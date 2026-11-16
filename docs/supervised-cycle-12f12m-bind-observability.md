# 12F.12M — M38 revision bind observability

## Scope and current result

This phase improves error visibility for the existing `bind_pipeline_human_review_revision` path and authorizes at most one additional bind. It does not approve, hold, reject, publish, run the pipeline, or change a migration. No bind was attempted in this phase because the Supabase hostname still failed DNS resolution (`ENOTFOUND`) at preflight.

## Error masking point

The RPC path is `scripts/supervised-cycle-12f12l-bind-human-revision.ts` → `SupabaseHumanReviewRepository.bindRevision` in `lib/agents/publisher/human-review-repository.ts` → Supabase JS PostgREST RPC → M38.

The repository previously converted `response.error` into a new `Error` containing only a regex-matched fragment of `message`, or `HUMAN_REVIEW_REVISION_BIND_FAILED`. That discarded `code`, `details`, `hint`, the response `status`, and any transport `cause`. The runner's final catch then replaced messages outside a narrow safe-character pattern with the same generic failure. The PostgREST client exposes `message`, `details`, `hint`, and `code` on its error object; HTTP `status` is on the RPC response object, not the `PostgrestError` instance.

## RPC error adapter

`lib/supabase/safe-rpc-error.ts` normalizes only the safe diagnostic fields: operation, HTTP status, PostgREST code, SQLSTATE, message, details, hint, cause name, and cause message. A five-character PostgreSQL error code is reported as `sqlState`; `PGRST...` codes remain `postgrestCode`. Missing fields become `null`. Runtime credential values, bearer/JWT forms, database URL credentials, and the bind's draft/source strings are redacted before logs or artifacts. The original error object and stack are never persisted. Successful RPC parsing and the returned repository value remain unchanged.

## M38 contract and caller matrix

The deployed-source migration `supabase/migrations/20261020130000_human_review_revision_binding.sql` declares nine RPC parameters. The application builder now centralizes the exact serialization, and local tests compare every argument name and value category:

| Parameter | M38 type | Caller value | Result |
| --- | --- | --- | --- |
| `p_review_id` | `uuid` | existing review UUID | PASS |
| `p_expected_original_draft_sha256` | `text` | lowercase 64-character SHA-256 | PASS |
| `p_original_draft` | `jsonb` object | reviewed original draft fields | PASS |
| `p_original_publication_payload` | `jsonb` object | unchanged original publication payload | PASS |
| `p_corrected_draft` | `jsonb` object | corrected revision fields | PASS |
| `p_corrected_publication_payload` | `jsonb` object | original payload with only corrected article fields | PASS |
| `p_source_lineage` | `jsonb` array | artifact source lineage | PASS |
| `p_corrected_revision_sha256` | `text` | lowercase 64-character SHA-256 | PASS |
| `p_human_revision_proof` | `jsonb` object | schema-versioned operator attestation | PASS |

There is no standalone actor parameter or revision-version parameter. Actor class is part of the proof object; M38 supplies revision version 1 by table default. Static review found no parameter-name, JSON-shape, hash-field, or status-string mismatch. The root cause of the two historical failures therefore remains `INSUFFICIENT_EVIDENCE` until the newly preserved RPC error is observed.

## State preconditions and failed-call atomicity

The runner requires `WAITING_FOR_HUMAN_REVIEW`, unconsumed review, original approval target, zero existing revision, unchanged original and lineage hashes, and intact Critic/M34 proof before the bind. These checks were present in the prior 12F.12L runner and are retained. The current remote values could not be rechecked because DNS failed.

M38 performs one revision insert and then the guarded review-target update inside one PostgreSQL function invocation. It has no autonomous transaction, commit, rollback handler, or audit/log insert. An exception aborts the RPC statement transaction, so the insert and target update roll back together. The prior 12F.12L post-failure reads observed no revision and an unchanged original target after both failures. That is historical evidence, not a fresh 12F.12M read. This phase did not delete or alter failed-call history.

## Fix and migration

The only change is application-side error observability and focused contract tests. No speculative business-logic change was justified by the available evidence. Migration: `NONE`; M38 remains unchanged; M39 was not created.

## Local tests

The binding unit test covers exact RPC serialization, successful response compatibility, review-state guards, original/corrected hashes, source lineage, revision insertion/reuse guards, atomic SQL structure, original-draft preservation, stale-approval rejection, and corrected Publisher targeting. The RPC-error unit test covers PostgREST code, SQLSTATE, message/details/hint, transport cause, absent fields, non-`Error` inputs, and secret/content redaction.

Lint, TypeScript, build, `git diff --check`, and the secret audit are recorded in the JSON artifact. No test invokes Supabase or any provider.

## Final preflight and bind

The latest DNS probe returned `ENOTFOUND`; no PostgREST request, remote read, or bind RPC was sent in this phase. The final preflight is `BLOCKED_DNS`; additional bind attempts in this phase: `0 of 1`; bind: `NOT_RUN`. The new runner persists the exact sanitized RPC failure and performs read-only reconciliation if the single authorized bind is eventually attempted and rejected.

Approval remains not ready. Do not approve, hold, reject, publish, or retry until a later authorized run has a successful remote preflight and the one guarded bind outcome is known.
