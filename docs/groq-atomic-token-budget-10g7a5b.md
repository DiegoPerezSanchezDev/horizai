# 10G.7a.5b — validación remota del presupuesto atómico Groq

## REMOTE BASELINE

- Proyecto remoto: **MATCH** — `skrthgpurquypgdwxast` (`horizai`).
- Migration 25: **ALREADY_APPLIED** antes de esta fase; no se reaplicó. Migration 26 no se creó.
- Periodo de cuota UTC: **2026-09-27**.
- Baseline: Groq requests `0`, tokens `0`, dispatched `0`; Cloudflare requests `0`, dispatched `0`, Neurons reservados `0`.
- Las lecturas de baseline usaron `SupabaseAgentLogger.getProviderDailyUsage` y conteos de `agent_logs` para el periodo UTC. El ledger tenía cero filas del día antes de iniciar fixtures.

## RPC SIGNATURES

Firmas verificadas en los metadatos PostgreSQL remotos:

- `public.reserve_groq_request_and_tokens(p_run_id uuid, p_agent_name text, p_agent_version text, p_event_key text, p_attempt integer, p_model text, p_request_date date, p_request_hard_limit integer, p_request_soft_limit integer, p_token_hard_limit bigint, p_token_soft_limit bigint, p_estimated_tokens bigint) returns jsonb`
- `public.settle_groq_token_usage(p_reservation_id bigint, p_run_id uuid, p_request_date date, p_actual_input_tokens bigint, p_actual_output_tokens bigint) returns jsonb`
- `public.mark_agent_request_dispatched(p_reservation_id bigint, p_run_id uuid, p_request_date date) returns boolean`
- `public.release_agent_request(p_reservation_id bigint, p_run_id uuid, p_request_date date) returns boolean`

## SECURITY

Las cuatro funciones son `SECURITY DEFINER`, tienen `search_path=pg_catalog, public, pg_temp` y conceden `EXECUTE` a `service_role`. `anon` y `authenticated` no tienen ejecución efectiva; `anon` fue comprobado con una llamada denegada y `authenticated` con los grants PostgreSQL verificados en la fase 10G.7a.5b.0.

## BASIC RESERVATION

La reserva sintética de 200 tokens pasó como una sola fila lógica. La cuenta Groq subió en una request y 200 tokens. `release_agent_request` la liberó antes del dispatch y devolvió ambos contadores al baseline.

## ATOMIC REJECTION

- Request proyectado por encima del límite y tokens dentro del límite: rechazo `GROQ_DAILY_REQUEST_HARD_LIMIT`; no se insertó ninguna reserva ni se contabilizó token parcialmente.
- Request dentro del límite y tokens proyectados por encima del límite: rechazo `GROQ_DAILY_TOKEN_SOFT_LIMIT`; no se insertó ninguna reserva ni se contabilizó request parcialmente.

Ambos escenarios pasaron (`PASS_NO_TOKEN_ROW` y `PASS_NO_REQUEST_ROW`).

## OWNERSHIP

El owner B no pudo liberar la reserva de A; la llamada devolvió `false` y la request y los 100 tokens permanecieron contabilizados. El owner A pudo liberarla y restauró el baseline. **PASS**.

## POSTGRES CONCURRENCY

Se enviaron dos llamadas RPC remotas concurrentes reales, cada una con estimación de 100 tokens. El límite dinámico permitía una reserva y rechazaba la segunda: **1 admitida, 1 rechazada** (`GROQ_DAILY_TOKEN_SOFT_LIMIT`). Nunca se admitieron ambas.

La dimensión de requests queda `COVERED_BY_SHARED_ATOMIC_LOCK_PATH`: la misma RPC lee y decide las dos capacidades bajo el advisory lock `horizai-agent-budget:groq:<UTC-date>`. La reserva admitida se liberó y el baseline volvió a cero.

## DISPATCH LIFECYCLE

El fixture sintético fue marcado con `mark_agent_request_dispatched`; no se envió HTTP. La request y los 200 tokens estimados siguieron contabilizados. La liberación pre-dispatch posterior devolvió `false` y no cambió el ledger: **BLOCKED_FALSE_NO_OP**.

## SETTLEMENT

- `reserved=200`, `actual=120`: la misma fila pasó a contabilizar 120 tokens; request permaneció en 1.
- Settlement idéntico repetido: `changed=false`, sin delta adicional; total 120.
- Settlement distinto (121): falló cerrado con `provider_token_settlement_conflict`; el total se mantuvo en 120.
- `reserved=100`, `actual=150`: pasó y contabilizó los 150 reales, sin truncar el aumento.
- `reserved=100`, `actual=100`: pasó y contabilizó 100.

Los cinco resultados esperados pasaron.

## UNKNOWN USAGE

Después del dispatch sintético sin settlement, el payload conservó `tokenUsageState=reserved_estimate` y `providerUnitUsageKnown=false`; siguieron contabilizados una request y los 100 tokens estimados. **PASS_ESTIMATE_RETAINED**.

## CANONICAL ACCOUNTING

La fuente canónica para las reservas nuevas es `agent_logs` con `step='provider_request_reserved'`, `provider='groq'`, `provider_unit='tokens'` y `provider_unit_amount`. Antes del settlement, `provider_unit_amount` contiene el estimado; después, la RPC lo actualiza en esa misma fila a `actual_input_tokens + actual_output_tokens`. No hay suma de estimación más valor real ni segunda fila de settlement.

La reserva calcula la suma diaria de `provider_unit_amount`; `SupabaseAgentLogger.getProviderDailyUsage('groq', dateUtc)` lee los mismos campos y, si la fila está `settled`, comprueba que `actualInputTokens + actualOutputTokens = actualTokens = provider_unit_amount`. El unknown legado se deriva de telemetría validada en `agent_runs.stats.telemetry`; si no es fiable, la reserva SQL falla cerrada. En esta ejecución, el baseline del día no contenía filas y todos los deltas temporales se observaron en el ledger sintético.

## UTC

Todas las reservas usaron el periodo actual `2026-09-27`; la RPC devolvió ese `quotaPeriodUtc`. No se falsificó reloj ni se esperó medianoche. **REMOTE_CROSS_UTC_BOUNDARY_NOT_EXERCISED**.

## CLEANUP

Namespace único de esta ejecución: `10g7a5b:664cbc19-5be4-446c-baf8-23341e53675b`. Se crearon 12 filas sintéticas `agent_runs` y 9 filas de reserva. El bloque `finally` buscó el namespace exacto, volvió a validar el tag de cada ejecución y eliminó únicamente sus filas `agent_logs` y `agent_runs`; esto limpió también las filas dispatch marcadas sintéticamente sin usar la RPC productiva de release. Resultado: **COMPLETE_ZERO_RESIDUAL_ROWS**, cero ejecuciones y cero reservas residuales con el namespace.

## CLOUDFLARE ISOLATION

Neurons reservados antes y después: `0`; delta: `0`. Requests y dispatches Cloudflare también permanecieron en `0`. No se creó ninguna reserva Cloudflare ni hubo llamada al proveedor.

## BASELINE RESTORATION

Después del cleanup, los snapshots completos del periodo UTC coincidieron con el baseline: filas de `agent_logs` `0`, filas de reserva `0`, Groq requests/tokens/dispatched `0/0/0` y Cloudflare requests/dispatched/Neurons `0/0/0`. `baselineRestored=true`.

Las filas históricas permanecieron intactas: no se aplicó ni reaplicó una migración en esta fase y todos los `UPDATE`/`DELETE` del validador se limitaron a las reservas sintéticas de los IDs de fixture verificados por namespace. No se tocaron `articles`, `events`, `raw_items`, `pipeline_event_attempts` ni `scheduler_runs`.

## LIMITATIONS

- El settlement cruzando medianoche no se ejercitó remotamente; queda cubierto por la lógica SQL y pruebas offline existentes.
- La denegación `authenticated` se confirmó por ACL PostgreSQL, no con un JWT de usuario; `anon` sí recibió una denegación RPC remota.
- Las advertencias de Node sobre type stripping y detección de módulos no impidieron la ejecución ni las verificaciones.

## NEXT STEP

**10G.7a.5b READY YES.** Regresar a `10G.7a.5 — GROQ CAPACITY POLICY + PACING IMPLEMENTATION`. No comenzar esa fase automáticamente.

## Regresiones offline

Pasaron 38 pruebas unitarias/simulaciones: presupuesto y capacidad Groq, pacing, presupuesto/router de proveedores, lifecycle, telemetry, Cloudflare capacity, cost policy, scheduler, pipeline/wiring/boundaries, Verifier, Translator, Editor, Classifier, Ranker, Critic, contracts y production gates. También pasaron `npm run lint`, `npx tsc --noEmit` y `npm run build`.
