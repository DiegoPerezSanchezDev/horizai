# 12F.12I — cierre de entrega de la revisión existente

Revisión autoritativa: `ebd8acc0-76a2-4977-81d9-60a7f6240084`. Intento: `4658d5c0-857c-4ed5-b97f-afb133b2bf22`. Esta fase no reanuda Critic ni crea revisiones, intentos o publicaciones. La única escritura remota autorizada es una migración de la función de lectura.

## OBSERVE: contratos y causas

M31 almacena `source_lineage` y su `source_lineage_sha256` obligatorio e inmutable. `create_pipeline_human_review` calcula SHA256 sobre `p_source_lineage::text` de PostgreSQL JSONB y añade el mismo digest a `review_manifest.sourceLineageSha256`. La restricción de la tabla exige igualdad. M34 exige una prueba Critic PASS del mismo intento, evento y pipeline en el manifiesto.

M32 status devuelve agregados, sin filas de revisión. M32 list devuelve resúmenes con `source_lineage_sha256`. M32 inspect devuelve el resumen y la fuente completa, pero la definición histórica omite ese hash. `summaryRowSchema` lo exige; `reviewRowSchema` hereda ese contrato y los parsers comprueban las identidades y hashes del manifiesto. Las pruebas anteriores fabricaban una fila completa e impedían detectar la omisión SQL. Clasificación M32: `RPC_PROJECTION_MISSING_REQUIRED_FIELD`. Contrato intencional: REQUIRED.

La comprobación del paquete en el CLI tenía además una discrepancia demostrada: calculaba el digest con JSON compacto ordenado en lugar de `jsonb::text`. La fuente existente tiene digest PostgreSQL `42c5de597f333d80c31d634f61960181d7f5480201237b9f447d37b651d968dc`; el digest compacto es distinto. El helper específico para la fuente reproduce el orden de claves por longitud en bytes, el orden de bytes para empates y los espacios de JSONB. No cambia ni reescribe la fuente, el manifiesto o sus garantías.

M31 bloquea el intento, verifica la evidencia, actualiza el intento a `WAITING_FOR_HUMAN_REVIEW` e inserta la revisión en una transacción. El propietario semántico de esa finalización exitosa es `create_pipeline_human_review`. El camino normal del orquestador ya respeta ese contrato. El camino `resumeCapacityDeferred` llamaba después a `registry.finalize` (línea 636 en 12H). La actualización final solo admite `completed_at IS NULL`, por lo que produjo `P0001: attempt is not owned or already finalized`. La revisión y el intento ya habían quedado correctamente en WAITING. Clasificación: `DUPLICATE_FINALIZATION_CALL`.

## PLAN y EXECUTE: corrección mínima

M37 (`20261020120000_human_review_inspect_source_lineage_hash.sql`) reemplaza únicamente la función inspect y añade la proyección de la columna almacenada. Conserva STABLE, SECURITY DEFINER, search_path fijo, comprobación service_role y revocación de permisos públicos. No modifica M32 ni otras migraciones aplicadas; status/list y los ACL de tablas permanecen iguales.

El resume acepta la transición terminal del RPC cuando el resultado es WAITING, existe reviewId y Critic PASS tiene checkpoint escrito, legible y válido. En ese caso omite la segunda finalización, igual que el camino normal. Los demás resultados conservan su finalización y sus errores; no se ignora P0001 globalmente. El contrato del gateway documenta esta propiedad.

## CRITIQUE y VERIFY

Las pruebas sin red usan el orquestador real y un gateway en memoria que representa la transacción SQL. Comprueban una sola finalización, una sola revisión WAITING, fallos de creación/M34, prevención de duplicados, intentos ya terminales y propagación de conflictos inesperados. La prueba M37 compara la definición completa con M32 más una sola propiedad, reproduce el antiguo fallo de parsing con la respuesta real de 12H y valida la respuesta corregida contra el paquete y los seis checkpoints inmutables. Incluye rechazos por intento, pipeline, fuente y prueba Critic alterados.

La evidencia definitiva de gates, aplicación única, cabeza remota, ACL, hashes de funciones/tablas y validación de M32 queda en `artifacts/supervised-cycle-12f12i-review-handoff.json` y sus evidencias referenciadas. READY FOR HUMAN ACTION solo se afirmará después de completar todas las comprobaciones remotas. No se ejecuta ninguna decisión humana.

## Resultado verificado

**READY FOR HUMAN ACTION: YES.** Validación remota completada el 20 de octubre de 2026 a las 20:20 UTC. La revisión autoritativa continúa WAITING y sin consumir. No se realizó la revisión humana.

| Campo de entrega | Evidencia / resultado |
| --- | --- |
| m32ContractInventory | Status agregado; list incluye hash; inspect ya proyecta la columna obligatoria. Parser estricto conservado. |
| sourceLineageContract | REQUIRED; digest almacenado, manifiesto, fuente local y hash PostgreSQL coinciden. |
| m32RootCause | RPC_PROJECTION_MISSING_REQUIRED_FIELD. El CLI también requería corregir su serialización del digest. |
| m32Fix | Una propiedad en inspect y helper de digest de fuente conforme a M31. |
| migration | M37 aplicada una vez; única pendiente en dry-run; head remoto `20261020120000`. |
| ACL | PASS; solo service_role; sin grants públicos ni cambios en ACL de tablas. |
| Migraciones históricas | 37 archivos con SHA256 intacto. |
| terminalizationOwnership | REVIEW_RPC_OWNS_TERMINALIZATION: `create_pipeline_human_review`. |
| duplicateFinalizationRootCause | DUPLICATE_FINALIZATION_CALL en `resumeCapacityDeferred → registry.finalize`; P0001 porque completed_at ya estaba asignado. |
| terminalizationFix | FIXED; WAITING probado acepta la transición atómica y omite la segunda finalización. Otros errores siguen propagándose. |
| localGates | PASS: 22 suites enfocadas, lint, TypeScript, build, diff check y auditoría de secretos (0 hallazgos). |
| existingReviewValidation | `ebd8acc0-76a2-4977-81d9-60a7f6240084`; WAITING; consumed=false; duplicada=NO. |
| m32Status / m32List / m32Inspect | PASS / PASS / PASS, HTTP 200, por el repositorio y sus parsers reales. |
| Fuente / Critic durable / M34 | PASS / PASS / PASS; seis identidades y digests de checkpoint verificados. |
| attemptValidation | Terminal WAITING_FOR_HUMAN_REVIEW; misma completed_at de 12H; generación 1; sin reabrir ni reejecutar etapas. |
| baseline | 19 intentos; activos/diferidos/atascados 0/0/0; reviews/WAITING 1/1. |
| Público | 2; Astra ARCHIVED; fingerprints intactos. |
| providerAccounting | 0 llamadas en esta fase; acumulado 6 requests, 9140 input + 1652 output = 10792 tokens; unknown reservations 0. |
| Publisher | NOT RUN. |
| Acciones prohibidas | Resume Critic, nuevas reviews/intentos, scheduler, mutaciones editoriales, APPROVE/HOLD/REJECT y publicaciones: todos 0. |
| readyForHumanAction | true. |

Las lecturas antes de M37, después de M37 y al cierre conservan exactamente los hashes de todas las filas de intentos, revisiones, artículos, agent_runs, agent_logs y scheduler_runs. También coinciden los hashes de las demás funciones y de los ACL de tablas. La única modificación remota es la definición de inspect y el registro de M37 en el historial de migraciones.

El build terminó correctamente en el host después de un EPERM del sandbox al crear `.next`. Persiste el aviso previo de NEXT_PUBLIC_SITE_URL ausente/inválido e indexación desactivada; no se cambió esa configuración.

Evidencia principal: `artifacts/supervised-cycle-12f12i-review-handoff.json`. Detalle remoto: `artifacts/supervised-cycle-12f12i-readonly-validation.json`. Head/ACL/hashes: `artifacts/supervised-cycle-12f12i-acl-before.json`, `artifacts/supervised-cycle-12f12i-acl-after.json` y `artifacts/supervised-cycle-12f12i-acl-final.json`. Gates y hashes del código: `artifacts/supervised-cycle-12f12i-local-gates.json`.

La fase se detiene aquí. La siguiente acción humana no se ejecutó.
