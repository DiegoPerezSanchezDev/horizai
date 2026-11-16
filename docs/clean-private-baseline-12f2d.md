# 12F.2d — Clean application private baseline

## WHY 12F.2c REMAINS NOT READY

12F.2c remains **READY NO**. Its linked Supabase CLI SQL path printed `Initialising login role...`; the reviewed CLI implementation provisions a temporary login through the Management API with `ReadOnly: false`. The exact number of provisioning requests and any expiry or cleanup were not captured. This phase does not attempt to remove that login and does not rewrite the historical result.

## CLI SIDE EFFECT

12F.2c's side effect was in audit infrastructure. The stored evidence says application data, provider accounting, scheduler state, and publication state were not mutated, and provider calls were zero. The strict infrastructure-write condition was nevertheless not met or provable. In 12F.2d, Supabase CLI was not invoked and no Management API or temporary login provisioning was initiated.

## APPLICATION PRIVATE READ PATH

The existing `createSupabaseServerClient()` helper was used with `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` from `.env.local`. The credential was classified by format as `[REDACTED_SUPABASE_PRIVATE_KEY]`; its value was not printed. The read runner is [clean-private-baseline-read-12f2d.ts](../scripts/clean-private-baseline-read-12f2d.ts).

The runner observed 13 PostgREST requests: 2 `HEAD` and 11 `GET`, all HTTP 200. The health read was `HEAD /rest/v1/pipeline_event_attempts`, count 10, PostgREST code null, response date `Wed, 07 Oct 2026 21:32:23 GMT`; local capture interval was `2026-10-07T21:32:24.041Z` to `2026-10-07T21:32:26.223Z`. The runner rejects any non-GET/HEAD or non-PostgREST request. It contains no CLI, RPC, or write path.

## AUTH BOUNDARY

Only the existing server helper and its configured server credential were used. Secret values were neither logged nor copied to the report. Reads were ordinary application/server PostgREST requests; no database login, migration-aware connection, Management API call, or new authentication mechanism was used.

## FRESH PRODUCT BASELINE

The fresh read returned two `published` rows from `public.articles`. Their IDs and substantive fields match the rows recorded in 12F.2c. The exact fields and current `publicArticleFingerprintV1` values are in `artifacts/clean-private-baseline-12f2d.json`.

- Article `6203559f-413a-4f06-9346-1720bbeb0e7a`: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`
- Article `7415c685-04ed-4956-a77a-4bc372c9b060`: `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`

The two historical PostgreSQL MD5 values remain preserved as prior evidence. This phase did not re-run SQL to reproduce those MD5 values. The new application fingerprint is a separate contract and is not comparable to the historical MD5.

## HISTORICAL MD5 EVIDENCE

Preserved from 12F.2c:

```text
md5(concat_ws(chr(31), a.slug, a.headline_es,
  coalesce(a.summary_es,''), coalesce(a.why_it_matters_es,''),
  coalesce(a.body_es,''), a.metadata::text))
```

Algorithm: PostgreSQL MD5. Field order: `slug`, `headline_es`, `summary_es`, `why_it_matters_es`, `body_es`, `metadata`. Serialization: PostgreSQL `jsonb::text` for metadata and `concat_ws` with ASCII 31 separators. Summary, why-it-matters, and body NULL values were converted to empty strings; there was no trimming, case folding, whitespace normalization, or Unicode normalization. Rows were ordered by article ID ascending. The historical outputs are `ccef966880d85663b8fd5049e9995f5f` and `4cf1ecf2990a5dca582c95e5733a484f`.

## OPERATIONAL FINGERPRINT V1

`publicArticleFingerprintV1` is SHA-256 over UTF-8 bytes of a compact `JSON.stringify` representation. It covers exactly `slug`, `headline_es`, `summary_es`, `why_it_matters_es`, `body_es`, and `metadata`. Object keys are sorted recursively using JavaScript's default string sort; array order is preserved. Null remains JSON `null` and is distinct from an empty string. Non-finite numbers and undefined JSON members are rejected. The SHA-256 result is lowercase hexadecimal.

IDs, publication status, and timestamps are excluded. The implementation is [public-article-fingerprint.ts](../lib/articles/public-article-fingerprint.ts); deterministic fixtures cover stable repeat calls, top-level and nested key reordering, each covered-field change, excluded volatile fields, and null versus empty string.

## ATTEMPTS

The fresh application read found 10 real attempts (`validation_namespace IS NULL`), 0 open attempts, 0 deferred provider-capacity attempts, and 0 open attempts older than one hour. Historical attempt `3ebda423-2aa6-4f3a-b119-53982fbf58d9` remains terminal and matches the saved 12F.2 state: `TECHNICAL_FAILURE` at `classifier`, reason `PROVIDER_CAPACITY_EXHAUSTED`, completed at `2026-10-07T19:32:06.285Z`. This phase did not mutate it.

## REVIEWS

The current total human-review row count and status counts are **unknown** through the permitted application read path. Migration 31 revokes `SELECT` on `pipeline_human_reviews` from `service_role`, `authenticated`, `anon`, and `public`. The repository's existing status/list reader executes SQL through linked Supabase CLI, which is forbidden here. The historical 12F.2c count of zero is not presented as a fresh 12F.2d result. No review-table request or mutation was made.

This missing fresh review state blocks 12F.2d readiness.

## ACCOUNTING

Accounting used the existing read-only `SupabaseAgentLogger.getProviderDailyUsage()` and `getProviderRateLimitState()` methods for UTC date `2026-10-07`. Groq: 3 reserved and dispatched requests, 5,387 settled tokens (4,458 input and 929 output), 0 unknown token requests, no rate-limit state. Cloudflare Workers AI and Cerebras each had 0 reservations and 0 unknown requests; both rate-limit states were null. No provider was probed or called.

The current schema has no separate durable provider-capacity state field; rate-limit telemetry reads returned null for all three providers.

## CHECKPOINT CONTRACT

Checkpoint/resume behavior stayed frozen. The offline durable-checkpoint suite passed, including durable Editor payload, Verifier/Translator/Editor/Classifier/Ranker/Critic roundtrips, fresh-process Classifier/Ranker/Critic resume, and capacity defer/resume at the first missing stage with the same synthetic attempt, retry count zero, and no completed-stage redispatch. Migration fixture suites 29, 30, and 31 passed. No checkpoint implementation was changed in this phase.

## FUTURE READ POLICY

- Application/server PostgREST reads through the established helper: allowed.
- Anonymous reads: allowed only when sufficient for the requested evidence.
- Supabase CLI SQL and temporary database login provisioning: not used for ordinary operational baselines.
- Migration tooling: reserved for actual migration work.
- No new read RPC or authentication architecture was introduced.

## NO-MUTATION PROOF

The read runner observed only GET/HEAD requests to PostgREST. Application writes, infrastructure provisioning initiated by this phase, provider calls, pipeline execution, discovery, publisher calls, review actions, and scheduler writes were all zero. The offline suite runner selected only package scripts backed by unit-test files (plus the offline contract test); it did not run provider or integration scripts.

## READINESS

Operational fingerprints are recorded and tested; articles, Astra, attempts, accounting, checkpoint regressions, and zero-write constraints passed. However, because fresh review totals/statuses could not be read through the allowed path, **12F.2d READY = NO**.

## NEXT

Do not start 12F.3 from this result. Add or authorize a suitable read path for review counts in a separately scoped phase, then refresh the review baseline before making a readiness decision. 12F.2c remains READY NO.
