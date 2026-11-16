# 12C.2B.2g.2 — intento final de resume y Critic

**Decisión final: `STOPPED_ACCOUNTING`.** Se hizo una única sonda Groq. La respuesta fue válida y su capacidad se clasificó `IMMEDIATE`, pero el runner bloqueó antes del resume por una comparación incorrecta del ledger diario. Al diagnosticarlo, el `Date` de la respuesta ya tenía 11,75 minutos; la fase no permite otra sonda. No se invocó la RPC de resume.

Se conservaron los artefactos anteriores. No se creó la migración 31. El único uso remoto de esta fase fue la sonda y su reserva, marca de dispatch, conciliación de tokens y telemetría canónica.

## PRE-PROBE STATE

- Migraciones remotas 27, 28, 29 y 30 aplicadas; 30 es la última. La 31 está ausente.
- Artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3`, estado `archived`; no aparece en el contrato público. Recuento público: 2.
- Intento `a82482be-58d8-4fc6-ac16-946d0906257b`, `FACTUAL_REMEDIATION`, intento piloto 5/5. Hay dos intentos y ninguno posterior.
- Una autorización existente (`f140d01b-b7f1-4f05-b8f7-9ad0081e7105`), estado `STOPPED`, sin generación ni ejecución de resume y sin historial de resume. No se creó otra autorización.
- Se preservaron `cost_guard_violation` y `CONTINUATION_RUNNER_ABORTED`.
- No había reserva, dispatch ni checkpoint Critic.
- `git status`, `git diff --stat` y `git diff --check` se revisaron antes del probe. No se hizo commit.

## GUARD VECTOR MAPPING

Lectura PostgreSQL de una sola sentencia: `2026-10-04 20:34:13.784327+00`. El vector es `true / true / false / 1 / true`; la rama completa pasa y `guard_rejects=false`.

| Predicado | Observado | Esperado | Pasa | Valores subyacentes relevantes |
|---|---:|---:|---:|---|
| `event_ok` | `true` | `true` | Sí | ID `5138e509-f4c3-4020-9d13-6a6efac99a39`, clave `event-30f226d1b8ba5c9eb8af2b65c46db512`, `active`, `approved` |
| `article_archived_ok` | `true` | `true` | Sí | Artículo esperado, evento esperado, slug esperado y `publication_status=archived` |
| `incident_public` | `false` | `false` | Sí | `incident_public_count=0`; total público 2. Es un `EXISTS` positivo dentro de la expresión OR de rechazo; debe ser falso para el incidente archivado. |
| `event_source_count` | `1` | `1` | Sí | Una fila `event_sources` para el evento; la regla exige cardinalidad exacta 1. |
| `source_raw_lineage_match` | `true` | `true` | Sí | Raw item `d3834944-72f6-4f59-9aca-3f66ae92dc33`, source `e8dd0363-f51e-4381-9fb2-c02ee81f4d41`, `TechCrunch AI`, hash esperado, longitud 1756, contenido no nulo, extracción `full` y estado `extracted`. |

El valor `false` es la visibilidad pública del incidente y es el resultado requerido. No representa una condición positiva obligatoria que haya fallado.

## LINEAGE PREFLIGHT

El preflight reforzado terminó `PASS`: evento y artículo correctos, relación `event_sources` única, raw/source/hash/longitud/estados correctos, autorización e intento correctos, manifest estricto y semánticamente igual, cinco checkpoints reutilizables, checkpoint Critic ausente, y ninguna reserva o dispatch Critic. La relectura SQL posterior a la sonda volvió a dar el mismo vector; el artículo continuó archivado y el recuento público siguió en 2.

La diferencia falsa→verdadera histórica de la fase anterior sigue sin explicación. Esta ejecución no encontró un defecto en la RPC de migración 30; no se hizo bypass ni se relajó el guard.

## CRITIC V4

La solicitud exacta se reconstruyó offline desde Verifier, Translator, Editor, Classifier y Ranker. Manifest: cinco checkpoints, igualdad semántica y hash canónico iguales (`0c3a6f8dab750a345f38e0efbd8481557a1fbfd49a43b2a13879b1ee43e555a6`).

- Entrada estimada: 5197 tokens.
- Reserva de salida: 1200 tokens.
- Total planificado: 6397 tokens.
- TPM duro: 8000; margen de seguridad: 128; margen ajustado: 1475.
- Atribución, incertidumbre, guard de detalle no soportado, identidad/cobertura de evidencia, geografía y prechecks: `PASS`.
- La cobertura incluyó TechCrunch, atribución al Wall Street Journal, estado de fuente única e incertidumbre, envelope factual, borrador del Editor, comparación de detalles y geografía.

No se llamó a Critic.

## TPM PROBE

Se despachó exactamente una inferencia `POST /openai/v1/chat/completions` con `openai/gpt-oss-20b`, prompt mínimo `Reply x.`, `max_completion_tokens=1`, sin herramientas ni contenido del artículo.

- HTTP 200; modelo devuelto exacto.
- `Date: Sun, 04 Oct 2026 20:22:29 GMT`; fresco al recibir la respuesta.
- Uso conciliado: entrada 74, salida 1, total 75.
- `x-ratelimit-limit-requests=1000`; remaining `999`; reset `1m26.4s`.
- `x-ratelimit-limit-tokens=8000`; remaining `7925`; reset `562ms`.
- `retry-after`: ausente.
- Reserva canónica creada y marcada como despachada; el uso real de 75 tokens quedó asentado. Reintentos 0.

## CAPACITY

Antes de la sonda, el accounting diario UTC mostraba 1 solicitud despachada, 75 tokens, cero reservas de token desconocidas, límites duros RPD 1000 y TPD 200000, y ningún bloqueo temporal activo. El preflight validó margen diario para la sonda y Critic: 6579 tokens planificados entre ambos, dentro de la política. TPM no se dedujo de estos valores diarios.

De la respuesta de la sonda, `6397 + 128 <= 7925`; la decisión al recibirla fue **`IMMEDIATE`**. El runner falló al revalidar accounting porque exigía que el total diario posterior fuera igual a la sonda (`1` solicitud/`75` tokens). El ledger ya tenía una reserva previa: el valor correcto era comparar el delta. La consulta SQL posterior confirmó 1→2 solicitudes, 1→2 despachos y 75→150 tokens, sin uso desconocido. El accounting remoto era correcto; la aserción local produjo un falso negativo.

Se corrigió el runner para exigir `después = baseline + una sonda` y se añadió un test con el caso observado. Para cuando el defecto quedó identificado, el `Date` tenía 11,75 minutos. La capacidad TPM actual quedó `STALE / UNKNOWN`; esta fase prohíbe una segunda sonda, así que no se puede autorizar resume ahora.

## REAL RESUME RPC

Invocaciones: **0**. Resultado: `NOT_RUN`. La autorización existente sigue sin consumirse; no se creó otra autorización ni intento 6. El rechazo histórico `INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED` no se repitió en esta fase porque la RPC no se llamó.

## CRITIC

Dispatch: no. Decisión: `NOT_RUN`. Tokens de entrada/salida: no aplican. La reserva Critic sigue ausente.

## CRITIC ACCOUNTING

Guard de Publisher: **PASS en pruebas offline**. Rechaza Critic ausente o no aprobado, dispatch sin uso conciliado y reserva estimada sin liquidación canónica. Publisher requiere resultado `pass` y uso real liquidado.

La consulta posterior encontró cero runs, reservas o dispatches Critic. No hubo liquidación Critic.

## PUBLISHER

No se ejecutó. Sin readiness, resultado ni escrituras de publicación.

## FACTUAL REVIEW

No aplica: no hubo Critic ni publicación. No se modificó el contenido ni se afirmó una nueva revisión factual.

## PUBLIC STATE

El artículo continúa `archived`, no es visible y el recuento público es 2. El Publisher no se ejecutó. Las dos huellas públicas del preflight se conservaron en el artefacto; no se escribió sobre otros artículos.

## FINAL PILOT ACCOUNTING

- Antes: 26/30 llamadas piloto.
- Sonda: 1, liquidada con 75 tokens.
- Critic: 0.
- Final: 27/30; máximo autorizado habría sido 28/30.
- Ledger diario posterior: RPD 2 reservadas / 2 despachadas; TPD 150; reservas desconocidas 0.
- Cloudflare 0; Cerebras 0; reintentos 0; fallback 0.
- Writes de contenido, ciclo de vida, resume y Publisher: 0. Se registraron únicamente las escrituras canónicas de accounting de la sonda.

## FINAL REMEDIATION DECISION

`STOPPED_ACCOUNTING`. La única sonda se consumió y se asentó. Su respuesta era `IMMEDIATE`, pero el runner detuvo el flujo por un defecto en la validación del delta diario. Cuando se corrigió el defecto, los headers ya estaban obsoletos y no quedaba autorizada otra sonda. Resume, Critic y Publisher siguen sin ejecutarse; el artículo permanece archivado.

Regresiones después de toda actividad de proveedor: 57/57 suites offline, fixtures SQL 17/17, migraciones 29 y 30, lint, TypeScript, build y `git diff --check` pasaron.
