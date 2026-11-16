begin;

-- Groq shares one provider-scoped ledger row for request admission and token
-- reservation. provider_unit_amount is the canonical daily token amount.
create function public.reserve_groq_request_and_tokens(
  p_run_id uuid,
  p_agent_name text,
  p_agent_version text,
  p_event_key text,
  p_attempt integer,
  p_model text,
  p_request_date date,
  p_request_hard_limit integer,
  p_request_soft_limit integer,
  p_token_hard_limit bigint,
  p_token_soft_limit bigint,
  p_estimated_tokens bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_request_usage bigint;
  v_token_usage numeric;
  v_legacy_token_usage numeric;
  v_legacy_unknown bigint;
  v_reservation_id bigint;
  v_reason text;
begin
  if p_run_id is null or not exists (
    select 1 from public.agent_runs where id = p_run_id and provider = 'groq'
  ) then raise exception 'provider-matched Groq run is required'; end if;
  if p_agent_name is null or length(trim(p_agent_name)) = 0 then raise exception 'agent_name is required'; end if;
  if p_agent_version is null or length(trim(p_agent_version)) = 0 then raise exception 'agent_version is required'; end if;
  if p_model is distinct from 'openai/gpt-oss-20b' then raise exception 'unapproved Groq model'; end if;
  if p_attempt is null or p_attempt < 1 then raise exception 'attempt must be positive'; end if;
  if p_request_date is null or p_request_date is distinct from (now() at time zone 'UTC')::date then
    raise exception 'request date must be the current UTC day';
  end if;
  if p_request_hard_limit is null or p_request_hard_limit < 1
    or p_request_soft_limit is null or p_request_soft_limit < 1 or p_request_soft_limit > p_request_hard_limit then
    raise exception 'invalid Groq request limits';
  end if;
  if p_token_hard_limit is null or p_token_hard_limit < 1
    or p_token_soft_limit is null or p_token_soft_limit < 1 or p_token_soft_limit > p_token_hard_limit then
    raise exception 'invalid Groq token limits';
  end if;
  if p_estimated_tokens is null or p_estimated_tokens < 1 then raise exception 'positive estimated token reservation is required'; end if;

  v_day_start := (p_request_date::text || ' 00:00:00+00')::timestamptz;
  v_day_end := ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;
  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:groq:' || p_request_date::text, 0));

  select count(*)::bigint into v_request_usage
    from public.agent_logs
   where step = 'provider_request_reserved'
     and created_at >= v_day_start and created_at < v_day_end
     and (provider = 'groq' or provider is null);

  if exists (
    select 1 from public.agent_logs
     where run_id = p_run_id and step = 'provider_request_reserved'
       and provider = 'groq' and payload ->> 'attempt' = p_attempt::text
  ) then raise exception 'duplicate Groq reservation identity'; end if;

  select coalesce(sum(provider_unit_amount), 0)::numeric into v_token_usage
    from public.agent_logs
   where step = 'provider_request_reserved'
     and (provider = 'groq' or provider is null) and provider_unit = 'tokens'
     and created_at >= v_day_start and created_at < v_day_end;

  -- Legacy request-only Groq reservations have no token estimate. Count only
  -- trustworthy, one-request-per-run telemetry; unknown legacy usage blocks
  -- admission instead of silently being treated as zero. Explicit token rows
  -- above are excluded here, so run telemetry can never double-count them.
  with legacy_rows as (
    select l.id, l.run_id, l.payload, r.provider as run_provider,
           r.stats -> 'telemetry' as telemetry,
           (select count(*) from public.agent_logs other
             where other.run_id = l.run_id and other.step = 'provider_request_reserved') as run_reservation_count
      from public.agent_logs l
      left join public.agent_runs r on r.id = l.run_id
     where l.step = 'provider_request_reserved'
       and (l.provider = 'groq' or l.provider is null)
       and l.provider_unit is distinct from 'tokens'
       and l.created_at >= v_day_start and l.created_at < v_day_end
  ), parsed_rows as (
    select legacy_rows.*,
      case when telemetry ->> 'inputTokens' ~ '^[0-9]{1,18}$' then (telemetry ->> 'inputTokens')::numeric end as input_tokens,
      case when telemetry ->> 'outputTokens' ~ '^[0-9]{1,18}$' then (telemetry ->> 'outputTokens')::numeric end as output_tokens,
      case when telemetry ->> 'totalTokens' ~ '^[0-9]{1,18}$' then (telemetry ->> 'totalTokens')::numeric end as total_tokens
    from legacy_rows
  ), checked_rows as (
    select parsed_rows.*,
      coalesce((coalesce(payload ->> 'providerRequestDispatched', 'false') = 'true'
       and run_reservation_count = 1
       and (run_provider = 'groq' or run_provider is null)
       and ((telemetry ->> 'provider' = 'groq') or (run_provider = 'groq' and telemetry ->> 'provider' is null))
       and telemetry ->> 'providerRequestsUsed' = '1'
       and input_tokens is not null and output_tokens is not null and total_tokens is not null
       and input_tokens + output_tokens <= total_tokens), false) as usage_is_trustworthy
    from parsed_rows
  )
  select count(*) filter (where not usage_is_trustworthy)::bigint,
         coalesce(sum(case when usage_is_trustworthy then total_tokens else 0 end), 0)::numeric
    into v_legacy_unknown, v_legacy_token_usage
    from checked_rows;

  v_token_usage := v_token_usage + v_legacy_token_usage;
  if v_legacy_unknown > 0 then
    v_reason := 'GROQ_DAILY_TOKEN_USAGE_UNKNOWN';
  elsif v_request_usage + 1 > p_request_hard_limit then
    v_reason := 'GROQ_DAILY_REQUEST_HARD_LIMIT';
  elsif v_request_usage + 1 > p_request_soft_limit then
    v_reason := 'GROQ_DAILY_REQUEST_SOFT_LIMIT';
  elsif v_token_usage + p_estimated_tokens > p_token_hard_limit then
    v_reason := 'GROQ_DAILY_TOKEN_HARD_LIMIT';
  elsif v_token_usage + p_estimated_tokens > p_token_soft_limit then
    v_reason := 'GROQ_DAILY_TOKEN_SOFT_LIMIT';
  end if;

  if v_reason is not null then
    return jsonb_build_object(
      'allowed', false, 'admitted', false, 'reason', v_reason,
      'dailyCount', v_request_usage, 'dailyLimit', p_request_hard_limit,
      'requestDate', p_request_date::text, 'quotaPeriodUtc', p_request_date::text,
      'requestUsageBefore', v_request_usage, 'requestUsageAfter', v_request_usage,
      'tokenUsageBefore', v_token_usage, 'tokenUsageAfter', v_token_usage,
      'reservedTokens', p_estimated_tokens,
      'requestHardLimit', p_request_hard_limit, 'requestSoftLimit', p_request_soft_limit,
      'tokenHardLimit', p_token_hard_limit, 'tokenSoftLimit', p_token_soft_limit
    );
  end if;

  insert into public.agent_logs (
    run_id, agent_name, step, level, message, payload, provider, provider_unit, provider_unit_amount
  ) values (
    p_run_id, p_agent_name, 'provider_request_reserved', 'info', 'Groq request and token capacity reserved',
    jsonb_build_object(
      'agentVersion', p_agent_version, 'eventKey', p_event_key, 'attempt', p_attempt,
      'model', p_model, 'provider', 'groq', 'requestDate', p_request_date::text,
      'providerRequestDispatched', false, 'providerUnitUsageKnown', false,
      'estimatedTokens', p_estimated_tokens, 'tokenUsageState', 'reserved_estimate',
      'requestHardLimit', p_request_hard_limit, 'requestSoftLimit', p_request_soft_limit,
      'tokenHardLimit', p_token_hard_limit, 'tokenSoftLimit', p_token_soft_limit
    ), 'groq', 'tokens', p_estimated_tokens
  ) returning id into v_reservation_id;

  return jsonb_build_object(
    'allowed', true, 'admitted', true, 'reason', null,
    'dailyCount', v_request_usage + 1, 'dailyLimit', p_request_hard_limit,
    'requestDate', p_request_date::text, 'quotaPeriodUtc', p_request_date::text,
    'reservationId', v_reservation_id,
    'requestUsageBefore', v_request_usage, 'requestUsageAfter', v_request_usage + 1,
    'tokenUsageBefore', v_token_usage, 'tokenUsageAfter', v_token_usage + p_estimated_tokens,
    'reservedTokens', p_estimated_tokens,
    'requestHardLimit', p_request_hard_limit, 'requestSoftLimit', p_request_soft_limit,
    'tokenHardLimit', p_token_hard_limit, 'tokenSoftLimit', p_token_soft_limit
  );
end;
$$;

-- Dispatch and release use the same Groq/day advisory key as atomic reserve.
-- Other providers retain the historic shared lifecycle lock and behavior.
create or replace function public.mark_agent_request_dispatched(
  p_reservation_id bigint,
  p_run_id uuid,
  p_request_date date
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_provider text;
  v_row_count integer;
begin
  if p_reservation_id is null or p_run_id is null or p_request_date is null then return false; end if;
  select coalesce(provider, payload ->> 'provider') into v_provider
    from public.agent_logs
   where id = p_reservation_id and run_id = p_run_id and step = 'provider_request_reserved'
     and created_at >= (p_request_date::text || ' 00:00:00+00')::timestamptz
     and created_at < ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;
  if not found then return false; end if;
  if v_provider = 'groq' then
    perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:groq:' || p_request_date::text, 0));
  else
    perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:' || p_request_date::text, 0));
  end if;
  update public.agent_logs
     set payload = payload || jsonb_build_object('providerRequestDispatched', true, 'dispatchedAt', now()),
         updated_at = now()
   where id = p_reservation_id and run_id = p_run_id and step = 'provider_request_reserved'
     and created_at >= (p_request_date::text || ' 00:00:00+00')::timestamptz
     and created_at < ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz
     and coalesce(payload ->> 'providerRequestDispatched', 'false') <> 'true';
  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_provider text;
  v_row_count integer;
begin
  if p_reservation_id is null or p_run_id is null or p_request_date is null then return false; end if;
  select coalesce(provider, payload ->> 'provider') into v_provider
    from public.agent_logs
   where id = p_reservation_id and run_id = p_run_id and step = 'provider_request_reserved'
     and created_at >= (p_request_date::text || ' 00:00:00+00')::timestamptz
     and created_at < ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;
  if not found then return false; end if;
  if v_provider = 'groq' then
    perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:groq:' || p_request_date::text, 0));
  else
    perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:' || p_request_date::text, 0));
  end if;
  delete from public.agent_logs
   where id = p_reservation_id and run_id = p_run_id and step = 'provider_request_reserved'
     and created_at >= (p_request_date::text || ' 00:00:00+00')::timestamptz
     and created_at < ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz
     and coalesce(payload ->> 'providerRequestDispatched', 'false') <> 'true';
  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

create function public.settle_groq_token_usage(
  p_reservation_id bigint,
  p_run_id uuid,
  p_request_date date,
  p_actual_input_tokens bigint,
  p_actual_output_tokens bigint
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_payload jsonb;
  v_provider text;
  v_reserved bigint;
  v_actual numeric;
  v_state text;
  v_row_count integer;
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  if p_reservation_id is null or p_run_id is null or p_request_date is null then raise exception 'reservation identity is required'; end if;
  if p_actual_input_tokens is null or p_actual_input_tokens < 0 or p_actual_output_tokens is null or p_actual_output_tokens < 0 then
    raise exception 'actual token usage must contain nonnegative integer input and output counts';
  end if;
  v_actual := p_actual_input_tokens::numeric + p_actual_output_tokens::numeric;
  if v_actual < 1 or v_actual > 9223372036854775807 then raise exception 'actual token usage is outside supported range'; end if;
  v_day_start := (p_request_date::text || ' 00:00:00+00')::timestamptz;
  v_day_end := ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;

  select coalesce(provider, payload ->> 'provider') into v_provider
    from public.agent_logs
   where id = p_reservation_id and run_id = p_run_id and step = 'provider_request_reserved'
     and created_at >= v_day_start and created_at < v_day_end;
  if not found or v_provider is distinct from 'groq' then raise exception 'owned Groq token reservation not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:groq:' || p_request_date::text, 0));

  select payload, provider_unit_amount into v_payload, v_reserved
    from public.agent_logs
   where id = p_reservation_id and run_id = p_run_id and step = 'provider_request_reserved'
     and provider = 'groq' and provider_unit = 'tokens'
     and created_at >= v_day_start and created_at < v_day_end
   for update;
  if not found then raise exception 'owned Groq token reservation not found'; end if;
  if coalesce(v_payload ->> 'providerRequestDispatched', 'false') <> 'true' then raise exception 'Groq token settlement requires a dispatched request'; end if;

  v_state := v_payload ->> 'tokenUsageState';
  if v_state = 'settled' then
    if (v_payload ->> 'actualTokens') ~ '^[0-9]+$' and (v_payload ->> 'actualTokens')::numeric = v_actual then
      return jsonb_build_object(
        'settled', true, 'changed', false, 'actualTokens', v_actual,
        'reservedTokensBefore', coalesce(nullif(v_payload ->> 'estimatedTokens', '')::bigint, v_reserved),
        'accountedTokens', v_reserved, 'deltaTokens', 0
      );
    end if;
    raise exception 'provider_token_settlement_conflict';
  end if;
  if v_state is distinct from 'reserved_estimate' then raise exception 'Groq token reservation state is not settleable'; end if;

  update public.agent_logs
     set provider_unit_amount = v_actual::bigint,
         payload = payload || jsonb_build_object(
           'providerUnitUsageKnown', true, 'tokenUsageState', 'settled',
           'actualInputTokens', p_actual_input_tokens, 'actualOutputTokens', p_actual_output_tokens,
           'actualTokens', v_actual, 'settledAt', now()
         ),
         updated_at = now()
   where id = p_reservation_id and run_id = p_run_id and provider = 'groq'
     and provider_unit = 'tokens' and step = 'provider_request_reserved'
     and created_at >= v_day_start and created_at < v_day_end;
  get diagnostics v_row_count = row_count;
  if v_row_count <> 1 then raise exception 'Groq token settlement did not update exactly one reservation'; end if;

  return jsonb_build_object(
    'settled', true, 'changed', true, 'actualTokens', v_actual,
    'reservedTokensBefore', v_reserved, 'accountedTokens', v_actual,
    'deltaTokens', v_actual - v_reserved
  );
end;
$$;

revoke all on function public.reserve_groq_request_and_tokens(uuid, text, text, text, integer, text, date, integer, integer, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reserve_groq_request_and_tokens(uuid, text, text, text, integer, text, date, integer, integer, bigint, bigint, bigint) to service_role;
revoke all on function public.mark_agent_request_dispatched(bigint, uuid, date) from public, anon, authenticated;
grant execute on function public.mark_agent_request_dispatched(bigint, uuid, date) to service_role;
revoke all on function public.release_agent_request(bigint, uuid, date) from public, anon, authenticated;
grant execute on function public.release_agent_request(bigint, uuid, date) to service_role;
revoke all on function public.settle_groq_token_usage(bigint, uuid, date, bigint, bigint) from public, anon, authenticated;
grant execute on function public.settle_groq_token_usage(bigint, uuid, date, bigint, bigint) to service_role;

comment on function public.reserve_groq_request_and_tokens(uuid, text, text, text, integer, text, date, integer, integer, bigint, bigint, bigint)
  is 'Atomically reserves one Groq request and estimated tokens in one provider-scoped UTC ledger row; hard/soft limits are supplied by server configuration.';
comment on function public.mark_agent_request_dispatched(bigint, uuid, date)
  is 'Marks an owned request reservation dispatched under the provider/day lock; dispatched capacity cannot be released.';
comment on function public.release_agent_request(bigint, uuid, date)
  is 'Releases an owned pre-dispatch reservation; for Groq this atomically frees request and token capacity.';
comment on function public.settle_groq_token_usage(bigint, uuid, date, bigint, bigint)
  is 'Idempotently reconciles a dispatched Groq token estimate to trusted input plus output usage in its original UTC day.';

commit;
