# Cloudflare quality benchmark — 10G.7b.3 review

## EXECUTION SUMMARY

**Technical result: 7/7 calls completed.** The production Verifier, Translator, Editor, Classifier, Ranker, Ars Critic, and MIT Critic ran sequentially with `cloudflare_workers_ai` and `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Each response was HTTP 200, finished with `stop`, passed Zod validation, and used exactly one attempt. There were no retries, repairs, fallbacks, provider substitutions, or technical failures. Groq, Cerebras, and other providers received zero calls.

The initial `npm run` invocation did not forward the execution argument; it ran the safe preflight mode and made zero provider calls. The benchmark then ran through the repository CLI with `--execute-quality-benchmark` explicitly. No inference was run after the seventh call.

- UTC period: `2026-09-27T16:25:00.294Z`–`2026-09-27T16:25:43.625Z`
- Planned / completed / dispatched: `7 / 7 / 7`
- Total tokens reported by the provider: `12,621` input + `1,113` output = `13,734` total
- Overall semantic status: `HUMAN_REVIEW_REQUIRED`
- `qualityBenchmarkCompleted=true`; this records technical completion and does not approve quality.

## CAPACITY

The live UTC-day baseline was 0 Cloudflare reservations and 0 reserved Neurons, with usage known and no active temporary provider block. The effective soft limit was 8,500 and the hard free allocation was 10,000. The normal provider-scoped admission check ran before each dispatch; all seven decisions were eligible under both limits.

| Call | Reserved Neurons | Pre-call projected Neurons | Soft / hard limits | Token-derived estimate |
|---|---:|---:|---:|---:|
| Ars Verifier | 530 | 530 | 8,500 / 10,000 | 184 |
| Ars Translator | 395 | 925 | 8,500 / 10,000 | 89 |
| Ars Editor | 397 | 1,322 | 8,500 / 10,000 | 109 |
| Ars Classifier | 389 | 1,711 | 8,500 / 10,000 | 48 |
| Ars Ranker | 380 | 2,091 | 8,500 / 10,000 | 37 |
| Ars Critic | 510 | 2,601 | 8,500 / 10,000 | 123 |
| MIT Critic | 509 | 3,110 | 8,500 / 10,000 | 90 |
| **Total / final** | **3,110** | **3,110** | **5,390 soft headroom / 6,890 hard headroom** | **680** |

The 680 value is a token-derived estimate. It is not actual Cloudflare Neuron usage and was not used to settle or reduce any reservation. Provider-reported actual Neurons remain `UNKNOWN`. All seven dispatched reservations and benchmark run records remain in the remote accounting ledger.

## INPUT PROVENANCE

All seven stage inputs were finalized and hashed before the first inference. No new Cloudflare output was chained into a later stage.

| Case / stage | Historical input relationship | Input SHA-256 |
|---|---|---|
| Ars Verifier | `RECONSTRUCTED_FROM_CHECKPOINT` | `sha256:1a47666269b80267d4b34a888137006561022f8d51fed7dafe77d5b14b9eb6a4` |
| Ars Translator | `PROVEN_FROM_STORED_MODEL_INPUT` | `sha256:c5a6d19e8680c319fb86d7a5279ab2319f1cfc0783b1eb7672b3fe65ec75e188` |
| Ars Editor | `RECONSTRUCTED_FROM_CHECKPOINT` | `sha256:31450d6f4980f5e28725352c9bc1f9c4a0598540b2e6c2451e54d21e3f61467c` |
| Ars Classifier | `REGISTRY_NOT_STORED` | `sha256:018b802bb52ca3fd49a0217365d6df5702642831d9fd75a9d97faa77b503af84` |
| Ars Ranker | `RECONSTRUCTED_FROM_CHECKPOINT` | `sha256:beaf922ae764361d955103fb0a46faa1cebbe8654d0bdd431171bc457e5c94b0` |
| Ars Critic | `RECONSTRUCTED_FROM_CHECKPOINT` | `sha256:4d8134beec23d3a55d57a34ebc749e62bccdeb0d5b8eb39ab036c8f8beb636fb` |
| MIT Critic | `RECONSTRUCTED_FROM_CHECKPOINT` | `sha256:77db9f1e8ba2a7012f35181db011c63abf26676dec445fb3021ff88e0d186b00` |

For Ars Verifier, the remote `raw_items` row was read by ID `93dea107-8bbf-42a5-8314-c0b4c70522ec`. Its source ID, external ID/source-item ID, normalized source URL, and repository-normalized extracted-content SHA-256 matched the saved lineage: `f2c5f58e-064d-4d9d-8f44-128d5b3bec38`, `f2c5f58e-064d-4d9d-8f44-128d5b3bec38:790cf36b99eec5abd380bb664c1d179c`, `https://arstechnica.com/security/2026/09/muse-metas-extraordinarily-privileged-ai-assistant-has-a-serious-0-day`, and `sha256:7aa373cdeeb56947806f21460d97042739cd62f7f8d3dd812c0a41d9e7dd7f84`. No title-only match was used.

The Translator input hash exactly matches the stored historical model-input projection. The Editor, Ranker, and both Critic inputs were independently reconstructed from their stage checkpoints. The Classifier used the audited current registry because historical registry ordering/snapshot was not persisted. MIT remains a clean Critic control only; its raw-item lineage is missing, and MIT Verifier was not run.

## ARS VERIFIER

- Telemetry: HTTP 200; `stop`; 2,461 input / 392 output / 2,853 total tokens; 15,846 ms; Zod valid; 1 attempt, 0 retries.
- Output: `confirmed`, confidence `90`, four verified facts, no contradictions, no uncertain claims. All four facts cite the same single source ID.
- Historical Groq output: `single_source`, confidence `85`, one verified fact.
- Deterministic source checks found the source terms for zero-day, Muse/Meta, transcription endpoint, token, hotfix, 12-hour timing, Amazon, and restriction/blocking language. A literal “full account control” match was not found by the lexical check. This only checks terms; it does not prove that each full proposition is entailed.
- Deterministic result: contract and source mapping `PASS`; corroboration discipline and confidence calibration `HUMAN_REVIEW_REQUIRED`.
- Semantic status: `CONCERN`. The `confirmed` label and confidence 90 deserve review for a one-source case, and the four-fact expansion needs claim-by-claim confirmation. No invented second source ID was observed.

Human questions: ¿es prudente el status para una noticia de una sola fuente? ¿la confianza parece demasiado alta o baja? ¿cada hecho marcado como verificado está sustentado? ¿inventa corroboración que no existe?

## ARS TRANSLATOR

- Telemetry: HTTP 200; `stop`; 982 / 214 / 1,196 tokens; 6,967 ms; Zod valid; 1 attempt, 0 retries.
- One expected fact was translated at index 0; the received index was `[0]`, the final translation contract passed, and no digit/date/percentage inventory item was changed.
- Names retained: `Muse`, `Meta`, `Ars Technica AI`. Historical Groq preserved `Muse` and `Meta`.
- Wording to review: `zero-day` became `0 días` instead of the more natural `día cero`; “transcription endpoint” became “punto de transcripción final,” which may change the technical meaning of endpoint. The core statement about local apps/terminal commands, token access, and account control remains present.
- Deterministic checks: expected/generated/translated fact count `1/1/1`; index and final schema `PASS`. Unsupported additions were not mechanically detected; semantic fidelity is not automatically certified.
- Semantic status: `CONCERN`; Spanish quality `HUMAN_REVIEW_REQUIRED`.

Cloudflare title: “Muse, asistente de IA de Meta con privilegios extraordinarios, tiene una grave vulnerabilidad de 0 días”.

Cloudflare fact: “Una vulnerabilidad de 0 días en el asistente de IA Muse de Meta permite que las aplicaciones o comandos de terminal que se ejecutan localmente cambien el punto de transcripción final y obtengan el token de autenticación del usuario, lo que da el control total de la cuenta de Muse.”

Human questions: ¿suena escrito originalmente en español? ¿conserva con precisión el sentido? ¿hay traducciones literales raras? ¿cambia nombres o cifras? ¿introduce afirmaciones nuevas? ¿la redacción tiene nivel publicable para HorizAI?

## ARS EDITOR

- Telemetry: HTTP 200; `stop`; 1,077 / 282 / 1,359 tokens; 8,221 ms; Zod valid; 1 attempt, 0 retries.
- Deterministic assembly and final editorial structure passed. The two protected names were observed and preserved; no omission or mutation was reported. No numeric claims were present to trigger a numeric-provenance change.
- Historical editorial input included the unsupported statement about Meta confirming the flaw and patch status. The Cloudflare draft did not repeat that statement.
- Semantic status: `HUMAN_REVIEW_REQUIRED`. The draft is brief and repeats the same mechanism in summary/body; its “Por qué importa” adds a plausible security implication that still needs editorial judgment.

**Titular:** Detectan vulnerabilidad de día cero en asistente de IA de Meta

**Resumen:** Se ha descubierto una vulnerabilidad de día cero en el asistente de IA Muse de Meta, que permite a aplicaciones y comandos que se ejecutan localmente cambiar el punto final de transcripción y obtener el token de autenticación del usuario.

**Por qué importa:** Esta vulnerabilidad es importante porque podría permitir a atacantes obtener control total de la cuenta Muse, lo que podría tener consecuencias de seguridad graves para los usuarios.

**Cuerpo:** La vulnerabilidad de día cero en el asistente de IA Muse de Meta es un problema de seguridad serio, ya que permite a aplicaciones y comandos locales obtener el token de autenticación del usuario y cambiar el punto final de transcripción, lo que da a los atacantes control total de la cuenta.

**Puntos clave:** vulnerabilidad de día cero en Muse de Meta; acceso al control de la cuenta por aplicaciones/comandos locales; posibles consecuencias graves para los usuarios.

Human questions: ¿titular fiel y no clickbait? ¿resumen fiel? ¿“Por qué importa” añade análisis razonable sin inventar hechos? ¿texto original en español? ¿estructura clara? ¿alguna afirmación sin apoyo? ¿parece publicable?

## ARS CLASSIFIER

- Telemetry: HTTP 200; `stop`; 917 / 59 / 976 tokens; 2,422 ms; Zod valid; 1 attempt, 0 retries.
- Selected categories: `innovacion`, `regulacion`, `empresas`. Historical Groq selected `empresas`, `modelos`, `investigacion`.
- Region and country: `US` / `US`; resolved coordinates `39.8283, -98.5795`. Company `Meta`, model `Muse`, technology `AI`; no people.
- Existing assembly checks validated allowed category IDs, registered region, ISO country code, entity normalization, and geo resolution. Semantic appropriateness of `regulacion` and the added `AI` technology still needs human review.
- Semantic status: `HUMAN_REVIEW_REQUIRED`.

Human questions: ¿categorías defendibles? ¿falta una categoría evidente? ¿hay alguna selección extraña? ¿región correcta?

## ARS RANKER

- Telemetry: HTTP 200; `stop`; 887 / 22 / 909 tokens; 1,688 ms; Zod valid; 1 attempt, 0 retries.
- Cloudflare: impact `80`, novelty `60`, economic impact `40`; deterministic credibility `58`, reach `34`, momentum `50`; final importance `56.4`.
- Historical Groq: impact `80`, novelty `70`, economic impact `60`; deterministic credibility `58`, reach `34`, momentum `50`; final importance `59.9`.
- Deterministic signals matched. The canonical `ranking-v1` assembly and final result passed; `80×25% + 60×15% + 34×20% + 58×20% + 40×10% + 50×10% = 56.4`.
- Semantic status: `HUMAN_REVIEW_REQUIRED`. No equality with Groq is expected and no winner is selected.

Human questions: ¿impact razonable? ¿novelty razonable? ¿economicImpact razonable? ¿hay valores extremos sin justificación evidente?

## ARS CRITIC PROBLEM CASE

- Telemetry: HTTP 200; `stop`; 2,567 / 137 / 2,704 tokens; 4,876 ms; Zod valid; 1 attempt, 0 retries.
- Cloudflare emitted two findings: a low `verification_factual_accuracy` concern for `single_source`, and `UNSUPPORTED_CLAIM_EDITORIAL` (medium) for “Meta ha confirmado la existencia de la falla”.
- Historical Groq emitted `UNSUPPORTED_CLAIM_EDITORIAL` at high severity and routed to `revise_editorial`. Cloudflare detected the known genuine problem: **YES**. Its final decision was still `pass`, with global severity low.
- The nonempty evidence branch was exercised. Indices `[0, 1, 3, 7]` were in range and resolved to `source:0`, `verifiedFact:0`, `editor:headline`, and `editor:body`. There were zero invented indices; normal Critic finalization reported evidence references validated and four resolved references. The editorial body at index 7 contains the unsupported confirmation claim; the source and verified-fact entries identify the single-source evidence context.
- Deterministic result: evidence resolution `PASS`; semantic status `CONCERN` because Critic identified the issue but did not route or rate it like the historical high-severity blocker.

Human question: ¿detecta un problema real y la decisión/severidad resultante es adecuada?

## MIT CRITIC CONTROL

- Telemetry: HTTP 200; `stop`; 2,617 / 7 / 2,624 tokens; 1,699 ms; Zod valid; 1 attempt, 0 retries.
- Cloudflare and historical Groq both returned `pass`, no findings, severity low. Deterministic prechecks passed; no evidence indices were generated; no fabricated severe finding was observed.
- Semantic status: `HUMAN_REVIEW_REQUIRED`. This remains a single-source control with missing raw-item lineage, not a verifier test.

Human question: ¿es aceptable la ausencia de findings y la conducta del Critic en este control limpio?

## CROSS-PROVIDER OBSERVATIONS

All historical runs are `CONFIRMED_GROQ`; these are comparisons, not gold labels. No overall winner or scalar quality score is assigned.

- Verifier: Cloudflare changes status from `single_source` to `confirmed`, raises confidence from 85 to 90, and returns four facts instead of one, while still citing only the same source.
- Translator: both preserve the core fact and entities; Cloudflare’s `0 días` and `punto de transcripción final` need Spanish/technical review.
- Editor: Cloudflare omits the historical unsupported patch/confirmation statement and writes a much shorter draft.
- Classifier: US and Meta/Muse align; category choices differ and Cloudflare adds `AI` as a technology.
- Ranker: deterministic fields match; subjective novelty and economic impact are lower in Cloudflare’s output.
- Ars Critic: both identify `UNSUPPORTED_CLAIM_EDITORIAL`; Cloudflare lowers severity and returns `pass` instead of `revise_editorial`.
- MIT Critic: both return `pass` with no findings.

## DETERMINISTIC CHECKS

- All seven responses: HTTP 200, finish `stop`, JSON parseable, schema/Zod valid, one dispatched provider request, zero retries.
- Translator: one expected fact and one translated fact; received index `[0]`; final translation assembly valid.
- Editor: final editorial draft and assembly valid; two protected names preserved with no reported mutation/omission; no numeric tokens to reconcile.
- Classifier: all selected category IDs and region are in the supplied current registry; country code `US` valid; normalized entities and US geo output passed production assembly.
- Ranker: deterministic signals and ranking-v1 recomputation passed.
- Ars Critic: nonempty evidence reference branch exercised, four references resolved, no invalid indices.
- MIT Critic: deterministic prechecks passed; no findings to resolve.
- Ars Verifier source mapping points only to the exact linked raw item and its single source ID. Lexical checks are useful diagnostics, not semantic proof.
- Production isolation: after counts match the prior audit—articles 0, events 0, raw_items 150, pipeline_event_attempts 3, scheduler_runs 1, event_sources 0, article_entities 0, article_categories 0. Only benchmark accounting/run rows were added.

## SEMANTIC CONCERNS

1. Verifier’s `confirmed` status and confidence 90 on a one-source case, plus the additional verified facts, need factual and calibration review.
2. Translator wording around “zero-day” and “endpoint” may be unnatural or technically imprecise.
3. Editor is valid and omits the historical unsupported patch claim, but the body is brief and repetitive; review its implications and publication quality.
4. Classifier’s category changes and extra `AI` technology require taxonomy judgment.
5. Ranker lowers novelty and economic impact; human calibration is required.
6. Ars Critic finds the unsupported editorial claim but still returns `pass` and lowers its severity from historical high to medium.

No benchmark result changes `semanticQualityGateValidated`; it remains `false`. A human decision is still required.

## MULTI-SOURCE LIMITATION

`REAL_MULTI_SOURCE_QUALITY_EVIDENCE=MISSING`. The Ars Verifier case has one source. The MIT case is a Critic-only clean control with no raw-item lineage. This benchmark does not validate corroboration, cross-source consistency, or multi-source Verifier quality.

## HUMAN DECISION CHECKLIST

- Verifier factual discipline acceptable? YES/NO — HUMAN
- Translator fidelity acceptable? YES/NO — HUMAN
- Translator Spanish quality acceptable? YES/NO — HUMAN
- Editor factual discipline acceptable? YES/NO — HUMAN
- Editor editorial quality acceptable? YES/NO — HUMAN
- Classifier choices acceptable? YES/NO — HUMAN
- Ranker subjective calibration acceptable? YES/NO — HUMAN
- Critic detects genuine problem? YES/PARTIAL/NO — HUMAN
- Critic clean-control behavior acceptable? YES/NO — HUMAN
- Cloudflare quality sufficient for secondary production routing? YES/NO — HUMAN

## REGRESSION VERIFICATION

The requested offline regression suites passed: benchmark, migration 26, Cloudflare stage validation, all six agent suites, Critic checkpoint/evidence, numeric provenance, Cloudflare provider, budget, router, cost policy, reservation lifecycle, telemetry, pipeline, pipeline semantics, scheduler, agent contracts, and the 10G.7a production gate. `npm run lint`, `npx tsc --noEmit`, and `npm run build` also passed. This verification made no provider inference calls.

## NEXT STEP

**10G.7b.3 technical status: READY YES.** `technicalAllStagesValidated=true`; `qualityBenchmarkCompleted=true`; `humanQualityDecisionRequired=true`; `semanticQualityGateValidated=false`; `capacityProductionReady=false`; `schedulerThroughputReady=false`; `productionRoutingEnabled=false`. This completes only the technical benchmark. The human quality-gate decision remains pending, and no subsequent phase was run.
