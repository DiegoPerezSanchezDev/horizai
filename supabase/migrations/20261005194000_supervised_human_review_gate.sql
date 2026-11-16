-- HorizAI / Fase 12E.1 — durable supervised human-review contract.
-- Stores review identities and hashes, not a second copy of article content.
-- Runtime Publisher integration and supervised scheduler activation remain in 12E.2.
begin;

alter table public.pipeline_event_attempts
  drop constraint if exists pipeline_event_attempts_final_state_check;
alter table public.pipeline_event_attempts
  add constraint pipeline_event_attempts_final_state_check
  check (final_state is null or final_state in (
    'READY_FOR_PUBLICATION', 'WAITING_FOR_HUMAN_REVIEW', 'REVISION_REQUIRED',
    'REJECTED', 'VERIFICATION_INSUFFICIENT', 'TECHNICAL_FAILURE',
    'PROVIDER_RATE_LIMIT', 'CANCELLED', 'ABORTED'
  ));

create unique index if not exists pipeline_event_attempts_one_human_review_waiting_idx
  on public.pipeline_event_attempts (event_key)
  where final_state = 'WAITING_FOR_HUMAN_REVIEW';

create or replace function public.claim_pipeline_event_attempt(
  p_event_key text,
  p_pipeline_run_id uuid,
  p_started_at timestamptz,
  p_now timestamptz,
  p_stale_after_seconds integer default 3600
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare
  active_row public.pipeline_event_attempts%rowtype;
  previous_row public.pipeline_event_attempts%rowtype;
  new_row public.pipeline_event_attempts%rowtype;
  technical_count integer;
begin
  if p_event_key is null or p_event_key = '' or p_pipeline_run_id is null or p_stale_after_seconds <= 0 then raise exception 'invalid event attempt claim'; end if;
  select * into active_row from public.pipeline_event_attempts where event_key = p_event_key and completed_at is null for update;
  if active_row.id is not null then
    if active_row.pipeline_run_id = p_pipeline_run_id then return jsonb_build_object('status','ALREADY_ACTIVE','reason','SAME_PIPELINE_RUN'); end if;
    if active_row.started_at > p_now - (p_stale_after_seconds * interval '1 second') then return jsonb_build_object('status','ALREADY_ACTIVE','reason','ACTIVE_ATTEMPT'); end if;
    update public.pipeline_event_attempts set completed_at = p_now, final_state = 'ABORTED', stop_stage = 'attempt_registry', stop_reason = 'STALE_ATTEMPT_RECOVERED', retry_class = 'TECHNICAL_FAILURE', counts_toward_retry_limit = false, next_eligible_at = p_now where id = active_row.id;
  end if;
  select * into previous_row from public.pipeline_event_attempts where event_key = p_event_key and pipeline_run_id = p_pipeline_run_id limit 1;
  if previous_row.id is not null then return jsonb_build_object('status','ALREADY_REGISTERED','reason','SAME_PIPELINE_RUN'); end if;
  if exists (select 1 from public.pipeline_event_attempts where event_key = p_event_key and final_state in ('READY_FOR_PUBLICATION','WAITING_FOR_HUMAN_REVIEW','REVISION_REQUIRED','REJECTED','VERIFICATION_INSUFFICIENT')) then return jsonb_build_object('status','INELIGIBLE','reason','PERMANENT_OUTCOME'); end if;
  select count(*) into technical_count from public.pipeline_event_attempts where event_key = p_event_key and final_state = 'TECHNICAL_FAILURE' and counts_toward_retry_limit = true;
  if technical_count >= 2 then return jsonb_build_object('status','QUARANTINED','reason','MAX_TECHNICAL_ATTEMPTS'); end if;
  select * into previous_row from public.pipeline_event_attempts where event_key = p_event_key and final_state = 'TECHNICAL_FAILURE' and counts_toward_retry_limit = true order by attempt_number desc limit 1;
  if previous_row.id is not null and previous_row.next_eligible_at is not null and previous_row.next_eligible_at > p_now then return jsonb_build_object('status','COOLDOWN','reason','TECHNICAL_COOLDOWN'); end if;
  insert into public.pipeline_event_attempts (event_key,pipeline_run_id,attempt_number,started_at) select p_event_key,p_pipeline_run_id,coalesce(max(attempt_number),0)+1,p_started_at from public.pipeline_event_attempts where event_key = p_event_key returning * into new_row;
  return jsonb_build_object('status','ACQUIRED','attempt',jsonb_build_object('id',new_row.id,'event_key',new_row.event_key,'pipeline_run_id',new_row.pipeline_run_id,'attempt_number',new_row.attempt_number,'started_at',new_row.started_at,'completed_at',new_row.completed_at,'final_state',new_row.final_state,'stop_stage',new_row.stop_stage,'stop_reason',new_row.stop_reason,'retry_class',new_row.retry_class,'counts_toward_retry_limit',new_row.counts_toward_retry_limit,'next_eligible_at',new_row.next_eligible_at,'created_at',new_row.created_at));
end;
$$;

create or replace function public.finalize_pipeline_event_attempt(
  p_attempt_id uuid,
  p_pipeline_run_id uuid,
  p_completed_at timestamptz,
  p_final_state text,
  p_stop_stage text,
  p_stop_reason text,
  p_retry_class text,
  p_counts_toward_retry_limit boolean,
  p_next_eligible_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public
as $$
begin
  if p_final_state not in ('READY_FOR_PUBLICATION','WAITING_FOR_HUMAN_REVIEW','REVISION_REQUIRED','REJECTED','VERIFICATION_INSUFFICIENT','TECHNICAL_FAILURE','PROVIDER_RATE_LIMIT','CANCELLED','ABORTED') then raise exception 'invalid final state'; end if;
  if p_final_state = 'WAITING_FOR_HUMAN_REVIEW' and (p_stop_stage is distinct from 'human_review' or p_stop_reason is distinct from 'HUMAN_REVIEW_PENDING') then raise exception 'invalid human review finalization'; end if;
  update public.pipeline_event_attempts set completed_at=p_completed_at, final_state=p_final_state, stop_stage=p_stop_stage, stop_reason=p_stop_reason, retry_class=p_retry_class, counts_toward_retry_limit=p_counts_toward_retry_limit, next_eligible_at=p_next_eligible_at where id=p_attempt_id and pipeline_run_id=p_pipeline_run_id and completed_at is null;
  if not found then raise exception 'attempt is not owned or already finalized'; end if;
  return jsonb_build_object('finalized',true);
end;
$$;

revoke all on function public.claim_pipeline_event_attempt(text, uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_pipeline_event_attempt(text, uuid, timestamptz, timestamptz, integer) to service_role;
revoke all on function public.finalize_pipeline_event_attempt(uuid, uuid, timestamptz, text, text, text, text, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.finalize_pipeline_event_attempt(uuid, uuid, timestamptz, text, text, text, text, boolean, timestamptz) to service_role;

create table public.pipeline_human_reviews (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  attempt_id uuid not null unique references public.pipeline_event_attempts(id) on delete restrict,
  pipeline_run_id uuid not null,
  draft_id text not null check (length(trim(draft_id)) > 0),
  draft_sha256 text not null check (draft_sha256 ~ '^[a-f0-9]{64}$'),
  source_lineage jsonb not null check (jsonb_typeof(source_lineage) = 'array' and jsonb_array_length(source_lineage) > 0),
  source_lineage_sha256 text not null check (source_lineage_sha256 ~ '^[a-f0-9]{64}$'),
  publication_payload_sha256 text not null check (publication_payload_sha256 ~ '^[a-f0-9]{64}$'),
  review_manifest jsonb not null,
  critic_pass boolean not null check (critic_pass),
  provider_usage_settled boolean not null check (provider_usage_settled),
  status text not null default 'WAITING_FOR_HUMAN_REVIEW',
  reviewer_id text,
  reviewer_approved boolean,
  facts_acceptable boolean,
  attribution_acceptable boolean,
  uncertainty_preserved boolean,
  headline_acceptable boolean,
  summary_acceptable boolean,
  no_unsupported_material_claims boolean,
  source_chain_acceptable boolean,
  reviewed_at timestamptz,
  consumed_at timestamptz,
  published_article_id uuid references public.articles(id) on delete restrict,
  decision_history jsonb not null default '[]'::jsonb check (jsonb_typeof(decision_history) = 'array'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint pipeline_human_reviews_review_manifest_check check (
    jsonb_typeof(review_manifest) = 'object'
    and review_manifest->>'schemaVersion' = '1'
    and coalesce(review_manifest->>'packageSha256', '') ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(review_manifest->'checkpoints') = 'object'
    and review_manifest->'checkpoints' ?& array['verifier', 'translator', 'editor', 'classifier', 'ranker', 'critic']
    and nullif(trim(review_manifest->'checkpoints'->'verifier'->>'identity'), '') is not null and coalesce(review_manifest->'checkpoints'->'verifier'->>'sha256', '') ~ '^[a-f0-9]{64}$'
    and nullif(trim(review_manifest->'checkpoints'->'translator'->>'identity'), '') is not null and coalesce(review_manifest->'checkpoints'->'translator'->>'sha256', '') ~ '^[a-f0-9]{64}$'
    and nullif(trim(review_manifest->'checkpoints'->'editor'->>'identity'), '') is not null and coalesce(review_manifest->'checkpoints'->'editor'->>'sha256', '') ~ '^[a-f0-9]{64}$'
    and nullif(trim(review_manifest->'checkpoints'->'classifier'->>'identity'), '') is not null and coalesce(review_manifest->'checkpoints'->'classifier'->>'sha256', '') ~ '^[a-f0-9]{64}$'
    and nullif(trim(review_manifest->'checkpoints'->'ranker'->>'identity'), '') is not null and coalesce(review_manifest->'checkpoints'->'ranker'->>'sha256', '') ~ '^[a-f0-9]{64}$'
    and nullif(trim(review_manifest->'checkpoints'->'critic'->>'identity'), '') is not null and coalesce(review_manifest->'checkpoints'->'critic'->>'sha256', '') ~ '^[a-f0-9]{64}$'
  ),
  constraint pipeline_human_reviews_manifest_binding_check check (
    review_manifest->>'eventKey' is not distinct from event_key
    and review_manifest->>'attemptId' is not distinct from attempt_id::text
    and review_manifest->>'pipelineRunId' is not distinct from pipeline_run_id::text
    and review_manifest->>'draftId' is not distinct from draft_id
    and review_manifest->>'draftSha256' is not distinct from draft_sha256
    and review_manifest->>'sourceLineageSha256' is not distinct from source_lineage_sha256
    and review_manifest->>'publicationPayloadSha256' is not distinct from publication_payload_sha256
  ),
  constraint pipeline_human_reviews_status_check check (
    (status = 'WAITING_FOR_HUMAN_REVIEW'
      and reviewer_id is null and reviewer_approved is null and reviewed_at is null
      and consumed_at is null and published_article_id is null)
    or (status in ('APPROVED', 'REJECTED', 'HOLD')
      and reviewer_id is not null and reviewer_approved is not null and reviewed_at is not null
      and facts_acceptable is not null and attribution_acceptable is not null
      and uncertainty_preserved is not null and headline_acceptable is not null
      and summary_acceptable is not null and no_unsupported_material_claims is not null
      and source_chain_acceptable is not null and consumed_at is null and published_article_id is null)
    or (status = 'PUBLISHING'
      and reviewer_id is not null and reviewer_approved is true and reviewed_at is not null
      and facts_acceptable is true and attribution_acceptable is true and uncertainty_preserved is true
      and headline_acceptable is true and summary_acceptable is true
      and no_unsupported_material_claims is true and source_chain_acceptable is true
      and consumed_at is not null and published_article_id is null)
    or (status = 'PUBLISHED'
      and reviewer_id is not null and reviewer_approved is true and reviewed_at is not null
      and facts_acceptable is true and attribution_acceptable is true and uncertainty_preserved is true
      and headline_acceptable is true and summary_acceptable is true
      and no_unsupported_material_claims is true and source_chain_acceptable is true
      and consumed_at is not null and published_article_id is not null)
  )
);

alter table public.pipeline_human_reviews enable row level security;
revoke all on table public.pipeline_human_reviews from public, anon, authenticated, service_role;

create function public.assert_pipeline_human_review_evidence(p_event_key text, p_pipeline_run_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_critic_count integer;
begin
  select count(*) into v_critic_count
    from public.agent_runs ar
   where ar.config->>'agentName' = 'critic'
     and ar.config->>'eventKey' = p_event_key
     and ar.config->>'pipelineRunId' = p_pipeline_run_id::text
     and ar.status = 'succeeded'
     and ar.stats #>> '{telemetry,finalCriticResultValid}' = 'true'
     and ar.stats #>> '{telemetry,deterministicPrechecksPassed}' = 'true'
     and ar.stats #>> '{telemetry,finalDecision}' = 'pass';
  if v_critic_count <> 1 then
    raise exception using errcode = 'P0001', message = 'human_review_critic_pass_not_proven';
  end if;

  if exists (
    select 1
      from public.agent_runs ar
     where ar.config->>'eventKey' = p_event_key
       and ar.config->>'pipelineRunId' = p_pipeline_run_id::text
       and (
         coalesce(ar.stats #>> '{telemetry,providerRequestsUsed}', '') !~ '^[0-9]{1,9}$'
         or (ar.provider is null and ar.stats #>> '{telemetry,providerRequestsUsed}' is distinct from '0')
         or (ar.provider is not null and (
           ar.provider not in ('groq', 'cerebras', 'cloudflare_workers_ai')
           or ar.stats #>> '{telemetry,provider}' is distinct from ar.provider
         ))
       )
  ) then
    raise exception using errcode = 'P0001', message = 'human_review_provider_usage_unknown';
  end if;

  if exists (
    select 1
      from public.agent_runs ar
     where ar.config->>'eventKey' = p_event_key
       and ar.config->>'pipelineRunId' = p_pipeline_run_id::text
       and ar.provider is not null
       and (select count(*) from public.agent_logs l
             where l.run_id = ar.id and l.step = 'provider_request_reserved')
           <> (ar.stats #>> '{telemetry,providerRequestsUsed}')::integer
  ) or exists (
    select 1
      from public.agent_runs ar
      join public.agent_logs l on l.run_id = ar.id and l.step = 'provider_request_reserved'
     where ar.config->>'eventKey' = p_event_key
       and ar.config->>'pipelineRunId' = p_pipeline_run_id::text
       and (
         ar.provider is null
         or
         coalesce(l.provider, l.payload->>'provider', ar.provider) is distinct from ar.provider
         or l.payload->>'providerRequestDispatched' is distinct from 'true'
         or (ar.provider = 'groq' and (
           l.provider_unit is distinct from 'tokens'
           or l.provider_unit_amount is null or l.provider_unit_amount < 1
           or l.payload->>'tokenUsageState' is distinct from 'settled'
           or coalesce(l.payload->>'actualTokens', '') !~ '^[1-9][0-9]*$'
           or l.payload->>'actualTokens' is distinct from l.provider_unit_amount::text
         ))
         or (ar.provider = 'cloudflare_workers_ai' and (
           l.provider_unit is distinct from 'neurons'
           or l.provider_unit_amount is null or l.provider_unit_amount < 1
         ))
         or (ar.provider = 'cerebras' and (
           case
             when coalesce(ar.stats #>> '{telemetry,inputTokens}', '') ~ '^[0-9]{1,18}$'
              and coalesce(ar.stats #>> '{telemetry,outputTokens}', '') ~ '^[0-9]{1,18}$'
              and coalesce(ar.stats #>> '{telemetry,totalTokens}', '') ~ '^[0-9]{1,18}$'
             then (ar.stats #>> '{telemetry,inputTokens}')::numeric
               + (ar.stats #>> '{telemetry,outputTokens}')::numeric
               > (ar.stats #>> '{telemetry,totalTokens}')::numeric
             else true
           end
         ))
       )
  ) then
    raise exception using errcode = 'P0001', message = 'human_review_provider_usage_unsettled';
  end if;
end;
$$;

create function public.assert_pipeline_human_review_source_lineage(p_lineage jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_expected integer;
  v_matched integer;
begin
  if jsonb_typeof(p_lineage) is distinct from 'array' or jsonb_array_length(p_lineage) < 1 then
    raise exception using errcode = 'P0001', message = 'human_review_source_lineage_invalid';
  end if;
  select count(*) into v_expected from jsonb_array_elements(p_lineage);
  select count(*) into v_matched
    from jsonb_array_elements(p_lineage) as items(item)
    join public.raw_items r on r.id::text = item->>'raw_item_id'
    join public.sources s on s.id = r.source_id
   where r.source_id::text = item->>'source_id'
     and r.content_hash is not null
     and r.content_hash is not distinct from item->>'content_hash'
     and coalesce(r.canonical_url, r.original_url) is not distinct from item->>'canonical_url'
     and s.url is not distinct from item->>'source_url'
     and r.extraction_quality = 'full'
     and r.processing_status = 'extracted';
  if v_matched <> v_expected then
    raise exception using errcode = 'P0001', message = 'human_review_source_lineage_changed';
  end if;
end;
$$;

create function public.create_pipeline_human_review(
  p_event_key text,
  p_attempt_id uuid,
  p_pipeline_run_id uuid,
  p_draft_id text,
  p_draft_sha256 text,
  p_source_lineage jsonb,
  p_review_manifest jsonb,
  p_publication_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_attempt public.pipeline_event_attempts%rowtype;
  v_review public.pipeline_human_reviews%rowtype;
  v_finalize_attempt boolean;
  v_publication_payload_sha256 text;
  v_source_lineage_sha256 text;
  v_review_manifest jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'human_review_service_role_required';
  end if;
  v_publication_payload_sha256 := encode(extensions.digest(convert_to(p_publication_payload::text, 'UTF8'), 'sha256'), 'hex');
  v_source_lineage_sha256 := encode(extensions.digest(convert_to(p_source_lineage::text, 'UTF8'), 'sha256'), 'hex');
  if nullif(trim(p_event_key), '') is null or p_attempt_id is null or p_pipeline_run_id is null
     or nullif(trim(p_draft_id), '') is null
     or p_draft_sha256 !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_review_manifest) is distinct from 'object'
     or jsonb_typeof(p_publication_payload) is distinct from 'object'
     or p_publication_payload->>'eventKey' is distinct from p_event_key
     or p_publication_payload->'critic'->>'decision' is distinct from 'pass'
     or p_review_manifest->>'schemaVersion' is distinct from '1'
     or coalesce(p_review_manifest->>'packageSha256', '') !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(p_review_manifest->'checkpoints') is distinct from 'object'
     or v_publication_payload_sha256 is null then
    raise exception using errcode = '22023', message = 'human_review_snapshot_invalid';
  end if;
  select * into v_attempt from public.pipeline_event_attempts
   where id = p_attempt_id for update;
  if v_attempt.id is null or v_attempt.event_key is distinct from p_event_key
     or v_attempt.pipeline_run_id is distinct from p_pipeline_run_id then
    raise exception using errcode = 'P0001', message = 'human_review_attempt_not_waiting';
  end if;
  v_finalize_attempt := v_attempt.completed_at is null and v_attempt.final_state is null;
  if not v_finalize_attempt and (v_attempt.final_state is distinct from 'WAITING_FOR_HUMAN_REVIEW'
     or v_attempt.completed_at is null or v_attempt.stop_stage is distinct from 'human_review'
     or v_attempt.stop_reason is distinct from 'HUMAN_REVIEW_PENDING') then
    raise exception using errcode = 'P0001', message = 'human_review_attempt_not_waiting';
  end if;
  perform public.assert_pipeline_human_review_evidence(p_event_key, p_pipeline_run_id);
  perform public.assert_pipeline_human_review_source_lineage(p_source_lineage);

  v_review_manifest := p_review_manifest || jsonb_build_object(
    'eventKey', p_event_key,
    'attemptId', p_attempt_id::text,
    'pipelineRunId', p_pipeline_run_id::text,
    'draftId', p_draft_id,
    'draftSha256', p_draft_sha256,
    'sourceLineageSha256', v_source_lineage_sha256,
    'publicationPayloadSha256', v_publication_payload_sha256
  );

  if v_finalize_attempt then
    update public.pipeline_event_attempts
       set completed_at = clock_timestamp(), final_state = 'WAITING_FOR_HUMAN_REVIEW',
           stop_stage = 'human_review', stop_reason = 'HUMAN_REVIEW_PENDING',
           retry_class = 'NONE', counts_toward_retry_limit = false, next_eligible_at = null
     where id = p_attempt_id and pipeline_run_id = p_pipeline_run_id and completed_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'human_review_attempt_finalize_conflict';
    end if;
  end if;

  insert into public.pipeline_human_reviews (
    event_key, attempt_id, pipeline_run_id, draft_id, draft_sha256,
    source_lineage, source_lineage_sha256, publication_payload_sha256,
    review_manifest, critic_pass, provider_usage_settled
  ) values (
    p_event_key, p_attempt_id, p_pipeline_run_id, p_draft_id, p_draft_sha256,
    p_source_lineage, v_source_lineage_sha256, v_publication_payload_sha256,
    v_review_manifest, true, true
  ) on conflict (attempt_id) do nothing;

  select * into v_review from public.pipeline_human_reviews where attempt_id = p_attempt_id for update;
  if v_review.id is null or v_review.event_key is distinct from p_event_key
     or v_review.pipeline_run_id is distinct from p_pipeline_run_id
     or v_review.draft_id is distinct from p_draft_id
     or v_review.draft_sha256 is distinct from p_draft_sha256
     or v_review.source_lineage is distinct from p_source_lineage
     or v_review.source_lineage_sha256 is distinct from v_source_lineage_sha256
     or v_review.publication_payload_sha256 is distinct from v_publication_payload_sha256
     or v_review.review_manifest is distinct from v_review_manifest then
    raise exception using errcode = 'P0001', message = 'human_review_snapshot_conflict';
  end if;
  return jsonb_build_object('reviewId', v_review.id, 'status', v_review.status, 'draftSha256', v_review.draft_sha256, 'publicationPayloadSha256', v_review.publication_payload_sha256, 'reviewManifest', v_review.review_manifest);
end;
$$;

create function public.decide_pipeline_human_review(
  p_review_id uuid,
  p_decision text,
  p_reviewer_id text,
  p_facts_acceptable boolean,
  p_attribution_acceptable boolean,
  p_uncertainty_preserved boolean,
  p_headline_acceptable boolean,
  p_summary_acceptable boolean,
  p_no_unsupported_material_claims boolean,
  p_source_chain_acceptable boolean
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_review public.pipeline_human_reviews%rowtype;
  v_status text;
  v_time timestamptz := clock_timestamp();
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'human_review_service_role_required';
  end if;
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT', 'HOLD')
     or nullif(trim(p_reviewer_id), '') is null
     or p_facts_acceptable is null or p_attribution_acceptable is null
     or p_uncertainty_preserved is null or p_headline_acceptable is null
     or p_summary_acceptable is null or p_no_unsupported_material_claims is null
     or p_source_chain_acceptable is null then
    raise exception using errcode = '22023', message = 'human_review_decision_invalid';
  end if;
  select * into v_review from public.pipeline_human_reviews where id = p_review_id for update;
  if v_review.id is null or v_review.status not in ('WAITING_FOR_HUMAN_REVIEW', 'HOLD') then
    raise exception using errcode = 'P0001', message = 'human_review_decision_not_allowed';
  end if;
  if p_decision = 'APPROVE' and not (
    p_facts_acceptable and p_attribution_acceptable and p_uncertainty_preserved
    and p_headline_acceptable and p_summary_acceptable
    and p_no_unsupported_material_claims and p_source_chain_acceptable
    and v_review.critic_pass and v_review.provider_usage_settled
  ) then
    raise exception using errcode = 'P0001', message = 'human_review_approval_checks_incomplete';
  end if;
  v_status := case p_decision when 'APPROVE' then 'APPROVED' when 'REJECT' then 'REJECTED' else 'HOLD' end;
  update public.pipeline_human_reviews
     set status = v_status,
         reviewer_id = trim(p_reviewer_id),
         reviewer_approved = (p_decision = 'APPROVE'),
         facts_acceptable = p_facts_acceptable,
         attribution_acceptable = p_attribution_acceptable,
         uncertainty_preserved = p_uncertainty_preserved,
         headline_acceptable = p_headline_acceptable,
         summary_acceptable = p_summary_acceptable,
         no_unsupported_material_claims = p_no_unsupported_material_claims,
         source_chain_acceptable = p_source_chain_acceptable,
         reviewed_at = v_time,
         decision_history = decision_history || jsonb_build_array(jsonb_build_object(
           'decision', p_decision, 'reviewerId', trim(p_reviewer_id), 'reviewedAt', v_time,
           'factsAcceptable', p_facts_acceptable, 'attributionAcceptable', p_attribution_acceptable,
           'uncertaintyPreserved', p_uncertainty_preserved, 'headlineAcceptable', p_headline_acceptable,
           'summaryAcceptable', p_summary_acceptable, 'noUnsupportedMaterialClaims', p_no_unsupported_material_claims,
           'sourceChainAcceptable', p_source_chain_acceptable
         )),
         updated_at = v_time
   where id = p_review_id;
  return jsonb_build_object('reviewId', p_review_id, 'status', v_status, 'reviewedAt', v_time);
end;
$$;

create function public.publish_reviewed_article_atomic(
  p_review_id uuid,
  p_event_key text,
  p_attempt_id uuid,
  p_pipeline_run_id uuid,
  p_draft_id text,
  p_draft_sha256 text,
  p_checkpoint_hashes jsonb,
  p_source_lineage jsonb,
  p_publication_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_review public.pipeline_human_reviews%rowtype;
  v_attempt public.pipeline_event_attempts%rowtype;
  v_result jsonb;
  v_article_id uuid;
  v_publication_payload_sha256 text;
  v_source_lineage_sha256 text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'human_review_service_role_required';
  end if;
  v_publication_payload_sha256 := encode(extensions.digest(convert_to(p_publication_payload::text, 'UTF8'), 'sha256'), 'hex');
  v_source_lineage_sha256 := encode(extensions.digest(convert_to(p_source_lineage::text, 'UTF8'), 'sha256'), 'hex');
  select * into v_review from public.pipeline_human_reviews where id = p_review_id for update;
  if v_review.id is null then
    raise exception using errcode = 'P0001', message = 'HUMAN_APPROVAL_REQUIRED';
  end if;
  if v_review.status = 'HOLD' then
    raise exception using errcode = 'P0001', message = 'human_review_held';
  end if;
  if v_review.status = 'REJECTED' then
    raise exception using errcode = 'P0001', message = 'human_review_rejected';
  end if;
  if v_review.status is distinct from 'APPROVED' then
    raise exception using errcode = 'P0001', message = 'HUMAN_APPROVAL_REQUIRED';
  end if;
  if v_review.reviewer_approved is distinct from true
     or v_review.facts_acceptable is distinct from true
     or v_review.attribution_acceptable is distinct from true
     or v_review.uncertainty_preserved is distinct from true
     or v_review.headline_acceptable is distinct from true
     or v_review.summary_acceptable is distinct from true
     or v_review.no_unsupported_material_claims is distinct from true
     or v_review.source_chain_acceptable is distinct from true
     or v_review.critic_pass is distinct from true
     or v_review.provider_usage_settled is distinct from true
     or p_event_key is distinct from v_review.event_key
     or p_attempt_id is distinct from v_review.attempt_id
     or p_pipeline_run_id is distinct from v_review.pipeline_run_id
     or p_draft_id is distinct from v_review.draft_id
     or p_draft_sha256 is distinct from v_review.draft_sha256
     or p_checkpoint_hashes is distinct from v_review.review_manifest->'checkpoints'
     or p_source_lineage is distinct from v_review.source_lineage
     or v_source_lineage_sha256 is distinct from v_review.source_lineage_sha256
     or v_publication_payload_sha256 is distinct from v_review.publication_payload_sha256
     or p_publication_payload->>'eventKey' is distinct from v_review.event_key
     or p_publication_payload->'critic'->>'decision' is distinct from 'pass' then
    raise exception using errcode = 'P0001', message = 'human_review_approval_missing_or_stale';
  end if;
  perform public.assert_pipeline_human_review_source_lineage(p_source_lineage);
  perform public.assert_pipeline_human_review_evidence(v_review.event_key, v_review.pipeline_run_id);
  select * into v_attempt from public.pipeline_event_attempts
   where id = v_review.attempt_id for update;
  if v_attempt.id is null or v_attempt.event_key is distinct from v_review.event_key
     or v_attempt.pipeline_run_id is distinct from v_review.pipeline_run_id
     or v_attempt.final_state is distinct from 'WAITING_FOR_HUMAN_REVIEW'
     or v_attempt.stop_stage is distinct from 'human_review' then
    raise exception using errcode = 'P0001', message = 'human_review_attempt_or_lineage_changed';
  end if;

  update public.pipeline_human_reviews
     set status = 'PUBLISHING', consumed_at = clock_timestamp(), updated_at = clock_timestamp()
   where id = p_review_id and status = 'APPROVED' and consumed_at is null;
  if not found then
    raise exception using errcode = 'P0001', message = 'human_review_approval_already_consumed';
  end if;
  v_result := public.publish_article_atomic(p_publication_payload);
  v_article_id := nullif(v_result->>'articleId', '')::uuid;
  if v_article_id is null or not exists (
      select 1 from public.articles a where a.id = v_article_id
      and a.publication_status = 'published'
      and a.slug = p_publication_payload->'article'->>'slug'
  ) then
    raise exception using errcode = 'P0001', message = 'human_review_publication_identity_invalid';
  end if;
  update public.pipeline_event_attempts
     set final_state = 'READY_FOR_PUBLICATION', stop_stage = 'publisher', stop_reason = null,
         retry_class = 'NONE', counts_toward_retry_limit = false, next_eligible_at = null
   where id = v_review.attempt_id and pipeline_run_id = v_review.pipeline_run_id
     and final_state = 'WAITING_FOR_HUMAN_REVIEW';
  if not found then
    raise exception using errcode = 'P0001', message = 'human_review_attempt_finalize_conflict';
  end if;
  update public.pipeline_human_reviews
     set status = 'PUBLISHED', published_article_id = v_article_id, updated_at = clock_timestamp()
   where id = p_review_id;
  return v_result || jsonb_build_object('humanReviewId', p_review_id, 'humanReviewStatus', 'PUBLISHED');
end;
$$;

-- The ordinary service-role Publisher must use the one-use reviewed wrapper.
-- Security-definer factual-incident RPCs retain their existing owner-mediated path.
revoke all on function public.publish_article_atomic(jsonb) from service_role;
revoke all on function public.assert_pipeline_human_review_evidence(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.assert_pipeline_human_review_source_lineage(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.create_pipeline_human_review(text, uuid, uuid, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.decide_pipeline_human_review(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) from public, anon, authenticated, service_role;
revoke all on function public.publish_reviewed_article_atomic(uuid, text, uuid, uuid, text, text, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_pipeline_human_review(text, uuid, uuid, text, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.decide_pipeline_human_review(uuid, text, text, boolean, boolean, boolean, boolean, boolean, boolean, boolean) to service_role;
grant execute on function public.publish_reviewed_article_atomic(uuid, text, uuid, uuid, text, text, jsonb, jsonb, jsonb) to service_role;

comment on table public.pipeline_human_reviews is
  'Private immutable review manifest and single-use human publication decision. Stores checkpoint/source identities and hashes, not article body or publication payload. Read and mutate through service-role RPCs only.';
comment on function public.publish_reviewed_article_atomic(uuid, text, uuid, uuid, text, text, jsonb, jsonb, jsonb) is
  'Publishes the exact current payload only when its SHA-256 and all reviewed identities match the durable human approval; consumes approval in the same transaction.';

commit;
