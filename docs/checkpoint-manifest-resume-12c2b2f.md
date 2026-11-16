# 12C.2B.2f — canonicalización del manifiesto y auditoría de reanudación

**Estado de esta fase:** lista; auditoría y corrección local completas. No se hicieron llamadas a proveedores ni escrituras remotas. La continuación real sigue `STOPPED`; la migración 30 está preparada localmente y no aplicada.

## FAILURE

La continuación existente `f140d01b-b7f1-4f05-b8f7-9ad0081e7105`, del intento `a82482be-58d8-4fc6-ac16-946d0906257b`, terminó antes de crear un run de Critic con `FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_MANIFEST_CHANGED`. El guard comparaba los manifiestos local y remoto con `JSON.stringify`, sensible al orden de claves de objetos.

## MANIFESTS

El manifiesto local reconstruido desde los cinco checkpoints tiene estas seis claves raíz, en este orden: `schemaVersion`, `eventKey`, `sourceRunId`, `resumeStage`, `criticCheckpoint`, `checkpoints`. El JSONB remoto devuelve: `eventKey`, `checkpoints`, `resumeStage`, `sourceRunId`, `schemaVersion`, `criticCheckpoint`. El orden local de las claves anidadas `checkpoints` es `verifier`, `translator`, `editor`, `classifier`, `ranker`; el remoto es `editor`, `ranker`, `verifier`, `classifier`, `translator`.

Ambos manifiestos contienen exactamente los mismos seis nombres y valores raíz y los mismos cinco pares etapa/hash:

| Etapa | SHA-256 |
| --- | --- |
| Verifier | `668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378` |
| Translator | `668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378` |
| Editor | `ac88461328385917a3c9ebd219815b06211b1d0ed64684eea1f0993c4e5cc218` |
| Classifier | `947951b78f3aa39719943d8d916a70c23a796777b33557b8dcb5d67d3b4a345d` |
| Ranker | `17d758b3883239ab7e3dc28141b8449c9b93df43827f56d77b4ef6fe506d5edf` |

El manifiesto no contiene attempt ID ni autorización: esos valores viven en el objeto de continuación y se validan por separado. El intento es `a82482be-58d8-4fc6-ac16-946d0906257b`; el run original es `db368f10-d9c1-4897-b752-b3d2cb156e09`; el único `pipelineRunId` autorizado es `f140d01b-b7f1-4f05-b8f7-9ad0081e7105`; el evento es `event-30f226d1b8ba5c9eb8af2b65c46db512`.

## SEMANTIC COMPARISON

La reproducción en vivo sobre la fila JSONB produjo:

- `JSON.stringify(local) === JSON.stringify(remote)`: **false**.
- comparación profunda de los valores JSON: **true**.
- JSON canónico local y remoto: **idéntico**.
- SHA-256 canónico de ambos: `0c3a6f8dab750a345f38e0efbd8481557a1fbfd49a43b2a13879b1ee43e555a6`.

Clasificación de diferencia: `OBJECT_KEY_ORDER_ONLY`. Clasificación de causa raíz: **`SERIALIZATION_CONTRACT_BUG`**. Los datos no muestran diferencias de tipo, valores ni linaje.

## ROOT CAUSE

PostgreSQL JSONB conserva la semántica del objeto, pero no el orden original de sus claves. La comparación de cadenas trataba ese orden de serialización como parte de la identidad. Por eso rechazó un manifiesto semánticamente idéntico antes de reservar o ejecutar Critic.

## CANONICALIZATION

Se añadió `continuationCheckpointManifestSchema`, estricto en raíz y en `checkpoints`. Exige exactamente las seis claves raíz y las cinco etapas admitidas; fija versión, evento, run de origen, etapa de reanudación, ausencia de checkpoint Critic y los hashes SHA-256 esperados para este incidente.

El comparador valida ambos lados con el mismo esquema y serializa recursivamente con las claves de objetos ordenadas. Mantiene el orden de arrays y conserva los valores escalares. Claves ausentes, claves extra, `null`, cambios de string, booleano, número, etapa, evento, run o hash no se normalizan como equivalentes. El guard remoto y la comprobación local posterior a la autorización usan este comparador. El guard de la migración usa igualdad JSONB semántica, además de validar la forma exacta y cada hash.

## SECURITY INVARIANTS

- Exactamente seis claves raíz y cinco checkpoints; sin subset, superset ni claves desconocidas.
- Los hashes tienen formato SHA-256 minúsculo y deben coincidir con los cinco hashes fijos de este incidente.
- Evento, run original, etapa `critic` e indicador `criticCheckpoint: absent` deben coincidir exactamente.
- Attempt ID, authorization reference, run autorizado y timestamps se validan fuera del manifiesto; la migración los fija al registro ya autorizado.
- Arrays conservan su orden; no hay arrays en este manifiesto.
- Reanudar no llama al RPC de autorización, no crea un intento y solo admite una transición `resumeGeneration: 1`.
- El stop previo se copia en `resumeHistory` antes de pasar a `RUNNING`.
- La migración solo admite `service_role`, fija `search_path`, toma lock advisory y limita la ruta al incidente, run, stop y autorización observados.
- El RPC exige cero solicitudes usadas y que no existan runs, reservas o dispatch de proveedor para la continuación.
- No se cambian los checkpoints ni sus hashes.

## REAL CONTINUATION STATE

La lectura remota actual confirmó:

| Campo | Valor |
| --- | --- |
| Attempt ID | `a82482be-58d8-4fc6-ac16-946d0906257b` |
| Run original | `db368f10-d9c1-4897-b752-b3d2cb156e09` |
| Run de continuación autorizado | `f140d01b-b7f1-4f05-b8f7-9ad0081e7105` |
| Autorización | `Diego`; referencia de solicitud de fase `12C.2B.2` |
| Autorizado UTC | `2026-10-02T20:58:56.149531+00:00` |
| Estado actual | `STOPPED` |
| Stop UTC | `2026-10-02T20:58:56.472794+00:00` |
| Stop reason | `CONTINUATION_RUNNER_ABORTED` |
| Solicitudes usadas | 0 |
| Ejecuciones de agente con el run de continuación | 0 |
| Reservas `provider_request_reserved` | 0 |
| Filas de intento del evento | 2; intento piloto 5/5; no hay intento 6 |
| Artículo | archivado; no visible; 2 artículos públicos |

`CriticDecision` sigue nulo y no existe checkpoint Critic. Los cinco checkpoints Verifier → Ranker siguen cargando con sus hashes y linaje esperados; el loader valida la cobertura factual, atribución secundaria, incertidumbre y geo. No se reejecutaron.

## RESUME CLASSIFICATION

**`C — SAME_AUTHORIZED_CONTINUATION_REQUIRES_DB_STATE_TRANSITION`.** La comparación local corregida elimina el falso rechazo, pero no cambia el estado remoto. El runner exige `RUNNING`; el registro real está `STOPPED`; el RPC de finalización devuelve `ALREADY_STOPPED`; y el RPC de autorización solo acepta `continuation IS NULL`. Por tanto, corregir únicamente TypeScript no permite continuar.

La arquitectura usa `pipelineRunId` como identidad de la autorización y del pipeline. Se conserva ese mismo ID. No hay `agent_runs` para la ejecución abortada, así que tampoco hay un ID de ejecución de Critic previo que pueda colisionar; el siguiente run de agente tendrá su propio ID. `resumeGeneration: 1` identifica la única reanudación.

## LIFECYCLE CONSEQUENCE

La migración 28 crea la autorización de un solo uso y el estado `RUNNING`; la 29 repara la validación de cardinalidad del manifiesto. La función `finish_incident_factual_remediation_continuation` registra `STOPPED` de forma terminal e idempotente y no ofrece transición de regreso. El runner anterior invocó esa función tras el error local y cerró la continuación con cero solicitudes.

La migración 30 preparada añade un RPC específico de reanudación. No borra ni sobreescribe el stop histórico: lo conserva en `resumeHistory`, valida que aún no se haya usado una reanudación y cambia el estado vigente a `RUNNING` para el mismo attempt y `pipelineRunId`. No autoriza otra vez ni toca los campos terminales del intento factual.

## MIGRATION 30

Preparada localmente: [20261002211000_factual_remediation_continuation_resume.sql](/C:/Users/Diego/OneDrive/Desktop/horizai/horizai/supabase/migrations/20261002211000_factual_remediation_continuation_resume.sql). Añade solo `resume_incident_factual_remediation_continuation(uuid, uuid, jsonb)`, sin tablas ni creación de intentos. Requiere servicio, lock, el stop exacto, autorización/timestamps existentes, manifiesto exacto, artículo archivado, linaje de origen intacto y ausencia de cualquier run/reserva de proveedor.

No se aplicó. La última historia remota verificada en la fase anterior terminaba en migración 29. No hay cliente PostgreSQL local disponible: `psql` y Supabase CLI no están instalados, y el daemon Docker no está activo. Por ello la migración recibió pruebas offline estáticas; no se afirma que se haya ejecutado contra PostgreSQL.

## CRITIC V4

El preflight local reconstruyó **6.397 tokens** (5.197 entrada + 1.200 salida), bajo el límite nominal 8.000 y el margen de seguridad 128. No se usó la observación TPM de la fase anterior para admitir capacidad futura: está obsoleta. Antes de cualquier despacho futuro se necesita una lectura TPM fresca.

La evidencia factual sigue igual: fuente TechCrunch AI; atribución al Wall Street Journal y contacto de TechCrunch con OpenAI preservados; estado de verificación `single_source`; incertidumbre presente; dos hechos verificados; prechecks Critic sin incidencias; geo US. El borrador de Editor y la superficie de comparación de detalles no sustentados permanecen intactos.

## REGRESSIONS

Las regresiones de manifiesto pasan: reproducción exacta de distinta orden raíz/anidado; igualdad semántica; huella canónica estable; cambios de hash, etapa, evento, run, attempt field, campo de autorización, clave ausente/extra rechazados; orden de array significativo; y distinción de clave ausente frente a `null`, strings, booleanos y números.

El test de la ruta de reanudación confirma que el repositorio llama solo a `resume_incident_factual_remediation_continuation` con attempt, run y manifiesto: no llama al RPC de autorización. El test offline de migración 30 verifica límites del estado `STOPPED`, una sola generación, historial preservado, rol y grants, hashes exactos, ausencia de actividad de proveedor y que no se insertan intentos. No hubo prueba de round-trip PostgreSQL local porque no hay servidor local disponible.

Pasaron **58 suites offline**: 55 unitarias, contratos de agentes y las suites específicas de migración 29 y 30. También pasaron `npm run lint`, `npx tsc --noEmit`, `npm run build` y `git diff --check`. Git solo advirtió conversiones LF→CRLF en archivos que ya estaban modificados antes de esta fase; no reportó errores de whitespace.

## REAL STATE

Tras la auditoría, no se hicieron escrituras remotas, llamadas Groq/Cloudflare/Cerebras ni llamadas de inferencia. El artículo continúa archivado y la cuenta pública continúa en 2. El piloto permanece en **5/5 intentos** y **25/30 llamadas Groq**; Cloudflare 0 y Cerebras 0.

La migración 30 sigue **no aplicada**. La transición de continuación permanece pendiente; no se invocó el método `resumePreviouslyAuthorized` durante esta fase.

## NEXT STEP

`12C.2B.2f READY: YES` para auditoría y preparación local. Siguiente fase: **12C.2B.2f.1 — aplicar y validar migración 30**, sin proveedor ni Critic. Solo después de esa validación se prepara la ejecución que reutiliza la autorización y el mismo `pipelineRunId`; antes de despachar Critic debe obtener TPM fresco. Nunca se llama otra vez a la autorización y no se crea el intento 6.
