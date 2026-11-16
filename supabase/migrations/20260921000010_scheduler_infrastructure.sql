-- HorizAI / Fase 10C.1
-- Persistent scheduler trigger history and lease ownership.
-- This is separate from agent_runs and request reservations: it never reserves
-- provider requests and it keeps completed trigger identities for deduplication.

create table public.scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_id text not null unique,
  owner_run_id uuid not null,
  invocation_type text not null default 'scheduled',
  schedule_date_utc date not null,
  slot text not null,
  scheduling_timezone text not null,
  scheduled_at timestamptz not null,
  request_date_utc date not null,
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  released_at timestamptz,
  finished_at timestamptz,
  lease_status text not null default 'active',
  run_status text not null default 'running',
  final_decision text not null default 'pending',
  stop_reason text,
  quota_used integer not null default 0,
  quota_remaining integer not null,
  max_events_per_run integer not null default 3,
  automatic_revision boolean not null default false,
  dry_run boolean not null default true,
  publish boolean not null default false,
  previous_owner_run_id uuid,
  lease_recovery_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduler_runs_trigger_not_blank check (length(trim(trigger_id)) > 0),
  constraint scheduler_runs_owner_required check (owner_run_id is not null),
  constraint scheduler_runs_invocation_check check (invocation_type in ('scheduled', 'manual', 'preflight')),
  constraint scheduler_runs_slot_check check (slot in ('morning', 'afternoon', 'night')),
  constraint scheduler_runs_timezone_not_blank check (length(trim(scheduling_timezone)) > 0),
  constraint scheduler_runs_expiry_after_acquire check (expires_at > acquired_at),
  constraint scheduler_runs_lease_status_check check (lease_status in ('active', 'released')),
  constraint scheduler_runs_status_check check (run_status in ('running', 'succeeded', 'failed', 'blocked')),
  constraint scheduler_runs_decision_check check (final_decision in ('pending', 'allowed', 'blocked', 'failed')),
  constraint scheduler_runs_quota_used_non_negative check (quota_used >= 0),
  constraint scheduler_runs_quota_remaining_non_negative check (quota_remaining >= 0),
  constraint scheduler_runs_max_events_positive check (max_events_per_run > 0),
  constraint scheduler_runs_automatic_revision_disabled check (automatic_revision = false),
  constraint scheduler_runs_dry_run_required check (dry_run = true),
  constraint scheduler_runs_publish_disabled check (publish = false),
  constraint scheduler_runs_recovery_non_negative check (lease_recovery_count >= 0)
);

create index scheduler_runs_active_lease_idx
  on public.scheduler_runs (lease_status, expires_at)
  where lease_status = 'active';
create index scheduler_runs_status_created_idx
  on public.scheduler_runs (run_status, created_at desc);
create index scheduler_runs_request_date_slot_idx
  on public.scheduler_runs (request_date_utc, slot, created_at desc);
create index scheduler_runs_owner_idx
  on public.scheduler_runs (owner_run_id, created_at desc);

create trigger scheduler_runs_set_updated_at
before update on public.scheduler_runs
for each row execute function public.set_updated_at();

create or replace function public.acquire_scheduler_run(
  p_trigger_id text,
  p_owner_run_id uuid,
  p_invocation_type text,
  p_schedule_date_utc date,
  p_slot text,
  p_scheduling_timezone text,
  p_scheduled_at timestamptz,
  p_request_date_utc date,
  p_now timestamptz,
  p_expires_at timestamptz,
  p_quota_used integer,
  p_quota_remaining integer,
  p_max_events_per_run integer,
  p_automatic_revision boolean,
  p_dry_run boolean,
  p_publish boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.scheduler_runs%rowtype;
begin
  if p_trigger_id is null or length(trim(p_trigger_id)) = 0 then raise exception 'trigger_id is required'; end if;
  if p_owner_run_id is null then raise exception 'owner_run_id is required'; end if;
  if p_expires_at <= p_now then raise exception 'expires_at must be after now'; end if;
  if p_automatic_revision or not p_dry_run or p_publish then raise exception 'scheduler must remain offline safe'; end if;

  insert into public.scheduler_runs (
    trigger_id, owner_run_id, invocation_type, schedule_date_utc, slot,
    scheduling_timezone, scheduled_at, request_date_utc, acquired_at,
    expires_at, quota_used, quota_remaining, max_events_per_run,
    automatic_revision, dry_run, publish
  ) values (
    p_trigger_id, p_owner_run_id, p_invocation_type, p_schedule_date_utc, p_slot,
    p_scheduling_timezone, p_scheduled_at, p_request_date_utc, p_now,
    p_expires_at, p_quota_used, p_quota_remaining, p_max_events_per_run,
    false, true, false
  ) on conflict (trigger_id) do nothing;

  select * into v_row
    from public.scheduler_runs
   where trigger_id = p_trigger_id
   for update;

  if v_row.lease_status = 'active' and v_row.expires_at > p_now then
    return jsonb_build_object('status', 'busy', 'runId', v_row.id, 'ownerRunId', v_row.owner_run_id, 'triggerId', v_row.trigger_id, 'expiresAt', v_row.expires_at);
  end if;

  if v_row.lease_status = 'active' and v_row.expires_at <= p_now then
    update public.scheduler_runs set
      previous_owner_run_id = owner_run_id,
      owner_run_id = p_owner_run_id,
      invocation_type = p_invocation_type,
      schedule_date_utc = p_schedule_date_utc,
      slot = p_slot,
      scheduling_timezone = p_scheduling_timezone,
      scheduled_at = p_scheduled_at,
      request_date_utc = p_request_date_utc,
      acquired_at = p_now,
      expires_at = p_expires_at,
      released_at = null,
      finished_at = null,
      lease_status = 'active',
      run_status = 'running',
      final_decision = 'pending',
      stop_reason = null,
      quota_used = p_quota_used,
      quota_remaining = p_quota_remaining,
      max_events_per_run = p_max_events_per_run,
      lease_recovery_count = lease_recovery_count + 1,
      updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('status', 'expired', 'runId', v_row.id, 'ownerRunId', p_owner_run_id, 'triggerId', p_trigger_id, 'expiresAt', p_expires_at);
  end if;

  return jsonb_build_object('status', 'duplicate', 'runId', v_row.id, 'ownerRunId', v_row.owner_run_id, 'triggerId', v_row.trigger_id, 'runStatus', v_row.run_status);
end;
$$;

create or replace function public.finish_scheduler_run(
  p_trigger_id text,
  p_owner_run_id uuid,
  p_run_status text,
  p_final_decision text,
  p_stop_reason text,
  p_quota_used integer,
  p_quota_remaining integer,
  p_finished_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row_count integer;
begin
  update public.scheduler_runs set
    run_status = p_run_status,
    final_decision = p_final_decision,
    stop_reason = p_stop_reason,
    quota_used = p_quota_used,
    quota_remaining = p_quota_remaining,
    finished_at = p_finished_at,
    updated_at = now()
   where trigger_id = p_trigger_id
     and owner_run_id = p_owner_run_id
     and lease_status = 'active';
  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

create or replace function public.release_scheduler_lease(
  p_trigger_id text,
  p_owner_run_id uuid,
  p_released_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row_count integer;
begin
  update public.scheduler_runs set
    lease_status = 'released',
    released_at = p_released_at,
    updated_at = now()
   where trigger_id = p_trigger_id
     and owner_run_id = p_owner_run_id
     and lease_status = 'active';
  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

revoke all on table public.scheduler_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.scheduler_runs to service_role;
revoke all on function public.acquire_scheduler_run(text, uuid, text, date, text, text, timestamptz, date, timestamptz, timestamptz, integer, integer, integer, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.acquire_scheduler_run(text, uuid, text, date, text, text, timestamptz, date, timestamptz, timestamptz, integer, integer, integer, boolean, boolean, boolean) to service_role;
revoke all on function public.finish_scheduler_run(text, uuid, text, text, text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.finish_scheduler_run(text, uuid, text, text, text, integer, integer, timestamptz) to service_role;
revoke all on function public.release_scheduler_lease(text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.release_scheduler_lease(text, uuid, timestamptz) to service_role;

comment on table public.scheduler_runs is 'Persistent scheduler trigger history and distributed lease state; never reserves provider requests.';
