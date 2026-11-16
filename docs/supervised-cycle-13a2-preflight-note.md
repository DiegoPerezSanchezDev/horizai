# FASE 13A.2 — Reanudación desde Ranker

Estado del trabajo: **corrección y gates locales PASS; operación remota bloqueada por revisión automática**.

La guarda de 13A.1 fijaba `p_resume_stage` a `editor` para toda llamada M35 de defer. El runner se había construido para iniciar desde Editor; al avanzar el pipeline hasta Ranker, el snapshot ya indicaba `ranker` generación 1 y la guarda local rechazó ese defer válido. M35 ya permite las etapas posteriores y el pipeline ya genera snapshots para la siguiente etapa pendiente.

La guarda ahora deriva el conjunto permitido de `capacityResumeStages` y sus checkpoints previos de `capacityResumePreviousStages`. Valida la etapa reclamada y la etapa pendiente, identidad de intento/evento/pipeline, snapshot y checkpoints, orden sin retroceso, generación siguiente y que el defer sea pre-dispatch con cero solicitudes y sin contar como retry. No cambia el contrato M35 ni relaja sus invariantes.

El contrato probado cubre `verifier`, `translator`, `editor`, `classifier`, `ranker` y `critic`. `geo` es determinista y no es una etapa de defer por capacidad del proveedor. Los casos locales aceptan defer válido en todas las etapas soportadas y rechazan etapa desconocida, retroceso, etapa distinta del snapshot, lineage distinto, checkpoint previo incompleto, dispatch ya iniciado y generación inválida.

Las pruebas enfocadas, lint, TypeScript, build, `git diff --check` y auditoría de secretos pasaron. La documentación de build indicó que `NEXT_PUBLIC_SITE_URL` falta y que la metadata de indexación queda deshabilitada, comportamiento esperado para esta fase.

La petición de ejecutar la única reanudación remota fue rechazada por la revisión automática: consideró que la operación puede transmitir datos editoriales privados y usar credenciales externas, y señaló que el historial no aportaba autorización humana confiable para ese efecto. No se ejecutó el runner remoto y no se intentó una vía alternativa. Por ello, la capacidad actual no fue consultada, el intento no se reclamó y no se consumió la invocación de resume.

El último estado durable comprobado en 13A.1 era el intento `65a83559-8522-4162-8e04-6f8a0bde62b3`, evento `event-2ecb910eda5c6167b3bb6105aaf38087`, pipeline `67c79a28-e27e-4a47-89a4-85801b9859cf`, diferido en Ranker generación 1, sin despacho ni checkpoint de Ranker. Es un dato histórico de 13A.1; 13A.2 no lo revalidó remotamente.

Contabilidad histórica al inicio de esta fase: 4 reservas/dispatches Groq, 7.961 tokens y 14 solicitudes restantes del límite supervisado de 18. En 13A.2: cero reservas, cero dispatches y cero tokens. No se ejecutó scheduler, no se creó intento, review ni decisión humana; Publisher y publicación no se ejecutaron. No se aplicó migración.

La operación pendiente, si se autoriza, es una única reanudación mediante `PipelineOrchestrator.resumeCapacityDeferred` y `createProductionPipeline`, sobre el mismo intento, desde Ranker generación 1. El runner tiene límite de una invocación, valida el resultado de admisión canónica y detiene el flujo ante defer, fallo técnico, rechazo semántico o resultado tipado final.
