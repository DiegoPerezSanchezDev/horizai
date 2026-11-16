# 12F.8A — Verifier TPM / cost guard diagnosis

## Scope and result

This diagnosis uses the persisted 12F.8 attempt and read-only remote state. It made no pipeline run, provider call, migration, or remote write. The forward fix bounds the Verifier request before accounting or provider dispatch and compacts only complete evidence sentences. The phase is **not ready for another UTC run**: migration 33 does not support same-attempt resume when the pre-dispatch capacity stop is at Verifier.

## Historical attempt

- Attempt: `a14bfb1b-9d26-4874-8f96-560a154ac94d`
- Event: `event-e47962db9b38821484a076ec5c6e05ec`
- Pipeline run: `262c2b0e-11a4-421a-9d58-805677b222be`
- Agent run: `af6d3492-ab46-44ff-95ee-d89ac9921aeb`
- Scheduler run: `1b605690-34fe-49bf-98e4-3952d1f42a9d`
- Persisted terminal state: `TECHNICAL_FAILURE`, stage `verifier`, reason `cost_guard_violation`; it counted toward the retry limit.
- Verifier telemetry records `RUNTIME_ERROR`, `providerRequestsUsed=0`, `providerRequestDispatched=false`, null usage and request-byte fields, and no response headers. The error says the Groq stage estimate exceeds the TPM limit and safety margin.
- The scheduler trigger remains `supervised-candidates:2026-10-14`, with `cost_guard_violation`. The attempt and scheduler rows were left unchanged.

The historical terminal mapping was safe in that it did not dispatch, but it was semantically too broad: this deterministic candidate/request-size condition was counted as a technical failure. New oversized Verifier input is mapped to the typed safe rejection described below. Historical data was not rewritten.

## Estimate and evidence limits

The recorded stage estimate is **9,883 tokens**, above the configured hard TPM limit of **8,000** even before accounting for the 128-token safety margin. With the margin, the estimate is 10,011, or 2,011 over the hard limit. Configuration used `openai/gpt-oss-20b`, `maxOutputTokens=1,200`, and `tokenMinuteHardLimit=8,000`; no soft TPM limit was configured.

The existing deterministic estimator is `ceil((system instruction chars + serialized model-input chars + strict-schema chars) / 2) + 128`, then adds the configured output reservation. The historical estimate implies 8,683 estimated input tokens. With the current local prompt (3,064 chars) and strict schema (1,228 chars), that is consistent with a model-input JSON size of 12,817–12,818 chars. The prompt and schema were not independently hashed in the historical run, so this component split is an inference from current source and recorded totals, not a persisted historical request capture.

The raw source item associated with the trace had `textLength=20,067`, title “The US military’s race to make fake blood” (41 chars), excerpt length 136, 44 paragraphs, and 150 sentences. The stored body hash was `sha256:2a84961144418e1bbaa041e32f939144ff5cac800683995ff863076e463f0217`. The old input builder capped aggregate body content at 12,000 chars, but the persisted record does not establish the exact per-source body sent, source count, or exact historical serialized JSON. Do not infer that the full raw body was sent.

`remainingTPM` is **unknown**: the failed request had no provider response headers and was stopped before dispatch. Current event-scoped remaining capacity therefore cannot be reconstructed. However, waiting would not solve this recorded request’s failure: the static stage estimate plus safety margin exceeds the entire hard TPM allowance. This diagnosis classifies it as `REQUEST_INTRINSICALLY_TOO_LARGE` under the configured deterministic guard. The actual provider-token count is unknown because no request was sent. Historical telemetry for a different Verifier request (2026-09-22: 3,699 input tokens, 17,061 request bytes) shows the character estimator can be conservative, but it does not prove this request would fit.

## Forward Verifier request bound

For the 12F.8 configuration, an admissible request must satisfy the same estimator before any provider reservation:

- Output reservation: 1,200 tokens.
- Estimator input overhead: 128 tokens.
- Existing TPM safety margin: 128 tokens.
- Maximum estimated stage use before margin: 7,872 tokens.
- Maximum estimated input use: 6,672 tokens.
- Maximum combined prompt/input/schema characters: 13,088.
- With 3,064 system-instruction chars and 1,228 schema chars, maximum serialized Verifier JSON input: **8,796 chars**.

`maxGroqModelInputCharsForTpm` derives this cap from the configured hard TPM, output reservation, estimator overhead, and safety margin. The Verifier preserves the system prompt and schema and compacts the candidate evidence to fit the remaining serialized-input budget. It retains whole sentences, keeps each source represented by its lead evidence, prioritizes complete numeric/date sentences, then selects title-relevant and information-rich sentences in source-balanced rounds. Exact duplicate sentences are removed only within a source. It never cuts a sentence mid-way or deduplicates across sources. If mandatory complete evidence cannot fit, it throws `VERIFIER_INPUT_TOO_LARGE` before starting a provider run or reserving a request.

Compaction is required for large candidate evidence, but it is not a factuality check. Verifier remains responsible for evaluating facts when a bounded request is dispatched.

## Typed terminal and single-candidate behavior

The typed reason is `VERIFIER_INPUT_TOO_LARGE`. The pipeline maps it to `BLOCKED_REJECTED`; attempt reconciliation records `REJECTED`, `retryClass=REJECTED`, `countsTowardRetryLimit=false`, and no next retry time. Since the failure happens before the Verifier runner starts, provider requests, reservations, Translator, Editor, Classifier, Ranker, Critic, Publisher, and review rows are all zero for that candidate. In a supervised multi-candidate run, the policy may proceed to the next independently bounded candidate; the single-candidate policy test confirms it does not replace the rejected candidate. Existing attempt and request caps remain enforced.

## Capacity deferral limitation

Supervised mode now disables in-run TPM pacing waits. Migration 33’s supported resume stages are `editor`, `classifier`, `ranker`, and `critic`; its snapshot contains already completed Verifier and Translator checkpoints. Verifier itself is absent from the resume-stage contract. Also, the runtime treats Verifier as the first provider stage and does not load event-scoped rate-limit headers before that first-stage decision. Thus `remainingTPM` for this case is unavailable, and a Verifier request that fits the full hard limit but lacks current TPM headroom cannot presently be proven to defer and resume through M33 with the same attempt. The required temporary-capacity case is **not implemented or proven**. Adding that capability would require a broader persisted-resume/RPC contract; no migration or remote state change was made in this phase.

## Remote read-only baseline

The remote baseline was read using the application’s Supabase/PostgREST path and the M32 human-review status/list path. No write operation was issued.

- Attempts: 16 total; active/deferred/stuck: `0/0/0`.
- Human reviews / `WAITING_FOR_HUMAN_REVIEW`: `0/0`.
- Public articles: 2, unchanged.
- Article `6203559f-413a-4f06-9346-1720bbeb0e7a`: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`.
- Article `7415c685-04ed-4956-a77a-4bc372c9b060`: `728f67672214de59791a44e10e83359353f28f97b81d81e4750cf47c5894200b`.
- Astra article `756b0ee0-b5e6-4153-846f-278a12c9afe3`: archived.
- Provider reservation, dispatch, token, and unknown-reservation counts for 2026-10-14: all zero.
- M32 `status` and `list`: PASS, HTTP 200; no review rows.
- Historical attempt and scheduler rows: unchanged.

## Regression evidence

Offline fixtures passed for Verifier sentence compaction and no-dispatch overflow; Groq TPM calculation and capacity parsing; reservation and telemetry lifecycle; supervised safe rejection and single-candidate behavior; attempt reconciliation; M33 same-attempt capacity lifecycle; Editor, Critic, human-review M31/M32/M34 paths; scheduler execution, finalization, wiring, and policy; and freshness. These tests use mocks/fixtures and do not call providers or Supabase.

The M33 fixture explicitly verifies the supported resume-stage set. It documents the missing Verifier resume stage rather than treating downstream resume coverage as proof of Verifier deferral. Compaction fixtures prove structural safeguards (whole sentences, source diversity, exact numeric/date preservation, schema validity); they do not independently measure factuality across real provider outputs.

## Readiness

- Root cause under configured estimator: confirmed (`REQUEST_INTRINSICALLY_TOO_LARGE`).
- Bounded whole-sentence Verifier input and typed no-dispatch rejection: implemented and covered offline.
- Provider calls / remote writes in this phase: `0 / 0`.
- 12F.8 historical rows, public articles, reviews, and accounting: unchanged.
- Verifier temporary-capacity deferral/resume via M33: unsupported.
- **READY FOR NEXT UTC RUN: NO.** Do not start another real supervised cycle based on this closure. A separately scoped change to the durable Verifier resume contract is needed first.
