-- HorizAI / Fase 10E
-- Corrige grants por defecto heredados por las views públicas.
-- No cambia el contrato ni la superficie de datos: anon/authenticated solo
-- reciben SELECT explícito.

begin;

revoke all on table
  public.public_published_articles,
  public.public_regions,
  public.public_categories
from public, anon, authenticated, service_role;

grant select on table
  public.public_published_articles,
  public.public_regions,
  public.public_categories
to anon, authenticated, service_role;

commit;
