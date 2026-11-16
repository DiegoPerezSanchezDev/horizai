# 12F.8D — Zero Eligible Events Diagnosis

## Result

Primary classification: **SELECTOR_STATE_BUG**, scoped to the 12F.8C local diagnostic adapter. The production selector, attempt-history policy, dedupe, and freshness rules were not changed.

The reported zero was incorrect. After correcting the adapter, a fresh read-only cohort contained 56 events, all `NEVER_ATTEMPTED` and all passing the existing evidence admission gate. Local gates and the remote baseline passed. The single authorized 12F.9 invocation then stopped before provider dispatch with `TECHNICAL_FAILURE`: `cost_guard_violation / GROQ_TPM_LOCAL_USAGE_UNKNOWN`. See [12F.9](supervised-cycle-12f9.md).

## Observe: exact defect

The original invocation was recovered from this task's local transcript (2026-10-15 19:24 UTC). It assigned:

```ts
const extracted = freshExtractionResults(extraction);
```

`freshExtractionResults()` returns `ExtractionResult[]`. Each result contains an `item: ExtractedItem | null`. The diagnostic then compared each event source's `candidateId` against `result.candidateId`, which does not exist, instead of `result.item.candidateId`.

All 52 clustered events were removed by that join. The history lookup received **zero keys**. No real selector decision or typed ineligibility reason was assigned to any of those events. The 12F.8C statement that the attempt lookup marked all events ineligible was therefore an incorrect interpretation of its output.

| Original cohort accounting | Count |
| --- | ---: |
| Clustered events reported | 52 |
| Dropped by the incorrect wrapper join | 52 |
| Contexts passed to attempt-history lookup | 0 |
| Typed ineligibility reasons assigned | 0 |

The sum of the causal accounting is 52. This is a diagnostic input-shape error, not a policy rejection reason.

## Historical reconstruction limitation

The original inline command saved neither candidate/event identities nor feed/extraction snapshots. Its process has ended. The exact metadata and identities of the original 52 cannot be recovered from the retained summary. This phase does **not** claim that the new 56 events are those same 52, or invent per-event historical reasons. All 52 losses are explained deterministically; the requested exact historical identity reconstruction remains unavailable.

The new artifact retains a safe trace for every event in the current cohort: key/title, candidate/source IDs, URL/domain, raw-item lookup, cluster/source counts, recency, history linkage, typed eligibility reason, and existing quality signals. It contains no complete article body.

## Plan and minimal fix

Severity: IMPORTANT — an incorrect diagnostic could block an authorized run and misstate policy behavior.

Added a typed diagnostic adapter, `selectionPreflightContexts()`, that unwraps `.item` before joining event source identities. It preserves the production ordering and throws on an unjoinable event instead of silently producing an unexplained zero. Added a read-only trace script and focused regression fixtures. No production pipeline caller imports this adapter, and no production admission policy was changed.

The trace uses `persistTraceability: false` and permits only HTTP GET/HEAD, with provider endpoints forbidden. Discovery does not persist raw items or source health, and model stages and the scheduler are not invoked during diagnosis.

## Current exhaustive trace

Reference time: `2026-10-15T19:34:17.639Z`; window: 24 hours.

| Result | Count |
| --- | ---: |
| Discovery candidates after dedupe | 59 |
| Successful, fresh extractions | 56 |
| Blocked fetches | 3 |
| Clustered events / unique event keys | 56 / 56 |
| `NEVER_ATTEMPTED` | 56 |
| Historical attempt matches | 0 |
| Quality admission `ELIGIBLE` | 56 |
| Other selector reasons | 0 |

The reason-count sum equals the current clustered-event count, 56. Every current event has an explicit trace. The 16 historical attempts were read without mutation; no current event key matched them. No current event was excluded by ABORTED, retry, terminal, source-level, or daily selection state.

The diagnostic also traces the real runner's first-six-candidate extraction cohort. At the preflight snapshot it had four extracted clusters and selected three events through normal ordering, all `NEVER_ATTEMPTED` with sufficient evidence. It does not manually choose or pass a candidate to the real runner. Live fetching changed between preflight and execution: the actual run successfully extracted five of its six selected candidates.

## Event identity and dedupe audit

Clustering removes exact canonical-URL duplicates. Pair decisions combine title, description, relevant terms, entities, publication time, number conflicts, and model-version conflicts; merging requires compatibility with every cluster member. The configured maximum pair time gap is 72 hours.

The event key is the first 32 hex digits of SHA-256 over the full lowercased canonical headline, the median publication UTC day, and sorted source-country codes. URL and body hashes are not event-key inputs. Attempt history matches the complete event key, not a source ID or broad topic term.

The current cohort has 56 unique keys and candidate identities, and no historical key match. Tests show that related topics with materially different headlines stay separate and that the same generated historical key stays consumed. No over-dedupe or event-key defect was proven. Same-headline/day/country collisions remain a theoretical identity limitation, not an observed cause here.

## Recency and retry audit

Discovery requires a reliable publication timestamp within the 24-hour window, allowing up to five minutes of future feed skew. Extraction independently applies its window: valid publication timestamps take precedence; invalid or future publication times fail closed. If publication time is absent, the existing safe fallback is the candidate discovery timestamp. No publication dates were invented. UTC arithmetic defines the window and the daily trigger. All 56 current extracted events were `FRESH`; none was falsely stale.

Attempt policy remains unchanged: completed publication/review/revision/rejection outcomes consume the same event key; ABORTED is permanent unless the complete explicit stale-recovery contract applies; active/deferred events cannot create a new attempt; two counted technical failures quarantine an event; technical cooldown and UTC retry boundaries remain enforced. New unrelated keys from the same source remain selectable.

## Diversity and quality

There are seven source IDs and seven domains, 56 single-source events, and zero multi-source events. Source-region metadata is US 29, SPAIN 26, unknown 1. Category classification is unavailable before providers. These are source-region signals rather than proven event geography.

All current items pass the existing generic editorial-evidence admission check. That does not establish factual truth, corroboration, editorial importance, or Critic acceptance. Single-source concentration is a future discovery-diversity consideration; it did not cause the reported zero and did not justify weakening any gate.

## Verification

The offline reproduction creates 52 synthetic clusters. The old wrapper join yields zero contexts; the corrected adapter yields all 52. Focused cases cover genuinely new events, identical historical events, published events, active/deferred attempts, safe rejection, ABORTED without recovery, unrelated events from the same source, related but different events, stale/current timestamps, missing publication timestamps, and missing event-item lineage.

All 31 focused suites recorded in `artifacts/supervised-cycle-12f8d-gates.json` passed, including selector/history, event-key/clustering, freshness, discovery/extraction, Verifier bounds, M35/M33 resume, throughput caps and safe revision continuation, Editor grounding, Critic/M34 proof, scheduler finalization, M32, and accounting. The new preflight fixture, lint, TypeScript, canonical Webpack build, diff check, and secret audit also passed. There were zero provider calls or remote writes during diagnosis. Visual checks are not applicable to this nonvisual change.

## Execution gate and final state

The actual UTC expression returned `2026-10-15`; trigger `supervised-candidates:2026-10-15` was free immediately before execution. Migration head was `20261014120000`, M35 present, M32 status/list PASS, attempts 16, active/deferred/stuck 0/0/0, reviews/WAITING 0/0, public 2, Astra archived, no unknown reservations, and authoritative fingerprints unchanged. No migration was applied.

One canonical invocation ran. It made one event attempt and stopped on the Verifier's unknown durable TPM state, with no provider dispatch or reservation. The scheduler finalized and released its lease. The final state is attempts 17, active/deferred/stuck 0/0/0, reviews/WAITING 0/0, public 2, Astra archived, fingerprints unchanged. All 16 pre-existing attempts are unchanged.

Diagnosis: closed. **READY FOR NEXT STEP: NO**, because the real run ended in a technical failure. No capacity resume, second run, repair phase, human action, publication, or deployment was performed.
