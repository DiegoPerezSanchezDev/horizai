# 12F.12A — Same-attempt Editor resume

**Final classification: DEFERRED_PROVIDER_CAPACITY. READY FOR HUMAN ACTION: NO.**

One invocation of PipelineOrchestrator.resumeCapacityDeferred through createProductionPipeline resumed attempt `4658d5c0-857c-4ed5-b97f-afb133b2bf22` from Editor. Event lineage `event-5c7d0ef5ea6f72bec96704aded750851` and pipeline lineage `f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d` were preserved. No daily scheduler run, daily trigger or new attempt was created.

## Preflight and local gates

M35 claim/resume, resumeGeneration, fresh-process Editor resume, durable checkpoints, M36 windows, unified admission, KNOWN_ZERO and temporary TPM defer, accounting continuity, Editor grounding, Classifier, Ranker, Critic, M34 proof and M32 read-path fixtures passed. The cumulative-budget check proved two inherited reservations plus at most sixteen additional requests. Lint, TypeScript, build, diff check and secret audit passed. The permitted NEXT_PUBLIC_SITE_URL warning was present.

Read-only preflight matched head 20261015120000, 19 attempts, active/deferred/stuck 0/1/0, reviews/WAITING 0/0, public 2 and Astra archived. Public fingerprints matched. The Verifier/Translator checkpoints and stored raw-source lineage were validated; Editor had neither a checkpoint nor a previous dispatch. All pre-existing attempt, agent, article and scheduler hashes matched the 12F.12 post-run snapshot.

## Current capacity and claim

At claim time complete durable local accounting was KNOWN_ZERO: zero tokens in the current rolling minute. The historical 3,783 tokens had expired from that window. Editor required 4,770 estimated tokens plus the existing margin 128, or 4,898 <= 8,000. The stale external header did not block admission and no external remaining amount was invented.

A single M35 claimant, owner `c7a2b421-d1b8-4e1c-8666-526974a43525`, claimed the same attempt. The run-local budget was seeded at 2/18; it finished at 5/18. A network guard excluded daily scheduler writes, new-attempt claims, earlier-stage requests, Publisher, human-review actions, other providers and duplicate stage dispatches. No forbidden call was attempted.

## Stage results

Verifier and Translator were reused without dispatch. Editor passed its grounding guard and wrote a valid checkpoint. Classifier and deterministic geography passed, followed by Ranker and its valid checkpoint. Three model calls occurred, in order: Editor, Classifier, Ranker.

Critic was denied before reservation/dispatch with GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED. Its estimate was 7,018 tokens plus margin 128; together with the 4,582 tokens used by this resume, the requested local window would be 11,728 > 8,000. No provider-side 429 occurred. Critic produced no decision and no checkpoint; M34 same-attempt PASS proof is therefore not applicable and no review was created.

## Durable re-defer

M35 persisted the same attempt at Critic with generation 1, retry_class NONE and counts_toward_retry_limit false. The remote snapshot equals the new local Critic-g1 snapshot. All five checkpoint hashes validate; the earlier Verifier and Translator hashes remain unchanged. The Critic checkpoint is absent. No second resume was invoked.

## Accounting

| Scope | Reservations | Dispatches | Input | Output | Total tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before resume | 2 | 2 | 2,879 | 904 | 3,783 |
| This resume | 3 | 3 | 3,869 | 713 | 4,582 |
| Cumulative attempt | 5 | 5 | 6,748 | 1,617 | 8,365 |

All five durable reservations are settled. Unknown reservations, releases, retries, fallback, Cloudflare calls and Cerebras calls are zero. One Critic reservation was denied; it created no accounting hold. The cumulative 8,365 tokens span separate minute windows.

## Post-resume reconciliation

Read-only reconciliation passed: attempts 19, active/deferred/stuck 0/1/0, reviews/WAITING 0/0, public 2, Astra archived and zero unknown reservations. M32 status/list/inspect passed and found no review. All historical article, scheduler, agent-log and agent-run rows are unchanged; only the authorized target attempt changed. The finalized 12F.12 scheduler row remains byte-for-byte comparable by its recorded canonical row hash, with no new scheduler row.

Public fingerprints remain:

- 6203559f-413a-4f06-9346-1720bbeb0e7a: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`.
- 7415c685-04ed-4956-a77a-4bc372c9b060: `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`.

Publisher was not run. No approve, hold, reject, publication, deploy or migration occurred. The attempt is safely deferred at Critic; no human action is available. This phase stops here.

Structured evidence: `artifacts/supervised-cycle-12f12a-resume.json`. Secrets and source article bodies are excluded.
