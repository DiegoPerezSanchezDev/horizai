# 12C.2B.0 — Audited factual-remediation lifecycle

**Status: PREPARED LOCALLY; migration 27 is not applied.** The normal lifecycle still treats `READY_FOR_PUBLICATION` as final. The incident path uses a separate, service-role-only claim and starts from a fixed Verifier boundary. No provider call, remote write, publication, scheduler execution, router activation, Netlify action, or migration apply occurred in this phase.

## WHY LIFECYCLE CHANGE IS REQUIRED

The ordinary attempt claim refuses an event with any previous `READY_FOR_PUBLICATION`, `REVISION_REQUIRED`, `REJECTED`, or `VERIFICATION_INSUFFICIENT` result. This is enforced both in `evaluateNormalEligibility` (`lib/agents/pipeline/event-attempt-policy.ts`) and in `public.claim_pipeline_event_attempt` (`supabase/migrations/20260922000018_pipeline_event_attempt_claim_race.sql`). The normal orchestrator always runs Discovery → Extraction → Clustering before it makes that ordinary claim (`lib/agents/pipeline/pipeline-orchestrator.ts`). There is no normal selector that can re-enter the event at Verifier.

The existing article is archived and the corresponding historical attempt is still `READY_FOR_PUBLICATION`. Reopening that attempt would destroy the lifecycle record and make ordinary callers eligible to publish again. A new, purpose-tagged attempt is required.

## CURRENT ATTEMPT MODEL

`pipeline_event_attempts` tracks event key, pipeline run ID, event-local attempt number, final state, retry class, cooldown, and ownership. The partial unique index permits one active attempt per event. The regular claim serializes using `pg_advisory_xact_lock(hashtextextended(event_key, 0))`, rejects permanent outcomes, and applies the existing technical retry ceiling and UTC cooldown.

The pilot’s four attempts are verified by their exact event key, run ID, attempt number, terminal state, and retry-count bit. Three unrelated historical rows in the table are not included in the pilot count. The incident’s old attempt remains event-local attempt 1 and the remediation will be event-local attempt 2.

## REMEDIATION PURPOSE

The new purpose is `FACTUAL_REMEDIATION`. Existing rows receive the additive default `NORMAL`. The one allowed remediation row records `start_stage='VERIFIER'`, article ID, raw item ID, prior attempt ID, human reason, operator name, authorization reference, and `pilot_attempt_number=5`.

The claim RPC is incident-specific and does not accept an event, article, raw item, or stage parameter. It checks the fixed target, the exact prior run and terminal state, the archived article, the raw lineage and stored content hash, the four-row pilot baseline, and the absence of an active or previous remediation attempt. A failed or aborted remediation still occupies pilot attempt 5; the unique index prevents a second remediation row for this event and a second use of pilot ordinal 5.

## SECURITY

Both new database functions require `auth.role()='service_role'`, use `SECURITY DEFINER` with `search_path = pg_catalog, public`, qualify table references, and use no dynamic SQL. Execute is revoked from `PUBLIC`, `anon`, and `authenticated`; only `service_role` receives execute. Direct `INSERT`, `UPDATE`, and `DELETE` on the attempt table are revoked from `service_role`; attempt changes continue through ownership-checking RPCs.

The server-only repository accepts an authorization operator, reference, and reason only after explicit execution arguments are present. The runner’s default and `--preflight-only` modes do not create an attempt. The normal scheduler, bridge, retry and claim paths still use only `claim_pipeline_event_attempt`.

## RESTART BOUNDARY

The only allowed restart value is `VERIFIER`. The RPC hardcodes that value, the table constraint permits no other factual-remediation stage, and `runFactualRemediation` does not accept a stage argument. It validates the exact event and single-source raw lineage, checks that the caller owns the active remediation row before any agent runs, and creates a new manual run context from the claimed run ID.

The ordinary `run()` method, scheduler, bridge, and retry code cannot reach this claim. They continue to reject the old `READY_FOR_PUBLICATION` outcome.

## CHECKPOINT SEMANTICS

Discovery, Extraction and Clustering are not rerun. The stored TechCrunch extraction is reused only after its raw item ID, source ID, external item ID, full extraction quality, status, character length, raw SHA-256, normalized content hash, URL host, and reconstructed event key/title are validated. No source fetch is used.

`runEventStages` constructs a new context from event, items and source metadata only. It receives no historical Verifier, Translator, Editor, Classifier, Ranker or Critic outputs. Production checkpoint paths include the new `pipeline_run_id` (`checkpointPath` in `lib/agents/pipeline/create-production-pipeline.ts`), so new stage output files are created in a new run directory. Historical checkpoint files are not rewritten or used as remediation output.

## ATTEMPT ACCOUNTING

Before the future claim, the pilot is 4/5 and Groq usage is 19/30. Claiming the remediaton row records event-local attempt 2 and pilot attempt 5, yielding 5/5. There is no sixth pilot attempt. The exact baseline and global partial unique index on `pilot_attempt_number` protect this accounting.

The remediation has `maxRetries=0`. Finalization always sets `counts_toward_retry_limit=false`, `retry_class='NONE'`, and `next_eligible_at=NULL`, including technical failures. This does not change normal cooldown behavior. Existing provider daily quota checks, Groq atomic reservations, token settlement, TPM/RPM pacing, and rate-limit gates remain in the production adapters; the remediation RPC has no capacity bypass.

## CONCURRENCY

The incident claim uses the same advisory key as the normal claim, then checks for any active attempt. The pre-existing one-active-attempt index remains in force. A one-remediation-per-event index and unique pilot ordinal prevent duplicate concurrent requests and any later hidden sixth attempt. Offline tests check these SQL contracts; actual concurrent database validation belongs to 12C.2B.1 after the migration is applied.

## PUBLICATION TOPOLOGY

The Publisher contract remains upsert-by-`event_id`; the database also enforces unique article event ID and unique slug (`20260916000009_publisher_atomic.sql`). The chosen policy is **update the same archived article row and preserve its slug**. The payload is forced to the incident slug, and `publish_factual_remediation_article_atomic` locks and requires that exact row to remain archived, delegates to the existing atomic Publisher function, then verifies the same article ID and slug became published. Any failure rolls back the transaction. The public article count is expected to return from 2 to 3 after successful future publication, with no duplicate row.

The old article remains archived for every upstream stage and until the final Publisher transaction succeeds. The correction attempt references the previous attempt, article and raw item; the execution runner records the 12C.1 public snapshot hash before running and records a readback result afterward. The original attempt and checkpoints remain unchanged.

## ARCHIVED ARTICLE

Article `756b0ee0-b5e6-4153-846f-278a12c9afe3`, event `5138e509-f4c3-4020-9d13-6a6efac99a39`, event key `event-30f226d1b8ba5c9eb8af2b65c46db512`, and slug `openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad` are fixed in the remediation plan and RPCs. The article remains archived now. No unarchive or publication was performed.

## MIGRATION 27

Prepared: [`20260930211903_factual_remediation_lifecycle.sql`](../supabase/migrations/20260930211903_factual_remediation_lifecycle.sql). It extends `pipeline_event_attempts` and adds an incident-only claim function plus an atomic same-row publication wrapper. No table is added, no old attempt row is updated, no migration 28 was prepared, and this migration has not been applied.

## APPLICATION CHANGES

- `factual-remediation.ts` defines the exact incident, authorization contract, attempt 5/5 plan, and immutable Verifier restart boundary.
- `factual-remediation-repository.ts` is the separate RPC-backed repository; it claims only this incident and can verify active attempt ownership before stages run.
- `factual-remediation-input.ts` loads and validates only existing database lineage and stored extraction. It does not discover, fetch, insert, or update.
- `pipeline-orchestrator.ts` has a separate `runFactualRemediation` entry that requires a valid claimed attempt, Groq quota, explicit publish mode, and a fresh Verifier context. Normal callers do not use it.
- `create-production-pipeline.ts`, Publisher, and `supabase-publisher-repository.ts` route a remediation publication to the guarded atomic RPC and preserve the archived article ID and slug.
- `scripts/factual-remediation-12c2b0.ts` defaults to preflight. Execution requires `--execute-factual-remediation`, `--authorized-by`, `--authorization-reference`, and `--reason`. It was not run.

## OFFLINE VALIDATION

The new offline test covers the migration ACL, fixed stage and lineage checks, no-new-table rule, pilot baseline, single remediation ceiling, explicit CLI mode, typed RPC claim contract, normal final-state rejection, ownership validation before stages, fresh-context restart, stage order, no source refresh, and same-slug publication wrapper. It simulates six model-stage requests with local fixtures; it made zero actual provider calls and no remote writes.

The relevant attempt, scheduler, bridge wiring, orchestrator, checkpoint, factual guard, Verifier, Translator, Editor, Classifier, Ranker, Critic, Publisher, public-content, publication readiness, production gate, and contract test suites pass. `npm run lint`, `npx tsc --noEmit`, and `npm run build` also pass. Live SQL grants, real concurrency, actual publication, and provider behavior remain unverified because migration apply and execution are out of scope for this phase.

## FUTURE EXECUTION

First complete 12C.2B.1: apply and remotely validate migration 27, including function permissions, ordinary claim rejection, attempt ownership, concurrency, archived-row locking, and transaction rollback. Then separately authorize 12C.2B.2. Before any model call, recheck current pilot Groq usage, remaining daily quota, capacity reservations, provider routing, exact article state, prior attempt, and source hash. The path is Verifier → Translator → Editor → Classifier → deterministic Geo → Ranker → Critic → Publisher. At most six Groq calls; Geo and Publisher are deterministic. Critic must pass before Publisher can run.

The future command’s default is preflight only:

```powershell
npm run pipeline:factual-remediation
```

An actual run requires the explicit execution flag and human authorization fields:

```powershell
npm run pipeline:factual-remediation -- --execute-factual-remediation --authorized-by="NAME" --authorization-reference="REF" --reason="REVIEWED FACTUAL CORRECTION"
```

Neither command was executed in this phase.

## LIMITATIONS

- Migration 27 is prepared but unapplied; database execution and real concurrency are not yet verified.
- No provider request was made, so no remote model calibration or corrected content is claimed.
- The stored extraction was previously assessed as matching the source rendering; this phase reuses only that stored item and does not perform a fresh fetch.
- Groq usage 19/30 is the recorded pilot baseline, not live admission evidence. Revalidate it before any execution.
- Normal final-state handling is unchanged; a failed factual-remediation attempt still consumes the only remaining pilot attempt.

## NEXT STEP

12C.2B.0 is **READY YES**. Offline tests, lint, TypeScript and build pass. Stop here. The next phase is 12C.2B.1 — apply and remotely validate migration 27; do not automatically proceed to remediation execution.
