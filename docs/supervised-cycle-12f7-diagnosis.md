# 12F.7A — Critic revision semantics and scheduler terminal reason

**Captured:** 2026-10-13 UTC
**Provider calls:** 0
**Remote application-data writes:** 0
**Migrations:** none

## Diagnosis

The 12F.7 Critic returned the schema-valid decision `revise_editorial`. The Critic decision contract in `criticDecisionSchema` accepts that value. The live Critic execution and final result were valid; its semantic decision was not `pass`, so the supervised human-review gate correctly did not create a review.

The pipeline orchestrator turned that decision into `BLOCKED_REVISION_REQUIRED` at stage `critic`, with the same stop reason. Its revision summary recorded `revisionStarted: false`. `attemptOutcomeFromPipelineResult` preserved the attempt as `REVISION_REQUIRED`, `BLOCKED_REVISION_REQUIRED`, retry class `REVISION_REQUIRED`, and `counts_toward_retry_limit: false`.

Two forward-path defects followed:

1. `isSafelyRejectedSupervisedAttempt` did not recognize this exact semantic terminal, so the multi-candidate loop stopped before candidate two.
2. `supervisedSchedulerOutcome` treated the blocked result as a technical failure. Its reason selector searched only for event states `FAILED` or `BLOCKED`; it therefore missed `BLOCKED_REVISION_REQUIRED` and substituted `SUPERVISED_PIPELINE_FAILED`. The scheduler finalizer mapped `TECHNICAL_FAILURE` to persisted decision `FAILED`.

The historical rows were not changed. The mismatch is **SEMANTICALLY_INACCURATE**: valid Critic output and all six provider stages completed; the scheduler reported a generic technical failure despite the durable attempt carrying the semantic revision reason.

## Classification and continuation

For the observed contract, `revise_editorial` means Critic requests editorial remediation. In supervised mode automatic revision is disabled. The pipeline records that remediation is required, does not rerun Editor, does not retry the candidate, and does not create a human review because Critic did not return `pass`. It is a safe, non-publishable semantic terminal for this candidate, not a technical failure.

Continuation is enabled only for this exact tuple:

```text
finalState = BLOCKED_REVISION_REQUIRED
stopStage = critic
stopReason = BLOCKED_REVISION_REQUIRED
criticDecision = revise_editorial
```

The orchestrator may then move to the next distinct eligible candidate. The candidate is consumed safely; no attempt is retried and no remediation loop is introduced. Other failure, capacity, budget, malformed-output, and review states keep their existing stop behavior.

## Forward terminal behavior

| Candidate sequence | Daily result | Scheduler representation |
| --- | --- | --- |
| `revise_editorial` → Critic `pass` | `WAITING_FOR_HUMAN_REVIEW`; stop | coarse persisted `COMPLETED`, reason `WAITING_FOR_HUMAN_REVIEW`; per-attempt review lineage points only to candidate two |
| Three safe semantic rejections | successful safe exhaustion; stop at cap 3 | existing equivalent `COMPLETED` / `ALL_CANDIDATES_SAFELY_REJECTED`; each event retains its exact state and reason in `event_final_states` |
| `revise_editorial` → actual technical failure | `TECHNICAL_FAILURE`; stop | actual failing event's reason is preserved; no generic masking when a specific reason exists |
| `revise_editorial` → pre-dispatch capacity defer | `DEFERRED_PROVIDER_CAPACITY`; stop | `STOPPED_CAPACITY` / `PROVIDER_CAPACITY_EXHAUSTED` |

For the revision-only safe result, the scheduler's top-level outcome uses the existing aggregate equivalent `ALL_CANDIDATES_SAFELY_REJECTED`; `event_final_states` retains `BLOCKED_REVISION_REQUIRED` and `critic` for the specific attempt. The mapper no longer classifies that event as technical or persists `SUPERVISED_PIPELINE_FAILED`.

No database enum change is needed: the existing scheduler representation supports the coarse final outcome and the structured attempt-final-state payload stores the exact semantic terminal. Migration 34's Critic PASS proof remains mandatory and unchanged.

## Lineage, budgets, and safety

The daily pipeline run ID is intentionally shared to group the candidates in one scheduler run. Candidate attempts remain isolated by distinct attempt IDs and event keys. Critic calls in the regression fixture carry the matching attempt ID, event key, and daily run ID. Checkpoints are event-key scoped; the only review binding belongs to the second candidate's PASS attempt. Migration 34 separately binds review creation to the same `(pipeline_run_id, attempt_id, event_key)` Critic PASS proof, so candidate one's `revise_editorial` evidence cannot satisfy candidate two.

The synthetic regression verifies sequential concurrency 1, maximum 3 event attempts, no retries, no fallback, and one shared 18-request reservation budget. The first candidate consumes 6; the next candidate starts with 6 already reserved, leaving 12. Three full six-request revision outcomes stop at 18, and candidate four never starts. Provider requests in these tests are synthetic telemetry only; there were no provider calls.

No Publisher path is reached. Critic `revise_editorial` creates no review. Critic PASS still enters the existing same-attempt M34-gated review path.

## Read-only remote baseline

Captured after the local-only correction using the application server client and PostgREST GET/HEAD reads. M32 status/list were also read through the existing human-review commands. The historical 12F.7 attempt and scheduler row remain unchanged.

| Check | Read result |
| --- | --- |
| Real attempts | 15 |
| Active / deferred / stuck | 0 / 0 / 0 |
| Human reviews / WAITING | 0 / 0 |
| Public articles | 2; fingerprints unchanged |
| Astra | archived |
| Unknown provider reservations | 0 |
| M32 status/list | PASS; status totals 0 reviews and list empty |
| 12F.7 attempt | `REVISION_REQUIRED` / `BLOCKED_REVISION_REQUIRED`, unchanged |
| 12F.7 scheduler | `failed` / `FAILED` / `SUPERVISED_PIPELINE_FAILED`, unchanged |
| Provider accounting for 2026-10-13 | Groq 6 requests / 13,081 tokens / 0 unknown; Cloudflare 0; Cerebras 0 |

Unchanged public fingerprints:

- Article `6203559f-413a-4f06-9346-1720bbeb0e7a`: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`
- Article `7415c685-04ed-4956-a77a-4bc372c9b060`: `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`

The remote reads made no application-data writes. No review action, publication, scheduler mutation, pipeline execution, or historical mutation occurred in this phase.

## Files changed

- `lib/agents/pipeline/supervised-throughput-policy.ts` — exact safe-continuation predicate for the valid `revise_editorial` terminal.
- `lib/agents/pipeline/supervised-run-outcome.ts` — preserve a specific failure stop reason rather than masking it with a generic scheduler failure.
- `scripts/supervised-throughput-unit-test.mjs` — synthetic continuation, stop-case, lineage, review, and shared request-budget regressions.
- `scripts/supervised-finalization-unit-test.mjs` — scheduler finalization and per-attempt reason preservation regression.
- `docs/supervised-cycle-12f7-diagnosis.md` — this diagnosis.
- `artifacts/supervised-cycle-12f7-diagnosis.json` — machine-readable evidence.

## Verification

All requested offline suites passed: Critic; pipeline state, revision, semantics, scheduler mapping/wiring/execution, and attempts; supervised throughput/finalization/rejection; Editor; Verifier; M34 same-attempt proof; human-review gate; capacity resume and M33 lifecycle; runtime telemetry and Groq token budget; freshness/selection; snapshot executor; and secret-audit unit.

`npm run lint`, `npx tsc --noEmit`, `npm run build`, `git diff --check`, and the sanitized repository secret audit passed. The production build emitted its existing warning that `NEXT_PUBLIC_SITE_URL` is unset, so indexing metadata is disabled; compilation and build completed successfully. The actual secret audit found no credential patterns and confirmed `.env.local` is Git-ignored.

## Readiness

**READY FOR NEXT UTC RUN: YES.** The correction is local and fully covered by offline regression and build checks. The 2026-10-13 historical trigger remains untouched; no additional real run was started.
