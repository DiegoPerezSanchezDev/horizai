do $fixture$
declare
  v_event_key constant text := '__synthetic_m35_verifier_capacity_fixture__';
  v_pipeline_run_id uuid := gen_random_uuid();
  v_attempt_id uuid := gen_random_uuid();
  v_wrong_attempt_id uuid := gen_random_uuid();
  v_source_id uuid := gen_random_uuid();
  v_raw_item_id uuid := gen_random_uuid();
  v_candidate_id text := gen_random_uuid()::text || ':synthetic-item';
  v_owner_id uuid := gen_random_uuid();
  v_started_at timestamptz := clock_timestamp();
  v_snapshot jsonb;
  v_changed jsonb;
  v_result jsonb;
  v_claimed boolean;
  v_released boolean;
  v_residual_rows bigint;
begin
  begin
    if exists (select 1 from public.pipeline_event_attempts where event_key = v_event_key) then
      raise exception 'm35_fixture_namespace_not_empty';
    end if;

    insert into public.pipeline_event_attempts (
      id, event_key, pipeline_run_id, attempt_number, started_at, purpose
    ) values (v_attempt_id, v_event_key, v_pipeline_run_id, 1, v_started_at, 'NORMAL');

    v_snapshot := jsonb_build_object(
      'schemaVersion', 1,
      'kind', 'SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME',
      'attemptId', v_attempt_id,
      'pipelineRunId', v_pipeline_run_id,
      'eventKey', v_event_key,
      'resumeStage', 'verifier',
      'attemptStartedAt', to_char(date_trunc('milliseconds', v_started_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'event', jsonb_build_object(
        'schemaVersion', 1, 'eventKey', v_event_key, 'canonicalTitle', 'Synthetic verifier resume event',
        'sourceItems', jsonb_build_array(jsonb_build_object(
          'candidateId', v_candidate_id, 'sourceId', v_source_id, 'sourceName', 'Synthetic source',
          'url', 'https://example.invalid/m35-synthetic', 'title', 'Synthetic item', 'publishedAt', null
        ))
      ),
      'items', jsonb_build_array(jsonb_build_object(
        'candidateId', v_candidate_id, 'canonicalUrl', 'https://example.invalid/m35-synthetic',
        'metadata', jsonb_build_object('sourceId', v_source_id)
      )),
      'sources', jsonb_build_array(jsonb_build_object(
        'sourceId', v_source_id, 'sourceItemId', v_candidate_id, 'rawItemId', v_raw_item_id,
        'sourceName', 'Synthetic source', 'sourceUrl', 'https://example.invalid/m35-synthetic'
      )),
      'checkpoints', '{}'::jsonb,
      'checkpointSha256', '{}'::jsonb,
      'providerAccounting', '{}'::jsonb,
      'nextStageDispatchCount', 0,
      'nextStageCheckpointPresent', false,
      'resumeGeneration', 0
    );

    perform set_config('request.jwt.claim.role', 'service_role', true);

    begin
      perform public.defer_pipeline_event_attempt_capacity_m35(
        v_attempt_id, v_event_key, v_pipeline_run_id, 'publisher', v_snapshot, false, 0
      );
      raise exception 'm35_invalid_stage_accepted';
    exception when sqlstate '22023' then null;
    end;

    v_changed := jsonb_set(v_snapshot, '{event,eventKey}', to_jsonb(v_event_key || '-wrong'));
    begin
      perform public.defer_pipeline_event_attempt_capacity_m35(
        v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_changed, false, 0
      );
      raise exception 'm35_wrong_event_lineage_accepted';
    exception when sqlstate '22023' then null;
    end;

    v_changed := jsonb_set(v_snapshot, '{resumeGeneration}', '1'::jsonb);
    begin
      perform public.defer_pipeline_event_attempt_capacity_m35(
        v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_changed, false, 0
      );
      raise exception 'm35_initial_nonzero_generation_accepted';
    exception when sqlstate '22023' then null;
    end;

    v_changed := jsonb_set(v_snapshot, '{attemptId}', to_jsonb(v_wrong_attempt_id::text));
    begin
      perform public.defer_pipeline_event_attempt_capacity_m35(
        v_wrong_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_changed, false, 0
      );
      raise exception 'm35_cross_attempt_accepted';
    exception when sqlstate 'P0002' then null;
    end;

    v_changed := jsonb_set(v_snapshot, '{sources,0,rawItemId}', 'null'::jsonb);
    begin
      perform public.defer_pipeline_event_attempt_capacity_m35(
        v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_changed, false, 0
      );
      raise exception 'm35_incomplete_lineage_accepted';
    exception when sqlstate '22023' then null;
    end;

    v_result := public.defer_pipeline_event_attempt_capacity_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_snapshot, false, 0
    );
    if v_result ->> 'status' <> 'DEFERRED' then raise exception 'm35_valid_verifier_defer_failed'; end if;
    if not exists (
      select 1 from public.pipeline_event_attempts
       where id = v_attempt_id and event_key = v_event_key and pipeline_run_id = v_pipeline_run_id
         and attempt_number = 1 and started_at = v_started_at and completed_at is null and final_state is null
         and stop_stage = 'verifier' and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED'
         and retry_class = 'NONE' and counts_toward_retry_limit = false and next_eligible_at is null
         and capacity_resume_snapshot = v_snapshot
    ) then raise exception 'm35_verifier_defer_state_invalid'; end if;

    v_claimed := public.claim_pipeline_event_attempt_capacity_resume_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_owner_id
    );
    if v_claimed is distinct from true then raise exception 'm35_first_verifier_claim_failed'; end if;
    if public.claim_pipeline_event_attempt_capacity_resume_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', gen_random_uuid()
    ) then raise exception 'm35_second_verifier_claim_accepted'; end if;

    v_changed := jsonb_set(v_snapshot, '{resumeGeneration}', '1'::jsonb);
    v_result := public.defer_pipeline_event_attempt_capacity_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_changed, false, 0, v_owner_id, 'verifier'
    );
    if v_result ->> 'status' <> 'DEFERRED' then raise exception 'm35_same_attempt_verifier_resume_defer_failed'; end if;
    if not exists (
      select 1 from public.pipeline_event_attempts
       where id = v_attempt_id and attempt_number = 1 and stop_stage = 'verifier'
         and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED' and counts_toward_retry_limit = false
         and capacity_resume_snapshot = v_changed
    ) then raise exception 'm35_attempt_identity_changed'; end if;

    v_claimed := public.claim_pipeline_event_attempt_capacity_resume_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_owner_id
    );
    if v_claimed is distinct from true then raise exception 'm35_second_cycle_claim_failed'; end if;

    v_changed := jsonb_set(v_snapshot, '{resumeGeneration}', '2'::jsonb);
    v_result := public.defer_pipeline_event_attempt_capacity_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_changed, false, 0, v_owner_id, 'verifier'
    );
    if v_result ->> 'status' <> 'DEFERRED' then raise exception 'm35_second_cycle_defer_failed'; end if;
    if not exists (
      select 1 from public.pipeline_event_attempts
       where id = v_attempt_id and attempt_number = 1 and stop_stage = 'verifier'
         and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED'
         and capacity_resume_snapshot ->> 'resumeGeneration' = '2'
    ) then raise exception 'm35_second_cycle_state_invalid'; end if;
    v_claimed := public.claim_pipeline_event_attempt_capacity_resume_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_owner_id
    );
    if v_claimed is distinct from true then raise exception 'm35_third_cycle_claim_failed'; end if;

    v_changed := jsonb_set(v_snapshot, '{resumeGeneration}', '3'::jsonb);
    v_result := public.defer_pipeline_event_attempt_capacity_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_changed, false, 0, v_owner_id, 'verifier'
    );
    if v_result ->> 'status' <> 'DEFERRED' then raise exception 'm35_third_cycle_defer_failed'; end if;
    if not exists (
      select 1 from public.pipeline_event_attempts
       where id = v_attempt_id and attempt_number = 1 and stop_stage = 'verifier'
         and stop_reason = 'PROVIDER_CAPACITY_EXHAUSTED'
         and capacity_resume_snapshot ->> 'resumeGeneration' = '3'
    ) then raise exception 'm35_third_cycle_state_invalid'; end if;
    v_claimed := public.claim_pipeline_event_attempt_capacity_resume_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', v_owner_id
    );
    if v_claimed is distinct from true then raise exception 'm35_third_cycle_claim_failed'; end if;
    update public.pipeline_event_attempts
       set completed_at = clock_timestamp(), final_state = 'ABORTED', stop_reason = 'SYNTHETIC_TERMINAL_FIXTURE'
     where id = v_attempt_id;
    if public.claim_pipeline_event_attempt_capacity_resume_m35(
      v_attempt_id, v_event_key, v_pipeline_run_id, 'verifier', gen_random_uuid()
    ) then raise exception 'm35_terminal_attempt_reopened'; end if;

    raise exception using errcode = 'P0001', message = 'M35_FIXTURE_FORCE_ROLLBACK';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'M35_FIXTURE_FORCE_ROLLBACK' then raise; end if;
  end;

  select count(*) into v_residual_rows
    from public.pipeline_event_attempts where event_key = v_event_key;
  if v_residual_rows <> 0 then raise exception 'm35_fixture_residual_rows_not_zero'; end if;
  raise notice 'M35_FIXTURE_PASS synthetic_attempt_residual_rows=%', v_residual_rows;
end;
$fixture$;
