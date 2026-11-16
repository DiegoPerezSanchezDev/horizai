-- Persistent, atomic free-tier request reservations for all agents.
-- The existing agent_logs table is the audit ledger; no extra counter table is needed.
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
begin
  if p_run_id is null then raise exception 'run_id is required'; end if;
  if p_agent_name is null or length(trim(p_agent_name)) = 0 then raise exception 'agent_name is required'; end if;
  if p_agent_version is null or length(trim(p_agent_version)) = 0 then raise exception 'agent_version is required'; end if;
  if p_model is null or length(trim(p_model)) = 0 then raise exception 'model is required'; end if;
  if p_attempt is null or p_attempt < 1 then raise exception 'attempt must be positive'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 20 then raise exception 'limit must be between 1 and 20'; end if;

  -- All processes serialize only the current UTC day, so a reservation is atomic.
  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:' || p_request_date::text, 0));

  select count(*)::integer
    into v_count
    from public.agent_logs
   where step = 'provider_request_reserved'
     and created_at >= v_day_start
     and created_at < v_day_end;

  if v_count >= p_limit then
    return jsonb_build_object(
      'allowed', false,
      'dailyCount', v_count,
      'dailyLimit', p_limit,
      'requestDate', p_request_date::text
    );
  end if;

  insert into public.agent_logs (
    run_id, agent_name, step, level, message, payload
  ) values (
    p_run_id,
    p_agent_name,
    'provider_request_reserved',
    'info',
    'Provider request reserved',
    jsonb_build_object(
      'agentVersion', p_agent_version,
      'eventKey', p_event_key,
      'attempt', p_attempt,
      'model', p_model,
      'requestDate', p_request_date::text
    )
  );

  return jsonb_build_object(
    'allowed', true,
    'dailyCount', v_count + 1,
    'dailyLimit', p_limit,
    'requestDate', p_request_date::text
  );
end;
$$;

revoke all on function public.reserve_agent_request(uuid, text, text, text, integer, text, date, integer) from public, anon, authenticated;
grant execute on function public.reserve_agent_request(uuid, text, text, text, integer, text, date, integer) to service_role;

comment on function public.reserve_agent_request(uuid, text, text, text, integer, text, date, integer)
  is 'Atomically reserves one model request against the shared daily free-tier budget and records it in agent_logs.';
