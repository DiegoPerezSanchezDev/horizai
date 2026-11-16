# 12C.2B.2d — Remote Critic continuation validation

**Resultado: `READY NO`.** Migration 28 se aplicó una vez y quedó como la última migración remota. La validación sintética encontró un error SQL en la función de autorización. La rutina ejecuta `jsonb_object_length(jsonb)`, función que no existe en PostgreSQL; la llamada devuelve `42883`. La petición de esta fase prohíbe reparar manualmente la migración aplicada y prohíbe crear la 29, así que la validación se detuvo después de limpiar los fixtures.

## PRE-APPLY

- Proyecto vinculado: `skrthgpurquypgdwxast`.
- Migraciones 26 y 27 aplicadas; 28 ausente antes del apply; 29 ausente.
- Migration 28 era la única pendiente.
- Las pruebas estáticas de continuación pasaron. La migración no crea tablas, no inserta intentos, no modifica campos terminales y añade la ruta de continuación de Critic al mismo intento.
- La lectura fresca confirmó el incidente archivado, los dos intentos existentes y la causa pre-dispatch de Critic. Los cinco checkpoints de Verifier a Ranker estaban presentes; no había checkpoint de Critic.
- `git diff --check` terminó con código 0; Git mostró advertencias existentes de conversión LF/CRLF.

## REMOTE STATE RECOVERY

La lectura pública anterior había devuelto `PGRST303`. El estado se recuperó sin tocar credenciales ni permisos, mediante `supabase db query --linked` y lecturas GET con `service_role`; el contrato público se leyó con `anon`.

El artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3` existe, está `archived` y enlaza con el evento `5138e509-f4c3-4020-9d13-6a6efac99a39`. El artículo no aparece en el contrato público. Hay dos artículos públicos y permanecen los mismos dos slugs de baseline.

## MIGRATION HISTORY

El apply informó éxito para `20261002105220_factual_remediation_continuation.sql`. Una lectura directa de `supabase_migrations.schema_migrations` confirmó:

- 27 (`20260930211903`): `APPLIED`.
- 28 (`20261002105220`): `APPLIED` esta sesión y última migración.
- 29: ausente.

Un intento posterior de `supabase migration list --linked` falló por autenticación de conexión. La tabla canónica de historial se leyó correctamente por PostgreSQL vinculado; no se cambiaron credenciales.

## APPLY

Se ejecutó una sola vez `npx supabase migration up --linked`. El CLI informó que aplicó únicamente la migración 28. No se aplicó ninguna otra migración.

## REMOTE OBJECTS

El catálogo remoto muestra estas funciones con propietario `postgres`, `SECURITY DEFINER`, `search_path=pg_catalog, public` y argumentos tipados:

- `authorize_incident_factual_remediation_continuation(uuid, uuid, text, text, text, jsonb)`.
- `finish_incident_factual_remediation_continuation(uuid, uuid, text, text, text, integer)`.
- `publish_incident_factual_remediation_continuation_atomic(uuid, uuid, uuid, text, jsonb)`.

Migration 28 añadió `pipeline_event_attempts.continuation`, su restricción de forma JSON, amplió la restricción de namespace sintético y creó el índice único parcial `pipeline_event_attempts_continuation_run_id_idx`. No creó tablas.

**Defecto observado:** en `supabase/migrations/20261002105220_factual_remediation_continuation.sql:240`, `jsonb_object_length` no está disponible en PostgreSQL. Al procesar un manifiesto válido, PostgREST devolvió error `42883: function jsonb_object_length(jsonb) does not exist`. Por ello el RPC no puede autorizar una continuación válida en su estado actual.

## SECURITY

El catálogo confirma ejecución concedida solo a `service_role`; `anon`, `authenticated` y `PUBLIC` no tienen `EXECUTE`. Las tres funciones usan el `search_path` fijo indicado arriba. La llamada de servicio llegó a la función; la llamada anónima fue denegada y la llamada SQL bajo el rol `authenticated` fue denegada.

## VALID CONTINUATION

**No validada.** No se creó autorización sintética válida. La primera llamada que requería procesar el manifiesto completo terminó con el error PostgreSQL `42883`. No se llamó a Critic ni se creó un run de continuación.

## INVALID CASES

Se comprobaron y rechazaron antes del error:

- `anon` y `authenticated` sin permiso.
- Marcador sintético de despacho de Critic.
- Campo de manifiesto que indica que ya existe checkpoint de Critic.

La siguiente prueba insertó un run sintético exitoso de Critic V4 y envió un manifiesto válido para comprobar el rechazo por checkpoint existente. El RPC falló antes de evaluar esa guarda por `jsonb_object_length`. Las pruebas restantes no se ejecutaron: namespace de linaje incorrecto, checkpoint upstream ausente o hash inválido, etapas no permitidas, propósito incorrecto, estados inválidos, falta de autorización, repetición y concurrencia.

## PRE-DISPATCH PROOF

La lectura real identificó el run `82c2b260-dd02-4232-a6bd-d7d1ffa84b39`: Critic V3, Groq, fallido, enlazado al `eventKey` y dentro de la ventana temporal del intento. La telemetría guarda `providerRequestDispatched=false` y `providerRequestsUsed=0`; el log `groq_tpm_pacing_decision` enlaza `runId`, `eventKey`, `GROQ_TPM_STAGE_EXCEEDS_TPM`, estimación 9005 y límite TPM 8000. Su cuenta de reservas es 0. Migration 28 ya no exige `pipelineRunId` ni `attemptId` inexistentes en `agent_runs.config`; el run real queda enlazado por ID canónico, evento y ventana temporal.

La prueba sintética con marcador de despacho se rechazó. No se realizó ninguna llamada a proveedores. El log de reserva sintético usado solo como marcador de la fixture se eliminó durante la limpieza; no representa una petición real.

## ONE-TIME RULE

No validada porque no se completó la primera autorización sintética.

## CONCURRENCY

No validada. No se lanzaron dos solicitudes de autorización válidas después de descubrir el error del manifiesto.

## HISTORICAL AUDITABILITY

El intento real conserva `TECHNICAL_FAILURE`, `completed_at=2026-10-02T09:56:07.337Z`, `stop_stage=critic`, `stop_reason=cost_guard_violation`, su `pipeline_run_id` original y `pilot_attempt_number=5`. La autorización de continuación permanece nula.

## CHECKPOINT POLICY

El preflight local leyó y verificó hashes de Verifier, Translator, Editor, Classifier y Ranker. El checkpoint de Critic no existe. El reinicio configurado es Critic; el manifiesto local estima la siguiente solicitud en 6.397 tokens con límite 8.000, margen 128 y 1.475 de espacio tras margen. El preflight remoto de esta fase no pudo completar la autorización ni confirmar la reutilización a través del RPC.

## ATTEMPT ACCOUNTING

El intento real sigue siendo la tentativa 2 del evento y la tentativa 5/5 del piloto. La autorización no inserta filas de intentos y no creó una sexta tentativa. Cada fixture sintética se limpió después del error.

## CAPACITY ISOLATION

Después de la limpieza, el baseline coincide: Groq 5 reservas y 7.366 tokens; reservas Groq desconocidas 0; Cloudflare 0 solicitudes y 0 neuronas. No hubo llamadas a Groq, Cerebras ni Cloudflare. El marcador de despacho sintético produjo una fila de reserva temporal de fixture, que se eliminó.

## REAL ATTEMPT ISOLATION

Lectura fresca posterior: intento `a82482be-58d8-4fc6-ac16-946d0906257b`, estado terminal original intacto, `continuation=null`, sin nuevo run V4, sin checkpoint Critic, sin despacho y sin nuevo intento. Los contadores permanecen 5/5 y 24/30 llamadas Groq acumuladas del piloto.

## REAL ARTICLE STATE

Lectura fresca posterior: el artículo sigue `archived`, el evento sigue activo/aprobado y el incidente no figura entre los dos artículos públicos. Los otros dos slugs públicos permanecen iguales.

## CLEANUP

El `finally` del validador eliminó los fixtures de su namespace aleatoria y comprobó residual 0 antes de lanzar el error. La lectura posterior encontró 0 filas con prefijo `12c2b2d:` en intentos, eventos, artículos, fuentes, raw items, runs y logs.

## BASELINE RESTORATION

Las lecturas posteriores al fallo coinciden con el baseline posterior a migration 28 para artículo, evento, fuentes, raw item, dos intentos, artículos públicos y contabilidad. El cambio persistente es el esquema de migration 28.

## RUNNER PREFLIGHT

`npm run pipeline:factual-remediation:continuation:preflight` terminó en `LOCAL_PREFLIGHT_PASS_REMOTE_REVALIDATION_REQUIRED`. Confirma el intento real, piloto 5/5, fallo histórico, cinco checkpoints y estimación Critic V4 de 6.397. El propio resultado dice que el artículo y la capacidad futura deben volver a validarse; este preflight no llamó proveedores ni hizo escrituras.

## NEXT STEP

No autorizar la fase 12C.2B.2e. La función remota de autorización necesita una corrección dentro de un plan de migración autorizado. Esta petición prohíbe una reparación manual y la migración 29, así que no se modificó el objeto remoto ni el archivo de migración después del apply. La fase queda `READY NO`.
