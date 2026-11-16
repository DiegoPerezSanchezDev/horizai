do $fixture$
declare
  v_event_key constant text := '__synthetic_m33_capacity_fixture__';
  v_pipeline_run_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_wrong_attempt_id uuid := gen_random_uuid();
  v_source_id uuid := gen_random_uuid();
  v_raw_item_id uuid := gen_random_uuid();
  v_candidate_id text := gen_random_uuid()::text || ':synthetic-item';
  v_owner_id uuid := gen_random_uuid();
  v_snapshot jsonb;
  v_next_snapshot jsonb;
  v_wrong_snapshot jsonb;
  v_wrong_event_snapshot jsonb;
  v_conflicting_snapshot jsonb;
  v_result jsonb;
  v_claimed boolean;
  v_released boolean;
  v_residual_rows bigint;
  v_previous_stage text;
  v_invalid_fields text[] := array[]::text[];
begin
  begin
  if exists (select 1 from public.pipeline_event_attempts where event_key = v_event_key) then
    raise exception 'm33_fixture_namespace_not_empty';
  end if;

  insert into public.pipeline_event_attempts (
    id, event_key, pipeline_run_id, attempt_number, started_at, purpose
  ) values (
    v_attempt_id, v_event_key, v_pipeline_run_id, 1, clock_timestamp(), 'NORMAL'
  );

  v_snapshot := jsonb_build_object(
    'schemaVersion', 1,
    'kind', 'SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME',
    'attemptId', v_attempt_id,
    'pipelineRunId', v_pipeline_run_id,
    'eventKey', v_event_key,
    'resumeStage', 'editor',
    'event', jsonb_build_object(
      'schemaVersion', 1, 'eventKey', v_event_key, 'canonicalTitle', 'Synthetic event',
      'sourceItems', jsonb_build_array(jsonb_build_object(
        'candidateId', v_candidate_id, 'sourceId', v_source_id, 'sourceName', 'Synthetic source',
        'url', 'https://example.invalid/synthetic', 'title', 'Synthetic source item', 'publishedAt', null
      ))
    ),
    'items', jsonb_build_array(jsonb_build_object(
      'candidateId', v_candidate_id, 'canonicalUrl', 'https://example.invalid/synthetic',
      'metadata', jsonb_build_object('sourceId', v_source_id)
    )),
    'sources', jsonb_build_array(jsonb_build_object(
      'sourceId', v_source_id, 'sourceItemId', v_candidate_id, 'rawItemId', v_raw_item_id,
      'sourceName', 'Synthetic source', 'sourceUrl', 'https://example.invalid/synthetic'
    )),
    'verification', jsonb_build_object('eventKey', v_event_key),
    'translation', jsonb_build_object('eventKey', v_event_key),
    'checkpoints', jsonb_build_object(
      'verifier', jsonb_build_object('stage', 'verifier', 'eventKey', v_event_key, 'path', 'synthetic://verifier', 'written', true, 'readable', true, 'valid', true),
      'translator', jsonb_build_object('stage', 'translator', 'eventKey', v_event_key, 'path', 'synthetic://translator', 'written', true, 'readable', true, 'valid', true)
    ),
    'checkpointSha256', jsonb_build_object('verifier', repeat('a', 64), 'translator', repeat('b', 64)),
    'providerAccounting', jsonb_build_object(
      'verifier', jsonb_build_object('status', 'SUCCESS', 'provider', 'groq', 'providerRequestDispatched', true, 'providerRequestsUsed', 1, 'attempts', 1, 'retries', 0, 'providerUnit', 'tokens', 'providerUnitUsageKnown', true, 'inputTokens', 2, 'outputTokens', 3, 'totalTokens', 5),
      'translator', jsonb_build_object('status', 'SUCCESS', 'provider', 'groq', 'providerRequestDispatched', true, 'providerRequestsUsed', 1, 'attempts', 1, 'retries', 0, 'providerUnit', 'tokens', 'providerUnitUsageKnown', true, 'inputTokens', 2, 'outputTokens', 3, 'totalTokens', 5)
    ),
    'nextStageDispatchCount', 0,
    'nextStageCheckpointPresent', false,
    'resumeGeneration', 0
  );

  foreach v_previous_stage in array array['verifier', 'translator'] loop
    if v_snapshot #>> array['checkpoints', v_previous_stage, 'stage'] is distinct from v_previous_stage then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':checkpoint_stage'); end if;
    if v_snapshot #>> array['checkpoints', v_previous_stage, 'eventKey'] is distinct from v_event_key then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':checkpoint_event'); end if;
    if v_snapshot #>> array['checkpoints', v_previous_stage, 'written'] is distinct from 'true' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':checkpoint_written'); end if;
    if v_snapshot #>> array['checkpoints', v_previous_stage, 'readable'] is distinct from 'true' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':checkpoint_readable'); end if;
    if v_snapshot #>> array['checkpoints', v_previous_stage, 'valid'] is distinct from 'true' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':checkpoint_valid'); end if;
    if length(trim(coalesce(v_snapshot #>> array['checkpoints', v_previous_stage, 'path'], ''))) = 0 then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':checkpoint_path'); end if;
    if coalesce(v_snapshot #>> array['checkpointSha256', v_previous_stage], '') !~ '^[a-f0-9]{64}$' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':checkpoint_hash'); end if;
    if v_snapshot #>> array['providerAccounting', v_previous_stage, 'status'] is distinct from 'SUCCESS' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':status'); end if;
    if v_snapshot #>> array['providerAccounting', v_previous_stage, 'provider'] is distinct from 'groq' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':provider'); end if;
    if v_snapshot #>> array['providerAccounting', v_previous_stage, 'providerRequestDispatched'] is distinct from 'true' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':dispatched'); end if;
    if v_snapshot #>> array['providerAccounting', v_previous_stage, 'providerRequestsUsed'] is distinct from '1' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':requests'); end if;
    if v_snapshot #>> array['providerAccounting', v_previous_stage, 'attempts'] is distinct from '1' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':attempts'); end if;
    if v_snapshot #>> array['providerAccounting', v_previous_stage, 'retries'] is distinct from '0' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':retries'); end if;
    if v_snapshot #>> array['providerAccounting', v_previous_stage, 'providerUnit'] is distinct from 'tokens' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':unit'); end if;
    if v_snapshot #>> array['providerAccounting', v_previous_stage, 'providerUnitUsageKnown'] is distinct from 'true' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':usage_known'); end if;
    if coalesce(v_snapshot #>> array['providerAccounting', v_previous_stage, 'inputTokens'], '') !~ '^[0-9]+$' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':input_tokens'); end if;
    if coalesce(v_snapshot #>> array['providerAccounting', v_previous_stage, 'outputTokens'], '') !~ '^[0-9]+$' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':output_tokens'); end if;
    if coalesce(v_snapshot #>> array['providerAccounting', v_previous_stage, 'totalTokens'], '') !~ '^[1-9][0-9]*$' then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':total_tokens'); end if;
    if coalesce(v_snapshot #>> array['providerAccounting', v_previous_stage, 'inputTokens'], '0')::bigint
       + coalesce(v_snapshot #>> array['providerAccounting', v_previous_stage, 'outputTokens'], '0')::bigint
       <> coalesce(v_snapshot #>> array['providerAccounting', v_previous_stage, 'totalTokens'], '0')::bigint then v_invalid_fields := array_append(v_invalid_fields, v_previous_stage || ':token_sum'); end if;
  end loop;
  if cardinality(v_invalid_fields) > 0 then raise exception 'm33_fixture_snapshot_invalid:%', array_to_string(v_invalid_fields, ','); end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_result := public.defer_pipeline_event_attempt_capacity(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_snapshot, false, 0
  );
  if v_result ->> 'status' <> 'DEFERRED' then raise exception 'm33_valid_defer_failed'; end if;
  if not exists (
    select 1 from public.pipeline_event_attempts
     where id = v_attempt_id and attempt_number = 1 and completed_at is null and final_state is null
       and stop_stage = 'editor' and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED'
       and retry_class = 'NONE' and counts_toward_retry_limit = false and next_eligible_at is null
       and capacity_resume_snapshot = v_snapshot
  ) then raise exception 'm33_defer_state_invalid'; end if;

  v_result := public.defer_pipeline_event_attempt_capacity(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_snapshot, false, 0
  );
  if v_result ->> 'status' <> 'ALREADY_DEFERRED' then raise exception 'm33_identical_defer_not_idempotent'; end if;

  v_conflicting_snapshot := jsonb_set(v_snapshot, '{event,canonicalTitle}', '"Conflicting synthetic snapshot"'::jsonb);
  begin
    perform public.defer_pipeline_event_attempt_capacity(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_conflicting_snapshot, false, 0
    );
    raise exception 'm33_conflicting_defer_was_accepted';
  exception when sqlstate '22023' then null;
  end;

  v_wrong_event_snapshot := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(v_snapshot, '{eventKey}', to_jsonb(v_event_key || '-wrong')),
          '{event,eventKey}', to_jsonb(v_event_key || '-wrong')
        ),
        '{checkpoints,verifier,eventKey}', to_jsonb(v_event_key || '-wrong')
      ),
      '{checkpoints,translator,eventKey}', to_jsonb(v_event_key || '-wrong')
    ),
    '{verification,eventKey}', to_jsonb(v_event_key || '-wrong')
  );
  v_wrong_event_snapshot := jsonb_set(
    v_wrong_event_snapshot,
    '{translation,eventKey}', to_jsonb(v_event_key || '-wrong')
  );
  begin
    perform public.defer_pipeline_event_attempt_capacity(
      v_attempt_id, v_event_key || '-wrong', v_pipeline_run_id, 'editor', v_wrong_event_snapshot, false, 0
    );
    raise exception 'm33_wrong_event_was_accepted';
  exception when sqlstate 'P0002' then null;
  end;

  begin
    perform public.defer_pipeline_event_attempt_capacity(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_snapshot, true, 0
    );
    raise exception 'm33_dispatched_transition_was_accepted';
  exception when sqlstate '22023' then null;
  end;

  v_claimed := public.claim_pipeline_event_attempt_capacity_resume(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_owner_id
  );
  if v_claimed is distinct from true then raise exception 'm33_first_claim_failed'; end if;
  if public.claim_pipeline_event_attempt_capacity_resume(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', gen_random_uuid()
  ) then raise exception 'm33_double_claim_was_accepted'; end if;

  v_next_snapshot := jsonb_set(v_snapshot, '{resumeGeneration}', '1'::jsonb);
  v_result := public.defer_pipeline_event_attempt_capacity(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_next_snapshot, false, 0, v_owner_id, 'editor'
  );
  if v_result ->> 'status' <> 'DEFERRED' then raise exception 'm33_resume_defer_failed'; end if;
  if not exists (
    select 1 from public.pipeline_event_attempts
     where id = v_attempt_id and attempt_number = 1 and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED'
       and capacity_resume_snapshot = v_next_snapshot and counts_toward_retry_limit = false
  ) then raise exception 'm33_same_attempt_resume_changed'; end if;

  v_claimed := public.claim_pipeline_event_attempt_capacity_resume(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_owner_id
  );
  if v_claimed is distinct from true then raise exception 'm33_release_fixture_claim_failed'; end if;
  begin
    perform public.defer_pipeline_event_attempt_capacity(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_snapshot, false, 0, v_owner_id, 'editor'
    );
    raise exception 'm33_stale_generation_was_accepted';
  exception when sqlstate '22023' then null;
  end;
  v_released := public.release_pipeline_event_attempt_capacity_resume(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_owner_id
  );
  if v_released is distinct from true then raise exception 'm33_release_failed'; end if;
  if public.release_pipeline_event_attempt_capacity_resume(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_owner_id
  ) then raise exception 'm33_wrong_owner_release_was_accepted'; end if;

  v_wrong_snapshot := jsonb_set(v_next_snapshot, '{attemptId}', to_jsonb(v_wrong_attempt_id::text));
  begin
    perform public.defer_pipeline_event_attempt_capacity(
      v_wrong_attempt_id, v_event_key, v_pipeline_run_id, 'editor', v_wrong_snapshot, false, 0
    );
    raise exception 'm33_wrong_attempt_was_accepted';
  exception when sqlstate 'P0002' then null;
  end;

  update public.pipeline_event_attempts
     set completed_at = clock_timestamp(), final_state = 'ABORTED', stop_reason = 'SYNTHETIC_TERMINAL_FIXTURE'
   where id = v_attempt_id;
  if public.claim_pipeline_event_attempt_capacity_resume(
    v_attempt_id, v_event_key, v_pipeline_run_id, 'editor', gen_random_uuid()
  ) then raise exception 'm33_terminal_reopen_was_accepted'; end if;
  raise exception using errcode = 'P0001', message = 'M33_FIXTURE_FORCE_ROLLBACK';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'M33_FIXTURE_FORCE_ROLLBACK' then raise; end if;
  end;
  select count(*) into v_residual_rows
    from public.pipeline_event_attempts
   where event_key = v_event_key;
  if v_residual_rows <> 0 then raise exception 'm33_fixture_residual_rows_not_zero'; end if;
  raise notice 'M33_FIXTURE_PASS synthetic_fixture_residual_rows=%', v_residual_rows;
end;
$fixture$;
