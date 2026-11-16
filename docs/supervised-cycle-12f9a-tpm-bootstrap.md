# 12F.9A — Groq First-Request TPM / Local Usage Diagnosis

## Outcome and readiness

Root cause: **ACCOUNTING_WINDOW_BUG** in `public.reserve_groq_request_and_tokens_m35`. A successful current-day read was empty, but the RPC's rolling TPM predicate also included 46 completed, request-only legacy reservations from September indefinitely. Their token fields and dispatch markers were absent. This produced `GROQ_TPM_LOCAL_USAGE_UNKNOWN` before the first request of 12F.9.

The application already permits first-stage admission without fresh provider headers. No header-bootstrap policy change is necessary. The necessary fix is inside PostgreSQL's atomic reservation function. A narrow forward SQL proposal and deterministic fixtures are prepared. **It has not been applied. READY FOR NEXT UTC RUN: NO.** This phase requires zero remote writes and migration head `20261014120000` unchanged. No application bypass of the atomic RPC was introduced.

Provider calls: 0. Real pipeline runs: 0. Scheduler runs: 0. Remote writes: 0.

## Observe and causal chain

1. `runStructuredAgent()` computes and bounds the first-stage request, evaluates fresh headers if available, then calls `SupabaseAgentLogger.reserveGroqCapacity()`.
2. That method invokes `reserve_groq_request_and_tokens_m35` with the existing hard limits and 128-token safety margin.
3. M35 reads `agent_logs`, step `provider_request_reserved`, for Groq or legacy null-provider rows. Its minute predicate includes either a recent dispatch timestamp **or any row whose dispatch marker is absent/false**. The second branch has no time bound or terminal-run test.
4. `coalesce(payload->>'providerRequestDispatched', 'false') <> 'true'` includes old request-only rows whose marker does not exist.
5. The separate `v_unknown_minute` query counts rows whose `provider_unit` is not `tokens`, or whose `provider_unit_amount` is null/nonpositive. It counted 46 legacy rows with both fields null.
6. `v_unknown_minute > 0` returns `GROQ_TPM_LOCAL_USAGE_UNKNOWN`. `agent-runner.ts` maps an UNKNOWN reservation reason to `cost_guard_violation`, which the pipeline records as a technical failure.

No read failed. No first-request state row was missing. The absence of a fresh header was not the source of LOCAL_USAGE_UNKNOWN. The RPC's selected scope was not empty even though the current UTC day and the legitimate current rolling window were empty.

## Durable evidence

A complete paginated read found 142 Groq/legacy reservation rows linked to 138 runs. Exactly 46 rows were included by M35 as unknown; all have the legacy request-only shape, known Groq provenance, completed `succeeded`/`failed` runs, and activity dates long before the relevant minute. Counts by reservation date are 19 on September 13, 20 on September 14, and 7 on September 15. Their age at 12F.9 was approximately 30–32 days. The remaining 96 rows were already excluded by the existing dispatch-time predicate.

All four modern accounting keys were absent on those 46 rows: `providerRequestDispatched`, `dispatchedAt`, `estimatedTokens`, and `tokenUsageState`. No old value was filled, normalized, or rewritten.

One row's client-generated finish timestamp precedes the DB-generated reservation timestamp by 132 ms. The schema sets `agent_runs.updated_at` with a PostgreSQL `BEFORE UPDATE` trigger. The proposal uses the greatest of start, finish, run update, and reservation creation times as a conservative latest-activity bound; it does not assume client/server timestamp ordering.

Historical logs 964–966 prove that 12F.9 passed the application first-stage header check with `NO_FRESH_HEADER`. The request estimate was 7,261 tokens; adding the unchanged margin gives 7,389, below the 8,000 hard TPM limit. The failure happened later in local atomic reservation.

## Two different unknowns

**Local accounting** means this runtime's durable reservations, dispatches, accounted token amounts, and unreleased holds. A successful complete empty read is `KNOWN_ZERO` for its defined window. Query failure, incomplete reads, missing run linkage, malformed state, or a relevant unknown reservation remain technical failures. Unknown historical token amounts are not converted to zero; completed legacy rows outside the current window simply do not belong to current TPM usage.

**External provider usage** is use outside HorizAI's durable accounting context, including organization-level use by other callers. It remains UNKNOWN before a response or a valid persisted observation. Known zero local usage does not establish remaining external TPM. Groq documents limits at organization scope and rate-limit values in HTTP response headers. See [Groq rate-limit documentation](https://console.groq.com/docs/rate-limits).

LOCAL ACCOUNTING COMPLETE: **YES for the relevant admission scope after complete successful reads and terminal-run/window validation**. This does not claim complete historical token totals for old request-only rows, or visibility into other external callers.

## Empty-window and provider-header bootstrap

SQL already uses `coalesce(sum(...), 0)` and `count(*)`. A truly empty successful query resolves to known zero. The defect was inclusion of irrelevant old rows, rather than empty-result interpretation.

`decideGroqFirstStageCapacity()` already returns `ALLOW_LOCAL_RESERVATION / NO_FRESH_HEADER` when no usable observation exists. Freshness is at most 15 seconds and also checks the observed reset interval. Stale, future-invalid, or reset observations cannot prove current exhaustion. Fresh valid insufficient headroom defers before reservation. No remaining external token count is invented when headers are absent.

Requiring a response-derived header before any first request would prevent generating that first observation. Current application logic avoids that dependency; the SQL window defect blocked the subsequent local reservation.

## Forward fix

`scripts/migration36-groq-tpm-window.proposed.sql` is a reviewable proposal outside the active migration directory. It replaces only the body of the existing reservation RPC with the same signature. It keeps service-role enforcement, existing ACL, provider/day advisory lock, limits, margin, return schema, M25 daily reservation/settlement/release, and M33/M35 continuation functions.

Both TPM sum and unknown-count queries exclude a row only if all of these hold:

- It has null token unit/amount and an object payload with none of the four modern accounting keys.
- Its linked run has explicit Groq provenance and terminal `succeeded` or `failed` status, with a finish timestamp.
- `greatest(run.started_at, run.finished_at, run.updated_at, reservation.created_at) <= now() - interval '60 seconds'`.

Explicit undispatched holds never expire through this predicate, even across minute/day boundaries. Active, recently completed, recently updated, missing-linkage, or partially modern rows remain relevant or fail closed. Null/malformed payloads are not mistaken for legacy emptiness. The unknown-count guard also rejects malformed dispatch-marker types. No ledger row is deleted or updated by the proposal.

An application-only override cannot correct a denial inside the RPC without bypassing the atomic local-capacity contract. **Migration required: YES; migration applied: NO.** M33/M35 historical files remain intact. No new migration was registered in the active directory, and the remote head remains M35.

## Admission decision matrix

| Case | Decision |
| --- | --- |
| Intrinsic estimate plus margin exceeds hard TPM | `VERIFIER_INPUT_TOO_LARGE`; no reservation or dispatch |
| Complete known local usage leaves insufficient TPM | `DEFERRED_PROVIDER_CAPACITY`; same attempt, Verifier resume, stop daily execution |
| Complete known zero/fitting usage, no fresh headers, request fits | Local reservation may admit; external capacity remains UNKNOWN |
| Accounting query fails | Technical failure; no dispatch |
| Accounting state malformed or partial | Technical failure; no dispatch |
| Fresh valid header proves insufficient headroom | `DEFERRED_PROVIDER_CAPACITY`; no dispatch |

The matrix passes deterministic fixtures. The live RPC still has the old predicate until a forward schema fix is applied and validated.

## Provider-side 429

A synthetic HTTP 429 test uses injected local responses and makes no network call. It proves one dispatched request, zero retries, preserved rate-limit headers, and no invented actual usage. With no response usage, the durable token estimate remains `reserved_estimate`; actual input/output/total tokens remain unknown. The existing terminal attempt policy is `PROVIDER_RATE_LIMIT`, not a pre-dispatch capacity defer. M35 same-attempt resume requires no dispatch at the missing stage and is therefore not used after this 429. No redesign was made.

## Accounting windows and release

| Limit | Existing contract |
| --- | --- |
| TPM | Rolling 60 seconds by dispatch timestamp, falling back to reservation creation; explicit undispatched holds remain included until release |
| RPD | Reservation creation in `[UTC midnight, next UTC midnight)` |
| TPD | Same UTC reservation day; estimated tokens count until trustworthy actual usage settles the row |
| RPM | Configured/readiness limit; M35 does not independently enforce an atomic RPM rolling counter. Supervised mode remains sequential with an 18-request run cap. RPD headers are not mislabeled RPM. |

Release deletes only an undispatched reservation under the matching run/date identity and lock. After dispatch, release cannot erase the reservation. Settlement replaces the estimate with trustworthy actual usage; failed/429 calls without actual usage retain the estimate. The proposal preserves these behaviors. A previous-day dispatch can still be in current rolling TPM; a new minute/day does not turn a complete empty window into UNKNOWN.

## Historical 12F.9 semantics

HISTORICAL SEMANTIC ACCURACY: **NO under the corrected window contract**. The relevant local window was empty and the request fit its hard bound. The observed runtime did fail closed correctly on the erroneous UNKNOWN response; its persisted technical result is valid evidence of what the deployed code did. It is not retrospectively rewritten, retried, resumed, or reclassified in the database.

## Tests and verification

Thirty-seven focused suites passed, including the new bootstrap matrix, the 12F.8D adapter regression, Verifier compaction/oversize, accounting, M33/M35 and fresh-process resume, throughput and safe revision continuation, Editor grounding, Critic/M34, scheduler finalization, selection, clustering, and recency. The new fixtures also cover active holds across UTC boundaries, the inclusive 60-second boundary, old legacy rows, terminal-run freshness, clock ordering, failed/partial/malformed reads, no-header bootstrap, and synthetic 429 accounting.

Lint, TypeScript, canonical `npm run build` using `next build --webpack`, diff check, and secret audit pass. Fonts, UI, package versions, and executable production policy are unchanged. Visual verification is not applicable. The existing local `NEXT_PUBLIC_SITE_URL` warning is unchanged.

SQL verification limitation: Docker's local engine was unavailable and no standalone PostgreSQL executable was present. The SQL proposal was inspected and checked against a deterministic predicate model and fixtures; it was **not executed in PostgreSQL**. No remote rollback fixture was run because that would issue remote writes.

## Remote read-only baseline

Before/after reads match all 17 complete attempt-row hashes, the full consumed scheduler-row hash, 719 agent-log rows, and 186 agent-run rows. Historical 12F.9 and `supervised-candidates:2026-10-15` are unchanged. Baseline: attempts 17; active/deferred/stuck 0/0/0; reviews/WAITING 0/0; public 2; Astra archived; current-day unknown reservations 0; M32 status/list PASS; M35 present at head `20261014120000`. M35 lifecycle/security offline tests pass; no schema or ACL change was attempted.

The authoritative public fingerprints remain `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64` and `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`, using unchanged `publicArticleFingerprintV1`.

## Closure

Cause proven; application bootstrap policy already correct; forward database fix prepared; deterministic regressions green. Production readiness remains **NO** until the SQL fix is applied under appropriate authorization and validated in PostgreSQL. This phase stops with provider calls 0, real pipeline/scheduler runs 0, and remote writes 0.
