# Autorización remota del benchmark Cloudflare — 10G.7b.2

La fase aplicó la migración 26 y validó la autorización remota sin inferencia, sin reservas de capacidad y sin crear runs de prueba. No se creó migración 27. No se modificó ningún gate.

## PRE-APPLY AUDIT

Se leyó completa `supabase/migrations/20260927000026_cloudflare_quality_benchmark_authorization.sql`. Es una migración aditiva que define una sola función; no crea tablas ni cambia tablas de producción, RLS, Publisher, scheduler o publicación. No contiene artículos, fuentes, drafts ni prompts. Fija propósito, dos case IDs, parejas permitidas, versiones, proveedor, modelo, intento y clave de contabilidad. No admite IDs, etapas ni modelos comodín. Usa `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`, nombres `public.*` calificados y no usa SQL dinámico. Revoca ejecución a `public`, `anon` y `authenticated`; concede ejecución a `service_role`.

Pasaron antes de aplicar las pruebas offline `provider:migration:unit`, `cloudflare:quality-benchmark:unit` y `provider:cloudflare:stage:unit`.

## REMOTE MIGRATION STATE

La lista de proyectos remotos identificó **HorizAI**, ref `skrthgpurquypgdwxast`, estado `ACTIVE_HEALTHY`. El ref enlazado y el ref de la URL configurada coincidían. `npx supabase migration list --linked` confirmó antes de la mutación: versión 25 aplicada, 26 pendiente, última remota `20260925000025`. No había migración 27 local.

## APPLY

Se aplicó solo `20260927000026_cloudflare_quality_benchmark_authorization.sql` mediante `supabase migration up --linked`, que tenía como única pendiente local la 26. La salida confirmó esa única migración aplicada. La comprobación posterior muestra 25 y 26 aplicadas; la última versión remota es `20260927000026`. No se aplicó reparación ni rollback.

## REMOTE OBJECTS

La introspección PostgreSQL posterior confirmó:

- Función: `public.reserve_cloudflare_quality_benchmark_capacity(uuid, text, text, text, text, text, integer, text, text, text, date, integer, bigint, bigint) returns jsonb`.
- Owner `postgres`; `SECURITY DEFINER=true`; `search_path=pg_catalog, pg_temp`.
- ACL efectiva: `postgres` y `service_role` tienen `EXECUTE`; `has_function_privilege` devuelve `false` para `anon` y `authenticated`.
- Hash MD5 de `pg_get_functiondef`: `6fddfff31567ae9a8c1a9f55a2965afe`.
- Las RPC preexistentes de capacidad Cloudflare, Critic supervisado y validación supervisada conservaron sus hashes de definición, owner, ACL y search path anteriores.

La nueva función reserva únicamente en `agent_logs` tras comprobar un `agent_run` provider-matched, `run_type=other`, `dry_run=true` y la identidad del benchmark. No modifica tablas de artículos ni crea intentos de pipeline.

## SECURITY

El servicio `SUPABASE_SECRET_KEY` usado por el cliente server alcanzó las verificaciones de identidad con claim `service_role`. Para validar sin insertar una reserva, cada llamada positiva se hizo con `p_run_id=null`: la función aceptó la identidad y terminó en el guard `provider-matched dry-run quality benchmark run is required`, antes de cualquier lectura de capacidad o escritura. La introspección ACL verificó `service_role=true`, `anon=false` y `authenticated=false`. No se crearon filas de usuario para probar el rol autenticado.

## CANONICAL VALIDATION REGRESSION

La RPC de la migración 24 aceptó la identidad del fixture canónico `translator:unit:gpt-5-launch-2026` y llegó al guard de run ausente. La misma RPC rechazó el ID real `quality:ars-problematic-lineage-v1` cuando se presentó como fixture canónico. Ambos tests terminaron con `p_run_id=null`; no crearon una reserva ni despacharon un modelo. La allowlist sintética sigue intacta.

## QUALITY BENCHMARK AUTHORIZATION

El propósito remoto es `quality_benchmark`; el proveedor es `cloudflare_workers_ai` y el modelo único es `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Las llamadas positivas comprobaron remotamente la puerta de identidad del case ID, etapa, agente/versión, propósito, proveedor, modelo, evento e intento. Al dejar `p_run_id=null`, no se probó ni ejecutó una reserva de capacidad; esa prueba requeriría crear una reserva que esta fase prohíbe.

## ARS MATRIX

Las seis parejas se aceptaron en la puerta de identidad remota y terminaron en el guard sin run: Verifier, Translator, Editor, Classifier, Ranker y Critic. Cada llamada quedó sin filas ni reserva.

## MIT MATRIX

MIT + Critic pasó la puerta de identidad y terminó en el guard sin run. MIT + Verifier fue rechazado como combinación caso/etapa. La falta de trazabilidad raw item sigue sin backfill.

## INVALID CASES

Se rechazaron `quality:unknown-case-v1`, MIT + Verifier, propósito `translator_stage_validation` para un caso real, proveedor `groq`, otro modelo Cloudflare y una versión de agente incorrecta. No hay wildcard authorization.

## PROVIDER/MODEL RESTRICTIONS

La matriz válida solo aceptó `cloudflare_workers_ai` con `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Los intentos remotos con Groq y con `@cf/meta/llama-3.1-8b-instruct` recibieron rechazo de identidad. No se contactó ningún endpoint de inferencia.

## PRODUCTION ISOLATION

Conteos antes y después: `articles=0`, `events=0`, `raw_items=150`, `pipeline_event_attempts=3`, `scheduler_runs=1`, `event_sources=0`, `article_entities=0`, `article_categories=0`. Coinciden exactamente. La migración no crea tablas nuevas. Los tests no crean `agent_runs`, intentos de producción, publicaciones, eventos ni filas sintéticas residuales.

## ACCOUNTING ISOLATION

El ledger UTC del día permaneció igual: reservas Cloudflare 0, dispatches Cloudflare 0, Neurons reservadas 0; reservas y dispatches Groq 0, tokens Groq reservados 0; reservas Cerebras 0. La delta de cada contador es cero. No se crearon reservas falsas para probar permisos.

## TYPESCRIPT/DB CONSISTENCY

La allowlist TypeScript y la RPC remota coinciden: Ars permite seis etapas; MIT permite solo Critic. Ambas restringen el propósito y el proveedor/modelo aprobados; MIT Verifier, IDs desconocidos y fixtures mal etiquetados se rechazan. `REAL_MULTI_SOURCE_QUALITY_EVIDENCE=MISSING` sigue vigente.

## CLI PREFLIGHT

`npm run cloudflare:quality-benchmark` sin flag produjo `PREFLIGHT_ONLY`, 7 llamadas planificadas (Ars 6, MIT 1), máximo 8, Verifier MIT omitido por `rawItemTraceability=MISSING`, cero llamadas, cero lecturas remotas y cero escrituras remotas. El executor requiere `--execute-quality-benchmark`; el validador remoto requiere su propia bandera explícita de solo lectura. Los flags desconocidos fallan cerrado.

## CLEANUP

No se crearon fixtures, runs ni reservas, por lo que no hubo filas que borrar. Conteos posteriores: runs con propósito `quality_benchmark=0`, reservas de benchmark `0`, filas/logs etiquetados `10g7b2=0`. La migración 26 permanece aplicada.

## LIMITATIONS

La prueba positiva confirma el paso de autorización de identidad con el rol de servicio y el rechazo posterior por ausencia de un run válido; deliberadamente no atraviesa el guard de capacidad que insertaría una reserva. La seguridad de `anon` y `authenticated` se comprobó por ACL efectiva. La prueba no ejecutó inferencia ni vuelve a demostrar calidad semántica. El benchmark futuro conserva siete llamadas y la limitación multi-source.

## NEXT STEP

Las regresiones offline posteriores a la aplicación pasaron. Gates sin cambios: `technicalAllStagesValidated=true`, `semanticQualityGateValidated=false`, `qualityBenchmarkCompleted=false`, `humanQualityDecisionRequired=true`, `capacityProductionReady=false`, `schedulerThroughputReady=false`, `productionRoutingEnabled=false`.

Siguiente: `10G.7b.3 — EXECUTE MINIMAL REAL CLOUDFLARE QUALITY BENCHMARK`. No se ejecuta automáticamente en esta fase.
