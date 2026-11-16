# HorizAI — Fase 12E.1a

**Estado:** migración aplicada y contrato remoto validado; **12E.1a READY: YES** tras ejecutar, con autorización explícita, una regresión sintética aislada de migración 30 usando su namespace legado permitido. No se creó una fase de reparación.

## 42710 FAILURE

La fase 12E.1 anterior intentó aplicar la migración 31 una vez y PostgreSQL devolvió `42710` para `pipeline_human_reviews_review_manifest_check`. La transacción se revirtió. En 12E.1a se reparó la migración aún no aplicada en el remoto y se hizo exactamente un push nuevo; Supabase aplicó solo `20261005194000_supervised_human_review_gate.sql`.

## DUPLICATE CONSTRAINT ROOT CAUSE

La declaración original contenía dos checks con el mismo nombre generado/expreso:

1. `review_manifest jsonb not null check (jsonb_typeof(review_manifest) = 'object')` generaba `pipeline_human_reviews_review_manifest_check`.
2. La tabla declaraba explícitamente ese mismo nombre para exigir `schemaVersion = 1`, `packageSha256` válido, los seis checkpoints y una identidad/hash válido en cada uno.

Las expresiones eran **SEMANTICALLY_DIFFERENT**. El invariante buscado era su conjunción: manifiesto objeto **y** estructura/versiones/identidades/hashes estrictos. Se clasificó como `NAME_COLLISION_BETWEEN_DIFFERENT_CHECKS`.

## MIGRATION 31 REPAIR

Se editó la migración 31 in situ: se quitó el check anónimo de la columna y se añadió `jsonb_typeof(review_manifest) = 'object'` al check explícito ya nombrado. El manifiesto sigue exigiendo los hashes e identidades de `verifier`, `translator`, `editor`, `classifier`, `ranker` y `critic`. La regresión local cuenta una sola declaración canónica y detecta un `ALTER TABLE ADD CONSTRAINT` duplicado.

No se añadió migración 32, no se parcheó PostgreSQL manualmente y no se editó migración 30.

## MIGRATION 30 PRESERVATION

Migración 30 no se editó. SHA-256 antes/después: `2E775EB5F1473FC472E4AFF656D9297284C7577B6B0D82F686D17E8EEA71F764`. Sus fixtures locales pasan y el hash de la función remota `resume_incident_factual_remediation_continuation` permaneció sin cambios durante el audit 12E.1a.

La regresión sintética remota quedó **PASS** después de la autorización explícita para usar 12c2b2f1a:<UUID nuevo>, el namespace requerido por la función inmutable. Se usó el namespace 12c2b2f1a:6c20ddb2-77de-4d86-8814-7a8ac469d3f7; no se reutilizó ningún UUID histórico y no se editó migración 30 ni 31.

La definición remota de public.resume_incident_factual_remediation_continuation(uuid,uuid,uuid,jsonb) se capturó; su SHA-256 fue d919eab5e93bb3476c6bbd053bc807327543ad0c451910c4ba68a2d78dcae40b y permaneció igual después del test. Con migración 31 aplicada y latest, service_role ejecutó el RPC y obtuvo RESUMED: se reutilizaron el mismo intento y autorización, no se creó otro intento, y el estado reinició en CRITIC. El marcador sintético de pre-dispatch bloqueó el resume; el marcador de checkpoint Critic V4 también lo bloqueó. La segunda invocación quedó bloqueada por la regla de un único resume.

Hubo una primera invocación del harness con otro UUID recién generado que llegó al resume válido y limpió la fixture, pero terminó por una aserción local defectuosa al leer su resultado. El finally confirmó cero residuos. Corregido ese acceso local, se ejecutó la pasada completa con el UUID consignado arriba; todos los invariantes y el baseline posterior pasaron. Los dos UUID fueron distintos y no se reutilizaron.

## LOCAL VALIDATION

El gate local pasó: 57/57 suites offline; fixtures de migraciones 29, 30 y 31; lint; `npx tsc --noEmit`; build; sintaxis del validador remoto; y `git diff --check`. La huella de migración 30 permaneció igual.

## REMOTE APPLY

Proyecto verificado: `skrthgpurquypgdwxast`. La lectura privada normal devolvió PASS con 8 intentos. El dry run listó únicamente la migración 31. El único `db push` de 12E.1a terminó correctamente. Historial remoto: 27–31 aplicadas, `20261005194000` latest y migración 32 ausente.

## REMOTE OBJECT AUDIT

- `pipeline_human_reviews` creado; RLS activado; sin políticas cliente.
- `pipeline_human_reviews_review_manifest_check`: exactamente **1**; su definición remota conserva la forma de objeto, versión, hash de paquete y los seis checkpoints con identidad/hash.
- Índices nuevos: `pipeline_event_attempts_one_human_review_waiting_idx`, `pipeline_human_reviews_attempt_id_key`, `pipeline_human_reviews_pkey`.
- Se añadieron los cinco RPC/helpers de revisión esperados. Solo cambiaron las funciones `claim_pipeline_event_attempt` y `finalize_pipeline_event_attempt`; no se añadieron triggers ni tipos de dominio.
- La tabla solo almacena identidades/hashes y decisiones, sin una segunda copia del cuerpo o payload del artículo.

## SECURITY

Owner de tabla y funciones: `postgres`. Funciones de migración 31: `SECURITY DEFINER` con `search_path` fijo. `anon`, `authenticated` y `PUBLIC` no tienen ejecución de mutaciones; `service_role` tiene el camino RPC confiable. `service_role`, `anon` y `authenticated` tampoco tienen lectura directa de la tabla. El `service_role` no puede llamar directamente `publish_article_atomic`; el wrapper revisado es la única ruta de publicación autorizada por aprobación.

## WAITING STATE

PASS. La creación sintética deja una fila durable `WAITING_FOR_HUMAN_REVIEW`, finaliza el intento con `HUMAN_REVIEW_PENDING` y no publica el artículo.

## NO APPROVAL

BLOCKED con `HUMAN_APPROVAL_REQUIRED`; no aparece en la vista pública.

## HOLD

BLOCKED. La decisión queda guardada y el intento no se reintenta.

## REJECT

BLOCKED. La decisión queda guardada y el intento no se reintenta.

## APPROVE

PASS. Se guardaron reviewer, timestamp, historial, revisión factual y de atribución. La autorización sintética permitió publicar solo el artículo sintético; se eliminó al terminar la prueba.

## STALE APPROVAL

BLOCKED al cambiar el hash del borrador, checkpoint, payload o lineage fuente.

## IDENTITY NEGATIVE CASES

Factual=false y attribution=false: BLOCKED. Evento incorrecto y attempt incorrecto: BLOCKED. Critic no pass: no entra en estado revisable/aprobable. Uso del proveedor sin liquidar: no entra en estado revisable/aprobable.

## SINGLE USE

PASS. Un segundo consumo de la autorización se rechaza.

## CONCURRENCY

PASS. Dos consumos concurrentes: 1 admitido y 1 rechazado.

## MIGRATION 30 REGRESSION

PASS. La RPC de migración 30 siguió ejecutable con service_role después de migración 31. Mismo intento: YES; misma autorización: YES; intentos adicionales: 0; etapa de reinicio: CRITIC. Pre-dispatch: PASS (la presencia del marcador sintético fue bloqueada). Ausencia de checkpoint Critic: PASS (el marcador Critic V4 fue bloqueado). Regla de un resume: PASS (segunda llamada bloqueada). Interferencia de migración 31: NO. Hash de la definición remota de migración 30 antes/después: d919eab5e93bb3476c6bbd053bc807327543ad0c451910c4ba68a2d78dcae40b.

## REAL DATA ISOLATION

Baseline previo y posterior idéntico: 2 artículos públicos, mismos IDs/hashes; Astra archivada con el mismo hash; 8 intentos y los mismos hashes; un registro de intento piloto y el mismo hash; dos intentos de Astra. Las 134 reservas históricas de proveedor y su hash permanecieron iguales. No hubo llamadas a proveedores ni mutaciones de contenido/intentos reales. Las filas sintéticas `12e1a:` y su reserva contable de prueba quedaron en cero.

## NEXT

12E.1a READY: YES. La regresión y el cleanup terminaron; los nueve contadores residuales sintéticos son cero. Los dos artículos públicos conservaron IDs y hashes, Astra siguió archivada, los 8 intentos reales y las filas de human review no cambiaron, y el delta de accounting de proveedores fue 0. Provider calls: 0. Scheduler, publicación real y remediación automática permanecen sin activar. Siguiente fase: 12E.2; esta ejecución se detuvo aquí y 12F no se inició.
