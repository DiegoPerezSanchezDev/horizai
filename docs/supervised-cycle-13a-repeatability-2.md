# FASE 13A — ciclo supervisado controlado #2

## Resultado

El ciclo controlado #2 **pasa** con el resultado tipado `DEFERRED_PROVIDER_CAPACITY`. Una única invocación canónica utilizó `supervised-candidates:2026-10-21`; descubrió 64 candidatos, extrajo seis y creó un solo intento de evento. Tras completar Verifier y Translator con dos solicitudes Groq, el control de capacidad local aplazó Editor antes de despachar otra solicitud: `GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED`. No hubo reintento, fallback, Critic, review ni publicación.

El scheduler finalizó como `blocked`, decisión `STOPPED_CAPACITY`, motivo persistido `PROVIDER_CAPACITY_EXHAUSTED`; el detalle de la denegación pre-dispatch identifica el límite TPM. El snapshot durable conserva la continuación en `editor`, generación 0 y contador de dispatches 0 para la siguiente etapa. El registro del intento queda abierto (`final_state=null`, `completed_at=null`) para permitir la reanudación segura; el resultado terminal tipado consta en `scheduler_runs.event_final_states`. Este intento activo es diferido y no está atascado.

## Línea base y elegibilidad

Antes de la invocación: 19 intentos históricos; cero activos, diferidos o atascados; una review histórica publicada y cero `WAITING_FOR_HUMAN_REVIEW`; tres artículos públicos; cero solicitudes o reservas Groq de hoy y cero reservas de uso desconocido. El artículo de Astra estaba archivado. Se guardaron los tres fingerprints públicos y se compararon de nuevo después.

La fecha UTC fue `2026-10-21`. La fila exacta `supervised-candidates:2026-10-21` no existía en las dos comprobaciones previas a la ejecución. El historial de migraciones remotas y local coincidía en `20261021120000` (M39). El antiguo mutex manual de publicación `supervised-human-review-publish:2026-10-21` permaneció intacto y se excluye de los conteos del scheduler de candidatos, pipeline y proveedor.

## Gates locales

Pasaron los tests de scheduler y su wiring/finalización, deduplicación y trigger, límite de selección 6, máximo de tres intentos secuenciales, tope de 18 reservas, continuidad normal/reanudación, checkpoints durables, M35, M36, Critic, M34, M31, M32, binding humano M38/M39 y guard de Publisher. También pasaron `npm run lint`, `npx tsc --noEmit`, `npm run build`, `git diff --check` y la auditoría de secretos (cero hallazgos). El build informó que `NEXT_PUBLIC_SITE_URL` no está configurada; se mantuvo la indexación desactivada, según el alcance autorizado.

## Ejecución y observabilidad

Discovery encontró y deduplicó 64 candidatos (cero URLs/hash duplicados o candidatos inválidos); insertó 64 raw items, actualizó cero y reutilizó cero. Extracción seleccionó seis: seis fetches/parser correctos, seis éxitos, cero bloqueados y cero fallidos; seis raw items recibieron actualización de extracción. Cinco resultados informaron `qualityGateOutcome=NOT_REACHED` y uno `ELIGIBLE`; todos terminaron `EXTRACTION_SUCCEEDED`.

El primer evento elegible fue **«Exercise in a pill»**. Su clave es `event-2ecb910eda5c6167b3bb6105aaf38087`; no existe una fila `events.id` porque la ejecución se detuvo antes de publicar o abrir una review. La tentativa `65a83559-8522-4162-8e04-6f8a0bde62b3`, dentro del pipeline `67c79a28-e27e-4a47-89a4-85801b9859cf`, corresponde al candidato `e3a5ef5a-c4d8-42bf-bc3c-08284952d3e4:7128a3126e2d91a70ff811ad4e2da3db`, raw item `a812b3b6-d053-414e-8159-31792bcc1a5a`, fuente MIT Technology Review. El snapshot mantiene esa misma relación de candidato, fuente y evento.

La secuencia fue Discovery → Extraction → Clustering → Verifier (PASS, 1 dispatch) → Translator (PASS, 1 dispatch) → Editor (capacidad denegada antes del dispatch). Editor no escribió checkpoint; no se volvió a ejecutar una etapa completada y no se creó un cuarto intento.

## Capacidad y contabilidad

La configuración distingue límites de Groq de la cuota por ejecución supervisada: RPD 1.000 hard / 850 soft, TPD 200.000 hard / 170.000 soft, TPM 8.000, RPM 30; el máximo de la ejecución supervisada es 18 reservas. El margen RPD interno dejaba 849 solicitudes de pipeline antes de este run y 847 después. La detención se debió al ledger TPM local, no al cap de 18 ni a RPD. Las cabeceras de Groq de las respuestas observaron 5.834 y luego 4.257 tokens restantes en la ventana por minuto.

En esta ejecución: 2 reservas, 2 despachos, 0 solicitudes no despachadas pendientes, 3.028 tokens de entrada, 1.040 de salida y 4.068 en total; uso conocido, cero desconocidas. Retries 0, fallback 0, concurrencia 1. La denegación de Editor fue pre-dispatch y no generó una tercera reserva.

No se alcanzó Critic, por lo que no hubo decisión Critic ni prueba M34 en esta tentativa. M34 sí pasó como regresión local. No se creó review; no aplica el inspect M32 para una review nueva. Las lecturas posteriores de estado y listado M32 confirmaron cero reviews `WAITING` nuevas.

## Reconciliación

La fila del trigger refleja una invocación, una tentativa, dos solicitudes, `run_status=blocked`, `final_decision=blocked`, `stop_reason=PROVIDER_CAPACITY_EXHAUSTED` y lease liberado. Su resumen terminal preserva `DEFERRED_PROVIDER_CAPACITY`, etapa `editor`, 2 solicitudes y tokens conocidos. El intento persistido mantiene el snapshot `SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME`, etapa `editor`, generación 0, dispatch siguiente 0 y sin checkpoint de Editor.

Después del ciclo siguen existiendo tres artículos públicos y los fingerprints anteriores coinciden exactamente. Astra sigue archivado. Publisher no se invocó; no hubo review, aprobación ni acción humana sobre el candidato nuevo. El único resultado de capacidad queda disponible para una futura reanudación autorizada; esta fase no la realiza.

El detalle estructurado, incluidos los seis mapeos de extracción, IDs, límites, contabilidad y estado final, está en [`artifacts/supervised-cycle-13a-repeatability-2.json`](../artifacts/supervised-cycle-13a-repeatability-2.json).
