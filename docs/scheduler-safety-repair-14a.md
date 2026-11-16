# Scheduler Safety Repair — 14A

## Alcance y estado

14A prepara localmente el worker supervisado y su control durable. No aplica M40, no despliega funciones, no configura una ejecución programada y no activa el scheduler. El siguiente paso operativo queda fuera de esta fase.

- Implementación local 14A: **READY**.
- Preparación para QA desplegado de 14B: **NO**; M40 aún no está aplicada y no se ha revisado el balance de créditos/consumo actual del equipo.
- Ejecuciones reales en esta fase: `0`.
- Llamadas a proveedores: `0`.
- Cambios remotos y escrituras de datos reales: `0`.

El trabajo sigue `OBSERVE → PLAN → EXECUTE → CRITIQUE → VERIFY`: se conservó el runner existente, se añadió el control requerido alrededor del ciclo supervisado y las verificaciones fueron offline.

## Arquitectura preparada

```text
Scheduled kickoff (sin schedule adjunto)
    └─ POST de metadata UTC pequeña
       └─ Background Function (13 min de presupuesto interno)
          ├─ M40: idempotencia diaria + lease global cercado
          ├─ inspección de intentos abiertos
          └─ resume del mismo intento o, si no hay ambigüedad, un ciclo supervisado

Runner manual supervisado
    └─ misma identidad UTC + claim M40 + heartbeat
       └─ lease heredado de scheduler_runs + ciclo supervisado
```

`netlify/functions/horizai-supervised-kickoff.ts` no compone ni ejecuta el pipeline. Envía solamente `utcDate`, `triggerId` e `invocationId`. La función worker declara `config.background = true`, autentica la llamada con un token interno antes de crear el cliente Supabase y reclama M40 antes de inspeccionar el estado o componer el pipeline.

La función kickoff no exporta `config.schedule` y no hay schedule de 14A en `netlify.toml`. Ambas funciones requieren sus flags de activación en `true`; por tanto, el código local no inicia el scheduler por sí solo.

El runner manual `scripts/supervised-pipeline-run.ts` reclama el mismo invocation ID diario y el mismo lease global cercado antes de tomar el lease heredado de `scheduler_runs`. Ambos caminos renuevan M40 cada minuto y aplican el mismo presupuesto de ejecución y timeout por etapa. El runner manual hace una lectura de intentos abiertos antes del claim para no consumir el día cuando ya existe trabajo pendiente, y vuelve a comprobar después del claim; si hay un intento abierto, termina sin Discovery y deja el resume al worker. El runner manual requiere M40 aplicado antes de volver a ejecutarse.

## Idempotencia, lease y recuperación

La migration local `supabase/migrations/20261022120000_scheduler_safety_repair_m40.sql` prepara:

- Una fila de lease global, bloqueada con `FOR UPDATE`, con owner, vencimiento y `fencing_token` monotónico.
- Una fila de invocación única por `utc_day`, `trigger_id` e `invocation_id`. Las identidades válidas son `supervised-candidates:<YYYY-MM-DD>` y `horizai-supervised:<YYYY-MM-DD>`.
- El worker background y el runner manual usan el mismo claim canónico por día; un claim no puede representar dos owners ni permitir concurrencia entre ambos caminos.
- Un claim diario serializado: una entrega repetida devuelve el estado ya reclamado. El vencimiento permite recuperar un lease antiguo y marca la ejecución anterior `STOPPED / STALE_LEASE_RECOVERED`.
- Heartbeat cada minuto y finalización que requiere owner y fencing token coincidentes. Una renovación fallida cierra la compuerta para iniciar etapas semánticas adicionales. El acceso directo a las tablas queda revocado; las funciones RPC son solo para `service_role`.
- RPCs M40 para diferir antes de despachar por capacidad o presupuesto de tiempo y para reclamar/liberar la continuación del mismo intento.

M40 está **preparada localmente, no aplicada remotamente**. La prueba de 14A valida el contrato estático; no sustituye una validación PostgreSQL/Supabase al aplicar la migration en una fase autorizada.

## Resume-first y límites del ciclo

Antes de Discovery, el worker lee todos los intentos abiertos:

- Sin intentos abiertos: puede empezar un candidato.
- Un único intento diferido válido: reanuda ese mismo intento y etapa.
- Intento activo/ambiguo, checkpoint de la etapa siguiente, dispatch previo de esa etapa o varios intentos: termina sin Discovery.

La reanudación comprueba identidad del snapshot, etapa, lineage, accounting pendiente y evidencia de dispatch/checkpoint. Los outputs tipados y sus hashes validados se guardan en el snapshot durable del intento; no se depende de que el filesystem efímero de Netlify sobreviva entre invocaciones. Un uso de proveedor desconocido bloquea el resume.

El pipeline queda en `mode: supervised`, `dryRun: true`, `publish: false`, `automaticRevision: false`, hasta 3 intentos/eventos y un máximo de 6 candidatos de extracción según la política supervisada existente. Mantiene concurrencia secuencial, Groq solamente, retries `0`, fallback pagado `0`, un máximo de una review `WAITING_FOR_HUMAN_REVIEW` y Publisher desactivado. El cap de solicitudes acumulado por intento/invocación es `18`, incluyendo el uso previo recuperado del snapshot.

## Presupuesto temporal

Netlify permite hasta 15 minutos para una Background Function en los planes compatibles. El worker y el runner manual cortan el inicio de etapas semánticas después de 13 minutos, reservan 3 minutos de margen y fijan el timeout máximo de etapa en 60 segundos. El lease dura 17 minutos y ambos caminos lo renuevan cada minuto mientras están activos. El paro pre-dispatch se persiste como `WORKER_TIME_BUDGET_EXHAUSTED`, separado de `PROVIDER_CAPACITY_EXHAUSTED`, y conserva el intento/snapshot para el siguiente ciclo.

La función background tiene una entrega inmediata `202`; cualquier repetición de plataforma usa la misma identidad diaria y queda bloqueada por el claim durable. El runtime persiste el marcador de dispatch antes de iniciar la petición del proveedor. Si el resultado queda ambiguo, el intento abierto y la evidencia de dispatch impiden que el siguiente ciclo vuelva a Discovery o repita esa etapa. La recuperación de un intento ambiguo exige reconciliación humana.

## Plan y estimación de coste

El usuario confirmó el plan del equipo: **Credit-based Free**. La documentación de Netlify indica 300 créditos mensuales con hard limit, sin auto-recharge, Background Functions disponibles y 10 créditos por GB-hora de compute. Netlify documenta también un máximo de 15 minutos para Background Functions y 30 segundos para Scheduled Functions.

Estimación de compute para 30 días, suponiendo 1 GB asignado, una ejecución diaria y el runtime observado de `60,852 ms`:

`10 créditos/GB-h × 1 GB × (60,852 s + 8 s) × 30 / 3.600 s = ~5,74 créditos/mes`

Límite conservador según el presupuesto local de 13 minutos por worker y el timeout de 8 segundos del kickoff:

`10 créditos/GB-h × 1 GB × (13 min + 8 s) × 30 / 60 min = ~65,67 créditos/mes`

El límite no supone que todos los workers duren 13 minutos; la primera cifra usa el runtime observado y la segunda cubre el máximo interno diario. Ambas excluyen web requests, deployments de producción (15 créditos por deploy exitoso según Netlify), consumo del resto de sitios/proyectos y uso ya ocurrido en el periodo. El encaje en el balance real del equipo es **UNKNOWN** hasta consultar el uso mensual del equipo/proyecto. El kickoff tiene una espera HTTP limitada a 8 segundos; su runtime real no se midió porque no se invocó.

Referencias de plataforma:

- [Netlify Background Functions](https://docs.netlify.com/build/functions/background-functions/)
- [Netlify Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/)
- [Netlify compute and credit usage](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)
- [Credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)

## Gates y regresiones

La prueba nueva `scheduler:14a:unit` cubre identidades UTC, validación de metadata, guard de token, resume-first, cap 18, fencing/idempotencia simulados, competencia worker/manual sobre la misma identidad diaria, cierre de la compuerta al perder heartbeat, presupuesto temporal y defer sintético pre-dispatch que conserva el mismo intento sin ejecutar Translator. `pipeline:editor-capacity-resume:unit` modela el shape diferido de Editor generación `0`, con Verifier y Translator previos, los mismos dos usos sintéticos, resume de Editor, cero replay de las etapas previas y misma fila de intento; el presupuesto de resume devuelve `16` restantes.

También pasaron suites offline de capacity/resume y M33/M35, provider capacity y accounting Groq/M36, scheduler (incluido duplicado/concurrencia/stale lease), pipeline supervisado y snapshots, además de human review M31/M32/M34/M39. Se incluyeron los terminales de WAITING y Critic revision, sin Publisher automático. La suite `pipeline:12f10a:unit` detectó un método de defer invocado sin su contexto `this`; se corrigió y la suite completa pasó al repetirse.

Gates finales:

- `npm.cmd run lint`: PASS.
- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run build -- --webpack`: PASS con `CIRCLE_NODE_TOTAL=2` (Next prerenderizó con 1 worker) y permiso ampliado limitado a crear los artefactos locales de `.next`. Las ejecuciones dentro del sandbox dieron `EPERM` al crear carpetas `.next` en OneDrive. Next reportó que `NEXT_PUBLIC_SITE_URL` no está configurada y deshabilitó metadata de indexación; no bloqueó el build.
- `git diff --check`: PASS (Git mostró avisos de conversión LF/CRLF ya asociados al working tree).
- `node scripts/safe-secret-audit.mjs`: PASS; 0 archivos con hallazgos, `.env.local` ignorado.
- Provider accounting delta / proveedor real: `0`.

## Cierre

**12F/13F no se inicia desde esta fase. 14A queda READY a nivel de implementación local.** Antes de 14B faltan la aplicación de M40, el despliegue/QA en Netlify, la lectura del balance/uso actual del equipo y una autorización operativa independiente. No se configuró cron, no se invocó el kickoff ni el worker, no se aplicó migration y no se reanudó ningún intento real.
