# 12C.2A — Archivo del incidente y guardas de integridad factual

**Resultado: archivo y guardas completados; 12C.2A READY: NO.** El artículo P1 ya no se expone públicamente y la evidencia histórica sigue preservada. La arquitectura actual bloquea permanentemente un segundo intento `READY_FOR_PUBLICATION` y no ofrece una entrada canónica que empiece desde Verifier; se deja un plan de bloqueo para 12C.2B.

## INCIDENT STATE

- Artículo: `756b0ee0-b5e6-4153-846f-278a12c9afe3`
- Evento: `5138e509-f4c3-4020-9d13-6a6efac99a39`
- eventKey: `event-30f226d1b8ba5c9eb8af2b65c46db512`
- Slug: `openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad`
- Fuente y raw item: TechCrunch AI, `e8dd0363-f51e-4381-9fb2-c02ee81f4d41`; `d3834944-72f6-4f59-9aca-3f66ae92dc33`.
- Pipeline run: `63b81d9a-e46f-4434-9637-335d3f455e0b`; intento existente: n.º 1, `READY_FOR_PUBLICATION`, `counts_toward_retry_limit=false`.
- El snapshot público previo coincide con la evidencia 12C.1, SHA-256 `5c61abc2e0a142cfb57da1280932b2e789422f5889eb9072963556501f92e85e`.

## ARCHIVE CONTRACT

El esquema ya admite `publication_status='archived'`. La vista `public_published_articles` filtra por estado `published`, fecha de publicación y evento activo/aprobado. La página dinámica usa `getPublishedArticleBySlug`; si el loader no devuelve datos, Next responde mediante `notFound()`.

Se añadió un lifecycle de servidor acotado al ID, event ID y slug exactos del incidente. Lee y valida esa identidad, hace un PATCH condicional de `published` a `archived`, vuelve a leer el estado y admite repetición idempotente. Usa service role desde un módulo `server-only`. No altera RLS, no requiere migración y no expone una ruta pública de escritura.

## ARCHIVE ACTION

La preflight volvió a leer el contrato público y encontró el artículo visible entre 3 filas; su hash coincidía con 12C.1. Se realizó una escritura remota. El cuerpo del PATCH solo contenía `articles.publication_status: published → archived` para el artículo indicado. El trigger existente de la base actualizó también `updated_at`; el resto de campos editoriales permaneció igual. La fila no se borró.

## PUBLIC EXPOSURE AFTER ARCHIVE

La lectura posterior de `public_published_articles` encontró 2 filas y ninguna coincidencia con el artículo o su slug. Los hashes de los otros dos artículos son idénticos antes y después. La ruta local de producción `GET /noticias/<slug>` respondió **404** después del archivado.

## EVIDENCE RETENTION

La fila del artículo permanece archivada. Los hashes de evento, `event_sources`, raw item, fuente, intentos y seis checkpoints locales no cambiaron; el checkpoint de Critic está presente. Los campos del artículo distintos de `publication_status` y el `updated_at` gestionado por la base siguen iguales. La evidencia 12C.1 permanece sin modificaciones.

El registro remoto `agent_runs`/`agent_logs` no tenía filas asociadas a este pipeline run en la lectura de auditoría anterior. Por eso esta fase afirma la conservación de los checkpoints locales y del snapshot 12C.1, no la existencia de filas de ejecución remotas. `activity_history` quedó fuera de alcance y no se modificó.

## SYSTEMIC ROOT CAUSE

Clasificación: **MULTIPLE**. El Verifier mantuvo el evento como `single_source`, pero la proposición verificada no conservó con suficiente claridad que TechCrunch atribuía detalles materiales a WSJ ni que faltaba confirmación independiente. Translator recibió esa representación más firme. Editor quitó la cautela y añadió afirmaciones de revisión interna y mitigación sin respaldo. Critic aprobó sin recibir suficiente evidencia textual para detectar la escalada.

La arquitectura ya representa `single_source`, confianza, hechos verificados, afirmaciones inciertas, contradicciones y referencias de fuente. No tiene campos tipados separados para “la fuente afirma directamente”, “la fuente cita a otra publicación” y “la fuente especula”; esas relaciones deben permanecer explícitas en las afirmaciones y su atribución. No se cambió la versión del contrato.

## VERIFIER GUARD

El prompt ahora separa un hecho que una fuente informa directamente de un hecho atribuido por esa fuente a otra publicación, y de una afirmación especulativa o cualificada. Un segundo reporte del mismo medio no cuenta como confirmación independiente. Una fuente directa y sólida aún puede sostener un hecho; `single_source` por sí solo no causa rechazo.

## TRANSLATOR GUARD

El prompt exige conservar quién reportó cada afirmación y sus calificadores. Una cadena TechCrunch → WSJ no puede convertirse en “TechCrunch confirma X”. Las comprobaciones de Critic también requieren cobertura uno a uno de `sourceText` con hechos verificados; no se introdujo un reemplazo genérico de palabras clave.

## EDITOR GUARD

El prompt exige mantener la atribución y no aumentar la certeza. Prohíbe introducir como hechos revisiones internas, conclusiones de riesgo, imposibilidad de mitigación, vulnerabilidades o ausencia de planes futuros si la evidencia no los respalda. No se añadió un detector textual heurístico que pretenda resolver semántica.

## CRITIC EVIDENCE

Critic recibe un extracto limitado por fuente: máximo 1.000 caracteres por elemento y 4.000 en total, más ID de fuente/elemento, URL, título y marca de truncado. El pipeline construye esto desde el elemento extraído de la misma fuente y el checkpoint de Ranker lo conserva para reanudaciones futuras. El hash se conserva internamente y no se envía al modelo.

## CRITIC PRECHECK

El precheck valida que cada fuente tenga exactamente un extracto con identidad coincidente y que los `sourceText` traducidos cubran los hechos verificados. Si falta el extracto o no corresponde a la fuente, Critic se detiene antes de cualquier llamada. Puede comprobar contratos y linaje; no puede inferir de forma fiable si una frase aumenta semánticamente la certeza o inventa un hecho. Esa revisión sigue siendo responsabilidad del juicio semántico de Critic con la evidencia disponible. En esta fase no se hizo ninguna llamada de modelo para calibrarlo.

Publisher sigue determinista y no reescribe prosa. No se cambió su comportamiento de publicación.

## REGRESSION FIXTURES

Las fixtures offline cubren:

- Fuente A atribuye X a Outlet B, no hay confirmación independiente y el borrador presenta X como hecho: Critic devuelve `revise_editorial` con hallazgo crítico de certeza.
- Detalle de revisión interna ausente de los hechos y del extracto: Critic devuelve `revise_editorial` y marca la afirmación sin respaldo.
- Pérdida de la atribución durante la traducción: Critic devuelve `revise_translation`.
- Reporte directo de una fuente sólida: pasa, incluso con estado `single_source`.
- Reporte atribuido correctamente a Outlet B: pasa.
- Regresión The Verge: un reporte directo de The Verge con estado `single_source`, extracto acotado y atribución conservada supera el precheck y el control positivo offline. Esto verifica que la nueva regla de evidencia no invalida el artículo solo por tener una fuente.
- MIT Technology Review: `NOT_DETERMINABLE`; no se fabricó evidencia ni se hizo una nueva comparación de fuente.

Los resultados de Critic en tests usan un proveedor simulado en memoria; no certifican la calibración semántica de un modelo remoto.

## MIGRATION DECISION

No se requiere migración para el archivo ni para las guardas implementadas. No se creó la migración 27. El permiso de escritura del lifecycle queda restringido al artículo exacto.

## REPROCESS TOPOLOGY

La ruta normal comienza en Discovery → Extraction → Clustering y no tiene selección de evento ni comando de entrada desde Verifier para una corrección factual. Además, `evaluateNormalEligibility` y `claim_pipeline_event_attempt` clasifican `READY_FOR_PUBLICATION` como resultado permanente; un claim normal de este evento devolvería `INELIGIBLE / PERMANENT_OUTCOME`.

El Publisher hace upsert por `event_id`, y `articles.slug` es único. Por tanto, la materialización canónica de una corrección del mismo evento reutilizaría la fila y el slug existentes y actualizaría esa fila al publicarla; crear otra fila para el mismo slug chocaría con la unicidad. No hay historial de revisiones en la fila. Para conservar el texto previo, 12C.2B tendrá que registrar el antes/después y referenciar el snapshot 12C.1 antes de que Publisher actualice la fila.

Clasificación: **ARCHITECTURE_DOES_NOT_SUPPORT_SAFE_REMEDIATION** en el estado actual. Hace falta una entrada de reprocess explícita y auditada desde Verifier, además de permitir un claim de remediación de un resultado permanente bajo condiciones estrechas (artículo archivado, identidad exacta, motivo y número de intento registrados). La función RPC actual exige un cambio de lifecycle en base de datos; no se añadió ni aplicó esa migración.

## EVENT ATTEMPT CONSEQUENCE

El piloto está en **4/5** y este trabajo consumió **0** intentos. El evento tiene un intento registrado, n.º 1. Si se aprueba e implementa un claim de remediación, sería el intento de evento n.º 2 y el quinto intento del piloto. `counts_toward_retry_limit=false` lo excluye del límite de reintentos técnicos, pero no del presupuesto total del piloto.

## FUTURE MODEL PATH

Si 12C.2B implementa la entrada segura, la ruta prevista es Verifier → Translator → Editor → Classifier → Ranker → Critic: máximo 6 llamadas Groq. Publisher es determinista. Presupuesto registrado: 19/30 llamadas del piloto, 11 restantes; la fase actual hizo 0 llamadas. No se reserva capacidad y la admisión deberá volver a verificarse justo antes de cualquier ejecución.

## NEXT STEP

12C.2A queda **READY: NO** por falta de topología segura de reprocess. Seguir únicamente el plan bloqueado [12C.2B](published-factual-remediation-12c2b-plan.md) para diseñar y aprobar esa entrada. No ejecutar reprocess ni empezar 12D automáticamente.

## VERIFICATION

`verifier:unit`, `translator:unit`, `editor:unit`, `critic:unit`, `incident:archive:lifecycle:unit`, pipeline/orquestación, Publisher/readiness, contratos, loader público, lint, TypeScript y build pasan. La ruta del slug archivado respondió 404 en el servidor local de producción. Groq, Cloudflare, Cerebras, inferencia, reintentos y fallback: 0. Scheduler desactivado; router desactivado; Netlify sin tocar.

El detalle de hashes, conteos, estados y archivos está en [el artefacto 12C.2A](../artifacts/published-factual-remediation-12c2a.json).

## REVALIDACIÓN DE CIERRE (2026-10-02)

Se repitió una preflight de solo lectura contra el proyecto Supabase `skrthgpurquypgdwxast`. El artículo sigue `archived`; `public_published_articles` contiene 2 filas y no incluye el artículo ni su slug. La relación de evento, fuentes y raw item pasa las validaciones de identidad, el evento conserva 1 intento y están presentes los 6 checkpoints locales. La comparación `incidentSnapshotMatches12C1=false` es esperada tras el archivo: el registro ya no está en la vista pública; la instantánea 12C.1 previa continúa guardada y el artefacto original documenta que coincidía antes del cambio.

Los otros dos artículos siguen visibles con los mismos hashes de la comprobación posterior al archivo del 30-09-2026: `bbe077187d9d0130a497a17a0dfe564b2a6bf0765d023da744b35954f9ccb162` y `aae74775888990978dbd42a1c0462f05f2c624af33967ee9b4f3a3d710ca815b`. La ruta pública `/noticias/openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad` devuelve 404 en el servidor de producción local.

Las regresiones offline de Verifier, Translator, Editor, Critic/prechecks, contratos `PublicationPayload`, pipeline/orquestación, lifecycle de intentos, Publisher/readiness, archivo y loader público pasaron. También pasaron lint, TypeScript y build. En esta revalidación hubo 0 llamadas a proveedores y 0 escrituras remotas.

`supabase migration list --linked` confirmó que la última migración aplicada sigue siendo `20260927000026`; `20260930211903_factual_remediation_lifecycle.sql` permanece pendiente. No se aplicó. 12C.2A sigue `READY: NO`: la ruta canónica segura desde Verifier falta y 12C.2B es el siguiente trabajo; detenerse aquí sin iniciar 12D ni reprocess.
