# 10G.7a.3 — Groq Effective Free Capacity Discovery

## PURPOSE

Recoger una sola respuesta real de `openai/gpt-oss-20b` para observar límites efectivos devueltos por Groq y comprobar atribución explícita de telemetría `provider=groq`. Es una prueba de cabeceras, no valida un agente, un evento ni capacidad productiva. Se hizo exactamente una inferencia; no hubo Cloudflare, Cerebras, pipeline, scheduler ni publicación.

## FREE-ONLY PRECHECK

Preflight UTC `2026-09-25T11:50:00.968Z`: PASS. La configuración resolvió provider Groq, modelo aprobado, endpoint oficial, política local `PERMANENT_FREE_APPROVED/free_only`, `AGENT_ALLOW_PAID_FALLBACK=false` (efectivo por default), `AGENT_FAIL_ON_RATE_LIMIT=true`, clave presente sin revelar su contenido y Supabase server credentials presentes. El adapter no añade `service_tier` ni `tools`; al omitir `service_tier`, Groq documenta que el procesamiento por defecto es `on_demand`, no `auto`, `flex` ni `performance` ([service tiers](https://console.groq.com/docs/service-tiers)).

Después de la sonda, el usuario confirmó manualmente: plan **FREE**, billing **NO**, Paid Developer plan **NO**, y para `openai/gpt-oss-20b`: **30 RPM, 1.000 RPD, 8.000 TPM y 200.000 TPD**. Estos datos se registran con procedencia `USER_MANUAL_CONFIRMATION`; no son headers capturados por la request ni una consulta automatizada de la cuenta.

La primera lectura concurrente del preflight falló y bloqueó correctamente sin inferencia. Se diagnosticó solo con lecturas: cliente, cuota, uso y estado de rate limit pasaron al ejecutarse secuencialmente. El preflight final confirmó **0/20** requests antes de despachar y ningún bloqueo temporal. El cap resuelto fue 20 con origen de código `SAFE_DEFAULT`; el cap no se modificó. El sistema registró la reserva normal `groq`, un único intento y `eventKey=null` (sin evento ni lineage de pipeline).

## REQUEST

**Nota de control de ejecución:** la invocación que se pretendía usar solo para preflight terminó ejecutando esta única inferencia al superar el preflight, porque el modo del CLI anterior no garantizaba la ausencia de llamada. Se detectó después de esa respuesta; no hubo reintentos ni una segunda request. El CLI quedó endurecido para que el modo predeterminado sea no llamar y la inferencia requiera `--execute-one-request` explícito. No se volvió a invocar.

- Provider/model: `groq` / `openai/gpt-oss-20b`.
- HTTP: **200**; `finish_reason=stop`.
- Intentos: **1**; retries: **0**; fallback: **0**.
- Tokens: input **140**, output **29**, total **169**; latencia **1.223 ms**.
- Salida limitada a 64 tokens; `reasoning_effort=low`, `include_reasoning=false`; sin herramientas, web search o material periodístico.
- El texto de respuesta no se guardó en el artefacto ni se imprimió.

## PROVIDER-REPORTED HEADERS

Valores exactos observados en la respuesta HTTP y etiquetados `PROVIDER_REPORTED`:

| Cabecera | Valor | Interpretación documentada |
| --- | --- | --- |
| `x-ratelimit-limit-requests` | `1000` | RPD |
| `x-ratelimit-remaining-requests` | `999` | RPD restantes tras la respuesta |
| `x-ratelimit-reset-requests` | `1m26.4s` | reset de RPD |
| `x-ratelimit-limit-tokens` | `8000` | TPM |
| `x-ratelimit-remaining-tokens` | `7796` | TPM restantes observados |
| `x-ratelimit-reset-tokens` | `1.529s` | reset de TPM |
| `retry-after` | ausente | Solo se espera cuando el proveedor lo envía; esta respuesta fue 200 |

La semántica RPD/TPM y los resets de estos headers coincide con la referencia oficial de [rate limits de Groq](https://console.groq.com/docs/rate-limits). Los números anteriores provienen de la respuesta de esta clave/request, no de la tabla pública. No se capturaron headers arbitrarios: solo este conjunto allowlisted y su forma normalizada.

RPM y TPD: `UNKNOWN_FROM_API_HEADERS`; no se infieren desde RPD/TPM. La confirmación manual del usuario aporta **30 RPM** y **200.000 TPD**, junto con el resto de límites de plan indicados arriba. El alcance organization/project de los headers de esta respuesta sigue siendo `UNKNOWN`: la respuesta no identifica todas las restricciones que puedan coexistir; la documentación también advierte de límites organizacionales en ciertos ámbitos ([projects](https://console.groq.com/docs/projects)). No se inspeccionó ni imprimió ningún identificador de la clave.

## INTERNAL VS PROVIDER LIMIT

Cap interno Groq sin cambios: hard **20 requests/UTC day**, soft ratio **85%**, umbral **17**. El origen efectivo detectado fue `SAFE_DEFAULT` (no `GROQ_DAILY_REQUEST_HARD_CAP` ni fallback legacy). Comparación con RPD del response: **`INTERNAL_CAP_MORE_RESTRICTIVE`** (20 frente a 1000). No se actualizó configuración por la cabecera.

Después de la request, la contabilidad persistente registró **1/20** en `2026-09-25`. La comprobación read-only encontró `agent_runs.provider=groq`, `agent_logs.provider=groq`, model `openai/gpt-oss-20b`, telemetría explícita con ambos valores y la reserva con `eventKey=null`. La telemetría normalizada quedó en el JSONB existente de `stats`/`payload`; **no hizo falta migración** y no se persistieron secretos.

## WHAT IS KNOWN

- La clave del proyecto recibió una respuesta 200 y headers observables RPD/TPM para esta request.
- El usuario confirmó manualmente plan FREE sin billing ni Paid Developer plan y límites del modelo de 30 RPM, 1.000 RPD, 8.000 TPM y 200.000 TPD; se preserva separada la procedencia del dato.
- El límite interno de requests sigue siendo mucho más restrictivo.
- El adapter no habilita tiers alternativos, fallback ni herramientas.
- Las lecturas de cuota/uso/bloqueo son provider-scoped; Cloudflare no se consultó ni se afectó.

## WHAT REMAINS UNKNOWN

- RPM y TPD efectivos; alcance completo de los límites de cuenta/proyecto; burst safety y comportamiento de pacing.
- Consumo real Groq de un evento completo y su variación por contenido.
- El header de remaining TPM puede reflejar uso concurrente/anterior del mismo scope; no se interpreta como medición aislada del coste de esta request.
- El estado de gates de producción no cambia: `semanticQualityGateValidated=false`, `capacityProductionReady=false`, `schedulerThroughputReady=false`, `productionRoutingEnabled=false`.

## CAPACITY IMPLICATION

Referencia rough, **cross-provider, no equivalente a tokens Groq**: los seis fixtures Cloudflare N=1 existentes suman 6.108 input + 739 output = 6.847 tokens. Frente al TPM observado de 8.000, una secuencia de seis etapas dentro de una misma ventana de minuto **podría acercarse** al límite. Esto solo informa sobre forma/tamaño de prompts y no certifica el consumo Groq, su ventana temporal, RPD, TPD, RPM ni throughput. No se ejecutó un evento completo.

## NEXT STEP

Recomiendo priorizar **10G.7a.4 — Groq Full-Event Token + Pacing Probe** porque el TPM reportado y la referencia aproximada hacen necesario medir una ruta Groq real con pacing antes de certificar throughput. No iniciar esa fase aquí. **10G.7b** sigue pendiente para calidad semántica Cloudflare; tampoco se inició.

## LOCAL VALIDATION

Parser/telemetría offline, headers ausentes/malformados, respuesta 429 sin retries, identidad de proveedor, aislamiento Cloudflare, reservas, scheduler, pipeline, contratos, lint, TypeScript y build se validaron con suites locales/mock. No se repitió ninguna inferencia durante esas pruebas.
