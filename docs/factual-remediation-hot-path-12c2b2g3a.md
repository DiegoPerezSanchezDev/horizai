# 12C.2B.2g.3a — probe hecha; resume detenido por el guard live

**Decisión: `STOPPED_RESUME`. `READY: NO`.** La sonda Groq pasó el delta de accounting y la capacidad fue `IMMEDIATE`. El runner invocó una vez el RPC de resume con la autorización existente; el RPC rechazó `INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED`. Se detuvo según la regla terminal. No se llamó a Critic ni a Publisher y no se reintentó el resume.

## EVIDENCIA DE MIGRATION 30

Se usó el artefacto remoto ya validado [12C.2B.2f.1a](../artifacts/checkpoint-manifest-resume-remote-12c2b2f1a.json). Confirma migration 30 aplicada y como última versión; migration 31 ausente; compilación remota del RPC; resume sintético válido; 31 variantes inválidas rechazadas; regla de un resume; concurrencia con una admisión y un rechazo; permisos correctos y cero residuos sintéticos.

La consulta SQL temporal no se usó en g3a (`cliSqlAuthStatus=NOT_USED`) y no se repitieron fixtures sintéticos remotos. La fase g3 anterior había terminado con `28P01`; ese error de autenticación no se interpretó como reversión del esquema.

Las cuatro migraciones locales 27–30 existen. Sus marcas de tiempo son anteriores al artefacto de validación del 3 de octubre de 2026 a las 12:28:13 UTC; no hay migration 31 ni archivo de migración posterior. El hash SHA-256 del archivo local de migration 30 es `2e775eb5f1473fc472e4aff656d9297284c7577b6b0d82f686d17e8eea71f764`. La inspección del repositorio y del historial g2/g3 no encontró reemplazos posteriores del RPC ni escrituras de esquema. No se ejecutó SQL de reparación ni se aplicó una migración en g3a.

## PREFLIGHT LIVE

La lectura por runtime/PostgREST a las `2026-10-05T17:04:38Z`, repetida dentro del runner justo antes de la sonda a las `17:05:18Z`, confirmó:

- Artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3` archivado, incidente no público y recuento público 2.
- Intento `a82482be-58d8-4fc6-ac16-946d0906257b`, propósito `FACTUAL_REMEDIATION`, piloto `5/5`; no hay intento posterior.
- Autorización única `f140d01b-b7f1-4f05-b8f7-9ad0081e7105`, sin consumir; sin reserva, dispatch ni checkpoint Critic.
- Guard: `event_ok=true`, `article_archived_ok=true`, `incident_public=false`, `event_source_count=1`, `source_raw_lineage_match=true`; `PASS`.
- Manifest estricto y semántico: `PASS`; hashes canónicos iguales; cinco checkpoints reutilizables; ningún rerun.
- Critic V4: entrada estimada 5197 + reserva de salida 1200 = **6397 tokens**; límite 8000, margen 128, headroom ajustado 1475. Pasaron los guards de atribución, incertidumbre, detalle no soportado, identidad/cobertura de evidencia, geografía y schema.
- Baseline diario UTC del 5 de octubre: 0 solicitudes, 0 tokens, cero reservas desconocidas y sin bloqueo temporal. La admisión RPD/TPD para sonda y Critic pasó. El baseline TPM se tomó únicamente de la respuesta de la sonda.

## SONDA Y DECISIÓN DE CAPACIDAD

Se despachó una sola petición mínima `POST /openai/v1/chat/completions`, modelo `openai/gpt-oss-20b`, sin datos del incidente, herramientas ni schema estructurado; reintentos 0.

- HTTP 200; modelo exacto; respuesta fresca con `Date: Mon, 05 Oct 2026 17:05:19 GMT`.
- Uso asentado: 74 tokens de entrada + 1 de salida = **75 tokens**.
- Headers: TPM límite `8000`, restante `7925`, reset `562ms`; RPD límite `1000`, restante `999`; `retry-after` ausente.
- Delta canónico: baseline `0 solicitudes / 0 despachos / 0 tokens` → `1 / 1 / 75`; uso desconocido `0 → 0`: **PASS**.
- Requerimiento de decisión: `6397 + margen 128 = 6525`; capacidad `IMMEDIATE`.

## RESUME Y DETENCIÓN

El runner llamó al RPC de migration 30 **exactamente una vez**. La respuesta fue `REJECTED`: `FACTUAL_REMEDIATION_CONTINUATION_RESUME_BLOCKED:INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED`. El preflight live anterior había pasado. No se reinterpretó la discrepancia ni se hizo bypass o nueva lectura para intentar corregirla.

El readback que el runner hizo al detenerse indica que la misma autorización y el mismo intento siguen asociados, resume no consumido, sin nueva autorización ni intento 6. El artículo permanece archivado; recuento público 2. Reserva y dispatch Critic ausentes. Critic, accounting Critic y Publisher: `NOT_RUN`.

## CONTABILIDAD FINAL Y REGRESIONES

- Llamadas piloto: `27 → 28 / 30`; probe 1, Critic 0.
- Ledger Groq del día: 1 solicitud reservada y despachada, 75 tokens, reservas desconocidas 0.
- Cloudflare 0; Cerebras 0; reintentos 0; fallback 0.
- Después de terminar toda actividad de proveedor: suites offline **57/57 PASS**; pruebas estáticas de migration 29 y 30 **PASS**; lint, TypeScript, build y `git diff --check` **PASS**.
- Fixtures SQL remotos: no repetidos, de acuerdo con esta fase.

La fase queda terminalmente detenida por el rechazo del RPC. No hubo más llamadas de modelo, resume, SQL remoto ni publicación. El artefacto de detalle es [factual-remediation-hot-path-12c2b2g3a.json](../artifacts/factual-remediation-hot-path-12c2b2g3a.json).
