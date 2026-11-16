# 10G.7a.4 — Groq Full-Path Token + Header-Driven Pacing Probe

## PURPOSE

Measure one supervised, sequential six-stage HorizAI lineage on Groq for capacity only. This is not semantic quality certification. Probe ID: `16ec351f-d2eb-43d6-849a-2a2c31acb807`; UTC period: `2026-09-25`; provider/model: `groq` / `openai/gpt-oss-20b`.

## FREE PLAN EVIDENCE

- Provenance: `USER_MANUAL_CONFIRMATION`; plan: **FREE**; billing enabled: **false**; Paid Developer plan: **false**.
- User-confirmed model limits: **30 RPM / 1000 RPD / 8000 TPM / 200000 TPD**.
- These are kept distinct from `PROVIDER_REPORTED_HEADERS`. The prior response headers reported RPD 1000 and TPM 8000, but did not report RPM or TPD.
- No service tier, paid fallback, tools, or external search are enabled by this harness.

## FIXTURE

One synthetic, copyright-safe event: Lumen Labs announces its fictional Lumen-1 inference accelerator. Two synthetic sources corroborate a 32 GB HBM specification and Q4 2026 pilot availability. Domains use reserved `.example`; there is no production event ID, production source, raw-item/event/article mutation, or publication.

## PRE-ADMISSION

- Preflight: **PASS**; reason: `NEW_EVENT_PROJECTED_SOFT_ADMISSION_PASS`.
- UTC request period: `2026-09-25`; starting provider-scoped usage: **1 reserved / 20 hard cap**, **19 remaining**.
- Six-request projection: **7** total reserved if admitted; soft threshold **17**. Admission reason: `NEW_EVENT_PROJECTED_SOFT_ADMISSION_PASS`.
- Persistent Supabase read-only usage/rate-block checks: **PASS**. The normal runtime creates only its permitted `agent_runs`/`agent_logs` accounting records.

## STAGE EXECUTION

Path: **FULL_PATH**. Completed stage calls: **6**; stop reason: `UNKNOWN`.

- verifier: SUCCESS; provider=groq; model=openai/gpt-oss-20b; version=verifier-v1; attempts=1; retries=0; provider identity persisted=true.
- translator: SUCCESS; provider=groq; model=openai/gpt-oss-20b; version=translator-v1; attempts=1; retries=0; provider identity persisted=true.
- editor: SUCCESS; provider=groq; model=openai/gpt-oss-20b; version=editor-v2; attempts=1; retries=0; provider identity persisted=true.
- classifier: SUCCESS; provider=groq; model=openai/gpt-oss-20b; version=classifier-v1; attempts=1; retries=0; provider identity persisted=true.
- ranker: SUCCESS; provider=groq; model=openai/gpt-oss-20b; version=ranker-v1; attempts=1; retries=0; provider identity persisted=true.
- critic: SUCCESS; provider=groq; model=openai/gpt-oss-20b; version=critic-v3; attempts=1; retries=0; provider identity persisted=true.

## TOKENS BY STAGE

| Stage | Version | Input | Output | Total | Estimated request tokens | Latency ms | Request bytes | Response bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| verifier | verifier-v1 | 1240 | 481 | 1721 | 3936 | 1761 | 5631 | 1777 |
| translator | translator-v1 | 1206 | 359 | 1565 | 4034 | 1315 | 5203 | 1501 |
| editor | editor-v2 | 1341 | 329 | 1670 | 4149 | 1405 | 5724 | 2076 |
| classifier | classifier-v1 | 1142 | 122 | 1264 | 3762 | 1344 | 4764 | 822 |
| ranker | ranker-v1 | 1103 | 74 | 1177 | 3493 | 934 | 4568 | 677 |
| critic | critic-v3 | 2917 | 33 | 2950 | 7786 | 1205 | 12594 | 640 |

## RATE LIMIT HEADERS

Only the allowlisted RPD/TPM headers and `retry-after` are captured; raw full headers and authorization are never persisted.

| Stage | RPD limit | RPD remaining | RPD reset | TPM limit | TPM remaining | TPM reset | retry-after | Pacing decision | Wait ms |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- | --- | ---: |
| verifier | 1000 | 999 | 1m26.4s | 8000 | 6579 | 10.657s | UNKNOWN | IMMEDIATE | 0 |
| translator | 1000 | 998 | 2m52.8s | 8000 | 5206 | 20.955s | UNKNOWN | IMMEDIATE | 0 |
| editor | 1000 | 997 | 4m19.2s | 8000 | 3754 | 31.845s | UNKNOWN | IMMEDIATE | 0 |
| classifier | 1000 | 996 | 5m45.6s | 8000 | 6377 | 12.172s | UNKNOWN | WAIT_FOR_TOKEN_RESET | 32095 |
| ranker | 1000 | 995 | 7m12s | 8000 | 5569 | 18.232s | UNKNOWN | IMMEDIATE | 0 |
| critic | 1000 | 994 | 8m38.4s | 8000 | 4602 | 25.485s | UNKNOWN | WAIT_FOR_TOKEN_RESET | 18482 |

## PACING

- Estimate method: exact production system-instruction/input/schema character lengths, existing conservative `ceil(chars / 2) + 128` input estimate, real stage `maxOutputTokens`, then a deterministic **128-token** headroom margin. This is an estimate, not a tokenizer result.
- TPM hard ceiling used for single-stage safety: **8,000**. Reset wait adds a deterministic **250 ms** margin to the provider-reported token reset; there is no random sleep and no RPD-based wait.
- Classification: **PACING_REQUIRED**; total pacing wait: **50577 ms**.

## FULL PATH

- Status: **FULL_PATH**; all six stages and six real requests: **YES**.
- Input/output/total: **8949 / 1398 / 10347** tokens.
- Wall-clock duration: **63601 ms**; provider 429 count: **0**.
- Final RPD remaining: **994**; minimum observed TPM remaining: **3754**.

## UNPACED COUNTERFACTUAL

Unpaced classification: **UNPACED_CLEARLY_OVER_TPM**. Unpaced token sum from completed stages: **10347**; approximate immediate-sequence 60-second demand: **10347**. These are `COUNTERFACTUAL_ESTIMATE` values, not provider-observed unpaced behavior.

For the actually paced path, the approximate rolling-60-second total was **8626 tokens**, calculated by assigning each stage's total usage to its request-dispatch timestamp. This is about **626 tokens above the manually confirmed 8,000 TPM**. No HTTP 429 occurred. This timestamp-bucket estimate can differ from Groq's internal window accounting and is not proof of an actual provider-limit violation; it is a caution that the header-driven waits do not certify rolling-window headroom.

Maximum observed requests in a rolling 60 seconds: **5**; theoretical immediate sequence: at most six. This does not validate concurrent-event safety.

## RPM/RPD ANALYSIS

Manual plan limits: **30 RPM / 1,000 RPD**. Provider response headers expose RPD in this probe but not RPM.

| Paths | Requests | Provider RPD 1,000 | Internal hard 20 / soft 17 |
| ---: | ---: | --- | --- |
| 10 | 60 | within provider RPD | exceeds current internal admission |
| 12 | 72 | within provider RPD | exceeds current internal admission |
| 15 | 90 | within provider RPD | exceeds current internal admission |

## TPM ANALYSIS

Manual TPM: **8,000**. Maximum approximate observed rolling-60-second token total: **8626**; minimum reported remaining TPM across responses: **3754**. The timestamp-based approximation exceeds 8,000 by 626 tokens, despite no 429; interpret it as a caution, not exact provider accounting. A single stage is blocked before dispatch if its conservative estimate plus safety margin exceeds 8,000. No N=1 finding is generalized to p75/p90 or concurrency.

## TPD 10/12/15 ANALYSIS

Manual TPD: **200,000**; planning threshold at 85%: **170,000**. If a full path with known provider usage completed, the N=1 estimates are:

| Paths | Token demand | % of 200,000 TPD | Hard TPD | Soft 85% TPD |
| ---: | ---: | ---: | --- | --- |
| 10 | 103470 | 51.73% | YES | YES |
| 12 | 124164 | 62.08% | YES | YES |
| 15 | 155205 | 77.60% | YES | YES |

These are capacity estimates based on one observed path, not production guarantees.

## INTERNAL 20-DAY CAP

Internal Groq hard cap remains **20 requests/UTC day**, soft ratio **0.85**, threshold **17**. Changed: **NO**. For full paths, 6 requests/path means the current internal soft admission binds well before provider RPD. No internal TPM/RPM/TPD or daily-token configuration was added.

## LIMITATIONS

- One synthetic sequential lineage only; no parallel requests, load test, or attempt to approach provider limits.
- A single path cannot certify concurrency, provider account/project scope, future traffic shape, or p75/p90.
- No semantic or editorial quality certification was performed; no chain-of-thought, full prompt, or model output is included here.
- Provider calls: **6**; Cloudflare: **0**; Cerebras: **0**; retries: **0**; fallback: **0**; published articles: **0**; secrets persisted: **NO**.

## PRODUCTION GATES

- technicalAllStagesValidated: **true**
- semanticQualityGateValidated: **false**
- capacityArchitectureProviderScoped: **true**
- capacityProductionReady: **false**
- schedulerThroughputReady: **false**
- productionRoutingEnabled: **false**

## NEXT STEP

After review, choose between 10G.7a.5 — GROQ CAPACITY POLICY + PACING DESIGN and 10G.7b — MINIMAL CLOUDFLARE QUALITY BENCHMARK. Neither was started.
