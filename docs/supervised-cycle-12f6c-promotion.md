# 12F.6C — Promoción del contrato Critic / human-review

## Resultado

Migration 34 se aplicó remotamente después de que el historial, el dry-run y todos los gates locales confirmaran que era la única migración pendiente. La validación remota de trigger/ACL pasó y la fixture transaccional M34 terminó correctamente con rollback. No se ejecutaron pipeline, scheduler, acciones humanas, publicación ni llamadas a proveedores.

## Execution locus

`npm.cmd run pipeline:supervised:run -- --execute-supervised` es `LOCAL_REPO_RUNTIME`. El script npm invoca Node local con `.env.local` y `scripts/supervised-pipeline-run.ts`, que importa `createProductionPipeline` del checkout actual. No delega la ejecución a Netlify ni a un runtime de aplicación desplegado.

**APPLICATION DEPLOY REQUIRED FOR 12F.7: NO.** La siguiente invocación local canónica cargará el código 12F.6B de este repositorio. No se hizo deploy.

## Revisión de M34

Archivo `supabase/migrations/20261012120000_human_review_critic_attempt_proof.sql`, versión `20261012120000`.

- Forward-only, en transacción, e idempotente en la definición de función y trigger (`CREATE OR REPLACE`, `REVOKE`, `DROP TRIGGER IF EXISTS`, `CREATE TRIGGER`).
- Añade una función trigger `SECURITY DEFINER` y un `BEFORE INSERT`; no modifica filas, enums, RLS, privilegios de tabla ni semántica de publicación.
- Exige exactamente una fila Critic `succeeded` enlazada al mismo event key, pipeline run e intento, con `zodValid`, resultado Critic válido, prechecks deterministas y decisión `pass`. También comprueba la identidad de checkpoint del intento en el manifest.
- No concede `EXECUTE` directo sobre la función trigger a `PUBLIC`, `anon`, `authenticated` ni `service_role`; la invoca el trigger. La RPC existente `create_pipeline_human_review` conserva `EXECUTE` solo para `service_role`. El acceso directo a la tabla de reviews sigue revocado y RLS sigue habilitado.
- No permite prueba de otro intento, lineage obsoleto, Critic REJECT, proof incompleto o malformado, ni duplicación de review. M31/M32/M33 no se debilitaron.

## Preflight y aplicación remota

El guard de migración actualizado requiere M33 y M34, y detiene la operación si existe cualquier migración local posterior a M34. La ruta usa el ejecutable Supabase local y `SUPABASE_DIRECT_DB_URL` cargado desde `.env.local`; el wrapper no usa link, Management API, `npx` ni fallback.

El CLI documenta que `db push` sincroniza Vault por defecto. El wrapper ahora añade `--skip-vault` al dry-run y al push, y `--yes` al push. El dry-run enumeró únicamente `20261012120000_human_review_critic_attempt_proof.sql`. El push se ejecutó una vez; el CLI confirmó que aplicó únicamente M34. El historial remoto final termina en `20261012120000` y coincide con el historial local.

## ACL remoto

La consulta de catálogo de solo lectura mostró:

- Trigger `pipeline_human_reviews_critic_attempt_proof`: habilitado (`O`), `BEFORE INSERT`, función `SECURITY DEFINER` con el `search_path` esperado.
- Función trigger: `PUBLIC`, `anon`, `authenticated` y `service_role` no tienen `EXECUTE` directo.
- `create_pipeline_human_review`: `service_role` tiene `EXECUTE`; `PUBLIC`, `anon` y `authenticated` no.
- `pipeline_human_reviews`: RLS habilitado; sin SELECT público ni para anon/authenticated y sin privilegios directos SELECT/INSERT/UPDATE/DELETE para service_role.

**Remote ACL: PASS.** El uso de service role queda dentro de la RPC existente y sujeto al trigger M34.

## Fixture remoto

Se ejecutó la fixture de `scripts/migration34-remote-rollback-fixture.sql` mediante el camino directo aprobado. Sigue el patrón transaccional ya usado por M33: datos de event attempt, agent run y review se crean dentro de un bloque con rollback forzado; el bloque comprueba residuo cero después del rollback y falla si no se cumple. No escribe artículos, eventos ni scheduler runs.

| Caso | Resultado remoto esperado y observado por la fixture |
| --- | --- |
| Critic PASS del mismo intento | Aceptado; queda en WAITING dentro de la transacción |
| Prueba de otro intento | Rechazada |
| Sin fila Critic | Rechazada |
| Sin resultado PASS válido | Rechazada |
| Critic REJECT | Rechazada |
| Proof con `zodValid=false` | Rechazada |
| Pipeline run obsoleto | Rechazado |
| Segunda review para el intento | Bloqueada por la unicidad de `attempt_id` |

El comando terminó con `DO` y sin error; los conteos internos post-rollback fueron cero para attempts, reviews y agent runs. Artículos/eventos/scheduler no se insertaron. **Residuo sintético: 0.**

## M32 y baseline real

Lectura previa a aplicar: `2026-10-12T12:43:42.884Z`. Lectura posterior: `2026-10-12T12:47:42.764Z`. Ambas pasaron por el cliente server-side/PostgREST de lectura. M32 status y list se consultaron de nuevo después de M34.

| Invariante | Pre | Post |
| --- | ---: | ---: |
| Attempts reales | 14 | 14 |
| Active / deferred / stuck | 0 / 0 / 0 | 0 / 0 / 0 |
| Reviews / WAITING | 0 / 0 | 0 / 0 |
| Artículos públicos | 2 | 2 |
| Astra | archived | archived |
| Reservas de proveedor desconocidas | 0 | 0 |
| Leases de scheduler activos | 0 | 0 |

Fingerprints públicos (método `publicArticleFingerprintV1`) sin cambio:

- `6203559f-413a-4f06-9346-1720bbeb0e7a` → `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`
- `7415c685-04ed-4956-a77a-4bc372c9b060` → `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`

M32 status: PASS (0 total, 0 WAITING). M32 list: PASS (vacía).

Accounting UTC del 12 de octubre se mantuvo idéntico antes y después: Groq 9 requests / 17.670 tokens; Cloudflare 0; Cerebras 0; unknown 0. Delta de 12F.6C: 0.

El attempt histórico `f7baede0-d577-47f3-a44f-4d245c62b81d` sigue `TECHNICAL_FAILURE` en Critic y contando para el límite, sin cambios. El scheduler `97a658d0-9614-4055-b3d7-3aef253d1145` sigue failed/released con 2 intentos y 9 requests. **Historical rows unchanged: YES.**

## Pruebas

Pasaron las suites focalizadas Critic unit/checkpoint, pipeline, human-review y fresh-process resume, M31, M32, M33, M34, guard y dry-run de migración, multi-attempt throughput, scheduler finalization/execution, provider budget/accounting/telemetry, capacidad/resume M33, Editor y Classifier. También pasaron `npm.cmd run lint`, `npx tsc --noEmit`, `npm.cmd run build`, `git diff --check` y la auditoría de secretos (753 archivos, 0 findings); `.env.local` está ignorado.

## Alcance de escrituras y readiness

- Provider calls: 0.
- Pipeline runs: 0.
- Scheduler runs/mutations: 0.
- Acción humana/publicación: 0.
- Remote application-data writes netos: 0; la fixture fue revertida.
- Remote schema: solo M34 y su registro en `supabase_migrations.schema_migrations`; `--skip-vault` evitó sincronización de secretos.
- Netlify/production deploy: 0.

**READY FOR NEXT UTC RUN: YES.** El runtime canónico siguiente es local y usará el código actual; M34 está aplicada y validada. Esta fase se detiene aquí: no se ejecutó 12F.7.
