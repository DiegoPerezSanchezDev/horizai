-- Forward-only extension of the existing agent_runs/agent_logs ledger.
-- Historical unknown-provider rows remain NULL; Groq counts them conservatively.
alter table public.agent_runs add column provider text;
alter table public.agent_logs add column provider text;
alter table public.agent_runs add constraint agent_runs_provider_check check (provider is null or provider in ('groq', 'cerebras'));
alter table public.agent_logs add constraint agent_logs_provider_check check (provider is null or provider in ('groq', 'cerebras'));

update public.agent_runs
   set provider = 'groq'
 where provider is null
   and (config->>'provider' = 'groq'
        or (config->>'model' = 'openai/gpt-oss-20b' and config->>'agentName' in ('verifier', 'translator', 'editor', 'classifier', 'ranker', 'critic')));

update public.agent_logs l
   set provider = 'groq'
  from public.agent_runs r
 where l.run_id = r.id
   and l.provider is null
   and (r.provider = 'groq' or (l.step = 'provider_request_reserved' and l.payload->>'model' = 'openai/gpt-oss-20b'));

create index agent_logs_provider_reservation_day_idx
  on public.agent_logs (provider, created_at)
  where step = 'provider_request_reserved';
create index agent_runs_provider_finished_idx
  on public.agent_runs (provider, finished_at desc)
  where provider is not null;

create function public.reserve_provider_agent_request(
  p_run_id uuid,
  p_agent_name text,
  p_agent_version text,
  p_event_key text,
  p_attempt integer,
  p_model text,
  p_request_date date,
  p_limit integer,
  p_provider text
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
  if p_provider not in ('groq', 'cerebras') or p_provider is null then raise exception 'approved provider is required'; end if;
  if p_run_id is null or not exists (select 1 from public.agent_runs where id = p_run_id and provider = p_provider) then raise exception 'provider-matched run is required'; end if;
  if p_agent_name is null or length(trim(p_agent_name)) = 0 then raise exception 'agent_name is required'; end if;
  if p_agent_version is null or length(trim(p_agent_version)) = 0 then raise exception 'agent_version is required'; end if;
  if p_model is null or length(trim(p_model)) = 0 then raise exception 'model is required'; end if;
  if p_provider = 'groq' and p_model <> 'openai/gpt-oss-20b' then raise exception 'unapproved Groq model'; end if;
  if p_provider = 'cerebras' and p_model <> 'gpt-oss-120b' then raise exception 'unapproved Cerebras model'; end if;
  if p_attempt is null or p_attempt < 1 then raise exception 'attempt must be positive'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then raise exception 'invalid internal provider request limit'; end if;
  if p_request_date is null then raise exception 'UTC request date is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:' || p_provider || ':' || p_request_date::text, 0));
  select count(*)::integer into v_count
    from public.agent_logs
   where step = 'provider_request_reserved'
     and created_at >= v_day_start and created_at < v_day_end
     and (provider = p_provider or (p_provider = 'groq' and provider is null));
  if v_count >= p_limit then
    return jsonb_build_object('allowed', false, 'dailyCount', v_count, 'dailyLimit', p_limit, 'requestDate', p_request_date::text);
  end if;
  insert into public.agent_logs (run_id, agent_name, step, level, message, payload, provider)
  values (p_run_id, p_agent_name, 'provider_request_reserved', 'info', 'Provider request reserved',
    jsonb_build_object('agentVersion', p_agent_version, 'eventKey', p_event_key, 'attempt', p_attempt,
      'model', p_model, 'provider', p_provider, 'requestDate', p_request_date::text, 'providerRequestDispatched', false), p_provider)
  returning id into v_reservation_id;
  return jsonb_build_object('allowed', true, 'dailyCount', v_count + 1, 'dailyLimit', p_limit,
    'requestDate', p_request_date::text, 'reservationId', v_reservation_id);
end;
$$;

revoke all on function public.reserve_provider_agent_request(uuid, text, text, text, integer, text, date, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_provider_agent_request(uuid, text, text, text, integer, text, date, integer, text) to service_role;
comment on function public.reserve_provider_agent_request(uuid, text, text, text, integer, text, date, integer, text)
  is 'Atomically reserves a request in the existing ledger for one approved provider and UTC day; unknown historical rows conservatively count against Groq.';
