-- M38: bind a separately attested human revision to the existing WAITING review.
-- The model draft, review identity, source lineage and M34 proof remain intact.
begin;

alter table public.pipeline_human_reviews
  add column approval_target_kind text not null default 'ORIGINAL'
    check (approval_target_kind in ('ORIGINAL', 'HUMAN_REVISION')),
  add column approval_target_revision_id uuid,
  add column approval_target_revision_sha256 text,
  add column approved_revision_sha256 text;

create table public.pipeline_human_review_revisions (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null unique references public.pipeline_human_reviews(id) on delete restrict,
  revision_version integer not null default 1 check (revision_version = 1),
  attempt_id uuid not null,
  pipeline_run_id uuid not null,
  original_draft jsonb not null check (jsonb_typeof(original_draft) = 'object'),
  original_publication_payload jsonb not null check (jsonb_typeof(original_publication_payload) = 'object'),
  corrected_draft jsonb not null check (jsonb_typeof(corrected_draft) = 'object'),
  corrected_publication_payload jsonb not null check (jsonb_typeof(corrected_publication_payload) = 'object'),
  original_draft_sha256 text not null check (original_draft_sha256 ~ '^[a-f0-9]{64}$'),
  corrected_revision_sha256 text not null check (corrected_revision_sha256 ~ '^[a-f0-9]{64}$'),
  source_lineage_sha256 text not null check (source_lineage_sha256 ~ '^[a-f0-9]{64}$'),
  automated_critic_draft_sha256 text not null check (automated_critic_draft_sha256 ~ '^[a-f0-9]{64}$'),
  human_revision_proof jsonb not null check (
    jsonb_typeof(human_revision_proof) = 'object'
    and human_revision_proof->>'schemaVersion' = '1'
    and human_revision_proof->>'status' = 'PASS'
    and human_revision_proof->>'actorClass' = 'HUMAN_OPERATOR'
    and human_revision_proof->>'automatedCriticScope' = 'ORIGINAL_DRAFT_ONLY'
    and human_revision_proof->>'humanAttestation' = 'FACTUAL_ATTRIBUTION_ORIGINALITY_SOURCE_LINEAGE_PASS'
    and coalesce(human_revision_proof->>'correctedRevisionSha256', '') ~ '^[a-f0-9]{64}$'
    and coalesce(human_revision_proof->>'originalDraftSha256', '') ~ '^[a-f0-9]{64}$'
    and coalesce(human_revision_proof->>'sourceLineageSha256', '') ~ '^[a-f0-9]{64}$'
    and coalesce(human_revision_proof->>'auditSha256', '') ~ '^[a-f0-9]{64}$'
    and nullif(trim(human_revision_proof->>'auditedAt'), '') is not null
  ),
  created_at timestamptz not null default clock_timestamp(),
  constraint pipeline_human_review_revisions_identity_check check (
    human_revision_proof->>'correctedRevisionSha256' is not distinct from corrected_revision_sha256
    and human_revision_proof->>'originalDraftSha256' is not distinct from original_draft_sha256
    and human_revision_proof->>'sourceLineageSha256' is not distinct from source_lineage_sha256
    and automated_critic_draft_sha256 is not distinct from original_draft_sha256
  )
);

alter table public.pipeline_human_review_revisions enable row level security;
revoke all on table public.pipeline_human_review_revisions from public, anon, authenticated, service_role;
alter table public.pipeline_human_reviews
  add constraint pipeline_human_reviews_revision_target_fk
    foreign key (approval_target_revision_id) references public.pipeline_human_review_revisions(id) on delete restrict,
  add constraint pipeline_human_reviews_revision_target_check check (
    (approval_target_kind = 'ORIGINAL' and approval_target_revision_id is null
      and approval_target_revision_sha256 is null and approved_revision_sha256 is null)
    or (approval_target_kind = 'HUMAN_REVISION' and approval_target_revision_id is not null
      and approval_target_revision_sha256 is not null and approval_target_revision_sha256 ~ '^[a-f0-9]{64}$'
      and ((status in ('APPROVED', 'PUBLISHING', 'PUBLISHED') and approved_revision_sha256 = approval_target_revision_sha256)
        or (status in ('WAITING_FOR_HUMAN_REVIEW', 'HOLD', 'REJECTED') and approved_revision_sha256 is null)))
  );

create function public.prevent_pipeline_human_review_revision_mutation()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $function$
begin
  raise exception using errcode = 'P0001', message = 'human_review_revision_immutable';
end;
$function$;
create trigger pipeline_human_review_revisions_immutable before update or delete on public.pipeline_human_review_revisions
for each row execute function public.prevent_pipeline_human_review_revision_mutation();

create function public.guard_pipeline_human_review_revision_target()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if old.approval_target_kind = 'HUMAN_REVISION' and (
    new.approval_target_kind is distinct from old.approval_target_kind
    or new.approval_target_revision_id is distinct from old.approval_target_revision_id
    or new.approval_target_revision_sha256 is distinct from old.approval_target_revision_sha256
  ) then raise exception using errcode = 'P0001', message = 'human_review_approval_target_immutable'; end if;
  if old.approval_target_kind = 'ORIGINAL' and new.approval_target_kind = 'HUMAN_REVISION'
     and not exists (select 1 from public.pipeline_human_review_revisions as revision
       where revision.id = new.approval_target_revision_id and revision.review_id = new.id
         and revision.corrected_revision_sha256 = new.approval_target_revision_sha256
         and revision.attempt_id = new.attempt_id and revision.pipeline_run_id = new.pipeline_run_id
         and revision.original_draft_sha256 = new.draft_sha256 and revision.source_lineage_sha256 = new.source_lineage_sha256)
  then raise exception using errcode = 'P0001', message = 'human_review_revision_target_invalid'; end if;
  return new;
end;
$function$;
create trigger pipeline_human_reviews_revision_target_guard before update on public.pipeline_human_reviews
for each row execute function public.guard_pipeline_human_review_revision_target();

create function public.pipeline_canonical_jsonb_text(p_value jsonb)
returns text language plpgsql immutable strict set search_path = pg_catalog, public, pg_temp
as $function$
declare v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || public.pipeline_canonical_jsonb_text(value), ',' order by key), '') || '}'
        into v_result from jsonb_each(p_value);
      return v_result;
    when 'array' then
      select '[' || coalesce(string_agg(public.pipeline_canonical_jsonb_text(value), ',' order by ordinality), '') || ']'
        into v_result from jsonb_array_elements(p_value) with ordinality as item(value, ordinality);
      return v_result;
    else return p_value::text;
  end case;
end;
$function$;

create function public.bind_pipeline_human_review_revision(
  p_review_id uuid, p_expected_original_draft_sha256 text, p_original_draft jsonb,
  p_original_publication_payload jsonb, p_corrected_draft jsonb, p_corrected_publication_payload jsonb,
  p_source_lineage jsonb, p_corrected_revision_sha256 text, p_human_revision_proof jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_review public.pipeline_human_reviews%rowtype;
  v_existing public.pipeline_human_review_revisions%rowtype;
  v_id uuid;
  v_source_lineage_sha256 text;
  v_original_payload_sha256 text;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'human_review_service_role_required'; end if;
  if p_review_id is null or p_expected_original_draft_sha256 is null or p_expected_original_draft_sha256 !~ '^[a-f0-9]{64}$'
     or p_corrected_revision_sha256 is null or p_corrected_revision_sha256 !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_original_draft) is distinct from 'object'
     or jsonb_typeof(p_original_publication_payload) is distinct from 'object'
     or jsonb_typeof(p_corrected_draft) is distinct from 'object'
     or jsonb_typeof(p_corrected_publication_payload) is distinct from 'object'
     or jsonb_typeof(p_source_lineage) is distinct from 'array'
     or jsonb_typeof(p_human_revision_proof) is distinct from 'object'
  then raise exception using errcode = '22023', message = 'human_review_revision_input_invalid'; end if;
  select * into v_review from public.pipeline_human_reviews where id = p_review_id for update;
  if v_review.id is null then raise exception using errcode = 'P0001', message = 'human_review_not_found'; end if;
  v_source_lineage_sha256 := encode(extensions.digest(convert_to(p_source_lineage::text, 'UTF8'), 'sha256'), 'hex');
  v_original_payload_sha256 := encode(extensions.digest(convert_to(p_original_publication_payload::text, 'UTF8'), 'sha256'), 'hex');
  if p_expected_original_draft_sha256 is distinct from v_review.draft_sha256
     or encode(extensions.digest(convert_to(public.pipeline_canonical_jsonb_text(p_original_draft), 'UTF8'), 'sha256'), 'hex') is distinct from v_review.draft_sha256
     or encode(extensions.digest(convert_to(public.pipeline_canonical_jsonb_text(p_corrected_draft), 'UTF8'), 'sha256'), 'hex') is distinct from p_corrected_revision_sha256
     or v_source_lineage_sha256 is distinct from v_review.source_lineage_sha256
     or p_source_lineage is distinct from v_review.source_lineage
     or v_original_payload_sha256 is distinct from v_review.publication_payload_sha256
     or p_original_publication_payload->>'eventKey' is distinct from v_review.event_key
     or p_original_publication_payload->'critic'->>'decision' is distinct from 'pass'
     or p_original_draft is distinct from jsonb_build_object(
       'headlineEs', p_original_publication_payload->'article'->'headlineEs', 'dekEs', p_original_publication_payload->'article'->'dekEs',
       'summaryEs', p_original_publication_payload->'article'->'summaryEs', 'whyItMattersEs', p_original_publication_payload->'article'->'whyItMattersEs',
       'bodyEs', p_original_publication_payload->'article'->'bodyEs', 'keyPoints', p_original_publication_payload->'article'->'keyPoints')
     or p_corrected_publication_payload->>'eventKey' is distinct from v_review.event_key
     or p_corrected_publication_payload->'critic' is distinct from p_original_publication_payload->'critic'
     or (p_corrected_publication_payload - 'article') is distinct from (p_original_publication_payload - 'article')
     or (p_corrected_publication_payload->'article' - 'slug') is distinct from p_corrected_draft
     or p_corrected_publication_payload->'article'->>'slug' is distinct from p_original_publication_payload->'article'->>'slug'
     or p_human_revision_proof->>'status' is distinct from 'PASS'
     or p_human_revision_proof->>'actorClass' is distinct from 'HUMAN_OPERATOR'
     or p_human_revision_proof->>'correctedRevisionSha256' is distinct from p_corrected_revision_sha256
     or p_human_revision_proof->>'originalDraftSha256' is distinct from v_review.draft_sha256
     or p_human_revision_proof->>'sourceLineageSha256' is distinct from v_review.source_lineage_sha256
     or p_human_revision_proof->>'automatedCriticScope' is distinct from 'ORIGINAL_DRAFT_ONLY'
  then raise exception using errcode = 'P0001', message = 'human_review_revision_binding_invalid'; end if;
  select * into v_existing from public.pipeline_human_review_revisions where review_id = p_review_id;
  if v_existing.id is not null then
    if v_existing.original_draft_sha256 is distinct from v_review.draft_sha256
       or v_existing.corrected_revision_sha256 is distinct from p_corrected_revision_sha256
       or v_existing.human_revision_proof is distinct from p_human_revision_proof
       or v_existing.source_lineage_sha256 is distinct from v_review.source_lineage_sha256
       or v_existing.corrected_draft is distinct from p_corrected_draft
       or v_existing.corrected_publication_payload is distinct from p_corrected_publication_payload
       or v_review.approval_target_revision_id is distinct from v_existing.id
    then raise exception using errcode = 'P0001', message = 'human_review_revision_conflict'; end if;
    return jsonb_build_object('reviewId', p_review_id, 'revisionId', v_existing.id, 'revisionVersion', v_existing.revision_version,
      'revisionSha256', v_existing.corrected_revision_sha256, 'originalDraftSha256', v_existing.original_draft_sha256,
      'sourceLineageSha256', v_existing.source_lineage_sha256, 'status', v_review.status, 'approvalTargetKind', v_review.approval_target_kind, 'reused', true);
  end if;
  if v_review.status is distinct from 'WAITING_FOR_HUMAN_REVIEW' or v_review.consumed_at is not null
     or v_review.approval_target_kind is distinct from 'ORIGINAL' or v_review.approval_target_revision_id is not null
  then raise exception using errcode = 'P0001', message = 'human_review_revision_not_attachable'; end if;
  insert into public.pipeline_human_review_revisions (
    review_id, attempt_id, pipeline_run_id, original_draft, original_publication_payload,
    corrected_draft, corrected_publication_payload, original_draft_sha256, corrected_revision_sha256,
    source_lineage_sha256, automated_critic_draft_sha256, human_revision_proof
  ) values (p_review_id, v_review.attempt_id, v_review.pipeline_run_id, p_original_draft, p_original_publication_payload,
    p_corrected_draft, p_corrected_publication_payload, v_review.draft_sha256, p_corrected_revision_sha256,
    v_review.source_lineage_sha256, v_review.draft_sha256, p_human_revision_proof) returning id into v_id;
  update public.pipeline_human_reviews set approval_target_kind = 'HUMAN_REVISION', approval_target_revision_id = v_id,
    approval_target_revision_sha256 = p_corrected_revision_sha256, updated_at = clock_timestamp()
   where id = p_review_id and status = 'WAITING_FOR_HUMAN_REVIEW' and consumed_at is null
     and approval_target_kind = 'ORIGINAL' and approval_target_revision_id is null;
  if not found then raise exception using errcode = 'P0001', message = 'human_review_revision_target_conflict'; end if;
  return jsonb_build_object('reviewId', p_review_id, 'revisionId', v_id, 'revisionVersion', 1,
    'revisionSha256', p_corrected_revision_sha256, 'originalDraftSha256', v_review.draft_sha256,
    'sourceLineageSha256', v_review.source_lineage_sha256, 'status', v_review.status,
    'approvalTargetKind', 'HUMAN_REVISION', 'reused', false);
end;
$function$;

create function public.get_pipeline_human_review_revision(p_review_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp
as $function$
declare v_revision public.pipeline_human_review_revisions%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'human_review_operator_read_forbidden'; end if;
  select * into v_revision from public.pipeline_human_review_revisions where review_id = p_review_id;
  return jsonb_build_object('found', v_revision.id is not null, 'revision', case when v_revision.id is null then null else to_jsonb(v_revision) end);
end;
$function$;

create or replace function public.get_pipeline_human_review_operator_inspect(p_review_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public
as $function$
declare v_review jsonb; v_published_today bigint;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'human_review_operator_read_forbidden'; end if;
  if p_review_id is null then raise exception using errcode = '22023', message = 'human_review_operator_review_id_required'; end if;
  select jsonb_build_object(
    'id', r.id, 'eventId', r.event_key, 'event_key', r.event_key, 'attempt_id', r.attempt_id,
    'pipeline_run_id', r.pipeline_run_id, 'draft_id', r.draft_id, 'draft_sha256', r.draft_sha256,
    'source_lineage_sha256', r.source_lineage_sha256, 'publication_payload_sha256', r.publication_payload_sha256,
    'approval_target_kind', r.approval_target_kind, 'approval_target_revision_id', r.approval_target_revision_id,
    'approval_target_revision_sha256', r.approval_target_revision_sha256, 'approved_revision_sha256', r.approved_revision_sha256,
    'source_lineage', r.source_lineage, 'review_manifest', r.review_manifest, 'critic_pass', r.critic_pass,
    'provider_usage_settled', r.provider_usage_settled, 'status', r.status,
    'action', case r.status when 'APPROVED' then 'APPROVE' when 'PUBLISHING' then 'APPROVE' when 'PUBLISHED' then 'APPROVE' when 'HOLD' then 'HOLD' when 'REJECTED' then 'REJECT' else null end,
    'reviewer_id', r.reviewer_id, 'reviewer_approved', r.reviewer_approved, 'facts_acceptable', r.facts_acceptable,
    'attribution_acceptable', r.attribution_acceptable, 'uncertainty_preserved', r.uncertainty_preserved,
    'headline_acceptable', r.headline_acceptable, 'summary_acceptable', r.summary_acceptable,
    'no_unsupported_material_claims', r.no_unsupported_material_claims, 'source_chain_acceptable', r.source_chain_acceptable,
    'reviewed_at', r.reviewed_at, 'consumed_at', r.consumed_at, 'published_article_id', r.published_article_id,
    'decision_history', r.decision_history, 'created_at', r.created_at, 'updated_at', r.updated_at
  ) into v_review from public.pipeline_human_reviews r where r.id = p_review_id;
  select count(*) into v_published_today from public.pipeline_human_reviews
   where status = 'PUBLISHED' and updated_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
  return jsonb_build_object('found', v_review is not null, 'review', v_review, 'publishedToday', v_published_today);
end;
$function$;

create or replace function public.decide_pipeline_human_review(
  p_review_id uuid, p_decision text, p_reviewer_id text, p_facts_acceptable boolean,
  p_attribution_acceptable boolean, p_uncertainty_preserved boolean, p_headline_acceptable boolean,
  p_summary_acceptable boolean, p_no_unsupported_material_claims boolean, p_source_chain_acceptable boolean
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $function$
declare v_review public.pipeline_human_reviews%rowtype; v_status text; v_time timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'human_review_service_role_required'; end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT', 'HOLD') or nullif(trim(p_reviewer_id), '') is null
     or p_facts_acceptable is null or p_attribution_acceptable is null or p_uncertainty_preserved is null
     or p_headline_acceptable is null or p_summary_acceptable is null or p_no_unsupported_material_claims is null or p_source_chain_acceptable is null then
    raise exception using errcode = '22023', message = 'human_review_decision_invalid';
  end if;
  select * into v_review from public.pipeline_human_reviews where id = p_review_id for update;
  if v_review.id is null or v_review.status not in ('WAITING_FOR_HUMAN_REVIEW', 'HOLD') then raise exception using errcode = 'P0001', message = 'human_review_decision_not_allowed'; end if;
  if p_decision = 'APPROVE' and v_review.approval_target_kind = 'HUMAN_REVISION' then raise exception using errcode = 'P0001', message = 'human_review_revision_hash_required'; end if;
  if p_decision = 'APPROVE' and not (p_facts_acceptable and p_attribution_acceptable and p_uncertainty_preserved and p_headline_acceptable and p_summary_acceptable and p_no_unsupported_material_claims and p_source_chain_acceptable and v_review.critic_pass and v_review.provider_usage_settled) then
    raise exception using errcode = 'P0001', message = 'human_review_approval_checks_incomplete';
  end if;
  v_status := case p_decision when 'APPROVE' then 'APPROVED' when 'REJECT' then 'REJECTED' else 'HOLD' end;
  update public.pipeline_human_reviews set status = v_status, reviewer_id = trim(p_reviewer_id), reviewer_approved = (p_decision = 'APPROVE'),
    facts_acceptable = p_facts_acceptable, attribution_acceptable = p_attribution_acceptable, uncertainty_preserved = p_uncertainty_preserved,
    headline_acceptable = p_headline_acceptable, summary_acceptable = p_summary_acceptable,
    no_unsupported_material_claims = p_no_unsupported_material_claims, source_chain_acceptable = p_source_chain_acceptable,
    reviewed_at = v_time, decision_history = decision_history || jsonb_build_array(jsonb_build_object(
      'decision', p_decision, 'reviewerId', trim(p_reviewer_id), 'reviewedAt', v_time, 'factsAcceptable', p_facts_acceptable,
      'attributionAcceptable', p_attribution_acceptable, 'uncertaintyPreserved', p_uncertainty_preserved,
      'headlineAcceptable', p_headline_acceptable, 'summaryAcceptable', p_summary_acceptable,
      'noUnsupportedMaterialClaims', p_no_unsupported_material_claims, 'sourceChainAcceptable', p_source_chain_acceptable
    )), updated_at = v_time where id = p_review_id;
  return jsonb_build_object('reviewId', p_review_id, 'status', v_status, 'reviewedAt', v_time);
end;
$function$;

create function public.decide_pipeline_human_review_revision(
  p_review_id uuid, p_approval_target_revision_sha256 text, p_reviewer_id text,
  p_facts_acceptable boolean, p_attribution_acceptable boolean, p_uncertainty_preserved boolean,
  p_headline_acceptable boolean, p_summary_acceptable boolean,
  p_no_unsupported_material_claims boolean, p_source_chain_acceptable boolean
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $function$
declare v_review public.pipeline_human_reviews%rowtype; v_time timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'human_review_service_role_required'; end if;
  if p_review_id is null or p_approval_target_revision_sha256 is null or p_approval_target_revision_sha256 !~ '^[a-f0-9]{64}$' or nullif(trim(p_reviewer_id), '') is null
     or p_facts_acceptable is null or p_attribution_acceptable is null or p_uncertainty_preserved is null
     or p_headline_acceptable is null or p_summary_acceptable is null or p_no_unsupported_material_claims is null or p_source_chain_acceptable is null then
    raise exception using errcode = '22023', message = 'human_review_revision_decision_invalid';
  end if;
  select * into v_review from public.pipeline_human_reviews where id = p_review_id for update;
  if v_review.id is null or v_review.status not in ('WAITING_FOR_HUMAN_REVIEW', 'HOLD') then raise exception using errcode = 'P0001', message = 'human_review_decision_not_allowed'; end if;
  if v_review.approval_target_kind is distinct from 'HUMAN_REVISION'
     or v_review.approval_target_revision_sha256 is distinct from p_approval_target_revision_sha256
     or v_review.approved_revision_sha256 is not null
     or not exists (select 1 from public.pipeline_human_review_revisions r where r.id = v_review.approval_target_revision_id and r.review_id = v_review.id and r.corrected_revision_sha256 = p_approval_target_revision_sha256)
     or not (p_facts_acceptable and p_attribution_acceptable and p_uncertainty_preserved and p_headline_acceptable and p_summary_acceptable and p_no_unsupported_material_claims and p_source_chain_acceptable and v_review.critic_pass and v_review.provider_usage_settled) then
    raise exception using errcode = 'P0001', message = 'human_review_revision_approval_missing_or_stale';
  end if;
  update public.pipeline_human_reviews set status = 'APPROVED', reviewer_id = trim(p_reviewer_id), reviewer_approved = true,
    facts_acceptable = p_facts_acceptable, attribution_acceptable = p_attribution_acceptable, uncertainty_preserved = p_uncertainty_preserved,
    headline_acceptable = p_headline_acceptable, summary_acceptable = p_summary_acceptable,
    no_unsupported_material_claims = p_no_unsupported_material_claims, source_chain_acceptable = p_source_chain_acceptable,
    approved_revision_sha256 = p_approval_target_revision_sha256, reviewed_at = v_time,
    decision_history = decision_history || jsonb_build_array(jsonb_build_object(
      'decision', 'APPROVE', 'reviewerId', trim(p_reviewer_id), 'reviewedAt', v_time,
      'approvalTargetKind', 'HUMAN_REVISION', 'approvalTargetRevisionSha256', p_approval_target_revision_sha256,
      'factsAcceptable', p_facts_acceptable, 'attributionAcceptable', p_attribution_acceptable,
      'uncertaintyPreserved', p_uncertainty_preserved, 'headlineAcceptable', p_headline_acceptable,
      'summaryAcceptable', p_summary_acceptable, 'noUnsupportedMaterialClaims', p_no_unsupported_material_claims,
      'sourceChainAcceptable', p_source_chain_acceptable
    )), updated_at = v_time where id = p_review_id;
  return jsonb_build_object('reviewId', p_review_id, 'status', 'APPROVED', 'approvedRevisionSha256', p_approval_target_revision_sha256, 'reviewedAt', v_time);
end;
$function$;

create or replace function public.publish_reviewed_article_atomic(
  p_review_id uuid, p_event_key text, p_attempt_id uuid, p_pipeline_run_id uuid,
  p_draft_id text, p_draft_sha256 text, p_checkpoint_hashes jsonb,
  p_source_lineage jsonb, p_publication_payload jsonb
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $function$
declare
  v_review public.pipeline_human_reviews%rowtype;
  v_revision public.pipeline_human_review_revisions%rowtype;
  v_attempt public.pipeline_event_attempts%rowtype;
  v_result jsonb;
  v_article_id uuid;
  v_publication_payload_sha256 text;
  v_source_lineage_sha256 text;
begin
  if auth.role() is distinct from 'service_role' then raise exception using errcode = '42501', message = 'human_review_service_role_required'; end if;
  v_publication_payload_sha256 := encode(extensions.digest(convert_to(p_publication_payload::text, 'UTF8'), 'sha256'), 'hex');
  v_source_lineage_sha256 := encode(extensions.digest(convert_to(p_source_lineage::text, 'UTF8'), 'sha256'), 'hex');
  select * into v_review from public.pipeline_human_reviews where id = p_review_id for update;
  if v_review.id is null then raise exception using errcode = 'P0001', message = 'HUMAN_APPROVAL_REQUIRED'; end if;
  if v_review.status = 'HOLD' then raise exception using errcode = 'P0001', message = 'human_review_held'; end if;
  if v_review.status = 'REJECTED' then raise exception using errcode = 'P0001', message = 'human_review_rejected'; end if;
  if v_review.status is distinct from 'APPROVED' then raise exception using errcode = 'P0001', message = 'HUMAN_APPROVAL_REQUIRED'; end if;
  if v_review.approval_target_kind = 'HUMAN_REVISION' then
    select * into v_revision from public.pipeline_human_review_revisions
     where id = v_review.approval_target_revision_id and review_id = v_review.id for update;
  end if;
  if v_review.reviewer_approved is distinct from true
     or v_review.facts_acceptable is distinct from true or v_review.attribution_acceptable is distinct from true
     or v_review.uncertainty_preserved is distinct from true or v_review.headline_acceptable is distinct from true
     or v_review.summary_acceptable is distinct from true or v_review.no_unsupported_material_claims is distinct from true
     or v_review.source_chain_acceptable is distinct from true or v_review.critic_pass is distinct from true
     or v_review.provider_usage_settled is distinct from true
     or p_event_key is distinct from v_review.event_key or p_attempt_id is distinct from v_review.attempt_id
     or p_pipeline_run_id is distinct from v_review.pipeline_run_id or p_draft_id is distinct from v_review.draft_id
     or p_draft_sha256 is distinct from v_review.draft_sha256
     or p_checkpoint_hashes is distinct from v_review.review_manifest->'checkpoints'
     or p_source_lineage is distinct from v_review.source_lineage
     or v_source_lineage_sha256 is distinct from v_review.source_lineage_sha256
     or p_publication_payload->>'eventKey' is distinct from v_review.event_key
     or p_publication_payload->'critic'->>'decision' is distinct from 'pass'
     or (v_review.approval_target_kind = 'ORIGINAL' and v_publication_payload_sha256 is distinct from v_review.publication_payload_sha256)
     or (v_review.approval_target_kind = 'HUMAN_REVISION' and (
       v_revision.id is null or v_revision.corrected_revision_sha256 is distinct from v_review.approval_target_revision_sha256
       or v_review.approved_revision_sha256 is distinct from v_review.approval_target_revision_sha256
       or v_revision.original_draft_sha256 is distinct from v_review.draft_sha256
       or v_revision.automated_critic_draft_sha256 is distinct from v_review.draft_sha256
       or v_revision.source_lineage_sha256 is distinct from v_review.source_lineage_sha256
       or encode(extensions.digest(convert_to(v_revision.original_publication_payload::text, 'UTF8'), 'sha256'), 'hex') is distinct from v_review.publication_payload_sha256
       or p_publication_payload is distinct from v_revision.corrected_publication_payload
     )) then
    raise exception using errcode = 'P0001', message = 'human_review_approval_missing_or_stale';
  end if;
  perform public.assert_pipeline_human_review_source_lineage(p_source_lineage);
  perform public.assert_pipeline_human_review_evidence(v_review.event_key, v_review.pipeline_run_id);
  select * into v_attempt from public.pipeline_event_attempts where id = v_review.attempt_id for update;
  if v_attempt.id is null or v_attempt.event_key is distinct from v_review.event_key
     or v_attempt.pipeline_run_id is distinct from v_review.pipeline_run_id
     or v_attempt.final_state is distinct from 'WAITING_FOR_HUMAN_REVIEW'
     or v_attempt.stop_stage is distinct from 'human_review' then
    raise exception using errcode = 'P0001', message = 'human_review_attempt_or_lineage_changed';
  end if;
  update public.pipeline_human_reviews set status = 'PUBLISHING', consumed_at = clock_timestamp(), updated_at = clock_timestamp()
   where id = p_review_id and status = 'APPROVED' and consumed_at is null;
  if not found then raise exception using errcode = 'P0001', message = 'human_review_approval_already_consumed'; end if;
  v_result := public.publish_article_atomic(p_publication_payload);
  v_article_id := nullif(v_result->>'articleId', '')::uuid;
  if v_article_id is null or not exists (select 1 from public.articles a where a.id = v_article_id
    and a.publication_status = 'published' and a.slug = p_publication_payload->'article'->>'slug') then
    raise exception using errcode = 'P0001', message = 'human_review_publication_identity_invalid';
  end if;
  update public.pipeline_event_attempts set final_state = 'READY_FOR_PUBLICATION', stop_stage = 'publisher', stop_reason = null,
    retry_class = 'NONE', counts_toward_retry_limit = false, next_eligible_at = null
   where id = v_review.attempt_id and pipeline_run_id = v_review.pipeline_run_id and final_state = 'WAITING_FOR_HUMAN_REVIEW';
  if not found then raise exception using errcode = 'P0001', message = 'human_review_attempt_finalize_conflict'; end if;
  update public.pipeline_human_reviews set status = 'PUBLISHED', published_article_id = v_article_id, updated_at = clock_timestamp() where id = p_review_id;
  return v_result || jsonb_build_object('humanReviewId', p_review_id, 'humanReviewStatus', 'PUBLISHED',
    'approvalTargetKind', v_review.approval_target_kind,
    'approvedRevisionSha256', case when v_review.approval_target_kind = 'HUMAN_REVISION' then v_review.approved_revision_sha256 else null end);
end;
$function$;

revoke all on function public.prevent_pipeline_human_review_revision_mutation() from public, anon, authenticated, service_role;
revoke all on function public.guard_pipeline_human_review_revision_target() from public, anon, authenticated, service_role;
revoke all on function public.pipeline_canonical_jsonb_text(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.bind_pipeline_human_review_revision(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.get_pipeline_human_review_revision(uuid) from public, anon, authenticated, service_role;
revoke all on function public.get_pipeline_human_review_operator_inspect(uuid) from public, anon, authenticated;
revoke all on function public.decide_pipeline_human_review(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.decide_pipeline_human_review_revision(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.publish_reviewed_article_atomic(uuid, text, uuid, uuid, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bind_pipeline_human_review_revision(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.get_pipeline_human_review_revision(uuid) to service_role;
grant execute on function public.get_pipeline_human_review_operator_inspect(uuid) to service_role;
grant execute on function public.decide_pipeline_human_review(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to service_role;
grant execute on function public.decide_pipeline_human_review_revision(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to service_role;
grant execute on function public.publish_reviewed_article_atomic(uuid, text, uuid, uuid, text, text, jsonb, jsonb, jsonb) to service_role;
commit;
