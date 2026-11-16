# FASE 13A.1 — Reanudación controlada desde Editor

Resultado: **DEFERRED_PROVIDER_CAPACITY**. Continuación del ciclo controlado #2: **PASS**. READY FOR HUMAN ACTION: **NO**.

El intento `65a83559-8522-4162-8e04-6f8a0bde62b3` mantuvo la línea de evento y pipeline existentes. El preclaim confirmó `DEFERRED_PROVIDER_CAPACITY`, Editor/g0, checkpoints Verifier y Translator PASS, Editor ausente y sin dispatch previo de Editor.

La única invocación de resume retomó Editor. Editor pasó grounding; Classifier y Geo determinista pasaron. La admisión M35/M36 permitió Editor y Classifier. Ranker fue aplazado antes del despacho porque la ventana TPM local tenía 3.893 tokens y la estimación de Ranker requería 4.259 más el margen de 128, por encima del límite 8.000. Verifier y Translator no se redispatcharon; Ranker y Critic no se despacharon.

La primera llamada del runner a persistir el defer fue bloqueada por su propia guarda de red, que asumió erróneamente que el `resume_stage` del RPC siempre sería `editor`. El pipeline liberó el claim y no regresó resultado. El snapshot durable local Ranker/g1 ya estaba escrito. Se verificó esa fotografía, se reclamó otra vez el mismo intento con el mismo owner y se persistió únicamente con el RPC M35 canónico. Esta reparación no volvió a invocar el pipeline ni hizo otra llamada al proveedor. El estado remoto final es Ranker/g1 diferido, `counts_toward_retry_limit=false`.

Contabilidad 13A.1: 2 reservas y 2 despachos Groq; 3.281 tokens de entrada, 612 de salida, 3.893 nuevos. Acumulado con 13A: 4 solicitudes, 6.309 de entrada, 1.652 de salida y 7.961 tokens. Cap supervisado 18; 14 solicitudes restantes; retries 0, fallback 0, desconocidas 0, Cloudflare 0, Cerebras 0.

No hubo nuevo trigger, intento, review, decisión humana ni publicación. La review WAITING sigue en 0; M32 status/list pasaron y el inspect no aplica porque no se creó review. Hay 20 intentos totales: 0 activos, 1 diferido, 0 atascados. La fila histórica del scheduler conserva `blocked / STOPPED_CAPACITY / PROVIDER_CAPACITY_EXHAUSTED`, con lease liberado. Siguen 3 artículos públicos, fingerprints sin cambios, Astra archivado y Publisher sin ejecutar.

Evidencia estructurada: [artifacts/supervised-cycle-13a1-resume-editor.json](../artifacts/supervised-cycle-13a1-resume-editor.json).
