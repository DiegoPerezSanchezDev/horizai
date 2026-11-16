-- HorizAI / Fase 9A
-- Campos mínimos para distinguir la homepage de un feed y registrar el estado
-- operativo del descubrimiento determinista.

alter table public.sources
  add column if not exists feed_url text,
  add column if not exists discovery_method text not null default 'manual',
  add column if not exists last_checked_at timestamptz,
  add column if not exists last_error text;

alter table public.sources
  drop constraint if exists sources_feed_url_format;

alter table public.sources
  add constraint sources_feed_url_format
    check (feed_url is null or feed_url ~* '^https?://');

alter table public.sources
  drop constraint if exists sources_discovery_method_check;

alter table public.sources
  add constraint sources_discovery_method_check
    check (discovery_method in ('rss', 'atom', 'html', 'api', 'manual'));

create index if not exists sources_active_discovery_priority_idx
  on public.sources (is_active, discovery_method, priority desc);

create unique index if not exists sources_feed_url_uidx
  on public.sources (feed_url)
  where feed_url is not null;

-- Solo se registran endpoints comprobados como RSS/Atom por HTTP directo.
-- Las fuentes restantes quedan disponibles para una fase posterior.
update public.sources
set feed_url = values.feed_url,
    discovery_method = 'rss',
    updated_at = now()
from (
  values
    ('https://www.technologyreview.com/', 'https://www.technologyreview.com/feed/'),
    ('https://www.theverge.com/ai-artificial-intelligence', 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'),
    ('https://techcrunch.com/category/artificial-intelligence/', 'https://techcrunch.com/category/artificial-intelligence/feed/'),
    ('https://arstechnica.com/ai/', 'https://feeds.arstechnica.com/arstechnica/technology-lab'),
    ('https://huggingface.co/blog', 'https://huggingface.co/blog/feed.xml'),
    ('https://blog.google/technology/ai/', 'https://blog.google/innovation-and-ai/technology/ai/rss/'),
    ('https://openai.com/news/', 'https://openai.com/news/rss.xml'),
    ('https://deepmind.google/discover/blog/', 'https://deepmind.google/blog/rss.xml'),
    ('https://www.nature.com/natmachintell/', 'https://www.nature.com/natmachintell.rss'),
    ('https://elpais.com/tecnologia/', 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/tecnologia/portada'),
    ('https://www.xataka.com/robotica-e-ia', 'https://www.xataka.com/feedburner.xml')
) as values(source_url, feed_url)
where public.sources.url = values.source_url;

