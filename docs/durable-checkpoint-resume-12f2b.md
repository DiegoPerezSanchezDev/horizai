# 12F.2b — Durable checkpoint resume contract

**Readiness: NO.** The durable checkpoint fixes and offline lifecycle regressions pass, but the required fresh private remote baseline was not available through an established read-only path. No migration, real pipeline run, provider call, article write, attempt mutation, review action, Publisher call, or scheduler activation was performed.

## HISTORICAL 12F.2 LIMITATION

The 12F.2 attempt recorded in `artifacts/second-real-supervised-cycle-12f2.json` is attempt `3ebda423-2aa6-4f3a-b119-53982fbf58d9`, run `543f00ff-6d68-4661-b170-b316e0d9b067`, event `event-b528bc50495484add3d2544579f47846`. Its recorded final state is `TECHNICAL_FAILURE`, stop stage `classifier`, stop reason `PROVIDER_CAPACITY_EXHAUSTED`, and `counts_toward_retry_limit=true`. It is terminal and is not resumed or repaired here.

The historical Editor file was inspected read-only at `artifacts/pipeline-checkpoints/543f00ff-6d68-4661-b170-b316e0d9b067/editor-event-b528bc50495484add3d2544579f47846.json`. It contains `schemaVersion`, `eventKey`, `canonicalTitle`, `event`, `verification`, `translation`, and `sources`. It has no `editorial` property. The missing `EditorialDraft` fields are `schemaVersion`, nested `eventKey`, `headlineEs`, `dekEs`, `summaryEs`, `whyItMattersEs`, `bodyEs`, `keyPoints`, and `suggestedSlug`.

## CHECKPOINT MATRIX

| Completed model stage | Durable data for the next stage | Result |
| --- | --- | --- |
| Verifier | Full `VerificationResult`, event/source state, and the canonical Translator model input | COMPLETE |
| Translator | `TranslationResult` is now stored as `translationResult`, alongside verification and source data | COMPLETE |
| Editor | Full validated `EditorialDraft` is now stored in `editorial` | COMPLETE |
| Classifier | Classification output plus the event, verification, translation and editorial projections used by Ranker | COMPLETE |
| Ranker | Ranking result and the complete canonical Critic input, including bounded source evidence and geo data | COMPLETE |
| Critic | Critic output plus full canonical event, compact source/raw-item lineage, and all six settled provider-accounting summaries needed to rebuild review evidence; the immutable stage checkpoint files remain available for the review manifest | COMPLETE |

## ROOT CAUSE

`SERIALIZATION_OMISSION`. The production Editor stage received and validated `result.output`, but its checkpoint builder serialized only event, verification, translation, and sources. The strict Zod schema also had no `editorial` field. Zod did not strip an output field; the production object never supplied it. The 12F.2 historical file therefore cannot be reconstructed without repeating the Editor provider call.

The same trace found a Translator gap: the Translator checkpoint persisted its model input but omitted its successful `TranslationResult`. Both output fields are now part of the existing v1 JSON checkpoint shapes as optional fields for legacy read compatibility. Production post-stage writers set them; old checkpoints without those fields remain readable but do not satisfy the new durable output contract.

## DURABLE RESUME CONTRACT

Each successful model stage writes its validated canonical result before the pipeline advances. A capacity snapshot is created immediately before the next eligible provider stage, after the required prior checkpoints and settled telemetry exist. Resume stages are `classifier`, `ranker`, and `critic`.

The snapshot contains the exact event, extracted evidence and source/raw-item lineage, the prior canonical outputs, references and hashes for all completed model checkpoints, and settled accounting for those stages. Snapshots use distinct stage/generation filenames. Resume validates the snapshot schema, identity, lineage, attempt stop stage, checkpoint hashes, settled usage, next-stage zero-dispatch/no-checkpoint state, ownership, and terminal rejection state. It starts at the first missing provider stage and never invokes a previous stage writer.

The Critic checkpoint now also stores a compact `reviewPackageContext`: the full clustered event, raw-item IDs/content hashes/canonical URLs, and normalized settled usage for Verifier, Translator, Editor, Classifier, Ranker, and Critic. The review-package regression reconstructs the package from the reloaded Critic checkpoint plus the immutable checkpoint files and the source-registry URL lookup. This avoids depending on vanished in-memory outputs or copying full extracted article bodies into the Critic checkpoint.

No database schema change was needed. No migration was created or applied; migration 32 was not created.

## EDITORIAL DRAFT PERSISTENCE

Production Editor checkpoint writing now includes the exact `result.output` as `editorial`. The writer then reloads the checkpoint through the production reader and only reports a valid checkpoint when the editorial event key matches. The reloaded `EditorialDraft` is parsed again by its strict schema and passed to the existing Classifier input builder.

Translator production checkpoint writing now includes its exact validated `result.output` as `translationResult`; the reloaded result is passed to the existing Editor input builder.

## SERIALIZATION ROUNDTRIP

The offline regression uses the exact production writer and reader for all six model stages. It discards each written in-memory checkpoint and calls the next-stage input builder with the reloaded payload:

`Verifier → Translator`, `Translator → Editor`, `Editor → Classifier`, `Classifier → Ranker`, `Ranker → Critic`, and `Critic → human-review package` all pass. The Editor case explicitly parses the reloaded `EditorialDraft` and builds Classifier input. The Critic case reconstructs a review package from the durable Critic checkpoint context and immutable checkpoint files.

## FRESH-PROCESS RESUME

The synthetic pipeline writes a deferred attempt and snapshot, exits the parent Node process, and resumes in a child Node process. The attempt row is serialized and restored into a new registry instance. Successful prior stage checkpoint hashes are compared before and after resume; the bytes remain unchanged.

## CAPACITY DEFER AT EACH STAGE

| Pre-dispatch stop | Fresh-process continuation | Calls after restart |
| --- | --- | --- |
| Classifier | `WAITING_FOR_HUMAN_REVIEW` | Classifier, Geo, Ranker, Critic |
| Ranker | `WAITING_FOR_HUMAN_REVIEW` | Ranker, Critic |
| Critic | `WAITING_FOR_HUMAN_REVIEW` | Critic |

Every case keeps the original single attempt, uses retry-neutral capacity state, repeats no completed provider stage, and never calls Publisher. Provider calls in these tests are zero; stage outcomes and telemetry are local deterministic fixtures.

## NEGATIVE CASES

Resume is rejected for missing or invalid output payloads, changed checkpoint hashes, unsettled provider usage, changed source/raw lineage, changed event or attempt identity, nonzero next-stage dispatch history, an existing next-stage checkpoint, an active owner, a finalized attempt, or terminal editorial rejection. A malformed or missing `EditorialDraft` cannot become a resumable Classifier snapshot.

## HISTORICAL ATTEMPT POLICY

Classification: `HISTORICAL_TERMINAL_NOT_RESUMABLE` because the recorded attempt is finalized as `TECHNICAL_FAILURE` and its Editor checkpoint lacks the required durable `EditorialDraft`. The historical attempt, Editor file, provider accounting, and scheduler record were not modified. No replacement attempt was created.

## REMOTE BASELINE REFRESH

The established public-content route uses the publishable/anonymous Supabase key and reads only `public_published_articles`. A fresh HTTP GET through that public view returned count **2** and the same two slugs recorded in 12F.2. The view does not expose article IDs or `metadata`, so it cannot reproduce the historical comparable MD5 expression:

`md5(concat_ws(chr(31), slug, headline_es, coalesce(summary_es,''), coalesce(why_it_matters_es,''), coalesce(body_es,''), metadata::text))`.

The view also cannot refresh private Astra status, real attempt count, waiting-review count, provider accounting, or active/deferred attempt state. No service-role or write-capable DB credential was used as a read workaround. Those private baseline values are **not freshly verified**. The last available saved record reports Astra archived, but that is historical evidence, not a current read.

Historical expected article IDs and hashes from the saved baseline are:

- `6203559f-413a-4f06-9346-1720bbeb0e7a` — `ccef966880d85663b8fd5049e9995f5f`
- `7415c685-04ed-4956-a77a-4bc372c9b060` — `4cf1ecf2990a5dca582c95e5733a484f`

Current comparable hashes: **UNAVAILABLE**. Unchanged hashes: **UNVERIFIED**. This baseline gap keeps readiness at NO.

## PRIVATE BASELINE REFRESH — 12F.2c

**Captured 2026-10-07 UTC; read-only.** The missing evidence was refreshed using the already-established `createSupabaseServerClient()` path with `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY`, loaded from `.env.local`. The selected credential class was `sb_secret` format, non-JWT. Secret values were not printed or rotated.

The private health query was a HEAD/count read of `pipeline_event_attempts`: HTTP **200**, no PostgREST code, response `Date: Wed, 07 Oct 2026 21:10:55 GMT`, local request start `2026-10-07T21:10:56.203Z`; count 10. Subsequent private PostgREST reads also returned HTTP 200. Review state was read through the existing `pipeline:human-review status/list` SQL helper because direct review-table SELECT is intentionally unavailable. The first parallel `list` invocation returned the generic CLI wrapper error; a serial retry succeeded and returned an empty review list. The initial error cause was not established and is not attributed to Supabase auth.

**Read-path safety caveat:** the linked SQL CLI printed `Initialising login role...` for the literal hash query. Inspection of the [Supabase CLI database connection code](https://github.com/supabase/cli/blob/develop/apps/cli-go/internal/utils/flags/db_url.go) shows that this path calls the Management API to provision a CLI login role with `ReadOnly: false`. At least one such temporary-role provisioning occurred; the exact number and its expiry/cleanup state were not captured. This is a remote control-plane mutation and is not strictly read-only. No attempt was made to delete it, since deletion would be another remote mutation. This invalidates the requested `remote writes = 0` condition even though application data rows did not change.

The fresh canonical public rows are the two expected published articles. Their MD5s were also checked by a read-only linked SQL query using the literal historical PostgreSQL expression and `ORDER BY a.id`:

| ID | Slug | Publication state | Historical MD5 |
| --- | --- | --- | --- |
| `6203559f-413a-4f06-9346-1720bbeb0e7a` | `openai-emplea-agentes-para-escanear-el-sitio-de-estadisticas-de-la-onu-mas-de-16-000-veces` | published | `ccef966880d85663b8fd5049e9995f5f` |
| `7415c685-04ed-4956-a77a-4bc372c9b060` | `mas-de-mil-fallecidos-tras-fallas-en-torres-de-vigilancia-fronteriza` | published | `4cf1ecf2990a5dca582c95e5733a484f` |

Both hashes match the historical values exactly. The SQL expression was `md5(concat_ws(chr(31), a.slug, a.headline_es, coalesce(a.summary_es,''), coalesce(a.why_it_matters_es,''), coalesce(a.body_es,''), a.metadata::text))`; rows were ordered by `a.id`. The full canonical fields were read, while the evidence artifact stores their current values.

Astra article `756b0ee0-b5e6-4153-846f-278a12c9afe3` remains `archived`. There are 10 real pipeline attempts, 0 active, 0 deferred-capacity, and 0 stuck. The historical 12F.2 attempt remains `TECHNICAL_FAILURE` / `PROVIDER_CAPACITY_EXHAUSTED`, terminal, with its original completion and retry fields. Review list count is 0 and `WAITING_FOR_HUMAN_REVIEW` count is 0.

For UTC day `2026-10-07`, the existing Groq ledger has 3 reserved and dispatched requests, 4,458 input tokens, 929 output tokens, and 5,387 settled total tokens. All 3 dispatched reservations are settled; unknown dispatched reservations are 0. Cloudflare, Cerebras, and other-provider reservation rows are 0 for the day. No current persisted provider rate-limit block was found; the schema has no separate durable temporary-capacity state field. The latest scheduler lease is released, there are 0 active leases, and the same latest-run identity/state was observed before and after the local regressions.

Before/after checks across the offline regression commands showed no change to public count or hashes, Astra state, real attempt count or historical attempt state, review counts, daily provider ledger, or scheduler lease state. Application data writes, attempt/review/accounting mutations, scheduler changes, and provider calls were all **0**. However, because the CLI provisioned a temporary write-capable login role, total remote mutations were **not zero** and the phase cannot satisfy its absolute read-only condition.

The precise snapshot and test results are in [the 12F.2c evidence artifact](../artifacts/private-baseline-refresh-12f2c.json).

## TESTS

The checkpoint roundtrip and capacity-resume suites, migration fixtures 29, 30, and 31, lint, TypeScript, build, and `git diff --check` all pass; results are recorded in `artifacts/private-baseline-refresh-12f2c.json`. No real pipeline or provider test was run. The supervised command remains `npm.cmd run pipeline:supervised:run -- --execute-supervised`.

## READINESS

Local durable checkpoint and fresh-process resume regressions are complete. The private baseline values and exact historical hashes were refreshed, but the linked SQL CLI provisioned a write-capable temporary login role. **12F.2c READY = NO; 12F.2b FINAL READY = NO** because the required zero-remote-writes condition was not met. Public count and hashes match; Astra is archived; attempts/reviews/accounting are known; application rows did not change; provider calls were 0.

## NEXT

12F.3 remains gated and was not started. Do not proceed until the read-path side effect and zero-remote-writes requirement are resolved under a separately authorized plan.
