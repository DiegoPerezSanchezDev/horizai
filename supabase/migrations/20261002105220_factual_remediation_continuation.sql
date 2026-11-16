-- 12C.2B.2c: one audited Critic-only continuation on the existing pilot attempt.
-- The terminal attempt row remains immutable; the execution history is a separate JSONB field.
begin;

alter table public.pipeline_event_attempts
  add column continuation jsonb,
  add constraint pipeline_event_attempts_continuation_shape_check
    check (
      continuation is null
      or (
        coalesce(jsonb_typeof(continuation) = 'object'
        and continuation ->> 'kind' = 'FACTUAL_REMEDIATION_CONTINUATION'
        and continuation ->> 'attemptId' = id::text
        and length(trim(coalesce(continuation ->> 'pipelineRunId', ''))) > 0
        and continuation ->> 'resumeStage' = 'critic'
        and continuation ->> 'status' in ('RUNNING', 'STOPPED', 'PUBLISHED')
        and length(trim(coalesce(continuation ->> 'authorizedBy', ''))) between 2 and 120
        and length(trim(coalesce(continuation ->> 'authorizationReference', ''))) between 5 and 500
        and length(trim(coalesce(continuation ->> 'reason', ''))) between 20 and 1000
        and jsonb_typeof(continuation -> 'checkpointManifest') = 'object', false)
    ));

-- Migration 27's incident metadata check permits its own isolated test namespace.
-- Add this phase's namespace for remote lifecycle fixtures without changing the
-- ordinary claim path or assigning synthetic rows a pilot attempt ordinal.
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
          (validation_namespace ~ '^12c2b2d:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            and pilot_attempt_number is null)
        ))
    );

create unique index pipeline_event_attempts_continuation_run_id_idx
  on public.pipeline_event_attempts ((continuation ->> 'pipelineRunId'))
  where continuation is not null;

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
    and coalesce(v_validation_namespace, '') ~ '^12c2b2d:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
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
  if jsonb_object_length(p_checkpoint_manifest) <> 6
     or jsonb_object_length(p_checkpoint_manifest -> 'checkpoints') <> 5
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

create or replace function public.finish_incident_factual_remediation_continuation(
  p_attempt_id uuid,
  p_pipeline_run_id uuid,
  p_critic_decision text,
  p_stop_stage text,
  p_stop_reason text,
  p_provider_requests_used integer
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_event_key constant text := 'event-30f226d1b8ba5c9eb8af2b65c46db512';
  v_now timestamptz := clock_timestamp();
  v_continuation jsonb;
  v_attempt public.pipeline_event_attempts%rowtype;
  v_dispatched_requests integer := 0;
  v_reservation_rows integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'factual_remediation_continuation_service_role_required';
  end if;
  if p_attempt_id is distinct from 'a82482be-58d8-4fc6-ac16-946d0906257b'::uuid
     or p_pipeline_run_id is null
     or (p_critic_decision is not null and p_critic_decision not in ('pass','reject','revise_verification','revise_translation','revise_editorial','revise_classification','revise_ranking'))
     or p_stop_stage is null or p_stop_stage not in ('critic','publisher')
     or length(trim(coalesce(p_stop_reason, ''))) not between 1 and 120
     or p_provider_requests_used is null or p_provider_requests_used not between 0 and 1 then
    raise exception using errcode = '22023', message = 'factual_remediation_continuation_result_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_event_key, 0));
  select * into v_attempt
    from public.pipeline_event_attempts
   where id = p_attempt_id and event_key = v_event_key for update;
  v_continuation := v_attempt.continuation;
  if v_attempt.id is null or v_attempt.pipeline_run_id <> 'db368f10-d9c1-4897-b752-b3d2cb156e09'::uuid
     or v_attempt.attempt_number <> 2 or v_attempt.purpose <> 'FACTUAL_REMEDIATION'
     or v_attempt.pilot_attempt_number <> 5 or v_attempt.final_state <> 'TECHNICAL_FAILURE'
     or v_attempt.completed_at is null or v_attempt.stop_stage <> 'critic'
     or v_attempt.stop_reason <> 'cost_guard_violation'
     or v_continuation is null or v_continuation ->> 'pipelineRunId' <> p_pipeline_run_id::text then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CONTINUATION_NOT_OWNED');
  end if;
  if v_continuation ->> 'status' = 'PUBLISHED' then
    return jsonb_build_object('status', 'ALREADY_PUBLISHED', 'attemptId', p_attempt_id, 'pipelineRunId', p_pipeline_run_id);
  end if;
  if v_continuation ->> 'status' = 'STOPPED' then
    return jsonb_build_object('status', 'ALREADY_STOPPED', 'attemptId', p_attempt_id, 'pipelineRunId', p_pipeline_run_id);
  end if;
  if v_continuation ->> 'status' <> 'RUNNING' then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'CONTINUATION_NOT_RUNNING');
  end if;
  select (count(l.id) filter (where l.payload ->> 'providerRequestDispatched' = 'true'))::integer,
         count(l.id)::integer
    into v_dispatched_requests, v_reservation_rows
    from public.agent_runs as ar
    left join public.agent_logs as l on l.run_id = ar.id
      and l.step = 'provider_request_reserved'
   where ar.config ->> 'agentName' = 'critic'
     and ar.config ->> 'agentVersion' = 'critic-v4'
     and ar.config ->> 'eventKey' = v_event_key
     and ar.config ->> 'model' = 'openai/gpt-oss-20b'
     and ar.config ->> 'attemptId' = p_attempt_id::text
     and ar.config ->> 'pipelineRunId' = p_pipeline_run_id::text
     and ar.provider = 'groq';
  if v_dispatched_requests > 1 or v_reservation_rows > 1
     or p_provider_requests_used <> v_dispatched_requests then
    raise exception using errcode = 'P0001', message = 'factual_remediation_continuation_request_limit_or_accounting_invalid';
  end if;
  update public.pipeline_event_attempts
     set continuation = continuation || jsonb_build_object(
       'status', 'STOPPED', 'completedAt', v_now, 'criticDecision', p_critic_decision,
       'stopStage', p_stop_stage, 'stopReason', trim(p_stop_reason),
       'providerRequestsUsed', v_dispatched_requests
     )
   where id = p_attempt_id;
  return jsonb_build_object('status', 'STOPPED', 'attemptId', p_attempt_id, 'pipelineRunId', p_pipeline_run_id);
end;
$$;

create or replace function public.publish_incident_factual_remediation_continuation_atomic(
  p_attempt_id uuid,
  p_pipeline_run_id uuid,
  p_article_id uuid,
  p_expected_slug text,
  p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_event_key constant text := 'event-30f226d1b8ba5c9eb8af2b65c46db512';
  v_event_id constant uuid := '5138e509-f4c3-4020-9d13-6a6efac99a39';
  v_article_id constant uuid := '756b0ee0-b5e6-4153-846f-278a12c9afe3';
  v_slug constant text := 'openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad';
  v_attempt public.pipeline_event_attempts%rowtype;
  v_article public.articles%rowtype;
  v_critic_run public.agent_runs%rowtype;
  v_critic_runs integer;
  v_reservations integer;
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'factual_remediation_continuation_service_role_required';
  end if;
  if p_attempt_id is distinct from 'a82482be-58d8-4fc6-ac16-946d0906257b'::uuid
     or p_pipeline_run_id is null or p_article_id is distinct from v_article_id
     or p_expected_slug is distinct from v_slug
     or jsonb_typeof(p_payload) is distinct from 'object'
     or p_payload ->> 'eventKey' is distinct from v_event_key
     or p_payload -> 'article' ->> 'slug' is distinct from v_slug then
    raise exception using errcode = '22023', message = 'factual_remediation_continuation_publication_identity_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_event_key, 0));
  select * into v_attempt from public.pipeline_event_attempts where id = p_attempt_id for update;
  if v_attempt.id is null or v_attempt.event_key <> v_event_key
     or v_attempt.purpose <> 'FACTUAL_REMEDIATION' or v_attempt.pilot_attempt_number <> 5
     or v_attempt.pipeline_run_id <> 'db368f10-d9c1-4897-b752-b3d2cb156e09'::uuid
     or v_attempt.attempt_number <> 2
     or v_attempt.final_state <> 'TECHNICAL_FAILURE' or v_attempt.completed_at is null
     or v_attempt.stop_stage <> 'critic' or v_attempt.stop_reason <> 'cost_guard_violation'
     or v_attempt.retry_class <> 'NONE' or v_attempt.counts_toward_retry_limit
     or v_attempt.remediation_article_id <> v_article_id
     or v_attempt.remediation_raw_item_id <> 'd3834944-72f6-4f59-9aca-3f66ae92dc33'::uuid
     or v_attempt.remediation_prior_attempt_id <> '4017edf4-86be-49f1-a464-e766ad371284'::uuid
     or v_attempt.continuation ->> 'kind' <> 'FACTUAL_REMEDIATION_CONTINUATION'
     or v_attempt.continuation ->> 'pipelineRunId' <> p_pipeline_run_id::text
     or v_attempt.continuation ->> 'resumeStage' <> 'critic'
     or v_attempt.continuation ->> 'status' <> 'RUNNING' then
    raise exception using errcode = 'P0001', message = 'factual_remediation_continuation_not_owned';
  end if;

  select count(*) into v_critic_runs from public.agent_runs as ar
   where ar.config ->> 'agentName' = 'critic'
     and ar.config ->> 'agentVersion' = 'critic-v4'
     and ar.config ->> 'eventKey' = v_event_key
     and ar.config ->> 'model' = 'openai/gpt-oss-20b'
     and ar.config ->> 'attemptId' = p_attempt_id::text
     and ar.config ->> 'pipelineRunId' = p_pipeline_run_id::text
     and ar.provider = 'groq' and ar.status = 'succeeded'
     and ar.stats ->> 'finalCriticResultValid' = 'true'
     and ar.stats ->> 'finalDecision' = 'pass'
     and ar.stats ->> 'deterministicPrechecksPassed' = 'true'
     and ar.stats ->> 'evidenceRefsValidated' = 'true'
     and ar.stats #>> '{telemetry,providerRequestDispatched}' = 'true'
     and ar.stats #>> '{telemetry,providerRequestsUsed}' = '1';
  if v_critic_runs <> 1 then
    raise exception using errcode = 'P0001', message = 'factual_remediation_continuation_critic_pass_not_proven';
  end if;
  select * into strict v_critic_run from public.agent_runs as ar
   where ar.config ->> 'agentName' = 'critic'
     and ar.config ->> 'agentVersion' = 'critic-v4'
     and ar.config ->> 'eventKey' = v_event_key
     and ar.config ->> 'model' = 'openai/gpt-oss-20b'
     and ar.config ->> 'attemptId' = p_attempt_id::text
     and ar.config ->> 'pipelineRunId' = p_pipeline_run_id::text
     and ar.provider = 'groq' and ar.status = 'succeeded'
     and ar.stats ->> 'finalCriticResultValid' = 'true'
     and ar.stats ->> 'finalDecision' = 'pass'
     and ar.stats ->> 'deterministicPrechecksPassed' = 'true'
     and ar.stats ->> 'evidenceRefsValidated' = 'true'
     and ar.stats #>> '{telemetry,providerRequestDispatched}' = 'true'
     and ar.stats #>> '{telemetry,providerRequestsUsed}' = '1'
   for update;
  select count(*) into v_reservations from public.agent_logs as l
   where l.run_id = v_critic_run.id and l.step = 'provider_request_reserved';
  if v_reservations <> 1 or not exists (
    select 1 from public.agent_logs as l
     where l.run_id = v_critic_run.id and l.step = 'provider_request_reserved'
       and l.provider = 'groq' and l.provider_unit = 'tokens'
       and l.payload ->> 'providerRequestDispatched' = 'true'
       and l.payload ->> 'tokenUsageState' = 'settled'
       and l.provider_unit_amount > 0
  ) then
    raise exception using errcode = 'P0001', message = 'factual_remediation_continuation_critic_reservation_not_settled';
  end if;

  if (select count(*) from public.event_sources as es where es.event_id = v_event_id) <> 1
     or not exists (
       select 1 from public.event_sources as es
         join public.raw_items as r on r.id = es.raw_item_id and r.source_id = es.source_id
         join public.sources as s on s.id = es.source_id
        where es.event_id = v_event_id
          and es.raw_item_id = 'd3834944-72f6-4f59-9aca-3f66ae92dc33'::uuid
          and es.source_id = 'e8dd0363-f51e-4381-9fb2-c02ee81f4d41'::uuid
          and s.name = 'TechCrunch AI'
          and r.content_hash = 'sha256:9f053bdbb6d53e5d59baf254201811874992bf7cad444b38431b8f364bfe5caa'
          and r.raw_content is not null and length(r.raw_content) = 1756
          and r.extraction_quality = 'full' and r.processing_status = 'extracted'
     ) then
    raise exception using errcode = 'P0001', message = 'factual_remediation_continuation_raw_lineage_changed';
  end if;
  perform 1 from public.event_sources as es
    join public.raw_items as r on r.id = es.raw_item_id and r.source_id = es.source_id
   where es.event_id = v_event_id
     and es.raw_item_id = 'd3834944-72f6-4f59-9aca-3f66ae92dc33'::uuid
     and es.source_id = 'e8dd0363-f51e-4381-9fb2-c02ee81f4d41'::uuid
   for share of es, r;

  if not exists (
    select 1 from public.events as e
     where e.id = v_event_id and e.event_key = v_event_key
       and e.event_status = 'active' and e.review_status = 'approved'
  ) or exists (
    select 1 from public.public_published_articles as p where p.slug = v_slug
  ) then
    raise exception using errcode = 'P0001', message = 'factual_remediation_continuation_event_or_public_state_changed';
  end if;

  select * into v_article from public.articles
   where id = v_article_id and event_id = v_event_id and slug = v_slug
     and publication_status = 'archived' for update;
  if v_article.id is null or exists (select 1 from public.public_published_articles as p where p.slug = v_slug) then
    raise exception using errcode = 'P0001', message = 'factual_remediation_continuation_article_not_archived';
  end if;
  v_result := public.publish_article_atomic(p_payload);
  select * into v_article from public.articles
   where id = v_article_id and event_id = v_event_id and slug = v_slug
     and publication_status = 'published';
  if v_article.id is null then
    raise exception using errcode = 'P0001', message = 'factual_remediation_continuation_article_identity_not_preserved';
  end if;
  update public.pipeline_event_attempts
     set continuation = continuation || jsonb_build_object(
       'status', 'PUBLISHED', 'completedAt', clock_timestamp(), 'criticDecision', 'pass',
       'finalState', 'READY_FOR_PUBLICATION', 'providerRequestsUsed', 1,
       'criticAgentRunId', v_critic_run.id
     )
   where id = p_attempt_id;
  return v_result || jsonb_build_object('factualRemediationContinuation', jsonb_build_object(
    'attemptId', p_attempt_id, 'pipelineRunId', p_pipeline_run_id, 'articleId', v_article_id, 'slug', v_slug
  ));
end;
$$;

revoke all on function public.authorize_incident_factual_remediation_continuation(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.authorize_incident_factual_remediation_continuation(uuid, uuid, text, text, text, jsonb) to service_role;
revoke all on function public.finish_incident_factual_remediation_continuation(uuid, uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.finish_incident_factual_remediation_continuation(uuid, uuid, text, text, text, integer) to service_role;
revoke all on function public.publish_incident_factual_remediation_continuation_atomic(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.publish_incident_factual_remediation_continuation_atomic(uuid, uuid, uuid, text, jsonb) to service_role;

comment on column public.pipeline_event_attempts.continuation is
  'One-time FACTUAL_REMEDIATION_CONTINUATION audit state. Original completed_at/final_state/stop fields preserve the terminal attempt truth.';

commit;
