# 12F.9B — M36 accounting window migration and validation

## Result

**ACCOUNTING_WINDOW_BUG: FIXED. READY FOR NEXT UTC RUN: YES.**

M36 was applied once on 2026-10-16. Remote migration head is `20261015120000`; M35 remains present and M36 is present exactly once. This phase executed no real pipeline or scheduler run and made no provider calls. The next supervised run requires its own authorized preflight; none was started here.

## Observation and scope

12F.9A proved that `reserve_groq_request_and_tokens_m35` included 46 terminal, request-only legacy reservations indefinitely because their dispatch markers were absent. Their missing token fields produced `GROQ_TPM_LOCAL_USAGE_UNKNOWN` even with no current usage. The application already admitted a first request without response-derived headers.

The fix is one forward migration: `supabase/migrations/20261015120000_groq_tpm_accounting_window.sql`. Historical migrations, reservations, 12F.9 outcomes, and the consumed `supervised-candidates:2026-10-15` scheduler row remain unchanged. No dependency, font, visual, or build-toolchain change was made.

## SQL review and accounting authority

A reservation can leave the rolling TPM selection as legacy state only when all of these conditions hold:

1. Both token unit fields are null; payload is an object with none of `providerRequestDispatched`, `dispatchedAt`, `estimatedTokens`, or `tokenUsageState`.
2. Its owning Groq run is `succeeded` or `failed`, with a non-null finish timestamp.
3. No attempt with incomplete or ambiguous terminal state is linked by the run's pipeline ID or event key.
4. The latest run start, finish, update, or reservation creation timestamp is at least 60 seconds old.

The age bound is the existing TPM window. Lifecycle proof is also mandatory. There are no calendar cutoffs, special sources, known IDs, or blanket expiry of active reservations. Taking the latest timestamp accommodates the previously observed client/server clock ordering while retaining recently updated terminal runs.

| State | Accounting authority after M36 |
| --- | --- |
| Active reservation with known tokens | Counts, including an explicit undispatched hold across minute/day boundaries |
| Active request-only reservation without a dispatch marker | Remains unknown and blocks admission safely |
| Dispatched request | Counts in rolling TPM by dispatch time, falling back to creation time; daily reservation accounting is preserved |
| Released pre-dispatch reservation | Existing guarded release removes the hold; no dispatched request is erased |
| Terminal succeeded/failed legacy run | Can leave rolling TPM only with the complete proof above |
| Deferred attempt | Existing M33/M35 state, claim, stage, retry-neutrality, and release semantics are preserved; a linked live attempt prevents legacy retirement |
| Unknown/inconsistent current state | Technical refusal; malformed data is never treated as an empty successful read |

Both the TPM sum and unknown-row count use the same retirement predicate. Explicit modern holds and partially populated modern rows cannot take the legacy exception. M36 also refuses a non-boolean dispatch marker within the relevant window.

## Windows and limits

| Window | Preserved contract |
| --- | --- |
| TPM | Rolling 60 seconds, with the existing inclusive dispatch cutoff and retained unreleased holds |
| RPD | Reservation creation in `[UTC midnight, next UTC midnight)` |
| TPD | Same UTC reservation day; estimated tokens remain until trustworthy actual usage settles the row |
| RPM | Existing configured/readiness limit. The RPC does not independently implement an atomic rolling RPM counter; M36 adds none. Sequential execution and the 18-request run cap remain unchanged |

Daily selection and the M25 reservation delegate are unchanged. Empty successful reads establish `KNOWN_ZERO`; valid current usage establishes `KNOWN_USAGE`. Failed/partial reads remain technical failures. Local accounting never invents external remaining TPM: external capacity is still `UNKNOWN` before the first response.

Temporary proven local TPM insufficiency returns `GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED`. Application regressions prove its mapping to `DEFERRED_PROVIDER_CAPACITY`, same attempt, Verifier resume, `counts_toward_retry_limit=false`, and `providerRequestDispatched=false`. Intrinsic oversize remains `VERIFIER_INPUT_TOO_LARGE` before dispatch. A synthetic provider-side 429 remains one dispatch, zero retries, retained estimate, unknown actual usage unless supplied, and no M35 pre-dispatch resume.

## PostgreSQL validation and deployment

**LOCAL_POSTGRES: UNAVAILABLE.** Docker's local engine was unavailable and no standalone PostgreSQL executable was found. No local SQL pass is claimed.

The direct-connection guard loaded `.env.local` through Node's repository-standard environment loader. No credential was printed, temporary login provisioned, or Management API used. Dry run showed exactly M36, no M35 replay, no seeds, and no role changes.

Before application, a remote PostgreSQL preview replaced the function inside a subtransaction, ran the exact final fixture, then forced rollback. It verified that the original function definition hash was restored. All assertions passed. After 39 offline suites, lint, TypeScript, build, diff check, and secret audit passed, the guarded runner rechecked the dry run and invoked migration push exactly once. An exclusive local invocation record prevents replay by that runner.

Migration SHA-256: `3c04c3366e4d4b86ca6a56bc3ca53ecfbe1dcfc1586248bf27e0992de60efbdf`.

Remote function definition MD5 changed from `59300a19e13c97b0a07bebcfa360324d` to `0ee971fbddc9c7dcc705e13e797f0523`. The deployed function body also matches the final migration by MD5 after removing CR characters. Identity, owner, ACL, and search path are unchanged.

## Transactional remote fixture

The same 14-case fixture passed both in the preview and against deployed M36. Every case uses fresh UUIDs under a fresh `12f9b:` namespace. Each case rolls back its writes through a checked subtransaction exception. Unexpected exceptions propagate and fail the command.

| Case | Assertion |
| --- | --- |
| 1 | Actual remote empty minute/day admits a synthetic request: usage before = 0, no UNKNOWN refusal, no provider headers needed |
| 2 | Expired terminal succeeded request-only legacy row does not poison TPM |
| 3 | Expired terminal failed request-only legacy row does not poison TPM |
| 4 | Old explicit active hold of 7800 tokens still counts and refuses a 1000-token request plus 128-token margin |
| 5 | Active unmarked legacy reservation remains unknown and blocks |
| 6 | Current known usage of 1000 admits another 1000 atomically, yielding minute usage 2000; daily usage remains correct |
| 7 | String-valued dispatch marker causes safe UNKNOWN refusal |
| 8 | Terminal legacy owner linked to an active attempt cannot retire its reservation |
| 9 | Linked deferred attempt remains unchanged and prevents retirement |
| 10 | Real M35 Verifier defer/claim/admission/release reuses the same synthetic attempt without charging a retry |
| 11 | Explicit undispatched reservation with null tokens remains unknown |
| 12 | Malformed dispatch timestamp raises a technical error |
| 13 | Recently updated terminal owner cannot retire its legacy reservation |
| 14 | Actual anon/authenticated calls fail; service_role succeeds |

The first case executes against the actual 46 historical reservations still present. A separate read-only inspection proves all 46 satisfy the generic retirement conditions. After M36, zero of them qualify as current pending reservations. Their individual full-row hashes match before and after. No historical row was cleaned, modified, or deleted.

Final remote residual counts: synthetic runs **0**, attempts **0**, reservations **0**. There are no permanent synthetic rows. Fixture writes and preview DDL were rolled back; committed application-data writes are **0**. The only committed schema change was M36.

## Security and regression evidence

Service role EXECUTE passes. PUBLIC, anon, and authenticated are denied. SECURITY DEFINER and `search_path=pg_catalog, public, pg_temp` are preserved. All 16 public table ACLs match, as do six related M25/M33/M35 function hashes. Provider/day advisory locking and atomic daily delegation remain intact. Production migration code adds no dynamic SQL or privilege grants.

All **39 focused offline suites pass**. Coverage includes Groq accounting/windows, bootstrap and synthetic 429, Verifier compaction/oversize, temporary capacity, M33/M35, fresh-process resume, throughput/18-request cap/concurrency 1/retries 0/fallback 0, Editor grounding, Critic/M34 proof, scheduler finalization, and selector diagnostics. The M36 suite also checks that the preview embeds the exact final function and identical post-migration fixture.

| Gate | Result |
| --- | --- |
| `npm.cmd run lint` | PASS |
| `npx.cmd tsc --noEmit` | PASS |
| `npm.cmd run build` (`next build --webpack`) | PASS |
| `git diff --check` | PASS |
| `node scripts/safe-secret-audit.mjs` | PASS; no findings; `.env.local` ignored |

The pre-existing `NEXT_PUBLIC_SITE_URL` warning remains: indexing metadata is disabled for this local configuration. No change was made to that unrelated setting. Visual validation is not applicable to this database-only change.

## Remote baseline and closure

Before/after captures at `2026-10-16T07:33:48.895Z` and `2026-10-16T07:46:09.835Z` match all complete attempt, agent-log, agent-run, article, and consumed-trigger row hashes:

- Attempts **17**; active/deferred/stuck **0/0/0**.
- Reviews/WAITING **0/0**; M32 status/list **PASS**.
- Public **2**; Astra **ARCHIVED**.
- Current-day unknown reservations **0**; Groq, Cloudflare, and Cerebras accounting delta **0**.
- Historical 12F.9 and the consumed October 15 trigger **UNCHANGED**.
- Public fingerprints remain `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64` and `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b` using unchanged `publicArticleFingerprintV1`.

Actual UTC validation day was October 16. No assumption that October 16's trigger is consumed was used to authorize any execution. No pipeline command, scheduler mutation, publication, human action, or commit was performed. This phase stops after M36 validation.

Evidence index: `artifacts/supervised-cycle-12f9b-m36.json`, with linked baseline, comparison, migration, ACL, fixture, and test artifacts. **READY FOR NEXT UTC RUN: YES.**
