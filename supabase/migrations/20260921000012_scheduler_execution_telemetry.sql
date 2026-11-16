-- HorizAI / Fase 10C.2
-- Adds compact scheduler-to-pipeline execution telemetry. No article bodies,
-- prompts, reasoning, secrets, RLS changes, or request reservations.

alter table public.scheduler_runs
  add column pipeline_run_id uuid,
  add column scheduler_decision text,
  add column event_attempts integer not null default 0,
  add column event_final_states jsonb not null default '[]'::jsonb,
  add column requests_used integer not null default 0,
  add column duration_ms integer;

alter table public.scheduler_runs
  add constraint scheduler_runs_decision_value_check
    check (scheduler_decision is null or scheduler_decision in ('PREFLIGHT', 'COMPLETED', 'BLOCKED_DUPLICATE_TRIGGER', 'BLOCKED_RUN_ALREADY_ACTIVE', 'BLOCKED_INSUFFICIENT_DAILY_BUDGET', 'BLOCKED_PROVIDER_RATE_LIMIT', 'BLOCKED_REVISION_REQUIRED', 'BLOCKED_REJECTED', 'FAILED')),
  add constraint scheduler_runs_event_attempts_non_negative check (event_attempts >= 0),
  add constraint scheduler_runs_event_states_array check (jsonb_typeof(event_final_states) = 'array'),
  add constraint scheduler_runs_requests_used_non_negative check (requests_used >= 0),
  add constraint scheduler_runs_duration_non_negative check (duration_ms is null or duration_ms >= 0);

create index scheduler_runs_pipeline_run_idx on public.scheduler_runs (pipeline_run_id) where pipeline_run_id is not null;

create or replace function public.finish_scheduler_run_execution(
  p_trigger_id text,
  p_owner_run_id uuid,
  p_run_status text,
  p_final_decision text,
  p_scheduler_decision text,
  p_stop_reason text,
  p_pipeline_run_id uuid,
  p_event_attempts integer,
  p_event_final_states jsonb,
  p_requests_used integer,
  p_quota_used integer,
  p_quota_remaining integer,
  p_duration_ms integer,
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
    scheduler_decision = p_scheduler_decision,
    stop_reason = p_stop_reason,
    pipeline_run_id = p_pipeline_run_id,
    event_attempts = p_event_attempts,
    event_final_states = p_event_final_states,
    requests_used = p_requests_used,
    quota_used = p_quota_used,
    quota_remaining = p_quota_remaining,
    duration_ms = p_duration_ms,
    finished_at = p_finished_at,
    updated_at = now()
   where trigger_id = p_trigger_id
     and owner_run_id = p_owner_run_id
     and lease_status = 'active';
  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

revoke all on function public.finish_scheduler_run_execution(text, uuid, text, text, text, text, uuid, integer, jsonb, integer, integer, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.finish_scheduler_run_execution(text, uuid, text, text, text, text, uuid, integer, jsonb, integer, integer, integer, integer, timestamptz) to service_role;
