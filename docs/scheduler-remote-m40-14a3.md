# Fase 14A.3 — validación remota de M40

## Resultado

M40 se aplicó una sola vez al proyecto Supabase canónico en la ejecución previa registrada. En este cierre se confirmó su presencia mediante historial remoto de solo lectura, se revalidaron objetos/ACL y se ejecutó una vez el fixture rollback-safe. No se volvió a aplicar M40. No se ejecutó el scheduler ni el pipeline; no se reanudaron intentos, no se crearon reviews y no hubo llamadas a proveedores.

**14A.3 M40: PASS.** **READY FOR 14B GITHUB SCHEDULER QA: YES.** La auditoría de producción exitosa posterior a la reparación de dependencias quedó en 0 Critical / 0 High; el árbol completo conserva un High de `brace-expansion` solo en herramientas de desarrollo, ausente de `npm audit --omit=dev`. La prueba remota real de dos sesiones sigue `PARTIAL` y no se presenta como PASS; la evidencia transaccional de exclusión, idempotencia y rollback satisface los gates de esta fase.

Coste: **€0**. No se activó GitHub Actions, Netlify ni infraestructura de scheduler.

## TARGET GUARD

Se cargó `.env.local` con el mecanismo Node habitual y se usó `SUPABASE_DIRECT_DB_URL` únicamente a través de `scripts/supabase-direct-migration-command.mjs`, que pasa `--db-url` explícito al CLI local. La referencia derivada del usuario de conexión Postgres coincidió con la referencia de `NEXT_PUBLIC_SUPABASE_URL`: `skrthgpurquypgdwxast`. No se usó selección de proyecto enlazado, Management API ni login temporal. El CLI fue Supabase 2.120.0 con telemetría desactivada. Ningún valor de credencial se imprimió.

El guard local se amplió para aceptar M40 como única migración posterior a M39 y para ejecutar exclusivamente consultas M40 fijadas a archivos. Los guard tests verifican que cualquier migración posterior a M40 detiene la operación. M31–M39 y el SQL de M40 no se modificaron durante esta fase.

## PRE-APPLY BASELINE

Lecturas previas y revalidación inmediata antes de aplicar coincidieron:

- Cabeza remota: `20261021120000`; M40 ausente y sin objetos M40 parciales.
- Dry-run: únicamente `20261022120000_scheduler_safety_repair_m40.sql` pendiente.
- Intentos reales: 21; activos 0, diferidos por provider capacity 1, atascados (>1 h, excluyendo el intento diferido) 0. El intento `f794f73c-ce15-4167-beac-cb54bd6312af` seguía diferido en Editor/g0, sin final state y con retry deshabilitado.
- Intento del ciclo 2 `65a83559-8522-4162-8e04-6f8a0bde62b3`: `REVISION_REQUIRED / BLOCKED_REVISION_REQUIRED` en Critic.
- Reviews: 1 total, 0 `WAITING_FOR_HUMAN_REVIEW`.
- Artículos publicados: 3. Astra (`756b0ee0-b5e6-4153-846f-278a12c9afe3`) estaba archivado.
- Scheduler histórico: 15 filas, 0 leases activas; fingerprint agregado `ea28abab443e7dd6b88d8ef0ac1988a7`.
- Reservas de proveedor del día UTC: 0; Groq, Cloudflare Workers AI y Cerebras reportaron 0 reservas, 0 despachos y 0 reservas desconocidas mediante lecturas GET de PostgREST.

Fingerprints públicos calculados con el método histórico PostgreSQL MD5 (`md5(concat_ws(chr(31), slug, headline_es, coalesce(summary_es,''), coalesce(why_it_matters_es,''), coalesce(body_es,''), metadata::text))`, ordenados por ID):

| ID | MD5 histórico |
| --- | --- |
| `6203559f-413a-4f06-9346-1720bbeb0e7a` | `ccef966880d85663b8fd5049e9995f5f` |
| `64ac852b-2d67-4048-953c-9c9e8c5e2ef2` | `1856d71e39d3f83c44e79d4f37030c30` |
| `7415c685-04ed-4956-a77a-4bc372c9b060` | `4cf1ecf2990a5dca582c95e5733a484f` |

## MIGRATION HASH AND SAFETY REVIEW

Archivo congelado antes del push: `supabase/migrations/20261022120000_scheduler_safety_repair_m40.sql`
SHA-256: `DD5A619BB50077CD71B05077B4E8DB53D74BB5F888CD209CF662816618508B5E`

La inspección del archivo final y la unidad local confirmaron rechazo explícito de TTL NULL y de valores fuera de 60–1020 segundos; identidad UTC y trigger/invocation canónicos; owner e invocation obligatorios; incremento y comprobación del fencing token; `SECURITY DEFINER` con `search_path = pg_catalog, public`; grants de ejecución solo a `service_role`; y ausencia de DDL destructivo o reescritura histórica. La migración crea las tablas M40, inserta solo la fila singleton inicial, añade `scheduler_defer_reason` y define RPCs; no se ejecuta ningún cuerpo de RPC durante el push.

## MIGRATION APPLICATION AND HEAD

`npm.cmd run supabase:db:push` aplicó una vez el archivo M40 exacto; el CLI informó solo esa migración y terminó con exit 0. El historial remoto contiene M40 una vez y la cabeza final es `20261022120000`; no hay migración posterior. `--skip-vault` estuvo activo.

Al reanudar la fase, el historial volvió a confirmar M40 una vez y la cabeza `20261022120000`. La aplicación de esta revalidación fue **0**: no se repitió `db push`. El SHA-256 local actual coincide con el hash capturado inmediatamente antes de la aplicación anterior, y el artefacto conserva que el comando aplicó exactamente ese archivo. Las lecturas actuales volvieron a encontrar los objetos y las ocho RPC esperadas; la ACL y el fixture funcional rollback-safe pasaron.

## READ-ONLY REVALIDATION — 2026-10-26 UTC

Se verificó de nuevo la referencia del proyecto con la URL pública y la URL directa, sin imprimir ninguna credencial. El CLI remoto se ejecutó con `SUPABASE_TELEMETRY_DISABLED=1`; no hubo fallback a proyecto enlazado ni login temporal.

- Historial: M40 aparece una vez y la cabeza es `20261022120000`; no existe migración posterior local ni remota.
- Baseline remoto: 21 intentos, activos/diferidos/atascados `0/1/0`; 1 review y 0 `WAITING`; 3 artículos públicos; Astra archivado; 15 scheduler runs históricos y 0 leases activas.
- El intento diferido `f794f73c-ce15-4167-beac-cb54bd6312af` sigue en Editor/g0. El intento de ciclo 2 `65a83559-8522-4162-8e04-6f8a0bde62b3` sigue `REVISION_REQUIRED / BLOCKED_REVISION_REQUIRED`.
- Los tres fingerprints públicos coinciden con los del baseline de aplicación: `ccef966880d85663b8fd5049e9995f5f`, `1856d71e39d3f83c44e79d4f37030c30` y `4cf1ecf2990a5dca582c95e5733a484f`.
- M40 post-apply: singleton lease idle, 0 lease activas, 0 expiry NULL, 0 invocaciones y 0 fechas sintéticas residuales.
- ACL actual: las ocho funciones existen; todas son `SECURITY DEFINER`, con `search_path = pg_catalog, public`, ejecución habilitada solo para `service_role`; `anon`, `authenticated` y `PUBLIC` denegados. RLS está activo y los roles de navegador y `service_role` no tienen privilegios directos sobre las tablas M40.
- Se repitió una vez `m40-fixture`: `M40_FIXTURE_ROLLBACK_CONFIRMED`. La lectura posterior volvió a mostrar singleton idle e invocaciones `0`.
- La lectura de contabilidad PostgREST del 2026-10-26 usó 3 GET HTTP 200: Groq, Cloudflare Workers AI y Cerebras reportaron reservas, despachos, uso desconocido y neuronas en `0`. `remoteWrites=0`, `providerCalls=0`.

## REMOTE OBJECTS AND ACL

Existen `public.supervised_scheduler_lease`, `public.supervised_scheduler_invocations`, la columna `pipeline_event_attempts.scheduler_defer_reason` y las ocho RPC M40:

- `claim_supervised_scheduler_invocation_m40`
- `heartbeat_supervised_scheduler_lease_m40`
- `finish_supervised_scheduler_invocation_m40`
- `list_open_supervised_scheduler_attempts_m40`
- `defer_pipeline_event_attempt_scheduler_capacity_m40`
- `defer_pipeline_event_attempt_worker_budget_m40`
- `claim_pipeline_event_attempt_scheduler_resume_m40`
- `release_pipeline_event_attempt_scheduler_resume_m40`

RLS está habilitado en las tablas M40. `anon`, `authenticated` y `service_role` no tienen privilegios directos de tabla. En las ocho RPC: `service_role` puede ejecutar; `anon`, `authenticated` y `PUBLIC` no; todas son `SECURITY DEFINER` y tienen el search path esperado.

## ROLLBACK-SAFE REMOTE FIXTURE

El fixture es una sola sentencia `DO`. Usa fechas sintéticas `2099-12-30`, `2099-12-31` y `2100-01-01` con las identidades canónicas que exige la RPC. Al alcanzar todas las aserciones emite `M40_FIXTURE_FORCE_ROLLBACK`; el error revierte la sentencia completa. El fixture se ejecutó dos veces y ambas terminaron con el marcador esperado. No se insertaron filas persistentes ni se tocó un trigger real.

- **NULL TTL:** claim rechazado con SQLSTATE `22023`; heartbeat devolvió false. La lease permaneció igual.
- **Límites TTL:** claim 59 rechazado, 60 aceptado, 1020 aceptado y 1021 rechazado.
- **Ownership:** owner A reclamó la lease. Owner B antes de la expiración obtuvo `ALREADY_RUNNING`; tras la expiración recuperó válidamente la lease.
- **Heartbeat:** el heartbeat válido del owner pasó; TTL NULL, propietario incorrecto, fencing obsoleto y owner anterior fueron rechazados sin mutar la lease actual.
- **Recovery/fencing:** la invocación A se finalizó `STOPPED / STALE_LEASE_RECOVERED`; B adquirió el fencing token siguiente. Heartbeat y finalización de A con fence obsoleto fueron rechazados, preservando a B.
- **UTC diario/idempotencia:** la primera claim sintética pasó; la entrega repetida devolvió `DAILY_TRIGGER_ALREADY_CLAIMED`; una identidad de segunda invocación no canónica fue rechazada. No se creó una segunda fila para el día.
- **Limpieza:** residual de invocaciones = 0; singleton global idle, fencing 0, lease activa 0, lease activa con expiry NULL = 0.

### Concurrencia remota

`CONCURRENCY_REMOTE_TEST: PARTIAL`. El CLI directo disponible no ofrece dos sesiones coordinadas dentro de una única transacción que permita verificar una carrera real y, a la vez, garantizar rollback atómico de ambos contendientes. La evidencia remota más fuerte fue el interleaving de propietario activo/expirado y el rechazo de duplicados; el código usa `SELECT ... FOR UPDATE` sobre la fila global antes de comprobar la invocación diaria. No se afirma un test de carrera concurrente PASS.

## HISTORICAL INTEGRITY AFTER M40

La lectura posterior confirmó, sin cambios:

- El intento diferido sigue en Editor/g0; el intento del ciclo 2 sigue terminal en Critic.
- Los 21 intentos reales, los contadores activo/diferido/atascado `0/1/0`, reviews `1/0 WAITING`, 3 artículos y los tres MD5 coinciden con el baseline.
- Astra permanece archivado.
- `scheduler_runs` permanece en 15 filas con 0 leases activas y el mismo fingerprint agregado.
- El uso y reservas desconocidas de Groq, Cloudflare Workers AI y Cerebras del día UTC siguen en cero.
- M40 tiene 0 invocaciones persistentes tras rollback.

Actividad de esta fase: ejecuciones del scheduler 0, kickoff 0, consumo de trigger real 0, reanudaciones del pipeline 0, intentos nuevos 0, reviews creadas 0, publicaciones 0 y llamadas a proveedores 0. GitHub Actions y cualquier horario permanecen inactivos.

## LOCAL REGRESSIONS

Pasaron 30/30 regresiones offline de M40 TTL, scheduler 14A/host/unit/wiring/execution, resume-first, M33/M35 capacity, reservas y contabilidad/políticas de proveedor, ejecución/finalización supervisada, y gates de human review M31/M32/M34/M39. Tres primeras ejecuciones fallaron por `EPERM` al renombrar fixtures bajo el `%TEMP%` aislado; se repitieron con `TEMP`/`TMP` dirigidos al directorio aislado escribible de Codex y pasaron. No se cambió código por esos errores de filesystem.

- `npm.cmd run lint`: PASS
- `npx.cmd tsc --noEmit`: PASS
- `git diff --check`: PASS (Git mostró solo avisos preexistentes LF→CRLF)
- `npm ci` en copia aislada: PASS; npm avisó de un fallo EPERM de limpieza que no impidió instalar ni construir.
- `npm.cmd run build` en copia aislada con `CIRCLE_NODE_TOTAL=2`: PASS; webpack, TypeScript y 19/19 páginas estáticas pasaron. `/contacto` se generó como ruta estática.
- Secret audit: PASS, 1.154 archivos revisados, 0 archivos con hallazgos, `.env.local` ignorado.

La primera ejecución del build aislado no fue válida porque el sandbox no resolvió Google Fonts y la copia omitió `lib/supabase`; se corrigió la copia, se permitió el acceso de red de fuentes y el build completo posterior pasó.

## READINESS / BLOCKER

La auditoría refrescada de `npm audit --omit=dev` informa 0 findings de producción. El árbol completo conserva un High de `brace-expansion` solo en herramientas de desarrollo, ausente de la auditoría de producción.

No queda blocker Critical/High en la ruta de producción que impida QA supervisada del scheduler. La limitación `CONCURRENCY_REMOTE_TEST: PARTIAL` se conserva explícitamente y no se declara PASS; no bloquea el readiness contractual de esta fase. **READY FOR 14B GITHUB SCHEDULER QA = YES.** Siguiente: **14B_GITHUB_SCHEDULER_QA**. No activar GitHub Cron ni ejecutar scheduler.
