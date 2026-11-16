-- The production Groq RPC retains its signature and 20-request cap.
-- New legacy-path reservations carry provider='groq' and share Groq's lock
-- with the provider-scoped RPC, preventing mixed-worker overbooking.
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
  if p_model is null or p_model <> 'openai/gpt-oss-20b' then raise exception 'approved Groq model is required'; end if;
  if p_attempt is null or p_attempt < 1 then raise exception 'attempt must be positive'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'limit must be between 1 and 20'; end if;
  if p_request_date is null then raise exception 'UTC request date is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:groq:' || p_request_date::text, 0));
  select count(*)::integer into v_count
    from public.agent_logs
   where step = 'provider_request_reserved'
     and created_at >= v_day_start and created_at < v_day_end
     and (provider = 'groq' or provider is null);
  if v_count >= p_limit then
    return jsonb_build_object('allowed', false, 'dailyCount', v_count, 'dailyLimit', p_limit, 'requestDate', p_request_date::text);
  end if;
  insert into public.agent_logs (run_id, agent_name, step, level, message, payload, provider)
  values (p_run_id, p_agent_name, 'provider_request_reserved', 'info', 'Provider request reserved',
    jsonb_build_object('agentVersion', p_agent_version, 'eventKey', p_event_key, 'attempt', p_attempt,
      'model', p_model, 'provider', 'groq', 'requestDate', p_request_date::text, 'providerRequestDispatched', false), 'groq')
  returning id into v_reservation_id;
  return jsonb_build_object('allowed', true, 'dailyCount', v_count + 1, 'dailyLimit', p_limit,
    'requestDate', p_request_date::text, 'reservationId', v_reservation_id);
end;
$$;

revoke all on function public.reserve_agent_request(uuid, text, text, text, integer, text, date, integer) from public, anon, authenticated;
grant execute on function public.reserve_agent_request(uuid, text, text, text, integer, text, date, integer) to service_role;
