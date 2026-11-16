# FASE 12F.12G.2 — Contrato de límites de requests

Fecha: 20 de octubre de 2026. Intento: `4658d5c0-857c-4ed5-b97f-afb133b2bf22`.

## Resultado

Clasificación única de causa raíz: **PROVIDER_RPD_EXECUTION_CAP_CONFLATION**.

La aserción anterior comparaba `production.dailyRequestLimit` (**RPD de Groq: 1000**) con el límite de reservas de una ejecución supervisada (**18**). Son dominios distintos. El fallo estaba en la validación del preflight; los guards de ejecución ya aplicaban ambos límites de forma independiente.

La corrección conserva RPD **1000**, soft RPD **850**, cap supervisado **18**, concurrencia **1**, retries **0** y fallback **0**. No cambia entorno, cuotas, contabilidad del proveedor, prompts, etapas ni esquema.

Después de todos los gates locales se ejecutó **exactamente un preflight canónico de solo lectura**: **PASS**, 16 solicitudes de lectura, ninguna escritura remota. No hubo claim ni resume.

| Dominio | Valor validado |
| --- | --- |
| PROVIDER_RPD_HARD_LIMIT | 1000 |
| PROVIDER_RPD_SOFT_LIMIT | 850 |
| SUPERVISED_EXECUTION_REQUEST_CAP | 18 |
| CUMULATIVE_ATTEMPT_REQUEST_USAGE | 5 |
| Remaining execution requests | 13 |

**READY FOR CRITIC RESUME: YES**, según la evidencia del preflight. **No se ha reanudado Critic.**

## OBSERVE → PLAN

Objetivo: recuperar la preflight sin equiparar una cuota diaria del proveedor con el presupuesto de una ejecución. Se afecta al diagnóstico y a su vista de contabilidad local; no hay intervención visual o de UX.

- CRITICAL: `DAILY_REQUEST_CAP_MISMATCH: 1000 !== 18` bloqueaba una configuración válida.
- IMPORTANT: el runner duplicaba el literal 18 y sembraba cinco reservas mediante un literal, aunque existían política canónica y contabilidad durable.
- IGNORE: cambiar cualquiera de los límites, red/DNS, scheduler, prompts, etapas, publicación o schema.
- Plan: separar campos, consumir la constante existente, reconstruir el uso del snapshot validado, probar continuidad y límites independientes, completar gates y consumir una única invocación remota con retorno antes de claim/resume.

## A. Procedencia exacta de 1000

1. `lib/agents/runtime/request-budget.ts:11`, función `resolveGroqDailyRequestHardCap`: lee **GROQ_DAILY_REQUEST_HARD_CAP** del entorno normal de Node. La resolución actual devuelve `{ limit: 1000, source: GROQ_DAILY_REQUEST_HARD_CAP }`.
2. La precedencia es clave canónica, fallback legado AGENT_DAILY_REQUEST_LIMIT y default seguro. En esta ejecución **no se usó fallback/default**.
3. `MAX_GROQ_DAILY_REQUEST_HARD_LIMIT=1000` es el techo permitido para validar la configuración; no sustituye a la clave explícita que produjo el valor actual.
4. `readGroqDailyRequestHardCap` entrega el valor a `getVerifierModelConfig`, en `lib/agents/verifier/verifier-agent.ts:60`, como `ModelConfig.dailyRequestLimit`.
5. `productionConfigs` conserva ese valor. `createProductionPipeline.preflight`, en `lib/agents/pipeline/create-production-pipeline.ts:312`, lo devuelve como `dailyRequestLimit: configs.verifier.dailyRequestLimit`.
6. Antes del fix, `baselineRead` en `scripts/supervised-cycle-12f12e-critic-resume.mjs` exigía que ese campo fuese 18. Esa comparación era incorrecta.

Significado: **cuota diaria dura del proveedor Groq**, con contabilidad por fecha UTC. Se conserva el nombre histórico del campo de producción por compatibilidad; el nuevo contrato lo mapea explícitamente a `providerRpdHardLimit`.

`readGroqAtomicCapacityLimits`, en `lib/agents/runtime/free-provider-router.ts`, obtiene el soft RPD mediante `floor(1000 × 0.85)=850`. La ratio se resuelve en `readProviderSoftLimitRatio` a partir de FREE_PROVIDER_SOFT_LIMIT_RATIO o la constante existente DAILY_SOFT_LIMIT_RATIO.

## B. Procedencia y enforcement de 18

Fuente canónica existente: `SUPERVISED_PROVIDER_REQUEST_LIMIT=18`, en **lib/agents/pipeline/supervised-throughput-policy.ts:6**. No se añadió otra constante independiente.

Significado: máximo de **reservas de requests del proveedor dentro de una ejecución supervisada**, adicional a las cuotas del proveedor.

- Ejecución normal: `scripts/supervised-pipeline-run.ts:61` construye un `ProviderScopedDailyRequestBudget` con esa constante y comparte la instancia entre etapas/intentos de la ejecución.
- Admisión: `ProviderScopedDailyRequestBudget.reserve` agrega los contadores de la instancia entre proveedores y días UTC y bloquea si alcanza su máximo. `AgentRunner` invoca ese guard antes de reservar en el ledger persistente o hacer dispatch.
- Continuación en el mismo proceso: mantiene la misma instancia y el uso acumulado.
- Resume del runner canónico: ahora `createCapacityResumeRequestBudget` consume la misma constante y reconstruye las reservas locales desde el `providerAccounting` de un snapshot validado. No hace ninguna reserva remota.
- El snapshot schemaVersion 1 **no persiste un campo independiente de cap 18**. Persiste la contabilidad de etapas completadas; el cap se obtiene de la política canónica. No se necesita cambiar el schema para esta corrección.

Los cinco registros durables de Verifier, Translator, Editor, Classifier y Ranker contienen un request cada uno y suman **8365 tokens**. La preflight comprobó que el snapshot local coincide con el remoto del mismo intento, evento y pipeline_run. El presupuesto reconstruido es **18 máximo / 5 usados / 13 restantes**.

El runner histórico de 12F.12D conserva su aserción antigua y su evidencia de fase ya invocada; no se reescribió ni ejecutó. El camino canónico hacia delante es el runner basado en 12F.12E, con el contrato corregido.

## C–F. Contrato independiente y continuidad

`SupervisedRequestCapContract` da campos distintos a los cuatro dominios:

- `providerRpdHardLimit` y `providerRpdSoftLimit`: cuotas diarias del proveedor.
- `supervisedExecutionRequestCap`: cap de la instancia de ejecución.
- `cumulativeAttemptRequests`: uso histórico restaurado.
- `remainingExecutionRequests`: diferencia entre cap y uso, sin agregar un presupuesto nuevo.

El preflight exige por separado:

1. Cap local igual a la política supervisada y al menos un request de ejecución restante.
2. Cuota diaria del proveedor válida y al menos un request permitido por su umbral de admisión existente.

No exige igualdad entre RPD y cap. Los resultados de agotamiento del contrato son distintos: `PROVIDER_RPD_CAPACITY_EXHAUSTED` y `SUPERVISED_EXECUTION_REQUEST_CAP_EXHAUSTED`.

En la lectura actual, el ledger de Groq del día UTC tiene **0 reservas**, mientras que el intento conserva **5 requests históricos**. El presupuesto del proveedor devuelve **849** requests admisibles: conserva el criterio existente `projectedRequests < softLimit`, por lo que usa `850 - 1 - 0`. Esto no sustituye los **13** requests restantes de la ejecución ni borra su uso anterior.

| Camino verificado localmente | Cap | Uso | Restante |
| --- | --- | --- | --- |
| Ejecución nueva | 18 | 0 | 18 |
| Continuación después de cinco requests y uno simulado adicional | 18 | 6 | 12 |
| Resume en proceso nuevo, desde contabilidad serializada | 18 | 5 | 13 |
| Ejecución agotada, proveedor con RPD disponible | 18 | 18 | 0 |

Normal/resume invariant: **PASS**. Cruzar medianoche UTC no resetea el total de la instancia. Ninguna de estas pruebas ejecutó un scheduler o resume remoto.

## G–H. Fix mínimo

Archivos de código afectados:

- `lib/agents/runtime/request-budget.ts`: vista **de solo lectura** `executionSnapshot()` con cap, uso total y restante. No cambia reserve/release ni la admisión.
- `lib/agents/pipeline/supervised-request-cap-contract.ts`: reconstrucción local desde contabilidad validada y validación de dominios separados usando la constante existente.
- `scripts/supervised-cycle-12f12e-critic-resume.mjs`: elimina la comparación RPD==18, reconstruye el uso durable, verifica que el snapshot leído es el usado para el budget, y añade la opción de fase con rutas de evidencia exclusivas.
- `scripts/supervised-request-cap-contract-unit-test.mjs`: regresiones del contrato y admisión offline.
- `scripts/supervised-cycle-12f12f-runner-observability-unit-test.mjs`: adapta el fixture de validación del intento al nuevo cotejo de snapshot.

No hubo migración ni cambios de políticas runtime, contabilidad persistente o límites.

## I–K. Regresiones, otros límites y gates

Los 14 requisitos pedidos están cubiertos y pasan:

| Caso | Resultado |
| --- | --- |
| 1. RPD 1000 + cap 18 válido | PASS |
| 2. RPD y cap no tienen que coincidir | PASS |
| 3. Fresh run cap 18 | PASS |
| 4. Resume cap 18 | PASS |
| 5. Cinco previos dejan 13 | PASS |
| 6. Uso 18 impide dispatch adicional | PASS |
| 7. Request 19 nunca admitido | PASS |
| 8. Cuota del proveedor insuficiente bloquea independientemente | PASS |
| 9. Cap de ejecución bloquea con RPD disponible | PASS |
| 10. Proceso nuevo no resetea uso | PASS |
| 11. Invariante normal/resume | PASS |
| 12. Retries 0 | PASS |
| 13. Fallback 0 | PASS |
| 14. Concurrencia 1 | PASS |

La regresión nueva usa AgentRunner y logger en memoria para comprobar ambos bloqueos antes de dispatch, y un proceso hijo que reconstruye 5/18/13 desde JSON. El fetch remoto está bloqueado en esa suite.

Además pasaron las 16 suites de cuotas, contabilidad de tokens, throughput, provider capacity resume, M35 verifier-first, M36, bootstrap TPM, admisión unificada, checkpoints durables y Critic, prueba M34, read-path M32, construcción de producción y guard/observabilidad del runner. Los nombres exactos y resultados están en el JSON.

Cuatro suites fallaron inicialmente con **EPERM al renombrar fixtures temporales en el sandbox**. Se repitieron solo esas pruebas offline fuera del sandbox y pasaron sin cambiar código. Las pruebas SQL M35/M36 validaron contratos/fixtures offline; no se ejecutó PostgreSQL local ni ninguna migración remota.

Otros límites: **RPM PASS (30)**, **TPM PASS (8000)**, **TPD PASS (200000 hard / 170000 soft)**. Conservan campos y checks separados; ninguna de estas dimensiones se compara con el cap de requests de ejecución. No se rediseñaron.

Gates: **npm run lint PASS**, **npx tsc --noEmit PASS**, **npm run build PASS**, **git diff --check PASS**, **secret audit PASS**, hallazgos 0 y .env.local ignorado.

Warnings: Node type stripping experimental/tipo de módulo; el build avisa que NEXT_PUBLIC_SITE_URL falta o no es válido y desactiva metadata de indexación. No se alteraron esos ajustes ajenos al contrato. UI, responsive y temas: no aplicables.

## L–M. Único preflight remoto y baseline

Comando ejecutado una sola vez después de los gates:

```text
node --env-file-if-exists=.env.local --conditions=react-server --experimental-strip-types scripts/supervised-cycle-12f12e-critic-resume.mjs --request-cap-preflight-12f12g2
```

Runner/preflight invocaciones: **1/1**. Resultado: **PREFLIGHT_READONLY_PASS**. Lecturas HTTP: **16**, todas con respuesta 200. El guard limita destinos y operaciones a tablas GET/HEAD y RPC M32 de lectura. La rama retorna antes de claim/resume. No se repitió el preflight.

| Validación remota | Resultado |
| --- | --- |
| Intento revalidado | YES |
| Estado | DEFERRED_PROVIDER_CAPACITY |
| Resume stage / generation | Critic / 1 |
| Verifier / Translator / Editor / Classifier / Ranker | PASS |
| Critic checkpoint / dispatch | ABSENT / NO |
| Event lineage / pipeline_run lineage | Coinciden con evidencia anterior |
| Request accounting | 5 usados / 18 máximo / 13 restantes |
| RPD hard / soft | 1000 / 850 |
| Intentos | 19 |
| Activos / diferidos / atascados | 0 / 1 / 0 |
| Reviews / WAITING | 0 / 0 |
| Públicos / Astra | 2 / ARCHIVED |
| Reservas desconocidas | 0 |
| Fingerprints | UNCHANGED |
| Histórico de filas y scheduler | UNCHANGED |

El oráculo M36 de ventana local dio KNOWN_ZERO, 0 tokens en ventana. Estimación de Critic: 7018 + 128 de margen = 7146, dentro de TPM 8000. Header persistido stale: se conservó la admisión local existente, sin llamar al proveedor para obtener headers nuevos. La elegibilidad leída es válida y no requiere repetir etapas completadas.

## CRITIQUE → VERIFY final

Se corrigió el contrato que producía el falso mismatch. Los valores 1000/850 y 18/5/13 coexisten y fueron comprobados en la preflight real. Los guards de admisión del runtime conservan su comportamiento y están cubiertos por regresión.

Evidencia: `artifacts/supervised-cycle-12f12g2-request-cap.json`. Latch de única invocación: `artifacts/supervised-cycle-12f12g2-preflight-invocation.json`.

Claims **0**; resume invocations **0**; provider calls **0**; remote writes **0**; daily scheduler runs **0**; nuevos intentos **0**; publicaciones **0**; migraciones **0**.

**READY FOR CRITIC RESUME: YES. DETENERSE SIN CLAIM, RESUME NI GROQ.**
