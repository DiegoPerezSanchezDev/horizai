# Fase 14 — Scheduler activation readiness

## Scope and decision

Auditoría de readiness únicamente. No se activó ni se invocó el scheduler, no se consumió trigger, no se ejecutó pipeline, no se reanudó el intento diferido y no hubo llamadas a proveedores ni escrituras remotas.

**SCHEDULER_ACTIVATION_READINESS: NO**\
**SCHEDULER_ACTIVATION_READY: NO**

La repetibilidad de los tres ciclos está respaldada por la evidencia previa de 13B.1. El estado remoto actual confirma que el intento de ciclo 3 permanece diferido y que no cambió la integridad pública. La activación queda bloqueada por la ausencia de un camino programado de producción, la falta de integración de resume con ese camino, la semántica diaria y de lease incompleta, y la falta de configuración supervisada en el executor del scheduler.

Captured remote state: `2026-10-22T20:13:20.746Z`.

## A. Current state audit

Lecturas privadas mediante el cliente server-side/PostgREST normal. No se usó SQL CLI ni Management API.

| Check | Resultado |
|---|---|
| Intento más reciente | `f794f73c-ce15-4167-beac-cb54bd6312af`, intento 1, run `fcddbe66-1071-4a3d-9876-951c99735c8b` |
| Estado | `DEFERRED_PROVIDER_CAPACITY`, Editor, `PROVIDER_CAPACITY_EXHAUSTED` |
| Resume snapshot | Presente, generación 0, checkpoints Verifier y Translator, Editor dispatch count 0, checkpoint Editor ausente |
| Scheduler row | `6f5c88c8-eba8-4832-aac7-1a28b5e6684d`, `BLOCKED_PROVIDER_RATE_LIMIT`, lease `released`, 2 requests |
| Active / deferred / stuck | `0 / 1 / 0` |
| Agent runs abiertos | 0 |
| Leases activos | 0 |
| Reviews | 1 histórica `PUBLISHED`; `WAITING_FOR_HUMAN_REVIEW` = 0; la review no pertenece al intento diferido |
| Artículos públicos | 3; los tres fingerprints son iguales a la baseline de 13B |
| Astra | Sigue `archived` |
| Accounting del 2026-10-22 | Groq 2 requests, 5,401 tokens, 0 unknown; Cloudflare 0; Cerebras 0 |

El ciclo 2 sigue terminal: intento `65a83559-8522-4162-8e04-6f8a0bde62b3`, `REVISION_REQUIRED / BLOCKED_REVISION_REQUIRED` en Critic. La fila de scheduler del ciclo 3 conserva `supervised-candidates:2026-10-22`; no se encontró otra ejecución posterior en la lectura del estado actual.

## B. Deferred attempt resume contract

La capacidad de resume existe en `PipelineOrchestrator.resumeCapacityDeferred`: valida el snapshot almacenado y su identidad, reclama atómicamente la misma fila de intento, continúa desde el stage diferido, conserva accounting/checkpoints anteriores y libera el claim al salir. El helper `createCapacityResumeRequestBudget` reconstruye el límite de ejecución desde `providerAccounting`.

Para el intento actual, el accounting previo suma 2 requests; el presupuesto correcto sería **2/18 usados, 16 restantes**. La primera reanudación válida avanzaría a generación 1. Las pruebas offline de capacity resume y request-cap pasan.

**El camino del scheduler no llama a esa función ni carga un snapshot diferido.** `runSchedulerTrigger()` llama únicamente al preflight. El executor, si se invocara, crea un pipeline normal y llama a `orchestrator.run()`. El filtro de intentos devuelve `RESUME_REQUIRED` para el mismo event diferido; no existe una barrera global que detenga la selección de otros eventos. Por eso el comportamiento esperado “reanudar primero el mismo intento” no está implementado.

## C. Daily trigger and deferred-work interaction

- La invocación Netlify actual solo ejecuta preflight con un namespace aleatorio `test:scheduler-preflight:<UUID>` y borra su fixture de scheduler al finalizar.
- El executor de pipeline exige `testNamespace` que empiece por `test:`; rechaza namespaces de producción.
- En el hipotético executor, la fila de trigger/lease se adquiere antes de ejecutar preflight y pipeline. No hay paso de resume anterior a esa adquisición.
- Un intento diferido del mismo evento se filtra como `RESUME_REQUIRED`. Si discovery produce otro evento elegible, el pipeline normal puede seleccionar ese otro evento y abrir un intento nuevo; no existe gate global “deferred work first”.
- Dos claves distintas pueden adquirir filas distintas. El SQL serializa por `trigger_id`, no impone una sola ejecución activa global.
- Si un resume manual vuelve a encontrar capacidad insuficiente antes del dispatch, el lifecycle M33 conserva la misma fila, crea el siguiente snapshot/generación y no crea otro intento. Ese lifecycle no está conectado al scheduler.

Conclusión: **no reanuda automáticamente el intento de ayer; puede consumir/adquirir el trigger antes de procesar; no hay garantía de que una invocación nueva se detenga por trabajo diferido global**.

## D. One trigger per UTC day

La fecha de request se deriva de `Date.toISOString().slice(0, 10)`, por tanto usa UTC. Sin embargo, el helper de scheduler produce `scheduled:<UTC-date>:<slot>` y define tres slots (`morning`, `afternoon`, `night`). El preflight Netlify usa un namespace aleatorio `test:`. La fila SQL solo garantiza unicidad de la cadena completa `trigger_id`.

El contrato solicitado `supervised-candidates:<YYYY-MM-DD>` no está impuesto por el repositorio ni por una restricción SQL. Claves alternativas o los tres slots permiten varias filas en un mismo día. No hay reset ni borrado en el contrato de ejecución normal; la recuperación de lease expirado sí vuelve a usar la misma fila/clave pendiente.

**Daily trigger PASS: NO.** Una clave idéntica se deduplica; “máximo una clave por día UTC” no está garantizado.

## E. Scheduler lease safety

**Correcto para una misma clave:** `trigger_id` es UNIQUE; la adquisición usa `INSERT ... ON CONFLICT`, bloquea la fila con `FOR UPDATE`, devuelve `busy` si el lease sigue activo y el release/finalize verifica `owner_run_id`.

**Bloqueos:**

- No hay lease global/advisory lock entre claves diferentes, así que triggers alternativos pueden adquirir simultáneamente.
- El lease expira a la hora por defecto. Al recuperarlo, la función cambia el owner y restablece `finished_at`, `run_status`, `final_decision` y `stop_reason`; la ejecución anterior no recibe fencing token en cada stage para impedir que continúe tras perder el owner.
- El executor libera después de éxito y en el catch de fallos. Si la finalización terminal falla después de comenzar, evita una segunda finalización genérica y puede dejar una fila sin terminalización correcta; el error se propaga, pero no existe notificación operativa automática.

**Lease safety PASS: NO** para activación con más de una clave o recuperación concurrente.

## F. Idempotency

| Caso | Evidencia / resultado |
|---|---|
| Doble entrega con la misma clave | UNIQUE + bloqueo por fila detiene una adquisición simultánea; después de finalizada/liberada, devuelve duplicate |
| Retry de Netlify / llamada manual duplicada | Solo queda deduplicada si el caller usa exactamente la misma clave estable. El preflight actual genera namespace aleatorio y no representa el trigger diario |
| Dos claves distintas | Sin barrera global; pueden abrir leases diferentes |
| Doble intento del mismo evento activo | `claim_pipeline_event_attempt` es atómico; el intento existente bloquea otro claim mientras sigue activo |
| Resume diferido | Claim M33 atómico para la misma fila; no lo invoca el scheduler |
| Crash después de respuesta del proveedor y antes del checkpoint | No hay idempotency key de proveedor ni recuperación de stage probado para esa ventana. La reserva puede quedar con uso desconocido; tras recuperación stale, la ruta normal no retoma el checkpoint incompleto del stage. No se puede afirmar exactly-once dispatch |
| Crash tras persistir estado y antes de finalizar scheduler | Lease/row pueden quedar pendientes hasta expiración; si la finalización falla, la observabilidad mejora por error propagado, pero no hay alerta automática ni garantía de reintento sin solapar trabajo |

**Idempotency PASS: NO.** La protección por trigger exacto y claim por evento es útil, pero no cubre alias diarios, ejecución concurrente por claves distintas ni la ventana proveedor-respuesta/checkpoint.

## G. Provider admission

Evidencia histórica del preflight 13B: Groq, modelo gratuito aprobado, retries 0, fallback de pago false, provider pacing wait false, router false, concurrencia 1. La contabilidad remota del ciclo 3 fue 2 requests / 5,401 tokens y 0 reservas desconocidas; no hubo Cloudflare ni Cerebras.

El código conserva límites de capacidad Groq/RPM/RPD/TPM/TPD y el guard de defer pre-dispatch. La política supervisada pone retries en 0 y fallback de pago en false. La ruta de scheduler, sin embargo, construye `createProductionPipeline` sin `mode: "supervised"` ni un `requestBudget` con cap de ejecución 18; tampoco valida el objeto de preflight antes de continuar.

`EXECUTION_MAX_EVENTS_PER_RUN` y el `limit` del pipeline están en 1, y el modo de producción fuerza cero retries por stage, lo que limita el camino ordinario actual. Aun así, el contrato explícito 18 y la reconstrucción acumulada del intento diferido no están aplicados en el scheduler. La capacidad de resume manual usa `createCapacityResumeRequestBudget`; el executor no.

**Provider admission PASS: NO** para el contrato automático completo. No se hizo llamada de proveedor en esta fase.

## H. Request accounting on resume

La utilidad de resume suma `providerRequestsUsed` de los stages previos y reserva esas unidades localmente bajo el cap total 18. Para el snapshot actual: 2 requests históricas → 16 requests restantes; la suma persiste aunque cambie el día UTC. El ledger M36 usa ventanas UTC para la capacidad diaria.

La prueba `supervised-request-cap-contract-unit-test` verificó uso acumulado, bloqueo del request 19, continuidad de proceso y separación del cap por ejecución frente al límite diario del proveedor. **La utilidad pasa; el scheduler no la conecta al resume diferido.** Resultado global: **FAIL**.

## I. Human review stop

El contrato de pipeline supervisado crea una review solo después de Critic PASS y de la evidencia/checkpoints requeridos; en el camino supervisado no hay decisión humana automática. La política del scheduler no ejecuta approve/hold/reject ni bind de revisión.

El executor de scheduler actual no pasa `mode: "supervised"`. Por ello no exige el estado `WAITING_FOR_HUMAN_REVIEW` ni activa la ruta de review M34. Además, el mapper del executor clasifica cualquier estado que no sea `SUCCESS`/`READY...`, `SKIPPED` o `BLOCKED*` como `failed`; una respuesta `WAITING_FOR_HUMAN_REVIEW` se marcaría como failure si llegara allí.

**Human review gate PASS: NO** en el camino del scheduler actual.

## J. Typed terminal outcomes

`supervised-run-outcome.ts` y `scheduler-terminal-contract.ts` contienen contratos tipados para safe rejection, no elegible, capacity defer, technical failure y waiting. La prueba de finalización supervisada pasa.

El executor alternativo `scheduler-execution.ts` no usa esos contratos de finalización: su mapper marca `WAITING_FOR_HUMAN_REVIEW` y `DEFERRED_PROVIDER_CAPACITY` como `failed`; `isRateLimit` solo identifica 429/`FREE_TIER_LIMIT_REACHED`, no el defer pre-dispatch. El mapping correcto que existe en el módulo terminal no está integrado en el executor. El stop actual del ciclo 3 está correctamente persistido como `BLOCKED_PROVIDER_RATE_LIMIT / PROVIDER_CAPACITY_EXHAUSTED` por el camino supervisado utilizado en 13B.1.

- Verifier rejection / `EDITOR_GROUNDING_REJECTED`: safe rejection en política supervisada.
- `VERIFIER_INPUT_TOO_LARGE` y technical failures: se cierran como failure; el reason específico queda en el resultado del evento, mientras el scheduler puede compactar el terminal a genérico.
- Critic `revise_editorial`: `BLOCKED_REVISION_REQUIRED`; no corre M34, no crea review ni inicia loop automático.
- `ALL_CANDIDATES_SAFELY_REJECTED`: el contrato supervisado lo conserva como stop seguro; el executor actual no usa dicho agregador.

**Typed terminal outcome PASS: NO** en el executor que se pretende automatizar.

## K. Critic revision safety

El scheduler configura `automaticRevision: false`; el camino de Critic devuelve `BLOCKED_REVISION_REQUIRED` y no vuelve a entrar en Verifier/Editor. La review se crea solo en el camino supervisado tras Critic PASS. Las pruebas de finalización y review confirman estas barreras.

## L. Publication gate

La configuración del executor fija `dryRun: true` y `publish: false`; el SQL del scheduler también exige dry-run y publicación desactivada. La publicación automática queda OFF. La publicación requiere la ruta separada de decisión humana.

El executor no llega al estado de review supervisada por falta de `mode: "supervised"`; por tanto “Publisher OFF” sí pasa como bloqueo de escrituras, pero el gate humano anterior a publicación no queda probado en esa ruta.

## M. Next-day scenarios

| Escenario | Resultado que demuestra el código actual |
|---|---|
| 1. Ayer Editor deferred; hoy hay capacidad | No hay resume automático. El mismo evento se filtra como `RESUME_REQUIRED`; otro evento elegible puede empezar. No pasa |
| 2. Ayer Editor deferred; hoy sigue sin TPM | El resume manual M33 puede reclamar la misma fila y volver a defer con nueva generación. El scheduler no invoca ese flujo |
| 3. Deferred llega a WAITING | El resume supervisado puede detenerse en una sola review tras Critic PASS/M34; el scheduler actual no ejecuta esa ruta |
| 4. Deferred safe-reject | El pipeline no crea un segundo candidato dentro del mismo evento; el scheduler no impone una barrera de intento diferido global entre días |
| 5. Technical failure durante resume | El resume manual libera el claim y el executor captura excepciones, intenta finalizar y libera el lease. Fallo de finalización puede dejar estado no terminal |
| 6. Misma invocación diaria entregada dos veces | La misma clave persistida deduplica; con una clave alternativa no existe dedupe diaria ni lease global |

## N. Scheduler hosting target

**SCHEDULER_HOST_TARGET: Netlify Functions ya presentes, pero sin schedule configurado.** `netlify.toml` solo configura `NODE_VERSION`; `netlify/functions/scheduler-trigger.ts` es un handler HTTP POST con secret y llama a preflight. No es un Scheduled Function compatible actualmente.

Netlify documenta Scheduled Functions en todos sus planes, con cron expresado en UTC y límite de 30 segundos. El ciclo real de 13B.1 duró aproximadamente 61 segundos, por lo que no cabe directamente en ese límite. Netlify Background Functions llegan a 15 minutos y están disponibles en planes basados en créditos, incluido Free; la compatibilidad con el plan real de este sitio no se pudo verificar.

## O. Recommended UTC schedule

**07:00 UTC**, cron `0 7 * * *`.

En Madrid corresponde aproximadamente a 08:00 en invierno (CET) y 09:00 en verano (CEST). El cron UTC no cambia con DST y mantiene una ventana de revisión editorial durante la mañana.

La hora es una recomendación para la fase posterior; no se ha configurado.

## P. Free-tier compatibility

La documentación actual de Netlify indica que Scheduled Functions están disponibles en todos los planes. En el plan Free basado en créditos hay un límite mensual duro de 300 créditos y no se cobran excedentes; al agotarlo el sitio se pausa. El compute cuesta 10 créditos por GB-hora. Una ejecución diaria de 61 s con 1 GB modela unos **5.1 créditos/mes** de compute, antes de uso del sitio.

La cuenta/proyecto real, tipo de plan (credit-based o legacy) y créditos disponibles no se inspeccionaron. Background Functions están disponibles en Free de plan credit-based, pero no se puede afirmar que este sitio esté en ese plan. El camino actual excede el límite de 30 s de Scheduled Functions.

**Free-tier compatible: CONDITIONAL / no verificado para este sitio.** No requiere comprar scheduler; activar ahora no cumple la duración observada ni el wiring.

Fuentes oficiales consultadas:

- [Netlify Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/)
- [Netlify Background Functions](https://docs.netlify.com/build/functions/background-functions/)
- [Netlify credit usage](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)

## Q. Operational observability

Se puede derivar con tablas/logs actuales; no hace falta una plataforma nueva:

| Señal | Fuente actual |
|---|---|
| Última ejecución, trigger, final result, lease y `pipeline_run_id` | `scheduler_runs` |
| Attempt ID, stage, final state, deferred stage y generation | `pipeline_event_attempts` unido por `pipeline_run_id`; `capacity_resume_snapshot` |
| Requests/tokens/unknown reservations por fecha UTC | `agent_logs` de reservas y telemetry de `agent_runs` |
| Reviews WAITING | `human_review` status RPC/list |
| Último error tipado | `scheduler_runs.stop_reason`, event final state y failure telemetry |

La fila scheduler no almacena por sí sola attempt ID, stage/generation, tokens ni waiting-count; deben derivarse por join. **Observability: PARTIAL** hasta que el executor los emita o el runbook documente una consulta estable y se alerte por terminales anómalos.

## R. Failure alerting

Sin implementar push en esta fase. Política mínima:

- WAITING review: sí, aviso editorial.
- Technical failure, unknown reservation, lineage ambiguity o finalization failure: sí, alerta operativa.
- Provider capacity defer: normalmente no; alertar si se repite persistentemente.
- Safe rejection y `ALL_CANDIDATES_SAFELY_REJECTED`: no.

## S. Current deferred attempt

**SAFE_TO_LEAVE_DEFERRED: YES, solo mientras el scheduler siga OFF.**

El snapshot remoto está presente y corresponde al mismo intento/run/event; los checkpoints previos están disponibles; Editor aún no dispatchó; no hay lease ni otro intento activo, no hay review asociada y el intento es retry-neutral. No lo modifiqué ni reanudé. No es seguro activar el scheduler con el resume automático ausente.

## T. Historical integrity

- Cycle #1: PASS (evidencia previa de 13B.1).
- Cycle #2: PASS (evidencia previa; su intento terminal fue releído y sigue `REVISION_REQUIRED / BLOCKED_REVISION_REQUIRED`).
- Cycle #3: PASS como ciclo controlado que quedó `DEFERRED_PROVIDER_CAPACITY`.
- Supervised repeatability: PASS (evidencia previa de 13B.1).
- Intentos reales: 21; diferido actual intacto.
- Reviews: una histórica `PUBLISHED`, ninguna WAITING; ninguna ligada al intento diferido.
- Artículos públicos: 3; fingerprints iguales.
- Astra: `archived`.

## U. Code change policy

**Source code changes: 0.** Se crean únicamente este informe y su artefacto JSON requeridos por la fase. No se modificó ninguna migration, configuración Netlify, artículo, attempt, review o accounting remoto.

## V. Activation runbook for the next phase (not executed)

1. Cerrar primero `FASE 14.1 — Production scheduler/resume safety closure` descrita abajo; mantener scheduler OFF durante la reparación.
2. Confirmar en Netlify que el proyecto usa Free basado en créditos, hay margen bajo 300 créditos y auto-recharge no aplica. Si el sitio es legacy Free, no asumir Background Functions gratis.
3. Confirmar presencia —sin imprimir valores— de `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AGENT_API_URL`, `AGENT_API_KEY`, `AGENT_PROVIDER`, límites `GROQ_*` de RPM/RPD/TPM/TPD y `SCHEDULER_TRIGGER_SECRET` solo si se mantiene entrada HTTP autenticada. Verificar Groq-only, retries 0, fallback false, concurrencia 1, presupuesto de ejecución 18 y publication false.
4. Después de aprobación para la fase de activación, agregar al wrapper Scheduled Function compatible con Netlify: `config.schedule = "0 7 * * *"` (o `[functions."scheduler-trigger"] schedule = "0 7 * * *"` en `netlify.toml`). El wrapper debe entregar el trabajo al executor supervisado de larga duración; el handler HTTP actual no acepta evento Scheduled y el ciclo observado supera 30 s.
5. Publicar el deploy aprobado que contiene el schedule. La documentación de Netlify no permite invocar directamente una Scheduled Function por URL; validar el wrapper/background path con fixture/local tests antes del deploy.
6. Observar el primer día: trigger UTC consumido una vez; lease adquirido/liberado; attempt ID `f794...` reanudado en Editor, generación 1; Verifier/Translator sin dispatch nuevo; Groq total ≤18; otros proveedores 0. Si capacity vuelve a bloquear antes del dispatch, mismo attempt deferred en la siguiente generación. Si completa, exigir Critic PASS + M34 PASS + exactamente una review WAITING.
7. Detener si hay trigger alternativo el mismo día, nuevo attempt antes de resolver el diferido, duplicate dispatch, unknown reservation, uso >18, provider no permitido, estado terminal ambiguo, review sin Critic/M34 PASS, publish habilitado o límite de ejecución/credit alcanzado.
8. Éxito del primer día autónomo: mismo intento diferido retomado; ejecución limitada y trazable; sin repetir etapas completadas; terminal typed; lease liberado; como máximo una WAITING review; cero publicaciones; €0.

## W. Rollback

Acción mínima: retirar/deshabilitar el schedule `0 7 * * *` en el deploy de Netlify (revertir el cambio de configuración o desactivar la función programada) y publicar el deploy sin schedule. No borrar scheduler rows, attempts, reviews, artículos ni accounting.

## Blockers and required repair phase

**CRITICAL:**

1. No existe schedule de producción y el trigger Netlify actual solo ejecuta preflight; el executor productivo rechaza namespaces que no sean `test:`.
2. No existe integración de resume deferred ni una barrera global que impida comenzar otro candidate mientras el intento anterior permanece pendiente.
3. El executor no pasa `mode: "supervised"`; no garantiza Critic → M34 → WAITING review y su mapper clasifica WAITING/defer como failure.

**HIGH:**

4. No se impone una sola clave de trigger por día UTC ni un lease global entre claves.
5. Lease expirado puede cambiar owner sin fencing del pipeline antiguo; el crash entre respuesta de proveedor y checkpoint no demuestra exactly-once.
6. El executor no inyecta la cuenta acumulada request budget de 18 al normal/resumed path.
7. Scheduled Function tiene límite 30 s frente a una ejecución observada de ~61 s; la opción background depende del plan Netlify actual no verificado.

**Next phase:** `FASE 14.1 — PRODUCTION SCHEDULER + DEFERRED RESUME + IDEMPOTENCY CLOSURE (NO ACTIVATION)`. Implementar y probar, sin providers ni activación: schedule-compatible wrapper; executor supervisado que reanude primero el mismo snapshot; trigger key UTC única; bloqueo global/fencing de leases; idempotencia en crash windows; budget 18 reconstruido; terminal mapper compartido; human review gate; observabilidad/alertas mínimas; ejecución compatible con free plan y timeout. Luego repetir gates de esta fase. Solo una fase posterior debe activar.

## Tests and verification

Offline tests PASS: scheduler policy, Netlify wiring guard, scheduler execution contract, M33 lifecycle, pre-dispatch defer guard, capacity-resume helper, request-cap reconstruction, unified Groq admission, M36 accounting window, Groq capacity parser, Cloudflare accounting baseline, M35 Verifier resume, supervised throughput, finalization, and human review.

The first run of three file-system unit suites was blocked by Windows sandbox `EPERM` while renaming temporary files outside the workspace. They were rerun with temporary directories inside the repository and passed. `pipeline:scheduler:integration` was not run because it inserts/releases/deletes remote scheduler rows; this phase requires remote writes 0.

- `npm run lint`: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS on retry. First build hit a transient `EPERM` creating `.next/server/app/terminos.segments/terminos`; second build passed. The build emitted `NEXT_PUBLIC_SITE_URL` warnings and disabled indexing metadata.
- `git diff --check`: recorded in the JSON artifact after final verification.
- Secret audit: recorded in JSON artifact after final verification.

Phase 14 activity totals: pipeline runs 0; provider calls 0; trigger consumption 0; remote writes 0; editorial decisions 0; publications 0.
