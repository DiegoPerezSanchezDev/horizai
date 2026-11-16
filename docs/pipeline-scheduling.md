# Scheduling policy — Fase 10C offline

## Alcance

Esta fase define la política que un futuro trigger podrá usar antes de invocar al orquestador. No crea un cron externo, no ejecuta el pipeline real y no contiene lógica editorial.

```text
schedule trigger → scheduler policy → quota check → overlap check → run plan → pipeline orchestrator
```

Los módulos viven en `lib/agents/pipeline/scheduler/`. Son funciones deterministas y tipos internos; no forman todavía un contrato público de API.

## Cuota y coste

La fuente canónica sigue siendo el ledger de reservas del runtime y `initialRequestsRequired()` de `pipeline-budget.ts`. No existe un segundo contador.

- Reset de cuota: UTC.
- Coste normal peor caso por evento: 6 requests (`Verifier`, `Translator`, `Editor`, `Classifier`, `Ranker`, `Critic`).
- Publisher: 0 requests.
- Un evento normal solo puede comenzar si `remaining >= 6`.
- `eventsAllowedByBudget = floor(remaining / 6)`.
- El límite efectivo es `min(eventsAllowedByBudget, maxEventsPerRun)`.
- Después de cada evento se vuelve a calcular el remanente usando las requests realmente consumidas; no se asume que todos los eventos cuestan 6.

Por defecto `maxEventsPerRun=3`. No representa un límite editorial ni sustituye a la cuota diaria: solo evita que un trigger monopolice el día. El fallback legado de Groq sigue siendo 20 requests; la configuración canónica confirmada permite 1.000 RPD y calcula 850 requests soft. La proyección provisional de tokens N=1+25% limita el plan diario a 13 eventos completos equivalentes, antes de aplicar este máximo de 3 por run. Los skips solo consumen las requests realmente despachadas. La admisión de tokens por evento está definida en la política Groq 10G.7a.5, pero esta fase no modifica el scheduler ni su objetivo por run.

Las rutas de revisión conocidas se derivan del mismo presupuesto: verification 6, translation 5, editorial 4, classification 3 y ranking 2. Como `automaticRevision=false`, no se reservan ni se planifican revisiones automáticas.

## Timezones y slots

La cuota usa UTC mediante `requestDateUtc`. La presentación/planificación usa explícitamente `Europe/Madrid`; no depende de la timezone del servidor.

Los tres slots conceptuales son estables en hora local:

| Slot | Intervalo local |
| --- | --- |
| `morning` | 06:00–11:59 |
| `afternoon` | 12:00–17:59 |
| `night` | 18:00–05:59 |

La clasificación usa `Intl.DateTimeFormat` con `timeZone`, por lo que los cambios DST de Europe/Madrid no se implementan sumando manualmente una o dos horas. `scheduledAt` se conserva como instante ISO y la fecha de cuota se calcula en UTC.

La identidad de trigger es `scheduled:<requestDateUtc>:<slot>`. Repetir el mismo slot y fecha produce el mismo identificador y debe bloquearse como `BLOCKED_DUPLICATE_TRIGGER`; otro slot tiene una identidad distinta.

## Run plan y modos seguros

`ScheduledRunPlan` contiene el instante, slot, fecha UTC, snapshot de cuota, coste peor caso, capacidad derivada, límite de eventos, ventana `hours`, y los flags de seguridad.

En 10C son obligatorios:

- `dryRun=true`;
- `publish=false`;
- `automaticRevision=false`;
- `maxRevisionAttempts=1`.

La policy no hace sleep para esperar el reset. Cerca de 00:00 UTC se aplica exactamente la misma regla de presupuesto; un instante antes y uno después pertenecen a fechas UTC diferentes.

## Overlap y lease

El scheduler recibe un `SchedulerLeaseRepository`, no implementa un lock productivo en memoria. El repositorio futuro debe proporcionar una operación atómica con owner, `acquiredAt`, `expiresAt` y TTL.

- Lease libre: `acquired`.
- Lease existente y no expirado: `busy`; el nuevo trigger queda `BLOCKED_RUN_ALREADY_ACTIVE` y no realiza llamadas al pipeline.
- Lease expirado: puede adquirirse de nuevo con estado `expired` para conservar la evidencia de recuperación.
- Release: solo el `ownerRunId` puede liberar su lease; otro owner recibe `rejected`.

El valor offline inicial es un TTL de una hora, configurable en la policy y documentado como punto operativo inicial, no como lock eterno. La implementación persistente/atómica se decidirá antes de habilitar un scheduler real.

## Selección y deduplicación de eventos

La selección reutiliza el orden real del orquestador: timestamp `publishedAt` más antiguo disponible y, en empate, `eventKey`; los timestamps nulos van al final.

No se seleccionan como eventos normales:

- eventos ya completados o publicados;
- `BLOCKED_REVISION_REQUIRED`;
- `BLOCKED_REJECTED`;
- fallos técnicos sin una señal explícita de retry;
- `SKIPPED_VERIFICATION_INSUFFICIENT` sin una señal explícita de reconsideración.

El esquema actual no ofrece todavía una política persistida de cooldown/reconsideración para skips. Por eso el planner no inventa una ventana temporal: requiere `reconsiderationAllowed=true` aportado por una capa futura. Los fallos no se reintentan dentro del mismo scheduled run.

## Rate limits y errores

Un `FREE_TIER_LIMIT_REACHED`/HTTP 429 del proveedor se representa como `BLOCKED_PROVIDER_RATE_LIMIT`. El scheduled run se detiene: no hace sleep, no activa fallback, no cambia de modelo, no reintenta globalmente y no trata el evento como completado.

Un fallo temporal de red o de Supabase también queda fail-closed; la política no crea loops globales.

## Revisión y publicación

Una decisión `BLOCKED_REVISION_REQUIRED` permanece distinguible y no vuelve a la selección normal. La revisión automática sigue desactivada. `BLOCKED_REJECTED` tampoco se reprograma como evento normal.

Publisher continúa en modo dry-run y no publica ni crea eventos mediante RPC. La política solo puede entregar al orquestador un plan; no autoriza por sí misma ninguna escritura.

## Verificación offline

```bash
npm run pipeline:scheduler:unit
npm run pipeline:scheduler:simulation
```

Los tests cubren presupuesto 20/5/6, contabilidad dinámica de skips y rutas completas, reset UTC, DST de Europe/Madrid, slots, leases activos/expirados/release por owner, duplicados, deduplicación de eventos, fallos sin retry, revisión/rechazo, 429 y máximo por run.

La simulación determinista reproduce:

```text
event A: skip → 1 request
event B: full path → 6 requests
event C: full path → 6 requests
total: 13 requests, 7 restantes, stop MAX_EVENTS_PER_RUN
```

## Fase 10C.1 — infraestructura real sin ejecución

Netlify ya estaba integrado mediante `@netlify/plugin-nextjs`, pero el repositorio no tenía directorio de Functions ni `@netlify/functions`. Se añadió `netlify/functions/scheduler-trigger.ts` como entry point server-only compatible con el directorio estándar de Netlify. `netlify.toml` solo declara ese directorio; no contiene `schedule` y por tanto no activa ningún cron productivo.

La invocación manual exige `SCHEDULER_TRIGGER_SECRET` en el header `x-horizai-scheduler-secret`, comparado con igualdad temporal segura. Sin secret, la function responde `401`; métodos distintos de `POST` responden `405`. Las respuestas no contienen secretos ni cuerpos de pipeline.

### Persistencia del lease y trigger history

`agent_runs` y `agent_logs` no eran suficientes: no tenían identidad única por fecha/slot, historial permanente de triggers ni una adquisición atómica que distinguiera lease activo, lease expirado y trigger ya procesado. La migración mínima `20260921000010_scheduler_infrastructure.sql` crea `scheduler_runs`; `20260921000011_fix_scheduler_acquire_insert.sql` corrige la clasificación de la primera inserción como `acquired`.

La tabla separa `lease_status` de `run_status`. `trigger_id` es único y no se elimina durante la operación normal. `acquire_scheduler_run` usa la unicidad y bloqueo de fila para que una concurrencia solo permita un owner; un lease expirado puede recuperarse, mientras que un trigger ya liberado/finalizado devuelve `duplicate`. `release_scheduler_lease` exige el owner correcto. Estas RPCs solo tienen `execute` para `service_role`; no se modificó RLS.

El scheduler usa el mismo ledger de `agent_logs` únicamente para leer cuota. La adquisición del lease no reserva requests. El preflight usa exclusivamente el namespace `test:scheduler-preflight:<uuid>` y elimina sus filas al terminar, por lo que no consume la identidad del slot productivo.

### Preflight e integración

```bash
npm run pipeline:scheduler:wiring:unit
npm run pipeline:scheduler:integration
npm run pipeline:scheduler:preflight
```

La integración remota prueba dos owners, release incorrecto, release correcto, duplicate tras release, expiry, adquisiciones concurrentes, fallo local con `finally` y cleanup. No ejecuta Discovery ni el orquestador, no escribe artículos y no realiza llamadas Groq.

## Fase 10C.2 — Scheduler → Pipeline Execution Bridge

El puente reutiliza exclusivamente `createProductionPipeline`; no existe una segunda composición de agentes. El modo es explícito:

- `preflight`: lee la cuota, valida la policy y puede adquirir/liberar un lease de namespace de test; no construye ni ejecuta el pipeline ni realiza llamadas al proveedor.
- `execute`: requiere autorización server-side, `test:*` y pasa por lease, duplicado y budget antes de construir el pipeline.

Durante esta fase el código fuerza en la frontera de ejecución `dryRun=true`, `publish=false`, `automaticRevision=false`, `maxRevisionAttempts=1`, `limit=1` y `hours=48`. Un `publish=true` no puede llegar al pipeline desde este scheduler. La primera ejecución manual debe usar `test:*`; nunca usa la identidad `scheduled:<fecha>:<slot>` de producción.

El resultado del pipeline se reduce a telemetría del scheduler: `pipeline_run_id`, decisión, número de intentos, estados finales compactos, requests usadas, cuota y duración. No se almacenan cuerpos editoriales. La migración `20260921000012_scheduler_execution_telemetry.sql` fue necesaria porque `scheduler_runs` no tenía columnas para auditar esta relación; no cambia RLS ni permisos del resto del modelo. La RPC de finalización sigue restringida a `service_role`.

La unidad del bridge cubre preflight sin pipeline, duplicado, lease activo, budget insuficiente, ejecución permitida, skip, revisión bloqueada, rechazo, fallo técnico, 429, release por owner y los flags de publicación/revisión. El wiring unitario conecta el scheduler a la composición productiva real con dependencias externas mockeadas.

Los horarios futuros documentados son `07:00 UTC`, `13:00 UTC` y `19:00 UTC`, que se clasifican como `morning`, `afternoon` y `night` tanto en invierno como en verano mediante `Intl.DateTimeFormat` para `Europe/Madrid`. No hay schedule productivo en `netlify.toml` y no se ha hecho deploy.

La prueba manual aislada se inicia únicamente con `npm run pipeline:scheduler:execute -- --confirm-test`; el script exige `SCHEDULER_TRIGGER_SECRET`, genera un trigger `test:scheduler-execute:*` y no imprime el secreto. Si esa variable no está configurada, se detiene antes de leer la cuota, adquirir el lease o construir el pipeline.

## Frontera hacia el futuro cron

La siguiente fase podrá activar un schedule de Netlify que construya `scheduledAt`, obtenga el snapshot de cuota, deduzca la identidad del slot, adquiera el lease persistente y, solo si el plan está permitido, invoque al orquestador. Los intervalos locales de slots ya están definidos en este documento; aún no se ha escogido ni activado una hora exacta de cron para cada slot. La function actual permanece preflight-only y conserva `dryRun=true`, `publish=false` y `automaticRevision=false`.
