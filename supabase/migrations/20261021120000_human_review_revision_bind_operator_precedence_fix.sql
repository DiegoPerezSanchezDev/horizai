-- M39: preserve M38's revision-binding contract while grouping JSONB subtraction
-- after JSON navigation. PostgreSQL gives binary +/- higher precedence than ->.
begin;

create or replace function public.bind_pipeline_human_review_revision(
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
     or ((p_corrected_publication_payload->'article') - 'slug'::text) is distinct from p_corrected_draft
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

revoke all on function public.bind_pipeline_human_review_revision(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.bind_pipeline_human_review_revision(uuid, text, jsonb, jsonb, jsonb, jsonb, jsonb, text, jsonb) to service_role;

commit;
