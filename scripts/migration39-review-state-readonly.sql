select jsonb_build_object(
  'review', (select jsonb_build_object(
    'id', id, 'status', status, 'consumed', consumed_at is not null,
    'approvalTargetKind', approval_target_kind, 'approvalTargetRevisionId', approval_target_revision_id,
    'approvalTargetRevisionSha256', approval_target_revision_sha256,
    'draftSha256', draft_sha256, 'sourceLineageSha256', source_lineage_sha256,
    'attemptId', attempt_id, 'pipelineRunId', pipeline_run_id, 'eventKey', event_key
  ) from public.pipeline_human_reviews where id = 'ebd8acc0-76a2-4977-81d9-60a7f6240084'::uuid),
  'revisionCount', (select count(*) from public.pipeline_human_review_revisions where review_id = 'ebd8acc0-76a2-4977-81d9-60a7f6240084'::uuid),
  'revision', (select jsonb_build_object(
    'id', id, 'revisionVersion', revision_version, 'originalDraftSha256', original_draft_sha256,
    'correctedRevisionSha256', corrected_revision_sha256, 'sourceLineageSha256', source_lineage_sha256,
    'automatedCriticDraftSha256', automated_critic_draft_sha256,
    'attemptId', attempt_id, 'pipelineRunId', pipeline_run_id
  ) from public.pipeline_human_review_revisions where review_id = 'ebd8acc0-76a2-4977-81d9-60a7f6240084'::uuid),
  'attempt', (select jsonb_build_object(
    'id', id, 'eventKey', event_key, 'pipelineRunId', pipeline_run_id,
    'completed', completed_at is not null, 'finalState', final_state, 'stopStage', stop_stage,
    'stopReason', stop_reason, 'retryClass', retry_class,
    'countsTowardRetryLimit', counts_toward_retry_limit, 'nextEligibleAt', next_eligible_at
  ) from public.pipeline_event_attempts where id = '4658d5c0-857c-4ed5-b97f-afb133b2bf22'::uuid),
  'criticM34Pass', exists (select 1 from public.agent_runs
    where config->>'agentName' = 'critic' and config->>'attemptId' = '4658d5c0-857c-4ed5-b97f-afb133b2bf22'
      and status = 'succeeded' and stats->'telemetry'->>'finalDecision' = 'pass'),
  'latestM39', exists (select 1 from supabase_migrations.schema_migrations where version = '20261021120000')
) as migration39_target_review_readonly;
