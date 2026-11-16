# Factual remediation lifecycle — 12C.2B.1

**Current result: READY YES.** Remote validation passed against Supabase project `skrthgpurquypgdwxast`. Migration 27 was already applied when this run began, so it was not applied again. The isolated synthetic lifecycle passed, all synthetic rows were removed, all 55 offline suites passed, and the real incident stayed archived and absent from public content.

Validation date: 2026-10-02. Provider calls: 0. Real incident remediation attempts created: 0. Migration 28: absent.

## PRE-APPLY

- Read the full migration and ran its offline static/lifecycle regression (`npm run pipeline:factual-remediation:unit`): PASS, no table creation, Verifier-only restart, six maximum Groq calls, zero actual provider calls.
- Captured `git status --short` and `git diff --stat`. The working tree already contained extensive uncommitted work from prior phases; those changes were preserved and no commit was created.
- Confirmed the linked project ref and configured Supabase URL both resolve to `skrthgpurquypgdwxast`.
- Checked the linked migration history before taking action. Migrations 26 and 27 were already applied; 27 was latest. The validation therefore skipped `db push` and migration repair.
- Captured the incident, pilot, public-content, source-lineage, and provider-capacity baseline with read-only queries.

## REMOTE MIGRATION STATE

The final linked history still ends at `20260930211903` (migration 27). Migration 26 is applied, migration 27 is applied, and migration 28 is absent both remotely and locally. Migration 27 was **not applied during this validation run** because the remote history already contained it.

## APPLY

No apply command was run in this validation. No other migration was applied, repaired, or created.

## REMOTE OBJECTS

Migration 27 added remediation metadata columns and checks to `public.pipeline_event_attempts`, plus two partial unique indexes. It created no table. The remote catalog confirms:

- `pipeline_event_attempts_one_factual_remediation_idx` on `event_key` where purpose is `FACTUAL_REMEDIATION`.
- `pipeline_event_attempts_pilot_attempt_number_idx` on non-null `pilot_attempt_number`.
- Three RPCs: `claim_factual_remediation_attempt`, `claim_incident_factual_remediation_attempt`, and `publish_factual_remediation_article_atomic`.
- Service role has no direct INSERT, UPDATE, or DELETE permission on `pipeline_event_attempts`.

The full remote signatures, owners, constraints, grants, and catalog results are in [the JSON artifact](../artifacts/factual-remediation-lifecycle-12c2b1.json).

## SECURITY

All three RPCs are owned by `postgres`, are `SECURITY DEFINER`, and have the fixed `search_path=pg_catalog, public`. The remote catalog reports EXECUTE for `service_role` and denies it to `anon` and `authenticated`. The synthetic service-role request succeeded; an actual anonymous REST request was denied. The authenticated role check was performed against the remote EXECUTE ACL. No privilege was widened.

## NORMAL FINAL-STATE REGRESSION

A normal `claim_pipeline_event_attempt` against a synthetic prior attempt in `READY_FOR_PUBLICATION` returned `INELIGIBLE / PERMANENT_OUTCOME`. The scheduler and execution bridge continue to use the normal claim path; their offline scheduler, wiring, execution, bridge, and boundary tests passed. They do not invoke the dedicated remediation RPC or assign remediation purpose. Normal retry cannot reopen a terminal attempt.

## VALID REMEDIATION

Using only synthetic archived-article, event, source, raw-item, event-source, and prior-attempt rows, the service-role RPC returned `ACQUIRED`. The new attempt was number 2, had purpose `FACTUAL_REMEDIATION`, started at `VERIFIER`, and had no pilot ordinal. No model stage ran.

## INVALID CASES

All tested invalid cases were rejected: article not archived, unknown event, unknown article, article/event mismatch, wrong raw lineage, wrong prior state, wrong purpose, restart stage other than Verifier, invalid namespace, and missing human authorization. A duplicate active remediation was also rejected as `ACTIVE_ATTEMPT`.

## CONCURRENCY

Two simultaneous PostgreSQL requests for the same eligible synthetic event produced one admitted attempt and one `ACTIVE_ATTEMPT` rejection. No execution admitted two attempts.

## HISTORICAL IMMUTABILITY

The synthetic prior terminal attempt was byte-stable before and after remediation admission. No status, attempt number, timestamp, history, or checkpoint identity was reset.

## CHECKPOINT POLICY

The runner uses validated stored extraction and starts a fresh pipeline run at Verifier. Prior Verifier, Translator, Editor, Classifier, Ranker, and Critic checkpoints are not selected as remediation outputs. Pre-Verifier source/raw lineage is revalidated and may be reused. No model was executed during this validation.

## CAPACITY ISOLATION

The recorded pilot budget was 19/30 Groq calls (11 remaining) and stayed 19/30 because this phase used zero provider calls. Separately, before and during synthetic validation, the canonical 2026-10-02 UTC ledger showed 0 Groq requests, 0 Groq tokens, 0 unknown Groq reservations, 0 Cloudflare requests, and 0 reserved Neurons. Every ledger delta was 0. No provider, scheduler, router, publication, or Netlify action ran.

## REAL INCIDENT ISOLATION

The real article `756b0ee0-b5e6-4153-846f-278a12c9afe3` remained archived at its original slug and event. It still has exactly one historical attempt (#1, `READY_FOR_PUBLICATION`) and no factual-remediation attempt. The pilot remains 4/5. Its raw-item hash, source relationship, and incident/event/article row hashes matched before and after validation.

The public contract still contains exactly two articles. The incident is absent, and both other public rows retained their hashes. A request to the local production route `/noticias/openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad` returned HTTP 404.

## CLI PREFLIGHT

`npm run pipeline:factual-remediation:preflight` returned `mode: preflight`. It showed `FACTUAL_REMEDIATION`, restart at Verifier, stored extraction validated and reused, old Verifier-onward checkpoints ignored, accounting `4/5 -> unchanged`, maximum 6 Groq calls, 849 quota remaining, 0 provider calls, and 0 remote writes. The orchestration preview includes deterministic Geo and Publisher steps; its six potential Groq stages are Verifier, Translator, Editor, Classifier, Ranker, and Critic. No claim or publication occurred.

## CLEANUP

The synthetic run used namespace `12c2b1:8df410ce-60f4-4666-9866-21988bfe25c3`. Its exact cleanup removed the synthetic source, four events, four articles, five raw items, four event-source links, four prior attempts, and two remediation attempts. Residual rows were zero in all six checked relations: attempts, events, articles, raw items, sources, and event-source links.

## BASELINE RESTORATION

The post-cleanup snapshot matched the pre-fixture baseline. The incident stayed archived, the historical attempt stayed final, real remediation attempts stayed at zero, pilot matches stayed at 4/5, public count stayed at two with unchanged public-row hashes, and provider-capacity ledgers stayed unchanged. This revalidation made no schema changes; migration 27 was already applied before it began.

After remote validation and cleanup, 55 offline suites passed: all 54 `:unit` scripts and `agents:contracts:test`. This includes migration/factual-remediation, normal attempt lifecycle, scheduler and bridge wiring, orchestrator, checkpoint resume, factual guards, all agent suites, publisher, public contract, production gate, and the quality benchmark. `npm run lint`, `npx tsc --noEmit`, `npm run build`, and `git diff --check` passed. The incident route returned 404 from the local production server. ESLint emitted no errors; its warnings were removed before the final checks.

An earlier report recorded the benchmark fixture failure `SOURCE_EVIDENCE_MISSING`. The fixture now obtains Ars evidence only through the exact validated raw-item lineage, leaves the evidence guard intact, and does not fabricate MIT evidence. The quality benchmark unit suite passes; historical 10G.7 artifacts remain preserved.

## NEXT STEP

**12C.2B.1 READY YES.** The next authorized phase is 12C.2B.2 — execute factual remediation from Verifier. It may use pilot attempt 5/5 and up to six Groq calls with `maxRetries=0` and no fallback. This validation did not execute that phase; stop here.
