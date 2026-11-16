# 12E.1 — supervised human-review migration

**Status: NOT READY.** Local reconciliation and all local checks passed. The single migration 31 push failed during PostgreSQL table creation, so remote approval and lifecycle validation did not run. The migration transaction rolled back; migration 31 remains unapplied.

## 12E BLOCKER

The migration-aware push stopped with PostgreSQL error `42710`: constraint `pipeline_human_reviews_review_manifest_check` already exists. The `review_manifest` column has an inline check that receives that generated name, and the table definition also declares an explicit constraint with the same name.

The push was attempted once. I did not retry it or patch the remote database. A read-only rollback check confirmed latest migration `20261002211000`, migration 31 absent, no review table/index/RPCs, eight attempts with the preapply row hash, two public articles, and Astra still archived.

## FAILING SUITE ROOT CAUSE

The original failing suite was `pipeline:factual-remediation:final-resume:unit` in `scripts/factual-remediation-final-resume-unit-test.mjs`. The assertion at line 75 expected `validateHistoricalMigration30Evidence(...).status` to equal `PASS`; it returned `FAIL`. The helper marked `noMigration31OrLater` false because the prepared migration 31 file was newer than the historical evidence artifact. That chronology guard treated migration 30 as the latest migration forever even though the evidence correctly recorded migration 31 as absent at capture time.

Classification: **OBSOLETE_LATEST_MIGRATION_ASSUMPTION**.

The test now checks the historical migration 30 evidence and its durable lifecycle/security invariants rather than forbidding later migrations. The failing suite passes.

## MIGRATION 30 COMPATIBILITY

Migration 30 was not edited. Its SHA-256 remained `2E775EB5F1473FC472E4AFF656D9297284C7577B6B0D82F686D17E8EEA71F764`.

The migration 29 and 30 fixtures pass and retain checks for same-attempt resume, reuse of the same authorization, Critic-only resume, one-resume protection, service-role isolation, fixed search path, preserved STOP history, and rejection of attempt 6. The failed migration push rolled back before migration 31 was recorded.

## MIGRATION 31 CONTRACT

The prepared local migration adds `WAITING_FOR_HUMAN_REVIEW`, a private `pipeline_human_reviews` table, service-role-only review RPCs, APPROVE/REJECT/HOLD decisions, and an atomic reviewed-publication wrapper. It binds approval to event/attempt/run/draft/checkpoint/source identities and hashes, requires factual and attribution review, and does not store a second copy of the article body or publication payload.

Migration 31 also replaces the attempt claim/finalize routines to preserve the waiting state as a permanent outcome. It revokes direct service-role execution of `publish_article_atomic`; runtime Publisher integration remains for 12E.2.

The migration 31 static fixture passes. The SQL has not been installed remotely, and its database contract remains unverified until the duplicate constraint name is corrected locally in a later phase and the migration is applied successfully.

## LOCAL VALIDATION

- Offline suites: **57/57 PASS**.
- Migration 29 fixtures: **PASS**.
- Migration 30 fixtures: **PASS**.
- Migration 31 static/lifecycle contract fixture: **PASS**.
- `npm run lint`: **PASS**.
- `npx tsc --noEmit`: **PASS**.
- `npm run build`: **PASS** (Next.js 16.3.4).
- `git diff --check`: **PASS**; Git emitted only existing LF-to-CRLF working-copy notices.
- Migration 30 checksum: **unchanged**.

## REMOTE APPLY

Preapply checks used project `skrthgpurquypgdwxast`. The normal private runtime read returned HTTP 200 for `pipeline_event_attempts` (8 rows). The public read returned two articles. Migration history showed 27, 28, 29, and 30 applied, 31 absent, and no 32. The installed `pgcrypto` extension is in schema `extensions`; the migration now qualifies its `digest` calls accordingly.

`supabase db push --dry-run --linked --yes` listed exactly `20261005194000_supervised_human_review_gate.sql`. The single actual push failed with the duplicate constraint error described above. A read-only query confirmed rollback. No other migration was applied.

## REMOTE OBJECTS

No migration 31 objects remain remotely: `pipeline_human_reviews`, its waiting index, and the five new review functions are absent. Migration 31 is not in history and migration 30 remains latest. No migration 32 exists.

The full post-apply catalog/grant audit was not run because the apply failed. Remote object inventory and synthetic lifecycle checks are pending a later phase.

## SECURITY

The local static fixture verifies fixed search paths, service-role-only mutation RPCs, anon/authenticated denial, no PUBLIC execute, no dynamic SQL, and no automatic Publisher or scheduler trigger. Remote ACL verification did not run because migration 31 is absent. The existing public read returned two articles before the push and after rollback.

## WAITING STATE

Local contract: Critic pass transitions to `WAITING_FOR_HUMAN_REVIEW` with `human_review` / `HUMAN_REVIEW_PENDING`. Remote transition: **NOT RUN**.

## APPROVE / REJECT / HOLD

Static contract checks pass for factual and attribution approvals, durable reviewer/action/time provenance, non-publishing HOLD/REJECT, and no automatic retry. Remote no-approval, HOLD, REJECT, and valid APPROVE fixtures: **NOT RUN**.

## STALE APPROVAL

Local assertions bind approval to draft/checkpoint/source/payload identities and hashes. Remote stale-identity checks: **NOT RUN**.

## SINGLE USE

The local contract serializes the approved consume operation with a row lock and marks the review consumed in the same transaction as publication. Remote single-use and concurrency checks: **NOT RUN**.

## PUBLIC CONTRACT

The preapply and rollback reads both returned two public articles. Astra remained archived. The migration does not alter article/event visibility tables.

## REAL DATA ISOLATION

No synthetic rows were created because remote lifecycle validation requires migration 31 to be installed first. The rollback check found eight attempts with the preapply hash unchanged, two public articles, and Astra archived. Provider calls: **0**. Real article/attempt mutations: **0**. Scheduler activation: **NO**.

## NEXT STEP

In a later 12E.1 pass, remove the duplicate auto-generated check by editing migration 31 locally, rerun the full local gate, verify migration 31 is still absent, and apply it through the migration-aware path once. Then run the prepared `12e1:<uuid>` synthetic validation and record the remote catalog, security, lifecycle, cleanup, and baseline checks. Do not edit migration 30 or integrate Publisher execution in this phase.
