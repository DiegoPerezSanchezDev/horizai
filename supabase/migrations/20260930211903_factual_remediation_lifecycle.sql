-- 12C.2B.1: audited factual-remediation claim plus namespaced synthetic validation.
begin;

alter table public.pipeline_event_attempts
  add column purpose text not null default 'NORMAL',
  add column start_stage text,
  add column remediation_article_id uuid references public.articles(id) on delete restrict,
  add column remediation_raw_item_id uuid references public.raw_items(id) on delete restrict,
  add column remediation_prior_attempt_id uuid references public.pipeline_event_attempts(id) on delete restrict,
  add column remediation_reason text,
  add column authorized_by text,
  add column authorization_reference text,
  add column pilot_attempt_number smallint,
  add column validation_namespace text;

alter table public.pipeline_event_attempts
  add constraint pipeline_event_attempts_purpose_check
    check (purpose in ('NORMAL', 'FACTUAL_REMEDIATION')),
  add constraint pipeline_event_attempts_remediation_stage_check
    check ((purpose = 'NORMAL' and start_stage is null) or (purpose = 'FACTUAL_REMEDIATION' and start_stage = 'VERIFIER')),
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
        ))
    );

create unique index pipeline_event_attempts_one_factual_remediation_idx
  on public.pipeline_event_attempts (event_key)
  where purpose = 'FACTUAL_REMEDIATION';

create unique index pipeline_event_attempts_pilot_attempt_number_idx
  on public.pipeline_event_attempts (pilot_attempt_number)
  where pilot_attempt_number is not null;

-- All attempt writes go through owner-checked RPCs. Synthetic remediations are
-- restricted to a per-run validation namespace and never take a pilot ordinal.
revoke insert, update, delete on table public.pipeline_event_attempts from service_role;

create or replace function public.claim_factual_remediation_attempt(
  p_pipeline_run_id uuid,
  p_authorized_by text,
  p_authorization_reference text,
  p_reason text,
  p_event_key text,
  p_event_id uuid,
  p_article_id uuid,
  p_raw_item_id uuid,
  p_prior_attempt_id uuid,
  p_purpose text,
  p_start_stage text,
  p_validation_namespace text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_incident_event_id constant uuid := '5138e509-f4c3-4020-9d13-6a6efac99a39';
  v_incident_event_key constant text := 'event-30f226d1b8ba5c9eb8af2b65c46db512';
  v_incident_article_id constant uuid := '756b0ee0-b5e6-4153-846f-278a12c9afe3';
  v_incident_article_slug constant text := 'openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad';
  v_incident_raw_item_id constant uuid := 'd3834944-72f6-4f59-9aca-3f66ae92dc33';
  v_incident_source_id constant uuid := 'e8dd0363-f51e-4381-9fb2-c02ee81f4d41';
  v_incident_raw_content_hash constant text := 'sha256:9f053bdbb6d53e5d59baf254201811874992bf7cad444b38431b8f364bfe5caa';
  v_incident_prior_run_id constant uuid := '63b81d9a-e46f-4434-9637-335d3f455e0b';
  v_now timestamptz := clock_timestamp();
  v_prior_attempt public.pipeline_event_attempts%rowtype;
  v_new_attempt public.pipeline_event_attempts%rowtype;
  v_pilot_matches integer;
  v_is_incident boolean;
  v_source_id uuid;
  v_next_attempt_number integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'factual_remediation_service_role_required';
  end if;
  if p_pipeline_run_id is null
     or length(trim(coalesce(p_authorized_by, ''))) not between 2 and 120
     or length(trim(coalesce(p_authorization_reference, ''))) not between 5 and 500
     or length(trim(coalesce(p_reason, ''))) not between 20 and 1000 then
    raise exception using errcode = '22023', message = 'factual_remediation_authorization_invalid';
  end if;
  if p_purpose is distinct from 'FACTUAL_REMEDIATION' then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'INVALID_PURPOSE');
  end if;
  if p_start_stage is distinct from 'VERIFIER' then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'INVALID_START_STAGE');
  end if;
  if p_event_key is null or p_event_key = '' or p_event_id is null or p_article_id is null
     or p_raw_item_id is null or p_prior_attempt_id is null then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'TARGET_IDENTITY_INVALID');
  end if;

  v_is_incident := p_validation_namespace is null;
  if v_is_incident then
    if p_event_key is distinct from v_incident_event_key
       or p_event_id is distinct from v_incident_event_id
       or p_article_id is distinct from v_incident_article_id
       or p_raw_item_id is distinct from v_incident_raw_item_id then
      return jsonb_build_object('status', 'BLOCKED', 'reason', 'INCIDENT_IDENTITY_MISMATCH');
    end if;
  elsif p_validation_namespace !~ '^12c2b1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_event_key = v_incident_event_key
     or p_event_id = v_incident_event_id
     or p_article_id = v_incident_article_id
     or p_raw_item_id = v_incident_raw_item_id then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'VALIDATION_NAMESPACE_INVALID');
  end if;

  -- Serialize with the ordinary claim RPC on the same event key.
  perform pg_advisory_xact_lock(hashtextextended(p_event_key, 0));

  if exists (select 1 from public.pipeline_event_attempts where event_key = p_event_key and completed_at is null) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'ACTIVE_ATTEMPT');
  end if;
  if exists (select 1 from public.pipeline_event_attempts where event_key = p_event_key and purpose = 'FACTUAL_REMEDIATION') then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'REMEDIATION_ALREADY_CLAIMED');
  end if;

  if v_is_incident then
    if exists (select 1 from public.pipeline_event_attempts where pilot_attempt_number = 5) then
      return jsonb_build_object('status', 'BLOCKED', 'reason', 'PILOT_ATTEMPT_FIVE_ALREADY_USED');
    end if;
    -- Verify the four immutable pilot rows; unrelated history is not counted.
    select count(*) into v_pilot_matches
    from (values
      ('event-cbbf85234317a442f59ece63ef1b40c8', 'ce894b55-5c50-44dc-87db-58bcbf09834b'::uuid, 1, 'TECHNICAL_FAILURE', true),
      ('event-cbbf85234317a442f59ece63ef1b40c8', '8c96ffb9-4705-4aab-b396-7e4cc41b2939'::uuid, 2, 'READY_FOR_PUBLICATION', false),
      ('event-f91a0e775887c720bb2bee5363ce6f26', '0327c9a0-1b2b-49a9-b814-351c6ff53b51'::uuid, 1, 'READY_FOR_PUBLICATION', false),
      (v_incident_event_key, v_incident_prior_run_id, 1, 'READY_FOR_PUBLICATION', false)
    ) as expected(event_key, pipeline_run_id, attempt_number, final_state, counts_toward_retry_limit)
    join public.pipeline_event_attempts as actual
      on actual.event_key = expected.event_key
     and actual.pipeline_run_id = expected.pipeline_run_id
     and actual.attempt_number = expected.attempt_number
     and actual.final_state = expected.final_state
     and actual.counts_toward_retry_limit = expected.counts_toward_retry_limit
     and actual.completed_at is not null
     and actual.purpose = 'NORMAL'
     and actual.pilot_attempt_number is null;
    if v_pilot_matches <> 4 then
      return jsonb_build_object('status', 'BLOCKED', 'reason', 'PILOT_BASELINE_CHANGED');
    end if;
  end if;

  select * into v_prior_attempt
    from public.pipeline_event_attempts
   where id = p_prior_attempt_id and event_key = p_event_key
     and final_state = 'READY_FOR_PUBLICATION'
     and completed_at is not null
     and counts_toward_retry_limit = false
     and purpose = 'NORMAL'
   for update;
  if v_prior_attempt.id is null then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'PRIOR_TERMINAL_ATTEMPT_CHANGED');
  end if;
  if exists (
    select 1 from public.pipeline_event_attempts
     where event_key = p_event_key and attempt_number > v_prior_attempt.attempt_number
  ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'PRIOR_ATTEMPT_NOT_LATEST');
  end if;

  if not exists (
    select 1 from public.events as e
     where e.id = p_event_id and e.event_key = p_event_key
       and e.event_status = 'active' and e.review_status = 'approved'
       and (v_is_incident or e.classification_payload ->> 'validationNamespace' = p_validation_namespace)
  ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'EVENT_IDENTITY_CHANGED');
  end if;
  if not exists (
    select 1 from public.articles as a
     where a.id = p_article_id and a.event_id = p_event_id
       and a.publication_status = 'archived'
       and (not v_is_incident or a.slug = v_incident_article_slug)
       and (v_is_incident or a.metadata ->> 'validationNamespace' = p_validation_namespace)
  ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'ARCHIVED_ARTICLE_IDENTITY_CHANGED');
  end if;
  if (select count(*) from public.event_sources where event_id = p_event_id) <> 1
     or not exists (
       select 1 from public.event_sources as es
        join public.raw_items as r on r.id = es.raw_item_id and r.source_id = es.source_id
        join public.sources as s on s.id = es.source_id
        where es.event_id = p_event_id and es.raw_item_id = p_raw_item_id
          and r.processing_status = 'extracted' and r.extraction_quality = 'full'
          and r.raw_content is not null and length(r.raw_content) > 0
          and r.content_hash is not null and length(trim(r.content_hash)) > 0
          and (v_is_incident or r.normalized_payload ->> 'validationNamespace' = p_validation_namespace)
          and (v_is_incident or s.metadata ->> 'validationNamespace' = p_validation_namespace)
     ) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'RAW_LINEAGE_CHANGED');
  end if;
  select r.source_id into v_source_id
    from public.raw_items as r where r.id = p_raw_item_id;
  if v_is_incident then
    if p_prior_attempt_id is distinct from (
         select id from public.pipeline_event_attempts
          where event_key = v_incident_event_key
            and pipeline_run_id = v_incident_prior_run_id
            and attempt_number = 1
            and purpose = 'NORMAL'
            and final_state = 'READY_FOR_PUBLICATION'
            and completed_at is not null
       )
       or (select count(*) from public.pipeline_event_attempts where event_key = v_incident_event_key) <> 1 then
      return jsonb_build_object('status', 'BLOCKED', 'reason', 'TARGET_ATTEMPT_HISTORY_CHANGED');
    end if;
    if p_raw_item_id is distinct from v_incident_raw_item_id or v_source_id is distinct from v_incident_source_id
       or not exists (
         select 1 from public.raw_items as r where r.id = v_incident_raw_item_id
           and r.external_id = 'e8dd0363-f51e-4381-9fb2-c02ee81f4d41:97a055038b0de18e8e86e495b37445d7'
           and r.content_hash = v_incident_raw_content_hash
       )
       or not exists (
         select 1 from public.sources as s where s.id = v_incident_source_id and s.name = 'TechCrunch AI'
       ) then
      return jsonb_build_object('status', 'BLOCKED', 'reason', 'STORED_EXTRACTION_CHANGED');
    end if;
  end if;

  if exists (select 1 from public.pipeline_event_attempts where event_key = p_event_key and pipeline_run_id = p_pipeline_run_id) then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'PIPELINE_RUN_ALREADY_REGISTERED');
  end if;
  select coalesce(max(attempt_number), 0) + 1 into v_next_attempt_number
    from public.pipeline_event_attempts where event_key = p_event_key;

  insert into public.pipeline_event_attempts (
    event_key, pipeline_run_id, attempt_number, started_at, purpose, start_stage,
    remediation_article_id, remediation_raw_item_id, remediation_prior_attempt_id,
    remediation_reason, authorized_by, authorization_reference, pilot_attempt_number, validation_namespace,
    counts_toward_retry_limit
  ) values (
    p_event_key, p_pipeline_run_id, v_next_attempt_number, v_now, 'FACTUAL_REMEDIATION', p_start_stage,
    p_article_id, p_raw_item_id, v_prior_attempt.id,
    trim(p_reason), trim(p_authorized_by), trim(p_authorization_reference),
    case when v_is_incident then 5 else null end,
    p_validation_namespace,
    false
  ) returning * into v_new_attempt;

  return jsonb_build_object(
    'status', 'ACQUIRED',
    'attempt', jsonb_build_object(
      'id', v_new_attempt.id,
      'event_key', v_new_attempt.event_key,
      'pipeline_run_id', v_new_attempt.pipeline_run_id,
      'attempt_number', v_new_attempt.attempt_number,
      'started_at', v_new_attempt.started_at,
      'completed_at', v_new_attempt.completed_at,
      'final_state', v_new_attempt.final_state,
      'stop_stage', v_new_attempt.stop_stage,
      'stop_reason', v_new_attempt.stop_reason,
      'retry_class', v_new_attempt.retry_class,
      'counts_toward_retry_limit', v_new_attempt.counts_toward_retry_limit,
      'next_eligible_at', v_new_attempt.next_eligible_at,
      'created_at', v_new_attempt.created_at,
      'purpose', v_new_attempt.purpose,
      'start_stage', v_new_attempt.start_stage,
      'remediation_article_id', v_new_attempt.remediation_article_id,
      'remediation_raw_item_id', v_new_attempt.remediation_raw_item_id,
      'remediation_prior_attempt_id', v_new_attempt.remediation_prior_attempt_id,
      'pilot_attempt_number', v_new_attempt.pilot_attempt_number,
      'validation_namespace', v_new_attempt.validation_namespace
    )
  );
end;
$$;

create or replace function public.claim_incident_factual_remediation_attempt(
  p_pipeline_run_id uuid,
  p_authorized_by text,
  p_authorization_reference text,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  v_prior_attempt_id uuid;
begin
  select id into v_prior_attempt_id
    from public.pipeline_event_attempts
   where event_key = 'event-30f226d1b8ba5c9eb8af2b65c46db512'
     and pipeline_run_id = '63b81d9a-e46f-4434-9637-335d3f455e0b'::uuid
     and attempt_number = 1
     and final_state = 'READY_FOR_PUBLICATION'
     and completed_at is not null
     and counts_toward_retry_limit = false
     and purpose = 'NORMAL';
  if v_prior_attempt_id is null then
    return jsonb_build_object('status', 'BLOCKED', 'reason', 'PRIOR_TERMINAL_ATTEMPT_CHANGED');
  end if;
  return public.claim_factual_remediation_attempt(
    p_pipeline_run_id,
    p_authorized_by,
    p_authorization_reference,
    p_reason,
    'event-30f226d1b8ba5c9eb8af2b65c46db512',
    '5138e509-f4c3-4020-9d13-6a6efac99a39'::uuid,
    '756b0ee0-b5e6-4153-846f-278a12c9afe3'::uuid,
    'd3834944-72f6-4f59-9aca-3f66ae92dc33'::uuid,
    v_prior_attempt_id,
    'FACTUAL_REMEDIATION',
    'VERIFIER',
    null
  );
end;
$$;

revoke all on function public.claim_factual_remediation_attempt(uuid, text, text, text, text, uuid, uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_factual_remediation_attempt(uuid, text, text, text, text, uuid, uuid, uuid, uuid, text, text, text) to service_role;
revoke all on function public.claim_incident_factual_remediation_attempt(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_incident_factual_remediation_attempt(uuid, text, text, text) to service_role;

-- The correction must atomically publish into the still-archived row, preserving
-- the article id and slug. A missing/replaced/unarchived row fails closed.
create or replace function public.publish_factual_remediation_article_atomic(
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
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'factual_remediation_service_role_required';
  end if;
  if p_attempt_id is null or p_pipeline_run_id is null or p_article_id is distinct from v_article_id
     or p_expected_slug is distinct from v_slug or jsonb_typeof(p_payload) is distinct from 'object'
     or p_payload->>'eventKey' is distinct from v_event_key
     or p_payload->'article'->>'slug' is distinct from v_slug then
    raise exception using errcode = '22023', message = 'factual_remediation_publication_identity_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_event_key, 0));
  select * into v_attempt from public.pipeline_event_attempts
   where id = p_attempt_id and pipeline_run_id = p_pipeline_run_id for update;
  if v_attempt.id is null or v_attempt.event_key <> v_event_key
     or v_attempt.purpose <> 'FACTUAL_REMEDIATION' or v_attempt.start_stage <> 'VERIFIER'
     or v_attempt.completed_at is not null or v_attempt.remediation_article_id <> v_article_id
     or v_attempt.remediation_raw_item_id <> 'd3834944-72f6-4f59-9aca-3f66ae92dc33'::uuid
     or v_attempt.pilot_attempt_number <> 5 then
    raise exception using errcode = 'P0001', message = 'factual_remediation_attempt_not_owned';
  end if;
  if not exists (
    select 1 from public.pipeline_event_attempts as prior
     where prior.id = v_attempt.remediation_prior_attempt_id
       and prior.event_key = v_event_key and prior.final_state = 'READY_FOR_PUBLICATION'
       and prior.completed_at is not null and prior.purpose = 'NORMAL'
  ) then
    raise exception using errcode = 'P0001', message = 'factual_remediation_prior_attempt_changed';
  end if;
  select * into v_article from public.articles
   where id = v_article_id and event_id = v_event_id and slug = v_slug
     and publication_status = 'archived' for update;
  if v_article.id is null then
    raise exception using errcode = 'P0001', message = 'factual_remediation_article_not_archived';
  end if;

  v_result := public.publish_article_atomic(p_payload);

  select * into v_article from public.articles
   where id = v_article_id and event_id = v_event_id and slug = v_slug
     and publication_status = 'published';
  if v_article.id is null then
    raise exception using errcode = 'P0001', message = 'factual_remediation_article_identity_not_preserved';
  end if;
  return v_result || jsonb_build_object(
    'factualRemediation', jsonb_build_object('attemptId', p_attempt_id, 'articleId', v_article_id, 'slug', v_slug)
  );
end;
$$;

revoke all on function public.publish_factual_remediation_article_atomic(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.publish_factual_remediation_article_atomic(uuid, uuid, uuid, text, jsonb) to service_role;

commit;
