# 12F.10A — contrato de generación de defer, recuperación y observabilidad

**Resultado: READY FOR RESUME = YES.** Se corrigió el productor de snapshots, se recuperó el intento existente mediante el RPC M35 y se cerró el `agent_run` huérfano con el logger existente. No se reanudó el pipeline ni se inició una ejecución diaria nueva.

## Causa raíz y significado de `resumeGeneration`

Clasificación: `SNAPSHOT_GENERATION_CONFLATION`.

`resumeGeneration` cuenta los ciclos de defer/reanudación del mismo intento. No cuenta etapas completadas ni mutaciones de snapshot. M35 exige generación `0` en el defer inicial; tras una reclamación válida, el siguiente defer usa la generación anterior más uno. Esa regla es correcta y M35 no se modificó.

El productor anterior inicializaba `resumeGeneration` en `-1` y lo incrementaba cada vez que escribía un snapshot de capacidad. En la ejecución inicial escribió snapshots al completar Verifier, Translator y antes de Editor: los valores resultaron `0`, `1` y `2`. M35 recibió el snapshot del Editor con `2`, aunque el intento nunca se había reanudado y debía recibir `0`.

La corrección genérica calcula la generación una sola vez por ejecución en `runEventStages`, mediante `nextCapacityResumeGeneration`: primera ejecución `0`; ejecución reanudada desde generación `n`, siguiente defer `n + 1`. La misma regla se aplica a Verifier, Translator, Editor, Classifier, Ranker y Critic en los puntos arquitectónicamente permitidos. No depende de la etapa Editor.

## Contrato M35 y cambios

La fixture transaccional remota de M35 pasó: rechaza un defer inicial con generación distinta de cero, acepta `0`, y prueba reclamaciones/re-defer del mismo intento en `1`, `2` y `3`. La transacción se revierte y la consulta de residuos confirmó cero intentos y cero reservas Groq sintéticos. ACL de M35: cuatro funciones revisadas, `service_role` autorizado y actualización directa denegada.

No se requiere migración. No se modificaron M35 ni M36 y no se creó M37. La carga del snapshot persistido compara estructuras JSON canónicas antes y después de reclamar el intento, evitando reclamar una generación obsoleta. La prueba de concurrencia también confirma que una reclamación repetida no crea otro intento.

La regresión offline simula los dos ciclos en procesos Node independientes. Cada proceso arranca en Editor, no vuelve a invocar Verifier o Translator, reutiliza el intento 1 y se detiene en una capacidad pre-dispatch sintética con cero requests.

## Auditoría y reconciliación del intento real

Intento `16f922f2-0409-4c28-aadb-13fb5e489e7d`; evento `event-0d2cec33a9acdaff882291db5e686f6c`; pipeline `4453d15d-1bcd-42dc-ba55-c060e1222aab`.

La auditoría de solo lectura verificó los checkpoints exitosos de Verifier y Translator, sus hashes y esquemas, la misma identidad de evento y hechos, el linaje de fuentes completo y la identidad del intento/pipeline. No había checkpoint de Editor ni despacho de Editor; el contador de reservas de Editor y las ejecuciones de Critic eran cero. No había review.

Decisión: `RECOVER_AS_DEFERRED_PROVIDER_CAPACITY`. Se usó una vez el RPC de defer M35 existente, con snapshot reconstruido de forma determinista, generación `0`, misma identidad del intento, etapa `editor`, `retry_class=NONE` y `counts_toward_retry_limit=false`. Verifier y Translator no se repitieron, no se creó otro intento y no se llamó a proveedores. El intento quedó abierto y diferido; no se inventó salida de Editor.

El proceso local ya no estaba activo. Se cerró el registro padre `agent_runs` mediante `SupabaseAgentLogger.finishRun`, preservando sus estadísticas. Resultado: cero intentos activos, un diferido, cero atascados y ningún `agent_run` abierto. Fueron dos escrituras remotas de ciclo de vida en total: un RPC M35 y un cierre del registro padre. No hubo escrituras de artículos, reviews, accounting ni scheduler.

## Accounting y estado remoto

El baseline de proveedor antes y después es idéntico:

| Proveedor | Reservas | Despachos | Entrada | Salida | Total | Uso desconocido |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Groq | 2 | 2 | 4085 | 789 | 4874 | 0 |
| Cloudflare Workers AI | 0 | 0 | 0 | 0 | 0 | 0 |
| Cerebras | 0 | 0 | 0 | 0 | 0 | 0 |

Los dos fingerprints públicos permanecieron idénticos: artículo `6203559f-413a-4f06-9346-1720bbeb0e7a` (`73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`) y artículo `7415c685-04ed-4956-a77a-4bc372c9b060` (`728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`). Total público: 2. Astra sigue archivado. Reviews/WAITING: `0/0`. El trigger `supervised-candidates:2026-10-16` sigue consumido y no se cambió.

M32 status/list/inspect: PASS. Migration history M33/M35/M36: PASS. M36 está aplicado en `20261015120000`. La fila histórica del scheduler `4b0a02dd-e0b7-46ea-a21f-ac9fac7b7c00` conserva exactamente su hash `270104a4ff9472902e5397c49a7b792b2517efe0d8e463c2884306b8221cf171`.

## Observabilidad del scheduler

La llamada de persistencia de defer lanzaba `EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023` antes de que el pipeline devolviera el resultado agregado. La capa exterior perdió el motivo tipado y los contadores ya conocidos, y persistió `SUPERVISED_EXECUTION_FAILED` con cero intentos y cero requests. La fila histórica es inexacta (`historicalSchedulerAccurate=NO`) y se dejó sin cambios.

La ruta corregida captura el error de persistencia como fallo terminal del evento y conserva el motivo específico, attempt ID, requests y telemetría disponibles. El resumen del scheduler incluye el fallo de persistencia. Si el resultado completo no está disponible, representa contadores como `null` y marca `COUNTERS_UNKNOWN` con la lista de campos desconocidos; no los presenta como ceros conocidos. Los campos numéricos heredados siguen usando el valor requerido por el esquema, acompañado por la marca explícita de desconocimiento en el detalle del evento.

## Pruebas y readiness

Pasan la regresión 12F.10A y las suites de capacidad/resume, checkpoints durables, finalización supervised, throughput, Verifier/compaction, Editor/grounding, Critic/M34, M32, M33, M35 y M36, además de las fixtures offline de migración 29 y 30. La fixture remota M35 y su comprobación de residuos también pasan.

En el cierre local pasan `npm run lint`, `npx tsc --noEmit`, `npm run build`, `git diff --check` y `scripts/safe-secret-audit.mjs`. No se imprimen ni se incluyen secretos. No hubo llamadas de proveedor, ejecuciones reales de pipeline/scheduler, publicaciones, reviews ni cambios de trigger.

**READY FOR RESUME = YES.** El mismo intento puede reanudarse en una fase posterior desde Editor. Esta fase se detuvo antes de reanudarlo y antes de cualquier ejecución diaria nueva.
