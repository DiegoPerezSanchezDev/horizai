-- Forward-only, service-role-only reservation capability shared by supervised
-- Cloudflare stage validations. This does not enable production event routing.
begin;

create or replace function public.reserve_cloudflare_supervised_stage_validation_capacity(
  p_run_id uuid,
  p_stage text,
  p_agent_name text,
  p_agent_version text,
  p_event_key text,
  p_fixture text,
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_day_start timestamptz := (p_request_date::text || ' 00:00:00+00')::timestamptz;
  v_day_end timestamptz := ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;
  v_requests integer;
  v_neurons bigint;
  v_reservation_id bigint;
  v_expected_agent_version text;
  v_expected_fixture text;
begin
  if p_stage is null or p_stage not in ('verifier', 'translator', 'editor', 'classifier', 'ranker', 'critic') then
    raise exception 'stage is outside the supervised validation allowlist';
  end if;

  case p_stage
    when 'verifier' then v_expected_agent_version := 'verifier-v1'; v_expected_fixture := 'verifier:unit:confirmed-two-source';
    when 'translator' then v_expected_agent_version := 'translator-v1'; v_expected_fixture := 'translator:unit:gpt-5-launch-2026';
    when 'editor' then v_expected_agent_version := 'editor-v2'; v_expected_fixture := 'editor:canonical-editor-input';
    when 'classifier' then v_expected_agent_version := 'classifier-v1'; v_expected_fixture := 'classifier:fixture-new-openai-model';
    when 'ranker' then v_expected_agent_version := 'ranker-v1'; v_expected_fixture := 'ranker:confirmed-launch';
    when 'critic' then v_expected_agent_version := 'critic-v3'; v_expected_fixture := 'critic:canonical-pass-fixture';
  end case;

  if p_provider is distinct from 'cloudflare_workers_ai'
    or p_model is distinct from '@cf/meta/llama-3.3-70b-instruct-fp8-fast'
    or p_validation_purpose is distinct from (p_stage || '_stage_validation')
    or p_agent_name is distinct from p_stage
    or p_agent_version is distinct from v_expected_agent_version
    or p_fixture is distinct from v_expected_fixture
    or p_event_key is null
    or p_event_key !~ ('^supervised-validation:' || p_validation_purpose || ':[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or p_attempt is distinct from 1 then
    raise exception 'request is outside the supervised stage validation allowlist';
  end if;

  if p_run_id is null or not exists (
    select 1 from public.agent_runs
     where id = p_run_id and provider = p_provider and dry_run = true
  ) then raise exception 'provider-matched dry-run validation run is required'; end if;

  if p_request_date is null or p_request_date is distinct from (now() at time zone 'UTC')::date then
    raise exception 'request date must be the current UTC day';
  end if;
  if p_request_limit is not null and p_request_limit < 1 then raise exception 'invalid optional request limit'; end if;
  if p_daily_neuron_allocation is null or p_daily_neuron_allocation < 1 or p_daily_neuron_allocation > 10000 then raise exception 'configured free neuron allocation is outside the 10000-Neuron hard cap'; end if;
  if p_estimated_neurons is null or p_estimated_neurons < 1 then raise exception 'positive estimated neuron reservation is required'; end if;

  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:cloudflare_workers_ai:' || p_request_date::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('horizai-cloudflare-supervised-stage-validation:' || p_event_key, 0));

  if exists (
    select 1 from public.agent_logs
     where step = 'provider_request_reserved'
       and provider = p_provider
       and payload ->> 'validationPurpose' = p_validation_purpose
       and payload ->> 'eventKey' = p_event_key
  ) then raise exception 'this supervised stage validation identity was already reserved'; end if;

  if exists (
    select 1 from public.agent_logs
     where step = 'provider_request_reserved'
       and provider = p_provider
       and agent_name = p_agent_name
       and payload ->> 'validationPurpose' = p_validation_purpose
       and created_at >= v_day_start and created_at < v_day_end
  ) then raise exception 'only one supervised request per stage and UTC day is allowed'; end if;

  select count(*)::integer, coalesce(sum(provider_unit_amount) filter (where provider_unit = 'neurons'), 0)::bigint
    into v_requests, v_neurons
    from public.agent_logs
   where step = 'provider_request_reserved'
     and provider = p_provider
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
    p_run_id, p_agent_name, 'provider_request_reserved', 'info', 'Supervised Cloudflare stage capacity reserved',
    jsonb_build_object(
      'agentVersion', p_agent_version, 'stage', p_stage, 'eventKey', p_event_key,
      'fixture', p_fixture, 'attempt', p_attempt, 'maxRetries', 0,
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

revoke all on function public.reserve_cloudflare_supervised_stage_validation_capacity(uuid, text, text, text, text, text, integer, text, text, text, date, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reserve_cloudflare_supervised_stage_validation_capacity(uuid, text, text, text, text, text, integer, text, text, text, date, integer, bigint, bigint) to service_role;
comment on function public.reserve_cloudflare_supervised_stage_validation_capacity(uuid, text, text, text, text, text, integer, text, text, text, date, integer, bigint, bigint)
  is 'Atomically reserves free Cloudflare Neurons for one allowlisted synthetic supervised stage validation; service_role only, max attempt 1, no production routing.';

commit;
