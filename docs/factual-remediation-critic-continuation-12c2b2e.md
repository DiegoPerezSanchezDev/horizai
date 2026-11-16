# 12C.2B.2e.2 — sonda TPM y continuación condicional

**Estado:** parada segura después de la sonda; la autorización única de continuación quedó consumida y cerrada como `STOPPED`.
**Resultado:** la sonda fue `IMMEDIATE`, pero el ejecutor abortó al comparar el manifiesto de checkpoints antes de reservar o despachar Critic. No se reintentó ni se creó una segunda continuación.
**Artículo:** `756b0ee0-b5e6-4153-846f-278a12c9afe3`, archivado y ausente del contrato público. El total público continúa en 2.

## INFERENCE TPM PROBE

Se envió exactamente una solicitud real a `POST https://api.groq.com/openai/v1/chat/completions` para `openai/gpt-oss-20b`, con un mensaje mínimo y `max_completion_tokens: 1`. La respuesta HTTP fue 200, el ID del modelo coincidió y la respuesta tuvo fecha fresca. No se guardó su contenido generado.

La estimación local previa fue 132 tokens de entrada + 1 de salida = 133 tokens. El uso real informado fue 74 de entrada + 1 de salida = **75 tokens**, conciliado en el ledger canónico. La sonda contó como una llamada real del piloto: **24 → 25 de 30**. No hubo reintentos.

## FRESH RATE LIMIT HEADERS

Cabeceras capturadas de esa misma respuesta:

| Cabecera | Valor |
| --- | --- |
| `Date` | `Fri, 02 Oct 2026 20:58:53 GMT` |
| `x-ratelimit-limit-requests` | `1000` |
| `x-ratelimit-remaining-requests` | `999` |
| `x-ratelimit-reset-requests` | `1m26.4s` |
| `x-ratelimit-limit-tokens` | `8000` |
| `x-ratelimit-remaining-tokens` | `7925` |
| `x-ratelimit-reset-tokens` | `562ms` |
| `retry-after` | ausente |

La respuesta fue fresca, el modelo devuelto fue exactamente `openai/gpt-oss-20b`, y las tres cabeceras TPM requeridas se pudieron analizar. El límite TPM observado fue 8.000, igual al límite configurado de HorizAI y a la referencia Free usada por esta fase.

## CAPACITY DECISION

**Decisión: `IMMEDIATE`.** El Critic V4 se estimó en 6.397 tokens. Con el margen de seguridad vigente de 128, el umbral de admisión era 6.525 tokens. La respuesta dejó 7.925 tokens disponibles, es decir, 1.400 sobre ese umbral. Por ello se inició inmediatamente la rama de continuación, sin esperar a que la observación TPM caducara.

## CONTINUATION

La revalidación previa pasó: migraciones 27, 28 y 29 aplicadas; migración 30 o posterior ausente; el artículo seguía archivado; el evento conservaba dos filas de intento; el intento factual seguía en 5/5 con `TECHNICAL_FAILURE`; los cinco checkpoints upstream y sus hashes seguían válidos; no había ejecución Critic V4 ni checkpoint Critic.

Tras `IMMEDIATE`, se envió una sola autorización para el mismo intento `a82482be-58d8-4fc6-ac16-946d0906257b`, usando el manifiesto humano existente. La base registró el run de continuación `f140d01b-b7f1-4f05-b8f7-9ad0081e7105`. El ejecutor terminó con `FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_MANIFEST_CHANGED` y la continuación quedó `STOPPED` con `CONTINUATION_RUNNER_ABORTED` y `providerRequestsUsed: 0`.

La evidencia apunta a una comparación sensible al orden de claves: el manifiesto lógico persistido en PostgreSQL JSONB conserva los mismos hashes, pero JSONB devuelve las claves en un orden distinto al objeto JavaScript local y el guard las compara mediante `JSON.stringify`. El rechazo ocurrió antes de crear una ejecución de agente o reservar la solicitud de Critic. El intento histórico `TECHNICAL_FAILURE` permanece auditable, el número de intento piloto sigue en 5/5 y no existe intento 6.

La fase permite una sola continuación. Al haberse autorizado y cerrado, no se volvió a autorizar ni a reanudar; queda bloqueado cualquier segundo intento de continuación dentro de esta fase.

## CRITIC

**No despachado.** No existe ejecución Critic V4 para este run, no se creó una reserva de Critic y no hubo llamada de proveedor, uso de tokens ni decisión. Reintentos: 0. Fallback: 0. El checkpoint Critic continúa ausente.

## PUBLISHER

**No ejecutado.** Sin un resultado `pass` nuevo de Critic, no se invocó Publisher. El artículo objetivo sigue archivado; no aparece en el contrato público; el total público sigue en 2.

## FINAL PILOT ACCOUNTING

| Medida | Resultado |
| --- | ---: |
| Llamadas piloto antes de esta fase | 24 / 30 |
| Sonda de inferencia | 1 llamada, 75 tokens reales |
| Critic | 0 llamadas |
| Llamadas piloto finales | 25 / 30 |
| Intentos piloto | 5 / 5 |
| Intento 6 | No creado |
| Ledger Groq UTC del día | 6 solicitudes, 7.441 tokens, 0 reservas despachadas desconocidas |
| Cloudflare / Cerebras | 0 / 0 |
| Reintentos / fallback | 0 / 0 |
| Publisher / artículos públicos | no ejecutado / 2 |

## REGRESSION CHECKS

Después de terminar toda actividad de proveedor pasaron 55 suites unitarias offline, `agents:contracts:test` y la prueba offline de migración 29: **57 suites, 0 fallos**. También pasaron `npm run lint`, `npx tsc --noEmit`, `npm run build` y `git diff --check`. Las pruebas no generaron llamadas de proveedor.

## FINAL STATUS

`12C.2B.2e.2 READY: NO`.

**Motivo de parada:** la sonda y la capacidad TPM pasaron, pero la única continuación fue autorizada y terminó `STOPPED` por el guard de manifiesto antes de reservar o despachar Critic. No se hizo un segundo intento. El artículo permanece archivado y no publicado.
