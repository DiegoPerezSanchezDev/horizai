# Esquema de datos de HorizAI — Fase 8A

## Objetivo y alcance

Esta propuesta deja preparado el backend de datos para el futuro pipeline de agentes. La aplicación sigue utilizando sus mocks actuales: en esta fase no se instala un cliente Supabase, no se conecta la UI, no se implementan agentes y no se hace scraping.

La relación principal es:

```text
sources ──< raw_items ──< event_sources >── events ──< articles
                                      │                    │
                                      │                    ├──< article_categories >── categories
                                      │                    └──< article_entities >──── entities
                                      │
regions ──< activity_history >── agent_runs ──< agent_logs
```

`event_sources` conserva la evidencia que relaciona un evento con una o varias piezas de origen. `articles` es la representación editorial en español de un evento; las tablas de categorías y entidades permiten clasificar sin repetir datos.

## Decisiones principales

- **UUID para entidades de dominio y ejecuciones.** Permite generar registros desde workers distribuidos sin depender de una secuencia compartida. `agent_logs.id` usa identidad `bigint`, adecuada para una tabla de alto volumen y siempre ligada a `agent_runs`.
- **`timestamptz` en todos los momentos operativos.** Se almacenan en UTC y se dejan explícitos `created_at`/`updated_at` en todas las tablas, incluidas las relaciones.
- **Estados como `text` con `CHECK`.** Evita crear enums demasiado pronto, pero impide valores inválidos en los estados conocidos. Si el pipeline crece, las listas pueden evolucionar en una migración posterior.
- **Deduplicación en dos niveles.** `raw_items` tiene hash de contenido único por fuente y conserva URL original/canónica. `event_sources` permite consolidar varias fuentes en un mismo evento, con una sola fuente primaria por evento.
- **Trazabilidad y reintentos.** `raw_items` conserva intentos, próxima reejecución y error; `events` conserva payload de clasificación y revisión; `articles` conserva estado y notas del Critic; `agent_runs` y `agent_logs` registran ejecución, configuración, estadísticas y mensajes.
- **JSONB acotado a payloads.** `metadata`, `normalized_payload`, `classification_payload`, `stats`, `config` y `payload` permiten conservar contexto del pipeline sin convertir el modelo en un documento sin estructura. Los campos principales siguen siendo columnas consultables.
- **Integridad referencial conservadora.** Se restringe el borrado de fuentes, eventos, categorías y entidades para no perder trazabilidad; las relaciones N:N se eliminan en cascada. La región principal de un evento y la ejecución de cálculo de actividad pasan a `NULL` si se elimina la referencia.
- **RLS pendiente de decisión de acceso.** No se activan políticas en esta fase porque todavía no existe un modelo de autenticación ni una superficie conectada. El `SUPABASE_SECRET_KEY` queda reservado para procesos server-side y no debe exponerse al cliente.

## Tablas

| Tabla | Responsabilidad | Campos de pipeline destacados |
| --- | --- | --- |
| `sources` | Catálogo de fuentes de información | homepage, feed URL, método de descubrimiento, prioridad, actividad, frecuencia, última ejecución y fallos consecutivos |
| `raw_items` | Captura normalizable de cada hallazgo | URL, hash, contenido bruto, calidad de extracción, estado, intentos, retry y error |
| `events` | Agrupación canónica de hechos | `event_key` lógico único, confianza, región/país, momento, clasificación y revisión |
| `event_sources` | Evidencia y procedencia de un evento | fuente primaria y FKs a evento, raw item y source |
| `articles` | Salida editorial en español | textos, importancia, confianza, Critic, revisiones y publicación |
| `regions` | Catálogo geográfico | código, nombre y coordenadas para mapa/agregaciones |
| `categories` | Catálogo editorial | slug, nombre y activación |
| `article_categories` | Clasificación N:N de artículos | categoría primaria y confianza |
| `entities` | Personas, organizaciones, modelos y productos normalizados | tipo, nombre canónico, alias, país, revisión y metadata |
| `article_entities` | Entidades mencionadas en un artículo | rol y confianza |
| `activity_history` | Serie agregada para actividad regional | periodo, score, conteos, versión de cálculo y run de origen |
| `agent_runs` | Una ejecución de pipeline | tipo, estado, dry-run, configuración, estadísticas y error |
| `agent_logs` | Log detallado de una ejecución | agente, paso, nivel, mensaje, payload y duración |

## Índices

- `sources_active_priority_idx`: seleccionar fuentes activas por prioridad para una cola de ingesta.
- `sources_active_discovery_priority_idx` y `sources_feed_url_uidx`: seleccionar feeds configurados y evitar registrar dos veces el mismo endpoint.
- `raw_items_pending_retry_idx`: localizar pendientes y reintentos vencidos; `raw_items_source_published_idx` y `raw_items_canonical_url_idx`: consultas de procedencia y deduplicación.
- `raw_items_extraction_status_idx`: localizar estados y calidades de extracción para reintentos controlados.
- `raw_items_source_hash_uidx`: evita reingresar el mismo contenido dentro de una fuente.
- `events_status_occurred_idx`, `events_region_occurred_idx` y `events_review_status_idx`: cola editorial, mapa y revisión.
- `events_event_key_unique`: permite upsert idempotente de un acontecimiento lógico.
- `event_sources_raw_item_idx`/`event_sources_source_idx`: navegar desde evidencia a evento y fuente.
- `event_sources_primary_uidx`: garantiza una sola fuente primaria por evento.
- `articles_publication_idx`, `articles_event_idx`, `articles_critic_idx` y `articles_importance_idx`: publicación, detalle, Critic y selección editorial.
- `article_categories_category_idx`/`article_entities_entity_idx`: navegación inversa de las relaciones N:N; índices parciales de primaria garantizan una categoría primaria por artículo.
- `activity_history_*`: series temporales por región/categoría, vínculo a ejecución y unicidad del mismo periodo.
- `agent_runs_*` y `agent_logs_*`: monitorización de ejecuciones y lectura cronológica de logs; las reservas de requests usan `agent_logs_run_created_idx` y el paso `provider_request_reserved`.

## Migraciones y seed

- `supabase/migrations/20260912000000_initial_schema.sql` crea extensión, función de timestamps, las 13 tablas, constraints, FKs, índices y triggers.
- `supabase/migrations/20260912000001_seed_reference_data.sql` inserta 11 regiones, 8 categorías y 15 fuentes de ejemplo. Usa `ON CONFLICT`, por lo que puede repetirse de forma segura.
- `supabase/migrations/20260912000002_source_registry_fields.sql` separa homepage/feed y registra el método y salud del descubrimiento.
- `supabase/migrations/20260912000003_extraction_fields.sql` añade calidad/fecha de extracción y estados específicos a `raw_items`.
- `supabase/migrations/20260912000004_event_key.sql` añade la clave lógica y su formato; `20260912000005_event_key_upsert_constraint.sql` la convierte en constraint `UNIQUE` inferible por upsert.
- `supabase/migrations/20260913000006_persistent_agent_request_budget.sql` añade la función `reserve_agent_request`, que cuenta reservas diarias UTC en `agent_logs` bajo advisory lock. Solo `service_role` puede ejecutarla; una respuesta no determinable bloquea el runtime.

Para aplicar en un proyecto Supabase se usa `npm run supabase:db:push`. La migración de presupuesto no cambia RLS ni expone ningún secreto.

## Tipos TypeScript

`types/database.ts` contiene `Database`, filas `Row`, entradas `Insert`, actualizaciones `Update`, la firma tipada de `reserve_agent_request` y helpers `Tables`, `TablesInsert` y `TablesUpdate`.
