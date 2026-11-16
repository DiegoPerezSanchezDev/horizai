# Recuperación del ciclo supervisado 12F.3

Fecha de verificación: 2026-10-09. La recuperación no reanudó el intento real y no realizó escrituras remotas ni llamadas a proveedores.

**Actualización posterior — fase 12F.3R:** el intento que permanecía activo en esta captura histórica fue finalizado más tarde como `ABORTED` mediante una única llamada al RPC `finalize_pipeline_event_attempt`, sin consumir retry allowance. El detalle y la lectura fresca posterior están en [supervised-cycle-12f3-reconciliation.md](supervised-cycle-12f3-reconciliation.md). No se reanudó el intento ni se inició otro ciclo.

## OBSERVE — causa exacta

El registro de Editor muestra `RUNTIME_ERROR`, pero la evidencia de `agent_runs` confirma `providerRequestDispatched=false` y `providerRequestsUsed=0`. La operación que detuvo Editor fue el preflight de pacing TPM de Groq en `runStructuredAgent`, en `lib/agents/runtime/agent-runner.ts`. Al requerirse esperar al reset y estar `allowProviderPacingWait=false` en el modo supervisado, el código lanza `AgentError` con código `PROVIDER_CAPACITY_EXHAUSTED` y mensaje `Groq TPM pacing requires waiting; refusing supervised stage dispatch`.

La decisión es determinista para el estado observado de los headers TPM y la estimación de Editor. No se originó al leer o validar los checkpoints, al construir el input del editor, ni en una llamada al proveedor. El modo supervisado no espera automáticamente: esa política se conserva. El defecto de código fue tratar el resultado de capacidad como `RUNTIME_ERROR` en la telemetría y no admitir Editor como primera etapa de reanudación.

Hay un segundo bloqueo de ciclo de vida. Después de devolver `DEFERRED_PROVIDER_CAPACITY`, `SupabasePipelineEventAttemptRepository.deferCapacity` intenta actualizar `pipeline_event_attempts` mediante PostgREST. La migración `supabase/migrations/20260930211903_factual_remediation_lifecycle.sql` revoca `INSERT`, `UPDATE` y `DELETE` de esa tabla a `service_role` (línea 60). Las migraciones 30, 31 y 32 no ofrecen una RPC de defer/claim para esta ruta. El repositorio transforma una respuesta sin fila actualizada o con error en `EVENT_ATTEMPT_CAPACITY_DEFER_NOT_OWNED`. No se conserva en el baseline el código HTTP/PostgREST específico de esa escritura fallida; no se atribuye uno.

## Checkpoints y reconstrucción

Se leyeron, sin modificarlos, los checkpoints persistidos de Verifier y Translator del mismo `pipelineRunId`. Un proceso Node nuevo los validó con `readSafeTranslatorCheckpoint`, confirmó la identidad `eventKey`, la igualdad de evento y verificación entre ambos, y confirmó que solo Translator contiene el resultado de traducción. A partir de esos datos y su metadata de fuentes, reconstruyó y validó `EditorInput` y `EditorModelInput` hasta `PROVIDER_DISPATCH_READY`. El hijo no llamó al proveedor ni imprimió el material fuente.

El checkpoint de Translator basta para preparar la entrada del editor. Sin embargo, el ciclo real no produjo un snapshot de capacidad para Editor: antes del cambio local, `capacityResumeStages` solo incluía Classifier, Ranker y Critic. En el directorio del run solo existen los checkpoints previos de Verifier y Translator; falta el snapshot de reanudación que vincularía la etapa, el attempt, el evento, los items y la lineage persistida.

## Cambio local y regresión

Se añadió soporte genérico para `editor` en las etapas de reanudación por capacidad. Un snapshot de Editor requiere Verifier y Translator, y omite `editorial` porque Editor aún no terminó. El orquestador puede escribir ese snapshot antes de invocar Editor. También se añadió el estado de telemetría tipado `PROVIDER_CAPACITY_EXHAUSTED` y un test de la ruta TPM que confirma cero dispatch, cero requests y ese estado, en lugar de `RUNTIME_ERROR`.

La nueva regresión `scripts/supervised-cycle-12f3-recovery-unit-test.mjs` abre los checkpoints de este ciclo en un proceso hijo y hace una continuación sintética en memoria con el mismo identificador de attempt. La simulación empieza en Editor, no repite Verifier ni Translator, no hace discovery, no crea otro attempt, usa cero requests y termina en `WAITING_FOR_HUMAN_REVIEW` sin Publisher. Es una simulación local: no convierte el registro remoto activo en un attempt diferido.

## Comprobación remota de solo lectura

El lector `scripts/supervised-cycle-12f3-recovery-readonly.mjs` limita las peticiones a PostgREST GET/HEAD y a las dos RPC de lectura del gate humano. A 2026-10-09 11:32:41 UTC confirmó:

- El attempt `dfada4fd-d9c6-4aa8-bfef-6d9447267e06` sigue activo, con `final_state=null`, `stop_stage=null` y `stop_reason=null`.
- El total de attempts reales sigue en 11, igual al baseline posterior a 12F.3; no se creó otro attempt.
- No hay filas de review ni reviews en espera.
- Siguen publicados 2 artículos y ambas huellas `publicArticleFingerprintV1` coinciden con el baseline: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64` y `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`.
- Astra continúa archivado.
- La contabilidad sigue siendo Groq 2 requests y 5.778 tokens; Cloudflare y Cerebras siguen en 0. El delta desde el cierre del ciclo es 0 y no hay uso desconocido.

## Verificación offline

Pasaron 71 suites locales `unit`/`simulation` y de contratos. También pasaron los fixtures offline de migration 29 y 30, y dentro de las 71 suites los fixtures de lifecycle humano para migrations 31 y 32. `npm run lint`, `npx tsc --noEmit`, `npm run build` y `git diff --check` pasaron. El build solo compiló y generó páginas estáticas; no ejecutó el pipeline.

## Readiness

`READY TO RESUME SAME ATTEMPT = NO`. Aunque la preparación de Editor desde los checkpoints pasa en un proceso fresco y el soporte local para snapshots de Editor está implementado, el registro remoto no está diferido y no existe el snapshot durable de Editor para este attempt. El guard de reanudación lo rechaza porque requiere `stop_stage=editor` y `stop_reason=PROVIDER_CAPACITY_EXHAUSTED`. No se modificó la fila, no se aplicó una migration y no se reanudó el intento. Se detiene aquí según el alcance autorizado.
