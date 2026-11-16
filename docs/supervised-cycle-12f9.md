# 12F.9 — Real Supervised Cycle

## Outcome

**TECHNICAL_FAILURE** at Verifier before provider dispatch:

```text
cost_guard_violation
Groq durable capacity state is unknown: GROQ_TPM_LOCAL_USAGE_UNKNOWN
```

Exactly one invocation ran:

```powershell
npm.cmd run pipeline:supervised:run -- --execute-supervised
```

The failure was not treated as a confirmed temporary TPM shortage, so it did not create a `DEFERRED_PROVIDER_CAPACITY` continuation. No retry or repair was attempted.

## Admission

The corrected 12F.8D read-only preflight, 31 focused offline suites, additional preflight fixture, lint, TypeScript, canonical build, diff check, and secret audit passed. Migration head was `20261014120000`; M35 was present and M32 status/list passed. Trigger `supervised-candidates:2026-10-15` was available. The baseline was attempts 16, active/deferred/stuck 0/0/0, reviews/WAITING 0/0, public 2, Astra archived, zero unknown reservations, and unchanged authoritative fingerprints.

## Execution

- Pipeline run: `f00f75f9-591e-4d29-b6f5-4d3c5b4b9ee0`
- Scheduler run: `7b630e27-784c-442f-9167-1a82d4412f9c`
- Start: `2026-10-15T19:40:19.093Z`
- Finish: `2026-10-15T19:40:41.507Z`
- Discovery: 59 candidates.
- Extraction: six selected; five successful, one blocked; five clusters.
- Event attempts: one of maximum three; attempts two and three not started.
- Request cap: 18; concurrency one; retries zero; paid fallback false.

The normal runner selected `event-874af2e5ec7f03b4f05cde0c1374f79c` from EL PAÍS Tecnología. Its exact source-item ID is `0afa63dc-7420-49b5-bd1e-ccbb2c6d7cb4:3579f6eba1120328b565714e821992b4`, and its raw item is `f4e2ab99-3a77-4581-a4ee-2cdea418f9e2`. No candidate was manually selected or substituted.

Attempt `8c67979e-b55c-40a4-a49e-db8f20ad39a0` passed the unchanged generic evidence admission gate. Verifier then failed before sending a model request. The durable attempt is completed as `TECHNICAL_FAILURE`, stop stage `verifier`, reason `cost_guard_violation`, retry class `TECHNICAL_FAILURE`, counted toward the current retry contract, next eligible timestamp `2026-10-16T00:00:00Z`. These fields were written by the normal runner; this phase made no subsequent reconciliation mutation.

Translator, Editor, Classifier, Ranker, Critic, and Publisher did not run. Critic PASS: no. Review: none. Intrinsic oversized-input count: zero. Capacity defer count: zero.

## Scheduler

Runtime decision: `TECHNICAL_FAILURE`; persisted scheduler decision: `FAILED`. Both run status and final decision are `failed`, with stop reason `cost_guard_violation`. The row has a finish timestamp and a released lease. The daily trigger is now occupied by this run and was not reset or bypassed.

## Accounting

For this run, durable accounting confirms:

| Counter | Value |
| --- | ---: |
| Reservations | 0 |
| Dispatched provider requests | 0 |
| Input / output / total tokens | 0 / 0 / 0 |
| Unknown reservations | 0 |
| Retries / fallback | 0 / 0 |
| Cloudflare / Cerebras calls | 0 / 0 |

The Verifier's telemetry contains null usage fields because no request was dispatched. Zero reservations and dispatches establish the zero provider delta. The runtime's unknown TPM state is a separate failure from an unknown dispatched reservation.

Normal discovery/run persistence created 59 raw items, updated the six extraction outcomes, recorded the new attempt and agent runs, and finalized the scheduler. There were no article or human-review writes.

## Post-run read-only verification

- Attempts: 17; active/deferred/stuck: 0/0/0.
- All 16 pre-existing attempt records: unchanged.
- M32 status/list: PASS; reviews/WAITING: 0/0.
- M32 inspect: not applicable, because no review exists.
- Public articles: 2; Astra remains archived.
- Article `6203559f-413a-4f06-9346-1720bbeb0e7a`: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`.
- Article `7415c685-04ed-4956-a77a-4bc372c9b060`: `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`.
- Fingerprints match the authoritative historical baseline using `publicArticleFingerprintV1`; the older 12F.8 artifact discrepancy was not rewritten.
- Publisher, automatic remediation, human actions, and deployment: not run.

**READY FOR NEXT STEP: NO.** Execution stopped on the technical failure. No second invocation occurred.
