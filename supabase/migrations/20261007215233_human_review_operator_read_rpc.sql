-- 12F.2e: trusted server-side, read-only operator access to private review state.
-- The table remains inaccessible through direct table privileges; only these
-- bounded SECURITY DEFINER read RPCs are executable by service_role.
begin;

create function public.get_pipeline_human_review_operator_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_utc_start timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'human_review_operator_read_forbidden';
  end if;

  return jsonb_build_object(
    'utcDay', to_char(now() at time zone 'UTC', 'YYYY-MM-DD'),
    'asOfUtc', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'totalReviews', (select count(*) from public.pipeline_human_reviews),
    'waitingReviews', (select count(*) from public.pipeline_human_reviews where status = 'WAITING_FOR_HUMAN_REVIEW'),
    'holdReviews', (select count(*) from public.pipeline_human_reviews where status = 'HOLD'),
    'rejectedReviews', (select count(*) from public.pipeline_human_reviews where status = 'REJECTED'),
    'approvedReviews', (select count(*) from public.pipeline_human_reviews where status = 'APPROVED'),
    'approveReviews', (select count(*) from public.pipeline_human_reviews where status in ('APPROVED', 'PUBLISHING', 'PUBLISHED')),
    'publishingReviews', (select count(*) from public.pipeline_human_reviews where status = 'PUBLISHING'),
    'publishedReviews', (select count(*) from public.pipeline_human_reviews where status = 'PUBLISHED'),
    'consumedReviews', (select count(*) from public.pipeline_human_reviews where consumed_at is not null),
    'candidatesToday', (select count(distinct event_key) from public.pipeline_event_attempts where started_at >= v_utc_start and purpose = 'NORMAL'),
    'attemptsToday', (select count(*) from public.pipeline_event_attempts where started_at >= v_utc_start),
    'awaitingReview', (select count(*) from public.pipeline_human_reviews where status = 'WAITING_FOR_HUMAN_REVIEW'),
    'held', (select count(*) from public.pipeline_human_reviews where status = 'HOLD'),
    'rejected', (select count(*) from public.pipeline_human_reviews where status = 'REJECTED'),
    'approved', (select count(*) from public.pipeline_human_reviews where status = 'APPROVED'),
    'consumed', (select count(*) from public.pipeline_human_reviews where consumed_at is not null),
    'publishedToday', (select count(*) from public.pipeline_human_reviews where status = 'PUBLISHED' and updated_at >= v_utc_start),
    'failedToday', (select count(*) from public.pipeline_event_attempts where started_at >= v_utc_start and final_state in ('TECHNICAL_FAILURE', 'PROVIDER_RATE_LIMIT', 'ABORTED')),
    'groqRequests', (select count(*) from public.agent_logs where step = 'provider_request_reserved' and created_at >= v_utc_start and coalesce(provider, payload->>'provider') = 'groq' and payload->>'providerRequestDispatched' = 'true'),
    'groqTokens', (select coalesce(sum(provider_unit_amount), 0) from public.agent_logs where step = 'provider_request_reserved' and created_at >= v_utc_start and coalesce(provider, payload->>'provider') = 'groq' and payload->>'providerRequestDispatched' = 'true' and provider_unit = 'tokens' and payload->>'tokenUsageState' = 'settled'),
    'groqUnknownUsage', (select count(*) from public.agent_logs where step = 'provider_request_reserved' and created_at >= v_utc_start and coalesce(provider, payload->>'provider') = 'groq' and payload->>'providerRequestDispatched' = 'true' and (provider_unit is distinct from 'tokens' or payload->>'tokenUsageState' is distinct from 'settled')),
    'activeWork', (select count(*) from public.pipeline_event_attempts where completed_at is null),
    'stuckWork', (select count(*) from public.pipeline_event_attempts where completed_at is null and started_at < now() - interval '1 hour')
  );
end;
$function$;

create function public.list_pipeline_human_reviews_operator(p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_published_today bigint;
  v_reviews jsonb;
  v_returned integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'human_review_operator_read_forbidden';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = '22023', message = 'human_review_operator_limit_invalid';
  end if;

  select count(*) into v_published_today
    from public.pipeline_human_reviews
   where status = 'PUBLISHED'
     and updated_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC';

  select count(*)::integer into v_returned
    from (
      select r.id
        from public.pipeline_human_reviews as r
       order by r.created_at desc, r.id desc
       limit p_limit
    ) as bounded_reviews;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', review_row.id,
        'eventId', review_row.event_key,
        'event_key', review_row.event_key,
        'attempt_id', review_row.attempt_id,
        'pipeline_run_id', review_row.pipeline_run_id,
        'draft_id', review_row.draft_id,
        'draft_sha256', review_row.draft_sha256,
        'source_lineage_sha256', review_row.source_lineage_sha256,
        'publication_payload_sha256', review_row.publication_payload_sha256,
        'review_manifest', review_row.review_manifest,
        'critic_pass', review_row.critic_pass,
        'provider_usage_settled', review_row.provider_usage_settled,
        'status', review_row.status,
        'action', case review_row.status
          when 'APPROVED' then 'APPROVE'
          when 'PUBLISHING' then 'APPROVE'
          when 'PUBLISHED' then 'APPROVE'
          when 'HOLD' then 'HOLD'
          when 'REJECTED' then 'REJECT'
          else null
        end,
        'reviewer_approved', review_row.reviewer_approved,
        'facts_acceptable', review_row.facts_acceptable,
        'attribution_acceptable', review_row.attribution_acceptable,
        'reviewed_at', review_row.reviewed_at,
        'consumed_at', review_row.consumed_at,
        'published_article_id', review_row.published_article_id,
        'created_at', review_row.created_at,
        'updated_at', review_row.updated_at
      ) order by review_row.created_at desc, review_row.id desc
    ), '[]'::jsonb
  ) into v_reviews
    from (
      select r.id, r.event_key, r.attempt_id, r.pipeline_run_id, r.draft_id,
             r.draft_sha256, r.source_lineage_sha256, r.publication_payload_sha256,
             r.review_manifest, r.critic_pass, r.provider_usage_settled, r.status,
             r.reviewer_approved, r.facts_acceptable, r.attribution_acceptable,
             r.reviewed_at, r.consumed_at, r.published_article_id,
             r.created_at, r.updated_at
        from public.pipeline_human_reviews as r
       order by r.created_at desc, r.id desc
       limit p_limit
    ) as review_row;

  return jsonb_build_object(
    'reviews', v_reviews,
    'publishedToday', v_published_today,
    'returned', v_returned,
    'limit', p_limit
  );
end;
$function$;

create function public.get_pipeline_human_review_operator_inspect(p_review_id uuid)
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

revoke all on function public.get_pipeline_human_review_operator_status() from public, anon, authenticated, service_role;
revoke all on function public.list_pipeline_human_reviews_operator(integer) from public, anon, authenticated, service_role;
revoke all on function public.get_pipeline_human_review_operator_inspect(uuid) from public, anon, authenticated, service_role;

grant execute on function public.get_pipeline_human_review_operator_status() to service_role;
grant execute on function public.list_pipeline_human_reviews_operator(integer) to service_role;
grant execute on function public.get_pipeline_human_review_operator_inspect(uuid) to service_role;

comment on function public.get_pipeline_human_review_operator_status() is
  'Read-only aggregate operator status for human reviews; service_role only; does not grant table SELECT.';
comment on function public.list_pipeline_human_reviews_operator(integer) is
  'Bounded read-only operator review list; at most 500 rows; service_role only; omits editorial/source bodies.';
comment on function public.get_pipeline_human_review_operator_inspect(uuid) is
  'Read-only operator lookup for one review row; detailed review package is verified from the server-side immutable artifact; service_role only.';

commit;
