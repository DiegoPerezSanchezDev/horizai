# 12F.12 — Supervised cycle, 2026-10-17 UTC

Final classification: **DEFERRED_PROVIDER_CAPACITY**. Exactly one invocation of `npm.cmd run pipeline:supervised:run -- --execute-supervised` consumed `supervised-candidates:2026-10-17`. No second invocation or resume was performed.

## Gates and baseline

All 38 focused required suites, lint, TypeScript, build, diff check and secret audit passed. The permitted local build warning concerns NEXT_PUBLIC_SITE_URL. The known stale migration31 inventory fixture was not repeated. No runtime implementation or migration was changed.

The read-only preflight passed: head 20261015120000; M32/M34/M35/M36 and ACLs valid; attempts 18; active/deferred/stuck 0/0/0; reviews/WAITING 0/0; public 2; Astra archived; unknown reservations 0; public fingerprints matched 12F.10D. The consumed historical attempt and scheduler remained unchanged. The direct database read path required the configured direct URL and had no temporary-login fallback.

## Discovery, extraction and attempt

Discovery returned 33 candidates and inserted 33 raw items. Extraction selected 6, updated their six raw items and recorded six terminal EXTRACTION_SUCCEEDED outcomes (zero missing outcomes, parser/fetch failures or persistence errors). Production clustering produced 6 events. One event was admitted and attempted; the daily execution stopped before another candidate.

Attempt: `4658d5c0-857c-4ed5-b97f-afb133b2bf22`.

Event key: `event-5c7d0ef5ea6f72bec96704aded750851`.

Pipeline run: `f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d`.

Verifier and Translator succeeded and wrote valid durable checkpoints. Editor stopped before dispatch with PROVIDER_CAPACITY_EXHAUSTED, specific admission reason GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED. Classifier, Ranker and Critic were not run. There were no semantic rejections, no Critic PASS, no review and no Publisher execution. Attempts 2 and 3 were not started.

## Proven capacity and durable M33 state

The local rolling window held 3,783 settled tokens. Editor required an estimate of 4,770 plus the existing 128-token margin: 3,783 + 4,770 + 128 = 8,681, above the 8,000 TPM limit. The input itself was within the single-request limit. No Editor reservation was created and no Editor request was dispatched.

The same attempt remains deferred at Editor, generation 0, retry_class NONE and counts_toward_retry_limit false. The remote snapshot equals the local parsed snapshot. Verifier and Translator checkpoint hashes match the durable manifest. No resume or retry was executed.

Verifier's prior external header was stale; complete local KNOWN_ZERO accounting correctly admitted its request. Translator used complete local usage and a fresh sufficient header. No unknown external remaining amount was invented. The Editor stop was caused by proven local capacity; no provider-side 429 occurred.

## Accounting and scheduler

This cycle: Groq reservations 2, dispatches 2, input 2,879 tokens, output 904, total 3,783. Both reservations are settled. Unknown reservations, pre-dispatch releases, Cloudflare calls, Cerebras calls, retries and fallback are all 0. There was one denied Editor reservation and one capacity defer.

Scheduler row `88f3b0a4-b764-4e1d-a929-2ee093e8aa7c` finalized with status blocked, final decision blocked, reason PROVIDER_CAPACITY_EXHAUSTED and released lease. Runtime decision STOPPED_CAPACITY is persisted using the existing BLOCKED_PROVIDER_RATE_LIMIT decision value; this did not represent a provider HTTP 429. The row preserves the pipeline ID, one attempt, two requests and all known input/output/total tokens in event_final_states.

## Post-run state and readiness

Read-only reconciliation passed: attempts 19; active/deferred/stuck 0/1/0; reviews/WAITING 0/0; public 2; Astra archived; unknown reservations 0. All pre-existing article, attempt, agent-log, agent-run and scheduler-row hashes remained unchanged. Public fingerprints remain:

- 6203559f-413a-4f06-9346-1720bbeb0e7a: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`.
- 7415c685-04ed-4956-a77a-4bc372c9b060: `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`.

M32 status/list/inspect all passed; inspect found no review. Same-attempt M34 Critic proof is not applicable because Critic was not run. No approve/hold/reject, publication, deploy or migration occurred.

**READY FOR NEXT STEP: YES, for a separately supervised resume of the same attempt from Editor. Human review is not yet available.** This phase stops here.

The complete structured evidence index is `artifacts/supervised-cycle-12f12.json`; source article bodies and secrets are excluded.
