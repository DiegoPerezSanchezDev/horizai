# 12F.3 — Third real supervised cycle

**Resultado: `TECHNICAL_FAILURE`; 12F.3 READY = NO.** Se ejecutó exactamente una vez el comando supervisado canónico y se detuvo en Editor. No se reintentó, no se seleccionó otro candidato y no se tomó ninguna acción humana.

## Baseline previo

La auditoría local de secretos pasó: 672 archivos revisados, cero hallazgos, y `.env.local` está ignorado por Git. No había un runner supervisado, scheduler ni pipeline de este repositorio activo antes del ciclo.

La lectura privada previa, realizada por el camino normal de la aplicación/PostgREST, confirmó 2 artículos públicos, Astra archivada, 10 intentos reales, 0 intentos activos/diferidos/atascados, 0 reviews y 0 reservas/despachos/tokens diarios de proveedores. Los hashes públicos fueron:

| Artículo | ID | Fingerprint `publicArticleFingerprintV1` |
| --- | --- | --- |
| 1 | `6203559f-413a-4f06-9346-1720bbeb0e7a` | `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64` |
| 2 | `7415c685-04ed-4956-a77a-4bc372c9b060` | `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b` |

## Candidato y ejecución

- Selección: normal del pipeline supervisado; no hubo elección manual ni reemplazo.
- Candidato: **We’re still figuring out the side effects of GLP-1 weight-loss drugs**.
- Fuente: MIT Technology Review.
- `sourceId`: `e3a5ef5a-c4d8-42bf-bc3c-08284952d3e4`.
- `sourceItemId`: `e3a5ef5a-c4d8-42bf-bc3c-08284952d3e4:3a37b5ad182749ab7c965409df42486c`.
- `eventKey`: `event-0c4ed88cddcd4f96c3d6f2983ced7de7`; no se materializó una fila `events`, por lo que `eventId` no existe.
- `attemptId`: `dfada4fd-d9c6-4aa8-bfef-6d9447267e06`, intento normal n.º 1.
- `pipelineRunId`: `3aa65ec9-448f-42ea-b53c-39bc24c70fb8`.
- Gate genérico de evidencia: `ELIGIBLE`.
- Comando ejecutado una sola vez: `npm.cmd run pipeline:supervised:run -- --execute-supervised`.
- Salida: código 1; el runner no produjo su JSON de resumen. No se repitió el comando.

## Etapas y accounting

| Etapa | Resultado | Despachos Groq | Entrada | Salida | Total |
| --- | --- | ---: | ---: | ---: | ---: |
| Verifier | PASS; HTTP 200; checkpoint validado | 1 | 2.041 | 1.169 | 3.210 |
| Translator | PASS; HTTP 200; checkpoint validado | 1 | 1.622 | 946 | 2.568 |
| Editor | `RUNTIME_ERROR` antes del despacho; sin checkpoint validado | 0 | 0 | 0 | 0 |
| Classifier | No ejecutado | 0 | 0 | 0 | 0 |
| Ranker | No ejecutado | 0 | 0 | 0 | 0 |
| Critic | No ejecutado | 0 | 0 | 0 | 0 |

Groq usó `openai/gpt-oss-20b`: **2 requests, 3.663 tokens de entrada, 2.115 de salida, 5.778 en total**. Ambas reservas se liquidaron. Reintentos: 0. Fallback: 0. Cloudflare: 0. Cerebras: 0. Reservas despachadas con uso desconocido: 0. El fallo ocurrió en Editor antes del despacho y no fue un bloqueo de capacidad. El detalle interno de bajo nivel de `RUNTIME_ERROR` no fue emitido por el telemetry seguro disponible.

## Checkpoints y estado remoto

Los checkpoints durables de Verifier y Translator existen y validan. No existe checkpoint de Editor porque no se obtuvo una salida validada. El intento no se reanudó.

El ciclo se clasifica como `TECHNICAL_FAILURE`; sin embargo, la fila remota del intento quedó **incompleta/activa** (`completed_at`, `final_state`, `stop_stage` y `stop_reason` nulos). No se finalizó ni reparó manualmente. El run manual del scheduler falló, liberó el lease y no activó ningún scheduler recurrente.

No se llegó a Critic ni a `WAITING_FOR_HUMAN_REVIEW`. La lectura RPC de operator `status` y `list` pasó y mostró 0 reviews y 0 en espera. `inspect` no se ejecutó: no hay review ID. Correct lineage: no aplicable. No hubo acción humana.

Publisher calls: 0. `publish-approved`: no ejecutado. Publicaciones creadas: 0.

## Baseline posterior

- Artículos públicos: 2; IDs y fingerprints idénticos al baseline previo.
- Astra: sigue archivada.
- Intentos reales: 11; activos: 1; diferidos: 0; atascados: 0. El nuevo intento es el intento incompleto descrito arriba.
- Reviews: 0; esperando: 0.
- Delta de accounting de la corrida: Groq 2 requests / 5.778 tokens; Cloudflare 0; Cerebras 0; uso desconocido 0.
- Mutaciones de artículos/publicación: 0; llamadas Publisher: 0.

## Regresión local posterior

- Suites offline: 67/67 PASS.
- Fixtures de migrations 29, 30, 31 y 32: PASS.
- `npm.cmd run lint`: PASS.
- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run build`: PASS.
- `git diff --check`: PASS; Git informó únicamente avisos de conversión LF/CRLF en archivos que ya estaban modificados.

No se modificó código runtime ni migrations durante 12F.3. Se crearon solamente este informe y `artifacts/supervised-cycle-12f3.json`.

## Cierre

**12F.3 READY = NO — `TECHNICAL_FAILURE`.** No se alcanzó Critic PASS ni se creó review. El intento persistido permanece activo e incompleto; debe conservarse para una decisión posterior. Esta fase se detiene aquí: sin reintento, sin Publisher, sin decisión humana y sin publicación.
