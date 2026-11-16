# Human-review read RPC migration closeout (12F.2f)

## Scope and safety

Migration 32 was applied once through the repository's direct-connection guard and the local Supabase CLI. The guard loaded `SUPABASE_DIRECT_DB_URL` from `.env.local`, passed it explicitly with `--db-url`, removed the URL and API/provider credentials from the CLI child environment, and did not use `npx`, a linked project, a temporary login, or Management API provisioning. Migrations 30 and 31 were not edited. No migration 33 exists.

The only remote write in this phase was the schema migration. There were no article, attempt, review, accounting, or scheduler writes, no pipeline execution, and no provider calls.

## Migration apply and history

`npm.cmd run supabase:db:push` applied exactly `20261007215233_human_review_operator_read_rpc.sql` and exited successfully. A subsequent guarded `npm.cmd run supabase:status` confirmed:

| Timestamp | Local | Remote |
| --- | --- | --- |
| `20261002211000` (migration 30) | present | applied |
| `20261005194000` (migration 31) | present | applied |
| `20261007215233` (migration 32) | present | applied |

Migration 32 is the latest remote migration. There is no migration 33 locally or remotely.

## Operator RPCs

All checks used the normal server-side Supabase/PostgREST path and the existing server secret helper. The credential value was not printed.

- `status`: PASS. HTTP 200 by successful RPC response. Total, WAITING, HOLD, REJECTED, APPROVED, APPROVE-action, PUBLISHING, PUBLISHED, consumed, candidates today, and attempts today were all 0. `activeWork` and `stuckWork` were 0.
- `list`: PASS. Returned 0 rows with the 500-row maximum. `publishedTodayUtc` was 0.
- `inspect`: PASS. A newly generated UUID returned the repository's typed `HUMAN_REVIEW_NOT_FOUND`; no raw SQL detail or permission failure leaked.

Fresh remote review baseline: total 0, WAITING 0, HOLD 0, REJECT 0, APPROVE 0, consumed 0, published 0. The empty result is the observed remote state, not an assumption.

## Remote security and ACL

The three remote functions exist. A single read-only catalog query through the direct-connection guard confirmed `EXECUTE` is granted to `service_role` and denied to `PUBLIC`, `anon`, and `authenticated` for each function. It also confirmed direct `SELECT` on `public.pipeline_human_reviews` is denied to `PUBLIC`, `anon`, `authenticated`, and `service_role`.

Runtime checks confirmed the trusted server can call the functions. The publishable-key anonymous RPC probe was denied with HTTP 401 / PostgREST `42501`. Direct table-read probes were denied for `anon` (HTTP 401) and `service_role` (HTTP 403). No authenticated test identity was configured, so the authenticated result is `ACL_VERIFIED_NOT_RUNTIME_TESTED`; the remote catalog ACL query verified its denial.

The read-only ACL query is kept at `scripts/migration32-remote-acl-readonly.sql` and can run only through `npm.cmd run supabase:migration32:acl`, which uses the same guarded direct URL path. It is one catalog `SELECT`; it does not read review rows or change database state.

## Product and provider baseline

The post-migration application baseline was captured on `2026-10-09T10:47:50Z` using GET/HEAD PostgREST requests only:

| Measure | Result |
| --- | --- |
| Public articles | 2 |
| Astra | archived |
| Real attempts | 10 |
| Active / deferred / stuck attempts | 0 / 0 / 0 |
| Active scheduler leases | 0 |
| Groq reserved / dispatched / total tokens / unknown-token requests (UTC day) | 0 / 0 / 0 / 0 |
| Cloudflare reserved / dispatched / total tokens / unknown-token requests (UTC day) | 0 / 0 / 0 / 0 |
| Cerebras reserved / dispatched / total tokens / unknown-token requests (UTC day) | 0 / 0 / 0 / 0 |

Both public article fingerprints match the previous recorded baseline:

| Article ID | Fingerprint |
| --- | --- |
| `6203559f-413a-4f06-9346-1720bbeb0e7a` | `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64` |
| `7415c685-04ed-4956-a77a-4bc372c9b060` | `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b` |

Provider delta for this phase: 0 requests, 0 tokens, 0 calls. Unknown dispatched reservations: 0.

## Regression and readiness

- 66 offline unit suites plus `agents:contracts:test`: PASS (67 total).
- Migration 29, 30, 31, and 32 fixtures: PASS.
- `npm.cmd run lint`: PASS.
- `npx.cmd tsc --noEmit`: PASS.
- `npm.cmd run build`: PASS.
- `git diff --check`: PASS after documentation and artifact updates. Git emitted only existing LF-to-CRLF working-copy notices.
- Temporary login provisioning: false. Management API provisioning: false.
- Real review mutations: 0. Provider calls: 0.

**12F.2f READY: YES.** Stop here. Do not publish, run the pipeline, or start 12F.3 in this phase.
