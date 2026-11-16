# Groq capacity policy — 10G.7a.5

## Estado y alcance

Esta fase define e implementa la política de capacidad Groq, la configuración local y las comprobaciones offline. No ejecuta inferencia, pipeline ni scheduler y no activa routing. La migración 25 (`20260925000025_groq_atomic_token_capacity.sql`) permanece aplicada y sin cambios; no se ejecutan migraciones ni se modifica el esquema.

## Evidencia y procedencia de límites

La cuenta fue confirmada manualmente como **FREE**, con billing deshabilitado y el modelo `openai/gpt-oss-20b`. Esta es evidencia de estado de cuenta aportada por el operador; el runtime no puede impedir que la cuenta cambie de plan después.

| Límite | Valor | Procedencia |
| --- | ---: | --- |
| RPD | 1.000 | Confirmación manual; también observado en headers |
| TPD | 200.000 | Confirmación manual; Groq no reportó TPD en los headers observados |
| RPM | 30 | Confirmación manual |
| TPM | 8.000 | Confirmación manual; también observado en headers |

No se atribuye ningún límite de cuenta a documentación pública. Los headers RPD/TPM complementan la evidencia de cuenta, pero la contabilidad diaria interna es la autoridad local.

El full path real N=1 tuvo seis requests y consumió 8.949 tokens de entrada, 1.398 de salida y **10.347 en total**. Duró 63.601 ms, con 50.577 ms de espera de pacing y cero respuestas 429. La suma sin pacing de 10.347 superó el TPM 8.000; el path terminó correctamente mediante pacing informado por headers. El valor aproximado de rolling-60s 8.626 permanece diagnóstico, no es evidencia de que Groq haya excedido su propio limiter. La evidencia por etapa y headers allowlisted está en [el artefacto 10G.7a.4](../artifacts/groq-full-path-capacity-probe-10g7a4.json).

## Configuración y precedencia

`.env.local` contiene los valores numéricos canónicos no secretos. `.env.example` documenta los mismos nombres y su procedencia.

| Variable | Valor local | Uso |
| --- | ---: | --- |
| `GROQ_DAILY_REQUEST_HARD_CAP` | 1.000 | Reserva diaria de requests Groq |
| `GROQ_DAILY_TOKEN_HARD_CAP` | 200.000 | Reserva diaria de tokens Groq |
| `GROQ_REQUESTS_PER_MINUTE_HARD_CAP` | 30 | Política RPM; modo secuencial inicial |
| `GROQ_TOKENS_PER_MINUTE_HARD_CAP` | 8.000 | Límite de pacing por etapa |
| `GROQ_EVENT_TOKEN_PLANNING_MARGIN_PERCENT` | 25 | Proyección de consumo para eventos nuevos |
| `GROQ_MAX_CONCURRENT_EVENTS` | 1 | Límite de concurrencia de eventos Groq aprobado inicialmente |

`AGENT_DAILY_REQUEST_LIMIT` queda como fallback legado Groq-only, válido entre 1 y 20. La precedencia es el cap canónico Groq (1–1.000), el fallback legado (`LEGACY_GROQ_FALLBACK`) y, si ambos faltan, el default conservador 20. Con el valor canónico configurado, ni `AGENT_DAILY_REQUEST_LIMIT=20` ni `GROQ_FREE_DAILY_REQUEST_LIMIT` lo reducen. Cloudflare ignora ambas variables. Cerebras sigue fuera del router y trial-only.

## Límites diarios y admisión

La razón soft existente es 0,85 y se aplica dinámicamente:

- RPD hard 1.000 → RPD soft 850.
- TPD hard 200.000 → TPD soft 170.000.

Un evento completo proyecta seis requests. Su proyección diaria de tokens usa el path real N=1 más margen; no suma las reservas máximas estimadas por etapa. Para admitir un evento Groq nuevo, la proyección de uso diario más seis requests y los tokens provisionales debe quedar dentro de los caps hard y soft. Si el uso de tokens es desconocido, se bloquea la admisión. Cada request real sigue usando su propia reserva atómica.

La capacidad por requests es `floor(850 / 6) = 141` eventos completos equivalentes por día. Los requests ya no son la dimensión diaria limitante.

## Proyección de evento N=1

Se usa `ceil(tokens observados × (1 + margen))` en todas las sensibilidades:

| Margen | Tokens provisionales por evento | Eventos dentro de 170.000 soft TPD |
| ---: | ---: | ---: |
| 10% | 11.382 | 14 |
| 15% | 11.900 | 14 |
| 20% | 12.417 | 13 |
| 25% | 12.934 | 13 |

Con 25%, la capacidad provisional por tokens es `floor(170.000 / 12.934) = 13`; la capacidad final provisional es `min(141, 13) = 13` eventos equivalentes al día. La etiqueta es **`PROVISIONAL_N1_CAPACITY`**, no rendimiento productivo garantizado.

Solo existe un full path Groq completo. El 25% da margen operativo significativo con esa muestra escasa; no afirma p90 ni p95 y no se escogió para hacer caber 15 eventos. Las reservas por etapa se ajustan al uso real después de cada respuesta exitosa, por lo que el margen de planificación no infla permanentemente el ledger. Se podrá recalibrar cuando existan más full paths reales y completos.

## Contabilidad atómica y settlement

Antes de cada HTTP Groq, `AgentRunner` usa la RPC existente de migración 25 para reservar **una request y el estimado conservador de esa etapa** dentro de la misma operación. El estimador existente de etapa (caracteres/2, overhead 128 y máximo de salida) se conserva; no se sustituye por 12.934 tokens.

Después de una respuesta exitosa con usage confiable, el runtime liquida atómicamente `inputTokens + outputTokens`. El ledger pasa de la estimación reservada al valor real, incluso si el real supera el estimado. Si la respuesta no trae usage confiable después de dispatch, conserva la estimación completa y cuenta la request. Si el evento termina antes de seis etapas, solo quedan contabilizadas las etapas que realmente despachó; no se cargan tokens ficticios.

El token settlement ocurre antes de validar la salida estructurada. Así, un HTTP exitoso con usage confiable se contabiliza aunque el JSON después no pase Zod. Un conflicto de settlement falla cerrado y no libera una reserva ya despachada.

## TPM header-driven

El TPM 8.000 limita cada etapa individual y usa el margen de seguridad existente de 128 tokens. Para las etapas de eventos Groq después de Verifier, el runtime lee la telemetry más reciente del mismo `eventKey` y toma `tokenRemainingMinute` y `tokenResetSeconds` de los headers Groq persistidos.

- Headroom suficiente: `IMMEDIATE`.
- Headroom insuficiente y reset válido: `WAIT_FOR_TOKEN_RESET` por el reset informado más el margen fijo existente de 250 ms.
- Headers, remaining o reset desconocidos: `GROQ_TPM_STATE_UNKNOWN`, sin dispatch.
- Etapa estimada por encima del TPM seguro: se bloquea antes de dispatch.
- Estado 429 vigente: `GROQ_TEMPORARILY_BLOCKED` para Groq; no bloquea Cloudflare.

No se añade jitter ni sleeps aleatorios. Los headers en vivo gobiernan el pacing; la aproximación rolling-60s local es solo diagnóstica. Las cabeceras RPD siguen capturándose. TPD no se infiere de headers: se protege con el ledger persistente basado en tokens y el cap manual de 200.000.

## RPM y concurrencia

RPM 30 está confirmado, pero no se ha validado ejecución de eventos paralelos. La política inicial requiere `maxConcurrentGroqEvents <= 1`; si se propone más concurrencia, el guard devuelve `GROQ_RPM_CONCURRENCY_NOT_APPROVED` y no deja que `schedulerThroughputReady` pase a true. El valor actual configurado es 1, mientras que `schedulerThroughputReady` permanece false por los gates de throughput aún pendientes.

No se crea un limiter distribuido RPM ni se hace un load test en esta fase. Cualquier concurrencia Groq futura requiere una política RPM provider-scoped separada. La RPC atómica diaria sigue siendo la autoridad ante carreras de accounting diario; los headers RPD son evidencia adicional de drift.

## Simulaciones offline

Las simulaciones usan un día nuevo, uso inicial cero y 12.934 tokens por evento. El total proyectado incluye todos los candidatos; admitido/bloqueado aplica la política por evento.

| Candidatos | Requests planeadas | Tokens planeados | Soft RPD | Soft TPD | Groq admitidos | Bloqueados | Tokens provisionados para admitidos |
| ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| 10 | 60 | 129.340 | Cumple (≤850) | Cumple (≤170.000) | 10 | 0 | 129.340 |
| 12 | 72 | 155.208 | Cumple (≤850) | Cumple (≤170.000) | 12 | 0 | 155.208 |
| 15 | 90 | 194.010 | Cumple (≤850) | No cumple | 13 | 2 | 168.142 |

Para 15, los dos últimos candidatos se bloquean con `GROQ_DAILY_TOKEN_SOFT_LIMIT`. La request soft no limita ninguno de estos tres escenarios.

**`FUTURE_CAPACITY_IF_CLOUDFLARE_QUALITY_APPROVED`** es una simulación futura, no routing activo. Asume 13 paths provisionales Groq y 3 full paths conservadores Cloudflare:

| Candidatos | Groq | Cloudflare hipotético | Bloqueados |
| ---: | ---: | ---: | ---: |
| 10 | 10 | 0 | 0 |
| 12 | 12 | 0 | 0 |
| 15 | 13 | 2 | 0 |

Cloudflare conserva hard 10.000 Neurons, soft 8.500, capacidad conservadora 3 y gate semántico false. Su routing sigue bloqueado.

## Recomendación y limitaciones

Las simulaciones sostienen un objetivo de planificación inicial de **12 eventos candidatos por día**: cabe en la proyección Groq con margen diario y no depende de aprobación de calidad Cloudflare. Es una recomendación de diseño; esta fase no modifica el scheduler ni convierte eventos admitidos en publicaciones.

Las muestras reales siguen en N=1, por lo que no se publican percentiles. El estado FREE y billing deshabilitado es externo a la aplicación. Se mantiene `AGENT_ALLOW_PAID_FALLBACK=false`, no se habilitan `service_tier=flex`, `performance` o `auto`, y no se amplía el router a Cerebras.

La telemetry existente identifica provider, model, event y usage por etapa. Una fase posterior puede agregar solo full paths completos, con las seis etapas explícitamente atribuidas a Groq y usage conocido, y derivar median/p75/p90 cuando la muestra sea suficiente. No se inventa un mínimo estadístico en esta fase.

## Gates y cierre

| Gate | Estado |
| --- | --- |
| `technicalAllStagesValidated` | `true` |
| `semanticQualityGateValidated` | `false` |
| `capacityArchitectureProviderScoped` | `true` |
| `groqCapacityPolicyDefined` | `true` |
| `groqPacingPolicyDefined` | `true` |
| `capacityProductionReady` | `false` |
| `schedulerThroughputReady` | `false` |
| `productionRoutingEnabled` | `false` |

La capacidad productiva sigue sin aprobar por la única muestra N=1, falta de readiness del scheduler, gate de calidad semántica pendiente y gate de calidad Cloudflare pendiente. No hubo llamadas Groq, Cloudflare o Cerebras. El siguiente paso es **10G.7b — Minimal Real Cloudflare Quality Benchmark**; esta fase se detiene aquí y no lo inicia.
