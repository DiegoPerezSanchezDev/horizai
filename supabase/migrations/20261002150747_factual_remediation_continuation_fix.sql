-- 12C.2B.2d.1: PostgreSQL-valid exact manifest cardinality and isolated validation namespace.
begin;
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
        ))
    );
create or replace function public.authorize_incident_factual_remediation_continuation(
  p_attempt_id uuid,
  p_pipeline_run_id uuid,
  p_authorized_by text,
  p_authorization_reference text,
  p_reason text,
  p_checkpoint_manifest jsonb
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_real_attempt_id constant uuid := 'a82482be-58d8-4fc6-ac16-946d0906257b';
  v_real_event_key constant text := 'event-30f226d1b8ba5c9eb8af2b65c46db512';
  v_real_original_run_id constant uuid := 'db368f10-d9c1-4897-b752-b3d2cb156e09';
  v_real_prior_attempt_id constant uuid := '4017edf4-86be-49f1-a464-e766ad371284';
  v_real_event_id constant uuid := '5138e509-f4c3-4020-9d13-6a6efac99a39';
  v_real_article_id constant uuid := '756b0ee0-b5e6-4153-846f-278a12c9afe3';
  v_real_raw_item_id constant uuid := 'd3834944-72f6-4f59-9aca-3f66ae92dc33';
  v_real_source_id constant uuid := 'e8dd0363-f51e-4381-9fb2-c02ee81f4d41';
  v_real_critic_run_id constant uuid := '82c2b260-dd02-4232-a6bd-d7d1ffa84b39';
  v_real_article_slug constant text := 'openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad';
  v_real_raw_content_hash constant text := 'sha256:9f053bdbb6d53e5d59baf254201811874992bf7cad444b38431b8f364bfe5caa';
  v_event_key text;
  v_original_run_id uuid;
  v_prior_attempt_id uuid;
  v_event_id uuid;
  v_article_id uuid;
  v_raw_item_id uuid;
  v_article_slug text;
  v_validation_namespace text;
  v_is_synthetic boolean := false;
  v_attempt public.pipeline_event_attempts%rowtype;
  v_critic_runs integer;
  v_now timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'factual_remediation_continuation_service_role_required';
  end if;
  if p_attempt_id is null
     or p_pipeline_run_id is null
     or length(trim(coalesce(p_authorized_by, ''))) not between 2 and 120
     or length(trim(coalesce(p_authorization_reference, ''))) not between 5 and 500
     or length(trim(coalesce(p_reason, ''))) not between 20 and 1000 then
    raise exception using errcode = '22023', message = 'factual_remediation_continuation_authorization_invalid';
  end if;

  select * into v_attempt from public.pipeline_event_attempts where id = p_attempt_id;
  if v_attempt.id is null then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TERMINAL_ATTEMPT_NOT_ELIGIBLE');
  end if;
  v_event_key := v_attempt.event_key;
  perform pg_advisory_xact_lock(hashtextextended(v_event_key, 0));
  select * into v_attempt from public.pipeline_event_attempts
   where id = p_attempt_id and event_key = v_event_key for update;
  v_validation_namespace := v_attempt.validation_namespace;
  v_is_synthetic := p_attempt_id <> v_real_attempt_id
    and coalesce(v_validation_namespace, '') ~ '^12c2b2d1?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  if p_attempt_id = v_real_attempt_id then
    v_event_key := v_real_event_key;
    v_original_run_id := v_real_original_run_id;
    v_prior_attempt_id := v_real_prior_attempt_id;
    v_event_id := v_real_event_id;
    v_article_id := v_real_article_id;
    v_raw_item_id := v_real_raw_item_id;
    v_article_slug := v_real_article_slug;
  elsif v_is_synthetic then
    v_original_run_id := v_attempt.pipeline_run_id;
    v_prior_attempt_id := v_attempt.remediation_prior_attempt_id;
    v_article_id := v_attempt.remediation_article_id;
    v_raw_item_id := v_attempt.remediation_raw_item_id;
    select e.id into v_event_id from public.events as e where e.event_key = v_event_key;
    select a.slug into v_article_slug from public.articles as a where a.id = v_article_id;
  else
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TERMINAL_ATTEMPT_NOT_ELIGIBLE');
  end if;
  if v_attempt.id is null or v_attempt.event_key <> v_event_key
     or v_attempt.pipeline_run_id <> v_original_run_id or p_pipeline_run_id = v_original_run_id
     or (v_is_synthetic and (v_attempt.id in (v_real_attempt_id, v_real_prior_attempt_id)
       or v_event_key = v_real_event_key or v_event_id = v_real_event_id
       or v_article_id = v_real_article_id or v_raw_item_id = v_real_raw_item_id
       or v_prior_attempt_id = v_real_prior_attempt_id)) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TERMINAL_ATTEMPT_NOT_ELIGIBLE');
  end if;
  if v_attempt.id is null
     or v_attempt.purpose <> 'FACTUAL_REMEDIATION'
     or v_attempt.start_stage <> 'VERIFIER'
     or v_attempt.attempt_number <> 2
     or (v_is_synthetic and v_attempt.pilot_attempt_number is not null)
     or (not v_is_synthetic and v_attempt.pilot_attempt_number <> 5)
     or v_attempt.remediation_article_id <> v_article_id
     or v_attempt.remediation_prior_attempt_id <> v_prior_attempt_id
     or v_attempt.remediation_raw_item_id <> v_raw_item_id
     or v_attempt.final_state <> 'TECHNICAL_FAILURE'
     or v_attempt.completed_at is null
     or v_attempt.stop_stage <> 'critic'
     or v_attempt.stop_reason <> 'cost_guard_violation'
     or v_attempt.retry_class <> 'NONE'
     or v_attempt.counts_toward_retry_limit
     or v_attempt.continuation is not null then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TERMINAL_ATTEMPT_NOT_ELIGIBLE');
  end if;
  if not exists (
    select 1 from public.pipeline_event_attempts as prior
     where prior.id = v_prior_attempt_id and prior.event_key = v_event_key
       and prior.attempt_number = 1 and prior.purpose = 'NORMAL'
       and prior.final_state = 'READY_FOR_PUBLICATION' and prior.completed_at is not null
       and (v_is_synthetic or prior.pipeline_run_id = '63b81d9a-e46f-4434-9637-335d3f455e0b'::uuid)
  ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'PRIOR_TERMINAL_ATTEMPT_CHANGED');
  end if;
  if exists (select 1 from public.pipeline_event_attempts where event_key = v_event_key and attempt_number > 2)
     or (select count(*) from public.pipeline_event_attempts where event_key = v_event_key) <> 2
     or (not v_is_synthetic and exists (select 1 from public.pipeline_event_attempts where event_key = v_event_key and pilot_attempt_number = 6))
     or exists (select 1 from public.pipeline_event_attempts where pipeline_run_id = p_pipeline_run_id) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'ATTEMPT_HISTORY_CHANGED');
  end if;

  -- The database ledger must show the canonical pre-dispatch TPM refusal,
  -- a failed critic run with zero requests, and no Critic reservation row.
  select count(*) into v_critic_runs
    from public.agent_runs as ar
   where ar.config ->> 'agentName' = 'critic'
     and ar.config ->> 'agentVersion' = 'critic-v3'
     and ar.config ->> 'eventKey' = v_event_key
     and ar.config ->> 'model' = 'openai/gpt-oss-20b'
     and ar.config ->> 'provider' = 'groq'
     and ar.provider = 'groq'
     and ar.status = 'failed'
     and ar.started_at >= v_attempt.started_at
     and ar.started_at <= v_attempt.completed_at
     and ar.finished_at <= v_attempt.completed_at
     and ar.stats #>> '{telemetry,status}' = 'RUNTIME_ERROR'
     and ar.stats #>> '{telemetry,providerRequestDispatched}' = 'false'
     and ar.stats #>> '{telemetry,providerRequestsUsed}' = '0'
     and (v_is_synthetic or ar.id = v_real_critic_run_id)
     and (not v_is_synthetic or (
       ar.config ->> 'pipelineRunId' = v_original_run_id::text
       and ar.config ->> 'attemptId' = v_attempt.id::text
       and ar.config ->> 'validationNamespace' = v_validation_namespace
     ))
     and exists (
       select 1 from public.agent_logs as l
        where l.run_id = ar.id and l.agent_name = 'critic'
          and l.step = 'groq_tpm_pacing_decision'
          and l.payload ->> 'eventKey' = v_event_key
          and l.payload ->> 'runId' = ar.id::text
          and l.payload ->> 'agentVersion' = 'critic-v3'
          and l.payload ->> 'model' = 'openai/gpt-oss-20b'
          and l.payload ->> 'provider' = 'groq'
          and l.payload #>> '{details,reason}' = 'GROQ_TPM_STAGE_EXCEEDS_TPM'
          and l.payload #>> '{details,estimatedStageTokenRequirement}' = '9005'
          and l.payload #>> '{details,tokenLimitTpm}' = '8000'
          and l.created_at >= ar.created_at
          and l.created_at <= ar.finished_at
     )
     and not exists (
       select 1 from public.agent_logs as l
        where l.run_id = ar.id and (l.step = 'provider_request_reserved'
          or l.payload #>> '{details,providerRequestDispatched}' = 'true'
          or l.payload #>> '{diagnostics,providerRequestDispatched}' = 'true')
     );
  if v_critic_runs <> 1 then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CRITIC_NON_DISPATCH_NOT_PROVEN');
  end if;

  -- Local checkpoint readers verify the bytes. This RPC independently checks
  -- the exact five-stage/hash manifest shape and records its attestation.
  if jsonb_typeof(p_checkpoint_manifest) is distinct from 'object'
     or p_checkpoint_manifest ->> 'schemaVersion' is distinct from '1'
     or p_checkpoint_manifest ->> 'eventKey' is distinct from v_event_key
     or p_checkpoint_manifest ->> 'sourceRunId' is distinct from v_original_run_id::text
     or p_checkpoint_manifest ->> 'resumeStage' is distinct from 'critic'
     or p_checkpoint_manifest ->> 'criticCheckpoint' is distinct from 'absent'
     or jsonb_typeof(p_checkpoint_manifest -> 'checkpoints') is distinct from 'object' then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CHECKPOINT_MANIFEST_INVALID');
  end if;
  if (select count(*) from jsonb_object_keys(p_checkpoint_manifest)) <> 6
     or (select count(*) from jsonb_object_keys(p_checkpoint_manifest -> 'checkpoints')) <> 5
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,verifier}', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,translator}', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,editor}', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,classifier}', '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_checkpoint_manifest #>> '{checkpoints,ranker}', '') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CHECKPOINT_MANIFEST_INVALID');
  end if;

  if exists (
    select 1 from public.agent_runs as ar
     where ar.config ->> 'agentName' = 'critic'
       and ar.config ->> 'agentVersion' = 'critic-v4'
       and ar.config ->> 'eventKey' = v_event_key
       and ar.config ->> 'model' = 'openai/gpt-oss-20b'
       and ar.config ->> 'pipelineRunId' = v_original_run_id::text
       and ar.config ->> 'attemptId' = v_attempt.id::text
       and ar.status = 'succeeded'
       and (not v_is_synthetic or ar.config ->> 'validationNamespace' = v_validation_namespace)
  ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CRITIC_CHECKPOINT_ALREADY_EXISTS');
  end if;

  if not exists (
    select 1 from public.events as e
     where e.id = v_event_id and e.event_key = v_event_key
       and e.event_status = 'active' and e.review_status = 'approved'
       and (not v_is_synthetic or e.classification_payload ->> 'validationNamespace' = v_validation_namespace)
  ) or not exists (
    select 1 from public.articles as a
     where a.id = v_article_id and a.event_id = v_event_id and a.slug = v_article_slug
      and a.publication_status = 'archived'
      and (not v_is_synthetic or a.metadata ->> 'validationNamespace' = v_validation_namespace)
  ) or (select count(*) from public.event_sources as es
          where es.event_id = v_event_id) <> 1
     or not exists (
    select 1
      from public.event_sources as es
      join public.raw_items as r on r.id = es.raw_item_id and r.source_id = es.source_id
      join public.sources as s on s.id = es.source_id
     where es.event_id = v_event_id
       and es.raw_item_id = v_raw_item_id
       and (v_is_synthetic or (es.source_id = v_real_source_id
         and s.name = 'TechCrunch AI' and r.content_hash = v_real_raw_content_hash
         and length(r.raw_content) = 1756))
       and (not v_is_synthetic or (
         r.normalized_payload ->> 'validationNamespace' = v_validation_namespace
         and s.metadata ->> 'validationNamespace' = v_validation_namespace
         and r.content_hash like 'sha256:%'
       ))
       and r.raw_content is not null
       and length(r.raw_content) > 0
       and r.extraction_quality = 'full'
       and r.processing_status = 'extracted'
  ) or exists (
    select 1 from public.public_published_articles as p where p.slug = v_article_slug
  ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'INCIDENT_ARTICLE_NOT_ARCHIVED');
  end if;

  update public.pipeline_event_attempts
     set continuation = jsonb_build_object(
       'kind', 'FACTUAL_REMEDIATION_CONTINUATION',
       'attemptId', p_attempt_id,
       'pipelineRunId', p_pipeline_run_id,
       'resumeStage', 'critic',
       'criticAgentVersion', 'critic-v4',
       'authorizedBy', trim(p_authorized_by),
       'authorizationReference', trim(p_authorization_reference),
       'reason', trim(p_reason),
       'authorizedAt', v_now,
       'status', 'RUNNING',
       'pilotAttemptNumber', 5,
       'syntheticFixture', v_is_synthetic,
       'validationNamespace', case when v_is_synthetic then v_validation_namespace else null end,
       'checkpointManifest', p_checkpoint_manifest
     )
   where id = p_attempt_id and continuation is null;
  if not found then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CONTINUATION_ALREADY_AUTHORIZED');
  end if;
  return jsonb_build_object('status', 'AUTHORIZED', 'attemptId', p_attempt_id, 'pipelineRunId', p_pipeline_run_id,
    'resumeStage', 'critic', 'pilotAttemptNumber', 5, 'syntheticFixture', v_is_synthetic);
end;
$$;
revoke all on function public.authorize_incident_factual_remediation_continuation(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.authorize_incident_factual_remediation_continuation(uuid, uuid, text, text, text, jsonb) to service_role;

commit;
