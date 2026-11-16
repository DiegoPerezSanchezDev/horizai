# 12F.3R — reconciliación terminal del intento real

**Fecha:** 2026-10-09\
**Resultado:** READY YES\
**Proveedor / pipeline / migration:** ninguno ejecutado; cero migraciones

## Alcance

Se cerró únicamente el intento real `dfada4fd-d9c6-4aa8-bfef-6d9447267e06`. No se reanudó Editor ni se intentó crear un snapshot de capacidad. No hubo Discovery, nuevo candidato o attempt, review, Publisher, publicación ni scheduler.

El informe previo [supervised-cycle-12f3-recovery.md](supervised-cycle-12f3-recovery.md) conserva la evidencia de la recuperación local y del estado remoto leído entonces. Esta fase lo complementa: en 12F.3R el intento que seguía abierto en aquella captura fue finalizado como `ABORTED`.

## Precheck y motivo

La lectura remota de solo lectura confirmó que el mismo attempt estaba activo, con `final_state=null`, `completed_at=null`, `stop_stage=null`, `stop_reason=null`, `retry_class=NONE`, `counts_toward_retry_limit=false`, `next_eligible_at=null` y sin snapshot de capacidad. El `pipeline_run_id` fue `3aa65ec9-448f-42ea-b53c-39bc24c70fb8`; el total era 11 attempts reales, con 0 reviews.

Los checkpoints de Verifier y Translator existen y pertenecen al mismo `eventKey`. Editor nunca despachó una solicitud: telemetry refleja `providerRequestDispatched=false` y `providerRequestsUsed=0`. Los checkpoints no incluyen el arreglo completo `items`, `rawItemId` ni un snapshot durable. Como M33 exige esa lineage, reconciliar a `DEFERRED_PROVIDER_CAPACITY` requeriría inventar hechos. La reconciliación por defer/resume permaneció insegura y no se hizo.

## Contrato del RPC terminal

Se revisó la definición de `public.finalize_pipeline_event_attempt(uuid, uuid, timestamptz, text, text, text, boolean, timestamptz)` en la migración de lifecycle y su reemplazo en migration 31. Es `SECURITY DEFINER`, fija `search_path = pg_catalog, public`, revoca ejecución a `PUBLIC`, `anon` y `authenticated`, y concede `EXECUTE` a `service_role`.

El RPC actualiza únicamente la fila con el `attempt_id` y `pipeline_run_id` dados, y exige `completed_at IS NULL`; si no encuentra una fila abierta, devuelve error. La constraint `pipeline_event_attempts_completed_consistency` exige que `completed_at` y `final_state` sean ambos nulos o ambos no nulos. Así, el compare-and-set del RPC solo puede finalizar una fila activa y rechaza un attempt terminal o una identidad distinta. La función cambia la fila existente: no crea otra ni modifica `attempt_number`.

Se invocó una sola vez con:

```text
p_attempt_id = dfada4fd-d9c6-4aa8-bfef-6d9447267e06
p_pipeline_run_id = 3aa65ec9-448f-42ea-b53c-39bc24c70fb8
p_final_state = ABORTED
p_stop_stage = editor
p_stop_reason = CAPACITY_RESUME_EVIDENCE_UNAVAILABLE
p_retry_class = NONE
p_counts_toward_retry_limit = false
p_next_eligible_at = null
```

El RPC respondió `finalized=true` con HTTP 200. `CAPACITY_RESUME_EVIDENCE_UNAVAILABLE` es una razón operativa tipada y no contiene secretos ni contenido editorial. No se hizo SQL manual ni `UPDATE` directo.

## Verificación posterior

La lectura fresca inmediatamente posterior confirmó:

- el mismo attempt en estado `ABORTED`, `completed_at` definido y `attempt_number=1`;
- `retry_class=NONE`, `counts_toward_retry_limit=false`, `next_eligible_at=null`;
- sin snapshot, defer ni claim ownership;
- 11 attempts reales en total, sin nuevos attempts; active/deferred/stuck: `0 / 0 / 0`;
- 0 reviews, 0 Publisher calls y delta de publicación 0;
- 2 artículos públicos, fingerprints sin cambio, Astra archivado;
- delta de contabilidad de proveedores: 0 requests, 0 tokens, 0 calls.

El ledger conserva los 2 requests Groq y 5.778 tokens del ciclo 12F.3 original. La fase 12F.3R no añadió consumo.

## Regresiones

- M33 lifecycle local: PASS.
- Provider capacity resume: PASS.
- Editor fresh-process capacity resume: PASS; cero llamadas de proveedor en la fixture.
- Human-review lifecycle unit: PASS.
- Fixtures de migrations 31 y 32: PASS.
- Guard de migration 33: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run lint`: PASS.
- `git diff --check`: PASS; Git solo mostró avisos de normalización LF/CRLF del árbol de trabajo.

El ejecutor `scripts/supervised-cycle-12f3-reconciliation.mjs` solo permite lecturas PostgREST y el RPC terminal exacto; bloquea cualquier segundo envío al endpoint terminal y deja un registro `wx` antes de llamar. El resultado detallado, precheck, respuesta HTTP y baseline posterior están en [supervised-cycle-12f3-reconciliation.json](../artifacts/supervised-cycle-12f3-reconciliation.json).

## Cierre

**12F.3R READY = YES.** El intento histórico quedó cerrado sin consumir reintentos. No se inició un nuevo ciclo supervisado. La siguiente fase autorizada deberá usar un nuevo ciclo real con el lifecycle M33 desde el principio.
