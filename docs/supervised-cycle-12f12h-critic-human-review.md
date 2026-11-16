# FASE 12F.12H — Critic del mismo intento y primera review

Fecha: 20 de octubre de 2026. Intento: `4658d5c0-857c-4ed5-b97f-afb133b2bf22`.

## Resultado

**Critic PASS**, checkpoint durable **PASS**, prueba **M34 PASS** y **una sola review WAITING creada**, sin consumir.

Review: **ebd8acc0-76a2-4977-81d9-60a7f6240084**.

El intento está completado en **WAITING_FOR_HUMAN_REVIEW**, con **0/0/0** activos/diferidos/atascados. Hay **1/1** reviews/WAITING. Los artículos públicos siguen siendo **2**, Astra sigue **ARCHIVED** y sus fingerprints no cambiaron.

La clasificación de la fase es **TECHNICAL_FAILURE**, y **READY FOR HUMAN ACTION: NO**. La operación posterior a la creación encontró dos defectos de contrato: finalización duplicada del intento y respuesta poblada M32 inspect sin un campo obligatorio. No se debilitó el parser, no se aplicó una migración y no se repitió ninguna mutación.

## OBSERVE → PLAN

Objetivo: reanudar una sola vez el mismo intento desde Critic, conservar los cinco checkpoints previos y su contabilidad, y detenerse tras el resultado de Critic o la primera review válida. Se afecta a la composición del runner y a la ejecución supervisada; no hay cambios visuales o de UX.

- CRITICAL: proteger el único claim/resume y bloquear redispatch de etapas completadas, nuevas candidaturas, publicación y acciones humanas.
- IMPORTANT: el factory de resume omitía el materializador de paquete que la ejecución supervisada normal ya utiliza.
- IGNORE: rediseño, cambios de prompts/etapas/cuotas, ciclos de scheduler, aprobación y publicación.
- Plan: completar gates offline, contrastar el estado mínimo contra 12F.12G.2, usar la admisión unificada actual y el método canónico de resume una sola vez, y verificar el estado final mediante lecturas.

## Cambios locales anteriores a la ejecución

1. `scripts/capacity-resume-production-pipeline.ts`: añade `publicationPayloadFactory: buildPipelinePublicationPayload`, la misma función usada por el runner supervisado normal. Su ausencia habría activado `PIPELINE_PUBLICATION_MATERIALIZER_REQUIRED` en el gateway de review. Esto prepara el paquete de revisión con `publish=false`; no ejecuta Publisher.
2. `scripts/supervised-cycle-12f12h-critic-human-review.mjs`: runner de fase con latch local exclusivo, verificación de hashes de fuentes, contraste dirigido de intento/runs/logs y controles de una sola invocación, claim, request y review.
3. `scripts/supervised-cycle-12f12h-unit-test.mjs`: prueba generación 1 en el orquestador real con repositorio en memoria, PASS/revise_editorial, rechazo de segundo resume, cambios de intento/checkpoint y prueba durable M34 anterior a crear review.

No se cambió código tras ejecutar el resume. Los defectos descubiertos después se documentan para cierre posterior, conservando el runner ejecutado y su evidencia original.

## Gates locales

**19 suites PASS** antes de cualquier mutación remota:

- Generación 1 Critic-only y controles de fase.
- Request-cap contract, cuotas y contabilidad de tokens.
- Groq unified admission y bootstrap TPM.
- M35 claim/resume y Verifier-first.
- M36 accounting window, contratos/fixtures SQL offline.
- Checkpoints durables, Critic schema/decision mapping/checkpoint.
- M34 same-attempt proof.
- Human review única y parada sin Publisher.
- M32 status/list/inspect en fixtures.
- Throughput, wiring, construcción normal/resume y observabilidad del runner.

`npm run lint`, `npx tsc --noEmit`, `npm run build`, `git diff --check` y secret audit: **PASS**. Hallazgos de secretos: 0; .env.local ignorado.

El build inicial falló con EPERM al crear un directorio de prerender en .next; el mismo build pasó fuera del sandbox. Las suites con fixtures temporales se ejecutaron offline en host cuando necesitaban renombrados que el sandbox bloquea. No se ejecutó SQL en PostgreSQL local ni se aplicó migración remota.

Warnings ya observados: Node type stripping experimental/tipo de módulo; NEXT_PUBLIC_SITE_URL ausente o inválido y metadata de indexación desactivada en el build. UI, responsive y temas no aplican.

Gates y hashes de las 11 fuentes relevantes quedaron en `artifacts/supervised-cycle-12f12h-local-gates.json` y se verificaron antes de ejecutar.

## Pre-claim y capacidad actual

No se ejecutó otra preflight diagnóstica: **0**.

Las lecturas dirigidas contrastaron el intento y los runs/logs de ese pipeline con los hashes de 12F.12G.2. Coincidieron estado diferido, etapa Critic, generación 1, retry-neutral, evento y pipeline_run. Los cinco checkpoints mantuvieron sus hashes y Critic estaba ausente/no despachado.

Evento: `event-5c7d0ef5ea6f72bec96704aded750851`.

Pipeline run: `f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d`.

Presupuesto restaurado: **5 usados / 18 máximo / 13 restantes**. RPD hard/soft independientes: **1000/850**. El ledger Groq del día tenía 0 reservas antes de esta fase. Concurrencia 1, retries 0 y fallback 0.

La reserva canónica M35/M36 admitió el request:

| Dimensión | Evidencia actual |
| --- | --- |
| RPD | 0 → 1; hard 1000 / soft 850 |
| TPD | 0 → 7018 tokens reservados; hard 200000 / soft 170000 |
| TPM | Ventana recalculada: 0 → 7018; hard 8000; margen 128 |
| RPM | Límite de producción 30; una sola llamada, camino unificado y concurrencia 1 |
| Estado usable del proveedor | Evaluado por AgentRunner y la política unificada actual |

Reserva ID **1063**, admitida sin reutilizar una ventana TPM antigua. La llamada obtuvo HTTP 200 y su uso real quedó settled.

## Ejecución única

Comando ejecutado una sola vez:

```text
node --env-file-if-exists=.env.local --conditions=react-server --experimental-strip-types scripts/supervised-cycle-12f12h-critic-human-review.mjs --execute-once
```

Camino: `createCapacityResumeProductionPipeline → createProductionPipeline → PipelineOrchestrator.resumeCapacityDeferred`.

- Resume invocations: **1**.
- Claim requests/successful claims: **1/1**.
- Generación antes/después del claim/final: **1/1/1**.
- Verifier, Translator, Editor, Classifier y Ranker: **0 dispatches nuevos**.
- Critic: **1 reserva, 1 dispatch, 1 llamada Groq**.
- Checkpoint Critic: **PASS durable**.
- Reviews creadas: **1**.
- Publisher, scheduler, triggers nuevos, intentos nuevos, acciones humanas y migraciones: **0**.

El request despachado permanece contabilizado. El presupuesto de ejecución final es **6 usados / 18 máximo / 12 restantes**.

## Critic durable y M34

Critic decidió **pass**. El checkpoint durable se persistió antes de invocar create_pipeline_human_review y se volvió a leer para validar:

- Same attempt, event y pipeline_run.
- Decisión pass durable.
- Identidad de prueba: `f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d:4658d5c0-857c-4ed5-b97f-afb133b2bf22:critic:event-5c7d0ef5ea6f72bec96704aded750851`.
- SHA-256 Critic: `2f0888dfaff2bf695e9e2475a1b6630af983e413a316b563a5df60f3aa42d2be`.
- El RPC de creación aceptó la prueba M34 y la review persistida declara critic_pass=true y provider_usage_settled=true.

Las lecturas M32 list y el contenido de inspect coinciden en esa identidad/hash y en el intento, evento y pipeline_run. La review requiere revisión factual y de atribución humana. No tiene acción editorial y consumed_at es null.

## Defectos descubiertos y STOP técnico

### Finalización duplicada posterior a la creación atómica

El RPC `create_pipeline_human_review` ya completa el intento como WAITING_FOR_HUMAN_REVIEW dentro de su transacción. Esto está en `supabase/migrations/20261005194000_supervised_human_review_gate.sql:344`.

Después, `PipelineOrchestrator.resumeCapacityDeferred` llama de nuevo a `registry.finalize`, en `lib/agents/pipeline/pipeline-orchestrator.ts:636`.

Ese segundo finalize devolvió **HTTP 400 / P0001 / “attempt is not owned or already finalized”**. El método de resume lanzó `EVENT_ATTEMPT_FINALIZE_FAILED:P0001` en lugar de devolver su resultado. El finally intentó la liberación soportada del ownership; la lectura posterior confirmó que el intento seguía completado en WAITING, sin quedar ACTIVE.

No se volvió a finalizar ni se mutó el intento manualmente. La decisión PASS se recuperó de la evidencia durable y el estado remoto, sin repetir Critic.

### M32 inspect omite source_lineage_sha256

M32 status y list: **PASS**. M32 inspect: **HTTP 200 / found=true**, pero **FAIL del parser canónico**:

```text
HUMAN_REVIEW_OPERATOR_INSPECT_INVALID
missing field: review.source_lineage_sha256
```

La función SQL de inspect en `supabase/migrations/20261007215233_human_review_operator_read_rpc.sql:156` omite ese campo; el parser lo exige a través de summaryRowSchema en `lib/agents/publisher/human-review-read-repository.ts`.

El hash sí existe en el manifest de inspect y coincide con el hash explícito de M32 list. Se comprobaron esas vinculaciones para documentar el estado real, **sin rellenar el campo faltante ni considerar PASS al parser que lo rechazó**.

Una lectura inspect adicional, limitada a esa review, confirmó el defecto. El cierre posterior hizo solo 7 lecturas soportadas para confirmar target, status/list y contabilidad. No hubo segunda invocación, claim, dispatch, creación de review o escritura remota.

Por no cumplirse M32 status/list/inspect PASS en su conjunto, **READY FOR HUMAN ACTION permanece NO**. No se aplicó una migración ni un fix adicional de runtime en esta fase.

## Contabilidad

| Concepto | Antes | Nuevo 12F.12H | Acumulado |
| --- | --- | --- | --- |
| Requests despachados | 5 | 1 | 6 |
| Input tokens | 6748 | 2392 | 9140 |
| Output tokens | 1617 | 35 | 1652 |
| Total tokens | 8365 | 2427 | 10792 |

Nuevas reservas: **1**. Unknown reservations: **0**. Retries/fallback: **0/0**. Cloudflare/Cerebras: **0/0**.

El ledger persistente Groq del día confirma exactamente 1 reserva, 1 dispatch y 2427 tokens settled. Los cinco requests históricos se conservaron aunque corresponden a contabilidad anterior. Total 6 ≤ 18.

## Estado final de solo lectura

| Campo | Valor |
| --- | --- |
| Intentos | 19 |
| Estado del intento | WAITING_FOR_HUMAN_REVIEW |
| Activos / diferidos / atascados | 0 / 0 / 0 |
| Reviews / WAITING | 1 / 1 |
| Review ID | ebd8acc0-76a2-4977-81d9-60a7f6240084 |
| Review status / consumed | WAITING / false |
| Critic / checkpoint / M34 | PASS / PASS / PASS |
| M32 status / list / inspect | PASS / PASS / FAIL |
| Públicos | 2 |
| Astra | ARCHIVED |
| Fingerprints | UNCHANGED |
| Reservas desconocidas | 0 |
| Scheduler | UNCHANGED |
| Publisher | NOT RUN |
| Clasificación de fase | TECHNICAL_FAILURE |
| READY FOR HUMAN ACTION | NO |

Los checkpoints previos permanecen idénticos. No se realizó revisión humana, APPROVE, HOLD, REJECT ni publicación.

## Evidencia y verificación final

- `artifacts/supervised-cycle-12f12h-critic-human-review.json`: evidencia final con estado durable y cierre de solo lectura.
- `artifacts/supervised-cycle-12f12h-execution-result.json`: salida original del único runner, preservada antes de completar el cierre de lecturas.
- `artifacts/supervised-cycle-12f12h-inspect-response.json`: respuesta inspect para reproducir el fallo del parser, sin secretos.
- `artifacts/supervised-cycle-12f12h-invocation.json`: latch de única invocación.
- `artifacts/supervised-cycle-12f12h-local-gates.json`: suites, gates y hashes previos.

Se revisaron coherencia del artefacto final, diff y secretos tras crear la documentación. Las pruebas locales no sustituyen a la validación real: el fallo M32 poblado y la finalización redundante quedaron registrados expresamente.

**STOP. NO SEGUNDO RESUME. NO REVISIÓN HUMANA NI PUBLICACIÓN.**
