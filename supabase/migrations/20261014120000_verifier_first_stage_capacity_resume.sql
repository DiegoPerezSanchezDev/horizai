-- M35: extend the existing retry-neutral lifecycle to Verifier/Translator and enforce rolling local Groq TPM atomically.
begin;

create function public.defer_pipeline_event_attempt_capacity_m35(
  p_attempt_id uuid,
  p_event_key text,
  p_pipeline_run_id uuid,
  p_resume_stage text,
  p_snapshot jsonb,
  p_provider_request_dispatched boolean,
  p_provider_requests_used integer,
  p_owner_id uuid default null,
  p_claimed_stage text default null
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_attempt public.pipeline_event_attempts%rowtype;
  v_previous_stages text[];
  v_previous_stage text;
  v_stage_order text[] := array['verifier', 'translator', 'editor', 'classifier', 'ranker', 'critic'];
  v_snapshot_allowed_keys text[] := array[
    'schemaVersion', 'kind', 'attemptId', 'pipelineRunId', 'eventKey', 'resumeStage', 'attemptStartedAt',
    'event', 'items', 'sources', 'verification', 'translation', 'editorial',
    'classification', 'geo', 'ranking', 'criticInputOverride', 'checkpoints',
    'checkpointSha256', 'providerAccounting', 'nextStageDispatchCount',
    'nextStageCheckpointPresent', 'classifierDispatchCount',
    'classifierCheckpointPresent', 'resumeGeneration'
  ];
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'capacity_attempt_service_role_required';
  end if;
  if p_attempt_id is null or p_pipeline_run_id is null or length(trim(coalesce(p_event_key, ''))) not between 1 and 200
     or p_resume_stage is null or not (p_resume_stage = any(v_stage_order))
     or p_provider_request_dispatched is distinct from false
     or p_provider_requests_used is distinct from 0
     or ((p_owner_id is null) <> (p_claimed_stage is null))
     or (p_owner_id is not null and not (p_claimed_stage = any(v_stage_order))) then
    raise exception using errcode = '22023', message = 'capacity_defer_inputs_invalid';
  end if;

  if p_snapshot is null or jsonb_typeof(p_snapshot) is distinct from 'object'
     or pg_column_size(p_snapshot) > 2097152
     or jsonb_typeof(p_snapshot -> 'schemaVersion') is distinct from 'number'
     or p_snapshot ->> 'schemaVersion' is distinct from '1'
     or p_snapshot ->> 'kind' is distinct from 'SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME'
     or p_snapshot ->> 'attemptId' is distinct from p_attempt_id::text
     or p_snapshot ->> 'pipelineRunId' is distinct from p_pipeline_run_id::text
     or p_snapshot ->> 'eventKey' is distinct from p_event_key
     or p_snapshot ->> 'resumeStage' is distinct from p_resume_stage
     or jsonb_typeof(p_snapshot -> 'event') is distinct from 'object'
     or p_snapshot #>> '{event,eventKey}' is distinct from p_event_key
     or jsonb_typeof(p_snapshot #> '{event,sourceItems}') is distinct from 'array'
     or jsonb_typeof(p_snapshot -> 'items') is distinct from 'array'
     or jsonb_typeof(p_snapshot -> 'sources') is distinct from 'array'
     or jsonb_typeof(p_snapshot -> 'attemptStartedAt') is distinct from 'string'
     or coalesce(p_snapshot ->> 'attemptStartedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+]00:00)$'
     or jsonb_typeof(p_snapshot -> 'checkpoints') is distinct from 'object'
     or jsonb_typeof(p_snapshot -> 'checkpointSha256') is distinct from 'object'
     or jsonb_typeof(p_snapshot -> 'providerAccounting') is distinct from 'object'
     or jsonb_typeof(p_snapshot -> 'nextStageDispatchCount') is distinct from 'number'
     or p_snapshot ->> 'nextStageDispatchCount' is distinct from '0'
     or jsonb_typeof(p_snapshot -> 'nextStageCheckpointPresent') is distinct from 'boolean'
     or p_snapshot ->> 'nextStageCheckpointPresent' is distinct from 'false'
     or jsonb_typeof(p_snapshot -> 'resumeGeneration') is distinct from 'number'
     or coalesce(p_snapshot ->> 'resumeGeneration', '') !~ '^(0|[1-9][0-9]{0,2})$'
     or exists (
       select 1 from jsonb_object_keys(p_snapshot) as k(key)
        where not (k.key = any(v_snapshot_allowed_keys))
     )
     or not (p_snapshot ?& array[
       'schemaVersion', 'kind', 'attemptId', 'pipelineRunId', 'eventKey', 'resumeStage',
       'event', 'items', 'sources', 'attemptStartedAt', 'checkpoints',
       'checkpointSha256', 'providerAccounting', 'nextStageDispatchCount',
       'nextStageCheckpointPresent', 'resumeGeneration'
     ]) then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_contract_invalid';
  end if;

  v_previous_stages := case p_resume_stage
    when 'verifier' then array[]::text[]
    when 'translator' then array['verifier']
    when 'editor' then array['verifier', 'translator']
    when 'classifier' then array['verifier', 'translator', 'editor']
    when 'ranker' then array['verifier', 'translator', 'editor', 'classifier']
    when 'critic' then array['verifier', 'translator', 'editor', 'classifier', 'ranker']
  end;
  if jsonb_array_length(p_snapshot -> 'items') = 0
     or jsonb_array_length(p_snapshot -> 'items') <> jsonb_array_length(p_snapshot #> '{event,sourceItems}')
     or jsonb_array_length(p_snapshot -> 'sources') <> jsonb_array_length(p_snapshot #> '{event,sourceItems}')
     or (select count(*) from jsonb_object_keys(p_snapshot -> 'checkpoints')) <> cardinality(v_previous_stages)
     or (select count(*) from jsonb_object_keys(p_snapshot -> 'checkpointSha256')) <> cardinality(v_previous_stages)
     or (select count(*) from jsonb_object_keys(p_snapshot -> 'providerAccounting')) <> cardinality(v_previous_stages)
     or exists (
       select 1 from jsonb_object_keys(p_snapshot -> 'checkpoints') as k(key)
        where not (k.key = any(v_previous_stages))
     )
     or exists (
       select 1 from jsonb_object_keys(p_snapshot -> 'checkpointSha256') as k(key)
        where not (k.key = any(v_previous_stages))
     )
     or exists (
       select 1 from jsonb_object_keys(p_snapshot -> 'providerAccounting') as k(key)
        where not (k.key = any(v_previous_stages))
     ) then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_stage_set_invalid';
  end if;

  foreach v_previous_stage in array v_previous_stages loop
    if p_snapshot #>> array['checkpoints', v_previous_stage, 'stage'] is distinct from v_previous_stage
       or p_snapshot #>> array['checkpoints', v_previous_stage, 'eventKey'] is distinct from p_event_key
       or p_snapshot #>> array['checkpoints', v_previous_stage, 'written'] is distinct from 'true'
       or p_snapshot #>> array['checkpoints', v_previous_stage, 'readable'] is distinct from 'true'
       or p_snapshot #>> array['checkpoints', v_previous_stage, 'valid'] is distinct from 'true'
       or length(trim(coalesce(p_snapshot #>> array['checkpoints', v_previous_stage, 'path'], ''))) = 0
       or coalesce(p_snapshot #>> array['checkpointSha256', v_previous_stage], '') !~ '^[a-f0-9]{64}$'
       or p_snapshot #>> array['providerAccounting', v_previous_stage, 'status'] is distinct from 'SUCCESS'
       or p_snapshot #>> array['providerAccounting', v_previous_stage, 'provider'] is distinct from 'groq'
       or p_snapshot #>> array['providerAccounting', v_previous_stage, 'providerRequestDispatched'] is distinct from 'true'
       or p_snapshot #>> array['providerAccounting', v_previous_stage, 'providerRequestsUsed'] is distinct from '1'
       or p_snapshot #>> array['providerAccounting', v_previous_stage, 'attempts'] is distinct from '1'
       or p_snapshot #>> array['providerAccounting', v_previous_stage, 'retries'] is distinct from '0'
       or p_snapshot #>> array['providerAccounting', v_previous_stage, 'providerUnit'] is distinct from 'tokens'
       or p_snapshot #>> array['providerAccounting', v_previous_stage, 'providerUnitUsageKnown'] is distinct from 'true'
       or coalesce(p_snapshot #>> array['providerAccounting', v_previous_stage, 'inputTokens'], '') !~ '^[0-9]+$'
       or coalesce(p_snapshot #>> array['providerAccounting', v_previous_stage, 'outputTokens'], '') !~ '^[0-9]+$'
       or coalesce(p_snapshot #>> array['providerAccounting', v_previous_stage, 'totalTokens'], '') !~ '^[1-9][0-9]*$'
       or (p_snapshot #>> array['providerAccounting', v_previous_stage, 'inputTokens'])::bigint
          + (p_snapshot #>> array['providerAccounting', v_previous_stage, 'outputTokens'])::bigint
          <> (p_snapshot #>> array['providerAccounting', v_previous_stage, 'totalTokens'])::bigint then
      raise exception using errcode = '22023', message = 'capacity_resume_snapshot_checkpoint_invalid';
    end if;
  end loop;

  if exists (
    select 1
      from jsonb_array_elements(p_snapshot #> '{event,sourceItems}') as event_source(value)
      left join jsonb_array_elements(p_snapshot -> 'items') as item(value)
        on item.value ->> 'candidateId' = event_source.value ->> 'candidateId'
      left join jsonb_array_elements(p_snapshot -> 'sources') as source(value)
        on source.value ->> 'sourceItemId' = event_source.value ->> 'candidateId'
     where item.value is null
        or source.value is null
        or source.value ->> 'sourceId' is distinct from event_source.value ->> 'sourceId'
        or source.value ->> 'sourceUrl' is distinct from item.value ->> 'canonicalUrl'
        or nullif(source.value ->> 'rawItemId', '') is null
        or source.value ->> 'rawItemId' = 'null'
        or item.value #>> '{metadata,sourceId}' is distinct from event_source.value ->> 'sourceId'
  ) then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_source_lineage_invalid';
  end if;
  if p_resume_stage = 'verifier' and (p_snapshot ? 'verification' or p_snapshot ? 'translation' or p_snapshot ? 'editorial' or p_snapshot ? 'classification' or p_snapshot ? 'geo' or p_snapshot ? 'ranking') then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_future_output_present';
  end if;
  if p_resume_stage = 'translator' and (jsonb_typeof(p_snapshot -> 'verification') is distinct from 'object' or p_snapshot #>> '{verification,eventKey}' is distinct from p_event_key or p_snapshot ? 'translation' or p_snapshot ? 'editorial' or p_snapshot ? 'classification' or p_snapshot ? 'geo' or p_snapshot ? 'ranking') then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_prior_output_missing';
  end if;
  if p_resume_stage not in ('verifier', 'translator') and (jsonb_typeof(p_snapshot -> 'verification') is distinct from 'object' or p_snapshot #>> '{verification,eventKey}' is distinct from p_event_key or jsonb_typeof(p_snapshot -> 'translation') is distinct from 'object' or p_snapshot #>> '{translation,eventKey}' is distinct from p_event_key) then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_prior_output_missing';
  end if;
  if p_resume_stage in ('classifier', 'ranker', 'critic') and not (p_snapshot ? 'editorial') then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_prior_output_missing';
  end if;
  if p_resume_stage in ('ranker', 'critic') and (not (p_snapshot ? 'classification') or not (p_snapshot ? 'geo')) then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_prior_output_missing';
  end if;
  if p_resume_stage = 'critic' and not (p_snapshot ? 'ranking') then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_prior_output_missing';
  end if;
  if (p_snapshot -> 'checkpoints') ? p_resume_stage then
    raise exception using errcode = '22023', message = 'capacity_resume_snapshot_next_checkpoint_present';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_event_key, 0));
  select * into v_attempt
    from public.pipeline_event_attempts
   where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id
   for update;
  if v_attempt.id is null then
    raise exception using errcode = 'P0002', message = 'capacity_attempt_identity_not_found';
  end if;
  if date_trunc('milliseconds', (p_snapshot ->> 'attemptStartedAt')::timestamptz) is distinct from date_trunc('milliseconds', v_attempt.started_at) then
    raise exception using errcode = '22023', message = 'capacity_attempt_start_time_mismatch';
  end if;
  if v_attempt.purpose is distinct from 'NORMAL' then
    raise exception using errcode = '22023', message = 'capacity_attempt_purpose_invalid';
  end if;
  if v_attempt.completed_at is not null or v_attempt.final_state is not null then
    raise exception using errcode = '22023', message = 'capacity_attempt_terminal';
  end if;
  if exists (
    select 1 from public.agent_runs as ar
     where ar.config ->> 'pipelineRunId' = p_pipeline_run_id::text
       and ar.config ->> 'eventKey' = p_event_key
       and ar.config ->> 'agentName' = p_resume_stage
       and (
         ar.stats #>> '{telemetry,providerRequestDispatched}' = 'true'
         or ar.stats #>> '{telemetry,providerRequestsUsed}' ~ '^[1-9][0-9]*$'
         or exists (
           select 1 from public.agent_logs as l
            where l.run_id = ar.id
              and (l.step = 'provider_request_reserved'
                or l.payload ->> 'providerRequestDispatched' = 'true'
                or l.payload #>> '{details,providerRequestDispatched}' = 'true'
                or l.payload #>> '{diagnostics,providerRequestDispatched}' = 'true')
         )
       )
  ) then
    raise exception using errcode = '22023', message = 'capacity_defer_dispatch_evidence_conflict';
  end if;

  if p_owner_id is null then
    if p_snapshot ->> 'resumeGeneration' is distinct from '0' then
      raise exception using errcode = '22023', message = 'capacity_initial_resume_generation_invalid';
    end if;
    if v_attempt.completed_at is null and v_attempt.final_state is null
       and v_attempt.stop_stage = p_resume_stage
       and v_attempt.stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED'
       and v_attempt.retry_class = 'NONE'
       and not v_attempt.counts_toward_retry_limit
       and v_attempt.next_eligible_at is null
       and v_attempt.capacity_resume_snapshot = p_snapshot then
      return jsonb_build_object('status', 'ALREADY_DEFERRED', 'attemptId', p_attempt_id, 'resumeStage', p_resume_stage);
    end if;
    if v_attempt.stop_stage is not null or v_attempt.stop_reason is not null
       or v_attempt.retry_class is distinct from 'NONE'
       or v_attempt.counts_toward_retry_limit
       or v_attempt.next_eligible_at is not null then
      raise exception using errcode = '22023', message = 'capacity_attempt_not_active';
    end if;
  else
    if p_snapshot ->> 'resumeGeneration' is distinct from ((v_attempt.capacity_resume_snapshot ->> 'resumeGeneration')::integer + 1)::text
       or array_position(v_stage_order, p_resume_stage) < array_position(v_stage_order, p_claimed_stage)
       or v_attempt.stop_stage is distinct from p_claimed_stage
       or v_attempt.stop_reason is distinct from ('CAPACITY_RESUME_CLAIMED:' || p_owner_id::text)
       or v_attempt.capacity_resume_snapshot is null
       or v_attempt.capacity_resume_snapshot ->> 'attemptId' is distinct from p_attempt_id::text then
      raise exception using errcode = '22023', message = 'capacity_resume_owner_or_generation_changed';
    end if;
  end if;

  update public.pipeline_event_attempts
     set stop_stage = p_resume_stage,
         stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED',
         retry_class = 'NONE',
         counts_toward_retry_limit = false,
         next_eligible_at = null,
         capacity_resume_snapshot = p_snapshot
   where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id
     and completed_at is null and final_state is null;
  if not found then
    raise exception using errcode = '40001', message = 'capacity_defer_compare_and_set_lost';
  end if;
  return jsonb_build_object('status', 'DEFERRED', 'attemptId', p_attempt_id, 'resumeStage', p_resume_stage);
end;
$function$;

create function public.claim_pipeline_event_attempt_capacity_resume_m35(
  p_attempt_id uuid,
  p_event_key text,
  p_pipeline_run_id uuid,
  p_resume_stage text,
  p_owner_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_attempt public.pipeline_event_attempts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'capacity_attempt_service_role_required';
  end if;
  if p_attempt_id is null or length(trim(coalesce(p_event_key, ''))) = 0
     or p_pipeline_run_id is null or p_owner_id is null
     or p_resume_stage not in ('verifier', 'translator', 'editor', 'classifier', 'ranker', 'critic') then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_key, 0));
  select * into v_attempt
    from public.pipeline_event_attempts
   where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id
   for update;
  if v_attempt.id is null or v_attempt.completed_at is not null or v_attempt.final_state is not null
     or v_attempt.purpose is distinct from 'NORMAL'
     or v_attempt.stop_stage is distinct from p_resume_stage
     or v_attempt.stop_reason is distinct from 'PROVIDER_CAPACITY_EXHAUSTED'
     or v_attempt.retry_class is distinct from 'NONE'
     or v_attempt.counts_toward_retry_limit
     or v_attempt.next_eligible_at is not null
     or v_attempt.capacity_resume_snapshot is null
     or v_attempt.capacity_resume_snapshot ->> 'attemptId' is distinct from p_attempt_id::text
     or v_attempt.capacity_resume_snapshot ->> 'pipelineRunId' is distinct from p_pipeline_run_id::text
     or v_attempt.capacity_resume_snapshot ->> 'eventKey' is distinct from p_event_key
     or v_attempt.capacity_resume_snapshot ->> 'resumeStage' is distinct from p_resume_stage then
    return false;
  end if;
  update public.pipeline_event_attempts
     set stop_reason = 'CAPACITY_RESUME_CLAIMED:' || p_owner_id::text
   where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id
     and completed_at is null and final_state is null and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED';
  return found;
end;
$function$;

create function public.release_pipeline_event_attempt_capacity_resume_m35(
  p_attempt_id uuid,
  p_event_key text,
  p_pipeline_run_id uuid,
  p_resume_stage text,
  p_owner_id uuid
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'capacity_attempt_service_role_required';
  end if;
  if p_attempt_id is null or length(trim(coalesce(p_event_key, ''))) = 0
     or p_pipeline_run_id is null or p_owner_id is null
     or p_resume_stage not in ('verifier', 'translator', 'editor', 'classifier', 'ranker', 'critic') then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_key, 0));
  update public.pipeline_event_attempts
     set stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED'
   where id = p_attempt_id and event_key = p_event_key and pipeline_run_id = p_pipeline_run_id
     and stop_stage = p_resume_stage
     and stop_reason = 'CAPACITY_RESUME_CLAIMED:' || p_owner_id::text
     and completed_at is null and final_state is null
     and retry_class = 'NONE' and counts_toward_retry_limit = false
     and capacity_resume_snapshot ->> 'resumeStage' = p_resume_stage;
  return found;
end;
$function$;

create function public.reserve_groq_request_and_tokens_m35(
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
     and (coalesce(l.payload ->> 'providerRequestDispatched', 'false') <> 'true'
       or coalesce(nullif(l.payload ->> 'dispatchedAt', '')::timestamptz, l.created_at) >= v_window_start)
     and (l.provider_unit is distinct from 'tokens' or l.provider_unit_amount is null or l.provider_unit_amount < 1);

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

revoke all on function public.defer_pipeline_event_attempt_capacity_m35(uuid, text, uuid, text, jsonb, boolean, integer, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_pipeline_event_attempt_capacity_resume_m35(uuid, text, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.release_pipeline_event_attempt_capacity_resume_m35(uuid, text, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.reserve_groq_request_and_tokens_m35(uuid, text, text, text, integer, text, date, integer, integer, bigint, bigint, bigint, integer, bigint) from public, anon, authenticated, service_role;

grant execute on function public.defer_pipeline_event_attempt_capacity_m35(uuid, text, uuid, text, jsonb, boolean, integer, uuid, text) to service_role;
grant execute on function public.claim_pipeline_event_attempt_capacity_resume_m35(uuid, text, uuid, text, uuid) to service_role;
grant execute on function public.release_pipeline_event_attempt_capacity_resume_m35(uuid, text, uuid, text, uuid) to service_role;
grant execute on function public.reserve_groq_request_and_tokens_m35(uuid, text, text, text, integer, text, date, integer, integer, bigint, bigint, bigint, integer, bigint) to service_role;

comment on function public.defer_pipeline_event_attempt_capacity_m35(uuid, text, uuid, text, jsonb, boolean, integer, uuid, text) is 'M35 validated retry-neutral capacity defer from the first missing Groq stage; service_role EXECUTE only.';
comment on function public.claim_pipeline_event_attempt_capacity_resume_m35(uuid, text, uuid, text, uuid) is 'M35 single-owner compare-and-set claim for the same active capacity-deferred attempt.';
comment on function public.release_pipeline_event_attempt_capacity_resume_m35(uuid, text, uuid, text, uuid) is 'M35 owner-checked release of the same capacity-deferred attempt.';
comment on function public.reserve_groq_request_and_tokens_m35(uuid, text, text, text, integer, text, date, integer, integer, bigint, bigint, bigint, integer, bigint) is 'Atomically enforces the local rolling 60-second Groq TPM ledger and delegates daily reservation to M25 under the same provider/day advisory lock.';

commit;
