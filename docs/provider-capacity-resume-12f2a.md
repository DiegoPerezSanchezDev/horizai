# 12F.2a — Provider capacity stop and same-attempt resume

**Resultado de la regresión sintética offline: PASS. El intento real de 12F.2: NOT READY. 12F.2a READY = NO.** No se llamó a proveedores ni se modificó el estado remoto durante esta fase.

## Audit of the 12F.2 capacity stop

The 12F.2 record identifies attempt `3ebda423-2aa6-4f3a-b119-53982fbf58d9`, run `543f00ff-6d68-4661-b170-b316e0d9b067`, event key `event-b528bc50495484add3d2544579f47846`. The recorded remote row ended as `TECHNICAL_FAILURE` at Classifier with `PROVIDER_CAPACITY_EXHAUSTED`, `retry_class=TECHNICAL_FAILURE`, and `counts_toward_retry_limit=true`.

`AgentRunner` stopped admission before dispatch: Groq TPM pacing required waiting, and the failure telemetry recorded `providerRequestDispatched=false` and zero Classifier requests. `attemptOutcomeFromPipelineResult()` had no capacity-specific case, so it fell through to the generic technical failure outcome and scheduled the next UTC period. The prior supervised runner also treated `SUCCESS_WITH_FAILURES` as scheduler `succeeded/allowed`, which described admission but obscured the pipeline stop. This phase maps a capacity stop to scheduler `STOPPED_CAPACITY` / `blocked` and records execution details through the existing `finishExecution` RPC.

The historical 12F.2 provider usage was 3 Groq requests / 5,387 settled tokens across Verifier, Translator, and Editor. That is prior-run usage, not usage from this phase. This phase's provider delta is zero.

## Canonical pre-dispatch capacity semantics

When an agent reports `PROVIDER_CAPACITY_EXHAUSTED` before dispatch and with zero requests, the current runner returns `DEFERRED_PROVIDER_CAPACITY`. The same attempt row remains open (`completed_at` and `final_state` null), with `stop_reason=PROVIDER_CAPACITY_EXHAUSTED`, `retry_class=NONE`, `counts_toward_retry_limit=false`, and no `next_eligible_at`. Ordinary discovery/retry eligibility returns `RESUME_REQUIRED`; it cannot create a replacement attempt for that event.

No database enum or migration is added. Resume ownership is acquired by a conditional update on the same attempt identity and released by a conditional update on that same row. A successful resume finalizes that same attempt. A second resume is rejected because the row is no longer an open capacity-deferred attempt. A repeated capacity stop releases the owned row back to the deferred state.

## Same-attempt resume evidence and stage

The only resume point implemented is Classifier, the first stage after successful Verifier, Translator, and Editor checkpoints. A versioned local snapshot stores the complete event, extracted items, source/raw-item lineage, Verifier result, Translation result, `EditorialDraft`, the three checkpoint identities and hashes, and settled provider telemetry. The snapshot is written after Editor and before Classifier dispatch.

Before claiming the attempt, the guard requires matching attempt/run/event identity; unchanged event and source/raw-item lineage; unchanged checkpoint hashes; no Classifier dispatch or checkpoint; settled upstream usage; no active owner; no terminal rejection; and an open, unfinalized capacity-deferred row. Ambiguous or changed evidence fails closed. The resume begins at Classifier and does not repeat Verifier, Translator, Editor, or Discovery. The supervised path can stop at `WAITING_FOR_HUMAN_REVIEW`; it does not call Publisher.

The resume API requires its caller to provide fresh current-state evidence. There is no new CLI or automatic scheduler for this path, and no automatic resume is enabled.

## Offline synthetic regression

`scripts/provider-capacity-resume-12f2a-unit-test.mjs` writes and reloads a synthetic snapshot, checks persisted checkpoint hashes, and exercises same-row resume using deterministic stage fixtures. The observed stage calls were Classifier, Geo, Ranker, and Critic; Verifier, Translator, Editor, Discovery, and Publisher were not called. Synthetic request count was zero. The test confirmed one attempt row remained, with the same attempt ID and attempt number, and finalized at `WAITING_FOR_HUMAN_REVIEW`. A second resume assessment was rejected.

Negative cases rejected changed checkpoints, source/raw lineage, event or attempt identity, ambiguous Classifier dispatch, an existing Classifier checkpoint, unsettled provider usage, an active owner, a terminal rejection, and an already-finalized row. Scheduler mapping for a capacity stop was `STOPPED_CAPACITY` / `blocked`, not `succeeded`.

## Migration 31 compatibility

The resume representation uses the existing attempt and scheduler fields, without adding a migration. The migration 31 human-review fixture suite and existing migration 29/30 fixture suites passed alongside the new offline resume regression. No migration was edited or applied in this phase; migration 32 was not created. The synthetic supervised flow reached the existing human-review boundary without invoking Publisher.

## Actual 12F.2 attempt readiness

The real 12F.2 attempt is **not resumable** under this contract. Its row is already terminal (`TECHNICAL_FAILURE`, with `completed_at` set), rather than an open capacity-deferred row. Also, the stored Editor checkpoint has Verifier and Translation data plus Editor inputs, but not the completed `EditorialDraft` output required to begin Classifier. Editor output appears only in remote run telemetry, which is not a reusable editorial checkpoint. Re-running Editor to reconstruct it would repeat a provider call, which this phase forbids.

The attempt therefore fails two independent guards: terminal attempt state and missing reusable Editor output. No change was made to the row, scheduler record, checkpoint, review, or articles. The historical scheduler row still reflects the 12F.2 `succeeded/allowed` discrepancy; this code change does not rewrite that historical record.

## Baseline and provider policy

The last read-only remote baseline recorded with 12F.2 had 2 public articles and these historical hashes:

| Article ID | Historical MD5 |
| --- | --- |
| `6203559f-413a-4f06-9346-1720bbeb0e7a` | `ccef966880d85663b8fd5049e9995f5f` |
| `7415c685-04ed-4956-a77a-4bc372c9b060` | `4cf1ecf2990a5dca582c95e5733a484f` |

Astra's last observed status was archived. The 12F.2 event had exactly one attempt and no human-review row; this phase executed no remote writes and added no attempt or review rows. A fresh post-test remote query was attempted but the command was rejected by the execution policy before it ran, so this phase cannot claim an independently refreshed remote snapshot. No provider credentials were used by test commands; provider request/token delta for this phase is zero.

## Verification

- Offline package suites: **68/68 PASS**; explicit migration fixtures 29 and 30: **PASS**; migration 31 fixture suite: **PASS**.
- New capacity-resume test: **PASS**; targeted ESLint: **PASS**.
- `npx.cmd tsc --noEmit --pretty false`: **PASS**.
- `npm.cmd run build`: **PASS**.
- Full `npm.cmd run lint`: **PASS**, no warnings after cleaning the new capacity fixture's unused parameter.
- `git diff --check`: **PASS**.
- Provider calls, real pipeline runs, article writes, review actions, Publisher, scheduler activation, and migration applications in this phase: **0**.

## Readiness and next step

The generic pre-dispatch stop and synthetic same-attempt resume mechanics pass offline regression, but the actual 12F.2 attempt cannot be safely resumed from available state. **12F.2a READY = NO.** Stop here; do not start 12F.2b or the next real supervised cycle from this phase.
