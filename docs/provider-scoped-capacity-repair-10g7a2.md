# 10G.7a.2 — Provider-Scoped Capacity Architecture Repair

## STATE BEFORE

El audit 10G.7a.1 encontró que el cap de 20 requests se había conservado como safety de Groq, pero el guard en memoria y algunas lecturas de capacidad todavía podían interpretarlo como presupuesto común. La telemetría explícitamente atribuida a Groq era insuficiente para conocer sus límites efectivos: muestra fiable `N=0`; causa del último HTTP 429 desconocida. Esta fase es una reparación local de arquitectura; no certifica capacidad productiva.

## ROOT CAUSE

La cuota diaria y su preflight no compartían siempre una identidad de proveedor: el runtime mantenía estado de requests global y el scheduler consultaba un saldo general mientras la persistencia ya ofrecía reservas por proveedor. Eso podía hacer que una reserva/bloqueo de Groq afectara a Cloudflare, y viceversa en los guards locales. La contabilidad antigua sin proveedor explícito se conserva como Groq por seguridad.

Puntos auditados: `request-budget.ts` (`resolveGroqDailyRequestHardCap`, `ProviderScopedDailyRequestBudget`); `agent-runner.ts` (guard y reserva dentro de `runStructuredAgent`); `agent-logger.ts` (`getRemainingRequests`, `reserveProviderRequest`, `reserveCloudflareNeuronCapacity`, `getProviderDailyUsage`); `pipeline-budget.ts` (`createPersistentPipelineQuota`); `scheduler-runner.ts`/`scheduler-execution.ts` (cuota legacy explícita de Groq); `scheduler/provider-capacity-reader.ts` (`readSchedulerProviderCapacitySnapshot`). El único lector runtime de `AGENT_DAILY_REQUEST_LIMIT` es la resolución de cap en `request-budget.ts`; `.env.example`, tests y documentación solo lo describen/ejercitan. Se retiró del guard en memoria el singleton de cuota compartida.

## CONFIG RESOLUTION

`GROQ_DAILY_REQUEST_HARD_CAP` es el nombre canónico. Resolución: valor canónico explícito; si no existe, `AGENT_DAILY_REQUEST_LIMIT` como `LEGACY_GROQ_FALLBACK`; si tampoco existe, default conservador 20. Todos los valores se validan como enteros de 1 a 20. Un cap de cuenta Groq configurado también puede restringir ese límite, nunca ampliarlo. La variable antigua no se usa para Cloudflare y no se elimina todavía. La futura retirada requiere migrar la configuración local y confirmar despliegues.

## GROQ CAPACITY

- Hard request cap: 20 requests/día.
- El código no consulta `.env.local` en esta fase; 20 es el valor conservador del escenario/audit aportado y también el default/cap máximo local. La resolución runtime real de la variable local queda sin reauditar.
- Soft ratio: 85%; umbral entero: 17 requests.
- El enrutador evalúa el uso proyectado y exige quedar estrictamente por debajo del umbral soft. Un evento normal estima seis llamadas, por lo que el presupuesto de requests admite dos rutas completas en el escenario configurado.
- El límite diario de tokens, TPM y RPM efectivos de Groq son `NOT_CONFIGURED`/desconocidos. Por ello, la capacidad de requests conocida no significa capacidad completa certificada.

## CLOUDFLARE CAPACITY

La dimensión primaria es Neurons; no se inventa un límite diario de requests. La simulación offline usa hard 10.000, soft 8.500 y una reserva conservadora estimada de 2.381 Neurons por ruta completa. El router aplica también estado temporal/429 y cualquier restricción de requests que se configure explícitamente. Estos valores describen el escenario configurado de simulación, no una lectura de cuenta ni capacidad productiva verificada.

## RUNTIME GUARD

El presupuesto en memoria y los bloqueos son independientes por clave proveedor + fecha UTC. El runtime verifica el proveedor seleccionado y reserva su dimensión persistente antes de despachar: Groq usa reserva de requests atribuida a `groq`; Cloudflare usa la RPC existente de capacidad Neuron con `provider=cloudflare_workers_ai`. Un fallo local antes del despacho libera únicamente la reserva propia; tras `providerRequestDispatched=true` no se libera automáticamente. Un 429 bloquea solo el proveedor que lo recibió. El evento que recibe 429 falla cerrado; no cambia de proveedor.

## PERSISTENT ACCOUNTING

No hizo falta migración. Se reutilizan las RPC/tablas de reserva existentes, sin ejecutar operaciones remotas durante esta reparación. La lectura de requests de Groq incluye filas históricas sin proveedor como Groq conservador; las lecturas de Cloudflare exigen identidad y evidencia Cloudflare, y no consumen filas Groq no etiquetadas. El fixture de logger valida las RPC y filtros sin conexión remota.

## SCHEDULER

El lector de capacidad devuelve dimensiones separadas de Groq y `cloudflare_workers_ai` (uso diario y bloqueos), y proyecta la estimación de evento disponible sin activar ejecución. La quota legacy de pipeline está identificada expresamente como Groq. No se incrementaron `maxEventsPerRun`, slots ni límites de ejecución; no se ejecutó scheduler ni pipeline real.

## ROUTER

El router evalúa snapshots por proveedor, unidades no intercambiables y uso proyectado; separa elegibilidad de capacidad de elegibilidad productiva. Las simulaciones offline derivadas del código admiten dos rutas completas Groq + tres Cloudflare = cinco rutas configuradas. Con 10, 12 y 15 candidatos, respectivamente: Groq 2, Cloudflare 3, bloqueados 5; Groq 2, Cloudflare 3, bloqueados 7; Groq 2, Cloudflare 3, bloqueados 10. Son rutas hipotéticas, no artículos publicados ni certificación de capacidad.

La disponibilidad matemática de Cloudflare no abre producción: `semanticQualityGateValidated=false`, `capacityProductionReady=false`, `schedulerThroughputReady=false` y `productionRoutingEnabled=false`. Cerebras sigue trial-only y no se agrega como fallback.

## SECURITY HARDENING

`lib/supabase/server.ts` incorpora el marcador `server-only` y reexporta el helper Node/CLI separado, para mantener compatibilidad con scripts de servidor. La revisión de imports no encontró el helper Node/server ni el boundary elevado importados desde `app/` o `components/`. Esta fase no leyó `.env.local`, no llamó a proveedores y no accedió a Supabase remoto.

## GIT AUDIT

`git rev-parse --is-inside-work-tree` devuelve true y `--show-toplevel` apunta al directorio de HorizAI. `git ls-files` devuelve cero y `git status` muestra los archivos del proyecto como no rastreados. Por tanto, la limitación es que el repositorio está inicializado pero no tiene archivos rastreados; no es un directorio equivocado. No se ejecutaron `git init`, `git add`, commits ni reescrituras.

## SIMULATIONS

La simulación reproducible `npm run provider:router:simulation` usa fixtures locales y produjo: Groq 20 hard / 17 soft / 6 requests por ruta / 2 rutas; Cloudflare 10.000 hard / 8.500 soft / 2.381 Neurons estimadas por ruta / 3 rutas; total aritmético 5. Escenarios 10/12/15: `[Groq=2, Cloudflare=3, bloqueados=5/7/10]`. No realiza llamadas externas ni representa capacidad productiva.

## REMAINING BLOCKERS

- Límite diario de tokens Groq: desconocido/no configurado.
- TPM y RPM efectivos de Groq: desconocidos/no configurados.
- Telemetría fiable explícita de requests Groq: `N=0`; burst y causa del 429 no verificados.
- El rendimiento conservador configurado queda por debajo del objetivo aproximado de 12–15 candidatos/día.
- Quality gate semántico no validado; throughput del scheduler no listo.

Estado de cierre esperado: arquitectura provider-scoped y safety free-only validadas offline; `technicalAllStagesValidated=true`; `capacityArchitectureProviderScoped=true`; `freeOnlySafetyValidated=true`; `capacityProductionReady=false`; `schedulerThroughputReady=false`; `productionRoutingEnabled=false`. Ninguna fase posterior se activa.
