-- M36: fix local rolling TPM eligibility for completed request-only legacy records.
-- No date/ID/source exceptions. Current holds, active lifecycle claims, daily limits,
-- service_role ACL, provider/day lock, and M33/M35 continuation semantics are preserved.
begin;

create or replace function public.reserve_groq_request_and_tokens_m35(
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
  p_token_minute_hard_limit bigint,
  p_safety_margin_tokens integer,
  p_estimated_tokens bigint
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_window_start timestamptz := now() - interval '60 seconds';
  v_minute_usage numeric := 0;
  v_unknown_minute bigint := 0;
  v_request_usage bigint := 0;
  v_day_token_usage numeric := 0;
  v_result jsonb;
  v_reason text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'groq_capacity_service_role_required';
  end if;
  if p_run_id is null or not exists (select 1 from public.agent_runs where id = p_run_id and provider = 'groq')
     or p_agent_name is null or length(trim(p_agent_name)) = 0
     or p_agent_version is null or length(trim(p_agent_version)) = 0
     or p_model is distinct from 'openai/gpt-oss-20b'
     or p_attempt is null or p_attempt < 1
     or p_request_date is null or p_request_date is distinct from (now() at time zone 'UTC')::date
     or p_request_hard_limit is null or p_request_hard_limit < 1
     or p_request_soft_limit is null or p_request_soft_limit < 1 or p_request_soft_limit > p_request_hard_limit
     or p_token_hard_limit is null or p_token_hard_limit < 1
     or p_token_soft_limit is null or p_token_soft_limit < 1 or p_token_soft_limit > p_token_hard_limit
     or p_token_minute_hard_limit is null or p_token_minute_hard_limit < 1
     or p_safety_margin_tokens is null or p_safety_margin_tokens < 0
     or p_estimated_tokens is null or p_estimated_tokens < 1 then
    raise exception using errcode = '22023', message = 'groq_capacity_inputs_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('horizai-agent-budget:groq:' || p_request_date::text, 0));

  select coalesce(sum(case when l.provider_unit = 'tokens' then l.provider_unit_amount else 0 end), 0)::numeric
    into v_minute_usage
    from public.agent_logs as l
   where l.step = 'provider_request_reserved'
     and (l.provider = 'groq' or l.provider is null)
     -- Only completed, request-only legacy rows can age out without a dispatch marker.
     -- Explicit undispatched holds and malformed/partial modern rows remain authoritative.
     and not coalesce((
       l.provider_unit is null and l.provider_unit_amount is null
       and jsonb_typeof(l.payload) = 'object'
       and not (l.payload ?| array['providerRequestDispatched', 'dispatchedAt', 'estimatedTokens', 'tokenUsageState'])
       and exists (
         select 1 from public.agent_runs r
          where r.id = l.run_id and r.provider = 'groq'
            and r.status in ('succeeded', 'failed')
            and r.finished_at is not null
            and not exists (
              select 1 from public.pipeline_event_attempts a
               where (a.completed_at is null or a.final_state is null)
                 and (a.pipeline_run_id::text = r.config ->> 'pipelineRunId'
                   or a.event_key = r.config ->> 'eventKey')
            )
            and greatest(r.started_at, r.finished_at, r.updated_at, l.created_at) <= v_window_start
       )
     ), false)
     and (
       coalesce(l.payload ->> 'providerRequestDispatched', 'false') <> 'true'
       or coalesce(nullif(l.payload ->> 'dispatchedAt', '')::timestamptz, l.created_at) >= v_window_start
     )
     and (l.provider_unit = 'tokens' or coalesce(l.payload ->> 'providerRequestDispatched', 'false') <> 'true');

  -- Recompute separately so malformed legacy usage cannot be hidden by a coalesce.
  select count(*)::bigint into v_unknown_minute
    from public.agent_logs as l
   where l.step = 'provider_request_reserved'
     and (l.provider = 'groq' or l.provider is null)
     -- Only completed, request-only legacy rows can age out without a dispatch marker.
     -- Explicit undispatched holds and malformed/partial modern rows remain authoritative.
     and not coalesce((
       l.provider_unit is null and l.provider_unit_amount is null
       and jsonb_typeof(l.payload) = 'object'
       and not (l.payload ?| array['providerRequestDispatched', 'dispatchedAt', 'estimatedTokens', 'tokenUsageState'])
       and exists (
         select 1 from public.agent_runs r
          where r.id = l.run_id and r.provider = 'groq'
            and r.status in ('succeeded', 'failed')
            and r.finished_at is not null
            and not exists (
              select 1 from public.pipeline_event_attempts a
               where (a.completed_at is null or a.final_state is null)
                 and (a.pipeline_run_id::text = r.config ->> 'pipelineRunId'
                   or a.event_key = r.config ->> 'eventKey')
            )
            and greatest(r.started_at, r.finished_at, r.updated_at, l.created_at) <= v_window_start
       )
     ), false)
     and (coalesce(l.payload ->> 'providerRequestDispatched', 'false') <> 'true'
       or coalesce(nullif(l.payload ->> 'dispatchedAt', '')::timestamptz, l.created_at) >= v_window_start)
     and (l.provider_unit is distinct from 'tokens' or l.provider_unit_amount is null or l.provider_unit_amount < 1
       or jsonb_typeof(l.payload) is distinct from 'object'
       or (l.payload ? 'providerRequestDispatched' and jsonb_typeof(l.payload -> 'providerRequestDispatched') is distinct from 'boolean'));

  select count(*)::bigint, coalesce(sum(case when provider_unit = 'tokens' then provider_unit_amount else 0 end), 0)::numeric
    into v_request_usage, v_day_token_usage
    from public.agent_logs
   where step = 'provider_request_reserved'
     and (provider = 'groq' or provider is null)
     and created_at >= (p_request_date::text || ' 00:00:00+00')::timestamptz
     and created_at < ((p_request_date + 1)::text || ' 00:00:00+00')::timestamptz;

  if v_unknown_minute > 0 then
    v_reason := 'GROQ_TPM_LOCAL_USAGE_UNKNOWN';
  elsif v_minute_usage + p_estimated_tokens + p_safety_margin_tokens > p_token_minute_hard_limit then
    v_reason := 'GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED';
  end if;

  if v_reason is not null then
    return jsonb_build_object(
      'allowed', false, 'admitted', false, 'reason', v_reason,
      'dailyCount', v_request_usage, 'dailyLimit', p_request_hard_limit,
      'requestDate', p_request_date::text, 'quotaPeriodUtc', p_request_date::text,
      'requestUsageBefore', v_request_usage, 'requestUsageAfter', v_request_usage,
      'tokenUsageBefore', v_day_token_usage, 'tokenUsageAfter', v_day_token_usage,
      'reservedTokens', p_estimated_tokens,
      'requestHardLimit', p_request_hard_limit, 'requestSoftLimit', p_request_soft_limit,
      'tokenHardLimit', p_token_hard_limit, 'tokenSoftLimit', p_token_soft_limit,
      'minuteTokenUsageBefore', v_minute_usage, 'minuteTokenUsageAfter', v_minute_usage,
      'minuteTokenHardLimit', p_token_minute_hard_limit, 'safetyMarginTokens', p_safety_margin_tokens
    );
  end if;

  v_result := public.reserve_groq_request_and_tokens(
    p_run_id, p_agent_name, p_agent_version, p_event_key, p_attempt, p_model,
    p_request_date, p_request_hard_limit, p_request_soft_limit,
    p_token_hard_limit, p_token_soft_limit, p_estimated_tokens
  );
  return v_result || jsonb_build_object(
    'minuteTokenUsageBefore', v_minute_usage,
    'minuteTokenUsageAfter', v_minute_usage + case when v_result ->> 'allowed' = 'true' then p_estimated_tokens else 0 end,
    'minuteTokenHardLimit', p_token_minute_hard_limit,
    'safetyMarginTokens', p_safety_margin_tokens
  );
end;
$function$;

commit;
