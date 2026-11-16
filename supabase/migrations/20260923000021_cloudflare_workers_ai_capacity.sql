-- Forward-only provider extension. Historic Cerebras rows remain Cerebras and
-- are never re-attributed to Cloudflare.
alter table public.agent_runs drop constraint if exists agent_runs_provider_check;
alter table public.agent_logs drop constraint if exists agent_logs_provider_check;
alter table public.agent_runs
  add constraint agent_runs_provider_check check (provider is null or provider in ('groq', 'cerebras', 'cloudflare_workers_ai'));
alter table public.agent_logs
  add constraint agent_logs_provider_check check (provider is null or provider in ('groq', 'cerebras', 'cloudflare_workers_ai'));

alter table public.agent_logs add column provider_unit text;
alter table public.agent_logs add column provider_unit_amount bigint;
alter table public.agent_logs add constraint agent_logs_provider_unit_check
  check (provider_unit is null or provider_unit in ('requests', 'tokens', 'neurons'));
alter table public.agent_logs add constraint agent_logs_provider_unit_amount_check
  check (provider_unit_amount is null or provider_unit_amount > 0);
alter table public.agent_logs add constraint agent_logs_provider_unit_pair_check
  check ((provider_unit is null) = (provider_unit_amount is null));

create index agent_logs_provider_unit_day_idx
  on public.agent_logs (provider, provider_unit, created_at)
  include (provider_unit_amount)
  where step = 'provider_request_reserved';

create function public.reserve_cloudflare_neuron_capacity(
  p_run_id uuid,
  p_agent_name text,
  p_agent_version text,
  p_event_key text,
  p_attempt integer,
  p_model text,
  p_request_date date,
  p_request_limit integer,
  p_daily_neuron_allocation bigint,
  p_estimated_neurons bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_day_start timestamptz := (p_request_date::text || ' 00:00:00+00')::timestamptz;
  v_day_end timestamptz := ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;
  v_requests integer;
  v_neurons bigint;
  v_reservation_id bigint;
begin
  if p_run_id is null or not exists (
    select 1 from public.agent_runs
     where id = p_run_id and provider = 'cloudflare_workers_ai'
  ) then raise exception 'provider-matched run is required'; end if;
  if p_model is distinct from '@cf/openai/gpt-oss-20b' then raise exception 'unapproved Cloudflare model'; end if;
  if p_agent_name is null or length(trim(p_agent_name)) = 0 then raise exception 'agent_name is required'; end if;
  if p_agent_version is null or length(trim(p_agent_version)) = 0 then raise exception 'agent_version is required'; end if;
  if p_attempt is null or p_attempt < 1 then raise exception 'attempt must be positive'; end if;
  if p_request_date is null then raise exception 'UTC request date is required'; end if;
  if p_request_date is distinct from (now() at time zone 'UTC')::date then raise exception 'request date must be the current UTC day'; end if;
  if p_request_limit is not null and p_request_limit < 1 then raise exception 'invalid optional internal request limit'; end if;
  if p_daily_neuron_allocation is null or p_daily_neuron_allocation < 1 then raise exception 'configured free neuron allocation is required'; end if;
  if p_estimated_neurons is null or p_estimated_neurons < 1 then raise exception 'positive estimated neuron reservation is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:cloudflare_workers_ai:' || p_request_date::text, 0));
  select count(*)::integer, coalesce(sum(provider_unit_amount), 0)::bigint
    into v_requests, v_neurons
    from public.agent_logs
   where step = 'provider_request_reserved'
     and provider = 'cloudflare_workers_ai'
     and created_at >= v_day_start and created_at < v_day_end;

  if (p_request_limit is not null and v_requests >= p_request_limit) or v_neurons + p_estimated_neurons > p_daily_neuron_allocation then
    return jsonb_build_object(
      'allowed', false, 'dailyCount', v_requests, 'dailyLimit', p_request_limit,
      'usedNeurons', v_neurons, 'neuronLimit', p_daily_neuron_allocation,
      'estimatedNeurons', p_estimated_neurons, 'requestDate', p_request_date::text
    );
  end if;

  insert into public.agent_logs (run_id, agent_name, step, level, message, payload, provider, provider_unit, provider_unit_amount)
  values (
    p_run_id, p_agent_name, 'provider_request_reserved', 'info', 'Cloudflare neuron capacity reserved',
    jsonb_build_object('agentVersion', p_agent_version, 'eventKey', p_event_key, 'attempt', p_attempt,
      'model', p_model, 'provider', 'cloudflare_workers_ai', 'requestDate', p_request_date::text,
      'providerRequestDispatched', false, 'providerUnitUsageKnown', false, 'estimatedNeurons', p_estimated_neurons),
    'cloudflare_workers_ai', 'neurons', p_estimated_neurons
  ) returning id into v_reservation_id;

  return jsonb_build_object(
    'allowed', true, 'dailyCount', v_requests + 1, 'dailyLimit', p_request_limit,
    'usedNeurons', v_neurons + p_estimated_neurons, 'neuronLimit', p_daily_neuron_allocation,
    'estimatedNeurons', p_estimated_neurons, 'requestDate', p_request_date::text,
    'reservationId', v_reservation_id
  );
end;
$$;

revoke all on function public.reserve_cloudflare_neuron_capacity(uuid, text, text, text, integer, text, date, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reserve_cloudflare_neuron_capacity(uuid, text, text, text, integer, text, date, integer, bigint, bigint) to service_role;
comment on function public.reserve_cloudflare_neuron_capacity(uuid, text, text, text, integer, text, date, integer, bigint, bigint)
  is 'Atomically reserves an internal Cloudflare request and estimated Neurons against the configured free daily allocation; never upgrades or bills.';
