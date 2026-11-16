# 12C.2B.2g — reanudación final de la remediación factual

Fecha de ejecución: 2026-10-04 (UTC). Proyecto Supabase: `skrthgpurquypgdwxast`.

## LIVE STATE

- Migraciones 27, 28, 29 y 30 aplicadas; 30 es la última. La 31 no existe.
- El artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3` sigue `archived`; su slug no aparece en el contrato público.
- Antes de la ejecución había 2 artículos públicos. Los hashes de ambos se mantuvieron idénticos después.
- El intento `a82482be-58d8-4fc6-ac16-946d0906257b` sigue siendo intento 2/2, propósito `FACTUAL_REMEDIATION`, piloto 5/5 y `TECHNICAL_FAILURE` por `cost_guard_violation`.
- La autorización existente `f140d01b-b7f1-4f05-b8f7-9ad0081e7105` continúa `STOPPED`, con una autorización, sin generación ni ejecución de reanudación consumida. Se conservaron `CONTINUATION_RUNNER_ABORTED`, la referencia y la fecha de autorización originales.
- No había reserva ni dispatch Critic V4, checkpoint Critic ni intento posterior. No se ejecutó intento 6 ni se repitió ninguna etapa anterior.

## CRITIC V4

El rebuild local usó los cinco checkpoints Verifier → Ranker y pasó el esquema estricto, igualdad semántica del manifiesto y hash canónico (`0c3a6f8dab750a345f38e0efbd8481557a1fbfd49a43b2a13879b1ee43e555a6`). Los guardas de atribución TechCrunch/WSJ, incertidumbre de fuente única, evidencia, borrador editorial y geografía pasaron sin incidencias.

Estimación: 5.197 tokens de entrada + reserva de salida de 1.200 = 6.397. El límite configurado es 8.000 TPM y el margen de seguridad es 128; el ajuste determinista dejó 1.475 tokens de margen.

## TPM PROBE

Se realizó una sola petición autenticada `POST https://api.groq.com/openai/v1/chat/completions`, con modelo `openai/gpt-oss-20b`, mensaje mínimo `Reply x.` y `max_completion_tokens: 1`. No hubo herramientas, esquema de salida, datos del artículo, reintentos ni fallback. El contenido de la respuesta no se guardó.

- HTTP: 200; modelo devuelto: `openai/gpt-oss-20b`.
- `Date`: `Sun, 04 Oct 2026 19:00:25 GMT`; respuesta fresca: sí.
- Uso: 74 entrada + 1 salida = 75 tokens; liquidación canónica confirmada.
- RPD: límite 1.000, restantes 999, reset `1m26.4s`.
- TPM: límite 8.000, restantes 7.925, reset `562ms`.
- `retry-after`: ausente.

## CAPACITY DECISION

La sonda fue compatible con el límite TPM de 8.000 y el plan de 6.397 tokens más margen de 128. La decisión fue `IMMEDIATE`; la reserva dinámica era 6.525 tokens y la capacidad diaria posterior a la sonda siguió aprobada. Se contó la petición en el presupuesto del piloto.

## EXISTING AUTHORIZATION RESUME

Inmediatamente después de `IMMEDIATE`, el proceso llamó una vez a la RPC de reanudación para reutilizar la autorización existente. Migración 30 respondió `BLOCKED: INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED`. La RPC no consumió la autorización ni persistió un `resumeExecutionId`; el estado remoto posterior siguió `STOPPED`, con generación nula e historial de reanudación vacío.

No se volvió a llamar a la RPC. Tras el rechazo, una lectura SQL de solo lectura recuperó la definición remota de la función y repitió su predicado de linaje. Una consulta compuesta inicial devolvió falso; al evaluar sus partes por separado todas dieron verdadero, y una repetición inmediata del predicado compuesto devolvió verdadero. No se pudo determinar la causa de esa discrepancia en el estado visto por la RPC. La condición se registra como no resuelta; no se infirió que fuera seguro continuar.

## AUDIT HISTORY

Se conservaron el `cost_guard_violation` del intento, el `CONTINUATION_RUNNER_ABORTED` de la continuación, la autorización previa, la identidad del run original y el incidente previo de cambio de manifiesto. La RPC bloqueada no los reemplazó. La autorización existente sigue siendo la única.

## CRITIC

No ejecutado. No se creó reserva, no hubo dispatch, no hubo checkpoint Critic y no hay tokens de Critic que liquidar. Las etapas Verifier, Translator, Editor, Classifier y Ranker no se repitieron.

## ACCOUNTING

- Piloto: 25 llamadas antes; 1 sonda; 0 llamadas Critic; total final 26/30.
- Uso de la sonda: 75 tokens. Contabilidad diaria Groq posterior: 1 solicitud, 75 tokens, 0 reservas con uso desconocido.
- HTTP 429: no. Reintentos: 0. Fallback: 0.
- Cloudflare: 0. Cerebras: 0. Otros proveedores: 0.

## PUBLISHER READINESS

Publisher no fue alcanzado porque la reanudación fue bloqueada por la guarda de base de datos. No se cambió la noticia ni se publicó nada.

## PUBLICATION

El artículo sigue archivado y no está en el contrato público. El recuento continúa en 2. Los otros artículos conservaron sus hashes: `a93934e7a1299a7d191673fa09da0063bf69d52351a05b90073e15f0dc6a4e21` y `8466781d0130bbc094e40299681ccc4f2f5dde38f116ff58ba99b744e9a8542e`.

## FACTUAL REVIEW

No se publicó una versión nueva, por lo que no se hizo una nueva matriz de soporte de afirmaciones. El conteo de afirmaciones materiales no sustentadas queda **sin evaluar**, no en cero. El artículo archivado permaneció sin cambios.

## PUBLIC CONTRACT

La ruta del artículo objetivo devolvió 404, consistente con su estado archivado y ausencia del contrato público. No se observó duplicado ni incremento del recuento.

## LOCAL PRODUCT QA

Con `npm run build` completado, `npm run start` sirvió el sitio localmente:

- `/`: 200; muestra dos enlaces de noticias públicas y el bloque del mapa global.
- `/fuentes`: 200.
- Las dos rutas de noticias ya públicas: 200; ambas incluyen “Por qué importa” y “Fuentes originales”.
- Ruta del artículo objetivo: 404.

La prueba fue HTTP local; no se hizo interacción visual en navegador ni se validaron peticiones a mosaicos externos del mapa.

## REGRESSIONS

- 59 suites offline: PASS (56 scripts `*:unit`, contratos de agentes y pruebas estáticas de migraciones 29 y 30).
- `npm run lint`: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS; Git solo mostró avisos habituales de normalización CRLF.
- El guard nuevo impide que Publisher se ejecute cuando el uso real del Critic no queda asentado. Su regresión offline confirma que un uso desconocido detiene el flujo en Critic.

## FINAL PILOT STATE

5/5 intentos; 26/30 llamadas Groq. Sin intento 6, reautorización, rerun upstream ni publicación. Las migraciones remotas siguen 27–30 aplicadas y 31 ausente.

## NEXT STEP

Fase detenida tras el rechazo de la guarda `INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED`. No reanudar esta continuación ni despachar Critic dentro de esta ejecución. La discrepancia entre el resultado de la RPC y la lectura SQL posterior requiere diagnóstico separado antes de cualquier nueva ejecución.

**12C.2B.2g READY: NO.** No se cumplieron los gates de Critic, publicación y revisión factual requeridos para `READY YES`.
