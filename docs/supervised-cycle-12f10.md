# 12F.10 — One real supervised cycle

## Closure

**Final classification: TECHNICAL_FAILURE. READY FOR NEXT STEP: NO.**

Exactly one invocation of `npm.cmd run pipeline:supervised:run -- --execute-supervised` ran for UTC day **2026-10-16**, trigger `supervised-candidates:2026-10-16`. It exited with code 1 and the precise error:

`EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023`

Verifier and Translator succeeded. Editor stopped on temporary TPM capacity before dispatch. The subsequent M35 defer persistence failed. The attempt remains active without a durable resume snapshot. No second candidate or second invocation was executed. No repair writes, migration, publication, human action, deployment, UI change, or production-code change was made in this phase.

## Local gates and remote preflight

All **41 focused offline suites passed**, including extraction observability, production selector diagnostic adapter, eligibility, Verifier compaction/oversize, Groq windows/bootstrap, M33/M35/M36, fresh-process resume, throughput caps, Editor grounding, Critic revision semantics/M34, M32, scheduler finalization, and CLI safety.

`npm.cmd run lint`, `npx.cmd tsc --noEmit`, `npm.cmd run build` using Webpack, `git diff --check`, and secret audit passed. The existing `NEXT_PUBLIC_SITE_URL` warning was accepted as specified. The new read-only audit helper also passed syntax and focused lint checks.

The UTC date was calculated using `new Date().toISOString().slice(0, 10)`. The trigger was free at `2026-10-16T08:03:04.228Z`. Read-only preflight confirmed:

- Attempts **17**; active/deferred/stuck **0/0/0**.
- Reviews/WAITING **0/0**; M32 status/list PASS.
- Public articles **2**; Astra archived; complete article-row hashes and public fingerprints unchanged.
- Unknown reservations **0** and zero current-day accounting for all three providers.
- Remote head **20261015120000**; M32/M34/M35/M36 present; RPC/security match the established M36 proof.
- All 46 legacy reservations remain present; none count as current pending under M36.
- Groq primary, all model stages `openai/gpt-oss-20b`, zero retries, no paid fallback, no in-run pacing wait.

## Discovery, extraction, and selector evidence

The production discovery/extraction/selector path was used. No candidate was selected manually or whitelisted.

The exception escaped before `PipelineRunResult` and its aggregate discovery/extraction summaries were returned or persisted. Exact discovery count, reused raw count, total extraction outcomes, and total eligible events are therefore **UNKNOWN** from retained evidence.

Read-only reconstruction found **20 newly inserted raw rows** with this pipeline's discovery timestamp and **2 freshly persisted successful extraction rows**. Those two rows were updated by extraction; neither has an error code. These are partial persisted observations. Processed reused rows are deliberately skipped by persistence, so they cannot establish the complete extraction totals for this invocation. The configured extraction cap remains **6**. Complete terminal-outcome coverage for every selected candidate cannot be claimed.

This outcome is a technical failure. It is not classified as benign zero eligible items. One eligible event was actually attempted; the total eligible set was not retained.

## Attempt and stages

| Identity | Value |
| --- | --- |
| Attempt ID | `16f922f2-0409-4c28-aadb-13fb5e489e7d` |
| Event key | `event-0d2cec33a9acdaff882291db5e686f6c` |
| Event ID | Not available; no matching persisted event row |
| Pipeline run ID | `4453d15d-1bcd-42dc-ba55-c060e1222aab` |
| Attempt number | 1 |
| Started | `2026-10-16T08:04:00.908+00:00` |
| Persisted terminal state/reason | Null/null; attempt remains open |

| Stage | Outcome | Dispatches | Input/output/total tokens |
| --- | --- | --- | --- |
| Verifier | SUCCESS, durable checkpoint | 1 | 2890 / 422 / 3312 |
| Translator | SUCCESS, durable checkpoint | 1 | 1195 / 367 / 1562 |
| Editor | PROVIDER_CAPACITY_EXHAUSTED before dispatch | 0 | N/A |
| Classifier / Ranker / Critic | NOT RUN | 0 | N/A |
| Publisher | NOT RUN | 0 | N/A |

Attempts 2 and 3 were not started. There were zero observed `VERIFIER_INPUT_TOO_LARGE`, `EDITOR_GROUNDING_REJECTED`, or `BLOCKED_REVISION_REQUIRED` outcomes. Critic PASS was not reached; M34 proof is N/A.

M36 bootstrap worked in the real request: Verifier logged `NO_FRESH_HEADER`, an estimate of **7871**, and successful local admission; adding the 128-token margin gives **7999**, within the 8000 bound. Both dispatched requests settled correctly.

## Capacity and precise failure

Translator's latest response reported remaining minute tokens **3654**. Editor required an estimated **4448**. Editor logged `GROQ_TPM_WAIT_REQUIRED`, reset **32.595 seconds**, and `stoppedWithoutWaiting=true`. No Editor provider request or remote reservation was created.

The local snapshot metadata shows generation 0 before Verifier, generation 1 before Translator, and generation **2** before Editor. The initial M35 defer contract requires `resumeGeneration=0` when no resume owner is supplied. The saved Editor snapshot therefore conflicts with that guard. The source increments generation while preparing successive stage snapshots, even during this initial uninterrupted attempt.

The confirmed runtime failure is SQLSTATE **22023**, wrapped as `EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023`. The repository wrapper retained the code but discarded PostgreSQL's message; the exact internal exception message is not claimed. The generation incompatibility is independently visible in the saved snapshot and unchanged M35 contract.

The `PROVIDER_CAPACITY_DEFERRED` log was emitted before the failing persistence RPC. That log alone does not establish a durable deferred attempt. Remote inspection confirms no capacity snapshot, stop stage, or stop reason was persisted. Durable defers: **0**. Failed defer persistence: **1**.

## Scheduler and lifecycle discrepancies

| Field | Observed value |
| --- | --- |
| Scheduler ID | `4b0a02dd-e0b7-46ea-a21f-ac9fac7b7c00` |
| Rows for trigger | 1 |
| Run status / final decision | failed / failed |
| Scheduler decision | FAILED |
| Stored reason | SUPERVISED_EXECUTION_FAILED |
| Pipeline lineage | Correctly preserved |
| Finished / released | `08:04:07.312Z` / `08:04:07.419Z` |
| Lease | released |

One canonical execution followed the tested exactly-once finalization path and produced one finished scheduler row. The specific failure reason was lost in the scheduler's generic exception branch. Stored counters report **0 attempts / 0 requests**, while the attempt registry and settled ledger prove **1 attempt / 2 requests**. Those persisted values remain unchanged; the report preserves the accurate figures separately.

The attempt is still active. Parent agent run `7f4d5f41-c957-42e1-b8d0-0fa991c0aca5` also remains `running` in the database with no finish timestamp. The local canonical process has exited. These lifecycle residues make the operational baseline unsuitable for another run. No automatic reconciliation was performed.

## Accounting, review, and public baseline

This execution's current-day baseline was zero. Historical agent-run/log/attempt/scheduler rows remain byte-comparable by canonical row hashes.

| Metric | This execution |
| --- | --- |
| Groq reservations / dispatched | **2 / 2** |
| Input / output / total tokens | **4085 / 789 / 4874** |
| Pre-dispatch reservation releases | 0 |
| Capacity stops / durable defers / failed defer persistence | 1 / 0 / 1 |
| Unknown reservations | **0** |
| Retries / fallback | **0 / 0** |
| Cloudflare / Cerebras calls | **0 / 0** |

Both reservations are settled; no accounting reservation leak was found. The two Groq calls used the configured free primary model. There was no provider-side 429.

Post-run read-only state:

- Attempts **18**; active/deferred/stuck **1/0/0** at capture.
- Reviews/WAITING **0/0**; no review ID; M32 status/list **PASS**, inspect **N/A**.
- Public articles **2**; Astra **ARCHIVED**; all article rows unchanged.
- Public fingerprints unchanged under `publicArticleFingerprintV1`:
  - `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`
  - `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`
- Historical 12F.9, its consumed October 15 trigger, and historical reservations remain unchanged.
- Publisher **NOT RUN**; no article writes, publication, or human actions.

## Evidence and stop

`artifacts/supervised-cycle-12f10.json` contains the final report. Supporting files record local gates, trigger availability, invocation guard, before/after baseline, exact exit error, and read-only reconstruction. They contain no credentials or full source bodies. Checkpoints remain available for a future explicitly scoped diagnosis; their existence does not authorize resume.

**TECHNICAL_FAILURE — READY FOR NEXT STEP: NO.** The daily trigger is consumed. Execution is stopped after one invocation; no retry, bypass, second candidate, migration, or repair was performed.
