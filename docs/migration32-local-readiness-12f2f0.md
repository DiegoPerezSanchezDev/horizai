# Migration 32 Local Readiness — 12F.2f.0

Scope: local-only preparation. No remote Supabase command, SQL, Management API, provider, or pipeline execution was performed. Migration 32 remains unapplied according to the supplied phase state; this phase did not query the remote project. Migration 33 is absent from the local migration directory.

## MIGRATION 32 CONTRACT

File: `supabase/migrations/20261007215233_human_review_operator_read_rpc.sql`.

The migration defines three read-only `jsonb` RPCs. All are `LANGUAGE plpgsql`, `STABLE`, and `SECURITY DEFINER`, with the fixed `search_path = pg_catalog, public`. They read migration-31 review state and, for status counts, the pipeline-attempt and agent-log tables. They contain no dynamic SQL or data mutation statements.

### STATUS RPC

`public.get_pipeline_human_review_operator_status()` takes no arguments. It returns the UTC reporting date/time and aggregate counts for total, waiting, held, rejected, approved, consumed, publishing, and published reviews, plus today's candidate/attempt/failure counts, active/stuck work, and Groq request/token/unknown-usage totals. Empty state is represented by numeric zero counts.

### LIST RPC

`public.list_pipeline_human_reviews_operator(p_limit integer default 100)` rejects null or out-of-range limits with SQLSTATE `22023`; allowed values are 1–500. It returns at most the requested number of summary rows in deterministic `created_at DESC, id DESC` order, together with `publishedToday`, `returned`, and `limit`. It omits full source lineage, decision history, reviewer identity, and editorial/source bodies. The included review manifest and digest fields let the server bind a summary to the local immutable review package.

### INSPECT RPC

`public.get_pipeline_human_review_operator_inspect(p_review_id uuid)` rejects a null ID with SQLSTATE `22023`. A missing UUID returns the typed result `{ found: false, review: null, publishedToday: n }`; it does not expose SQL text. A found result carries the migration-31 review row, lineage, manifest, decision history, and state fields.

Migration 31 stores the review identity, hashes, lineage, manifest, Critic/accounting state, and human-review state, not the complete editorial package. The runtime inspector combines the RPC row with the server-side immutable review artifact and validates package/row bindings. That combined runtime result contains the headline, summary, why-it-matters, body, source URLs, Verifier/attribution/uncertainty evidence, Critic findings, classification, geo, ranking, provider accounting, manifest, and review state. The migration itself is not described as returning editorial content that it does not store.

## SECURITY

- Each RPC rejects callers whose `auth.role()` is not `service_role` with SQLSTATE `42501` and the typed message `human_review_operator_read_forbidden`.
- `EXECUTE` is revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role` before it is granted back to `service_role` only.
- No `SELECT` or other direct table privilege is granted on `public.pipeline_human_reviews`; migration 31 retains the table-level revoke.
- Table references are schema-qualified. The functions have a fixed search path, no dynamic SQL, and no mutation statements.
- The list is bounded at 500 and excludes raw/editorial body data.

## RUNTIME ALIGNMENT

The server-only repository calls the exact RPC names and argument keys: status `{}`, list `{ p_limit }`, inspect `{ p_review_id }`. Strict Zod schemas validate the status aggregate, the summary row, the full inspect row, nested lineage/manifest fields, action/status correspondence, list bounds, and not-found shape. Unknown or malformed fields fail closed with typed local errors. Operator list output uses the summary response; inspect, decision, and publish checks use the inspect RPC and the locally verified package.

Offline fixtures cover empty, waiting, hold, reject, approve, consumed, and published states; zero-count status; list and inspect; and not-found inspection. No RPC was called remotely during this phase.

## DIRECT MIGRATION CONNECTION

The required variable name is `SUPABASE_DIRECT_DB_URL`. The guard accepts only a PostgreSQL URL with scheme, host, username, password, and database path. It fails before child-process creation with `DIRECT_MIGRATION_CONNECTION_REQUIRED` when absent, and with `DIRECT_MIGRATION_CONNECTION_INVALID` when malformed. The variable is not present in the current process environment; `.env.local` values were not read. The future remote runner must supply this variable after credential rotation.

`npm run supabase:status` and `npm run supabase:db:push` now enter the guarded local script. It permits only migration history or push, requires migration 32 to be present and no later migration, and passes the explicit `--db-url` option to the CLI without printing the command or URL. CLI output is sanitized before display. The child environment strips the direct URL variable, server keys, Supabase access token, and provider credentials. The CLI interface receives the direct URL as an argument, so do not enable shell tracing or command-line logging around the future run.

## AUTO-LOGIN FALLBACK GUARD

The guarded path does not use `npx`, `npm exec`, `supabase link`, `--linked`, a project ref, or temporary-login provisioning. It requires a local Supabase CLI executable and an explicit direct URL before spawning it. If the executable is missing, it fails with `LOCAL_SUPABASE_CLI_EXECUTABLE_REQUIRED`; there is no download or linked-project fallback. No CLI process was started in this phase. The unit fixture proves a missing direct URL causes zero spawn calls.

No local Supabase CLI executable is currently present. Install/provide the local executable after the parallel task is complete and before remote history/apply; the guarded scripts will not download one.

## SAFE SECRET AUDIT

`scripts/safe-secret-audit.mjs` scans tracked and non-ignored repository files plus added lines in the working diff. It excludes `.env.local` from file reads and separately verifies that Git ignores that path. Its output contains only relative path, category, and presence; it never emits matched text or values. The unit fixture uses assembled synthetic credentials and verifies report redaction.

The first local scan found five Supabase private-key-shaped strings in three artifacts, one document, and one script from earlier work. They were replaced with `[REDACTED_SUPABASE_PRIVATE_KEY]` without displaying or otherwise inspecting their values. The final repository scan reports zero findings across 667 files; `.env.local` is ignored and untracked. `SUPABASE_DIRECT_DB_URL` is absent from the current process environment. No secret value was printed in this phase.

Environment variable names found in repository configuration/code:

- Public Supabase client: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, legacy fallback `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Private Supabase server client: `SUPABASE_SECRET_KEY`; one legacy script also accepts `SUPABASE_SERVICE_ROLE_KEY`.
- Direct migration connection: `SUPABASE_DIRECT_DB_URL`.
- Groq/shared agent credential: `AGENT_API_KEY`.
- Cloudflare: `CLOUDFLARE_AI_API_TOKEN` (and account configuration `CLOUDFLARE_ACCOUNT_ID`).
- Cerebras: `CEREBRAS_API_KEY`.

Only names are recorded here; no values were read from `.env.local` or reported.

## ROTATION HANDOFF

After the parallel task is finished:

1. Revoke/rotate the exposed Supabase server credential.
2. Update local/runtime environment with the new value.
3. Restart processes that may still hold the old credential.
4. Confirm `.env.local` remains ignored by Git.
5. Configure `SUPABASE_DIRECT_DB_URL` with the explicit direct PostgreSQL connection.
6. Resume 12F.2f remote execution only after those steps.

Credential rotation is `PENDING` by instruction and is expected for this local phase. This phase did not perform rotation.

## POST-ROTATION EXECUTION PLAN

After Diego confirms the parallel task is complete and credentials are rotated, perform the separately authorized remote phase in this order: safe private GET; sanitized secret audit; verify the direct connection and local CLI executable are present; migration-history precheck; apply migration 32 once; call status/list/inspect with a nonexistent ID; verify RPC ACLs and direct-table denial; capture a fresh review baseline and public fingerprints; then run the agreed regressions. Do not execute any step in this list during local preparation.

## TESTS

Local checks include migration-32 SQL/runtime contract fixtures, migration fixtures 29–32, all 66 offline unit suites, lint, TypeScript, build, repository secret audit, and `git diff --check`. All passed. The production build ran in an isolated copy without env files and with `--webpack`; Next's Google Font fetch was replaced by a local mock backed by an installed font file. The default Turbopack attempt on the isolated copy stopped on its out-of-project `node_modules` junction restriction, so no claim is made that this was a default Turbopack build. Results are recorded in the adjacent JSON artifact. Remote/provider call counts are zero.

## READINESS

`12F.2f.0 READY = YES` only when the listed local regression suites and static checks pass. This means local preparation is ready; it does not mean migration 32 is applied, credentials are rotated, a direct connection is configured, or remote verification has taken place. After readiness, stop and wait for confirmation that the parallel task is finished. Do not start 12F.3.
