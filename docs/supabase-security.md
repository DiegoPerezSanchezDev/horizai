# Supabase security contract — Fase 10E

## Objective

Cerrar la superficie de Supabase antes de conectar el frontend a datos reales o activar publicación/cron. Esta fase mantiene `publish=false`, `automaticRevision=false`, el cron de producción desactivado y no realiza llamadas a Groq.

## Auditoría remota

La inspección se ejecutó sobre el proyecto remoto enlazado, no solo sobre los archivos locales.

Inventario encontrado en `public`:

- 14 tablas de aplicación: `sources`, `raw_items`, `events`, `event_sources`, `articles`, `regions`, `categories`, `article_categories`, `entities`, `article_entities`, `activity_history`, `agent_runs`, `agent_logs` y `scheduler_runs`.
- 1 secuencia interna: `agent_logs_id_seq`.
- Antes de 10E no había views ni policies y las tablas estaban sin RLS.
- Las RPC de reserva, scheduler, telemetría y Publisher ya eran `SECURITY DEFINER`, propiedad de `postgres`, con `search_path` fijo y `EXECUTE` únicamente para `service_role`.

## Clasificación

Todas las tablas base son `INTERNAL_ONLY`. Esto incluye `regions` y `categories`: son referencias del backend, pero no se exponen directamente para evitar que un grant futuro convierta una tabla interna en API pública.

También son internas por definición:

- `raw_items`, `events`, `event_sources`;
- `agent_runs`, `agent_logs`, `scheduler_runs`;
- `activity_history`;
- `articles`, `article_categories`, `article_entities`, `entities` y `sources`.

La aplicación actual sigue utilizando mocks. La auditoría del frontend confirmó que Home, latest, artículo, categorías, regiones/mapa y fuentes todavía no importan un cliente Supabase ni realizan lecturas remotas.

## Contrato público mínimo

La migración `20260921000014_security_rls_public_read_contract.sql` crea tres views explícitas:

- `public.public_published_articles`: `slug`, campos editoriales publicados, timestamp, presentación de región y arrays JSON de categorías, atribución de fuentes (`name`/`url`) y entidades aprobadas (`type`/`name`/`countryCode`). No contiene IDs internos, `event_id`, `metadata`, critic, prompts, raw content, hashes, telemetría ni scores internos.
- `public.public_regions`: `code`, `name`, `latitude`, `longitude` de regiones activas.
- `public.public_categories`: `slug`, `name` de categorías activas.

El filtro de artículo publicado exige simultáneamente:

- `articles.publication_status = 'published'`;
- `articles.published_at IS NOT NULL`;
- `events.event_status = 'active'`;
- `events.review_status = 'approved'`.

Por tanto, drafts, artículos en revisión y estados intermedios no aparecen. La vista usa `security_barrier=true` y `security_invoker=false` de forma explícita: el owner `postgres` puede proyectar tablas base sin concederlas al navegador. La proyección es cerrada y no usa `SELECT *`.

La migración `20260921000015_fix_public_view_grants.sql` revoca los privilegios heredados por defecto al crear views y concede únicamente `SELECT` a `anon`, `authenticated` y `service_role` sobre esas tres views.

## RLS y grants

Las 14 tablas de aplicación tienen RLS habilitado. No se activó `FORCE ROW LEVEL SECURITY`: el comportamiento server-side existente de `service_role` y de las RPC `SECURITY DEFINER` debe mantenerse.

Para `anon` y `authenticated` se revocaron `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `REFERENCES`, `TRIGGER` y `TRUNCATE` de las tablas base y de la secuencia. No hay policies permisivas sobre tablas internas. `service_role` conserva los grants necesarios para pipeline, reservas, telemetría, scheduler y Publisher.

Las RPC sensibles permanecen server-only:

- `reserve_agent_request`, `mark_agent_request_dispatched`, `release_agent_request`;
- `acquire_scheduler_run`, `finish_scheduler_run`, `finish_scheduler_run_execution`, `release_scheduler_lease`;
- `publish_article_atomic`.

Todas tienen `EXECUTE` revocado para `public`, `anon` y `authenticated`, y concedido a `service_role`. `set_updated_at` tampoco es una RPC pública.

## Precheck de publicación

`lib/agents/publisher/publication-readiness.ts` expone `validateRealPublicationReadiness`. Es una comprobación read-only y nunca llama a `publish_article_atomic`. Valida:

- `PublicationPayload` con Zod;
- Critic en `pass`;
- lineage y revisión más reciente;
- sources existentes y activas;
- `rawItemId` de cada source nueva y pertenencia al `sourceId` declarado;
- categorías y región activas;
- identidades de entidades y colisiones;
- resolución de artículo/evento y el plan determinista del Publisher.

Una publicación de un evento nuevo requiere `rawItemId` explícito en cada source y una fila `raw_items` perteneciente al source correspondiente. No se infiere ni se adivina esa relación.

## Verificación ejecutada

`npm run supabase:security` usa la publishable/anon key y fixtures temporales para comprobar:

- lectura pública de un artículo publicado;
- ocultación de un artículo `draft`;
- 11 regiones y 8 categorías en las views públicas;
- bloqueo de SELECT directo en las 14 tablas base;
- bloqueo de INSERT/UPDATE/DELETE anónimo;
- bloqueo de Publisher y reservation RPC para anon;
- ausencia de columnas internas en la proyección pública.

El test elimina al finalizar artículos, eventos, raw items, entidades y relaciones temporales. La comprobación remota posterior confirmó cero fixtures de seguridad restantes.

No se creó un usuario autenticado permanente. Para `authenticated` se verificaron los grants SQL directamente; la sesión HTTP autenticada queda pendiente hasta disponer de un usuario de test gestionado y eliminable.

## Seguridad de secretos

Las keys no se incluyen en esta documentación. `SUPABASE_SECRET_KEY`, `AGENT_API_KEY` y `SCHEDULER_TRIGGER_SECRET` siguen limitadas a server-side y no se usan en componentes Client. La publishable key solo se usa en el test de anon y está protegida por RLS/grants.
