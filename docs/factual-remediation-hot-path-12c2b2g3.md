# 12C.2B.2g.3 — hot path final detenido en preflight

**Decisión: `STOPPED_PREFLIGHT`.** No se ejecutó la sonda Groq. Las validaciones de producto, linaje, manifiesto, checkpoints, accounting diario y calidad local pasaron, pero no pude completar una lectura SQL remota fresca del estado de migraciones ni ejecutar los fixtures SQL: Supabase CLI devolvió `SQLSTATE 28P01` al autenticar su rol temporal. La fase exige confirmar esas condiciones antes de cualquier llamada al proveedor.

No se invocaron resume, Critic ni Publisher. No se creó una autorización ni un intento. La autorización existente sigue sin consumirse y el artículo continúa archivado según la última lectura remota de solo lectura.

## PREFLIGHT REMOTO

- Artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3`, slug esperado, estado `archived`; visibilidad pública del incidente `false`; recuento público `2` (lectura a las `2026-10-04T21:05:03Z`).
- Intento `a82482be-58d8-4fc6-ac16-946d0906257b`, `FACTUAL_REMEDIATION`, piloto `5/5`; no hay intento posterior.
- Autorización existente `f140d01b-b7f1-4f05-b8f7-9ad0081e7105`, única, sin consumir. Resume no consumido; reserva, dispatch y checkpoint Critic ausentes.
- Linaje artículo/evento/origen/raw y estado de archivo: `PASS`. El manifiesto pasó el esquema estricto y la comparación canónica; hashes iguales, cinco checkpoints reutilizables y checkpoint Critic ausente.
- El guard SQL evaluó dos veces en la misma instantánea y obtuvo el mismo vector: `event_ok=true`, `article_archived_ok=true`, `incident_public=false`, `event_source_count=1`, `source_raw_lineage_match=true`; `guardRejects=false`. Instantánea: `2026-10-04 21:01:24.367295+00`.
- La primera lectura de preflight vía PostgREST devolvió `PGRST303` (`JWT issued at future`); un reintento de solo lectura pasó y completó el preflight a las `21:05Z`.

### Migraciones y fixtures SQL

La consulta enlazada que debía verificar 27–30 aplicadas y 31 ausente, y la consulta de fixtures de 17 casos, terminaron antes de ejecutar SQL por fallo de autenticación del rol temporal (`SQLSTATE 28P01`). Por tanto, el estado remoto de migraciones de esta fase queda **sin verificar** y los fixtures SQL quedan **no ejecutados**. El estado registrado en g2 no sustituye la lectura fresca requerida aquí. No se aplicó ninguna migración.

## CAPACIDAD Y PLAN CRITIC V4

El ledger Groq capturado a las `2026-10-04T21:05:03Z` tenía 2 solicitudes reservadas y despachadas, 150 tokens, cero reservas despachadas de uso desconocido y ningún bloqueo temporal. Límites diarios: RPD 1000 (soft 850) y TPD 200000 (soft 170000). La admisión diaria para sonda y Critic pasó. Esto no determina el TPM actual.

El plan Critic V4 se reconstruyó desde Verifier, Translator, Editor, Classifier y Ranker: entrada estimada 5197, reserva de salida 1200, total 6397 tokens; TPM configurado 8000, margen de seguridad 128 y headroom ajustado 1475. Pasaron atribución, incertidumbre, detección de detalle no soportado, identidad/cobertura de fuentes, geografía y prechecks. La cobertura incluyó TechCrunch, atribución al Wall Street Journal cuando aplicaba, estado de confirmación independiente, envelope factual, borrador Editor, superficie de comparación de detalles y evidencia geográfica.

Los headers de TPM disponibles pertenecen a la sonda g2 y ya están obsoletos. No se trataron como capacidad actual. El estado TPM g3 es `UNKNOWN`; por el fallo previo de migración/fixtures, no se emitió una sonda nueva ni se autorizó capacidad `IMMEDIATE`.

## CALIDAD LOCAL

- Suites offline (`*:unit` y contratos): **57/57 PASS**.
- Regresiones delta: baseline `1/1/75` → `2/2/150` y baseline arbitrario `9/8/4000` → `10/9/4075`: **PASS**. Reservas desconocidas sin cambios: **PASS**.
- Pruebas unitarias de migración 29 y 30: **PASS**.
- `npm run lint`: **PASS**.
- `npx tsc --noEmit`: **PASS**.
- `npm run build`: **PASS**.
- `git diff --check`: **PASS** tras generar esta documentación y el artefacto.
- Fixtures SQL remotos: **NO EJECUTADOS**, bloqueo de autenticación `28P01` antes de ejecutar la consulta.

## ACTIVIDAD Y RESULTADO

- Llamadas Groq nuevas en g3: **0** (sonda 0, Critic 0); total piloto `27/30`.
- Resume RPC: `0`; autorización nueva: no; intento 6: no.
- Reserva/dispatch Critic: no; decisión, uso y conciliación Critic: no ejecutados.
- Publisher y revisión pública factual: no ejecutados. Revisión de claims materiales: no aplica; sin publicación.
- Cloudflare 0; Cerebras 0; reintentos 0; fallback 0.
- Escrituras remotas g3: 0. El artículo permanece archivado según la última lectura; recuento público observado: 2.

La fase g3 termina detenida antes del probe porque no se pudo demostrar el estado remoto de migraciones ni correr los fixtures SQL requeridos. No se usó la autorización existente ni se inició actividad de proveedor.
