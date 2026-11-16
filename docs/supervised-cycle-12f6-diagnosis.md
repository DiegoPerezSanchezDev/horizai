# 12F.6B — Diagnóstico de Critic PASS y human-review gate

## Alcance y resultado histórico

No se volvió a ejecutar el pipeline ni el scheduler. Esta fase hizo lecturas PostgREST, pruebas offline con proveedores simulados y cambios locales. No hubo escrituras remotas, llamadas a proveedores, acciones de review ni publicaciones.

El segundo evento iniciado por 12F.6 corresponde al intento persistido `f7baede0-d577-47f3-a44f-4d245c62b81d`, evento `event-bda67b3aabf3cac48b2e24931e7f83b0`, pipeline run `127144dc-25c2-46a8-b2af-e00a4c564cb0`. Su `attempt_number=1` es el contador de ese evento; “intento #2” se refiere al segundo evento procesado en el ciclo. No se materializó `events.id` para ese evento. La fila terminó como `TECHNICAL_FAILURE`, `stop_stage=critic`, `stop_reason=unknown`, `retry_class=TECHNICAL_FAILURE`, contó para el límite y no tiene review asociada. La última etapa completada fue Critic; la petición de crear la review falló después.

## Reconstrucción de Critic

- **Dispatch y respuesta:** sí. La fila de `agent_runs` está `succeeded`; sus logs registran reserva, intento, liquidación de tokens y `completed`. Hubo una petición Groq de Critic, sin retry: 2.585 tokens de entrada, 44 de salida, 2.629 en total.
- **Parse y esquema:** pasaron. La telemetría remota marca `zodValid=true`; el checkpoint se leyó con `readSafeCriticPipelineCheckpoint` y satisface el esquema.
- **Decisión semántica:** `pass`, severidad `low`, cero issues. El checkpoint Critic y el paquete local de human review contienen ese resultado y sus hashes verifican.
- **Persistencia:** sí. El checkpoint Critic se escribió y leyó antes de invocar la compuerta. `agent_runs.stats` también conserva `finalCriticResultValid=true`, `deterministicPrechecksPassed=true` y `finalDecision=pass`.
- **Salida cruda:** no está retenida durablemente. Los logs guardan telemetría y métricas, no el texto bruto del modelo. El resultado parseado y validado sí está retenido.

## Causa primaria

**`HUMAN_REVIEW_GATE_CONTRACT_BUG`.** La función `assert_pipeline_human_review_evidence` de migration 31 cuenta filas de Critic cuando encuentra los tres campos bajo `agent_runs.stats.telemetry`. El productor actual los persistió en el nivel raíz de `agent_runs.stats`; dentro de `stats.telemetry` solo estaban los datos generales de telemetría. La consulta encontró cero filas elegibles y la función lanzó `human_review_critic_pass_not_proven` (`P0001` definido por esa función). La review pre-RPC ya estaba construida localmente con Critic PASS, pero no se creó una fila remota.

El orden de persistencia no fue la causa: `agent_runs` finalizó, Critic escribió/leyó su checkpoint y luego se invocó la compuerta. No fue un PASS únicamente en memoria ni un rechazo semántico.

Había además una brecha de identidad: la fila Critic histórica no llevaba `config.attemptId`, y la prueba SQL de M31 solo unía Critic por evento y pipeline run. La review sí estaba ligada a un attempt, pero la prueba del Critic no. Esto no cambia la causa inmediata del error; sí impide considerar completa la prueba de lineage entre Critic y attempt.

## Contrato forward y migración

El camino forward ahora exige:

1. Critic termina con resultado válido, prechecks deterministas pasados y decisión semántica `pass`.
2. El registro del agente conserva esa prueba bajo `stats.telemetry`, además de los diagnósticos existentes en `stats`.
3. La ejecución propaga el `attemptId` dueño a Critic y lo incluye en `agent_runs.config` y en el checkpoint atómico.
4. Antes de materializar la review, el código vuelve a leer el checkpoint Critic con el parser seguro y comprueba decisión, `eventKey` y `attemptId`. El resultado del payload debe coincidir con el checkpoint durable.
5. La identidad de checkpoint de la review incluye `pipelineRunId:attemptId:stage:eventKey`.
6. La nueva migration 34 añade una validación `BEFORE INSERT` que exige exactamente una prueba Critic exitosa con el mismo evento, run e intento, y la misma identidad en el manifest. No cambia enums ni debilita la idempotencia de M31 (`UNIQUE(attempt_id)` y `ON CONFLICT DO NOTHING`).

**Migration 34 es necesaria para cerrar la unión SQL al intento.** Se creó localmente en `supabase/migrations/20261012120000_human_review_critic_attempt_proof.sql`, pero no se aplicó en remoto: la fase prohíbe escrituras remotas. Por tanto, el proyecto local pasa las pruebas, pero el gate remoto no tiene aún el contrato nuevo ni el código desplegado.

## Pruebas de seguridad y semántica

- Una prueba en proceso hijo reconstruye el paquete de review tras descartar el contexto Critic en memoria; obtiene PASS leyendo el checkpoint durable con la identidad del intento correcto.
- Un checkpoint de otro intento, sin PASS durable, una discrepancia entre resultado en memoria y checkpoint, o un fallo de persistencia impiden llegar a la compuerta.
- Crear de nuevo una review con el mismo attempt resuelve a la misma review; el contrato SQL mantiene una sola fila por `attempt_id`.
- `Critic REJECT` permanece como rechazo seguro y no crea review. Puede continuar según la política multi-attempt existente.
- Error runtime o salida Critic con esquema inválido permanece técnico y detiene el ciclo antes del siguiente candidato. PASS en el segundo intento llega a `WAITING_FOR_HUMAN_REVIEW` y detiene la secuencia.
- Las pruebas de finalización cubren rechazo semántico, fallo técnico y espera de review, con un finalizador de scheduler por ejecución y sin enum nuevo.

## Estado remoto de solo lectura

Captura final: `2026-10-12T12:29:17.530Z`.

- Attempts reales: 14; active/deferred/stuck: `0/0/0`.
- Reviews/WAITING: `0/0`; M32 status y list: PASS.
- Artículos públicos: 2. IDs y fingerprints siguen iguales al baseline: `6203559f-413a-4f06-9346-1720bbeb0e7a` → `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`; `7415c685-04ed-4956-a77a-4bc372c9b060` → `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`.
- Astra sigue `archived`; unknown reservations: `0`.
- La fila scheduler histórica `97a658d0-9614-4055-b3d7-3aef253d1145` sigue `failed`, `final_decision=failed`, `pipeline_run_id=127144dc-25c2-46a8-b2af-e00a4c564cb0`, dos eventos intentados, nueve requests y lease `released`.
- Contabilidad del día refleja la ejecución previa 12F.6: Groq 9 requests / 17.670 tokens; Cloudflare y Cerebras 0. El delta atribuible a 12F.6B es 0.

## Lint generado

`.netlify/**` es salida generada e ignorada por Git. Se añadió únicamente a `globalIgnores` de ESLint; no se excluyó código fuente. El comando normal `npm run lint` pasó.

## Verificación y readiness

Pasaron: Critic unit/schema/checkpoints; pipeline y human-review; prueba fresh-process; contratos M31/M32/M34; multi-attempt y scheduler; provider accounting/reservations; capacidad/resume M33; regresiones Editor; lint normal; `npx tsc --noEmit`; `npm run build`; `git diff --check`; auditoría de secretos (749 archivos, 0 findings, `.env.local` ignorado).

El build emitió solo el aviso existente de que `NEXT_PUBLIC_SITE_URL` falta y la metadata de indexación queda desactivada.

**READY FOR NEXT UTC RUN: NO.** M34 todavía no se aplicó en remoto y el cambio de aplicación aún no está desplegado. Mantener el scheduler detenido para nuevas ejecuciones supervisadas hasta aplicar/desplegar el contrato; no se ejecutó otra prueba real en esta fase.
