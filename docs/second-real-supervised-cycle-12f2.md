# 12F.2 — Second real supervised cycle

**Resultado: STOPPED_CAPACITY. 12F.2 READY = NO.** La ejecución procesó un candidato, hizo tres requests Groq asentadas y el admission detuvo Classifier antes de enviar su request porque habría requerido esperar por TPM. No se ejecutó otro candidato ni se llamó a Publisher. No se creó review; no se inicia 12F.3.

## BASELINE

Captura UTC: 2026-10-07. El árbol ya tenía cambios de fases anteriores: `git status --short` mostró archivos modificados y artefactos sin seguimiento; `git diff --stat` reportó 55 archivos rastreados, 1.556 inserciones y 173 eliminaciones. No se hizo commit. Antes y después de la ejecución no se aplicó ninguna migración.

Configuración efectiva del runner: modo `supervised`, máximo 1 candidato en esta corrida, 3 candidatos/día, 2 publicaciones/día, concurrencia Groq 1, reintentos 0 en las seis etapas, fallback de pago desactivado, remediación factual automática desactivada, `publish=false`. El runner manual no activa una tarea recurrente. Proveedor y accounting: Groq.

Estado privado previo: 0 intentos/candidatos admitidos hoy, 0 reviews esperando, 0 publicaciones hoy, 0 intentos activos o atascados, 0 leases activos, Astra archivada y 0 reservas/despachos de proveedor hoy.

## PUBLIC HASH BASELINE

Se recalculó el método histórico PostgreSQL MD5 con `concat_ws(chr(31), slug, headline_es, coalesce(summary_es,''), coalesce(why_it_matters_es,''), coalesce(body_es,''), metadata::text)`, filas ordenadas por `a.id`.

| Artículo | MD5 antes | MD5 después |
| --- | --- | --- |
| `6203559f-413a-4f06-9346-1720bbeb0e7a` | `ccef966880d85663b8fd5049e9995f5f` | `ccef966880d85663b8fd5049e9995f5f` |
| `7415c685-04ed-4956-a77a-4bc372c9b060` | `4cf1ecf2990a5dca582c95e5733a484f` | `4cf1ecf2990a5dca582c95e5733a484f` |

Conteo público: 2 antes y después. La lectura anónima posterior vio los mismos dos artículos. Astra siguió archivada y no fue visible anónimamente.

## PROVIDER BASELINE

La lectura del ledger canónico antes de la corrida encontró 0 requests reservadas/despachadas, 0 tokens, uso conocido, 0 reservas estimadas sin liquidar y 0 requests de uso desconocido. No había bloqueo de rate limit. Límites efectivos: requests 1.000 hard / 850 soft; tokens diarios 200.000 hard / 170.000 soft; RPM 30 y TPM 8.000. El admission tenía 849 requests disponibles y requería 6 para el recorrido completo. La admisión de cada etapa siguió usando el mecanismo existente; no se reservaron seis requests por adelantado.

## DISCOVERY

Se ejecutó Discovery normal con datos externos tratados como no confiables: encontró 62 candidatos. Extraction obtuvo 3 items y Clustering formó 3 eventos; el orden determinista normal eligió un único evento elegible para el límite de esta corrida. No hubo elección manual ni reemplazo después del fallo. Se intentó un solo evento.

## QUALITY GATE

El gate genérico de 12F.1b dio `ELIGIBLE`: cuerpo presente, extracción `full`, 3.417 caracteres, 492 palabras, 78 párrafos, 18 párrafos con prosa, 125 frases, 19 frases sustantivas, 10 frases sustantivas relacionadas y cobertura de términos del título 0,7. No se utilizó una regla por hash o fuente.

## CANDIDATE

- Título: **Emotional optimization by newsroom AI needs behavioural evaluation — Nature Machine Intelligence**
- Fuente: Nature Machine Intelligence — [artículo fuente](https://www.nature.com/articles/s42256-026-01315-8)
- `sourceId`: `20282179-6fb3-4a48-b9d3-3c3a00475532`
- `sourceItemId` / external ID: `20282179-6fb3-4a48-b9d3-3c3a00475532:5f7438cb16b59f40367a00c2486df067`
- `rawItemId`: `b92847b4-22d7-4cf2-a462-1e9c3a21f98d`
- `eventKey`: `event-b528bc50495484add3d2544579f47846`
- `eventId`: ninguno; el evento solo existió en memoria, no se materializó en `events`.

## LINEAGE

La fila raw_item enlaza el candidato con el `sourceId`, URL canónica y calidad de extracción `full`. El attempt claim ocurrió antes del primer dispatch. El estado previo no tenía un attempt para este `eventKey`; la corrida creó el intento n.º 1. No hubo intento duplicado.

## ATTEMPT

- `attemptId`: `3ebda423-2aa6-4f3a-b119-53982fbf58d9`; número 1.
- Una sola fila de intento para este evento en esta corrida; no se reintentó.
- Estado remoto final: `TECHNICAL_FAILURE`, `stop_stage=classifier`, `stop_reason=PROVIDER_CAPACITY_EXHAUSTED`, retry class `TECHNICAL_FAILURE`, `counts_toward_retry_limit=true`.
- El siguiente intento no es elegible antes de `2026-10-08T00:00:00Z`. No se intentó.

La clasificación operativa de esta ejecución es `STOPPED_CAPACITY`, porque el mensaje concreto fue “Groq TPM pacing requires waiting; refusing supervised stage dispatch” y `providerRequestDispatched=false`. La fila existente quedó intacta.

## VERIFIER

**PASS**, un request Groq, sin reintentos. Resultado `confirmed`, una fact verificada. Uso asentado: 2.285 tokens de entrada + 301 de salida = 2.586. Checkpoint escrito y validado.

## TRANSLATOR

**PASS**, un request Groq, sin reintentos. Un hecho traducido. Uso asentado: 1.070 de entrada + 155 de salida = 1.225. Checkpoint escrito y validado.

## EDITOR

**PASS**, un request Groq, sin reintentos. Uso asentado: 1.103 de entrada + 473 de salida = 1.576. Checkpoint escrito y validado. No se obtuvo un paquete Critic/review para aprobación humana.

## CLASSIFIER

**STOPPED BEFORE DISPATCH.** Falló el admission local de TPM porque se requería esperar. 0 requests y 0 tokens de Classifier; no hubo HTTP 429 ni espera. No se repitió.

## RANKER

**NOT RUN**; Classifier no terminó.

## CRITIC

**NOT RUN**; no hubo decisión Critic.

## REVIEW TRANSITION

No se alcanzó `WAITING_FOR_HUMAN_REVIEW`. Review ID, paquete y manifest hash: ninguno. El conteo remoto de reviews sigue en 0; no hubo decisión humana.

## OPERATOR STATUS

**PASS**. Tras la corrida: 1 candidato y 1 intento hoy, 0 reviews esperando, 0 publicaciones, 0 trabajo activo/atascado, 3 requests Groq, 5.387 tokens liquidados y 0 requests de uso desconocido.

## OPERATOR LIST

**PASS**. Lista vacía; no se creó una review.

## OPERATOR INSPECT

**NOT RUN**: no existe review ID ni paquete que inspeccionar.

## PUBLIC CONTRACT

Conteo público antes/después: 2/2. Lectura anónima: visibles los dos artículos anteriores; Astra y el candidato nuevo no visibles. Writes de artículos: 0. Publisher calls: 0. Reviews: 0.

## PUBLIC HASH POSTCHECK

Los dos MD5 comparables son idénticos al baseline de esta fase y al baseline histórico. **UNCHANGED**.

## ACCOUNTING

| Etapa | Requests | Entrada | Salida | Total | Resultado |
| --- | ---: | ---: | ---: | ---: | --- |
| Verifier | 1 | 2.285 | 301 | 2.586 | Asentado |
| Translator | 1 | 1.070 | 155 | 1.225 | Asentado |
| Editor | 1 | 1.103 | 473 | 1.576 | Asentado |
| Classifier | 0 | 0 | 0 | 0 | Admission detenido antes de dispatch |
| Ranker | 0 | 0 | 0 | 0 | No ejecutado |
| Critic | 0 | 0 | 0 | 0 | No ejecutado |

Total Groq: **3 requests / 5.387 tokens**; las tres reservas se liquidaron. Reintentos 0; fallback 0; Cloudflare 0; Cerebras 0; inference ajena a Groq 0; 429: 0; unknown dispatched reservations: 0. El delta de provider accounting de esta corrida es 3 requests / 5.387 tokens.

## FINAL STATE

La clasificación primaria es **STOPPED_CAPACITY**. El pipeline devolvió `SUCCESS_WITH_FAILURES`, un evento fallido, 3 requests y 0 reviews esperando. El runner marcó el registro del scheduler como `succeeded/allowed`, aunque el intento quedó `TECHNICAL_FAILURE` por agotamiento de capacity. Esa discrepancia entre resultado del pipeline, registro del intento y scheduler queda documentada y no se corrigió después de la ejecución.

No se procesó un candidato segundo, no hubo aprobación automática, HOLD, REJECT ni publicación. Scheduler recurrente no se activó; no se aplicó migration 32 ni otra migración en esta fase. Después de detener proveedores pasaron las 67 suites offline, migrations fixtures 29/30/31, lint, TypeScript, build y `git diff --check`.

**12F.2 READY = NO**: no se alcanzó el objetivo `WAITING_FOR_HUMAN_REVIEW`, y el estado guardado del intento/scheduler refleja la discrepancia descrita.

## HUMAN DECISION REQUIRED

Ninguna acción humana está pendiente porque no se creó review. No se toma ninguna decisión editorial en esta fase. 12F.3 no se inició; detenerse aquí.
