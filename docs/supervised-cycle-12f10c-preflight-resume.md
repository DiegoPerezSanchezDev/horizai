# 12F.10C — preflight remoto y reanudación del intento diferido

## Resultado

La lectura privada se recuperó con el cliente server-side habitual. El preflight confirmó el mismo intento y los checkpoints de Verifier y Translator. La única invocación autorizada de PipelineOrchestrator.resumeCapacityDeferred terminó en TECHNICAL_FAILURE en Editor por GROQ_TPM_STATE_UNKNOWN; no se hizo dispatch a Groq. No se reintentó.

El intento quedó terminal y no hay runs activos, intentos nuevos, reviews nuevos ni cambios en artículos, accounting o scheduler. READY FOR HUMAN ACTION = NO.

## PGRST303 y autenticación

12F.10B guardó el código PGRST303, pero no persistió HTTP status ni el cuerpo de error. PostgREST usa este código para errores de validación o análisis de claims JWT. Por tanto, el submensaje exacto de esa respuesta concreta no puede recuperarse de los datos conservados.

El mismo cliente y la misma carga de .env.local pasaron después M32 status/list/inspect y un GET instrumentado a pipeline_event_attempts devolvió HTTP 200. En el repositorio existe un caso anterior de PGRST303 cuyo cuerpo sí decía JWT issued at future; es consistente con un fallo transitorio de validación temporal, pero no permite afirmar que ese fuese el submensaje de 12F.10B. No hay evidencia de secreto inválido, variable ausente, header incorrecto ni ACL denegada.

Las variables NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SECRET_KEY y SUPABASE_DIRECT_DB_URL estaban presentes en el proceso iniciado con node --env-file-if-exists=.env.local. El helper createSupabaseServerClient() usa URL más SUPABASE_SECRET_KEY; las RPC M32 de operador exigen service_role y pasaron.

## Camino de lectura

El preflight 12F.10A anterior usaba allRows("pipeline_event_attempts"), que pedía páginas amplias con select("*"). El GET instrumentado a ese endpoint devolvió HTTP 200 con el rol service_role; no imprimió el contenido. M17 revoca acceso a public, anon y authenticated; M29 y M35 dejan las escrituras directas de service_role revocadas. No se amplió ningún permiso.

Para este preflight se leyó una sola fila filtrada por attempt, event y pipeline run, y el snapshot se cargó además mediante SupabasePipelineEventAttemptRepository.loadCapacityResumeSnapshot. No existe una RPC de solo lectura para el estado de intentos en M33/M35/M36; sus RPC de claim, defer, release y reserva son mutadoras. M32 status/list/inspect se usaron únicamente para reviews y comprobación de autenticación.

El camino de lectura existente fue suficiente y MIGRATION_REQUIRED = NO; no se creó ni aplicó M37. La cabecera de migraciones sigue en 20261015120000; history, M35 ACL y M36 ACL pasaron.

## Preflight remoto

Fecha UTC: 2026-10-16. Se confirmó que el trigger histórico supervised-candidates:2026-10-16 estaba consumido y que su fila no cambió.

Antes del resume:

- Intentos reales: 18; activos/diferidos/atascados: 0/1/0.
- Reviews/WAITING: 0/0; runs activos: 0.
- Intento 16f922f2-0409-4c28-aadb-13fb5e489e7d, número 1, abierto y DEFERRED_PROVIDER_CAPACITY, etapa editor, generación 0, retry class NONE.
- Evento event-0d2cec33a9acdaff882291db5e686f6c y pipeline 4453d15d-1bcd-42dc-ba55-c060e1222aab coincidían.
- Verifier y Translator tenían checkpoints durables, hashes locales iguales a los almacenados y linaje válido. Sus accounting estaban asentados: dos reservas/despachos Groq, 4085 tokens de entrada, 789 de salida y 4874 totales.
- Había un registro fallido de Editor de la ejecución inicial. Su telemetría decía providerRequestDispatched=false, providerRequestsUsed=0, sin reserva ni checkpoint Editor. No era un dispatch.
- Artículos públicos: 2; fingerprints publicArticleFingerprintV1 iguales al baseline. Astra seguía archivado.
- Reservas desconocidas: 0. M32 status/list/inspect, M35 ACL, M36 ACL y migration history: PASS.

## Reanudación y resultado

El único ingreso fue PipelineOrchestrator.resumeCapacityDeferred desde createProductionPipeline, en modo supervised, límite 1, Publisher desactivado, retries 0, fallback 0 y espera de pacing desactivada. El presupuesto local de 18 solicitudes se inicializó con las 2 solicitudes asentadas del snapshot antes de invocar el resume. El quota preflight devolvió 847 solicitudes disponibles y la ejecución requirió 4 para admitir las etapas restantes.

La llamada reclamó el mismo intento y llegó a Editor. El log remoto de pacing registró TPM_REMAINING_UNKNOWN, requisito estimado de 4448 tokens y margen de 128. AgentRunner rechazó el dispatch con GROQ_TPM_STATE_UNKNOWN; no había headers de headroom/reset suficientes para probar que fuera capacidad agotada. Por eso no se clasificó como defer de capacidad. La finalización normal del lifecycle marcó el mismo intento como TECHNICAL_FAILURE, stop_stage=editor, retry_class=TECHNICAL_FAILURE, con counts_toward_retry_limit=true.

Este resume: reservas/despachos/tokens Groq 0/0/0. Acumulado del intento: 2/2/4874, por debajo del límite de 18. Cloudflare y Cerebras: 0. Verifier y Translator no se volvieron a ejecutar; el resultado contiene su telemetría histórica. Classifier, Ranker y Critic no se ejecutaron. No hubo proof M34 nuevo, review ni Publisher.

## Estado posterior

- Intentos reales: 18; activos/diferidos/atascados: 0/0/0.
- El mismo intento está terminal como TECHNICAL_FAILURE en Editor.
- Reviews/WAITING: 0/0; M32 status/list/inspect: PASS.
- Accounting diario Groq no cambió: 2 reservas, 2 despachos, 4085 entrada, 789 salida, 4874 total, 0 desconocidas. Cloudflare/Cerebras: 0.
- Artículos públicos: 2; fingerprints sin cambios. Astra sigue archivado.
- El hash de la fila histórica del scheduler coincide con el baseline; no se adquirió otro trigger.
- Publisher no corrió. No se aprobó, retuvo ni rechazó ninguna review.

El resume sí hizo la claim M35 y la finalización M35 del intento existente, además de registrar la ejecución fallida de Editor. No creó intentos, reviews, escrituras de artículos, reservas de provider ni cambios del scheduler.

## Validaciones locales

Las suites offline de pipeline, resume de capacidad, Editor, M33/M35, checkpoints durables, finalización supervisada, throughput, M36, Verifier, Translator, Editor, Classifier, Ranker, Critic y M32/M34 pasaron antes de la única invocación. También pasaron lint, TypeScript, build, git diff --check y el secret audit. No se cambió código de aplicación en esta fase.

## Cierre

Clasificación final: TECHNICAL_FAILURE por estado TPM desconocido antes del dispatch. Resume invocations: 1. Provider calls: 0. READY FOR HUMAN ACTION = NO. No continuar este intento ni iniciar una ejecución diaria desde esta fase.
