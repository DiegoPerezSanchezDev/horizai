-- Fase 14A / M40. Durable idempotency and one global lease for the
-- supervised scheduler. This migration is prepared locally only.
begin;

create table public.supervised_scheduler_lease (
  singleton_id smallint primary key check (singleton_id = 1),
  owner_id uuid,
  invocation_id text,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  acquired_at timestamptz,
  expires_at timestamptz,
  released_at timestamptz,
  constraint supervised_scheduler_lease_owner_pair check ((owner_id is null) = (invocation_id is null)),
  constraint supervised_scheduler_lease_active_expiry check (owner_id is null or released_at is not null or expires_at is not null)
);
insert into public.supervised_scheduler_lease(singleton_id) values (1);

create table public.supervised_scheduler_invocations (
  invocation_id text primary key,
  trigger_id text not null unique,
  utc_day date not null unique,
  owner_id uuid not null,
  fencing_token bigint not null,
  status text not null default 'RUNNING' check (status in ('RUNNING','COMPLETED','STOPPED','FAILED')),
  outcome_code text,
  work_mode text check (work_mode is null or work_mode in ('RESUME_SAME_ATTEMPT','NEW_CANDIDATE')),
  attempt_id uuid,
  current_stage text,
  resume_generation integer check (resume_generation is null or resume_generation >= 0),
  requests_used integer not null default 0 check (requests_used >= 0),
  requests_remaining integer check (requests_remaining is null or requests_remaining >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  started_at timestamptz not null,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supervised_scheduler_invocation_identity check (
    trigger_id = 'supervised-candidates:' || to_char(utc_day, 'YYYY-MM-DD')
    and invocation_id = 'horizai-supervised:' || to_char(utc_day, 'YYYY-MM-DD')
  )
);
create index supervised_scheduler_invocations_status_idx
  on public.supervised_scheduler_invocations(status, started_at desc);

alter table public.supervised_scheduler_lease enable row level security;
alter table public.supervised_scheduler_invocations enable row level security;
revoke all on table public.supervised_scheduler_lease from public, anon, authenticated;
revoke all on table public.supervised_scheduler_invocations from public, anon, authenticated;
revoke all on table public.supervised_scheduler_lease from service_role;
revoke all on table public.supervised_scheduler_invocations from service_role;

create function public.claim_supervised_scheduler_invocation_m40(
  p_utc_day date,
  p_trigger_id text,
  p_invocation_id text,
  p_owner_id uuid,
  p_now timestamptz,
  p_lease_ttl_seconds integer
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare
  v_lease public.supervised_scheduler_lease%rowtype;
  v_existing public.supervised_scheduler_invocations%rowtype;
  v_fence bigint;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'supervised_scheduler_service_role_required'; end if;
  if p_now is null or p_utc_day is distinct from (p_now at time zone 'UTC')::date
     or p_trigger_id is distinct from ('supervised-candidates:' || to_char(p_utc_day, 'YYYY-MM-DD'))
     or p_invocation_id is distinct from ('horizai-supervised:' || to_char(p_utc_day, 'YYYY-MM-DD'))
     or p_owner_id is null or p_lease_ttl_seconds is null or p_lease_ttl_seconds not between 60 and 1020 then
    raise exception using errcode = '22023', message = 'supervised_scheduler_identity_invalid';
  end if;

  select * into v_lease from public.supervised_scheduler_lease where singleton_id = 1 for update;

  -- Serialize duplicate delivery checks with the global lease claim. Without
  -- this lock first, same-day simultaneous kickoffs could race on the unique
  -- day constraint and surface a database error instead of an idempotent result.
  select * into v_existing from public.supervised_scheduler_invocations
   where utc_day = p_utc_day or invocation_id = p_invocation_id or trigger_id = p_trigger_id;
  if found then
    return jsonb_build_object('status', 'DAILY_TRIGGER_ALREADY_CLAIMED', 'invocationId', v_existing.invocation_id, 'triggerId', v_existing.trigger_id, 'runStatus', v_existing.status);
  end if;

  -- An active owner with a missing expiry is ambiguous, not stale. Fail closed
  -- instead of allowing a new owner to replace a possibly live worker.
  if v_lease.owner_id is not null and v_lease.released_at is null and v_lease.expires_at is null then
    return jsonb_build_object('status', 'ALREADY_RUNNING', 'invocationId', v_lease.invocation_id, 'fencingToken', v_lease.fencing_token);
  end if;

  if v_lease.owner_id is not null and v_lease.released_at is null and v_lease.expires_at > p_now then
    return jsonb_build_object('status', 'ALREADY_RUNNING', 'invocationId', v_lease.invocation_id, 'fencingToken', v_lease.fencing_token, 'expiresAt', v_lease.expires_at);
  end if;

  if v_lease.owner_id is not null and v_lease.released_at is null and v_lease.expires_at <= p_now then
    update public.supervised_scheduler_invocations set status = 'STOPPED', outcome_code = 'STALE_LEASE_RECOVERED',
      finished_at = p_now, updated_at = p_now
     where invocation_id = v_lease.invocation_id and owner_id = v_lease.owner_id
       and fencing_token = v_lease.fencing_token and status = 'RUNNING';
  end if;

  v_fence := v_lease.fencing_token + 1;
  insert into public.supervised_scheduler_invocations(invocation_id, trigger_id, utc_day, owner_id, fencing_token, started_at)
  values (p_invocation_id, p_trigger_id, p_utc_day, p_owner_id, v_fence, p_now);
  update public.supervised_scheduler_lease set owner_id = p_owner_id, invocation_id = p_invocation_id,
    fencing_token = v_fence, acquired_at = p_now, expires_at = p_now + make_interval(secs => p_lease_ttl_seconds), released_at = null
   where singleton_id = 1;
  return jsonb_build_object('status', 'ACQUIRED', 'invocationId', p_invocation_id, 'triggerId', p_trigger_id, 'ownerId', p_owner_id, 'fencingToken', v_fence, 'expiresAt', p_now + make_interval(secs => p_lease_ttl_seconds));
end;
$function$;

create function public.heartbeat_supervised_scheduler_lease_m40(
  p_invocation_id text, p_owner_id uuid, p_fencing_token bigint, p_now timestamptz, p_lease_ttl_seconds integer
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public
as $function$
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'supervised_scheduler_service_role_required'; end if;
  if p_invocation_id is null or p_owner_id is null or p_fencing_token is null or p_now is null
     or p_lease_ttl_seconds is null or p_lease_ttl_seconds not between 60 and 1020 then
    return false;
  end if;
  update public.supervised_scheduler_lease set expires_at = p_now + make_interval(secs => p_lease_ttl_seconds)
   where singleton_id = 1 and invocation_id = p_invocation_id and owner_id = p_owner_id
     and fencing_token = p_fencing_token and released_at is null and expires_at > p_now;
  return found;
end;
$function$;

create function public.finish_supervised_scheduler_invocation_m40(
  p_invocation_id text, p_owner_id uuid, p_fencing_token bigint, p_status text, p_outcome_code text,
  p_work_mode text, p_attempt_id uuid, p_current_stage text, p_resume_generation integer,
  p_requests_used integer, p_requests_remaining integer, p_duration_ms integer, p_now timestamptz
) returns boolean
language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare
  v_count integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'supervised_scheduler_service_role_required'; end if;
  if p_invocation_id is null or p_owner_id is null or p_fencing_token is null or p_status is null
     or p_requests_used is null or p_now is null
     or p_status not in ('COMPLETED','STOPPED','FAILED') or p_requests_used < 0
     or (p_requests_remaining is not null and p_requests_remaining < 0)
     or (p_duration_ms is not null and p_duration_ms < 0)
     or (p_work_mode is not null and p_work_mode not in ('RESUME_SAME_ATTEMPT','NEW_CANDIDATE')) then
    raise exception using errcode = '22023', message = 'supervised_scheduler_outcome_invalid';
  end if;
  update public.supervised_scheduler_invocations set status = p_status, outcome_code = p_outcome_code,
    work_mode = p_work_mode, attempt_id = p_attempt_id, current_stage = p_current_stage,
    resume_generation = p_resume_generation, requests_used = p_requests_used,
    requests_remaining = p_requests_remaining, duration_ms = p_duration_ms,
    finished_at = p_now, updated_at = p_now
   where invocation_id = p_invocation_id and owner_id = p_owner_id and fencing_token = p_fencing_token and status = 'RUNNING';
  get diagnostics v_count = row_count;
  if v_count = 0 then return false; end if;
  update public.supervised_scheduler_lease set released_at = p_now
   where singleton_id = 1 and invocation_id = p_invocation_id and owner_id = p_owner_id
     and fencing_token = p_fencing_token and released_at is null;
  return found;
end;
$function$;

create function public.list_open_supervised_scheduler_attempts_m40()
returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'supervised_scheduler_service_role_required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'attemptId', a.id, 'eventKey', a.event_key, 'pipelineRunId', a.pipeline_run_id,
    'attemptNumber', a.attempt_number, 'startedAt', a.started_at, 'completedAt', a.completed_at,
    'finalState', a.final_state, 'stopStage', a.stop_stage, 'stopReason', a.stop_reason,
    'retryClass', a.retry_class, 'countsTowardRetryLimit', a.counts_toward_retry_limit,
    'nextEligibleAt', a.next_eligible_at, 'capacityResumeSnapshot', a.capacity_resume_snapshot,
    'resumeDispatchCount', coalesce(d.dispatch_count, 0),
    'resumeCheckpointPresent', case when a.capacity_resume_snapshot is null then null else a.capacity_resume_snapshot #> array['checkpoints', a.stop_stage] is not null end
  ) order by a.started_at), '[]'::jsonb)
    into v_result
    from public.pipeline_event_attempts a
    left join lateral (
      select count(*)::integer as dispatch_count
        from public.agent_runs ar
       where ar.config ->> 'pipelineRunId' = a.pipeline_run_id::text
         and ar.config ->> 'eventKey' = a.event_key
         and ar.config ->> 'agentName' = a.stop_stage
         and (ar.stats #>> '{telemetry,providerRequestDispatched}' = 'true'
           or coalesce(ar.stats #>> '{telemetry,providerRequestsUsed}', '0') ~ '^[1-9][0-9]*$'
           or exists (select 1 from public.agent_logs l where l.run_id = ar.id and
             (l.step = 'provider_request_reserved' or l.payload ->> 'providerRequestDispatched' = 'true'
              or l.payload #>> '{details,providerRequestDispatched}' = 'true'
              or l.payload #>> '{diagnostics,providerRequestDispatched}' = 'true')))
    ) d on true
   where a.completed_at is null and a.final_state is null;
  return v_result;
end;
$function$;

alter table public.pipeline_event_attempts add column scheduler_defer_reason text
  check (scheduler_defer_reason is null or scheduler_defer_reason in ('PROVIDER_CAPACITY_EXHAUSTED','WORKER_TIME_BUDGET_EXHAUSTED'));

create function public.defer_pipeline_event_attempt_scheduler_capacity_m40(
  p_attempt_id uuid, p_event_key text, p_pipeline_run_id uuid, p_resume_stage text, p_snapshot jsonb,
  p_provider_request_dispatched boolean, p_provider_requests_used integer, p_owner_id uuid default null, p_claimed_stage text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'capacity_attempt_service_role_required'; end if;
  v_result := public.defer_pipeline_event_attempt_capacity_m35(p_attempt_id, p_event_key, p_pipeline_run_id, p_resume_stage, p_snapshot,
    p_provider_request_dispatched, p_provider_requests_used, p_owner_id, p_claimed_stage);
  if v_result ->> 'status' = 'DEFERRED' then
    update public.pipeline_event_attempts set scheduler_defer_reason = null
     where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id
       and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED' and completed_at is null and final_state is null;
  end if;
  return v_result;
end;
$function$;

create function public.defer_pipeline_event_attempt_worker_budget_m40(
  p_attempt_id uuid, p_event_key text, p_pipeline_run_id uuid, p_resume_stage text, p_snapshot jsonb,
  p_provider_request_dispatched boolean, p_provider_requests_used integer, p_owner_id uuid default null, p_claimed_stage text default null
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'capacity_attempt_service_role_required'; end if;
  if p_provider_request_dispatched is distinct from false or p_provider_requests_used is distinct from 0 then
    raise exception using errcode = '22023', message = 'worker_budget_defer_must_be_pre_dispatch';
  end if;
  v_result := public.defer_pipeline_event_attempt_capacity_m35(p_attempt_id, p_event_key, p_pipeline_run_id, p_resume_stage, p_snapshot,
    false, 0, p_owner_id, p_claimed_stage);
  if v_result ->> 'status' = 'DEFERRED' then
    update public.pipeline_event_attempts set stop_reason = 'WORKER_TIME_BUDGET_EXHAUSTED', scheduler_defer_reason = 'WORKER_TIME_BUDGET_EXHAUSTED'
     where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id
       and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED' and completed_at is null and final_state is null;
    if not found then raise exception using errcode = '40001', message = 'worker_budget_defer_compare_and_set_lost'; end if;
  end if;
  return v_result;
end;
$function$;

create function public.claim_pipeline_event_attempt_scheduler_resume_m40(
  p_attempt_id uuid, p_event_key text, p_pipeline_run_id uuid, p_resume_stage text, p_owner_id uuid
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare v_attempt public.pipeline_event_attempts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'capacity_attempt_service_role_required'; end if;
  if p_attempt_id is null or p_event_key is null or length(trim(p_event_key)) = 0
     or p_pipeline_run_id is null or p_owner_id is null or p_resume_stage is null
     or not (p_resume_stage = any(array['verifier','translator','editor','classifier','ranker','critic'])) then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_key, 0));
  select * into v_attempt from public.pipeline_event_attempts where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id for update;
  if v_attempt.id is null or v_attempt.completed_at is not null or v_attempt.final_state is not null or v_attempt.purpose is distinct from 'NORMAL'
     or v_attempt.stop_stage is distinct from p_resume_stage or v_attempt.stop_reason is null
     or v_attempt.stop_reason not in ('PROVIDER_CAPACITY_EXHAUSTED','WORKER_TIME_BUDGET_EXHAUSTED')
     or v_attempt.retry_class is distinct from 'NONE' or v_attempt.counts_toward_retry_limit or v_attempt.next_eligible_at is not null
     or v_attempt.capacity_resume_snapshot is null or v_attempt.capacity_resume_snapshot ->> 'attemptId' is distinct from p_attempt_id::text
     or v_attempt.capacity_resume_snapshot ->> 'pipelineRunId' is distinct from p_pipeline_run_id::text
     or v_attempt.capacity_resume_snapshot ->> 'eventKey' is distinct from p_event_key
     or v_attempt.capacity_resume_snapshot ->> 'resumeStage' is distinct from p_resume_stage then return false; end if;
  update public.pipeline_event_attempts set scheduler_defer_reason = stop_reason,
    stop_reason = 'CAPACITY_RESUME_CLAIMED:' || p_owner_id::text
   where id = p_attempt_id and completed_at is null and final_state is null;
  return found;
end;
$function$;

create function public.release_pipeline_event_attempt_scheduler_resume_m40(
  p_attempt_id uuid, p_event_key text, p_pipeline_run_id uuid, p_resume_stage text, p_owner_id uuid
) returns boolean language plpgsql security definer set search_path = pg_catalog, public
as $function$
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'capacity_attempt_service_role_required'; end if;
  if p_attempt_id is null or p_event_key is null or length(trim(p_event_key)) = 0
     or p_pipeline_run_id is null or p_resume_stage is null or p_owner_id is null
     or not (p_resume_stage = any(array['verifier','translator','editor','classifier','ranker','critic'])) then
    return false;
  end if;
  update public.pipeline_event_attempts set stop_reason = coalesce(scheduler_defer_reason, 'PROVIDER_CAPACITY_EXHAUSTED'), scheduler_defer_reason = null
   where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id and stop_stage = p_resume_stage
     and stop_reason = 'CAPACITY_RESUME_CLAIMED:' || p_owner_id::text and completed_at is null and final_state is null;
  return found;
end;
$function$;

revoke all on function public.claim_supervised_scheduler_invocation_m40(date,text,text,uuid,timestamptz,integer) from public, anon, authenticated, service_role;
grant execute on function public.claim_supervised_scheduler_invocation_m40(date,text,text,uuid,timestamptz,integer) to service_role;
revoke all on function public.heartbeat_supervised_scheduler_lease_m40(text,uuid,bigint,timestamptz,integer) from public, anon, authenticated, service_role;
grant execute on function public.heartbeat_supervised_scheduler_lease_m40(text,uuid,bigint,timestamptz,integer) to service_role;
revoke all on function public.finish_supervised_scheduler_invocation_m40(text,uuid,bigint,text,text,text,uuid,text,integer,integer,integer,integer,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.finish_supervised_scheduler_invocation_m40(text,uuid,bigint,text,text,text,uuid,text,integer,integer,integer,integer,timestamptz) to service_role;
revoke all on function public.list_open_supervised_scheduler_attempts_m40() from public, anon, authenticated, service_role;
grant execute on function public.list_open_supervised_scheduler_attempts_m40() to service_role;
revoke all on function public.defer_pipeline_event_attempt_scheduler_capacity_m40(uuid,text,uuid,text,jsonb,boolean,integer,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.defer_pipeline_event_attempt_scheduler_capacity_m40(uuid,text,uuid,text,jsonb,boolean,integer,uuid,text) to service_role;
revoke all on function public.defer_pipeline_event_attempt_worker_budget_m40(uuid,text,uuid,text,jsonb,boolean,integer,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.defer_pipeline_event_attempt_worker_budget_m40(uuid,text,uuid,text,jsonb,boolean,integer,uuid,text) to service_role;
revoke all on function public.claim_pipeline_event_attempt_scheduler_resume_m40(uuid,text,uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_pipeline_event_attempt_scheduler_resume_m40(uuid,text,uuid,text,uuid) to service_role;
revoke all on function public.release_pipeline_event_attempt_scheduler_resume_m40(uuid,text,uuid,text,uuid) from public, anon, authenticated, service_role;
grant execute on function public.release_pipeline_event_attempt_scheduler_resume_m40(uuid,text,uuid,text,uuid) to service_role;

commit;
