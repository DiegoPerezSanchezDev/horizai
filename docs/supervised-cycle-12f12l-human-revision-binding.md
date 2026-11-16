# FASE 12F.12L — Human Revision Binding

## Outcome

M38 was applied to the remote database after migration history and dry-run confirmed it was the only pending migration. Read-only ACL verification confirmed the revision table has RLS enabled, no policies, and no direct privileges for `service_role`, `anon`, or `authenticated`; the security-definer RPCs are executable only by `service_role` and not by `PUBLIC`, `anon`, or `authenticated`.

The corrected human draft passed the local 12K audit and both 12L read-only preflights. Across the two identical 12L requests, each request's single permitted call to `bind_pipeline_human_review_revision` returned a generic failure; neither runner retried. A subsequent read-only inspect and a direct call to the revision-read RPC found no revision row and confirmed the existing review remains `WAITING_FOR_HUMAN_REVIEW`, unconsumed, and still targets the original draft. The corrected revision is **not bound and not ready for approval**. The specific PostgREST/database error was not preserved by the current RPC error adapter.

## Boundaries preserved

- Review `ebd8acc0-76a2-4977-81d9-60a7f6240084` and attempt `4658d5c0-857c-4ed5-b97f-afb133b2bf22` remain the only target; no new review or attempt was created.
- Original model draft SHA-256: `3e03a0ada667bd6b46be7f99ac06d5c24ca80e82adaa33e85bb090a7b4062b14`.
- Proposed corrected revision SHA-256: `69f0d3e350621f86c69a72d2cb1cbf1cb390212d695f932eedb03d325ade2045`.
- Source lineage SHA-256: `42c5de597f333d80c31d634f61960181d7f5480201237b9f447d37b651d968dc`.
- M34 Critic PASS remains evidence about the original draft only.
- No approve, hold, reject, Publisher, or provider action was run. Published article count stayed at 2 during preflight, and provider daily usage matched the prior read-only baseline.

## Validation

The revision-binding unit test, human-review unit suite, M31/M32/M34 contract suites, migration-runner unit suite, secret-audit unit and full scan, lint, TypeScript, production build, and `git diff --check` passed. The production build required one worker, a temporary isolated output directory, and network access for the app's configured Google Fonts; temporary config changes and build output were restored/removed. The full sanitized verification record is in `artifacts/supervised-cycle-12f12l-human-revision-binding.json`.

## Next step

Inspect the failure cause without changing the review, then use a separately authorized recovery step if another binding call is needed. Both authorized calls in these two 12L executions have been used. This phase intentionally stops with the existing review waiting on its original immutable draft.
