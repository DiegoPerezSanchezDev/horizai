-- 12C.2B.2f.1a: resume the existing Critic-only authorization after its local
-- manifest comparison rejected PostgreSQL JSONB object-key ordering.
-- Synthetic validation is limited to the exact 12c2b2f1a:<uuid> namespace.
begin;

-- Permit only this phase's isolated factual-remediation fixtures. Normal
-- attempt metadata and the incident's final-slot accounting stay unchanged.
alter table public.pipeline_event_attempts
  drop constraint pipeline_event_attempts_remediation_metadata_check,
  add constraint pipeline_event_attempts_remediation_metadata_check
    check (
      (purpose = 'NORMAL'
        and remediation_article_id is null
        and remediation_raw_item_id is null
        and remediation_prior_attempt_id is null
        and remediation_reason is null
        and authorized_by is null
        and authorization_reference is null
        and pilot_attempt_number is null
        and validation_namespace is null)
      or
      (purpose = 'FACTUAL_REMEDIATION'
        and remediation_article_id is not null
        and remediation_raw_item_id is not null
        and remediation_prior_attempt_id is not null
        and length(trim(coalesce(remediation_reason, ''))) between 20 and 1000
        and length(trim(coalesce(authorized_by, ''))) between 2 and 120
        and length(trim(coalesce(authorization_reference, ''))) between 5 and 500
        and (
          (validation_namespace is null
            and event_key = 'event-30f226d1b8ba5c9eb8af2b65c46db512'
            and pilot_attempt_number = 5)
          or
          (validation_namespace ~ '^12c2b1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            and pilot_attempt_number is null)
          or
          (validation_namespace ~ '^12c2b2d1?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            and pilot_attempt_number is null)
          or
          (validation_namespace ~ '^12c2b2f1a:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            and pilot_attempt_number is null)
        ))
    );

create or replace function public.resume_incident_factual_remediation_continuation(
  p_attempt_id uuid,
  p_pipeline_run_id uuid,
  p_resume_execution_id uuid,
  p_checkpoint_manifest jsonb
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_real_attempt_id constant uuid := 'a82482be-58d8-4fc6-ac16-946d0906257b';
  v_real_event_key constant text := 'event-30f226d1b8ba5c9eb8af2b65c46db512';
  v_real_original_run_id constant uuid := 'db368f10-d9c1-4897-b752-b3d2cb156e09';
  v_real_continuation_run_id constant uuid := 'f140d01b-b7f1-4f05-b8f7-9ad0081e7105';
  v_real_prior_attempt_id constant uuid := '4017edf4-86be-49f1-a464-e766ad371284';
  v_real_event_id constant uuid := '5138e509-f4c3-4020-9d13-6a6efac99a39';
  v_real_article_id constant uuid := '756b0ee0-b5e6-4153-846f-278a12c9afe3';
  v_real_raw_item_id constant uuid := 'd3834944-72f6-4f59-9aca-3f66ae92dc33';
  v_real_source_id constant uuid := 'e8dd0363-f51e-4381-9fb2-c02ee81f4d41';
  v_real_article_slug constant text := 'openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad';
  v_real_raw_content_hash constant text := 'sha256:9f053bdb6d53e5d59baf254201811874992bf7cad444b38431b8f364bfe5caa';
  v_event_key text;
  v_original_run_id uuid;
  v_prior_attempt_id uuid;
  v_event_id uuid;
  v_article_id uuid;
  v_raw_item_id uuid;
  v_source_id uuid;
  v_article_slug text;
  v_validation_namespace text;
  v_is_synthetic boolean := false;
  v_expected_synthetic_fixture text;
  v_attempt public.pipeline_event_attempts%rowtype;
  v_continuation jsonb;
  v_previous_stop jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'factual_remediation_continuation_service_role_required';
  end if;
  if p_attempt_id is null or p_pipeline_run_id is null or p_resume_execution_id is null
     or p_resume_execution_id in (
       p_pipeline_run_id, v_real_original_run_id, v_real_attempt_id,
       '4017edf4-86be-49f1-a464-e766ad371284'::uuid,
       '5138e509-f4c3-4020-9d13-6a6efac99a39'::uuid,
       '756b0ee0-b5e6-4153-846f-278a12c9afe3'::uuid,
       'd3834944-72f6-4f59-9aca-3f66ae92dc33'::uuid,
       'e8dd0363-f51e-4381-9fb2-c02ee81f4d41'::uuid
     )
     or p_checkpoint_manifest is null then
    raise exception using errcode = '22023', message = 'factual_remediation_continuation_resume_identity_invalid';
  end if;

  select event_key into v_event_key from public.pipeline_event_attempts where id = p_attempt_id;
  if v_event_key is null then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TERMINAL_ATTEMPT_CHANGED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_event_key, 0));
  select * into v_attempt
    from public.pipeline_event_attempts
   where id = p_attempt_id and event_key = v_event_key
   for update;
  if v_attempt.id is null then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TERMINAL_ATTEMPT_CHANGED');
  end if;

  v_validation_namespace := v_attempt.validation_namespace;
  v_is_synthetic := coalesce(v_validation_namespace, '') ~ '^12c2b2f1a:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_attempt_id <> v_real_attempt_id and v_event_key <> v_real_event_key;
  v_expected_synthetic_fixture := v_is_synthetic::text;
  if v_is_synthetic then
    v_original_run_id := v_attempt.pipeline_run_id;
    v_prior_attempt_id := v_attempt.remediation_prior_attempt_id;
    v_article_id := v_attempt.remediation_article_id;
    v_raw_item_id := v_attempt.remediation_raw_item_id;
    select e.id into v_event_id from public.events as e where e.event_key = v_event_key;
    select a.slug into v_article_slug from public.articles as a where a.id = v_article_id;
    select es.source_id into v_source_id from public.event_sources as es
      where es.event_id = v_event_id and es.raw_item_id = v_raw_item_id;
  elsif p_attempt_id = v_real_attempt_id and v_event_key = v_real_event_key then
    v_original_run_id := v_real_original_run_id;
    v_prior_attempt_id := v_real_prior_attempt_id;
    v_event_id := v_real_event_id;
    v_article_id := v_real_article_id;
    v_raw_item_id := v_real_raw_item_id;
    v_source_id := v_real_source_id;
    v_article_slug := v_real_article_slug;
  else
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TERMINAL_ATTEMPT_NOT_ELIGIBLE');
  end if;

  if v_attempt.pipeline_run_id is distinct from v_original_run_id
     or v_attempt.attempt_number <> 2
     or v_attempt.purpose <> 'FACTUAL_REMEDIATION'
     or (v_is_synthetic and v_attempt.pilot_attempt_number is not null)
     or (not v_is_synthetic and v_attempt.pilot_attempt_number <> 5)
     or v_attempt.remediation_article_id is distinct from v_article_id
     or v_attempt.remediation_raw_item_id is distinct from v_raw_item_id
     or v_attempt.remediation_prior_attempt_id is distinct from v_prior_attempt_id
     or v_attempt.final_state <> 'TECHNICAL_FAILURE'
     or v_attempt.completed_at is null
     or v_attempt.stop_stage <> 'critic'
     or v_attempt.stop_reason <> 'cost_guard_violation'
     or v_attempt.retry_class <> 'NONE'
     or v_attempt.counts_toward_retry_limit
     or (not v_is_synthetic and (
       v_attempt.authorized_by is distinct from 'Diego'
       or v_attempt.authorization_reference is distinct from 'Codex user request 105932dd-1d8a-4f9d-ab0d-b7809a68604f phase 12C.2B.2'
       or v_attempt.remediation_reason is distinct from 'User explicitly authorized the final factual-remediation attempt using Groq only, at most six calls, zero retries, and no fallback.'
     )) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TERMINAL_ATTEMPT_CHANGED');
  end if;
  if (not v_is_synthetic and p_pipeline_run_id is distinct from v_real_continuation_run_id)
     or (v_is_synthetic and (p_attempt_id in (v_real_attempt_id, v_real_prior_attempt_id)
       or v_event_key = v_real_event_key or v_event_id = v_real_event_id
       or v_article_id = v_real_article_id or v_raw_item_id = v_real_raw_item_id
       or v_source_id = v_real_source_id or v_prior_attempt_id = v_real_prior_attempt_id
       or p_pipeline_run_id = v_real_continuation_run_id)) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CONTINUATION_IDENTITY_INVALID');
  end if;

  if not exists (
    select 1 from public.pipeline_event_attempts as prior
     where prior.id = v_prior_attempt_id and prior.event_key = v_event_key
       and prior.attempt_number = 1 and prior.purpose = 'NORMAL'
       and prior.final_state = 'READY_FOR_PUBLICATION' and prior.completed_at is not null
       and (v_is_synthetic or prior.pipeline_run_id = '63b81d9a-e46f-4434-9637-335d3f455e0b'::uuid)
  ) or (select count(*) from public.pipeline_event_attempts where event_key = v_event_key) <> 2
     or exists (select 1 from public.pipeline_event_attempts where event_key = v_event_key and (attempt_number > 2 or pilot_attempt_number = 6)) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'ATTEMPT_HISTORY_CHANGED');
  end if;

  v_continuation := v_attempt.continuation;
  if jsonb_typeof(v_continuation) is distinct from 'object'
     or v_continuation ->> 'kind' is distinct from 'FACTUAL_REMEDIATION_CONTINUATION'
     or v_continuation ->> 'attemptId' is distinct from v_attempt.id::text
     or v_continuation ->> 'pipelineRunId' is distinct from p_pipeline_run_id::text
     or v_continuation ->> 'resumeStage' is distinct from 'critic'
     or v_continuation ->> 'status' is distinct from 'STOPPED'
     or v_continuation ->> 'stopStage' is distinct from 'critic'
     or v_continuation ->> 'stopReason' is distinct from 'CONTINUATION_RUNNER_ABORTED'
     or not (v_continuation ? 'criticDecision')
     or jsonb_typeof(v_continuation -> 'criticDecision') is distinct from 'null'
     or v_continuation ->> 'providerRequestsUsed' is distinct from '0'
     or v_continuation ->> 'syntheticFixture' is distinct from v_expected_synthetic_fixture
     or (v_is_synthetic and v_continuation ->> 'validationNamespace' is distinct from v_validation_namespace)
     or (not v_is_synthetic and (
       v_continuation ->> 'authorizedBy' is distinct from 'Diego'
       or v_continuation ->> 'authorizationReference' is distinct from 'Codex user request 105932dd-1d8a-4f9d-ab0d-b7809a68604f phase 12C.2B.2'
       or v_continuation ->> 'reason' is distinct from 'User explicitly authorized the final factual-remediation attempt using Groq only, at most six calls, zero retries, and no fallback.'
       or v_continuation ->> 'authorizedAt' is distinct from '2026-10-02T20:58:56.149531+00:00'
       or v_continuation ->> 'completedAt' is distinct from '2026-10-02T20:58:56.472794+00:00'
     ))
     or (v_is_synthetic and (
       v_continuation ->> 'authorizedBy' is distinct from v_attempt.authorized_by
       or v_continuation ->> 'authorizationReference' is distinct from v_attempt.authorization_reference
       or length(trim(coalesce(v_continuation ->> 'reason', ''))) < 20
       or nullif(v_continuation ->> 'authorizedAt', '') is null
       or nullif(v_continuation ->> 'completedAt', '') is null
       or v_continuation ->> 'failureCode' is distinct from 'FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_MANIFEST_CHANGED'
     )) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'AUTHORIZED_STOPPED_STATE_NOT_RESUMABLE');
  end if;
  if v_continuation ? 'resumeGeneration' or v_continuation ? 'resumeExecutionId'
     or v_continuation ? 'resumeHistory' or v_continuation ? 'resumedAt'
     or exists (select 1 from public.pipeline_event_attempts where pipeline_run_id = p_resume_execution_id)
     or exists (select 1 from public.pipeline_event_attempts where continuation ->> 'resumeExecutionId' = p_resume_execution_id::text)
     or exists (select 1 from public.agent_runs where config ->> 'pipelineRunId' = p_resume_execution_id::text) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'AUTHORIZED_RESUME_ALREADY_USED_OR_EXECUTION_ID_EXISTS');
  end if;

  -- The database manifest contract is exactly six root keys and five stage
  -- hashes. JSONB equality ignores object key order and preserves array order.
  if jsonb_typeof(p_checkpoint_manifest) is distinct from 'object'
     or jsonb_typeof(p_checkpoint_manifest -> 'schemaVersion') is distinct from 'number'
     or p_checkpoint_manifest ->> 'schemaVersion' is distinct from '1'
     or p_checkpoint_manifest ->> 'eventKey' is distinct from v_event_key
     or p_checkpoint_manifest ->> 'sourceRunId' is distinct from v_original_run_id::text
     or p_checkpoint_manifest ->> 'resumeStage' is distinct from 'critic'
     or p_checkpoint_manifest ->> 'criticCheckpoint' is distinct from 'absent'
     or jsonb_typeof(p_checkpoint_manifest -> 'checkpoints') is distinct from 'object'
     or (select count(*) from jsonb_object_keys(p_checkpoint_manifest)) <> 6
     or (select count(*) from jsonb_object_keys(p_checkpoint_manifest -> 'checkpoints')) <> 5
     or jsonb_typeof(p_checkpoint_manifest #> '{checkpoints,verifier}') is distinct from 'string'
     or jsonb_typeof(p_checkpoint_manifest #> '{checkpoints,translator}') is distinct from 'string'
     or jsonb_typeof(p_checkpoint_manifest #> '{checkpoints,editor}') is distinct from 'string'
     or jsonb_typeof(p_checkpoint_manifest #> '{checkpoints,classifier}') is distinct from 'string'
     or jsonb_typeof(p_checkpoint_manifest #> '{checkpoints,ranker}') is distinct from 'string'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,verifier}', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,translator}', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,editor}', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,classifier}', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,ranker}', '') !~ '^[0-9a-f]{64}$'
     or p_checkpoint_manifest is distinct from (v_continuation -> 'checkpointManifest') then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CHECKPOINT_MANIFEST_CHANGED');
  end if;
  if not v_is_synthetic and (
       p_checkpoint_manifest #>> '{checkpoints,verifier}' is distinct from '668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378'
       or p_checkpoint_manifest #>> '{checkpoints,translator}' is distinct from '668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378'
       or p_checkpoint_manifest #>> '{checkpoints,editor}' is distinct from 'ac88461328385917a3c9ebd219815b06211b1d0ed64684eea1f0993c4e5cc218'
       or p_checkpoint_manifest #>> '{checkpoints,classifier}' is distinct from '947951b78f3aa39719943d8d916a70c23a796777b33557b8dcb5d67d3b4a345d'
       or p_checkpoint_manifest #>> '{checkpoints,ranker}' is distinct from '17d758b3883239ab7e3dc28141b8449c9b93df43827f56d77b4ef6fe506d5edf'
     ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CHECKPOINT_MANIFEST_CHANGED');
  end if;

  if exists (
    select 1 from public.agent_runs as ar
     where ar.config ->> 'pipelineRunId' in (p_pipeline_run_id::text, p_resume_execution_id::text)
        or (ar.config ->> 'eventKey' = v_event_key
          and ar.config ->> 'attemptId' = p_attempt_id::text
          and ar.config ->> 'agentName' = 'critic'
          and ar.config ->> 'agentVersion' = 'critic-v4'
          and (not v_is_synthetic or ar.config ->> 'validationNamespace' = v_validation_namespace))
  ) or exists (
    select 1 from public.agent_runs as ar
    join public.agent_logs as l on l.run_id = ar.id
     where ar.config ->> 'eventKey' = v_event_key
       and ar.config ->> 'attemptId' = p_attempt_id::text
       and (not v_is_synthetic or ar.config ->> 'validationNamespace' = v_validation_namespace)
       and (l.step = 'provider_request_reserved'
         or l.payload ->> 'providerRequestDispatched' = 'true'
         or l.payload #>> '{details,providerRequestDispatched}' = 'true'
         or l.payload #>> '{diagnostics,providerRequestDispatched}' = 'true')
  ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CONTINUATION_PROVIDER_ACTIVITY_EXISTS');
  end if;

  if v_is_synthetic then
    if not exists (
      select 1 from public.events as e
       where e.id = v_event_id and e.event_key = v_event_key
         and e.event_status = 'active' and e.review_status = 'approved'
         and e.classification_payload ->> 'validationNamespace' = v_validation_namespace
    ) or not exists (
      select 1 from public.articles as a
       where a.id = v_article_id and a.event_id = v_event_id
         and a.slug = v_article_slug and a.publication_status = 'archived'
         and a.metadata ->> 'validationNamespace' = v_validation_namespace
    ) or exists (
      select 1 from public.public_published_articles as p where p.slug = v_article_slug
    ) or (select count(*) from public.event_sources as es where es.event_id = v_event_id) <> 1
       or not exists (
         select 1 from public.event_sources as es
         join public.raw_items as r on r.id = es.raw_item_id and r.source_id = es.source_id
         join public.sources as s on s.id = es.source_id
          where es.event_id = v_event_id and es.raw_item_id = v_raw_item_id
            and es.source_id = v_source_id
            and s.metadata ->> 'validationNamespace' = v_validation_namespace
            and r.normalized_payload ->> 'validationNamespace' = v_validation_namespace
            and r.content_hash like 'sha256:%'
            and r.raw_content is not null and length(r.raw_content) > 0
            and r.extraction_quality = 'full' and r.processing_status = 'extracted'
       ) then
      return jsonb_build_object('status', 'BLOCKED', 'reason', 'SYNTHETIC_LINEAGE_OR_ARCHIVE_CHANGED');
    end if;
  else
    if not exists (
      select 1 from public.events as e
       where e.id = v_real_event_id and e.event_key = v_real_event_key
         and e.event_status = 'active' and e.review_status = 'approved'
    ) or not exists (
      select 1 from public.articles as a
       where a.id = v_real_article_id and a.event_id = v_real_event_id
         and a.slug = v_real_article_slug and a.publication_status = 'archived'
    ) or exists (
      select 1 from public.public_published_articles as p where p.slug = v_real_article_slug
    ) or (select count(*) from public.event_sources as es where es.event_id = v_real_event_id) <> 1
       or not exists (
         select 1 from public.event_sources as es
         join public.raw_items as r on r.id = es.raw_item_id and r.source_id = es.source_id
         join public.sources as s on s.id = es.source_id
          where es.event_id = v_real_event_id and es.raw_item_id = v_real_raw_item_id
            and es.source_id = v_real_source_id and s.name = 'TechCrunch AI'
            and r.content_hash = v_real_raw_content_hash and length(r.raw_content) = 1756
            and r.raw_content is not null and r.extraction_quality = 'full'
            and r.processing_status = 'extracted'
       ) then
      return jsonb_build_object('status', 'BLOCKED', 'reason', 'INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED');
    end if;
    -- Retain the canonical pre-dispatch evidence that authorized the incident:
    -- exactly one V3 refusal, zero dispatched requests, and no reservation row.
    if (select count(*) from public.agent_runs as ar
         where ar.id = '82c2b260-dd02-4232-a6bd-d7d1ffa84b39'
           and ar.config ->> 'agentName' = 'critic'
           and ar.config ->> 'agentVersion' = 'critic-v3'
           and ar.config ->> 'eventKey' = v_real_event_key
           and ar.config ->> 'model' = 'openai/gpt-oss-20b'
           and ar.config ->> 'pipelineRunId' = v_real_original_run_id::text
           and ar.config ->> 'attemptId' = v_real_attempt_id::text
           and ar.status = 'failed' and ar.provider = 'groq'
           and ar.stats #>> '{telemetry,providerRequestDispatched}' = 'false'
           and ar.stats #>> '{telemetry,providerRequestsUsed}' = '0') <> 1
       or exists (
         select 1 from public.agent_logs as l
          where l.run_id = '82c2b260-dd02-4232-a6bd-d7d1ffa84b39'
            and l.step = 'provider_request_reserved'
       ) then
      return jsonb_build_object('status', 'BLOCKED', 'reason', 'CANONICAL_PRE_DISPATCH_PROOF_CHANGED');
    end if;
  end if;

  v_previous_stop := v_continuation;
  update public.pipeline_event_attempts
     set continuation = v_continuation || jsonb_build_object(
       'status', 'RUNNING',
       'resumeGeneration', 1,
       'resumeExecutionId', p_resume_execution_id,
       'resumedAt', v_now,
       'resumeHistory', jsonb_build_array(v_previous_stop),
       'completedAt', null,
       'stopStage', null,
       'stopReason', null,
       'criticDecision', null,
       'providerRequestsUsed', 0
     )
   where id = p_attempt_id and continuation ->> 'status' = 'STOPPED'
     and not (continuation ? 'resumeGeneration');
  if not found then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'AUTHORIZED_RESUME_ALREADY_USED');
  end if;
  return jsonb_build_object(
    'status', 'RESUMED',
    'attemptId', p_attempt_id,
    'pipelineRunId', p_pipeline_run_id,
    'resumeExecutionId', p_resume_execution_id,
    'resumeGeneration', 1,
    'authorizationReused', true,
    'newAuthorizationCreated', false,
    'newAttemptCreated', false
  );
end;
$$;

revoke all on function public.resume_incident_factual_remediation_continuation(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.resume_incident_factual_remediation_continuation(uuid, uuid, uuid, jsonb) to service_role;

commit;
