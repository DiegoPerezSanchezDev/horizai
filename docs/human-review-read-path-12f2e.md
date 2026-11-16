# Human-review read path and operator observability (12F.2e)

## BLOCKER

The existing operator's `status`, `list`, and `inspect` commands used `npx supabase db query --linked` to read `pipeline_human_reviews`. Migration 31 revokes direct table privileges from `public`, `anon`, `authenticated`, and `service_role`, so this is not a working application read path. The replacement PostgREST/RPC path is implemented locally, but its functions are not present remotely: the read-only `status` invocation returned `PGRST202`. The remote review count and WAITING count therefore remain unknown; they are not assumed to be zero.

## 12E.2 OPERATOR PATH AUDIT

The entry point was `scripts/pipeline-human-review.ts`. Before this phase, its status/list/inspect branches delegated database SQL to the linked Supabase CLI. The operator needed the CLI's linked project/database access; the path did not call a review-read RPC and could not work under migration 31's review-table grants. It was not suitable for routine operator reads.

The 12E.2 PASS was offline and synthetic. `docs/runtime-supervised-mode-12e2.md` says no live database operation occurred; `artifacts/runtime-supervised-mode-12e2.json` records `listAndInspectSyntheticFixtures: PASS`. Those fixtures validated local package parsing and mocked RPC behavior, not remote status/list/inspect against production.

## MIGRATION 31 PRIVILEGES

Migration 31 defines these seven review/lifecycle functions:

| Function | Role |
| --- | --- |
| `claim_pipeline_event_attempt` | Mutation: claims an attempt. |
| `finalize_pipeline_event_attempt` | Mutation: finalizes an attempt. |
| `assert_pipeline_human_review_evidence` | Read-only evidence/accounting validator used internally. |
| `assert_pipeline_human_review_source_lineage` | Read-only source-lineage validator used internally. |
| `create_pipeline_human_review` | Mutation: creates a review and atomically moves its attempt to WAITING. |
| `decide_pipeline_human_review` | Mutation: records APPROVE, HOLD, or REJECT. |
| `publish_reviewed_article_atomic` | Mutation: validates and consumes approval while publishing. |

There is no operator status/list/inspect read RPC in migration 31. Migration 31's direct `pipeline_human_reviews` table protection remains unchanged.

## READ CONTRACT

Migration 32 adds three read-only PostgREST RPCs: aggregate status, a list capped at 500 rows, and inspection of one UUID. Status reports total, WAITING, HOLD, REJECTED, APPROVED, APPROVE-action, PUBLISHING, PUBLISHED, and consumed counts, plus the existing UTC-day attempt and provider observability fields. The list RPC returns only review identity/state, lineage, hashes, manifest, decision fields, and timestamps. It does not return editorial or source bodies. The trusted operator then loads the local immutable review package, binds it to the row and expected package hash, and renders headline, source names/URLs, Critic findings, factual/attribution state, and timestamps. `inspect` returns the full reviewable package only after the same row/package/checkpoint binding; an absent UUID has the typed `{ found: false, review: null }` result and the CLI maps it to `HUMAN_REVIEW_NOT_FOUND`.

The offline populated fixture covers WAITING, HOLD, REJECT, APPROVE, consumed approval, and PUBLISHED. Empty list and not-found inspection are also parsed. The exact package contents remain served from the existing immutable local artifact rather than duplicated into the review table.

## SECURITY

`SECURITY DEFINER` is required because direct table SELECT remains revoked, including for `service_role`. Each function fixes `search_path` to `pg_catalog, public`, qualifies its table references, rejects `auth.role()` values other than `service_role`, and performs reads only. Function execution is revoked from `public`, `anon`, `authenticated`, and `service_role` before being granted only to `service_role`. The migration does not grant table SELECT. The repository module has a `server-only` guard and invokes only those RPCs; the operator CLI uses the existing server secret helper and does not expose credentials to browser code.

The offline ACL fixture confirms the intended anonymous/authenticated denial and trusted-role grant. A remote anonymous/authenticated probe was not run because migration 32 is not applied; remote ACL behavior is consequently not reported as verified.

## MIGRATION DECISION

**MIGRATION_32_REQUIRED.** Migration 31 has no safe review read RPC and direct table SELECT is revoked. The code-only option cannot read the review table using existing grants. Exactly one forward migration was prepared at `supabase/migrations/20261007215233_human_review_operator_read_rpc.sql`. Migrations 30 and 31 were not edited.

**Migration applied: NO.** The local environment has no configured database password for a password-backed migration connection. The passwordless linked Supabase CLI fallback can provision a temporary login through the Management API; that conflicts with this phase's explicit `temporary login: 0` and `Management API provisioning: 0` requirements. This conclusion is based on the [Supabase CLI database URL resolution code](https://github.com/supabase/cli/blob/develop/apps/cli-go/internal/utils/flags/db_url.go), which contains the login-role fallback when a database password is absent. That fallback was not invoked. No manual remote SQL patch was made.

## REMOTE STATUS

Fresh status command attempted through the new application/server PostgREST RPC path:

```text
npm.cmd run pipeline:human-review -- status
HUMAN_REVIEW_OPERATOR_STATUS_FAILED:PGRST202
```

The function is missing from the remote schema because migration 32 has not been applied. No remote status count is available.

## REMOTE LIST

Not run: the list RPC is in the same unapplied migration, so there is no remote list result. Empty-list behavior passes offline.

## REMOTE INSPECT

The remote nonexistent-ID command was not run because its RPC is likewise absent. Typed not-found behavior passes offline; no synthetic review was written remotely.

## APPLICATION BASELINE

Captured read-only on `2026-10-07T21:59:18.755Z` through the existing application/server PostgREST helper. Requests were GET/HEAD only; Supabase CLI and Management API were not invoked.

| Measure | Fresh result |
| --- | --- |
| Public articles | 2 |
| Article 1 ID / `publicArticleFingerprintV1` | `6203559f-413a-4f06-9346-1720bbeb0e7a` / `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64` |
| Article 2 ID / `publicArticleFingerprintV1` | `7415c685-04ed-4956-a77a-4bc372c9b060` / `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b` |
| Astra | Archived |
| Real attempts | 10 |
| Active / deferred / stuck | 0 / 0 / 0 |
| Groq today | 3 dispatched requests; 5,387 settled tokens; 0 unknown |
| Cloudflare / Cerebras today | 0 / 0 requests |
| Active scheduler leases | 0 |

Both fingerprints match the 12F.2d baseline. Review count and WAITING count remain unknown because the safe remote RPC is not applied. Provider and review-mutation deltas for this phase are zero.

## OPERATIONAL POLICY

Windows operator entry point remains `npm.cmd run pipeline:human-review -- <status|list|inspect ...>`. The read path uses the service-role PostgREST client server-side. Do not use CLI SQL, direct review-table SELECT, or provision temporary database logins for routine reads. After the migration is safely applied, run `status`, `list`, and `inspect <nonexistent-uuid>` remotely and confirm status/list plus typed not-found before starting 12F.3. Scheduler remains off; no pipeline, provider, decision, publication, or review-write command was run.

## TESTS

- 65 offline `:unit` suites: PASS.
- Migration 29 fixtures: PASS.
- Migration 30 fixtures: PASS.
- Migration 31 fixtures: PASS.
- Migration 32 read-path/security/populated-state fixtures: PASS.
- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run lint`: pending final verification.
- `npm.cmd run build`: pending final verification.
- `git diff --check`: PASS after final documentation/artifact edits.
- Provider calls: 0. Real review writes: 0. Supabase CLI SQL: not used. Temporary login/Management API provisioning: 0.

## READINESS

**12F.2e READY: NO.** The safe server-side read path and offline contract are implemented, and the fresh public/attempt/provider baseline is unchanged. Remote status/list/inspect, current review counts, and remote ACL denial are unverified because migration 32 cannot be applied without violating the temporary-login prohibition under the available credentials. Continue only after a password-backed migration path is configured securely and migration 32 is applied once; then repeat the three remote read checks and refresh review counts.

## NEXT

12F.3 is not authorized by this result. First complete the blocked remote migration and operator-read validation; stop before any human decision, publisher action, or pipeline execution.
