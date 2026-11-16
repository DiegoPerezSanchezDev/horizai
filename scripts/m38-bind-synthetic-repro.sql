do $fixture$
declare
  v_id uuid := gen_random_uuid();
  v_event_key text := '__m38_bind_fixture__' || gen_random_uuid()::text;
  v_attempt_id uuid := gen_random_uuid();
  v_pipeline_run_id uuid := gen_random_uuid();
  v_draft_id text := 'm38-bind-fixture';
  v_source_lineage jsonb := jsonb_build_array(jsonb_build_object('synthetic', true));
  v_original_draft jsonb;
  v_corrected_draft jsonb;
  v_original_payload jsonb;
  v_corrected_payload jsonb;
  v_original_sha text;
  v_corrected_sha text;
  v_lineage_sha text;
  v_payload_sha text;
  v_proof jsonb;
  v_manifest jsonb;
  v_result jsonb;
  v_outcome text;
  v_state text;
  v_message text;
  v_context text;
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_original_draft := jsonb_build_object(
    'headlineEs', 'Fixture original headline', 'dekEs', 'Fixture original dek',
    'summaryEs', 'Fixture original summary', 'whyItMattersEs', 'Fixture why',
    'bodyEs', 'Fixture original body', 'keyPoints', jsonb_build_array('Fixture point')
  );
  v_corrected_draft := jsonb_build_object(
    'headlineEs', 'Fixture corrected headline', 'dekEs', 'Fixture corrected dek',
    'summaryEs', 'Fixture corrected summary', 'whyItMattersEs', 'Fixture why',
    'bodyEs', 'Fixture corrected body', 'keyPoints', jsonb_build_array('Fixture point')
  );
  v_original_payload := jsonb_build_object(
    'eventKey', v_event_key, 'critic', jsonb_build_object('decision', 'pass'),
    'article', v_original_draft || jsonb_build_object('slug', 'fixture-slug')
  );
  v_corrected_payload := jsonb_build_object(
    'eventKey', v_event_key, 'critic', jsonb_build_object('decision', 'pass'),
    'article', v_corrected_draft || jsonb_build_object('slug', 'fixture-slug')
  );
  v_original_sha := encode(extensions.digest(convert_to(public.pipeline_canonical_jsonb_text(v_original_draft), 'UTF8'), 'sha256'), 'hex');
  v_corrected_sha := encode(extensions.digest(convert_to(public.pipeline_canonical_jsonb_text(v_corrected_draft), 'UTF8'), 'sha256'), 'hex');
  v_lineage_sha := encode(extensions.digest(convert_to(v_source_lineage::text, 'UTF8'), 'sha256'), 'hex');
  v_payload_sha := encode(extensions.digest(convert_to(v_original_payload::text, 'UTF8'), 'sha256'), 'hex');
  v_proof := jsonb_build_object(
    'schemaVersion', '1', 'status', 'PASS', 'actorClass', 'HUMAN_OPERATOR',
    'automatedCriticScope', 'ORIGINAL_DRAFT_ONLY',
    'humanAttestation', 'FACTUAL_ATTRIBUTION_ORIGINALITY_SOURCE_LINEAGE_PASS',
    'correctedRevisionSha256', v_corrected_sha, 'originalDraftSha256', v_original_sha,
    'sourceLineageSha256', v_lineage_sha, 'auditSha256', repeat('f', 64),
    'auditedAt', '2026-10-21T00:00:00.000Z'
  );
  v_manifest := jsonb_build_object(
    'schemaVersion', '1', 'packageSha256', repeat('d', 64),
    'eventKey', v_event_key, 'attemptId', v_attempt_id::text,
    'pipelineRunId', v_pipeline_run_id::text, 'draftId', v_draft_id,
    'draftSha256', v_original_sha, 'sourceLineageSha256', v_lineage_sha,
    'publicationPayloadSha256', v_payload_sha,
    'checkpoints', jsonb_build_object(
      'verifier', jsonb_build_object('identity', 'fixture:verifier', 'sha256', repeat('a', 64)),
      'translator', jsonb_build_object('identity', 'fixture:translator', 'sha256', repeat('b', 64)),
      'editor', jsonb_build_object('identity', 'fixture:editor', 'sha256', repeat('c', 64)),
      'classifier', jsonb_build_object('identity', 'fixture:classifier', 'sha256', repeat('d', 64)),
      'ranker', jsonb_build_object('identity', 'fixture:ranker', 'sha256', repeat('e', 64)),
      'critic', jsonb_build_object('identity', concat_ws(':', v_pipeline_run_id::text, v_attempt_id::text, 'critic', v_event_key), 'sha256', repeat('f', 64))
    )
  );

  begin
    insert into public.pipeline_event_attempts (id, event_key, pipeline_run_id, attempt_number, started_at)
    values (v_attempt_id, v_event_key, v_pipeline_run_id, 1, clock_timestamp());
    insert into public.agent_runs (run_type, started_at, finished_at, status, dry_run, stats, config)
    values ('other', clock_timestamp(), clock_timestamp(), 'succeeded', true,
      jsonb_build_object('telemetry', jsonb_build_object(
        'zodValid', true, 'finalCriticResultValid', true,
        'deterministicPrechecksPassed', true, 'finalDecision', 'pass')),
      jsonb_build_object('agentName', 'critic', 'eventKey', v_event_key,
        'pipelineRunId', v_pipeline_run_id::text, 'attemptId', v_attempt_id::text));
    insert into public.pipeline_human_reviews (
      id, event_key, attempt_id, pipeline_run_id, draft_id, draft_sha256,
      source_lineage, source_lineage_sha256, publication_payload_sha256,
      review_manifest, critic_pass, provider_usage_settled
    ) values (
      v_id, v_event_key, v_attempt_id, v_pipeline_run_id, v_draft_id, v_original_sha,
      v_source_lineage, v_lineage_sha, v_payload_sha, v_manifest, true, true
    );
    v_result := public.bind_pipeline_human_review_revision(
      v_id, v_original_sha, v_original_draft, v_original_payload, v_corrected_draft,
      v_corrected_payload, v_source_lineage, v_corrected_sha, v_proof
    );
    if v_result->>'approvalTargetKind' is distinct from 'HUMAN_REVISION'
       or v_result->>'revisionSha256' is distinct from v_corrected_sha then
      raise exception using errcode = 'P0001', message = 'M38_FIXTURE_BIND_RETURN_MISMATCH';
    end if;
    v_outcome := 'SUCCESS';
    raise exception using errcode = 'P0001', message = 'M38_FIXTURE_FORCE_ROLLBACK';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text, v_context = pg_exception_context;
    if v_message = 'M38_FIXTURE_FORCE_ROLLBACK' then
      v_outcome := 'SUCCESS';
    else
      v_outcome := 'ERROR';
    end if;
  end;

  if v_outcome = 'ERROR' then
    raise exception using errcode = 'P0001',
      message = 'M38_SYNTHETIC_BIND_RESULT:' || v_state || ':' || v_message || ':CONTEXT=' || coalesce(v_context, ''),
      detail = coalesce(v_context, '');
  end if;
  raise exception using errcode = 'P0001', message = 'M38_SYNTHETIC_BIND_RESULT:SUCCESS:bind completed and rollback was forced';
end;
$fixture$;
