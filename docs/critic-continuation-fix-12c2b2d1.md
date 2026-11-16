# 12C.2B.2d.1 — arreglo de autorización de continuación

## MIGRATION 28 DEFECT

La migración 28 (`20261002105220_factual_remediation_continuation.sql`) dejó dos llamadas a `jsonb_object_length(jsonb)`, en las líneas 240 y 241. PostgreSQL remoto no registra esa función (`to_regprocedure(...)` devolvió `NULL`); la llamada sintética anterior llegó al manifiesto válido y PostgREST devolvió `42883`, `function jsonb_object_length(jsonb) does not exist`.

La condición afectada era ejecutable, no un error de sintaxis superficial: impedía autorizar manifiestos que sí cumplían el contrato.

## INTENDED JSON AUTHORIZATION SEMANTICS

El manifiesto debe ser un objeto JSON con exactamente seis claves raíz: `schemaVersion`, `eventKey`, `sourceRunId`, `resumeStage`, `criticCheckpoint` y `checkpoints`. `checkpoints` debe ser un objeto con exactamente cinco claves: `verifier`, `translator`, `editor`, `classifier` y `ranker`. Sus valores deben ser hashes SHA-256 hexadecimales en minúscula de 64 caracteres. La versión debe ser `1`, el reinicio debe ser en `critic` y `criticCheckpoint` debe ser `absent`.

La raíz o el objeto anidado vacío, un tipo que no sea objeto, los campos ausentes y las claves extra se rechazan. La regresión offline cubre esos casos y los hashes inválidos. El sondeo remoto comprobó un manifiesto estructural válido con cardinalidades 6 y 5 mediante `jsonb_object_keys`.

## MIGRATION 29

Se creó y aplicó únicamente `20261002150747_factual_remediation_continuation_fix.sql`. La función de autorización mantiene su firma, retorno `jsonb`, modo `SECURITY DEFINER`, propietario y `search_path`. Los dos conteos ahora usan subconsultas `COUNT(*) FROM jsonb_object_keys(...)` después de comprobar que ambos valores son objetos.

La migración también amplía la restricción de `validation_namespace` para aceptar el prefijo sintético específico `12c2b2d1:<uuid>` que exige esta validación. Conserva las allowlists anteriores y exige que estos fixtures no tengan ordinal de piloto. No crea tablas ni modifica filas de intentos.

La migración 28 histórica no se modificó. No existe ni se aplicó migración 30.

## PRE-APPLY VALIDATION

Proyecto enlazado confirmado: `skrthgpurquypgdwxast`. Antes de aplicar, el historial remoto tenía 26, 27 y 28 aplicadas; 29 no aplicada. No había migración 30. El estado real recién leído mostraba el artículo archivado y ausente de la vista pública, dos artículos públicos, dos filas de intento, y contabilidad diaria de Groq de 5 solicitudes/7366 tokens y Cloudflare de 0.

La prueba `scripts/factual-remediation-continuation-migration-29-unit-test.mjs` pasa. Antes de aplicar también pasaron las 55 suites offline, lint, TypeScript, build y `git diff --check`.

## REMOTE APPLY

`supabase migration up --linked` aplicó solo `20261002150747_factual_remediation_continuation_fix.sql`, que era la única migración pendiente. La lista posterior muestra la 29 aplicada y como última versión remota.

## REMOTE OBJECT AUDIT

La función remota mantiene firma `authorize_incident_factual_remediation_continuation(uuid, uuid, text, text, text, jsonb) returns jsonb`, propietario `postgres`, `SECURITY DEFINER` y `search_path=pg_catalog, public`. El cuerpo remoto no contiene `jsonb_object_length`. `service_role` puede ejecutarla; `anon`, `authenticated` y `PUBLIC` no. Las tres funciones de continuación conservan su propiedad, modo de seguridad, ruta de búsqueda y grants. No se creó ninguna tabla.

Las huellas remotas de las rutinas normales de claim/publicación coinciden con las registradas antes de esta corrección. La verificación cubrió `claim_pipeline_event_attempt`, `claim_factual_remediation_attempt`, `claim_incident_factual_remediation_attempt` y `publish_factual_remediation_article_atomic`.

## VALID CONTINUATION

La batería usó 25 fixtures sintéticos bajo el namespace `12c2b2d1:1bababd1-b4f5-4eff-9d1d-3a4b98a7e4f4`; ningún UUID sintético coincidió con los identificadores reales. El RPC de servicio autorizó el fixture válido en el mismo intento y en la etapa `critic`. Conservó el estado y el historial del fallo, mantuvo dos filas sintéticas de intento y no creó una fila de ejecución.

El intento real siguió en 5/5. La autorización sintética no creó un intento piloto adicional.

## INVALID CASES

El RPC rechazó el JSON vacío, JSON no objeto, objeto de checkpoints no válido, versión ausente, clave raíz y checkpoint extra, cada checkpoint upstream ausente, hash inválido, evento o run de origen incorrectos, checkpoint de Critic presente, etapa incorrecta, artículo no archivado, linaje no coincidente, intento activo o READY, fallo técnico no elegible y propósito incorrecto. El marcador sintético de dispatch también fue rechazado. La falta o el formato inválido de `authorized_by`, referencia o motivo produjo `22023`.

Las llamadas como `anon` y `authenticated` fueron denegadas por privilegios. Los manifiestos inválidos devolvieron `BLOCKED`; no se produjo el error `42883`.

## ONE-TIME RULE

La primera autorización sintética devolvió `AUTHORIZED`; repetirla para el mismo intento devolvió `BLOCKED`.

## CONCURRENCY

Dos autorizaciones simultáneas sobre otro fixture produjeron exactamente una admitida y una rechazada. La protección de advisory lock y el bloqueo de fila permanecieron activos.

## HISTORICAL AUDITABILITY

La continuación dejó intactos `final_state=TECHNICAL_FAILURE`, el motivo, la hora de finalización y el run original del intento sintético. No reabrió ni reescribió el registro terminal.

## CHECKPOINT POLICY

El manifiesto válido incluyó Verifier, Translator, Editor, Classifier y Ranker con hashes válidos; declaró que el checkpoint de Critic estaba ausente y que la etapa de reinicio era Critic. Los cinco checkpoints reales siguieron presentes y válidos en el preflight local. La autorización no ejecutó ninguna etapa.

## NORMAL LIFECYCLE

Las huellas de las rutinas normales de claim y publicación no cambiaron. Los límites de intento, claims normales, reintentos, scheduler, bridge, finality de `READY_FOR_PUBLICATION`, fallos técnicos genéricos y la semántica de creación de la migración 27 no recibieron cambios. La ruta explícita de continuación sigue limitada a las condiciones de esta función.

## CAPACITY ISOLATION

La autorización sintética produjo delta 0 de solicitudes/tokens Groq y delta 0 de solicitudes/neuronas Cloudflare. El marcador de dispatch era un log sintético que no era una reserva de proveedor. El contador real siguió en 5 solicitudes y 7366 tokens Groq, 0 solicitudes/neuronas Cloudflare. No hubo llamadas de inference.

## REAL INCIDENT ISOLATION

El intento `a82482be-58d8-4fc6-ac16-946d0906257b` permaneció en `TECHNICAL_FAILURE`, `FACTUAL_REMEDIATION`, intento piloto 5, con continuación nula. El run real de Critic conservó `providerRequestDispatched=false` y `providerRequestsUsed=0`; no apareció checkpoint Critic V4 ni nuevo run. El artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3` siguió archivado y no visible públicamente. El conjunto público conservó sus dos artículos.

Después de limpiar el namespace sintético, las filas residuales en intentos, eventos, artículos, fuentes, raw items, event sources, runs y logs fueron cero. Las huellas de artículo, evento, intentos, capacidad y artículos públicos coincidieron con la línea base anterior.

## RUNNER PREFLIGHT

El runner real terminó en `PREFLIGHT_ONLY` (`LOCAL_PREFLIGHT_PASS_REMOTE_REVALIDATION_REQUIRED`), con el mismo intento, piloto 5/5, 24 llamadas consumidas y máximo futuro de una llamada. Confirmó reinicio en Critic, cinco checkpoints upstream y ausencia de checkpoint Critic. La estimación V4 fue 6397 tokens frente al límite de 8000, con margen de seguridad 128 y headroom ajustado de 1475. El runner informó cero llamadas de proveedor y cero escrituras remotas.

## NEXT STEP

La siguiente fase es `12C.2B.2e — AUTHORIZE + CONTINUE EXISTING FIFTH ATTEMPT AT CRITIC`, con máximo de una llamada Groq. Antes debe volver a leer el artículo real y la capacidad Groq y completar la autorización de continuación. Esta fase no autorizó la continuación real ni despachó Critic. No se ejecuta automáticamente.
