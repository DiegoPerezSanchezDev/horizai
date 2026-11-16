# 12F.8B — Verifier first-stage capacity and defer/resume

## Result

The Verifier first-stage capacity contract is implemented and validated locally and remotely. M35 was the only migration applied. No provider, pipeline, or scheduler run was started. `READY FOR NEXT UTC RUN` is **NO** because the required `npm run build` fails in the repository's Next/Turbopack Google Font resolver (`@vercel/turbopack-next/internal/font/google/font`); lint, TypeScript, regression suites, secret audit, and diff check pass.

## First-stage capacity sources

| Source | What is known before Verifier | Rule |
| --- | --- | --- |
| `STATIC_LIMIT` | Authoritative Groq policy config, including hard TPM 8,000 and configured output cap | Estimate the full request plus the 128-token safety margin first. If it cannot fit the hard limit, reject as `VERIFIER_INPUT_TOO_LARGE` before reservation or dispatch. |
| `LOCAL_DURABLE_USAGE` | M35 reads durable local token reservations/settlements from `agent_logs` over the rolling 60-second window under the reservation lock | If known local usage plus this request and margin exceeds the hard limit, return `DEFERRED_PROVIDER_CAPACITY` before dispatch. The reservation RPC performs the check and daily reservation atomically. |
| `FRESH_PROVIDER_HEADER` | Latest persisted Groq rate-limit telemetry and its `finished_at` timestamp; fresh only within the 15-second freshness window and before reset | If a fresh header proves insufficient remaining TPM, defer before creating a reservation. A sufficient header does not bypass the durable local reservation. |
| `STALE_PROVIDER_HEADER` | Persisted header exists but is too old, future-dated beyond tolerance, or its reset elapsed | Do not use it as remaining-capacity evidence. Continue to the local durable reservation rule. |
| `UNKNOWN_EXTERNAL_USAGE` | Provider-side usage from other clients cannot be inferred when no usable recent header exists | Missing/stale headers do not mean exhausted: do not fabricate remaining TPM and do not defer solely for unknown external use. Admit only if the static bound and atomic local reservation allow it. Unknown or inconsistent local reservation accounting is a technical failure, not capacity exhaustion. |

## Header bootstrap

The application learns Groq headers from ordinary provider responses and persists them with run telemetry. A first request cannot rely on a header from that same request. There is no probe or extra network call to bootstrap capacity. A prior persisted header is used only while fresh under the rule above.

## M33 gap

M33's durable defer/claim/release contract allowed resume from downstream stages, beginning at Editor; it did not allow Verifier or Translator. The snapshot parser and stage-specific prior-checkpoint contract also assumed a Verifier checkpoint existed before a deferred stage. A pre-dispatch Verifier defer therefore had no valid durable representation and could not be claimed by a fresh process without restarting the attempt.

## Migration decision and M35

`MIGRATION_REQUIRED: YES`. M33 was left unchanged. The sole forward migration is `20261014120000_verifier_first_stage_capacity_resume.sql` (M35). It adds M35-named service-role RPCs for defer, claim, release, and atomic Groq request/token reservation. The resume-stage contract now includes Verifier and Translator, validates the same attempt/event lineage, and preserves row/advisory locking and one claimant. M35 was the only migration in the dry-run and the only migration applied; remote migration history reports it as head.

Remote ACL check: all four M35 functions exist; `service_role` can execute them; `PUBLIC`, `anon`, and `authenticated` cannot. Direct `UPDATE` on `pipeline_event_attempts` remains denied to all four roles checked, including `service_role`.

## Verifier snapshot and fresh-process resume

The Verifier defer snapshot persists the attempt start time, attempt/run/event identity, candidate and raw-item source lineage, extracted items, event payload, deterministic Verifier source material, and empty pre-Verifier checkpoint/hash/accounting state. It records Verifier as the first missing stage, `providerRequestDispatched: false`, and a retry-neutral capacity defer. On resume, a fresh Node process claims the same attempt and reconstructs Verifier input without rediscovery or re-extraction. The offline child-process regression then continues through Translator, Editor, Classifier, Ranker, and Critic to a synthetic human-review stop.

The test asserts one attempt, one synthetic review, one raw lineage entry, no duplicate checkpoints, and no model provider calls. Verifier is the first resumed model stage.

## Provider accounting

The temporary TPM fixture starts with a synthetic durable reservation that leaves less than the request-plus-margin requirement. The Verifier request fits the intrinsic hard request bound, but its atomic local reservation is denied as temporary capacity. The request is not dispatched, no new reservation is leaked, no provider tokens are recorded, and the attempt remains retry-neutral. Resume does not reserve or dispatch twice. The remote rollback fixture exercises the lifecycle RPCs only and leaves zero synthetic attempts or Groq reservations.

## Intrinsic oversize and temporary capacity remain distinct

- Intrinsic size overflow returns `VERIFIER_INPUT_TOO_LARGE`; it is a safe candidate rejection with zero reservation and zero dispatch. Existing multi-attempt policy can continue to candidate two after that safe rejection.
- Temporary TPM shortage returns `DEFERRED_PROVIDER_CAPACITY` at Verifier for the same attempt, with `counts_toward_retry_limit: false` and `providerRequestDispatched: false`. The daily run stops before candidate two.
- Unknown external capacity is not relabeled as exhaustion. Unknown or invalid local accounting is a technical failure.

## Remote baseline and validation

Captured read-only on `2026-10-14` after M35:

- Migration head: `20261014120000` (M35).
- Real attempts: 16; active/deferred/stuck: `0/0/0`.
- M32 review status/list: HTTP 200; total/waiting reviews: `0/0`.
- Public articles: 2.
- Current fingerprints: article `6203559f-413a-4f06-9346-1720bbeb0e7a` → `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`; article `7415c685-04ed-4956-a77a-4bc372c9b060` → `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`.
- Both fingerprints match the established 12F.2d–12F.7 public baseline. The 12F.8 diagnosis artifact contains a one-character transcription discrepancy for article 2 (`...e10e833...`); the current hash and the earlier established baseline are `...e10c833...`. This phase did not edit that historical artifact or any article.
- Astra remains archived.
- Unknown Groq reservations: 0. Current UTC-day Groq, Cloudflare, and Cerebras request/token usage: 0.
- The historical 12F.8 Verifier-failure attempt still matches its recorded event/run/state/stage/reason/retry fields. Its scheduler row remains released, failed, dry-run, and `publish: false`.
- M35 rollback fixture: PASS; synthetic residual attempts: 0; synthetic Groq reservations: 0.

## Tests

Passed offline regression suites: Verifier; M35 first-stage capacity and fresh-process resume; capacity resume; M33 lifecycle; Groq capacity/header handling; Groq token budget and migration checks; provider accounting/reservation lifecycle; supervised throughput including Verifier defer stopping before candidate two; scheduler finalization/unit/execution/wiring; Editor/unit/checkpoint/numeric grounding; Critic/checkpoint; M31/M32/M34 contract fixtures; direct migration guard; secret audit.

Quality commands:

- `npm run lint` — PASS
- `npx tsc --noEmit` — PASS
- `git diff --check` — PASS (Git emitted only line-ending conversion warnings)
- `node scripts/safe-secret-audit.mjs` — PASS; 785 files scanned, 0 finding files, `.env.local` ignored.
- `npm run secret:audit:unit` — PASS
- `npm run build` — FAIL: Next 16.3.4 Turbopack cannot resolve `@vercel/turbopack-next/internal/font/google/font` from `app/layout.tsx`'s `next/font/google` import.

## Readiness

`READY FOR NEXT UTC RUN: NO` until the required application build passes. M35 and the Verifier capacity/defer/resume behavior are in place. No real supervised run was executed as part of this phase.
