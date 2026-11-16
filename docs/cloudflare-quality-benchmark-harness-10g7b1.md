# REAL-CASE QUALITY BENCHMARK HARNESS — 10G.7b.1

Preparación solamente. Esta fase hizo cero inferencias, cero llamadas a Groq/Cloudflare/Cerebras y cero escrituras remotas. El preflight también informa cero lecturas remotas. No modifica gates ni activa routing.

## WHY 10G.7b STOPPED

10G.7b se detuvo antes de inferir porque la validación supervisada existente admite fixtures sintéticos canónicos, no los linajes históricos Ars y MIT. Etiquetar esos datos reales como un fixture sintético habría falseado la identidad autorizada. El executor existente de snapshots tampoco sirve: ejecuta el pipeline completo y puede entrar en intentos y lógica de revisión de producción.

## ALLOWLIST ROOT CAUSE

El bloqueo está en **BOTH** TypeScript y la base de datos. `lib/agents/runtime/cloudflare-stage-validation.ts` fija un fixture, etapa y versión por agente. La migración 24 repite esas parejas y el propósito `${stage}_stage_validation` en `reserve_cloudflare_supervised_stage_validation_capacity`. Los runners de Verifier, Translator, Editor, Classifier y Ranker usan esas identidades sintéticas; `scripts/critic-cloudflare-validation.ts` construye `canonicalCriticInput` para el control sintético de Critic. No existe una identidad de caso Ars/MIT en esa autorización. Esta preparación conserva esas reglas sin cambios.

## BENCHMARK PURPOSE

El propósito separado es `quality_benchmark`. Los IDs de caso son `quality:ars-problematic-lineage-v1` y `quality:mit-clean-control-v1`; son casos históricos, no nombres de fixture sintético. El executor llama una instancia del agente de producción por pareja permitida. No recorre etapas vecinas ni invoca pipeline, scheduler, Publisher, revisión, materialización de eventos o publicación.

## ARS CASE

- Tipo `PROBLEM_CASE`, proveedor histórico `CONFIRMED_GROQ`, una fuente y trazabilidad raw item `AVAILABLE`.
- Raw item `93dea107-8bbf-42a5-8314-c0b4c70522ec`; SHA-256 de contenido `7aa373cdeeb56947806f21460d97042739cd62f7f8d3dd812c0a41d9e7dd7f84`. El cuerpo extraído permanece en el registro histórico; no se copia a este documento ni al plan.
- La salida histórica de Critic fue `revise_editorial`, con un finding `UNSUPPORTED_CLAIM_EDITORIAL` de severidad `high`. Es una referencia histórica, no una respuesta exacta exigida al nuevo modelo.
- Verifier se puede reconstruir determinísticamente solo tras leer la fila exacta `raw_items` y comprobar ID, fuente, external ID y hash guardado. El preflight no hace esa lectura. El hash del input Verifier queda pendiente hasta la lectura futura.
- El input de Translator se reconstruye y su hash coincide con el `translatorModelInput` guardado. Editor, Classifier, Ranker y Critic se proyectan de checkpoints almacenados sin volver a ejecutar etapas previas. Sus hashes describen las proyecciones del benchmark; salvo Translator, no prueban identidad byte por byte con el input histórico.

## MIT CASE

- Tipo `CLEAN_CONTROL`, proveedor histórico `CONFIRMED_GROQ`, una fuente y trazabilidad raw item `MISSING`.
- No hay asociación `rawItemId` verificable en el checkpoint. No se crea ni se inventa una.
- Verifier queda `MISSING`; los demás inputs se construyen desde sus checkpoints. El input de Critic pasa esquema y prechecks deterministas: `CRITIC_CONTROL_USABLE=true`.
- El resultado histórico de Critic fue `pass`, cero findings. Es un control histórico, no una etiqueta gold; sin el raw item no se puede auditar contra el artículo original.

## STAGE INPUT AVAILABILITY

| Caso | Verifier | Translator | Editor | Classifier | Ranker | Critic |
| --- | --- | --- | --- | --- | --- | --- |
| Ars | `INPUT_CAN_BE_DETERMINISTICALLY_RECONSTRUCTED` | `READY_FROM_STORED_INPUT` | `READY_FROM_STORED_INPUT` | `READY_FROM_STORED_INPUT` | `READY_FROM_STORED_INPUT` | `READY_FROM_STORED_INPUT` |
| MIT | `MISSING` | `READY_FROM_STORED_INPUT` | `READY_FROM_STORED_INPUT` | `READY_FROM_STORED_INPUT` | `READY_FROM_STORED_INPUT` | `READY_FROM_STORED_INPUT` |

Classifier usa el conjunto local auditado de regiones y categorías; el orden/snapshot histórico del registry no se guardó. Ranker recibe el tiempo de referencia guardado y no usa un historial de actividad ausente. Critic valida el input reconstruido con sus prechecks antes de cualquier futura llamada.

## HISTORICAL GROQ PROVENANCE

Los artefactos de auditoría vinculan los dos linajes con `provider=groq`, modelo `openai/gpt-oss-20b`, HTTP 200 y salida Zod válida. En los dos Critic hubo también un intento histórico 429 anterior; el checkpoint seleccionado corresponde a una ejecución exitosa. Los outputs se muestran como resúmenes acotados, con hashes y referencias de archivo, no como copias completas de artículos.

## ISOLATED EXECUTOR

`scripts/cloudflare-quality-benchmark.ts` usa las implementaciones reales de los seis agentes, un override explícito al modelo Cloudflare aprobado, `dryRun=true`, logger supervisado y reserva provider-scoped antes del dispatch. Una llamada fallida por motivo técnico detiene las llamadas siguientes y conserva el contador del dispatch incluso si la etapa falla después de llamar al proveedor. No hay retries, repairs ni fallbacks. Esta fase no reserva ni liquida Neurons; el runner mantiene su ciclo de reserva/dispatch normal y la liquidación existente es específica de Groq. Una revisión semántica pendiente queda capturada para revisión humana mientras se continúa con las etapas independientes.

## AUTHORIZATION

Cada llamada futura requiere `purpose=quality_benchmark`, un case ID y etapa de la pareja fija, versión correspondiente, `provider=cloudflare_workers_ai`, modelo `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `attempt=1`, `maxRetries=0` y un run `other` en dry-run. El hash de input aporta reproducibilidad, pero nunca autoriza por sí solo. La ruta local y la RPC aplican allowlists exactas.

## MIGRATION DECISION

**`MIGRATION_REQUIRED`.** La ruta RPC actual solo puede reservar capacidad para fixtures sintéticos y propósitos `stage_validation`; no hay una autorización remota de capacidad para los casos históricos reales. Se preparó `supabase/migrations/20260927000026_cloudflare_quality_benchmark_authorization.sql`, una función RPC aditiva y una definición tipada. **No se aplicó. No requiere tabla nueva.** La RPC crea solo una reserva en `agent_logs` después de comprobar el run de benchmark.

## SECURITY

La RPC exige `service_role`, revoca ejecución a `public`, `anon` y `authenticated`, usa `search_path = pg_catalog, pg_temp` y referencias `public.*` calificadas. No usa SQL dinámico. Fija case/stage, agente/versión, propósito, proveedor, modelo, intento y clave de contabilidad; limita el ledger Cloudflare compartido y el benchmark a ocho reservas. No cambia RLS ni tablas de publicación, y no debilita la autorización sintética.

## COPYRIGHT

El manifiesto conserva solo IDs, hashes, paths locales, estados, resúmenes acotados y un inventario factual breve para revisión. Ars describe en una frase el riesgo central de la falla Muse y en otra el claim editorial sin soporte. MIT resume la propuesta sobre datasets de biotecnología y deja clara la falta de fuente primaria enlazada. No se vuelca texto completo de artículos. El resultado del Translator omite `translatedSourceMaterial` en el futuro artefacto de revisión.

## CLI SAFETY

Sin argumentos o con `--preflight`, el CLI solo escribe el plan local. Cualquier otro argumento falla cerrado. Las llamadas futuras requieren explícitamente `--execute-quality-benchmark`; antes de ello valida el plan/hashes, configuración, capacity y router desactivado. En esta fase no se usó ese flag. El test offline comprueba que el modo por defecto hace cero llamadas y lecturas/escrituras remotas.

## PLANNED CALLS

Se representan siete llamadas independientes: Ars Verifier, Translator, Editor, Classifier, Ranker y Critic; MIT Critic. MIT Verifier se omite porque la trazabilidad raw item falta. MIT Translator, Editor, Classifier y Ranker tienen inputs disponibles, pero quedan fuera del plan pedido. El límite duro futuro es ocho llamadas, una por pareja; los inputs vienen de sus checkpoints correspondientes, no de outputs Cloudflare previos. El plan y la plantilla de revisión dejan `cloudflareOutput=NOT_RUN`, preguntas humanas y decisión `PENDING_NO_WINNER`.

## MULTI-SOURCE LIMITATION

Ambos casos tienen una sola fuente. No certifican corroboración, consistencia entre fuentes ni calibración de confianza multi-source. `REAL_MULTI_SOURCE_QUALITY_EVIDENCE=MISSING` permanece explícito.

## NEXT STEP

Después de revisar este plan, la siguiente fase es `10G.7b.2 — APPLY + REMOTE VALIDATE QUALITY BENCHMARK AUTHORIZATION`. Esta fase se detiene aquí: no aplica la migración, no lee la fila raw remota, no ejecuta benchmark y no inicia la siguiente fase.
