# 12F.5A — Editor grounding and scheduler finalization diagnosis

Captured 2026-10-11 UTC. This phase performed read-only PostgREST checks and offline tests. It did not run the pipeline or a scheduler trigger, write remote data, or call a provider.

## Editor reconstruction

The durable Verifier checkpoint reports a single-source pass (confidence 80). It states that Apple disclosed an agreement to hire some Huxe AI employees and receive a non-exclusive license to Huxe intellectual property. The Translator checkpoint contains the corresponding Spanish title, one translated fact, and 229 characters of translated source material. None of the event title, verified fact, translated fact, or translated source material contains a numeric/date claim.

Editor returned parseable JSON with all six expected fields. Durable failure telemetry records one rejected token: `2021`, classified as a year, in `bodyEs`. Its diagnostic context is only the token itself. There were zero allowed numeric claims, zero matched provenance entries, and no equivalent date in the material supplied to Editor. The raw model response and parsed editorial draft were not durably retained; only response sizes, field names, and deterministic diagnostics remain. The original upstream article body was not used to infer what Editor could cite.

**Classification: `TRUE_UNSUPPORTED_FACT`.** The year was unsupported by Editor's actual grounding input. This is not a normalization false positive. The guard was correct; numeric/date normalization was not changed or loosened. Existing tests continue to cover safe equivalent number/date forms and reject unsupported additions.

## Error taxonomy and historical attempt

Before this fix, the shared deterministic guard threw `invalid_structured_output` with `LOCAL_SCHEMA_VALIDATION_ERROR` for both malformed structure and unsupported factual numbers. The pipeline then treated this event as `FAILED`, and the attempt policy persisted it as a retry-counting technical failure.

The historical attempt is terminal (`completed_at` is set), attempt 1, purpose `NORMAL`, validation namespace null. It has `final_state=TECHNICAL_FAILURE`, `stop_stage=editor`, `stop_reason=LOCAL_SCHEMA_VALIDATION_ERROR`, `retry_class=TECHNICAL_FAILURE`, and `counts_toward_retry_limit=true`. Provider dispatch was true. Verifier and Translator completed; Editor dispatched one request and the later stages did not run. Its lineage remains bound to event `event-b0fdb4f14f9734ca25090788b79b109c` and pipeline run `15b3324e-987b-4c7f-b99f-4640bce5600d`.

That historical state is **semantically inaccurate** for a deterministic grounding rejection. The historical attempt was not rewritten. New behavior raises `EDITOR_GROUNDING_REJECTED` with telemetry kind `DETERMINISTIC_GROUNDING_REJECTION`; it is non-retryable, stops before downstream stages, returns `BLOCKED_REJECTED`, and finalizes the attempt as `REJECTED` with `counts_toward_retry_limit=false`. Malformed structured output remains a technical failure.

## Scheduler finalization root cause

Migration `20260921000012_scheduler_execution_telemetry.sql` restricts `scheduler_runs.scheduler_decision` to its fixed enum. The supervised outcome mapper emitted `TECHNICAL_FAILURE`, which is outside that enum. The runner passed the known pipeline run ID to `finish_scheduler_run_execution`, but the database check constraint rejected that update. The repository discarded the PostgREST error details and surfaced only `Scheduler execution finalization failed`.

Because the detailed finalizer threw, the runner's `finally` block invoked the older `finish_scheduler_run` path with `SUPERVISED_RUN_ABORTED`. That second update wrote a generic failed/released row without `pipeline_run_id` or `scheduler_decision`, masking the original outcome. The pipeline run ID was returned and passed to the first finalizer; it was not missing from the result or lost in exception propagation. The observed row is `a04d4908-aaf2-4334-a69c-6ad464eae227`, trigger `supervised-candidates:2026-10-11`, released/failed, `stop_reason=SUPERVISED_RUN_ABORTED`, null `pipeline_run_id`, 0 event attempts, and 0 requests. Its fields still match the 12F.5 baseline. No race is indicated. The original database error code was not retained, so this report identifies the exact violated constraint but does not invent an HTTP/SQLSTATE value.

## Forward terminal contract

The repository now maps pipeline-level semantic outcomes to the enum already allowed by the migration and preserves the detailed outcome in `stop_reason`:

| Pipeline outcome | Persisted scheduler decision | Stop reason |
| --- | --- | --- |
| `COMPLETED` | `COMPLETED` | unchanged or null |
| `NO_ELIGIBLE_EXTRACTED_ITEMS` | `COMPLETED` | `NO_ELIGIBLE_EXTRACTED_ITEMS` |
| `WAITING_FOR_HUMAN_REVIEW` | `COMPLETED` | `WAITING_FOR_HUMAN_REVIEW` |
| `CANDIDATE_REJECTED` / `CRITIC_BLOCKED` | `BLOCKED_REJECTED` | original typed reason |
| `STOPPED_CAPACITY` | `BLOCKED_PROVIDER_RATE_LIMIT` | `PROVIDER_CAPACITY_EXHAUSTED` |
| `BLOCKED_BUDGET` | `BLOCKED_INSUFFICIENT_DAILY_BUDGET` | `BLOCKED_INSUFFICIENT_DAILY_BUDGET` |
| `TECHNICAL_FAILURE` | `FAILED` | original typed reason |

The supervised runner allocates the pipeline run ID before pipeline construction and retains it when `orchestrator.run()` is entered. One finalization helper handles either a returned terminal result or a thrown pipeline error and invokes `finishExecution` once. The legacy generic `finish` fallback was removed from that runner; lease release remains in `finally`. The scheduler execution bridge also avoids a second generic finish after a terminal update was attempted. A failed terminal RPC is surfaced instead of being overwritten by a second mutation.

No migration was required. The trigger name, daily guard, retry policy outside the grounding rejection, and historical scheduler/attempt rows are unchanged.

## Read-only remote baseline

The post-test checks used GET/HEAD PostgREST reads plus the existing read-only Migration 32 status/list RPCs (HTTP 200). The request guard rejected any non-read request except those two read-only RPC paths.

- Public articles: 2. Both `publicArticleFingerprintV1` hashes exactly match the stored comparable baseline: article `6203559f-413a-4f06-9346-1720bbeb0e7a` → `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`; article `7415c685-04ed-4956-a77a-4bc372c9b060` → `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`.
- Fingerprint method: SHA-256 over UTF-8 compact `JSON.stringify` of `{slug, headline_es, summary_es, why_it_matters_es, body_es, metadata}` after recursively sorting object keys lexicographically; array order is preserved. Articles are ordered by ID for comparison. IDs, publication state, timestamps, and other read-time fields are excluded.
- Astra remains archived. Real attempts remain 12; active/deferred/stuck remain 0/0/0. Human reviews and `WAITING_FOR_HUMAN_REVIEW` remain 0/0. Unknown provider reservations remain 0. Migration 32 status/list passed; active/stuck work is 0/0.
- The 12F.5 scheduler row is unchanged. Provider accounting for 2026-10-11 still shows the historical Groq total of 3 dispatched requests and 4,987 tokens; Cloudflare and Cerebras remain at 0. This diagnostic phase added no provider usage.

## Files changed in this phase

- Runtime/editor/pipeline: `lib/agents/runtime/agent-errors.ts`, `lib/agents/runtime/runtime-types.ts`, `lib/agents/runtime/telemetry.ts`, `lib/agents/editor/editor-output-guard.ts`, `lib/agents/pipeline/pipeline-orchestrator.ts`, `lib/agents/pipeline/event-attempt-policy.ts`, `lib/agents/pipeline/supervised-run-outcome.ts`.
- Scheduler/runner: `lib/agents/pipeline/scheduler/scheduler-terminal-contract.ts`, `lib/agents/pipeline/scheduler/scheduler-repository.ts`, `lib/agents/pipeline/scheduler/scheduler-execution.ts`, `scripts/supervised-pipeline-run.ts`, `types/database.ts`.
- Regressions and command: `scripts/editor-unit-test.mjs`, `scripts/editor-numeric-provenance-unit-test.mjs`, `scripts/pipeline-unit-test.mjs`, `scripts/pipeline-scheduler-execution-unit-test.mjs`, `scripts/supervised-finalization-unit-test.mjs`, and the `pipeline:supervised:finalization:unit` package script.

## Verification

The Editor numeric provenance, Editor/Translator contract, pipeline orchestrator, attempt selection, scheduler, human-review, extraction-observability, Migration 31/32 fixture, and Migration 33 capacity/resume suites passed offline. The new finalization fixtures cover safe rejection, technical exception, no eligible items, provider capacity, human review, lineage, migration enum compatibility, and exactly-once finalization. The executed offline commands included `editor:unit`, `editor:numeric:unit`, `editor:checkpoint:unit`, `translator:unit`, `translator:checkpoint:unit`, `runtime:telemetry:unit`, `pipeline:unit`, `pipeline:attempts:unit`, `pipeline:scheduler:unit`, `pipeline:scheduler:wiring:unit`, `pipeline:scheduler:execution:unit`, `pipeline:supervised:cli:unit`, `pipeline:supervised:finalization:unit`, `pipeline:capacity-resume:unit`, `pipeline:editor-capacity-resume:unit`, `pipeline:capacity-lifecycle:migration33:unit`, `pipeline:human-review:unit`, `supervised-human-review:migration31:unit`, `supervised-human-review:read-path:migration32:unit`, and the 12F.4 extraction-observability fixture.

Lint, TypeScript, production build, `git diff --check`, and the safe secret audit passed. The safe secret audit scanned 727 files, found 0 finding files, and confirmed `.env.local` is ignored.

Provider calls: **0**. Real pipeline/scheduler executions: **0**. Remote writes: **0**. Migration applied: **no**.

## Readiness

**READY FOR NEXT UTC RUN: YES** for the corrected local code path. The unsupported fact remains blocked, safe rejections no longer count as technical retries, the scheduler enum mapping matches the immutable database constraint, and finalization lineage is covered offline. This phase stopped without running another pipeline.
