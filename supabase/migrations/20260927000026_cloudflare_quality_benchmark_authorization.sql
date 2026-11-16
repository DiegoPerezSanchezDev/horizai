-- Additive, service-role-only reservation path for the isolated historical
-- quality benchmark. Canonical synthetic stage validation stays unchanged.
begin;

create or replace function public.reserve_cloudflare_quality_benchmark_capacity(
  p_run_id uuid,
  p_stage text,
  p_benchmark_case_id text,
  p_agent_name text,
  p_agent_version text,
  p_event_key text,
  p_attempt integer,
  p_validation_purpose text,
  p_provider text,
  p_model text,
  p_request_date date,
  p_request_limit integer,
  p_daily_neuron_allocation bigint,
  p_estimated_neurons bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_requests integer;
  v_neurons bigint;
  v_reservation_id bigint;
  v_expected_agent_version text;
  v_expected_event_key text;
  v_quality_runs integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role is required for quality benchmark capacity';
  end if;

  if p_benchmark_case_id = 'quality:ars-problematic-lineage-v1' then
    if p_stage not in ('verifier', 'translator', 'editor', 'classifier', 'ranker', 'critic') then
      raise exception 'case and stage are outside the quality benchmark allowlist';
    end if;
  elsif p_benchmark_case_id = 'quality:mit-clean-control-v1' and p_stage = 'critic' then
    null;
  else
    raise exception 'case and stage are outside the quality benchmark allowlist';
  end if;

  case p_stage
    when 'verifier' then v_expected_agent_version := 'verifier-v1';
    when 'translator' then v_expected_agent_version := 'translator-v1';
    when 'editor' then v_expected_agent_version := 'editor-v2';
    when 'classifier' then v_expected_agent_version := 'classifier-v1';
    when 'ranker' then v_expected_agent_version := 'ranker-v1';
    when 'critic' then v_expected_agent_version := 'critic-v3';
    else raise exception 'stage is outside the quality benchmark allowlist';
  end case;

  v_expected_event_key := 'quality-benchmark:' || p_benchmark_case_id || ':' || p_stage;
  if p_validation_purpose is distinct from 'quality_benchmark'
    or p_provider is distinct from 'cloudflare_workers_ai'
    or p_model is distinct from '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    or p_agent_name is distinct from p_stage
    or p_agent_version is distinct from v_expected_agent_version
    or p_event_key is distinct from v_expected_event_key
    or p_attempt is distinct from 1 then
    raise exception 'request is outside the quality benchmark allowlist';
  end if;

  if p_run_id is null or not exists (
    select 1 from public.agent_runs
     where id = p_run_id
       and run_type = 'other'
       and provider = 'cloudflare_workers_ai'
       and dry_run = true
       and status = 'running'
       and config ->> 'validationPurpose' = 'quality_benchmark'
       and config ->> 'benchmarkCaseId' = p_benchmark_case_id
       and config ->> 'stage' = p_stage
       and config ->> 'eventKey' = p_event_key
       and config ->> 'provider' = p_provider
       and config ->> 'model' = p_model
       and config ->> 'agentName' = p_agent_name
       and config ->> 'agentVersion' = p_agent_version
       and config ->> 'dryRun' = 'true'
       and config ->> 'inputSha256' ~ '^sha256:[a-f0-9]{64}$'
  ) then
    raise exception 'provider-matched dry-run quality benchmark run is required';
  end if;

  if p_request_date is null or p_request_date is distinct from (now() at time zone 'UTC')::date then
    raise exception 'request date must be the current UTC day';
  end if;
  if p_request_limit is not null and (p_request_limit < 1 or p_request_limit > 8) then
    raise exception 'quality benchmark request limit must be between one and eight';
  end if;
  if p_daily_neuron_allocation is null or p_daily_neuron_allocation < 1 or p_daily_neuron_allocation > 10000 then
    raise exception 'configured free neuron allocation is outside the 10000-Neuron hard cap';
  end if;
  if p_estimated_neurons is null or p_estimated_neurons < 1 then
    raise exception 'positive estimated neuron reservation is required';
  end if;

  v_day_start := (p_request_date::text || ' 00:00:00+00')::timestamptz;
  v_day_end := ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;
  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:cloudflare_workers_ai:' || p_request_date::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('horizai-cloudflare-quality-benchmark-global', 0));

  select count(*)::integer into v_quality_runs
    from public.agent_runs
   where config ->> 'validationPurpose' = 'quality_benchmark';
  if v_quality_runs > 8 then
    raise exception 'quality benchmark global eight-call ceiling is exhausted';
  end if;
  if exists (
    select 1 from public.agent_runs
     where id <> p_run_id
       and config ->> 'validationPurpose' = 'quality_benchmark'
       and config ->> 'benchmarkCaseId' = p_benchmark_case_id
       and config ->> 'stage' = p_stage
  ) then
    raise exception 'this quality benchmark case and stage already has a run';
  end if;
  if exists (
    select 1 from public.agent_logs
     where run_id = p_run_id
       and step = 'provider_request_reserved'
       and payload ->> 'validationPurpose' = 'quality_benchmark'
  ) then
    raise exception 'this quality benchmark run already has a reservation';
  end if;

  select count(*)::integer,
         coalesce(sum(provider_unit_amount) filter (where provider_unit = 'neurons'), 0)::bigint
    into v_requests, v_neurons
    from public.agent_logs
   where step = 'provider_request_reserved'
     and provider = 'cloudflare_workers_ai'
     and created_at >= v_day_start and created_at < v_day_end;

  if (p_request_limit is not null and v_requests >= p_request_limit)
    or v_neurons + p_estimated_neurons > p_daily_neuron_allocation then
    return jsonb_build_object(
      'allowed', false, 'dailyCount', v_requests, 'dailyLimit', p_request_limit,
      'usedNeurons', v_neurons, 'neuronLimit', p_daily_neuron_allocation,
      'estimatedNeurons', p_estimated_neurons, 'requestDate', p_request_date::text
    );
  end if;

  insert into public.agent_logs (run_id, agent_name, step, level, message, payload, provider, provider_unit, provider_unit_amount)
  values (
    p_run_id, p_agent_name, 'provider_request_reserved', 'info', 'Supervised Cloudflare quality benchmark capacity reserved',
    jsonb_build_object(
      'agentVersion', p_agent_version, 'stage', p_stage, 'eventKey', p_event_key,
      'benchmarkCaseId', p_benchmark_case_id, 'attempt', p_attempt, 'maxRetries', 0,
      'validationPurpose', p_validation_purpose, 'model', p_model, 'provider', p_provider,
      'requestDate', p_request_date::text, 'providerRequestDispatched', false,
      'providerUnitUsageKnown', false, 'estimatedNeurons', p_estimated_neurons
    ),
    p_provider, 'neurons', p_estimated_neurons
  ) returning id into v_reservation_id;

  return jsonb_build_object(
    'allowed', true, 'dailyCount', v_requests + 1, 'dailyLimit', p_request_limit,
    'usedNeurons', v_neurons + p_estimated_neurons, 'neuronLimit', p_daily_neuron_allocation,
    'estimatedNeurons', p_estimated_neurons, 'requestDate', p_request_date::text,
    'reservationId', v_reservation_id
  );
end;
$$;

revoke all on function public.reserve_cloudflare_quality_benchmark_capacity(uuid, text, text, text, text, text, integer, text, text, text, date, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reserve_cloudflare_quality_benchmark_capacity(uuid, text, text, text, text, text, integer, text, text, text, date, integer, bigint, bigint) to service_role;
comment on function public.reserve_cloudflare_quality_benchmark_capacity(uuid, text, text, text, text, text, integer, text, text, text, date, integer, bigint, bigint)
  is 'Atomically reserves provider-scoped Cloudflare Neurons for one explicitly allowlisted real historical quality benchmark stage; service_role only, quality_benchmark purpose, at most eight calls, no pipeline routing.';

commit;
