# 12F.5B — Supervised daily throughput

## Purpose

This change lets one supervised UTC-day execution continue after a narrowly defined safe candidate rejection. The daily trigger remains `supervised-candidates:<YYYY-MM-DD>` and is acquired once. The change does not create one scheduler row per candidate and does not run a real pipeline.

## Old and new policy

| Policy | Before 12F.5B | 12F.5B |
| --- | --- | --- |
| Scheduler executions | One per UTC-day trigger | One per UTC-day trigger, unchanged |
| Discovery | Existing behavior | Unchanged |
| Extraction candidates selected | 3 | 6 |
| Event attempts in the execution | 1 | At most 3, sequentially |
| Concurrency | 1 | 1 |
| Provider requests | Existing provider limits | Hard run-scoped maximum of 18 |
| Retries / paid fallback | 0 / 0 | 0 / 0 |
| Publication | Disabled in supervised execution | Disabled; human review remains required |

The per-UTC-day candidate-admission limit remains three. It bounds attempts across the one daily trigger; it does not increase the number of triggers. Discovery behavior and extraction evidence-quality checks are unchanged. Each selected extraction candidate still produces typed observability for candidate ID, raw-item ID, fetch result, parser result, quality-gate result, and terminal extraction outcome.

## Continue and stop conditions

The orchestrator examines events in deterministic order and claims at most three attempts. It continues only after a typed safe rejection:

- extraction evidence insufficient;
- verifier rejection or insufficient verification;
- Editor grounding rejection;
- Critic `BLOCKED_REJECTED`.

Each event must have unique candidate ownership and event lineage before any attempt is claimed. A duplicate event key or candidate mapped to multiple selected events fails closed. Attempt IDs, source lineage, checkpoints, stage accounting, and terminal state remain attached to each individual event.

The first result that is not a safe rejection stops the execution. This includes the first `WAITING_FOR_HUMAN_REVIEW`, technical failure, `DEFERRED_PROVIDER_CAPACITY`, budget block, and unexpected error. Therefore no execution can create a second review after its first waiting review. A run with no remaining usable event completes without another scheduler invocation; the already-acquired UTC trigger remains consumed.

## Provider budget and pacing

The production supervised runner supplies a process-local hard cap of 18 provider request reservations. The cap counts reservations across UTC midnight, so a running process cannot obtain request 19 by crossing the daily ledger boundary. Normal persistent provider reservation and capacity checks still run before dispatch; the cap is an additional guard, not a replacement.

Only the configured Groq free-only route is accepted. Runner preflight rejects nonzero retries and paid fallback. Cloudflare remains disabled for this supervised route and Cerebras remains router-ineligible. Provider concurrency stays at one. Existing Groq header-driven pacing is allowed only for a reported token reset of at most 60 seconds. Unknown, unavailable, or longer pacing conditions stop with `PROVIDER_CAPACITY_EXHAUSTED`; no blind sleep or provider switch is added.

## Scheduler semantics

The runner constructs the same UTC trigger string and calls `scheduler.acquire` once. The lease allows at most three event attempts. There is still one terminal `finishExecution` call for the whole supervised execution.

The scheduler terminal payload keeps the existing `event_final_states` JSON array. It records each attempt ID, event key, final state, stop stage/reason, terminal class, request count, token counts when known, and whether a review was created. Run-level attempt/rejection/defer/review/request summaries are derived from that array and the existing run outcome. No schema change or migration is required.

Outcome precedence is deterministic: first waiting review; provider-capacity defer; budget block; all-attempts-safe-rejected completion; technical failure; then the existing not-verified, no-eligible-extracted-items, and generic completion outcomes. A safe rejection alone never becomes a technical failure. If all up to three attempts are safe rejections, the persisted scheduler decision uses the existing compatible `COMPLETED` value and the reason `ALL_CANDIDATES_SAFELY_REJECTED`.

## Tests and verification

`scripts/supervised-throughput-unit-test.mjs` uses synthetic stages, a mock provider telemetry object, an in-memory attempt registry, and temporary local checkpoints. It covers the six-candidate extraction cap, safe rejection continuation, first-waiting stop, technical/capacity/malformed-output stop, three-attempt maximum, no fourth attempt, concurrency one, unique attempt/event lineage, request 19 rejection across UTC midnight, one trigger identity/acquire source, token/request aggregation, and exactly-once scheduler finalization. Publisher is a throwing test stub and is never invoked.

Additional offline suites cover zero retries and fallback, provider cost/routing policy, Editor grounding, scheduler wiring/finalization, human-review lifecycle, migration 33 capacity resume, extraction observability, checkpoints, and secret scanning. All package scripts named `*:unit` passed after one isolated retry of `verifier:unit`; its first run hit a flaky timeout assertion, and the immediate rerun passed.

Verification results for this phase:

- Offline `*:unit` scripts: 70 passed (including the successful `verifier:unit` rerun).
- `npm run lint`: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS.
- `git diff --check`: recorded in the artifact.
- Secret audit: recorded in the artifact; output contains sanitized presence only.
- Provider calls, remote writes, scheduler runs, and real pipeline runs: 0.

## Readiness

**READY FOR 12F.6: YES.** This phase itself does not execute 12F.6, consume today's trigger, publish, or contact a provider.
