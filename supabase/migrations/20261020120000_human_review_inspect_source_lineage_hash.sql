-- M37: restore the required durable source-lineage hash in M32 inspect.
-- Read-only projection only; status/list, rows and table privileges are unchanged.
begin;

create or replace function public.get_pipeline_human_review_operator_inspect(p_review_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_review jsonb;
  v_published_today bigint;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'human_review_operator_read_forbidden';
  end if;
  if p_review_id is null then
    raise exception using errcode = '22023', message = 'human_review_operator_review_id_required';
  end if;

  select jsonb_build_object(
    'id', r.id,
    'eventId', r.event_key,
    'event_key', r.event_key,
    'attempt_id', r.attempt_id,
    'pipeline_run_id', r.pipeline_run_id,
    'draft_id', r.draft_id,
    'draft_sha256', r.draft_sha256,
    'source_lineage_sha256', r.source_lineage_sha256,
    'publication_payload_sha256', r.publication_payload_sha256,
    'source_lineage', r.source_lineage,
    'review_manifest', r.review_manifest,
    'critic_pass', r.critic_pass,
    'provider_usage_settled', r.provider_usage_settled,
    'status', r.status,
    'action', case r.status
      when 'APPROVED' then 'APPROVE'
      when 'PUBLISHING' then 'APPROVE'
      when 'PUBLISHED' then 'APPROVE'
      when 'HOLD' then 'HOLD'
      when 'REJECTED' then 'REJECT'
      else null
    end,
    'reviewer_id', r.reviewer_id,
    'reviewer_approved', r.reviewer_approved,
    'facts_acceptable', r.facts_acceptable,
    'attribution_acceptable', r.attribution_acceptable,
    'uncertainty_preserved', r.uncertainty_preserved,
    'headline_acceptable', r.headline_acceptable,
    'summary_acceptable', r.summary_acceptable,
    'no_unsupported_material_claims', r.no_unsupported_material_claims,
    'source_chain_acceptable', r.source_chain_acceptable,
    'reviewed_at', r.reviewed_at,
    'consumed_at', r.consumed_at,
    'published_article_id', r.published_article_id,
    'decision_history', r.decision_history,
    'created_at', r.created_at,
    'updated_at', r.updated_at
  ) into v_review
    from public.pipeline_human_reviews as r
   where r.id = p_review_id;

  select count(*) into v_published_today
    from public.pipeline_human_reviews
   where status = 'PUBLISHED'
     and updated_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';

  return jsonb_build_object(
    'found', v_review is not null,
    'review', v_review,
    'publishedToday', v_published_today
  );
end;
$function$;

revoke all on function public.get_pipeline_human_review_operator_inspect(uuid) from public, anon, authenticated;
grant execute on function public.get_pipeline_human_review_operator_inspect(uuid) to service_role;

commit;
