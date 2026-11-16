# Plan bloqueado 12C.2B — Reprocesar el incidente desde Verifier

**Estado: BLOCKED / NO EJECUTADO.** 12C.2A archivó el incidente y completó guardas offline. No iniciar llamadas de proveedor hasta que exista y se revise una ruta de claim de remediación segura.

## Motivo del bloqueo

El pipeline canónico solo inicia por Discovery → Extraction → Clustering. No ofrece un selector exacto para reiniciar este evento desde Verifier. El evento tiene un intento `READY_FOR_PUBLICATION`, que tanto `evaluateNormalEligibility` como `claim_pipeline_event_attempt` consideran permanente. El claim ordinario devolvería `INELIGIBLE / PERMANENT_OUTCOME`.

El Publisher sí upsertea por `event_id`, reutilizando la fila y el slug existentes. Ese upsert pone el estado en `published`; no debe alcanzarse hasta que la nueva ejecución haya completado Critic y el registro de corrección esté aprobado. `articles.slug` tiene unicidad global y no hay historial de revisiones en la fila.

## Diseño requerido antes de ejecutar

1. Diseñar una entrada de remediación de solo servidor que acepte la identidad exacta del artículo, evento y `eventKey`, valide que el artículo siga `archived`, y cargue el raw item y la relación `event_sources` existentes sin redescubrir ni reextraer.
2. Añadir una ruta auditada de claim de remediación para un resultado permanente. Debe exigir un motivo y una referencia al snapshot, mantener bloqueo concurrente, registrar número/run nuevos y no cambiar la política de reintentos ordinarios. La función actual `claim_pipeline_event_attempt` tendría que sustituirse o complementarse en una migración; nunca editar la fila del intento existente.
3. Confirmar el efecto del presupuesto antes de pedir admisión: este sería el intento de evento n.º 2 y consumiría el quinto intento de piloto (límite 5). El intento previo tiene `counts_toward_retry_limit=false`, pero el contador de piloto es distinto.
4. Crear un registro local de corrección antes del pipeline con snapshot público 12C.1, hash, fuente/raw item, motivo, identidad, hashes de checkpoints previos, revisor humano y campos que cambien. El artículo debe seguir archivado durante todas las etapas.
5. Cargar los extractos de la fuente que alimentarán Critic y comprobar el linaje fuente → raw item → evento. Critic debe recibir su extracto acotado; si falta o el linaje difiere, detener antes de cualquier petición.
6. Preflight de proveedor justo antes de cualquier ejecución: Groq solamente, hasta seis llamadas (Verifier, Translator, Editor, Classifier, Ranker, Critic), cero fallback/reintentos, capacidad y presupuestos actualizados. El Publisher es determinista.
7. Exigir Critic `pass`, validar el registro de corrección y luego usar Publisher para actualizar la fila existente y el mismo slug. No crear un artículo paralelo ni borrar la fila archivada.
8. Leer el resultado a través de `public_published_articles`; comparar ID, slug, prosa aprobada, fuente y estado con el registro. Guardar nuevos hashes de checkpoint y snapshot público.

## Política de fila y slug

Recomendación que debe confirmarse en el diseño: `REPROCESS_SAME_EVENT_REPLACE_ARCHIVED_ARTICLE`, reutilizar la misma fila y slug existentes. Publisher implementa upsert por `event_id` y el slug no puede duplicarse. El snapshot 12C.1 y los checkpoints inmutables preservan el texto anterior; antes de ejecutar, verificar que el registro before/after cubra los campos que el upsert actualizará.

## Cambio de base de datos

La excepción al estado permanente necesita un cambio explícito en el lifecycle/RPC de claim. Esto probablemente requiere una nueva migración versionada. No se creó una migración en 12C.2A; no crear ni aplicar la migración 27 sin un alcance de implementación para 12C.2B. No debilitar RLS ni reescribir el estado/contador directamente.

## Presupuestos pendientes

- Piloto actual al cierre de 12C.2A: 19/30 llamadas Groq, 4/5 intentos.
- 12C.2A consumió: 0 llamadas y 0 intentos.
- Remediación completa prevista: hasta 6 llamadas Groq y el quinto intento del piloto.
- La cifra 19/30 es histórica; no constituye admisión de capacidad. Revalidar el contador, la cuota diaria, la capacidad y las reservas desconocidas inmediatamente antes de 12C.2B.

## Criterios para desbloquear

- Ruta exacta de Verifier y carga del evento probadas en fixtures sin proveedores.
- Claim de remediación atómico, auditado, idempotente y limitado al artículo archivado.
- Pruebas de que el flujo ordinario aún rechaza `READY_FOR_PUBLICATION` permanente.
- Revisión del esquema/migración y confirmación de que no se altera evidencia histórica.
- Preflight de fuente, checkpoints, capacidad Groq y último intento del piloto.
- Autorización explícita para ejecutar hasta seis llamadas Groq y consumir el intento 5/5.

Hasta que se cumplan estos criterios, mantener el artículo archivado. No iniciar 12D.
