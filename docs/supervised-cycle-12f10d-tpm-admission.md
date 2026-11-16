# 12F.10D — Unified Groq TPM Admission

## Outcome

**Root cause classification: `MULTIPLE_PROVEN_CAUSES`.** Normal first-stage admission and later-stage admission used different policies. The later-stage path treated missing TPM remaining tokens as a hard error, and its event-scoped header lookup discarded observation time and could select the most recent failed, non-dispatched stage. The normal first-stage path already treated absent or stale external capacity as unknown and continued to the atomic local ledger.

The shared runtime policy now handles every Groq request the same way. Durable local accounting is checked atomically first. A fresh provider header may defer a request when it proves insufficient headroom. An absent, stale, or headerless response stays explicitly unknown and does not invent remaining TPM or block admission by itself.

Provider calls: **0**. Real pipeline runs: **0**. Scheduler runs: **0**. Remote writes: **0**. Migration: **not required**.

## Exact 12F.10C Failure Path

`runStructuredAgent()` previously used two branches:

1. Verifier ran `decideGroqFirstStageCapacity()`. It checked the static request bound and used a fresh persisted header only when one existed. Missing or stale external state proceeded to the atomic local reservation.
2. Later stages loaded `getLatestProviderRateLimitTelemetry("groq", eventKey)` and called `decideGroqTpmPacing()`. This lookup returned telemetry without its observation timestamp. The pacing helper converted absent `tokenRemainingMinute` into `BLOCKED_TPM_RESET_UNKNOWN`, which `agent-runner.ts` mapped to `GROQ_TPM_STATE_UNKNOWN` and a technical failure.

At 12F.10C's Editor start, `2026-10-16T09:42:59.942Z`, the latest dispatched Groq response in the whole account was Translator at `2026-10-16T08:04:05.994Z`. It carried 3,654 remaining TPM and a 32.595-second reset. It was 5,934 seconds old, so it could not establish current external headroom. A newer initial Editor run had made no dispatch and had no headers. The old event-scoped lookup selected that no-dispatch run and returned null remaining TPM; the later-stage branch stopped on it.

## Normal and Resume Decision Trace

| Case | Local RPM | Local TPM | Local RPD / TPD | Header source | Admission |
| --- | --- | --- | --- | --- | --- |
| Fresh normal, first request | No separate rolling RPM ledger is read by M35/M36; supervised concurrency remains 1 and the attempt cap remains 18 | M36 atomic reservation returns known zero, known usage, proven shortage, or unknown | M25/M36 atomic reservation checks daily request and token usage | Latest dispatched provider response, if any | Same shared contract |
| Fresh normal, later request | Same | Same | Same | In-memory response for the current agent retry, otherwise persisted latest dispatched response | Same shared contract |
| Fresh-process resume, first resumed request | Same | Durable ledger is re-read; no process-local ledger is trusted | Same | Persisted provider-wide response with `finished_at`, if any | Same shared contract; missing memory is not a block |
| Continued resume, later request | Same | Same | Same | Latest dispatched response in memory, otherwise persisted snapshot | Same shared contract |

Admission no longer branches on stage index or resume mode. RPM, TPM, RPD, and TPD decision paths do not diverge between normal and resumed execution. RPM has no separate rolling local counter in the existing M35/M36 reservation RPC; this phase preserves the existing concurrency limit of 1 and supervised 18-request cap without adding an RPM subsystem.

## Local and External Unknown States

- `LOCAL_USAGE_UNKNOWN`: the durable accounting read failed, returned malformed or incomplete data, or found a relevant unknown reservation. The runtime returns `cost_guard_violation` before dispatch.
- `LOCAL_WINDOW_KNOWN_ZERO`: M36 successfully evaluated the current rolling 60-second window and found no applicable token rows.
- `LOCAL_WINDOW_KNOWN_USAGE`: M36 found valid applicable local token reservations and returned their sum.
- `LOCAL_WINDOW_PROVEN_INSUFFICIENT`: the atomic local TPM check proves that the request plus the 128-token margin does not fit. The runtime returns `PROVIDER_CAPACITY_EXHAUSTED` before dispatch.
- `HEADER_ABSENT`: no provider observation is available. Continue to local reservation and dispatch if local accounting allows.
- `HEADER_STALE`: invalid, future, older than 15 seconds, or past its reported reset window. Ignore its remaining count and fall back to the local/bootstrap contract.
- `EXTERNAL_REMAINING_UNKNOWN`: a fresh response was persisted but did not provide a valid token remaining value. Do not fabricate a number; continue if local accounting allows.
- A fresh header with a valid remaining value below estimate plus margin proves external temporary shortage and returns `PROVIDER_CAPACITY_EXHAUSTED` before dispatch.

These states are not collapsed into `TPM_STATE_UNKNOWN`.

## Header Lifetime

The model provider parses Groq's allowlisted rate-limit headers and stores normalized telemetry in `agent_runs.stats.telemetry`. The database `agent_runs.finished_at` is the persisted observation timestamp. The latest snapshot reader now selects the latest **dispatched** Groq response, including a response with no TPM header, and returns its observation time. This prevents a newer failed, non-dispatched run from masking the latest provider response and prevents an old remaining value from being treated as current.

The in-memory snapshot is refreshed only after a dispatched provider response. It is used for later retries in that agent run. A new process uses the persisted snapshot. Both go through the same 15-second/reset freshness policy.

## 12F.10C Rolling TPM State

The remote read-only ledger reconstruction used the resumed Editor start time, not the daily token total. The durable M36 window model evaluated all provider reservation rows and their linked runs at `2026-10-16T09:42:59.942Z`:

- Current local 60-second TPM state: **`KNOWN_ZERO`, 0 tokens**.
- Included current-window rows: **0**.
- Completed legacy rows excluded by the existing M36 terminal-age predicate: **46**.
- Unknown current-window reservations: **0**.
- Same-day Groq accounting: 2 reservations, 2 dispatches, 4,874 cumulative tokens.

The 4,874 daily cumulative tokens were outside the current minute window and do not imply TPM exhaustion. The Editor request estimate was 4,448; estimate plus margin was 4,576, below the 8,000 hard TPM bound. External remaining TPM at that time was unknown because the latest dispatched header was stale. Under the corrected contract, the local decision was admissible.

## Unified Admission Contract

1. Check intrinsic request size, including the 128-token margin. Oversize requests fail before reservation or dispatch.
2. Make the existing durable atomic Groq reservation. M36 evaluates the rolling local TPM window and unknown holds; its M25 call evaluates daily RPD/TPD limits. Read/query errors and malformed results fail technically.
3. If local accounting proves insufficient, stop as `PROVIDER_CAPACITY_EXHAUSTED`; if it is unknown, stop technically.
4. Evaluate the latest provider header only after local accounting passes. Fresh insufficiency releases the undispatched reservation before returning `PROVIDER_CAPACITY_EXHAUSTED`.
5. Dispatch when local accounting permits and the header is absent, stale, unknown, or sufficient.

The local reservation remains authoritative and atomic. The external header gate is additional evidence only. No provider probe request is introduced, no hard bound is relaxed, and no migration is needed.

## Normal / Resume Invariant

Deterministic tests replay identical local accounting and header states through first-stage, later-stage, fresh-process-resume, and continued-resume stage positions. `NORMAL_ADMISSION == RESUME_ADMISSION` passes for RPM, TPM, RPD, and TPD. The exact 12F.10C fixture (estimate 4,448, margin 128, complete local known-zero minute, no fresh header) reaches local reservation rather than `TPM_REMAINING_UNKNOWN`.

## Provider-Side 429

A local fake provider returns one synthetic 429 after dispatch. The dispatch marker and request count remain true/1, retries remain 0, and fallback remains 0. The provider rate-limit outcome is preserved. Actual token usage remains unknown unless returned; the conservative reservation estimate stays in the ledger. No real provider call was made.

## Historical Attempt Semantics

**`historicalSemanticAccuracy: NO` under the corrected contract.** The deployed code produced the recorded technical failure, but at the exact resume time M36's local TPM window was known zero, the request fit the hard limit, and no fresh external header existed. Those conditions should not have produced `GROQ_TPM_STATE_UNKNOWN`.

The historical attempt remains terminal and unchanged: `TECHNICAL_FAILURE`, Editor, `GROQ_TPM_STATE_UNKNOWN`, `counts_toward_retry_limit=true`. It was not reopened or rewritten.

## Remote Read-Only Baseline

Read-only server-side/PostgREST checks confirmed:

- attempts: 18; active/deferred/stuck: 0/0/0;
- reviews / `WAITING_FOR_HUMAN_REVIEW`: 0/0; M32 status/list/inspect passed;
- public articles: 2; fingerprints: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64` and `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`;
- Astra: archived;
- unknown current-day Groq reservations: 0;
- historical attempt: terminal with the recorded values above;
- scheduler row `4b0a02dd-e0b7-46ea-a21f-ac9fac7b7c00`: SHA-256 still `270104a4ff9472902e5397c49a7b792b2517efe0d8e463c2884306b8221cf171`.

The read-only calls were guarded to permit only Supabase GET/HEAD and the three M32 read RPCs. Provider calls: 0; remote writes: 0.

## Migration Decision

**`MIGRATION_REQUIRED: NO`.** Existing M36 atomically evaluates local rolling TPM and delegates daily RPD/TPD reservation to M25. The defect was the application later-stage header policy, so no schema or ACL change was needed.

## Files Changed

- `lib/agents/runtime/agent-runner.ts`
- `lib/agents/runtime/groq-capacity-pacing.ts`
- `lib/agents/runtime/agent-logger.ts`
- `lib/agents/runtime/runtime-types.ts`
- `scripts/groq-unified-admission-12f10d-unit-test.mjs`
- `scripts/groq-token-budget-unit-test.mjs`
- `scripts/groq-tpm-bootstrap-unit-test.mjs`
- `scripts/groq-full-path-capacity-unit-test.mjs`
- `docs/supervised-cycle-12f10d-tpm-admission.md`
- `artifacts/supervised-cycle-12f10d-tpm-admission.json`

## Tests and Verification

Passed offline: unified 12F.10D admission matrix; Groq token budget; Groq TPM bootstrap; Groq full-path checks; M33 lifecycle; M35 first-stage/resume; M36 window accounting; M36 token-budget migration; provider-capacity migration; capacity resume generation; fresh-process checkpoints; Editor resume; Verifier compaction; Editor grounding; Classifier; Ranker; Critic; M32 read path; M34 Critic proof; supervised throughput; scheduler finalization; selector diagnostic adapter; provider accounting; Groq capacity; runtime telemetry.

Passed: `npm run lint`, `npx tsc --noEmit`, `npm run build`, `git diff --check`, and `node scripts/safe-secret-audit.mjs`. The build completed with the existing warning that `NEXT_PUBLIC_SITE_URL` is missing or invalid, so indexing metadata is disabled.

Provider calls: **0**. Pipeline runs: **0**. Scheduler runs: **0**. Remote writes: **0**.

## Readiness

**`READY FOR NEXT UTC RUN: YES`.** Normal and resume admission are unified; local and external unknown states are distinct; fresh and stale header behavior is explicit; M33/M35/M36 and stage regressions pass; historical remote rows and public fingerprints remain unchanged; no migration or remote mutation was performed. No real supervised run was started in this phase.
