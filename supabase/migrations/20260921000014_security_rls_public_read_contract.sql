-- HorizAI / Fase 10E
-- RLS, mínimo privilegio y contrato de lectura pública explícito.
--
-- Las tablas de aplicación son internas por defecto. El lector accede solo a
-- las views curadas de abajo; no se exponen tablas base ni columnas internas.

begin;

-- Defense in depth: RLS permanece habilitado incluso si un grant accidental
-- reaparece en el futuro. No se usa FORCE ROW LEVEL SECURITY: service_role y
-- las funciones SECURITY DEFINER existentes deben conservar su comportamiento.
alter table public.sources enable row level security;
alter table public.raw_items enable row level security;
alter table public.events enable row level security;
alter table public.event_sources enable row level security;
alter table public.articles enable row level security;
alter table public.regions enable row level security;
alter table public.categories enable row level security;
alter table public.article_categories enable row level security;
alter table public.entities enable row level security;
alter table public.article_entities enable row level security;
alter table public.activity_history enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_logs enable row level security;
alter table public.scheduler_runs enable row level security;

-- Internal-only tables: no browser read or write path. service_role retains
-- its existing complete grants and bypassrls behavior.
revoke all on table
  public.sources,
  public.raw_items,
  public.events,
  public.event_sources,
  public.articles,
  public.regions,
  public.categories,
  public.article_categories,
  public.entities,
  public.article_entities,
  public.activity_history,
  public.agent_runs,
  public.agent_logs,
  public.scheduler_runs
from public, anon, authenticated;

revoke all on sequence public.agent_logs_id_seq from public, anon, authenticated;

-- This trigger helper is not a public RPC surface.
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- Reassert the sensitive RPC boundary explicitly in the security migration.
revoke all on function public.reserve_agent_request(uuid, text, text, text, integer, text, date, integer) from public, anon, authenticated;
grant execute on function public.reserve_agent_request(uuid, text, text, text, integer, text, date, integer) to service_role;
revoke all on function public.mark_agent_request_dispatched(bigint, uuid, date) from public, anon, authenticated;
grant execute on function public.mark_agent_request_dispatched(bigint, uuid, date) to service_role;
revoke all on function public.release_agent_request(bigint, uuid, date) from public, anon, authenticated;
grant execute on function public.release_agent_request(bigint, uuid, date) to service_role;
revoke all on function public.publish_article_atomic(jsonb) from public, anon, authenticated;
grant execute on function public.publish_article_atomic(jsonb) to service_role;
revoke all on function public.acquire_scheduler_run(text, uuid, text, date, text, text, timestamptz, date, timestamptz, timestamptz, integer, integer, integer, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.acquire_scheduler_run(text, uuid, text, date, text, text, timestamptz, date, timestamptz, timestamptz, integer, integer, integer, boolean, boolean, boolean) to service_role;
revoke all on function public.finish_scheduler_run(text, uuid, text, text, text, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.finish_scheduler_run(text, uuid, text, text, text, integer, integer, timestamptz) to service_role;
revoke all on function public.release_scheduler_lease(text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.release_scheduler_lease(text, uuid, timestamptz) to service_role;
revoke all on function public.finish_scheduler_run_execution(text, uuid, text, text, text, text, uuid, integer, jsonb, integer, integer, integer, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.finish_scheduler_run_execution(text, uuid, text, text, text, text, uuid, integer, jsonb, integer, integer, integer, integer, timestamptz) to service_role;

-- Views deliberately use owner (postgres) privileges with an explicit,
-- security-barrier definition. They expose only reader-facing projections;
-- no SELECT grant is given on their base tables.
drop view if exists public.public_published_articles;
create view public.public_published_articles
with (security_barrier = true, security_invoker = false)
as
select
  article.slug,
  article.headline_es,
  article.summary_es,
  article.why_it_matters_es,
  article.body_es,
  article.published_at,
  article.updated_at,
  region.code as region_code,
  region.name as region_name,
  region.latitude as region_latitude,
  region.longitude as region_longitude,
  coalesce((
    select jsonb_agg(
      jsonb_build_object('slug', category.slug, 'name', category.name)
      order by article_category.is_primary desc, category.name
    )
    from public.article_categories as article_category
    join public.categories as category on category.id = article_category.category_id
    where article_category.article_id = article.id
      and category.is_active = true
  ), '[]'::jsonb) as categories,
  coalesce((
    select jsonb_agg(
      jsonb_build_object('name', source.name, 'url', raw_item.original_url)
      order by event_source.is_primary desc, source.name, raw_item.original_url
    )
    from public.event_sources as event_source
    join public.sources as source on source.id = event_source.source_id
    join public.raw_items as raw_item on raw_item.id = event_source.raw_item_id
    where event_source.event_id = article.event_id
  ), '[]'::jsonb) as sources,
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'type', entity.entity_type,
        'name', entity.canonical_name,
        'countryCode', entity.country_code
      )
      order by entity.entity_type, entity.canonical_name
    )
    from public.article_entities as article_entity
    join public.entities as entity on entity.id = article_entity.entity_id
    where article_entity.article_id = article.id
      and entity.review_status = 'approved'
  ), '[]'::jsonb) as entities
from public.articles as article
join public.events as event on event.id = article.event_id
left join public.regions as region
  on region.id = event.primary_region_id
 and region.is_active = true
where article.publication_status = 'published'
  and article.published_at is not null
  and event.event_status = 'active'
  and event.review_status = 'approved';

drop view if exists public.public_regions;
create view public.public_regions
with (security_barrier = true, security_invoker = false)
as
select code, name, latitude, longitude
from public.regions
where is_active = true;

drop view if exists public.public_categories;
create view public.public_categories
with (security_barrier = true, security_invoker = false)
as
select slug, name
from public.categories
where is_active = true;

revoke all on table
  public.public_published_articles,
  public.public_regions,
  public.public_categories
from public;
grant select on table
  public.public_published_articles,
  public.public_regions,
  public.public_categories
to anon, authenticated;

comment on view public.public_published_articles is
  'Public reader contract: published articles only, with explicit editorial, presentation, attribution and approved-entity fields. Base tables remain internal.';
comment on view public.public_regions is
  'Public reader contract: active region presentation fields only.';
comment on view public.public_categories is
  'Public reader contract: active category presentation fields only.';

commit;
