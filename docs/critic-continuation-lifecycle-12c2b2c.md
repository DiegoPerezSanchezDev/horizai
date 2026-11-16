# Critic Compaction and Same-Attempt Continuation — 12C.2B.2c

**Scope:** prepare and validate the local implementation and migration 28. This phase is offline-only. It does not apply the migration, read current remote state, call a model, write remotely, create a sixth pilot attempt, or publish the article.

## CURRENT FAILURE

The exact remediation attempt is `a82482be-58d8-4fc6-ac16-946d0906257b`, attached to pipeline run `db368f10-d9c1-4897-b752-b3d2cb156e09`, event attempt 2, pilot attempt 5 of 5. Critic was stopped before dispatch because the conservative request estimate exceeded Groq's 8,000-token-per-minute hard limit. Critic has no checkpoint; Publisher did not run. The confirmed pilot ledger at that point was 24 of 30 calls.

The latest live database read recorded in phase 12C.2B.2a failed with `PGRST303`. The last earlier successful read showed the target article archived, outside the public view, with two public articles. Those values are historical evidence only; this document does not assert the current live article or public state.

## CRITIC TOKEN BREAKDOWN

The installed V3 runtime estimator was reproduced from the Ranker checkpoint:

| V3 prompt component | Characters |
| --- | ---: |
| System instructions | 3,711 |
| Serialized model input | 10,230 |
| Strict output schema | 1,413 |
| Total prompt characters | 15,354 |
| Estimated input (`ceil(chars / 2) + 128`) | 7,805 tokens |
| Reserved output | 1,200 tokens |
| Total estimated request | **9,005 tokens** |

This is a conservative capacity estimate, not provider-measured token usage. The 9,005-token request could not pass the existing pacing check: the 8,000 hard limit also retains its 128-token safety margin.

## DUPLICATED EVIDENCE

The main source excerpt was already bounded to 1,000 characters. The largest avoidable addition was the 4,498-character evidence catalog, including 2,424 characters of textual previews. Those previews repeat material already present in Verifier facts, translated fact pairs, the editorial draft, classification and ranking objects, and the source excerpt. A 300-character source preview reproduces the excerpt lead. The old model input also passed complete classification and ranking objects where a narrow projection suffices.

The V3 serialized model-input field lengths were: event 125, verification 545, translation 723, editorial 1,638, classification 286, ranking 665, sources 230, source evidence 1,371, evidence catalog 4,498, and schema version 1. JSON keys and separators account for the remainder of 10,230 characters.

## COMPACT PROJECTION

The V4 builder emits the semantic facts once and replaces catalog prose with typed integer references. It retains event identity; source metadata; one bounded excerpt; Verifier status, confidence, approved facts, uncertainty and contradictions; translated facts linked to their verified-fact indices; the full editorial fields needed for claim comparison; the geographic and entity projection; and ranking scores/reason. It does not retain the full article or add a second source excerpt. The excerpt remains capped at 1,000 characters.

The system prompt is versioned `critic-v4`, and the input schema is version 2. The original V3 prompt and builder remain available so prior runs stay interpretable. The compact field lengths are event 125, verification 599, translation 602, editorial 1,733, classification 266, ranking 681, sources 373, source evidence 1,173, geo 101, evidence catalog 66, and schema version 1; serialized JSON totals 5,875 characters.

## FACTUAL COVERAGE

The checkpoint loader verifies the same incident lineage across all five upstream checkpoints and runs the existing deterministic Critic prechecks. It also checks the incident-specific signals before constructing the compact input:

- TechCrunch AI remains the single source. The bounded source excerpt retains the WSJ attribution, the Journal attribution language, and TechCrunch's outreach to OpenAI.
- Verifier remains `single_source`; the uncertainty and two approved facts remain distinct.
- The complete Editor draft stays available to identify certainty escalation, attribution loss, and the unsupported internal-evaluation detail.
- The compact input keeps geography, entity and ranking signals.
- Existing Critic controls continue to cover a direct report, an attributed secondary report, and The Verge single-source case.

The execution path requires deterministic prechecks to pass and evidence references to validate. The database publication RPC checks those successful Critic run fields in addition to requiring one valid pass decision and its settled provider reservation. It also rechecks the source/event/article lineage and archived/non-public article state under lock.

## TOKEN TARGET

The V4 estimator reproduces 5,197 input tokens plus the unchanged 1,200-token output reserve, for **6,397 total estimated tokens**. Against the 8,000 TPM hard limit, gross headroom is 1,603 tokens. After the existing 128-token pacing margin, safe adjusted headroom is 1,475 tokens.

The output reserve remains 1,200. The current contract permits up to 50 findings, issue messages up to 1,000 characters, unsupported claims up to 1,500 characters and reasons up to 1,000 characters. The observed small outputs do not bound valid future output size, so this phase cannot prove a smaller safe reserve. Neither output contract nor reserve is reduced.

## CURRENT TERMINAL ATTEMPT

The original attempt is already terminal as `TECHNICAL_FAILURE`, stopped at `critic` with `cost_guard_violation`. Its terminal state, completion timestamp, stop stage and stop reason remain immutable. The local execution artifacts prove that the Critic reservation and dispatch did not occur. There is no Critic checkpoint. This phase has made no live database assertion because of the prior `PGRST303` read failure.

## WHY CONTINUATION IS NEEDED

The normal runner claims a new factual-remediation attempt and begins at Verifier. It cannot safely reopen this completed row, and migration 27's attempt accounting does not provide a same-attempt Critic continuation. A TypeScript-only bypass would leave publication disconnected from the attempt lifecycle. Migration 28 therefore adds a tightly scoped continuation state on the existing attempt row, while preserving its terminal fields and existing pilot attempt number.

## AUDIT MODEL

The continuation is attached to the exact existing attempt and stores a new continuation pipeline-run UUID, human authorization metadata, checkpoint hashes, restart stage, one-time status and outcome. Authorization and finalization RPCs accept only the incident identity and are granted to `service_role`; each RPC rejects other database roles. Explicit `authorizedBy`, `authorizationReference` and `reason` fields are required by the runner and persisted with the continuation.

The runner's default invocation is preflight-only. It does not load `.env.local`, construct a Supabase client, query remote state, reserve provider capacity, or write an artifact. Execution is gated by a distinct execution flag, a caller-provided new continuation-run UUID, and all authorization fields. Once explicitly invoked, it must revalidate remote attempt/article state and current Groq capacity before authorizing the one Critic call.

## CONTINUATION ELIGIBILITY

Eligibility is limited to this exact attempt, event, prior run and factual-remediation purpose. The attempt must still be terminal with the recorded Critic TPM pre-dispatch failure; local artifacts must prove no Critic request was dispatched; the five existing checkpoints must match their pinned SHA-256 hashes; Critic must have no checkpoint; no later attempt or sixth pilot attempt may exist; and no continuation may already be claimed. Restart stage is fixed to Critic. Any mismatch stops before dispatch.

The local preflight is a provisional eligibility assessment only. The migration and execution runner independently recheck live ownership and article state. The article must be archived and absent from the public view at authorization time and is checked again before any publication.

## DISPATCH PROOF

The saved execution artifact identifies `GROQ_TPM_STAGE_EXCEEDS_TPM`, 9,005 estimated tokens, zero Critic reservations, zero Critic dispatches, and 24 calls already used. The runner also queries the canonical agent-run and reservation ledger during a future authorized execution. Migration 28 requires canonical pre-dispatch evidence for the original failure, then records and verifies the single continuation Critic request. It refuses a second request, unsettled usage, a missing run, an invalid Critic result, failed prechecks, or invalid evidence references.

## ATTEMPT ACCOUNTING

The pilot remains at 5 of 5 attempts. A successful future Critic call would bring the provider-call total to 25 of 30. The one-time continuation can use at most one future model request. It does not create attempt 6 or count as another pilot attempt. Provider retries, paid fallback, the router and automatic editorial revision are disabled for this path.

## CHECKPOINT POLICY

Verifier, Translator, Editor, Classifier and Ranker checkpoints are reused only after local schema/lineage checks and exact hash comparison. The manifest records all five hashes, the source run, `resumeStage: critic`, and `criticCheckpoint: absent`. Critic is generated afresh once. Publisher can run only after a Critic pass, passing factual guards, canonical reservation settlement, live article archive validation and publication readiness. A Critic revise, reject, exception or failed guard finalizes/stops the continuation without Publisher.

## SECURITY

Migration functions use schema-qualified objects and a fixed `search_path`. They reject `anon` and `authenticated` roles and grant execution only to `service_role`. The runner's execution path does not enable secrets or remote access in preflight mode. No provider inference, remote database write, migration apply, article mutation, scheduler change, router change or Netlify change occurred in this phase.

## CONCURRENCY

The three lifecycle RPCs take the same event-key advisory transaction lock and lock the attempt row. Authorization requires a null continuation value, so only one caller can claim the continuation. Finalization checks the exact new run and the canonical request ledger. Publication revalidates ownership and the settled one-request Critic pass while holding the lifecycle lock and row locks. Repeated terminal finalization is idempotent; competing claims or altered terminal fields fail closed.

## MIGRATION 28

Prepared file: `supabase/migrations/20261002105220_factual_remediation_continuation.sql`. It adds one nullable JSONB continuation field to the existing attempt table and three incident-scoped service-role RPCs. It creates no table and no attempt row. No migration 29 was created. **Migration 28 has not been applied.**

## RUNNER

The script is `scripts/factual-remediation-critic-continuation-12c2b2c.ts`, exposed through `pipeline:factual-remediation:continuation:preflight` and `pipeline:factual-remediation:continuation:unit`. Preflight verifies the local checkpoint hashes, evidence coverage, prechecks, lineage and both estimates, while reporting that live archive and capacity checks remain outstanding. An execution command must provide `--execute-critic-continuation`, `--continuation-run-id=UUID`, `--authorized-by`, `--authorization-reference` and `--reason`; it cannot reuse the original pipeline-run UUID.

## OFFLINE VALIDATION

The unit fixtures cover the exact incident eligibility, invalid attempt states and identities, missing checkpoints, duplicate continuation, command authorization, the one-call Critic-to-Publisher success path, and stopping before Publisher on Critic revise/reject/failure. Static migration checks cover its filename, scope, role grants, locking, terminal-state immutability, attempt ceiling and publication guards. The targeted Critic suite covers the compact projection, both exact estimates and factual positive/negative controls. Full offline-suite, typecheck, lint, build and diff-check results are recorded in the companion JSON artifact after verification.

## NEXT STEP

After review, the next phase is **12C.2B.2d — APPLY + REMOTE VALIDATE CRITIC CONTINUATION LIFECYCLE**. A separate later phase may authorize the single Groq Critic call. This phase stops before both actions.
