# 12F.4E — diagnóstico de extracción con cero items

> **Corrección posterior (12F.4E.1):** la evidencia read-only permitió identificar los tres candidatos seleccionados y sus outcomes. No hubo un candidato sin `raw_items`: el conteo anterior de 44 excluyó la tercera actualización, cuyo timestamp de servidor quedó 40 ms después del `completedAt` del proceso. El cierre corregido está en [docs/extraction-observability-closure-12f4e1.md](extraction-observability-closure-12f4e1.md); la sección siguiente conserva el diagnóstico tal como se conocía en 12F.4E.

## Resultado

**READY FOR NEXT UTC RUN: NO.** La causa completa de `45 candidates → 0 ExtractedItem` no se puede reconstruir con los registros retenidos. Sí se confirmó que dos extracciones de EL PAÍS terminaron en HTTP 403 y que el runner supervisado envió como máximo tres candidatos a extracción. No hay un resultado individual persistido para reconciliar el tercer intento posible ni la diferencia entre 45 candidatos detectados y 44 filas `raw_items`.

No se repitió el runner, no se hizo fetch de artículos durante el diagnóstico, no hubo llamadas a proveedores y no se escribieron datos remotos.

## OBSERVE

- Scheduler run: `55aa2f13-77c8-458c-9170-501a6f16da4e`, trigger `supervised-candidates:2026-10-10`.
- Pipeline run: `579a63e9-62cf-4756-9ff6-fbd2683cf44b`, 2026-10-10 12:20:01.345–12:20:15.264 UTC.
- El resultado registrado fue discovery 45, extracción 0, clustering 0, intentos 0, llamadas a modelos 0.
- El pipeline pasó los candidatos descubiertos por el límite supervisado `candidates.slice(0, 3)`. El valor 45 corresponde a los registros anteriores a la deduplicación; la lista exacta posterior a deduplicación no se guardó.
- En la ventana del run se encontraron 44 filas `raw_items`: 42 `pending` con cero intentos persistidos y 2 `extraction_failed` con `processing_attempts=1`.
- Los dos errores pertenecen a EL PAÍS Tecnología, host `elpais.com`; `error_message` conserva `HTTP 403`, `error_code` conserva `blocked`.
- El selector del fetcher considera `401`, `403` y `429` como `blocked` para cualquier host. Ante HTTP no exitoso, lanza antes de ejecutar `response.text()`. Por ello Readability no se invocó y el cuerpo de respuesta no se leyó. No hay evidencia para atribuir el 403 a robots, paywall, anti-bot u otra política concreta.

## Matriz de resultados y límite 45→44

Los IDs de abajo son metadatos de `raw_items`; no se incluye cuerpo editorial.

| Resultado persistido | Cantidad | Evidencia |
| --- | ---: | --- |
| `FETCH_BLOCKED` | 2 | EL PAÍS Tecnología, `elpais.com`, HTTP 403; IDs `0b2d7f8f-0c02-49df-995b-a1d4c6215b95`, `adb57da2-068c-4ed0-b251-1d673ee51c3b`. |
| `OTHER` — sin resultado de extracción persistido | 42 | Filas que permanecieron `pending`, `processing_attempts=0`, sin `error_code`. Distribución: TechCrunch AI 9, The Verge AI 5, Ars Technica AI 1, Hugging Face Blog 1, Xataka 26. El estado no demuestra si la fila estaba fuera del límite de tres o si una extracción seleccionada no llegó a persistirse. |
| `OTHER` — candidato sin fila reconciliada | 1 | `45` discovery records frente a `44` filas. Puede corresponder a deduplicación previa, reutilización o error de persistencia; no se conservó el contador de deduplicación/persistencia ni la identidad. |
| **Total** | **45** | La aritmética reconcilia; los resultados exactos e identidades de todos los candidatos, no. |

El conjunto de 44 filas tiene esta distribución por dominio/estado: `elpais.com` 2 bloqueadas; `techcrunch.com` 9 pendientes; `www.theverge.com` 5 pendientes; `arstechnica.com` 1 pendiente; `huggingface.co` 1 pendiente; `www.xataka.com` 26 pendientes. El artifact guarda los IDs de las filas, agrupados sin títulos ni URLs completas.

Los dos registros bloqueados confirman dos resultados de extracción. El resto del estado no permite clasificar las 43 entradas restantes como `ALREADY_KNOWN`, `DEDUPED`, `FETCH_FAILED`, `EMPTY_BODY`, `PARSER_FAILED` u otra categoría. En particular, no se afirma que las dos filas 403 expliquen todo el cero.

## Hallazgo sobre EL PAÍS y extracción

El HTTP status está conservado dentro de `error_message` como `HTTP 403`; no existe un campo `status_code` en `raw_items`. La ruta genérica `fetchContent` rechaza los estados 401/403/429 antes de leer HTML. El estado permite afirmar que el servidor respondió con acceso denegado; no permite determinar por qué. No se intentó acceder de nuevo ni evitar ese control.

Los fixtures locales muestran que el extractor puede procesar un artículo HTML sustantivo, quitar navegación/footers, clasificar HTTP 403 genéricamente, devolver fallo para HTML sin contenido editorial y funcionar igual con una fuente conocida o desconocida. No prueban qué ocurrió con el tercer candidato del run remoto.

## Clasificación

- **Causa parcial confirmada:** dos de los candidatos cuyo resultado quedó guardado fueron rechazados por HTTP 403; el extractor funciona con fixtures accesibles.
- **Defecto genérico de extracción:** no probado.
- **Limitación específica de fuente:** desconocida. El comportamiento `blocked` depende solo del código HTTP y no del hostname.
- **Calidad de Discovery:** los metadatos muestran feeds heterogéneos; el conjunto exacto de 45 y la calidad editorial de las entradas no seleccionadas no se retuvieron. No hay evidencia suficiente para cuantificar candidatos irrelevantes/inaccesibles ni se añadió filtro o blacklist de fuente.
- **Agregación/observabilidad:** sí. `extractedItems=0` y `clusteredEvents=0` eran conteos coherentes, pero el resumen del run no conservaba contadores/códigos de extracción y el scheduler lo guardó como `COMPLETED` aunque no hubo item elegible.
- **Clasificación histórica:** `docs/supervised-cycle-12f4.md` llamó a la situación `TECHNICAL_FAILURE` como evaluación de diagnóstico. El estado remoto realmente guardado fue `run_status=succeeded`, `final_decision=allowed`, `scheduler_decision=COMPLETED`, `stop_reason=null`.

## Cambio local

Se hizo un cambio mínimo de observabilidad/semántica terminal, sin cambiar extracción, fetch, ranking de Discovery, límites, políticas por fuente ni persistencia de contenido:

1. El resultado del pipeline ahora lleva un resumen agregado seguro: candidatos seleccionados, items, resultados successful/blocked/failed, conteos por `error_code` y contadores de persistencia. No incluye títulos, URLs, mensajes ni cuerpos.
2. `createLoggerPipelinePersistence` guarda ese resumen en los stats del run.
3. Un run con candidatos descubiertos, cero items y cero intentos queda tipado como `NO_ELIGIBLE_EXTRACTED_ITEMS` solo cuando todos los resultados están contabilizados, no hubo errores de persistencia y los códigos son fallos de fetch/no-editoriales conocidos (`blocked`, `timeout`, `http_error`, `content_type`, `redirect_limit`, `empty_content`). Códigos desconocidos, `parse_error` o persistencia incompleta producen `TECHNICAL_FAILURE` con `EXTRACTION_OUTCOME_UNRESOLVED`.

El resumen hará visible en próximos runs si una fila no se actualizó por `persistErrors`, pero no reconstruye el dato que faltó en el run ya terminado.

## Auditoría de escrituras `raw_items`

Las 44 filas se crearon durante Discovery con metadata de candidato y `processing_status=pending`; no hay cuerpo extraído en las 42 filas pendientes. Dos resultados de extracción actualizaron sus filas a `extraction_failed`, `extraction_quality=failed`, `processing_attempts=1`, `error_code=blocked`, `error_message=HTTP 403`; los campos `raw_content`, `normalized_payload` y `extracted_at` quedaron nulos, igual que `content_hash` en el fallo (la fila pending podía tener un hash de metadata de Discovery). La transición está implementada en `rawItemInputFromExtraction`. Las inserciones repetidas se resuelven por identidad exacta source/external ID; una actualización de fallo vuelve a incrementar `processing_attempts`, así que no es idempotente en ese contador. La evidencia remota no informa si hubo una fila de Discovery reutilizada o un error de persistencia.

Escrituras remotas durante este diagnóstico: **0**. No se escribieron attempts, reviews, articles, accounting ni scheduler rows.

## Baseline privado READ ONLY

Lectura a través del cliente server-side/PostgREST existente y los dos RPC de lectura M32. Todas las solicitudes observadas fueron `GET`, `HEAD` o los RPC de status/list de human review; no se observó un request de escritura.

- Attempts reales: 11; active/deferred/stuck: 0/0/0.
- Reviews / WAITING: 0/0; listados: 0.
- Public articles: 2.
- Fingerprints: `6203559f-413a-4f06-9346-1720bbeb0e7a` → `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`; `7415c685-04ed-4956-a77a-4bc372c9b060` → `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`.
- Astra: `archived`.
- Reservas desconocidas: 0.
- Groq, Cloudflare y Cerebras el 2026-10-10: 0 reservas, 0 dispatches, 0 tokens.
- Scheduler row del run: release completado, 0 intentos y 0 requests.

## Regresiones y verificaciones

- `node --experimental-strip-types scripts/supervised-cycle-12f4-extraction-unit-test.mjs` — PASS; caso mixto de 45 candidatos, selección supervisada de tres sin reemplazo, 2 bloqueados + 1 vacío, resumen persistido, terminal tipado sin dispatch de etapas de modelo.
- `npm.cmd run extraction:unit`, `npm.cmd run discovery:unit`, `npm.cmd run agents:contracts:test` — PASS.
- Pipeline unit/semantics/boundaries/wiring, scheduler/policy/attempts, M29, M30, M31, M32, M33, capacity resume, human-review lifecycle y raw-item persistence — PASS.
- `npm.cmd run lint`, `npx.cmd tsc --noEmit`, `npm.cmd run build` — PASS.
- `git diff --check` — PASS; Git informó avisos de normalización LF/CRLF en archivos preexistentes del workspace.
- `node scripts/safe-secret-audit.mjs` — PASS; cero hallazgos, `.env.local` ignorado.

## Cierre

La regresión offline y el estado privado actual están sanos, pero **no se ha determinado el resultado de todas las extracciones ni reconciliado la identidad de la entrada 45**. No se debe repetir el runner el 2026-10-10. `readyForNextUtcRun=false` hasta obtener evidencia de extracción por candidato suficiente para explicar ese run; el cambio de outcome no se presenta como arreglo de la causa desconocida.
