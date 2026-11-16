-- HorizAI / Fase 10F-A.4
-- Serialize claims for one event key so a concurrent caller receives a
-- deterministic ALREADY_ACTIVE/COOLDOWN result instead of a unique violation.
begin;

create or replace function public.claim_pipeline_event_attempt(
  p_event_key text,
  p_pipeline_run_id uuid,
  p_started_at timestamptz,
  p_now timestamptz,
  p_stale_after_seconds integer default 3600
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  active_row public.pipeline_event_attempts%rowtype;
  previous_row public.pipeline_event_attempts%rowtype;
  new_row public.pipeline_event_attempts%rowtype;
  technical_count integer;
begin
  if p_event_key is null or p_event_key = '' or p_pipeline_run_id is null or p_stale_after_seconds <= 0 then raise exception 'invalid event attempt claim'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_key, 0));
  select * into active_row from public.pipeline_event_attempts where event_key = p_event_key and completed_at is null for update;
  if active_row.id is not null then
    if active_row.pipeline_run_id = p_pipeline_run_id then return jsonb_build_object('status','ALREADY_ACTIVE','reason','SAME_PIPELINE_RUN'); end if;
    if active_row.started_at > p_now - (p_stale_after_seconds * interval '1 second') then return jsonb_build_object('status','ALREADY_ACTIVE','reason','ACTIVE_ATTEMPT'); end if;
    update public.pipeline_event_attempts set completed_at = p_now, final_state = 'ABORTED', stop_stage = 'attempt_registry', stop_reason = 'STALE_ATTEMPT_RECOVERED', retry_class = 'TECHNICAL_FAILURE', counts_toward_retry_limit = false, next_eligible_at = p_now where id = active_row.id;
  end if;
  select * into previous_row from public.pipeline_event_attempts where event_key = p_event_key and pipeline_run_id = p_pipeline_run_id limit 1;
  if previous_row.id is not null then return jsonb_build_object('status','ALREADY_REGISTERED','reason','SAME_PIPELINE_RUN'); end if;
  if exists (select 1 from public.pipeline_event_attempts where event_key = p_event_key and final_state in ('READY_FOR_PUBLICATION','REVISION_REQUIRED','REJECTED','VERIFICATION_INSUFFICIENT')) then return jsonb_build_object('status','INELIGIBLE','reason','PERMANENT_OUTCOME'); end if;
  select count(*) into technical_count from public.pipeline_event_attempts where event_key = p_event_key and final_state = 'TECHNICAL_FAILURE' and counts_toward_retry_limit = true;
  if technical_count >= 2 then return jsonb_build_object('status','QUARANTINED','reason','MAX_TECHNICAL_ATTEMPTS'); end if;
  select * into previous_row from public.pipeline_event_attempts where event_key = p_event_key and final_state = 'TECHNICAL_FAILURE' and counts_toward_retry_limit = true order by attempt_number desc limit 1;
  if previous_row.id is not null and previous_row.next_eligible_at is not null and previous_row.next_eligible_at > p_now then return jsonb_build_object('status','COOLDOWN','reason','TECHNICAL_COOLDOWN'); end if;
  insert into public.pipeline_event_attempts (event_key,pipeline_run_id,attempt_number,started_at) select p_event_key,p_pipeline_run_id,coalesce(max(attempt_number),0)+1,p_started_at from public.pipeline_event_attempts where event_key = p_event_key returning * into new_row;
  return jsonb_build_object('status','ACQUIRED','attempt',jsonb_build_object('id',new_row.id,'event_key',new_row.event_key,'pipeline_run_id',new_row.pipeline_run_id,'attempt_number',new_row.attempt_number,'started_at',new_row.started_at,'completed_at',new_row.completed_at,'final_state',new_row.final_state,'stop_stage',new_row.stop_stage,'stop_reason',new_row.stop_reason,'retry_class',new_row.retry_class,'counts_toward_retry_limit',new_row.counts_toward_retry_limit,'next_eligible_at',new_row.next_eligible_at,'created_at',new_row.created_at));
end;
$$;

revoke all on function public.claim_pipeline_event_attempt(text, uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_pipeline_event_attempt(text, uuid, timestamptz, timestamptz, integer) to service_role;
commit;
