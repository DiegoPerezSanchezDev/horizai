# 12A.1b — Geography consistency remediation

## FAILED GEO STATE

- No `events` row exists, so EVENT 1 has no database `eventId`. Its canonical `eventKey` is `event-cbbf85234317a442f59ece63ef1b40c8`.
- Pipeline run: `ce894b55-5c50-44dc-87db-58bcbf09834b`; failed attempt: `5b780142-18bc-4185-aeb4-e4a6b30f507e`, attempt 1, `TECHNICAL_FAILURE` at Publisher.
- The persisted Classifier checkpoint contains `primaryRegionCode=GLOBAL`, `countryCodes=["US"]`, and coordinates `(39.8283, -98.5795)`. The Ranker and Critic checkpoints carry the same classification coordinates.
- Critic checkpoint: `artifacts/pipeline-checkpoints/ce894b55-5c50-44dc-87db-58bcbf09834b/critic-event-cbbf85234317a442f59ece63ef1b40c8.json`. Critic returned `pass`, zero issues. Its editorial object matches the Ranker checkpoint; draft SHA-256: `0ddf0c6072bf3b5f7fde7097cdb2b4fb84c10119f8a129fabcb60e8458fa6d08`.
- The rebuilt Publisher payload used `region.code=GLOBAL` and the Geo output coordinates `(39.8283, -98.5795)`. Readiness compared those values with the active `GLOBAL` row and rejected the mismatch.

## ACTIVE REGION REGISTRY

Read-only Supabase `SELECT` of the active registry returned 11 active rows. Relevant rows:

| id | code | name | canonical latitude | canonical longitude | other geo metadata |
| --- | --- | --- | ---: | ---: | --- |
| `b3efde0a-a1f4-496c-a69d-f266c8942beb` | `GLOBAL` | Global | 20 | 0 | None beyond the region registry fields |
| `f8e9291b-627a-4ea7-b160-20584ec57cfb` | `US` | EE. UU. | 39.8283 | -98.5795 | None beyond the region registry fields |
| `bb3f300e-fd94-482b-bcb3-5d8ab47cd645` | `EUROPE` | Europa | 54.526 | 15.2551 | Included as the broader-region comparison |

All three rows are active. There is no active `USA`, `NORTH-AMERICA`, `NORTH_AMERICA`, `NORTH AMERICA`, or `AMERICAS` code, and there is no row named “North America.” `USA` and North America are not alternate registry aliases. The active table’s other geo data consists of region ID, code, name, latitude, longitude, and active status.

## CLASSIFIER OUTPUT

The model selected `GLOBAL`: **YES**. The `ClassifierGeneration` schema permits `primaryRegionCode` and ISO `countryCodes`, but excludes latitude and longitude. `classifier-prompt.ts` also explicitly says not to return coordinates; HorizAI adds them after generation. `classifier-agent.ts` copies the model’s `primaryRegionCode` and `countryCodes` into the result, then calls the deterministic Geo resolver for the coordinates.

Therefore `GLOBAL` is model-owned semantic classification. `US` is the model-produced country code. The stored evidence does not establish why the model selected `US`; The Verge’s source metadata is also country-coded `US`, but that is not proof that the event occurred there. The company or publisher location is not used here to rewrite the region.

## GEO PROVENANCE

| Field / stage | Value | Origin and persisted location | Ownership |
| --- | --- | --- | --- |
| Classifier-selected region | `GLOBAL` | Model generation copied into `classification.primaryRegionCode` in the Classifier checkpoint | Model-owned |
| Classifier country list | `US` | Model generation copied into `classification.countryCodes` in the Classifier checkpoint | Model-owned |
| Geo-stage region | `GLOBAL` | Geo stage copies `classification.primaryRegionCode`; it does not select a different region | Deterministic pass-through |
| Latitude | `39.8283` | Old `resolveGeo` mapped the first country code `US` to region code `US` and read that active row | Deterministic registry metadata |
| Longitude | `-98.5795` | Same `US` registry row and resolver path as latitude | Deterministic registry metadata |
| Event-level geography | `probableRegionCode=GLOBAL`, `probableCountryCode=US`; publication region code `GLOBAL` | Publisher payload assembly from classification | Mixed: semantic fields from Classifier, coordinates from Geo |
| Critic checkpoint `geo` metadata | `(39.8283, -98.5795)`, level `region`, `resolvedFrom=region_registry` | Persisted in Ranker/Critic checkpoint | Derived, but source/level were lossy labels |
| Publisher readiness geography | `GLOBAL` plus `(39.8283, -98.5795)` | Payload compared against active `GLOBAL` row | Deterministic validation |

There is no separate persisted Geo checkpoint file. The production Geo stage previously kept only coarse `provenance=reference_registry`, and Critic-input assembly converted every such value to `resolutionLevel=region` and `resolvedFrom=region_registry`. Reconstructing the actual old resolver call from `countryCodes[0]=US` shows it had resolved from `country_registry` at country level. The stored Critic `geo` labels therefore did **not** preserve exact resolver provenance. This metadata loss did not cause the coordinate mismatch, but it obscured its source.

The coordinate origin is `REGION_REGISTRY_COORDINATES`: specifically, the active `US` registry row. It is not a source-location geocode, entity location, event-location claim, default, stale coordinate cache, or Publisher-generated coordinate.

## GLOBAL SEMANTICS

The Classifier prompt defines `GLOBAL` for genuinely multinational or multiregional events, or when no more specific primary region is justified. It does not mean that a story is merely globally relevant despite a known local event. No code or product document says that a source publisher’s country becomes the event’s primary region.

HorizAI’s region coordinates are deterministic registry points used with the selected region. They are not a claim that the event happened at that precise point. The event’s `GLOBAL` selection remains unchanged; no saved evidence justifies silently replacing it with `US` or null.

## REGION-COORDINATE INVARIANT

The authoritative local invariant is `assertRegion` in `lib/agents/publisher/publisher-write-plan.ts`:

- a null region requires both coordinates to be null;
- a non-null region must resolve to an active registry row;
- latitude and longitude must exactly equal that row’s canonical pair.

Migration `20260921000013_publisher_event_materialization.sql` repeats this check inside the atomic transaction before its first write, then stores the resolved region ID on the event. The rule protects the region ID and map coordinates from describing different registry entries. It is consistent across Publisher and the database; readiness is not the defect and must not be weakened.

## CRITIC INPUT

| Question | Result | Evidence |
| --- | --- | --- |
| Critic saw region | **YES** | Model-facing `classification` includes `primaryRegionCode=GLOBAL`. |
| Critic saw latitude and longitude | **YES** | `buildCriticModelInput` passes the full `ClassificationResult`, which includes numeric `latitude` and `longitude`. The old EVENT 1 model input therefore contained `39.8283, -98.5795`. |
| Critic saw a human-readable geo label derived from those coordinates | **NO** | The standalone `CriticInput.geo` object is dropped from model-facing input. The model received raw coordinates, plus the separate `GLOBAL` and `US` classification codes; neither code was derived from the coordinates. |

Because the coordinates were in the model input and the Critic instruction audits classification support and cross-stage consistency, the old approval cannot be reused as approval of corrected coordinates.

## ROOT CAUSE

**Classification: `CONTRACT_DRIFT`.** The old deterministic resolver explicitly preferred `countryCodes[0]`, and its test asserted that behavior even when the selected region differed. Publisher and the atomic database contract require coordinates to match `primaryRegionCode`. These two contracts conflict whenever a broader selected region and a country code coexist.

The immediate faulty layer was deterministic Geo resolution: `GLOBAL + [US]` resolved to the US centroid. A separate provenance-label loss in Critic-input assembly made the old checkpoint report that country-derived coordinates came from the region registry. The model-owned `GLOBAL` output, active registry rows, Publisher assembly, and readiness invariant were not the causes.

## EXPECTED CORRECT STATE

- Preserve `primaryRegionCode=GLOBAL` and `countryCodes=["US"]`.
- Project coordinates from the selected region’s active registry record: `latitude=20`, `longitude=0`.
- Keep region selection semantic and model-owned. Do not infer `US` from The Verge, OpenAI, or another organization’s location.
- When no supported primary region is selected, return both coordinates as null. Do not fall back from country metadata to a coordinate that has no matching `region.code`.

## FIX

The smallest consistent correction is at Geo resolution, before Ranker/Critic/Publisher:

- `resolveGeo` now resolves only from `primaryRegionCode`. It no longer lets `countryCodes[0]` override that field.
- A valid `GLOBAL` selection produces the canonical `GLOBAL` point. A valid specific region produces that region’s registry point. Null, unknown, or coordinate-less regions remain unresolved.
- Classifier and production Geo stage use the same rule. Geo stage output now retains exact resolution level and registry origin instead of relying on a later guess.
- Critic deterministic prechecks compare classification coordinates, Geo output, and the selected active registry row. They reject a stale/mismatched tuple before a model call.
- `projectClassificationGeo` creates an in-memory projection for a persisted classification. The Critic resume and replay paths use it; historical checkpoint files are left untouched. A newly written checkpoint can contain corrected projection only after the future Critic run.
- Publisher and database region checks remain strict. No schema or migration was changed.

## REGRESSION COVERAGE

Added a minimized, article-free EVENT 1 shape: `GLOBAL + countryCodes=[US] + US coordinates`. Tests cover:

- `GLOBAL` with canonical `(20, 0)`;
- a specific broader region (`EUROPE`) with canonical region coordinates even when country codes are present;
- US selected as the region, with the US registry pair;
- missing region/coordinates, unsupported codes, and a registry row without coordinates;
- rejection of `GLOBAL + US coordinates` by Publisher;
- acceptance of `GLOBAL + (20, 0)` by the write-plan check;
- immutable checkpoint projection;
- Critic model input containing region and coordinates, and Critic prechecks rejecting/accepting the mismatched/corrected pairs.

The live, read-only EVENT 1 readiness reproduction also used the corrected in-memory projection. It passed Zod, Publisher boundary validation, Publisher input validation, active source/category/raw-item checks, and readiness. The raw-item ownership check ran once. Event resolution remains `would_create`; readiness invokes no RPC.

## CRITIC VALIDITY

**`CRITIC_RERUN_REQUIRED`.** The corrected model input retains `GLOBAL` and `US` country codes but changes the coordinates Critic received. Offline Critic prechecks for the projected real checkpoint pass against the active registry. Re-evaluate Critic before Publisher; no Critic run happened in this phase.

## RESUME CLASSIFICATION

**`CRITIC_THEN_PUBLISHER_RERUN_REQUIRED`.** The persisted Ranker checkpoint has all upstream inputs needed to create a corrected in-memory Critic input; a Classifier or earlier stage rerun is not required. The existing checkpoint is not edited. After the corrected Critic run passes, reconstruct Publisher input and re-run readiness before any future publication.

Read-only attempt state still has one counted technical failure. Its `next_eligible_at` is `2026-09-29T00:00:00Z`; the current `event-attempt-policy.ts` permits another attempt after this cooldown and quarantines only after two counted technical failures. EVENT 1 is therefore still eligible after cooldown. The existing `critic-checkpoint-resume.ts` operational entrypoint is pinned to a different snapshot and a prior rate-limit attempt, so it is not a command for EVENT 1; the next phase must use a targeted route that honors EVENT 1’s attempt state.

## TOKEN CONSEQUENCES

- Existing Groq usage remains **6 calls** and **9,881 tokens** (8,574 input + 1,307 output). Nothing was released or rewritten.
- Future minimum: **1 Groq Critic call** with the current zero-retry resume configuration and passing deterministic prechecks. Provider rate limits or a Critic revision decision could change later requirements.
- Verifier, Translator, Editor, Classifier, and Ranker need no replay under this correction. Publisher and readiness use no model provider.
- Calls added in 12A.1b: Groq 0, Cloudflare 0, Cerebras 0, inference 0.

## LIMITATIONS

- The original temporary in-memory Publisher input was not retained. The readiness reproduction uses the persisted Critic checkpoint, the known owned `rawItemId`, the canonical Publisher adapter, and the same read-only validation path.
- No archived provider request body exists. Critic visibility is established from the persisted classification values and the exact model-input builder/schema, not from a stored outbound request log.
- Registry coordinates are canonical map points for the selected region, not factual event coordinates.
- No provider call, publication, RPC, migration, scheduler, router, Netlify action, or remote write occurred. The only Supabase operations in this phase were `SELECT` reads.

## NEXT STEP

After the attempt cooldown, proceed only to **12A.2 — targeted Critic revalidation + Publisher readiness**. The expected model boundary is Critic; preserve the existing six-call/9,881-token accounting and the historical checkpoints. Do not publish automatically or run any later phase.
