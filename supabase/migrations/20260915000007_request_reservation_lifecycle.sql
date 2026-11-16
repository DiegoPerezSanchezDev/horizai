-- Request reservation lifecycle for safe pre-dispatch cleanup.
-- Reservations remain in agent_logs as the shared atomic quota ledger.
create or replace function public.reserve_agent_request(
  p_run_id uuid,
  p_agent_name text,
  p_agent_version text,
  p_event_key text,
  p_attempt integer,
  p_model text,
  p_request_date date,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day_start timestamptz := (p_request_date::text || ' 00:00:00+00')::timestamptz;
  v_day_end timestamptz := ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;
  v_count integer;
  v_reservation_id bigint;
begin
  if p_run_id is null then raise exception 'run_id is required'; end if;
  if p_agent_name is null or length(trim(p_agent_name)) = 0 then raise exception 'agent_name is required'; end if;
  if p_agent_version is null or length(trim(p_agent_version)) = 0 then raise exception 'agent_version is required'; end if;
  if p_model is null or length(trim(p_model)) = 0 then raise exception 'model is required'; end if;
  if p_attempt is null or p_attempt < 1 then raise exception 'attempt must be positive'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'limit must be between 1 and 20'; end if;

  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:' || p_request_date::text, 0));

  select count(*)::integer
    into v_count
    from public.agent_logs
   where step = 'provider_request_reserved'
     and created_at >= v_day_start
     and created_at < v_day_end;

  if v_count >= p_limit then
    return jsonb_build_object('allowed', false, 'dailyCount', v_count, 'dailyLimit', p_limit, 'requestDate', p_request_date::text);
  end if;

  insert into public.agent_logs (run_id, agent_name, step, level, message, payload)
  values (
    p_run_id, p_agent_name, 'provider_request_reserved', 'info', 'Provider request reserved',
    jsonb_build_object(
      'agentVersion', p_agent_version,
      'eventKey', p_event_key,
      'attempt', p_attempt,
      'model', p_model,
      'requestDate', p_request_date::text,
      'providerRequestDispatched', false
    )
  )
  returning id into v_reservation_id;

  return jsonb_build_object('allowed', true, 'dailyCount', v_count + 1, 'dailyLimit', p_limit, 'requestDate', p_request_date::text, 'reservationId', v_reservation_id);
end;
$$;

create or replace function public.mark_agent_request_dispatched(
  p_reservation_id bigint,
  p_run_id uuid,
  p_request_date date
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated boolean;
  v_row_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:' || p_request_date::text, 0));
  update public.agent_logs
     set payload = payload || jsonb_build_object('providerRequestDispatched', true, 'dispatchedAt', now()),
         updated_at = now()
   where id = p_reservation_id
     and run_id = p_run_id
     and step = 'provider_request_reserved'
     and created_at >= (p_request_date::text || ' 00:00:00+00')::timestamptz
     and created_at < ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz
     and coalesce(payload->>'providerRequestDispatched', 'false') <> 'true';
  get diagnostics v_row_count = row_count;
  v_updated := v_row_count > 0;
  return v_updated;
end;
$$;

create or replace function public.release_agent_request(
  p_reservation_id bigint,
  p_run_id uuid,
  p_request_date date
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted boolean;
  v_row_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:' || p_request_date::text, 0));
  delete from public.agent_logs
   where id = p_reservation_id
     and run_id = p_run_id
     and step = 'provider_request_reserved'
     and created_at >= (p_request_date::text || ' 00:00:00+00')::timestamptz
     and created_at < ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz
     and coalesce(payload->>'providerRequestDispatched', 'false') <> 'true';
  get diagnostics v_row_count = row_count;
  v_deleted := v_row_count > 0;
  return v_deleted;
end;
$$;

revoke all on function public.mark_agent_request_dispatched(bigint, uuid, date) from public, anon, authenticated;
grant execute on function public.mark_agent_request_dispatched(bigint, uuid, date) to service_role;
revoke all on function public.release_agent_request(bigint, uuid, date) from public, anon, authenticated;
grant execute on function public.release_agent_request(bigint, uuid, date) to service_role;

comment on function public.mark_agent_request_dispatched(bigint, uuid, date)
  is 'Marks an owned request reservation as dispatched; dispatched reservations cannot be released.';
comment on function public.release_agent_request(bigint, uuid, date)
  is 'Releases only an owned, pre-dispatch request reservation for the specified UTC day.';
