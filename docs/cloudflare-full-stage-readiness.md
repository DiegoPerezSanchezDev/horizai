# 10G.5 — Cloudflare full-stage compatibility and capacity audit

> **Current-state notice (10G.7a):** this document preserves historical 10G.5/10G.6e evidence and some point-in-time statements below are superseded. The current technical matrix is 6/6; quality, capacity, scheduler and routing approvals remain independent. See docs/cloudflare-production-gate-10g7a.md for the current audit and activation gate state.

## 10G.6e — supervised Ranker validation (2026-09-25)

Ranker compatibility is now `REAL_VALIDATED` after exactly one supervised Cloudflare request using the real `ranker-v1` and canonical `ranker:confirmed-launch` unit fixture. The request returned HTTP 200 with `finish_reason=stop`; generation Zod, the exact model-owned fields (`impact`, `novelty`, `economicImpact`) and integer 0–100 scores passed. The real agent then deterministically computed credibility 90, reach 66, momentum 95 (controlled fixture activity-history supplied; momentum available), and final importance 63.7. The shared importance helper independently recomputed 63.7. Response repair: none. Reservation/dispatch delta: +1/+1, with 360 reserved Neurons; token-based post-response estimate: 28 Neurons. Provider-reported actual Neurons remain unknown.

The compatibility result is technical only; semantic ranking quality for impact, novelty and economic-impact judgments remains `NOT_CERTIFIED`. The capability state keeps independent gates: `technicalAllStagesValidated=true`, `semanticQualityGateValidated=false`, `capacityProductionReady=false`, `productionRoutingEnabled=false`. Production provider/routing settings were not changed, and no event or article was created.

The six-stage offline capacity snapshot for this validation is stored in `artifacts/cloudflare-capacity-snapshot-10g6e.json`. It uses one real validation sample per stage, re-reads reservation and token telemetry from Supabase, labels post-response Neurons as estimates rather than actual usage, and is not a production guarantee. No settlement or router capacity logic was changed.

The capacity report's blocked-secondary policy simulation remains an explicit hypothetical with stage validation set to false; this keeps the fail-closed scenario testable after the live compatibility matrix reaches 6/6. It does not alter the current matrix or enable routing.

10G.5 snapshot status: offline audit complete; no Cloudflare, Groq or Cerebras inference was called during that phase. Production defaults and routing were unchanged.

## Stage inventory

All six model-backed stages enter through `runStructuredAgent` and the common `ModelProvider` interface. Supervised validation must call each real agent with its canonical unit fixture; it must not replace the prompt, generation schema, postprocessor or deterministic guards. `geo`/coordinate resolution is deterministic and is not an LLM stage.

| Stage/version | Prompt builder / generation contract | Output checks and provider/runtime path | Defaults, retry and side effects |
|---|---|---|---|
| Verifier / `verifier-v1` | `verifierSystemInstructions`; `VerificationResult` Zod schema | `buildVerifierModelInput` caps source text and records truncation; output Zod checks enums, integer confidence and source IDs; `VerifierAgent.verify` → `runStructuredAgent` | `strict_schema`; configured retries (current 2, bounded); optional run/log telemetry only; accepts one-source clusters. Evidence/source handling is the key risk. |
| Translator / `translator-v1` | `translatorSystemInstructions`; provider returns `TranslatorGeneration`, then trusted code assembles `TranslationResult` | Generation schema requires unique `factIndex` values; assembly requires every verified fact exactly once and restores source text/IDs from input; `TranslatorAgent.translate` → runtime | `strict_schema`; configured retries (current 2, bounded); logs only. Output fidelity, mapping, and uncertainty invariants are deterministic checks; source text is not sent in full. |
| Editor / `editor-v2` | `editorV2SystemInstructions`; provider returns six fields, then code assembles `EditorialDraft` and slug | Real final-schema parse plus headline, URL, numeric/date provenance, preserved-name mutation/omission and full-source-copy guards; `EditorV2Agent.edit` → runtime | `json_object`; configured retries (current 2, bounded); logs only. Largest editorial QA surface: numeric provenance, names/versions, body and slug constraints. |
| Classifier / `classifier-v1` | `classifierSystemInstructions`; `ClassifierGeneration` | Allowed region/category registry, ISO country codes, category count, entity normalization and deterministic `resolveGeo`; `ClassifierAgent.classify` → runtime | `json_object`; configured retries (current 2, bounded); default path reads active registries from Supabase, so supervised fixture must inject `classifierFixtureRegistry`; no article writes. |
| Ranker / `ranker-v1` | `rankerSystemInstructions`; `RankerGeneration` has only `impact`, `novelty`, `economicImpact` | Zod integer scores; production code computes reach, credibility, momentum, final importance score and rank reason; `RankerAgent.rank` → runtime | `json_object`; configured retries (current 2, bounded); no article write. Smallest model contract; deterministic ranking formula remains authoritative. |
| Critic / `critic-v3` | `criticSystemInstructions`; `CriticGenerationV3` with evidence indices | Deterministic prechecks, evidence-catalog index resolution, Critic routing and final `CriticResult` validation; `CriticAgent.critique` → runtime | `json_object`; configured retries (current 2, bounded); default path reads the reference registry, so future fixture validation must inject it. Real Llama result was `pass`, findings 0; non-empty evidence-reference branch remains unexercised. |

Every agent accepts an injected `ModelProvider` and a model-config override. The Cloudflare adapter uses `max_tokens`; the OpenAI-compatible Groq adapter continues to use `max_completion_tokens`. All six current output limits resolve to 1,200 from `AGENT_MAX_OUTPUT_TOKENS`; production `AGENT_MAX_RETRIES` currently resolves to 2. Future supervised calls must set exactly one attempt and zero retries in the wrapper, without changing an agent's prompt or output contract.

The agents do not persist articles. Logger-backed `agent_runs`/`agent_logs` are the observability side effect; Classifier and Critic can also read reference data unless the supervised wrapper supplies the canonical in-memory registry. The planned validator remains dry-run and synthetic-fixture-only.

## Compatibility matrix and risk order

| Stage | Cloudflare Llama status | Main risk |
|---|---|---|
| Verifier | `NOT_VALIDATED` | Evidence/source attribution, status/confidence semantics and potentially long source input |
| Translator | `NOT_VALIDATED` | Spanish fidelity and one-to-one fact-index assembly while preserving names, uncertainty and contradictions |
| Editor | `NOT_VALIDATED` | Numeric/date provenance, preserved names, editorial field completeness, body and slug rules |
| Classifier | `NOT_VALIDATED` | Strict registry membership and entity/country constraints; geo coordinates must remain deterministic |
| Ranker | `NOT_VALIDATED` | Keep the model to three semantic dimensions and keep deterministic scores/formula outside it |
| Critic | `REAL_VALIDATED_WITH_UNEXERCISED_NONEMPTY_EVIDENCE_BRANCH` | One real `critic-v3` Llama call returned HTTP 200 and `pass`; no model-generated non-empty evidence indices were exercised |

Recommended one-call-at-a-time order for the five remaining stages:

1. **Editor** — highest number of independent deterministic quality gates, with numeric provenance and name/version preservation most likely to expose model incompatibility.
2. **Verifier** — source evidence attribution and `VerificationResult` semantics are central and fail-closed; validate before trusting downstream material.
3. **Translator** — validate the full fact-index assembly and Spanish fidelity after the verification contract is stable.
4. **Classifier** — registry-constrained generation, with deterministic geo resolution kept separate.
5. **Ranker** — smallest model output surface; deterministic components and final score remain code-owned.

Stop the sequence after the first stage failure. Each future stage validation is at most one provider request, one attempt and zero retries. Critic is not to be called again merely to cover its already exercised stage path.

## Canonical fixtures and current configured capacity

The report is generated offline by `npm run provider:cloudflare:stage:capacity`. It invokes the real model-input builders and strict provider schema conversion on the existing unit fixtures. `fixtureInputChars` is the serialized model-facing JSON size; the estimate includes prompt and strict schema lengths. It is an approximation, **not tokenizer-exact**.

| Stage | Unit fixture | Input chars | Prompt chars | Strict schema chars | Estimated input tokens | Max output | Cloudflare field | Conservative reservation |
|---|---|---:|---:|---:|---:|---:|---|---:|
| Verifier | `verifier:unit:confirmed-two-source` | 995 | 2,284 | 1,228 | 2,382 | 1,200 | `max_tokens` | 388 Neurons |
| Translator | `translator:unit:gpt-5-launch-2026` | 715 | 3,594 | 591 | 2,578 | 1,200 | `max_tokens` | 394 Neurons |
| Editor | `editor:canonical-editor-input` | 1,552 | 2,727 | 349 | 2,442 | 1,200 | `max_tokens` | 390 Neurons |
| Classifier | `classifier:fixture-new-openai-model` | 1,167 | 1,746 | 570 | 1,870 | 1,200 | `max_tokens` | 370 Neurons |
| Ranker | `ranker:confirmed-launch` | 1,162 | 1,465 | 203 | 1,543 | 1,200 | `max_tokens` | 360 Neurons |
| Critic | `critic:canonical-pass-fixture` | 6,420 | 2,128 | 1,413 | 5,109 | 1,200 | `max_tokens` | 479 Neurons |

All six fixtures execute their stage independently once upstream-shaped fixture data is supplied. Classifier and Critic need the in-memory reference registry passed explicitly to avoid a database read. Fixture inputs exercise the real stage builder/schema, but do not represent the upper bound of production news content.

Rates are centralized in `free-provider-router.ts` and selected by Cloudflare model; stage code contains no pricing. Current Llama defaults are 26,668 input and 204,805 output Neurons per million tokens with a 125% safety margin; environment overrides remain model-specific. Cloudflare documents a 10,000 Neuron/day free allocation and the same Llama rates on its [Workers AI pricing page](https://developers.cloudflare.com/workers-ai/platform/pricing/). The configured allocation is 10,000; the internal soft limit is 85% (8,500 Neurons). The capacity report refuses to estimate if allocation is not configured.

The existing estimator is:

```text
estimatedInputTokens = ceil((systemPromptChars + JSONInputChars + strictSchemaChars) / 2) + 128
```

Per-stage reservation uses the model-specific rates and safety margin with the full configured `maxOutputTokens`. The conservative full-event reservation is **2,381 Neurons**. With no downward settlement, clean-day conservative admission capacity is **3 full events** under the 8,500 soft cap. Ten full Cloudflare events reserve **23,810 Neurons**, so the result is `FAIL_CAPACITY_BY_RESERVATION` (15,310 over the soft cap). At the last known 10G.4 accounting snapshot, 846 Neurons were reserved and soft remaining was 7,654; that would still allow three more conservative fixture-sized full events, not four. This snapshot was not refreshed against Supabase during 10G.5.

`observedFullEventNeuronEstimate = INSUFFICIENT_SAMPLE`: only Critic has a real Cloudflare agent-stage token sample. Its 10G.4 request reported 2,070 input and 7 output tokens, producing a **post-response estimate** of 73 Neurons; Cloudflare did not report actual per-request Neuron usage. The historical reservation was 482 Neurons, ratio `482 / 73 = 6.60x` (409 Neurons above that estimate). This ratio applies only to that Critic request and is not generalized. The current canonical Critic capacity fixture estimate (479) is a different request shape.

Keep usage states distinct: `RESERVED_ESTIMATE`, `POST_RESPONSE_ESTIMATE`, and `ACTUAL_PROVIDER_USAGE`. The latter is unknown in available real telemetry.

### Ten-event mixed-route policy simulation

Offline fixtures assume 8,000 Cloudflare Neurons are available and explicitly separate that capacity fact from stage compatibility:

- With Groq assumed eligible as primary, ten new events remain assigned to Groq; Cloudflare receives zero. `PASS_POLICY_ONLY` — Groq account capacity is an assumption, not a provider-limit guarantee.
- If Groq is unavailable but Cloudflare has 8,000 Neurons, all ten events are blocked because the five remaining stages are not validated. Cloudflare receives zero. `PASS_FAIL_CLOSED`.
- No event can start on Groq and automatically switch stages to Cloudflare. Checkpoint rescue is outside this router decision.

## Supervised validation capability and migration decision

Migrations 21 and 22 provide the shared Cloudflare Neuron reservation ledger but restrict the Llama exception to the 10G.3c synthetic check. Migration 23 adds a dedicated `critic-v3` reservation function. It cannot safely authorize Verifier, Translator, Editor, Classifier or Ranker. **One generic forward-only migration 24 is therefore needed and prepared locally; it has not been applied remotely.** No migration-per-agent pattern is introduced.

`20260924000024_cloudflare_supervised_stage_validation.sql` creates one service-role-only RPC. It constrains provider to `cloudflare_workers_ai`, model to the Llama validation candidate, stages to the six model stages, agent/version/fixture/purpose to a per-stage allowlist, event keys to synthetic UUID validation identities, attempts to 1, and retries to 0 in the audit payload. It requires a matching `dry_run` run, the UTC date, atomic advisory locks, a configured free Neuron allocation no greater than the 10,000-Neuron hard cap, and the existing daily reservation ledger. Execution is revoked from `public`, `anon`, and `authenticated`; only `service_role` receives execute. The SQL does not alter tables or RLS, does not enable production routing and does not modify migration 23.

The generic command is currently a **plan-only** argument validator at `scripts/cloudflare-stage-validation.ts`; it accepts only `stage`, `fixture`, `provider`, and `model`, rejects non-allowlisted values, and has no inference path in 10G.5. For the future supervised runner, construct the real agent with the injected Cloudflare provider and its normal real fixture, override only provider/model plus the explicit zero-retry supervised limit, inject the fixture registry where required, use the generic reservation RPC, and call the real agent once. Do not alter production defaults, agent prompts, schemas or postprocessors. `--execute` is rejected in this phase.

## Full-event routing guard

`cloudflareAllRequiredStagesValidated` is independent from model free status, structured-output candidacy and available capacity. `routeFreeProviderEvent` defaults this capability to false; its full-event selector allows Cloudflare only when router is explicitly enabled, all six required stages are marked validated, and free capacity is eligible. Groq remains preferred. A test supplies **8,000 free Neurons with Editor not validated** and confirms the event is denied to Cloudflare. `allStagesValidated` is false today. Partial event routing and automatic mid-event provider changes remain forbidden.

## Settlement audit — design only

No settlement code was added. Current behavior retains dispatched reservations. Options:

| Option | Benefit | Risk / safety condition |
|---|---|---|
| A. No settlement | Strongest protection against undercounting | Conservative reservations consume the soft budget quickly; current estimate allows only 3 fixture-sized full events/day |
| B. Settle to post-response token-derived estimate plus margin | Can improve capacity | Token counts and published rates are still estimates, not actual Neurons; requires independently validated tokenizer/price assumptions and a non-releasable safety floor |
| C. Hybrid bounded release | Limits how much unused reserve is returned | Bounded percentage is a policy choice and can still undercount unless based on calibrated evidence; unresolved usage must retain the full reservation |
| D. Provider-reported actual usage | Best measurement if authoritative per-request Neurons become available | Such usage was not present in current response telemetry; dashboard/day aggregates are not a safe per-request settlement source |

Never release reservation on missing usage, a post-dispatch failure, or failed telemetry persistence. Settlement is **not selected or implemented**. It is necessary to reach ten Cloudflare-only fixture-sized events within the current soft allocation, but whether it is necessary for the overall 10-article/day target is **undetermined** because Groq account capacity and actual event sizes are not established here.

## Validation boundary and state

Offline unit tests cover the six-stage matrix, full-event gate, stage/provider/model/fixture allowlists, synthetic identity, `max_tokens` mapping per stage via mock fetch, estimator arithmetic, Neuron reservations, 10-event reservation result, and Groq-primary/Cloudflare-secondary policy. Migration 24 received static SQL boundary tests only; it was not applied or run against a database.

At the end of 10G.5:

- Production provider remains Groq.
- FreeProviderRouter and automatic Cloudflare routing remain disabled.
- Cloudflare full-event compatibility remains false; only Critic has the qualified real-validation status described above.
- No scheduler, publisher, article persistence, RLS or UI changes were made.
- Cloudflare, Groq and Cerebras inference calls: **0**.
