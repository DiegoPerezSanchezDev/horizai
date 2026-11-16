-- Fix: a newly inserted scheduler trigger is already active, but must return
-- acquired rather than being mistaken for an existing busy lease.
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
  v_row_count integer;
  v_inserted boolean;
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
  get diagnostics v_row_count = row_count;
  v_inserted := v_row_count > 0;

  select * into v_row
    from public.scheduler_runs
   where trigger_id = p_trigger_id
   for update;

  if v_inserted then
    return jsonb_build_object('status', 'acquired', 'runId', v_row.id, 'ownerRunId', v_row.owner_run_id, 'triggerId', v_row.trigger_id, 'expiresAt', v_row.expires_at);
  end if;

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

revoke all on function public.acquire_scheduler_run(text, uuid, text, date, text, text, timestamptz, date, timestamptz, timestamptz, integer, integer, integer, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.acquire_scheduler_run(text, uuid, text, date, text, text, timestamptz, date, timestamptz, timestamptz, integer, integer, integer, boolean, boolean, boolean) to service_role;
