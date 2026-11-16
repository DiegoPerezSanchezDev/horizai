# Migration 33: provider-capacity defer and resume lifecycle

**Phase:** 12F.3 — persistence fix\
**Verified:** 2026-10-09\
**Readiness:** READY YES\
**Real attempt resumed or reconciled:** No

## Root cause

The real Editor stage stopped before provider dispatch. Groq TPM pacing required waiting, while supervised execution had `allowProviderPacingWait=false`; `runStructuredAgent` raised the typed `PROVIDER_CAPACITY_EXHAUSTED` error. Verifier and Translator had already passed. Editor dispatched no request.

The local runtime recovery added Editor capacity-resume support, a durable snapshot contract, and fresh-process reconstruction. The persistence path still attempted a direct PostgREST `UPDATE` to `pipeline_event_attempts`. The existing lifecycle migrations revoke that table write from `service_role`, and migrations 30–32 had no authorized defer/claim path. The failed lifecycle transition left the observed real attempt active without a capacity stop marker or durable capacity snapshot.

## Migration 33

Created and applied exactly one forward migration:

`supabase/migrations/20261009120000_provider_capacity_attempt_lifecycle_rpc.sql`

Remote migration history reports M33 applied and latest. Migrations 27–32 were neither edited nor reapplied. No later migration was created.

The migration adds `capacity_resume_snapshot jsonb` with an identity constraint and three narrow `SECURITY DEFINER` RPCs:

- `defer_pipeline_event_attempt_capacity(...)`: validates and persists a retry-neutral pre-dispatch defer on an existing active NORMAL attempt. It returns `ALREADY_DEFERRED` for an identical repeat and rejects a conflicting repeat.
- `claim_pipeline_event_attempt_capacity_resume(...)`: compare-and-set claim of the same deferred attempt for one owner.
- `release_pipeline_event_attempt_capacity_resume(...)`: owner-checked release back to the deferred state.

Resume writes are generation checked. A resumed run can atomically replace the snapshot for a later missing stage and release its prior owner. Terminal attempts cannot be reopened. The migration does not create attempts or offer a general table/JSON patch API.

## Security

All three functions use `search_path = pg_catalog, public`. Execute is revoked from `PUBLIC`, `anon`, `authenticated`, and initially `service_role`; only the required function execute grants are then given to `service_role`. Remote ACL inspection confirmed all three functions exist, `service_role` can execute them, and `PUBLIC`, `anon`, and `authenticated` cannot.

`directUpdateRestored=false`. Remote table ACL inspection confirmed `service_role` still has no direct `INSERT`, `UPDATE`, or `DELETE` on `pipeline_event_attempts`; anon/authenticated/public cannot select it. RLS remains enabled and the prior policies are unchanged. Direct `service_role` select remains at its pre-M33 state. Existing M32 human-review read RPC ACLs still pass; direct reads from `pipeline_human_reviews` remain unavailable to `service_role`.

The `anon` and `authenticated` denials were verified through ACL metadata rather than live calls using those roles (`ACL_VERIFIED_NOT_RUNTIME_TESTED`).

## Snapshot contract

The versioned snapshot is an object with kind `SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME`, matching attempt, run, and event identities, the first missing `resumeStage`, and the event, extracted `items`, and source/raw-item lineage. It includes completed-stage outputs, checkpoint metadata and SHA-256 values, settled provider accounting, next-stage dispatch/checkpoint evidence, and a resume generation. The RPC rejects unknown top-level keys, oversized or malformed snapshots, mismatched lineage, invalid/missing prior checkpoints, missing required prior outputs, a next-stage checkpoint, a nonzero next-stage dispatch count, and stale generations.

For the observed Editor failure, the snapshot must carry valid Verifier and Translator checkpoints and outputs. A fresh process resumes at Editor without rerunning those completed model stages. The local recovery fixture verifies this path and confirms zero Verifier/Translator redispatch.

## Concurrency and idempotency

The RPCs take a transaction-scoped advisory lock keyed by event, lock the attempt row, and use lifecycle/identity compare-and-set predicates. This serializes defer/claim transitions for an event. Identical repeated defer is idempotent; conflicting defer, a second claim, stale owner/generation, and terminal reopen are rejected.

The in-memory regression races two resume claims and observes exactly one winner. The remote rollback fixture exercises repeated and conflicting defer, double claim, owner release, stale generation, and terminal reopen. It runs as one transactional `DO` block, forces its synthetic row back to zero, and a separate read-only residual query confirmed zero rows. No separate multi-session stress race was run; remote concurrency protection is provided by the advisory lock and row-level lock in each RPC.

## Local and remote fixtures

Local M33 fixtures cover snapshot validation, retry-neutral state, same-attempt identity, idempotency, pre-dispatch-only evidence, concurrent claim behavior, fresh-process continuation, and the absence of direct table DML in the repository. The remote synthetic rollback fixture also checked wrong attempt, wrong event, already-dispatched evidence, stale generation, double claim, and terminal reopen.

Remote results:

- valid defer: PASS;
- retry-count neutrality and first-missing stage persistence: PASS;
- identical defer idempotency and conflicting defer rejection: PASS;
- same-attempt resume and one-owner claim: PASS;
- wrong attempt/event, dispatched request, stale generation, and terminal reopen: rejected;
- ephemeral fixture residue: `0`.

## Real attempt state and reconciliation plan

Attempt `dfada4fd-d9c6-4aa8-bfef-6d9447267e06` was left untouched. The post-M33 read-only check found it active with `final_state=null`, `stop_stage=null`, `stop_reason=null`, and `attempt_number=1`. The real attempt count remained 11; there were no human-review rows. The latest observed provider ledger remained at 2 Groq requests / 5,778 tokens for the original 12F.3 run. This phase added no provider usage.

The post-M33 public baseline remained at 2 articles with unchanged fingerprints: `6203559f-413a-4f06-9346-1720bbeb0e7a` → `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`; `7415c685-04ed-4956-a77a-4bc372c9b060` → `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`. Astra article `756b0ee0-b5e6-4153-846f-278a12c9afe3` remained archived.

**Facts known at incident time:** Verifier and Translator passed; Editor hit the typed Groq TPM preflight capacity stop before dispatch; Editor dispatched zero requests; no Editor output was produced; the attempt was left active; the capacity snapshot was not persisted.

**State reconstructed from durable checkpoints now:** Verifier and Translator checkpoints are readable, validate to the same event and verification, and can reconstruct a valid Editor input in a fresh process. The durable checkpoint metadata does not contain the full extracted `items` array or `rawItemId` source lineage required by the M33 snapshot contract. There is no persisted Editor output or capacity-resume snapshot.

Therefore `realAttemptReconciliationSafe=false`. Constructing the M33 snapshot would require inventing historical extraction/lineage facts. Do not convert the attempt to deferred and do not resume Editor. If a later, separately authorized phase elects to close the orphaned attempt, the safest terminal handling is to finalize this same attempt through the existing owner-checked `finalize_pipeline_event_attempt` RPC as `ABORTED`, at stage `editor`, with reason `CAPACITY_RESUME_EVIDENCE_UNAVAILABLE`, retry class `NONE`, `counts_toward_retry_limit=false`, and `next_eligible_at=null`. That recommendation was not executed here.

## Verification

- 72 offline package unit/simulation/contract suites: PASS. This includes M31 human-review, M32 read-path, and M33 lifecycle/guard fixtures.
- Standalone migration 29 fixture: PASS.
- Standalone migration 30 fixture: PASS.
- Remote migration history, M33 ACL, existing M32 review RPC ACL, and fixed residual check: PASS.
- Remote ephemeral M33 behavior fixture: PASS; residual rows: 0.
- `npm run lint`: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS; static build only, no pipeline execution.
- `git diff --check`: PASS (Git emitted line-ending normalization warnings only).
- `npm run secret:audit:unit`: PASS; no secret values reported.

Phase effects: provider calls `0`; real attempt mutations `0`; real pipeline executions `0`; new real attempts `0`; article/review writes `0`; publication `0`; scheduler activation `false`. The only persistent remote write was the authorized schema migration. Synthetic fixture writes were rolled back.

## Readiness

**12F.3 READY = YES.** M33 is applied, narrowly authorized, and its local and remote lifecycle fixtures pass. The real incident remains unreconciled because required historical lineage is absent. Stop here; the real-attempt reconciliation is a separate phase and must not resume the attempt unless a valid snapshot can be formed without invented data.
