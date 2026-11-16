do $fixture$
declare
  v_review_id uuid := gen_random_uuid();
  v_event_key text := '__m39_bind_fixture__' || gen_random_uuid()::text;
  v_attempt_id uuid := gen_random_uuid();
  v_pipeline_run_id uuid := gen_random_uuid();
  v_draft_id text := 'm39-bind-fixture';
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
  v_rejection record;
  v_try_original_sha text;
  v_try_corrected_sha text;
  v_try_lineage jsonb;
  v_state text;
  v_message text;
  v_rejections integer := 0;
  v_revision_count integer;
  v_duplicate_blocked boolean := false;
  v_immutable_blocked boolean := false;
  v_stale_approval_blocked boolean := false;
  v_current_approval_supported boolean := false;
  v_review public.pipeline_human_reviews%rowtype;
  v_revision public.pipeline_human_review_revisions%rowtype;
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
    v_review_id, v_event_key, v_attempt_id, v_pipeline_run_id, v_draft_id, v_original_sha,
    v_source_lineage, v_lineage_sha, v_payload_sha, v_manifest, true, true
  );

  for v_rejection in
    select * from (values
      ('original_hash'), ('corrected_hash'), ('source_lineage')
    ) as cases(case_name)
  loop
    v_try_original_sha := v_original_sha;
    v_try_corrected_sha := v_corrected_sha;
    v_try_lineage := v_source_lineage;
    if v_rejection.case_name = 'original_hash' then v_try_original_sha := repeat('0', 64); end if;
    if v_rejection.case_name = 'corrected_hash' then v_try_corrected_sha := repeat('0', 64); end if;
    if v_rejection.case_name = 'source_lineage' then v_try_lineage := jsonb_build_array(jsonb_build_object('synthetic', false)); end if;
    begin
      v_result := public.bind_pipeline_human_review_revision(
        v_review_id, v_try_original_sha, v_original_draft, v_original_payload,
        v_corrected_draft, v_corrected_payload, v_try_lineage, v_try_corrected_sha, v_proof
      );
      raise exception using errcode = 'XX000', message = 'M39_EXPECTED_BIND_VALIDATION_REJECTION_NOT_RAISED';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'human_review_revision_binding_invalid' then raise; end if;
      v_rejections := v_rejections + 1;
    end;
    if exists (select 1 from public.pipeline_human_review_revisions where review_id = v_review_id) then
      raise exception 'M39_FAILED_BIND_CREATED_REVISION:%', v_rejection.case_name;
    end if;
  end loop;

  update public.pipeline_human_reviews set status = 'HOLD', reviewer_id = 'synthetic-fixture',
    reviewer_approved = false, reviewed_at = clock_timestamp(), facts_acceptable = true,
    attribution_acceptable = true, uncertainty_preserved = true, headline_acceptable = true,
    summary_acceptable = true, no_unsupported_material_claims = true, source_chain_acceptable = true
   where id = v_review_id;
  begin
    v_result := public.bind_pipeline_human_review_revision(
      v_review_id, v_original_sha, v_original_draft, v_original_payload,
      v_corrected_draft, v_corrected_payload, v_source_lineage, v_corrected_sha, v_proof
    );
    raise exception using errcode = 'XX000', message = 'M39_NON_WAITING_REVIEW_NOT_REJECTED';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'human_review_revision_not_attachable' then raise; end if;
  end;
  update public.pipeline_human_reviews set status = 'WAITING_FOR_HUMAN_REVIEW', reviewer_id = null,
    reviewer_approved = null, reviewed_at = null, facts_acceptable = null, attribution_acceptable = null,
    uncertainty_preserved = null, headline_acceptable = null, summary_acceptable = null,
    no_unsupported_material_claims = null, source_chain_acceptable = null
   where id = v_review_id;

  update public.pipeline_human_reviews set status = 'PUBLISHING', reviewer_id = 'synthetic-fixture',
    reviewer_approved = true, reviewed_at = clock_timestamp(), facts_acceptable = true,
    attribution_acceptable = true, uncertainty_preserved = true, headline_acceptable = true,
    summary_acceptable = true, no_unsupported_material_claims = true, source_chain_acceptable = true,
    consumed_at = clock_timestamp()
   where id = v_review_id;
  begin
    v_result := public.bind_pipeline_human_review_revision(
      v_review_id, v_original_sha, v_original_draft, v_original_payload,
      v_corrected_draft, v_corrected_payload, v_source_lineage, v_corrected_sha, v_proof
    );
    raise exception using errcode = 'XX000', message = 'M39_CONSUMED_REVIEW_NOT_REJECTED';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'human_review_revision_not_attachable' then raise; end if;
  end;
  update public.pipeline_human_reviews set status = 'WAITING_FOR_HUMAN_REVIEW', reviewer_id = null,
    reviewer_approved = null, reviewed_at = null, facts_acceptable = null, attribution_acceptable = null,
    uncertainty_preserved = null, headline_acceptable = null, summary_acceptable = null,
    no_unsupported_material_claims = null, source_chain_acceptable = null, consumed_at = null
   where id = v_review_id;

  v_result := public.bind_pipeline_human_review_revision(
    v_review_id, v_original_sha, v_original_draft, v_original_payload,
    v_corrected_draft, v_corrected_payload, v_source_lineage, v_corrected_sha, v_proof
  );
  if v_result->>'approvalTargetKind' is distinct from 'HUMAN_REVISION'
     or v_result->>'revisionSha256' is distinct from v_corrected_sha
     or v_result->>'reused' is distinct from 'false' then
    raise exception 'M39_VALID_BIND_RESULT_INVALID';
  end if;
  select count(*) into v_revision_count from public.pipeline_human_review_revisions where review_id = v_review_id;
  if v_revision_count <> 1 then raise exception 'M39_VALID_BIND_REVISION_COUNT_INVALID'; end if;
  select * into v_review from public.pipeline_human_reviews where id = v_review_id;
  select * into v_revision from public.pipeline_human_review_revisions where review_id = v_review_id;
  if v_review.status <> 'WAITING_FOR_HUMAN_REVIEW' or v_review.consumed_at is not null
     or v_review.approval_target_kind <> 'HUMAN_REVISION'
     or v_review.approval_target_revision_id <> v_revision.id
     or v_review.approval_target_revision_sha256 <> v_corrected_sha
     or v_review.draft_sha256 <> v_original_sha or v_review.source_lineage_sha256 <> v_lineage_sha
     or v_revision.original_draft <> v_original_draft
     or v_revision.original_draft_sha256 <> v_original_sha
     or v_revision.corrected_draft <> v_corrected_draft
     or v_revision.corrected_revision_sha256 <> v_corrected_sha
     or v_revision.corrected_publication_payload <> v_corrected_payload
     or v_revision.automated_critic_draft_sha256 <> v_original_sha
     or v_revision.human_revision_proof->>'status' <> 'PASS' then
    raise exception 'M39_VALID_BIND_STORED_STATE_INVALID';
  end if;

  begin
    update public.pipeline_human_review_revisions set corrected_draft = '{}'::jsonb where review_id = v_review_id;
    raise exception using errcode = 'XX000', message = 'M39_IMMUTABLE_REVISION_UPDATE_NOT_REJECTED';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'human_review_revision_immutable' then raise; end if;
    v_immutable_blocked := true;
  end;
  begin
    insert into public.pipeline_human_review_revisions (
      review_id, attempt_id, pipeline_run_id, original_draft, original_publication_payload,
      corrected_draft, corrected_publication_payload, original_draft_sha256, corrected_revision_sha256,
      source_lineage_sha256, automated_critic_draft_sha256, human_revision_proof
    ) select review_id, attempt_id, pipeline_run_id, original_draft, original_publication_payload,
      corrected_draft, corrected_publication_payload, original_draft_sha256, corrected_revision_sha256,
      source_lineage_sha256, automated_critic_draft_sha256, human_revision_proof
      from public.pipeline_human_review_revisions where review_id = v_review_id;
    raise exception using errcode = 'XX000', message = 'M39_DUPLICATE_REVISION_NOT_REJECTED';
  exception when unique_violation then
    v_duplicate_blocked := true;
  end;

  begin
    v_result := public.decide_pipeline_human_review_revision(
      v_review_id, v_original_sha, 'synthetic-fixture', true, true, true, true, true, true, true
    );
    raise exception using errcode = 'XX000', message = 'M39_STALE_APPROVAL_NOT_REJECTED';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'human_review_revision_approval_missing_or_stale' then raise; end if;
    v_stale_approval_blocked := true;
  end;
  begin
    v_result := public.decide_pipeline_human_review_revision(
      v_review_id, v_corrected_sha, 'synthetic-fixture', true, true, true, true, true, true, true
    );
    if v_result->>'status' is distinct from 'APPROVED'
       or v_result->>'approvedRevisionSha256' is distinct from v_corrected_sha then
      raise exception 'M39_CURRENT_REVISION_APPROVAL_DRY_RUN_INVALID';
    end if;
    raise exception using errcode = 'P0001', message = 'M39_APPROVAL_DRY_RUN_FORCE_ROLLBACK';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'M39_APPROVAL_DRY_RUN_FORCE_ROLLBACK' then raise; end if;
    v_current_approval_supported := true;
  end;
  select * into v_review from public.pipeline_human_reviews where id = v_review_id;
  if v_review.status <> 'WAITING_FOR_HUMAN_REVIEW' or v_review.consumed_at is not null
     or v_review.approved_revision_sha256 is not null
     or v_review.approval_target_revision_sha256 <> v_corrected_sha then
    raise exception 'M39_APPROVAL_DRY_RUN_PERSISTED';
  end if;
  if v_rejections <> 3 or not v_immutable_blocked or not v_duplicate_blocked
     or not v_stale_approval_blocked or not v_current_approval_supported then
    raise exception 'M39_FIXTURE_EXPECTED_TESTS_MISSING';
  end if;
  raise exception using errcode = 'P0001', message =
    'M39_FIXTURE_PASS: exact corrected bind; 3 validation rejections; HOLD/consumed blocked; 1 immutable revision; duplicate blocked; stale approval blocked; corrected approval supported in forced rollback; no committed decision';
end;
$fixture$;
