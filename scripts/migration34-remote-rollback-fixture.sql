do $fixture$
declare
  v_namespace text := '__synthetic_m34_' || gen_random_uuid()::text;
  v_case record;
  v_event_key text;
  v_attempt_id uuid;
  v_proof_attempt_id uuid;
  v_pipeline_run_id uuid;
  v_proof_run_id uuid;
  v_draft_id text;
  v_draft_sha text := repeat('a', 64);
  v_lineage_sha text := repeat('b', 64);
  v_payload_sha text := repeat('c', 64);
  v_manifest jsonb;
  v_stats jsonb;
  v_config jsonb;
  v_rejected boolean;
  v_duplicate_blocked boolean := false;
  v_attempt_residual bigint;
  v_review_residual bigint;
  v_agent_run_residual bigint;
begin
  if exists (select 1 from public.pipeline_event_attempts where event_key like v_namespace || '%')
     or exists (select 1 from public.pipeline_human_reviews where event_key like v_namespace || '%')
     or exists (select 1 from public.agent_runs where config->>'eventKey' like v_namespace || '%') then
    raise exception 'm34_fixture_namespace_not_empty';
  end if;

  begin
    for v_case in
      select * from (values
        ('same_attempt_pass', true, true, true, true, 'MATCH', 'MATCH'),
        ('cross_attempt', true, true, true, true, 'OTHER_ATTEMPT', 'MATCH'),
        ('missing_critic', false, true, true, true, 'MATCH', 'MATCH'),
        ('missing_pass', true, false, true, true, 'MATCH', 'MATCH'),
        ('critic_reject', true, true, true, false, 'MATCH', 'MATCH'),
        ('malformed_proof', true, true, false, true, 'MATCH', 'MATCH'),
        ('stale_lineage', true, true, true, true, 'MATCH', 'OTHER_RUN')
      ) as fixtures(case_name, insert_critic, final_valid, zod_valid, pass_decision, attempt_link, run_link)
    loop
      v_event_key := v_namespace || ':' || v_case.case_name;
      v_attempt_id := gen_random_uuid();
      v_pipeline_run_id := gen_random_uuid();
      v_draft_id := v_namespace || ':' || v_case.case_name;
      v_proof_attempt_id := case when v_case.attempt_link = 'OTHER_ATTEMPT' then gen_random_uuid() else v_attempt_id end;
      v_proof_run_id := case when v_case.run_link = 'OTHER_RUN' then gen_random_uuid() else v_pipeline_run_id end;

      insert into public.pipeline_event_attempts (id, event_key, pipeline_run_id, attempt_number, started_at)
      values (v_attempt_id, v_event_key, v_pipeline_run_id, 1, clock_timestamp());

      if v_case.insert_critic then
        v_stats := jsonb_build_object('telemetry', jsonb_build_object(
          'zodValid', v_case.zod_valid,
          'finalCriticResultValid', v_case.final_valid,
          'deterministicPrechecksPassed', true,
          'finalDecision', case when v_case.pass_decision then 'pass' else 'reject' end
        ));
        v_config := jsonb_build_object(
          'agentName', 'critic', 'eventKey', v_event_key,
          'pipelineRunId', v_proof_run_id::text, 'attemptId', v_proof_attempt_id::text
        );
        insert into public.agent_runs (run_type, started_at, finished_at, status, dry_run, stats, config)
        values ('other', clock_timestamp(), clock_timestamp(), 'succeeded', true, v_stats, v_config);
      end if;

      v_manifest := jsonb_build_object(
        'schemaVersion', '1', 'packageSha256', repeat('d', 64),
        'eventKey', v_event_key, 'attemptId', v_attempt_id::text,
        'pipelineRunId', v_pipeline_run_id::text, 'draftId', v_draft_id,
        'draftSha256', v_draft_sha, 'sourceLineageSha256', v_lineage_sha,
        'publicationPayloadSha256', v_payload_sha,
        'checkpoints', jsonb_build_object(
          'verifier', jsonb_build_object('identity', v_namespace || ':verifier', 'sha256', repeat('e', 64)),
          'translator', jsonb_build_object('identity', v_namespace || ':translator', 'sha256', repeat('e', 64)),
          'editor', jsonb_build_object('identity', v_namespace || ':editor', 'sha256', repeat('e', 64)),
          'classifier', jsonb_build_object('identity', v_namespace || ':classifier', 'sha256', repeat('e', 64)),
          'ranker', jsonb_build_object('identity', v_namespace || ':ranker', 'sha256', repeat('e', 64)),
          'critic', jsonb_build_object(
            'identity', concat_ws(':', v_pipeline_run_id::text, v_attempt_id::text, 'critic', v_event_key),
            'sha256', repeat('f', 64)
          )
        )
      );

      if v_case.case_name = 'same_attempt_pass' then
        insert into public.pipeline_human_reviews (
          event_key, attempt_id, pipeline_run_id, draft_id, draft_sha256,
          source_lineage, source_lineage_sha256, publication_payload_sha256,
          review_manifest, critic_pass, provider_usage_settled
        ) values (
          v_event_key, v_attempt_id, v_pipeline_run_id, v_draft_id, v_draft_sha,
          '[{"synthetic":true}]'::jsonb, v_lineage_sha, v_payload_sha,
          v_manifest, true, true
        );
        if not exists (select 1 from public.pipeline_human_reviews where attempt_id = v_attempt_id and status = 'WAITING_FOR_HUMAN_REVIEW') then
          raise exception 'm34_same_attempt_pass_not_accepted';
        end if;
        begin
          insert into public.pipeline_human_reviews (
            event_key, attempt_id, pipeline_run_id, draft_id, draft_sha256,
            source_lineage, source_lineage_sha256, publication_payload_sha256,
            review_manifest, critic_pass, provider_usage_settled
          ) values (
            v_event_key, v_attempt_id, v_pipeline_run_id, v_draft_id, v_draft_sha,
            '[{"synthetic":true}]'::jsonb, v_lineage_sha, v_payload_sha,
            v_manifest, true, true
          );
        exception when unique_violation then
          v_duplicate_blocked := true;
        end;
        if not v_duplicate_blocked then raise exception 'm34_duplicate_review_was_accepted'; end if;
      else
        v_rejected := false;
        begin
          insert into public.pipeline_human_reviews (
            event_key, attempt_id, pipeline_run_id, draft_id, draft_sha256,
            source_lineage, source_lineage_sha256, publication_payload_sha256,
            review_manifest, critic_pass, provider_usage_settled
          ) values (
            v_event_key, v_attempt_id, v_pipeline_run_id, v_draft_id, v_draft_sha,
            '[{"synthetic":true}]'::jsonb, v_lineage_sha, v_payload_sha,
            v_manifest, true, true
          );
          raise exception using errcode = 'XX000', message = 'm34_expected_proof_rejection_not_raised';
        exception when sqlstate 'P0001' then
          if sqlerrm <> 'human_review_critic_pass_not_proven' then raise; end if;
          v_rejected := true;
        end;
        if not v_rejected then raise exception 'm34_invalid_critic_proof_was_accepted:%', v_case.case_name; end if;
      end if;
    end loop;

    if not v_duplicate_blocked then raise exception 'm34_duplicate_review_not_tested'; end if;
    raise exception using errcode = 'P0001', message = 'M34_FIXTURE_FORCE_ROLLBACK';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'M34_FIXTURE_FORCE_ROLLBACK' then raise; end if;
  end;

  select count(*) into v_attempt_residual from public.pipeline_event_attempts where event_key like v_namespace || '%';
  select count(*) into v_review_residual from public.pipeline_human_reviews where event_key like v_namespace || '%';
  select count(*) into v_agent_run_residual from public.agent_runs where config->>'eventKey' like v_namespace || '%';
  if v_attempt_residual <> 0 or v_review_residual <> 0 or v_agent_run_residual <> 0 then
    raise exception 'm34_fixture_residual_rows_not_zero';
  end if;
  raise notice 'M34_FIXTURE_PASS synthetic_attempts=% synthetic_reviews=% synthetic_agent_runs=% synthetic_articles=0 synthetic_events=0 synthetic_scheduler_runs=0', v_attempt_residual, v_review_residual, v_agent_run_residual;
end;
$fixture$;
