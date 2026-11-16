-- HorizAI / Fase 9J
-- Idempotencia y publicación atómica server-side. No modifica RLS.

create unique index if not exists articles_event_id_uidx
  on public.articles (event_id);

create unique index if not exists entities_identity_uidx
  on public.entities (entity_type, canonical_name, coalesce(country_code, ''));

create or replace function public.publish_article_atomic(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_article_id uuid;
  v_region_id uuid;
  v_region_latitude numeric;
  v_region_longitude numeric;
  v_region_code text;
  v_source_count integer;
  v_category_count integer;
  v_entity_id uuid;
  v_category_id uuid;
  v_category jsonb;
  v_entity jsonb;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = 'P0001', message = 'publication_transaction_failed';
  end if;

  if p_payload->'critic'->>'decision' <> 'pass' then
    raise exception using errcode = 'P0001', message = 'publication_not_approved';
  end if;

  select id into v_event_id
    from public.events
   where event_key = p_payload->>'eventKey'
   for update;

  if v_event_id is null then
    raise exception using errcode = 'P0001', message = 'publication_event_not_found';
  end if;

  if exists (
    select 1 from public.events
     where id = v_event_id
       and canonical_title <> p_payload->'event'->>'canonicalTitle'
  ) then
    raise exception using errcode = 'P0001', message = 'publication_idempotency_conflict';
  end if;

  select count(*) into v_source_count
    from jsonb_array_elements(p_payload->'sources') as requested
    join public.sources source_row on source_row.id = (requested->>'sourceId')::uuid;
  if v_source_count <> jsonb_array_length(p_payload->'sources') then
    raise exception using errcode = 'P0001', message = 'publication_missing_source';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_payload->'sources') as requested
     where not exists (
       select 1 from public.event_sources relation
        where relation.event_id = v_event_id
          and relation.source_id = (requested->>'sourceId')::uuid
     )
  ) then
    raise exception using errcode = 'P0001', message = 'publication_source_traceability_missing';
  end if;

  v_region_code := nullif(p_payload->'region'->>'code', '');
  if v_region_code is not null then
    select id, latitude, longitude into v_region_id, v_region_latitude, v_region_longitude
      from public.regions
     where code = v_region_code and is_active = true;
    if v_region_id is null then
      raise exception using errcode = 'P0001', message = 'publication_invalid_region';
    end if;
    if (p_payload->'region'->>'latitude')::numeric is distinct from v_region_latitude
       or (p_payload->'region'->>'longitude')::numeric is distinct from v_region_longitude then
      raise exception using errcode = 'P0001', message = 'publication_invalid_geo';
    end if;
  elsif p_payload->'region'->>'latitude' is not null or p_payload->'region'->>'longitude' is not null then
    raise exception using errcode = 'P0001', message = 'publication_invalid_geo';
  end if;

  v_category_count := 0;
  for v_category in select value from jsonb_array_elements(p_payload->'categories') loop
    select id into v_category_id
      from public.categories
     where slug = v_category->>'categorySlug' and is_active = true;
    if v_category_id is null then
      raise exception using errcode = 'P0001', message = 'publication_invalid_category';
    end if;
    if (v_category->>'isPrimary')::boolean then v_category_count := v_category_count + 1; end if;
  end loop;
  if v_category_count > 1 then
    raise exception using errcode = 'P0001', message = 'publication_invalid_category';
  end if;

  insert into public.articles (
    event_id, slug, headline_es, summary_es, why_it_matters_es, body_es,
    importance_score, confidence_score, publication_status, critic_status,
    critic_notes, generated_at, reviewed_at, published_at, metadata
  ) values (
    v_event_id,
    p_payload->'article'->>'slug',
    p_payload->'article'->>'headlineEs',
    p_payload->'article'->>'summaryEs',
    p_payload->'article'->>'whyItMattersEs',
    p_payload->'article'->>'bodyEs',
    (p_payload->'scores'->>'importanceScore')::numeric,
    (p_payload->'verification'->>'confidenceScore')::numeric / 100,
    'published',
    'approved',
    p_payload->'critic'->>'notes',
    now(), now(), now(),
    jsonb_build_object(
      'publisherVersion', 'publisher-v1',
      'dekEs', p_payload->'article'->>'dekEs',
      'keyPoints', p_payload->'article'->'keyPoints'
    )
  )
  on conflict (event_id) do update set
    slug = excluded.slug,
    headline_es = excluded.headline_es,
    summary_es = excluded.summary_es,
    why_it_matters_es = excluded.why_it_matters_es,
    body_es = excluded.body_es,
    importance_score = excluded.importance_score,
    confidence_score = excluded.confidence_score,
    publication_status = excluded.publication_status,
    critic_status = excluded.critic_status,
    critic_notes = excluded.critic_notes,
    reviewed_at = excluded.reviewed_at,
    published_at = excluded.published_at,
    metadata = excluded.metadata,
    updated_at = now()
  returning id into v_article_id;

  for v_category in select value from jsonb_array_elements(p_payload->'categories') loop
    select id into v_category_id from public.categories where slug = v_category->>'categorySlug' and is_active = true;
    insert into public.article_categories (article_id, category_id, is_primary, confidence_score)
    values (v_article_id, v_category_id, (v_category->>'isPrimary')::boolean, (v_category->>'confidenceScore')::numeric / 100)
    on conflict (article_id, category_id) do update set
      is_primary = excluded.is_primary,
      confidence_score = excluded.confidence_score,
      updated_at = now();
  end loop;

  for v_entity in select value from jsonb_array_elements(p_payload->'entities') loop
    insert into public.entities (entity_type, canonical_name, country_code)
    values (v_entity->>'entityType', v_entity->>'canonicalName', nullif(v_entity->>'countryCode', ''))
    on conflict (entity_type, canonical_name, (coalesce(country_code, ''))) do update set updated_at = now()
    returning id into v_entity_id;
    insert into public.article_entities (article_id, entity_id, role, confidence_score)
    values (v_article_id, v_entity_id, v_entity->>'role', (v_entity->>'confidenceScore')::numeric / 100)
    on conflict (article_id, entity_id) do update set
      role = excluded.role,
      confidence_score = excluded.confidence_score,
      updated_at = now();
  end loop;

  update public.events set
    canonical_title = p_payload->'event'->>'canonicalTitle',
    event_status = 'active',
    confidence_score = (p_payload->'verification'->>'confidenceScore')::numeric / 100,
    primary_region_id = v_region_id,
    primary_country_code = nullif(p_payload->'event'->>'probableCountryCode', ''),
    occurred_at = (p_payload->'event'->>'probableOccurredAt')::timestamptz,
    review_status = 'approved',
    review_notes = p_payload->'critic'->>'notes',
    last_seen_at = now(),
    updated_at = now()
  where id = v_event_id;

  return jsonb_build_object(
    'eventId', v_event_id,
    'articleId', v_article_id,
    'articleOperation', 'upsert_by_event_id',
    'categoriesLinkedCount', jsonb_array_length(p_payload->'categories'),
    'entitiesLinkedCount', jsonb_array_length(p_payload->'entities'),
    'sourcesLinkedCount', jsonb_array_length(p_payload->'sources'),
    'activityRowsCreated', 0
  );
exception
  when others then
    if sqlstate = 'P0001' then raise; end if;
    raise exception using errcode = 'P0001', message = 'publication_transaction_failed';
end;
$$;

revoke all on function public.publish_article_atomic(jsonb) from public, anon, authenticated;
grant execute on function public.publish_article_atomic(jsonb) to service_role;

comment on function public.publish_article_atomic(jsonb)
  is 'Atomically publishes an already-approved PublicationPayload for server-side HorizAI use.';
