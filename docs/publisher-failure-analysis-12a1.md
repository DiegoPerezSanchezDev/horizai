# 12A.1 — Pilot Publisher Failure Analysis

## FAILED EVENT

- `eventId`: **none**. No row exists in `events`; the UUID would have been created by the atomic Publisher transaction. The canonical event key is `event-cbbf85234317a442f59ece63ef1b40c8`.
- Pipeline run: `ce894b55-5c50-44dc-87db-58bcbf09834b`.
- Persistent attempt: `5b780142-18bc-4185-aeb4-e4a6b30f507e`, attempt 1, `TECHNICAL_FAILURE`, stage `publisher`, code `LOCAL_SCHEMA_VALIDATION_ERROR`. It counts toward the retry limit.
- Attempt window: `2026-09-28T17:09:19.602Z`–`2026-09-28T17:10:20.916Z`.
- Critic persisted `pass`, with zero issues. No revision orchestration occurred.
- The Publisher input was assembled in the pipeline's in-memory event context from successful stage outputs. The original temporary pilot runner and its transient `PublisherInput` were not retained; the final Critic checkpoint and other stage checkpoints were used to reconstruct the object.
- The attempt row stores only the stop stage and code. No Publisher `agent_logs` row, validation stack, or detailed failure message was persisted.

## REPRODUCTION

All six persisted checkpoint files passed their current safe readers and share the same event key. The run artifact records Verifier, Translator, Editor, Classifier, Geo, Ranker, and Critic as successful. Rebuilding the publication object from the persisted real outputs and running the current strict Zod contract reproduces the Publisher failure deterministically.

The reproduced object has one Zod issue. Its score values and all other fields pass. The failure comes from passing the complete Ranker result into the narrower `scores` object, which is also the pattern present in the retained pipeline, supervised-snapshot, and critic-resume assemblers.

## VALIDATION ISSUES

Authoritative schema: `PublicationPayload`, version `1`, in `lib/agents/contracts/index.ts`. Its score object is strict and accepts exactly seven numeric fields: `impact`, `novelty`, `reach`, `credibility`, `economicImpact`, `momentum`, and `importanceScore`.

The reproduced Zod issue is `unrecognized_keys` at path `scores`, with keys `schemaVersion`, `eventKey`, and `rankReason`:

| Field path | Expected | Actual shape |
| --- | --- | --- |
| `scores.schemaVersion` | Absent from the strict score object | Number (`1`) |
| `scores.eventKey` | Absent from the strict score object | String, 38 characters |
| `scores.rankReason` | Absent from the strict score object | String, 243 characters |

These are valid Ranker metadata fields in their source object. They are invalid only after that object is spread into `PublicationPayload.scores`.

## FIELD PROVENANCE

| Field | Origin | Why it reached the invalid path |
| --- | --- | --- |
| `schemaVersion` | Ranker output | The Publisher assembler spread the full `RankingResult` into `scores`. |
| `eventKey` | Ranker output | Same spread; lineage was valid, but this field is not part of the score contract. |
| `rankReason` | Ranker output | Same spread; explanatory metadata is not a numeric publication score. |

The persisted Ranker result itself passes `RankingResult`. The fault is `PUBLISHER_ASSEMBLY_BUG`, not invalid model output, schema drift, database drift, nullability, or an enum mismatch. No other Zod issue reproduced from the real stage outputs.

## ROOT CAUSE

The assembler copied a whole `RankingResult` where the strict `PublicationPayload.scores` contract requires a seven-field projection. The local validation correctly rejected the extra metadata. The Publisher atomic RPC was never invoked.

The requested canonical pre-Publisher state is **NO**: all upstream stages completed and Critic approved the draft, but the assembled publication contract was invalid. A second, independent geographic inconsistency also blocks readiness after the score projection is corrected; see **RESUME SAFETY**.

## SCHEMA DRIFT

- Runtime `PublicationPayload` is schema version 1 and strict. The runtime Publisher boundary parses it in `lib/agents/pipeline/pipeline-boundaries.ts`; `Publisher` validates it again before lookup/materialization.
- `PublisherInput` in `lib/agents/publisher/publisher-types.ts` wraps that payload. It has no competing score schema.
- `types/database.ts` types the atomic RPC argument as `Json`; it does not contradict the runtime score contract.
- Migration `20260921000013_publisher_event_materialization.sql` (migration 13) reads `scores.importanceScore`; it requires a new event's source to include an owned `rawItemId`, and requires region coordinates to equal the active region row. It does not require `schemaVersion`, `eventKey`, or `rankReason` inside `scores`.
- The public article view and article row contract do not contain these score metadata fields and were not changed.
- `npm run supabase:status` confirmed local and remote migration histories match through `20260927000026`. No migration was applied or created.

There is no schema/database defect requiring a migration. The initial `LOCAL_SCHEMA_VALIDATION_ERROR` occurs before database lookup or RPC execution.

## FIX

Added `buildPublicationScores` in `lib/agents/publisher/publication-payload.ts`. It explicitly projects the six dimensions and required deterministic importance score. It rejects a missing or null importance score with `publication_ranking_mismatch`; it does not invent a value or weaken validation.

Updated the three retained payload assemblers that passed the whole ranking object:

- `scripts/pipeline-real-test.ts`
- `scripts/supervised-snapshot-execute.ts`
- `scripts/critic-checkpoint-resume.ts`

The 12A run introduced no tracked source-code changes. This phase's fix does not alter the classifier, geo helper, database, migrations, scheduler, router, or public UI.

## REGRESSION TEST

Added `scripts/publisher-failure-analysis-12a1-unit-test.mjs`. Its minimized Ranker fixture uses EVENT 1's structural shape and numeric dimensions; the rationale text is synthetic and no source article text is included.

The test confirms that the old spread deterministically fails with the three reported extra keys, the explicit projection passes `PublicationPayload`, missing/null importance remains rejected, and a new-event Publisher write plan accepts the corrected payload with a source `rawItemId`. The write-plan check is local and invokes no RPC.

## PUBLISHER CONTRACT

After the score fix, a full `PublisherInput` rebuilt from EVENT 1's checkpoints passes `buildPublisherInputBoundary`, `validatePublisherInputs`, and `PublicationPayload` Zod validation. The new regression and existing Publisher unit tests also pass the runtime write-plan contract without calling the atomic RPC. No migration change is needed for the score projection.

A read-only check against current registries finds another real payload blocker: classification says region `GLOBAL` and country `US`, while Geo carries coordinates `39.8283, -98.5795`. The active `GLOBAL` registry row is at `20, 0`; the active `US` row is at `39.8283, -98.5795`. Readiness therefore fails with the message “Publication coordinates do not match the active region registry.” The readiness wrapper labels this `publication_invalid_payload`; the underlying Publisher error is `publication_invalid_geo`.

This is not part of the original Zod error. The local synthetic atomic write-plan regression passes, but the real event is not ready for atomic materialization until its geographic state is reconciled.

## PARTIAL STATE AUDIT

Read-only Supabase checks found:

- No `events` row for the event key, so there is no event UUID.
- No article row by the checkpoint's suggested slug and no public article by that slug.
- The exact source raw item remains present, extracted at `full` quality, and owned by the expected source.
- Exactly one attempt exists for this event; it is the recorded technical failure.
- No Publisher log row was recorded. Since local validation failed before Publisher lookups, there was no atomic materialization to roll back or partially apply.
- 12A reported 0 public articles before and after the run. No article, slug, or event-source partial state was created by this attempt.

## RESUME SAFETY

**Publisher-only resume safe: NO.**

The six model stages completed once, all checkpoints pass schema/lineage reads, Critic persisted `pass`, and no revision ran. The canonical final editorial draft is identical in the Ranker and Critic checkpoints: `artifacts/pipeline-checkpoints/ce894b55-5c50-44dc-87db-58bcbf09834b/critic-event-cbbf85234317a442f59ece63ef1b40c8.json`; its slug and SHA-256 identity are recorded in the JSON artifact. The source raw-item ownership check passes, and no article already exists.

However, the corrected real payload still fails read-only Publisher readiness because `region.code=GLOBAL` is paired with US-centroid coordinates. Changing the region or coordinates after Critic would alter the geographic context associated with its persisted decision. Do not resume from Publisher until a focused geographic-contract remediation determines the correct canonical pair and whether the saved Critic decision remains valid.

## CAPACITY

At `2026-09-28T19:05:22.707Z`, a paginated, read-only ledger verification found exactly six Groq reservation rows, all dispatched for this pilot event: 8,574 input tokens + 1,307 output tokens = **9,881 accounted tokens**. Usage is known, unknown reservations are zero, and there is no active Groq block. Remaining to the configured soft limits: 844 requests and 160,119 tokens. The six calls and 9,881 tokens remain historical usage; nothing was released or reserved in 12A.1.

## LIMITATIONS

- The temporary 12A runner and exact transient `PublisherInput` were not retained. The failure stack and detailed Zod error were not stored remotely. Reproduction therefore uses the persisted stage outputs and the same retained strict assembly pattern; it establishes the exact deterministic issue for that reconstructed payload, but cannot compare the original in-memory object byte for byte.
- The geographic mismatch is a separate blocker. This phase did not change or reinterpret the saved geography and did not re-evaluate Critic.
- No provider call, remote write, publication, scheduler/router activation, or migration occurred.

## NEXT STEP

**12A.1 analysis: READY YES. Publisher-only resume: NO.** The original failure is reproduced and fixed, the contract and regression checks pass, and the independent resume blocker is identified. Next is focused remediation of the classification/Geo/Publisher region contract. **Do not run 12A.2 automatically.**
