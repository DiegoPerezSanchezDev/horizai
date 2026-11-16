# Publisher — Fase 9J

## Alcance

`publisher-v1` es un componente server-side determinista. No usa el runtime LLM, no tiene configuración de modelo, no reserva presupuesto y no llama a Groq. Solo persiste un `PublicationPayload` validado cuando `CriticResult.decision === "pass"`.

## PublicationPayload exacto

El Publisher reutiliza `publicationPayloadSchema` y `PublicationPayload` de `lib/agents/contracts/index.ts` sin crear un contrato paralelo:

```text
{
  schemaVersion: 1,
  eventKey: string,
  event: { canonicalTitle, probableOccurredAt, probableCountryCode, probableRegionCode },
  article: { slug, headlineEs, dekEs, summaryEs, whyItMattersEs, bodyEs, keyPoints },
  sources: [{ sourceId, rawItemId?, sourceName, url, isPrimary, publishedAt }],
  categories: [{ categorySlug, isPrimary, confidenceScore }],
  entities: [{ entityType, canonicalName, countryCode, role, confidenceScore }],
  region: { code, latitude, longitude },
  scores: { impact, novelty, reach, credibility, economicImpact, momentum, importanceScore },
  verification: VerificationResult,
  critic: CriticResult
}
```

Todos los campos son validados con Zod. El Publisher vuelve a comprobar el lineage, el gate del Critic, el guard editorial y la recomputación `ranking-v1` antes de construir el plan.

## Esquema real utilizado

La migración inicial ya contiene estas columnas relevantes:

- `events`: identidad `event_key` (única), título, estado, región, país, fecha, revisión y timestamps.
- `event_sources`: relación existente entre evento, `raw_item` y `source`; el Publisher la reutiliza y no crea una relación sin `raw_item_id`.
- `articles`: contenido editorial, scores, estados, timestamps y `metadata` JSONB.
- `article_categories` y `article_entities`: relaciones con claves primarias compuestas.
- `entities`: identidad exacta por tipo, nombre canónico y país.
- `regions` y `categories`: referencias activas; nunca se crean desde Publisher.
- `activity_history`: agregados por periodo; Publisher no los recalcula.

La base usa estados existentes. Después de publicar, `events` queda `active`/`approved` y `articles` queda `published`/`approved`. La confidence de Verification se convierte de 0–100 a 0–1 para las columnas antiguas de Supabase.

`dekEs` y `keyPoints` no tienen columnas propias en `articles`; se conservan en `articles.metadata` junto con `publisherVersion`. No se guarda `raw_content`, HTML ni el artículo fuente.

La geolocalización se verifica contra `regions.latitude/longitude` y el Geo Resolver. El esquema actual no tiene una columna de provenance geográfica específica; la provenance permanece en el checkpoint y en la validación previa, no se inventa una columna nueva.

## Write plan

`publisher-write-plan.ts` produce un plan explícito antes de cualquier write:

```text
event                 → insert PostgreSQL o reuse bloqueado por event_key
article               → insert/update por event_id
eventSources          → links idempotentes en la misma transacción para eventos nuevos
categories            → resolución exacta contra categorías activas
entities              → reuse o insert exacto por identidad canónica
articleCategories     → upsert por (article_id, category_id)
articleEntities       → upsert por (article_id, entity_id)
activityHistory       → no-op; los agregados pertenecen a otra etapa
```

El modo `dryRun` ejecuta una `preview` read-only y garantiza cero writes. Hay dos identidades distintas:

- `eventKey` es la identidad lógica estable que viaja en el `PublicationPayload`.
- `databaseId`/FK son identidades materializadas de Supabase y solo se incluyen cuando una lectura encuentra una fila real.

`PublisherMaterializationPlan` mantiene `databaseId: null` para un evento o artículo todavía inexistente. En ese caso expresa `event.resolution = would_create` y `article.operation = would_create`; no fabrica UUIDs. Categorías, región y fuentes se resuelven contra los registros activos/existentes y una categoría ausente falla cerrado. Las entidades usan coincidencia exacta por tipo, nombre canónico y país: una entidad existente es `reuse_existing` y una ausente es `would_create`, sin insertarla.

La preview puede ejecutarse dos veces y produce el mismo plan lógico. No llama a `publish_article_atomic` ni ejecuta inserts, updates o deletes.

## Gate, lineage e idempotencia

El Publisher bloquea con `publication_not_approved` cualquier decisión distinta de `pass`, incluyendo todos los `revise_*` y `reject`.

Se exige el mismo `eventKey` en Verification, Translation, Editorial, Classification, Ranking, Critic y PublicationPayload. Los mismatches fallan cerrado.

La identidad estable de publicación es `articles.event_id`, no el slug. La migración `20260916000009_publisher_atomic.sql` añade:

- índice único `articles_event_id_uidx`;
- índice único `entities_identity_uidx` para `(entity_type, canonical_name, coalesce(country_code, ''))`.

La republicación del mismo evento es un update determinista del mismo artículo. Un slug que pertenezca a otro evento provoca conflicto.

Las entidades se resuelven con coincidencia exacta; no se usa fuzzy matching ni se fusionan alias automáticamente.

## Atomicidad y seguridad

Supabase JS no ofrece una transacción multitabla para varias llamadas REST. Por eso la migración crea `public.publish_article_atomic(jsonb)`, una función PostgreSQL `SECURITY DEFINER` con `search_path = public, pg_temp`.

La RPC comprueba el evento, fuentes y relaciones existentes, región y categorías activas, upsert del artículo por `event_id`, categorías, entidades y relaciones, y finalmente actualiza el evento. Cualquier error provoca rollback completo.

La migración `20260921000013_publisher_event_materialization.sql` mantiene `public.publish_article_atomic(jsonb)` como única API y permite que la RPC resuelva o cree el evento por `event_key` dentro de la misma transacción. El UUID de `events.id` lo genera PostgreSQL. Para un evento nuevo, cada source debe aportar `rawItemId` explícito y ese raw item debe pertenecer al source; si falta, la operación falla cerrado. No se busca ni se inventa un raw item.

Si el evento ya existe, se bloquea su fila, se verifica el título y se reutilizan sus `event_sources`; el Publisher no muta arbitrariamente el evento upstream. El artículo mantiene la unicidad por `event_id`, y la RPC devuelve `eventAction`, `articleAction`, ids materializados, entidades creadas/reutilizadas y relaciones creadas. La prueba de integración cubre materialización de evento inexistente, reuse, idempotencia, concurrencia, rollback posterior, referencias inválidas y cleanup.

`EXECUTE` está revocado para `public`, `anon` y `authenticated`, y concedido únicamente a `service_role`. No modifica RLS.

## Checkpoint y replay

`critic-pipeline-checkpoint.ts` define el checkpoint seguro posterior al Critic y lo escribe atómicamente en `artifacts/pipeline-critic-checkpoint.json` después de un Critic SUCCESS y antes del Publisher. No contiene prompts, reasoning, secretos, HTML ni artículos fuente completos.

`npm run publisher:replay-test -- --run-id=<runId> --event-key=<eventKey>` consume el Critic checkpoint de esa ejecución, lee referencias de Supabase y ejecuta la preview materialization. No reconstruye resultados históricos ni inventa IDs. Para checkpoints antiguos sin scores/roles explícitos, la preview usa únicamente una resolución determinista de registry/natural key para completar el payload de validación; esos valores no sustituyen al materializador explícito requerido para una publicación real.

El checkpoint histórico disponible no contiene una `CriticResult` completa persistida, por lo que no se reconstruye automáticamente. El próximo `critic:replay-test` exitoso escribirá el checkpoint mediante el mecanismo preparado.

## Errores y validación

Errores tipados principales: `publication_not_approved`, `publication_lineage_mismatch`, `publication_invalid_category`, `publication_invalid_region`, `publication_ranking_mismatch`, `publication_idempotency_conflict`, `publication_missing_raw_item` y `publication_transaction_failed`.

La integración temporal comprueba publicación, relaciones, republicación idempotente, dos workers concurrentes, rollback tras fallo de relación, reuse de source existente y cero writes en dry-run. Todos los datos de integración tienen event keys y nombres temporales propios y se eliminan al finalizar.
