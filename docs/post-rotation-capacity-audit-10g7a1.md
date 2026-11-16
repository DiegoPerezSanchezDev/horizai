# HorizAI — auditoría post-rotación y capacidad remota (10G.7a.1)

**Fecha:** 25 de septiembre de 2026  
**Cierre:** `READY YES` para esta auditoría de solo lectura; no significa que el runtime o el enrutamiento estén listos para producción.

## SECURITY

- La URL y la credencial server-side actuales están presentes. El código consume `NEXT_PUBLIC_SUPABASE_URL` y **`SUPABASE_SECRET_KEY`**; el secreto se clasificó localmente como `SUPABASE_SECRET_KEY` sin imprimir su valor. La lectura autenticada de `agent_runs` tuvo éxito (110 filas) y el proyecto remoto coincide con el proyecto HorizAI configurado (`skrthgpurquypgdwxast`). `newCredentialValidated=true`.
- El usuario confirmó la rotación anterior; `supabaseServiceCredentialRotationRequired=false` y `oldCredentialUseAttempted=false`. No se recuperó ni probó la credencial anterior. La revocación se considera confirmada por el usuario, no se verificó con una llamada usando la credencial antigua.
- `.env.local` está ignorado por Git. La comprobación exacta del secreto actual encontró cero coincidencias en `.next/static`, `public`, artifacts y logs; los patrones de secretos reconocidos dieron cero coincidencias en artifacts/logs.
- `currentTrackedSecretExposure=NO`, con una limitación importante: `git ls-files` devuelve **cero archivos trackeados en este checkout**. Esto no es una auditoría del historial Git ni permite afirmar que un repositorio publicado esté limpio. No se reescribió historia.
- El helper `lib/supabase/server.ts` solo se referencia desde módulos/scripts server-side en el árbol comprobado; no hay referencias directas desde `app/` o `components/`, ni apareció el secreto en assets públicos o bundle cliente. Resultado: **PASS para el uso y bundle actuales**. Caveat: el helper no importa el marcador de compilación `server-only`; esta auditoría no añade código ni presenta la ausencia del marcador como una garantía de compilación futura.
- Lecturas remotas permitidas para la auditoría: `remoteOperationsAllowed=true` (alcance de lectura solamente). Escrituras remotas: `0`.

## REMOTE TELEMETRY

Con la credencial nueva solo se hicieron lecturas Supabase, sin RPC. Se leyeron `agent_runs`, `agent_logs` y `pipeline_event_attempts`; también se hizo el mínimo `HEAD count` de conectividad sobre `agent_runs`.

| Estructura | Filas visibles | Observación |
|---|---:|---|
| `agent_runs` | 110 | 67 llevan un objeto `stats.telemetry`; las demás no ofrecen telemetría utilizable. |
| `agent_logs` | 327 | 92 son reservas `provider_request_reserved`. |
| `pipeline_event_attempts` | 3 | Incluye un intento detenido en Critic con `PROVIDER_RATE_LIMIT`. |

Para atribuir proveedor se exigió un `stats.telemetry.provider` o `config.provider` explícito; el nombre de modelo por sí solo no basta. Con esa regla: `CONFIRMED_GROQ=0`, `CONFIRMED_CLOUDFLARE=9`, `CONFIRMED_OTHER=0`, `UNKNOWN_PROVIDER=101` (58 filas con telemetry sin identidad utilizable y 43 sin telemetry). No hubo discrepancias entre la identidad de proveedor en telemetry y la columna de proveedor cuando ambas estaban presentes.

La migración `20260923000019_provider_scoped_request_budget.sql` rellenó `agent_runs.provider='groq'` para registros históricos basándose también en el modelo `openai/gpt-oss-20b`; 100 filas tienen esa columna, pero no `config.provider` ni proveedor explícito en telemetry. Esas filas, y las reservas cuyo payload solo identifica el modelo, se mantienen `UNKNOWN_PROVIDER` para este análisis.

El 25-09-2026 UTC se observó una reserva reciente, marcada como Cloudflare, despachada. No se modificó ni creó ninguna reserva durante esta auditoría. Llamadas de inferencia Groq/Cloudflare/Cerebras: `0/0/0`.

## GROQ SAMPLE

La muestra **confirmada** de llamadas Groq es `N=0` en las seis etapas. Por etapa (Verifier, Translator, Editor, Classifier, Ranker, Critic): llamadas confirmadas `0`; HTTP 200 `0`; HTTP 429 confirmado `0`; otros errores confirmados `0`; input/output/total tokens conocidos `0`. Esto expresa ausencia de muestras con identidad fiable, no prueba que nunca hubiera llamadas Groq.

Las estadísticas median/p75/p90/max de tokens por etapa y evento son `INSUFFICIENT_SAMPLE`; no se calculan percentiles con `N=0`. Para futuras muestras, usar percentil nearest-rank `rank=ceil(p*N)` y exigir `N>=20` antes de interpretarlos como robustos. No hay `STAGE_SUMMED_ESTIMATE` Groq porque tampoco hay métricas de etapa atribuibles con fiabilidad.

Eventos completos de seis etapas Groq reconstruibles mediante `eventKey`/`pipeline_run_id`: `0`. Hay tres filas de intentos de evento, pero ninguna puede enlazarse a llamadas con identidad Groq explícita en telemetry/config. No se cuentan rutas saltadas ni registros ambiguos como rutas Groq completas.

## GROQ 429 FORENSICS

La consulta encontró **dos registros telemetry HTTP 429 de Critic**, el 18-09-2026 10:37:17 UTC y el 23-09-2026 19:46:07 UTC. Ambos indican `FREE_TIER_LIMIT_REACHED`, un intento y una petición despachada; ambos carecen de `config.provider`, `stats.telemetry.provider`, cabeceras de rate limit y tokens input/output. Su columna `agent_runs.provider='groq'` no resuelve la identidad porque fue rellenada por la migración a partir del modelo. Por tanto:

- HTTP 429 persistido: **2 incidentes de proveedor ambiguo**; HTTP 429 confirmado como Groq: **0**.
- El intento conocido de pipeline en Critic del 23-09 se detuvo con `PROVIDER_RATE_LIMIT`, consistente con el registro 429 cercano, pero la atribución del proveedor no es verificable.
- Causa de cuota: `UNKNOWN`. No hay evidencia para distinguir ventana TPM, RPM/request-window o daily. `retry-after`, resets, remaining, límites y contexto de tokens no fueron persistidos.
- Último metadata de límite reportado por Groq: `NOT_FOUND`; riesgo de burst: `INSUFFICIENT_DATA`.

No se intenta reparar esos registros ni reconstruir cabeceras ausentes.

## LEGACY GLOBAL CAP

`AGENT_DAILY_REQUEST_LIMIT` no está definido en `.env.local`; el default efectivo del código es **20**. El guard persistente de `reserve_agent_request` tiene estado `ACTIVE_GROQ_ONLY_CAP`: la migración `20260923000020_label_legacy_groq_reservations.sql` valida el modelo Groq aprobado, reserva con `provider='groq'` y cuenta reservas Groq o históricas nulas. No es una cuota persistente global que cuente las reservas Cloudflare como Groq.

Sin embargo, quedan dos interferencias multi-provider en arquitectura local: `runStructuredAgent` usa `reserveRequest` (no `reserveProviderRequest`), y su `DailyRequestBudget` en memoria no separa proveedores; además, el lector de cuota del scheduler cuenta todas las filas `provider_request_reserved`, sin filtro de proveedor. Por ello `GLOBAL_CAP_INTERFERES_WITH_MULTI_PROVIDER=YES` para el guard en memoria y la decisión de presupuesto del scheduler, aunque la RPC duradera del límite de 20 sea Groq-only. El RPC provider-scoped existe, pero no tiene callsite desde `AgentRunner`; con el cableado actual, el camino genérico de `AgentRunner` no puede despachar Cloudflare correctamente porque su RPC genérico exige el modelo Groq aprobado. Las rutas especiales de validación Cloudflare utilizan RPCs dedicadas de Neurons y no convierten el pipeline normal en provider-scoped.

## GROQ CAPACITY

| Límite/configuración | Estado efectivo |
|---|---|
| Límite interno de requests | 20/día por default de código; RPC persistente Groq-only. |
| `GROQ_FREE_DAILY_REQUEST_LIMIT` | `NOT_CONFIGURED` (no es la misma variable que el guard interno). |
| `GROQ_FREE_DAILY_TOKEN_LIMIT` | `NOT_CONFIGURED`. |
| `GROQ_FREE_MINUTE_REQUEST_LIMIT` / RPM | `NOT_CONFIGURED`. |
| `GROQ_FREE_MINUTE_TOKEN_LIMIT` / TPM | `NOT_CONFIGURED`. |
| Soft ratio | 0.85 por default de código; variable de entorno ausente. |

Con seis llamadas por ruta completa, el límite aritmético de requests es `floor(20/6)=3` rutas/día. Si se aplica el soft ratio existente a ese hard cap efectivo, quedan 17 requests y `floor(17/6)=2` rutas. La capacidad **real total** de Groq es `UNDETERMINED`: no hay muestra confirmada ni límites diarios/minuto de cuenta, y la política de routing permanece apagada. No se aplica 85% a límites de tokens inexistentes.

Como sensibilidad para el target provider-scoped, reutilizar 20 requests como hard cap independiente de Groq produciría 3 rutas hard o 2 al 85%; esto es una hipótesis aritmética, no una configuración ni una lectura de cuota real de Groq. Capacidad por tokens diaria/mediana/p75/p90: `UNDETERMINED`. Seguridad de ejecución inmediata frente a ventanas móviles: `UNDETERMINED` (sin muestra/cabeceras); requerir pacing informado por proveedor antes de concurrencia.

## CLOUDFLARE CAPACITY

Se reutiliza únicamente el snapshot local de 10G.6e; no se consultó Cloudflare. El artefacto [`cloudflare-capacity-snapshot-10g6e.json`](../artifacts/cloudflare-capacity-snapshot-10g6e.json) contiene N=1 validación técnica por etapa y reservas conservadoras por etapa 388, 394, 390, 370, 360 y 479; suma: **2,381 Neurons/ruta**. Hard diario 10,000; soft 85% = 8,500; `floor(8500/2381)=3` rutas conservadoras limpias/día.

Las seis reservas reales de validación supervisada suman 2,388 Neurons, mientras la estimación post-respuesta derivada de tokens suma **405 Neurons/ruta**. 405 es estimación token-derived N=1/etapa, no consumo real reportado por proveedor; 20 rutas es solo capacidad teórica informativa y no se usa para admisión. El modelo no tiene aprobación de structured-output para producción y el routing está desactivado.

## COMBINED CAPACITY

Estas son simulaciones de **rutas completas de candidatos**, nunca artículos publicados garantizados. Asumen cero consumo previo y cero retries; las cuotas reales, los fallos y el yield editorial/verificación pueden reducir resultados.

| Candidatos/día | Arquitectura actual: soft 85%, Groq primario, Cloudflare no aprobado | Provider-scoped hipotético: Groq 2 + Cloudflare 3 conservador* |
|---:|---:|---:|
| 10 | 2 rutas Groq; 0 Cloudflare; 8 bloqueados | 5 rutas; 5 bloqueados |
| 12 | 2 rutas Groq; 0 Cloudflare; 10 bloqueados | 5 rutas; 7 bloqueados |
| 15 | 2 rutas Groq; 0 Cloudflare; 13 bloqueados | 5 rutas; 10 bloqueados |

`*` El escenario provider-scoped asume, solo para comparar, un cap Groq independiente de 20 requests/día (17 a soft 85%, dos rutas) y los 8,500 Neurons soft de Cloudflare (tres rutas de 2,381). Requiere gates/routing compatibles que hoy están apagados; Groq no tiene caps de cuenta configurados. El hard ceiling request-only sin soft es tres rutas Groq. En arquitectura actual el ledger/lector del scheduler limita el agregado nominal a tres rutas hard; el escenario de tabla usa el soft policy y la compuerta Cloudflare actual. La ruta actual automática es cero porque el router está desactivado.

## SETTLEMENT

Decisión: `UNDETERMINED`. No hay capacidad Groq confirmada, y tres rutas Cloudflare conservadoras no establecen que se puedan sostener los objetivos de 10–12 candidatos sin settlement; además, settlement no resolvería límites de requests, routing apagado ni la falta de yield. No implementar settlement en esta fase.

## SCHEDULER

- Slots conceptuales: 3/día (`morning`, `afternoon`, `night`), zona `Europe/Madrid`.
- `SCHEDULER_MAX_EVENTS_PER_RUN`: default planner 3, máximo planificador teórico 9 candidatos/día si se invocara cada slot.
- Bridge de ejecución: `EXECUTION_MAX_EVENTS_PER_RUN=1`.
- `netlify.toml`: sin `schedule`; cron activo: no; candidatos ejecutados automáticamente ahora: 0.
- Techo recomendado: **0 automático hoy**; como objetivo de diseño inicial, no más de **2 rutas completas/día** bajo el soft request budget conocido hasta medir/configurar capacidad y separar los budgets; mantener una por ejecución. 12–15 candidatos no están soportados. Bloqueos primarios: falta de cuota Groq por tokens/RPM/TPM, atribución/telemetría incompleta, presupuesto de scheduler compartido y gates de calidad/routing falsos.

## NEXT GATES

| Gate | Estado |
|---|---|
| `technicalAllStagesValidated` | `true` (6/6 técnico, estado previo; no certifica calidad semántica). |
| `semanticQualityGateValidated` | `false`. |
| `capacityProductionReady` | `false` (muestra Groq N=0, límites específicos ausentes, telemetría histórica ambigua). |
| `schedulerThroughputReady` | `false`. |
| `freeOnlySafetyValidated` | `true` para las policies inspeccionadas: allowlist free-only, paid fallback efectivo false; router apagado. No es una activación. |
| `productionRoutingEnabled` | `false`. |
| settlement | no implementado. |

**10G.7a.1 READY: YES — auditoría cerrada, solo lectura.** La siguiente fase recomendada por evidencia es **10G.7a.2 — reparación de arquitectura de capacidad** (telemetría con provider explícito desde el inicio, conexión del presupuesto provider-scoped al runtime/scheduler y límites Groq de cuenta antes de volver a medir). No avanzar a 10G.7b ni activar routing en esta fase.

## Validación offline

Tras las lecturas remotas se ejecutaron las suites offline listadas en el JSON adjunto, además de `npm run lint`, `npx tsc --noEmit` y `npm run build`. No se ejecutaron pruebas de integración/preflight remotas. Resultado final: **PASS** para todas. No se realizaron llamadas de inferencia, escrituras Supabase, ejecuciones de pipeline/scheduler ni publicación.
