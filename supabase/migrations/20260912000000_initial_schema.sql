-- HorizAI / Fase 8A
-- Modelo relacional inicial para el pipeline de ingesta, clasificación,
-- edición y publicación. No conecta la aplicación con Supabase.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.regions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  latitude numeric(8,5),
  longitude numeric(8,5),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint regions_code_not_blank check (length(trim(code)) > 0),
  constraint regions_name_not_blank check (length(trim(name)) > 0),
  constraint regions_latitude_range check (latitude is null or latitude between -90 and 90),
  constraint regions_longitude_range check (longitude is null or longitude between -180 and 180)
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null unique,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint categories_name_not_blank check (length(trim(name)) > 0)
);

create table public.entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  canonical_name text not null,
  country_code varchar(2),
  aliases text[] not null default '{}',
  review_status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint entities_type_check check (entity_type in ('person', 'organization', 'model', 'product', 'location', 'other')),
  constraint entities_name_not_blank check (length(trim(canonical_name)) > 0),
  constraint entities_country_code_check check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint entities_review_status_check check (review_status in ('pending', 'approved', 'rejected')),
  constraint entities_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null unique,
  source_type text not null default 'rss',
  country_code varchar(2),
  language text not null default 'es',
  priority smallint not null default 50,
  is_active boolean not null default true,
  crawl_interval_minutes integer not null default 60,
  last_fetched_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  consecutive_failures integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sources_name_not_blank check (length(trim(name)) > 0),
  constraint sources_url_format check (url ~* '^https?://'),
  constraint sources_type_check check (source_type in ('rss', 'atom', 'website', 'api', 'newsletter', 'social', 'other')),
  constraint sources_country_code_check check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  constraint sources_language_not_blank check (length(trim(language)) > 0),
  constraint sources_priority_range check (priority between 0 and 100),
  constraint sources_crawl_interval_positive check (crawl_interval_minutes > 0),
  constraint sources_failures_non_negative check (consecutive_failures >= 0),
  constraint sources_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'pending',
  dry_run boolean not null default false,
  stats jsonb not null default '{}'::jsonb,
  config jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_runs_type_check check (run_type in ('ingest', 'normalize', 'classify', 'enrich', 'editorial', 'critic', 'publish', 'aggregate', 'full', 'other')),
  constraint agent_runs_status_check check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint agent_runs_finished_after_started check (finished_at is null or finished_at >= started_at),
  constraint agent_runs_stats_object check (jsonb_typeof(stats) = 'object'),
  constraint agent_runs_config_object check (jsonb_typeof(config) = 'object')
);

create table public.raw_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete restrict,
  original_url text not null,
  canonical_url text,
  external_id text,
  title text,
  excerpt text,
  raw_content text,
  content_type text not null default 'article',
  language text,
  published_at timestamptz,
  discovered_at timestamptz not null default now(),
  content_hash text,
  processing_status text not null default 'pending',
  processing_attempts integer not null default 0,
  last_processed_at timestamptz,
  next_retry_at timestamptz,
  last_error_at timestamptz,
  error_code text,
  error_message text,
  normalized_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, source_id),
  constraint raw_items_original_url_format check (original_url ~* '^https?://'),
  constraint raw_items_canonical_url_format check (canonical_url is null or canonical_url ~* '^https?://'),
  constraint raw_items_content_type_check check (content_type in ('article', 'video', 'podcast', 'newsletter', 'post', 'other')),
  constraint raw_items_status_check check (processing_status in ('pending', 'processing', 'processed', 'failed', 'ignored')),
  constraint raw_items_attempts_non_negative check (processing_attempts >= 0),
  constraint raw_items_hash_not_blank check (content_hash is null or length(trim(content_hash)) > 0),
  constraint raw_items_payload_object check (normalized_payload is null or jsonb_typeof(normalized_payload) = 'object')
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  canonical_title text not null,
  event_status text not null default 'candidate',
  confidence_score numeric(4,3),
  primary_region_id uuid references public.regions(id) on delete set null,
  primary_country_code varchar(2),
  occurred_at timestamptz,
  occurred_at_precision text not null default 'unknown',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  review_status text not null default 'pending',
  review_notes text,
  classification_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_title_not_blank check (length(trim(canonical_title)) > 0),
  constraint events_status_check check (event_status in ('candidate', 'active', 'archived', 'merged')),
  constraint events_confidence_range check (confidence_score is null or confidence_score between 0 and 1),
  constraint events_country_code_check check (primary_country_code is null or primary_country_code ~ '^[A-Z]{2}$'),
  constraint events_precision_check check (occurred_at_precision in ('exact', 'day', 'month', 'year', 'unknown')),
  constraint events_last_seen_check check (last_seen_at is null or last_seen_at >= first_seen_at),
  constraint events_review_status_check check (review_status in ('pending', 'approved', 'changes_requested', 'rejected')),
  constraint events_classification_object check (jsonb_typeof(classification_payload) = 'object')
);

create table public.event_sources (
  event_id uuid not null references public.events(id) on delete cascade,
  raw_item_id uuid not null references public.raw_items(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete restrict,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, raw_item_id),
  constraint event_sources_raw_source_fk
    foreign key (raw_item_id, source_id)
    references public.raw_items(id, source_id)
    on delete cascade
);

create table public.articles (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  slug text not null unique,
  headline_es text not null,
  summary_es text,
  why_it_matters_es text,
  body_es text,
  importance_score numeric(5,2),
  confidence_score numeric(4,3),
  publication_status text not null default 'draft',
  critic_status text not null default 'pending',
  critic_score numeric(4,3),
  critic_notes text,
  revision_count integer not null default 0,
  generated_at timestamptz,
  reviewed_at timestamptz,
  published_at timestamptz,
  rejection_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint articles_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint articles_headline_not_blank check (length(trim(headline_es)) > 0),
  constraint articles_importance_range check (importance_score is null or importance_score between 0 and 100),
  constraint articles_confidence_range check (confidence_score is null or confidence_score between 0 and 1),
  constraint articles_publication_status_check check (publication_status in ('draft', 'in_review', 'approved', 'published', 'archived', 'rejected')),
  constraint articles_critic_status_check check (critic_status in ('pending', 'approved', 'changes_requested', 'rejected')),
  constraint articles_critic_score_range check (critic_score is null or critic_score between 0 and 1),
  constraint articles_revision_count_non_negative check (revision_count >= 0),
  constraint articles_published_timestamp check (publication_status <> 'published' or published_at is not null),
  constraint articles_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.article_categories (
  article_id uuid not null references public.articles(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  is_primary boolean not null default false,
  confidence_score numeric(4,3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (article_id, category_id),
  constraint article_categories_confidence_range check (confidence_score is null or confidence_score between 0 and 1)
);

create table public.article_entities (
  article_id uuid not null references public.articles(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete restrict,
  role text not null default 'mentioned',
  confidence_score numeric(4,3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (article_id, entity_id),
  constraint article_entities_role_check check (role in ('subject', 'mentioned', 'source', 'other')),
  constraint article_entities_confidence_range check (confidence_score is null or confidence_score between 0 and 1)
);

create table public.activity_history (
  id uuid primary key default gen_random_uuid(),
  region_id uuid not null references public.regions(id) on delete restrict,
  category_id uuid references public.categories(id) on delete set null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  activity_score numeric(7,2) not null default 0,
  event_count integer not null default 0,
  article_count integer not null default 0,
  calculation_version text not null default 'v1',
  source_run_id uuid references public.agent_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activity_history_period_check check (period_end > period_start),
  constraint activity_history_score_non_negative check (activity_score >= 0),
  constraint activity_history_event_count_non_negative check (event_count >= 0),
  constraint activity_history_article_count_non_negative check (article_count >= 0),
  constraint activity_history_version_not_blank check (length(trim(calculation_version)) > 0)
);

create table public.agent_logs (
  id bigint generated by default as identity primary key,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  agent_name text not null,
  step text not null,
  level text not null default 'info',
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  duration_ms integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_logs_agent_name_not_blank check (length(trim(agent_name)) > 0),
  constraint agent_logs_step_not_blank check (length(trim(step)) > 0),
  constraint agent_logs_level_check check (level in ('debug', 'info', 'warn', 'error')),
  constraint agent_logs_message_not_blank check (length(trim(message)) > 0),
  constraint agent_logs_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint agent_logs_duration_non_negative check (duration_ms is null or duration_ms >= 0)
);

-- Índices de colas, consultas editoriales y relaciones.
create index sources_active_priority_idx on public.sources (is_active, priority desc, name);
create index sources_country_language_idx on public.sources (country_code, language);

create index raw_items_pending_retry_idx on public.raw_items (processing_status, next_retry_at, discovered_at);
create index raw_items_source_published_idx on public.raw_items (source_id, published_at desc);
create index raw_items_canonical_url_idx on public.raw_items (canonical_url) where canonical_url is not null;
create unique index raw_items_source_hash_uidx on public.raw_items (source_id, content_hash) where content_hash is not null;

create index events_status_occurred_idx on public.events (event_status, occurred_at desc);
create index events_region_occurred_idx on public.events (primary_region_id, occurred_at desc);
create index events_review_status_idx on public.events (review_status, updated_at desc);

create index event_sources_raw_item_idx on public.event_sources (raw_item_id);
create index event_sources_source_idx on public.event_sources (source_id, created_at desc);
create unique index event_sources_primary_uidx on public.event_sources (event_id) where is_primary;

create index articles_publication_idx on public.articles (publication_status, published_at desc);
create index articles_event_idx on public.articles (event_id);
create index articles_critic_idx on public.articles (critic_status, updated_at desc);
create index articles_importance_idx on public.articles (importance_score desc nulls last);

create index article_categories_category_idx on public.article_categories (category_id, article_id);
create unique index article_categories_primary_uidx on public.article_categories (article_id) where is_primary;

create index article_entities_entity_idx on public.article_entities (entity_id, article_id);

create index activity_history_region_period_idx on public.activity_history (region_id, period_start desc, period_end desc);
create index activity_history_category_period_idx on public.activity_history (category_id, period_start desc, period_end desc);
create index activity_history_run_idx on public.activity_history (source_run_id);
create unique index activity_history_region_category_period_uidx
  on public.activity_history (region_id, category_id, period_start, period_end)
  where category_id is not null;
create unique index activity_history_region_period_uidx
  on public.activity_history (region_id, period_start, period_end)
  where category_id is null;

create index agent_runs_status_started_idx on public.agent_runs (status, started_at desc);
create index agent_runs_type_started_idx on public.agent_runs (run_type, started_at desc);
create index agent_logs_run_created_idx on public.agent_logs (run_id, created_at);
create index agent_logs_level_created_idx on public.agent_logs (level, created_at desc);

-- Mantiene updated_at coherente en entidades mutables y relaciones.
create trigger regions_set_updated_at before update on public.regions for each row execute function public.set_updated_at();
create trigger categories_set_updated_at before update on public.categories for each row execute function public.set_updated_at();
create trigger entities_set_updated_at before update on public.entities for each row execute function public.set_updated_at();
create trigger sources_set_updated_at before update on public.sources for each row execute function public.set_updated_at();
create trigger agent_runs_set_updated_at before update on public.agent_runs for each row execute function public.set_updated_at();
create trigger raw_items_set_updated_at before update on public.raw_items for each row execute function public.set_updated_at();
create trigger events_set_updated_at before update on public.events for each row execute function public.set_updated_at();
create trigger event_sources_set_updated_at before update on public.event_sources for each row execute function public.set_updated_at();
create trigger articles_set_updated_at before update on public.articles for each row execute function public.set_updated_at();
create trigger article_categories_set_updated_at before update on public.article_categories for each row execute function public.set_updated_at();
create trigger article_entities_set_updated_at before update on public.article_entities for each row execute function public.set_updated_at();
create trigger activity_history_set_updated_at before update on public.activity_history for each row execute function public.set_updated_at();
create trigger agent_logs_set_updated_at before update on public.agent_logs for each row execute function public.set_updated_at();

-- El acceso y las políticas RLS se definirán junto con el modelo de autenticación.
