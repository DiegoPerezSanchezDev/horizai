# UI-07: read-only live editorial data

## Objective and scope

Provide the authenticated editorial workspace with a server-side, read-only adapter for M32 human-review data. The adapter is protected by `requireEditorialOperator()` and the server-only `EDITORIAL_LIVE_DATA_ENABLED` flag. The flag defaults off. It is not a public environment variable, and production never falls back to UI-06 fixtures.

No migration, decision, revision bind, publication, provider request, pipeline run, scheduler run, push delivery, SMTP configuration, or deployment was performed. Remote M32 reads were not performed. All mapping tests use synthetic objects and an injected repository.

## M32 contract inventory

The contract is defined by the local M32 read repository and migrations; this phase does not change M31–M39.

- `get_pipeline_human_review_operator_status()` returns `utcDay`, `asOfUtc`, review totals by status, `waitingReviews`, `consumedReviews`, `publishedToday`, candidate/attempt/failed counts, provider usage counters, and active/stuck work counters. The adapter uses only `waitingReviews` and `publishedToday`.
- `list_pipeline_human_reviews_operator(p_limit)` returns `{ reviews, publishedToday, returned, limit }`. Each summary row contains review/event/attempt/run/draft IDs; draft, lineage, and publication-payload hashes; approval-target kind and revision ID/hash; manifest; Critic and provider-settlement booleans; status/action; reviewer decision booleans and timestamps; consumed/published identifiers; and created/updated timestamps. The M32 implementation sorts newest first and caps `p_limit` at 500. It has no cursor or status filter.
- `get_pipeline_human_review_operator_inspect(p_review_id)` returns `{ found, review, publishedToday }`. The review contains the list fields plus source lineage, reviewer ID, review-check booleans, and decision history. The adapter uses the source lineage only to compare it with the verified package, then drops it from the DTO.
- `get_pipeline_human_review_revision(p_review_id)` (M38) returns `{ found, revision }`. The revision record is parsed with the repository's strict schema and verified before use.

The M32 RPCs require `service_role`; application code uses only those read RPCs and the M38 revision read. It does not query protected tables directly. Article copy and source metadata are read from the immutable package under `HUMAN_REVIEW_ARTIFACT_ROOT`; a missing package, hash mismatch, or binding mismatch fails closed.

## Operator DTO and mapping

The shared strict `EditorialReview` DTO contains review and attempt IDs, status and consumed state, article/draft/revision IDs, current approval target and hash, source-lineage hash, proof states, headline, summary, “Por qué importa”, country/region/category, creation time, Ranker score when present, safe body blocks, source metadata, and deterministic warnings. Inbox summaries omit body, attempt ID, and hashes. Detail adds only the original draft copy needed to compare it with a linked corrected revision.

Raw M32 objects, checkpoint hashes, prompts, provider responses, extraction text, usage internals, decision history, and service credentials are not passed to client components. The detail screen labels the corrected revision as the current approval target and separately identifies the original draft. The Critic label always states that it validated the original draft.

M32's article source contract includes `sourceName`, URL, primary/secondary flag, and publication date. The DTO shows the URL domain as publisher and `sourceName` as title. It does not invent a source title, date, or classification. Only `http:` and `https:` links survive DTO validation; links open with `noopener noreferrer`.

The source-lineage digest is recomputed from the immutable package and compared with the M32 row. Detail also compares the complete M32 inspect lineage to the package. Critic PASS requires the M32 flag and both package Critic decisions to agree, plus the bound Critic checkpoint. M34 PASS is derived from a valid M32 row and the M34 insert invariant: the unique successful Critic run and exact event/run/attempt checkpoint identity were required when that row was created. The status is withheld if Critic or provider settlement evidence is inconsistent. Activation requires the deployed database to include M34 and the remaining revision migrations; this phase did not inspect or change the hosted migration head.

Warnings are generated only from known data: consumed review, missing/inconsistent Critic proof, or missing M34 proof. Empty or mismatched source lineage, an invalid artifact, or a mismatched revision target blocks the entire read and returns a generic safe error rather than exposing untrusted content.

## Server boundary and environment modes

`EDITORIAL_LIVE_DATA_ENABLED=true` is the only enabling value. Every live adapter entry calls `requireEditorialOperator()` before creating the privileged client. The client is created through `createSupabaseServerClient({ privateNoStore: true })`; no client component imports it. A corrected target uses only `get_pipeline_human_review_revision` as its additional RPC.

| Environment | Flag | Mode | Behavior |
| --- | --- | --- | --- |
| Development | absent/false | `FIXTURE` | Existing UI-06 fixtures, guarded by the development host policy |
| Development | true | `LIVE_READ_ONLY` | Authenticated M32 reads; no fixture fallback |
| Production | absent/false | `LIVE_DISABLED` | Safe operator message; no fixture import or live query |
| Production | true | `LIVE_READ_ONLY` | Authenticated, allowlisted server reads; generic error on failure |

The route pages are dynamic. Supabase fetches use `cache: "no-store"`, and the existing editorial route headers set `Cache-Control: private, no-store, max-age=0`. No API route was added; Server Components and a small explicit refresh button are sufficient. The button calls `router.refresh()` only when pressed and does not poll.

UI-06 fixtures are dynamically imported only inside the `FIXTURE` branch. The live adapter has no fixture dependency. A live read error never becomes a fixture response. Safe UI states cover disabled data, M32 failure, empty inbox, and not-found review without rendering raw PostgREST errors.

## Notification foundation

The UI-06 `getEditorialNotificationEligibility()` helper receives the same live DTO shape in tests. A waiting, unconsumed review with Critic PASS, M34 PASS, valid lineage, and no prior dedupe key is eligible. The test checks the helper only. No notification is persisted or sent, and there is no push permission request or delivery code in the live adapter.

## Security and QA

The AUTH-01 resolver/unit scenarios and UI-06 fixture/access regressions pass. The UI-07 mocked read service exercises status/list/inspect, DTO mapping, strict malformed-response rejection, consumed/nonwaiting filtering, revision identity, missing lineage, proof mismatch, not-found, and generic PostgREST failure behavior. Client code is checked for privileged imports and RPCs. The secret audit and production client-bundle scan are recorded in `artifacts/ui-07-live-editorial-data.json`.

Visual checks requested for 390×844, 430×932, 768×1024, and 1440×900 cover fixture inbox, disabled live mode, mocked live inbox, detail, corrected revision, M32 error, and empty inbox. Fresh UI-07 screenshots were not captured: the sandbox denied access to the Docker Engine named pipe needed to start the isolated local OTP stack, and no existing operator session was available. Earlier UI-06 screenshots remain in the repo but are not counted as current UI-07 evidence. No production operator session was used.

## Operational limits and activation checklist

The default package root is `artifacts/human-review-packages`. This path must be a durable, private mount visible to the web runtime before production live reads can work; ephemeral function filesystems are insufficient. M32 list has a 500-row maximum and no pagination/cursor, so very large queues need a future read-contract extension before full queue coverage can be claimed.

Before AUTH-02 or any live activation, an operator must verify all of the following:

1. Configure `EDITORIAL_OPERATOR_EMAILS` as a private server-side value with the real verified operator address.
2. Confirm the production HTTPS origin and configure the matching Supabase Auth callback/redirect origin.
3. Verify real email/OTP delivery through the approved production mail path.
4. Disable public signup in Supabase Auth.
5. Confirm deployed database migration/ACL state includes the required M32–M39 read contracts and M34 proof trigger.
6. Mount immutable review packages and any required private artifacts at the configured server path.
7. Pass anonymous, unauthorized-account, expired-session, and authorized-operator route tests in that environment.
8. Only after steps 1–7 pass, set `EDITORIAL_LIVE_DATA_ENABLED=true` in private runtime configuration.

This checklist is prepared; its operational steps remain incomplete. Production is not activated and this implementation is not ready for AUTH-02 live activation.
