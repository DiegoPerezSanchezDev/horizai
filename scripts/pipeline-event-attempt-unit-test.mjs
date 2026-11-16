import assert from "node:assert/strict";
import { InMemoryPipelineEventAttemptRegistry, attemptOutcomeFromPipelineResult, evaluateNormalEligibility, nextUtcPeriodStart } from "../lib/agents/pipeline/index.ts";

const now = new Date("2026-09-23T12:00:00.000Z");
const base = (overrides = {}) => ({ id: crypto.randomUUID(), eventKey: "event-a", pipelineRunId: crypto.randomUUID(), attemptNumber: 1, startedAt: "2026-09-23T01:00:00.000Z", completedAt: "2026-09-23T01:10:00.000Z", finalState: "TECHNICAL_FAILURE", stopStage: "editor", stopReason: "EDITOR_OUTPUT_REJECTED", retryClass: "TECHNICAL_FAILURE", countsTowardRetryLimit: true, nextEligibleAt: "2026-09-24T00:00:00.000Z", createdAt: "2026-09-23T01:00:00.000Z", ...overrides });

assert.equal(evaluateNormalEligibility([], now).eligible, true); // A never attempted
assert.equal(evaluateNormalEligibility([base({ completedAt: null, finalState: null, startedAt: "2026-09-23T11:30:00.000Z" })], now).reason, "ACTIVE"); // active claim
assert.equal(evaluateNormalEligibility([base()], now).reason, "COOLDOWN"); // B technical attempt 1 same period
assert.equal(evaluateNormalEligibility([base({ nextEligibleAt: "2026-09-23T00:00:00.000Z" })], now).eligible, true); // C next UTC period
assert.equal(evaluateNormalEligibility([base({ nextEligibleAt: "2026-09-22T00:00:00.000Z" }), base({ attemptNumber: 2, pipelineRunId: crypto.randomUUID(), startedAt: "2026-09-22T01:00:00Z" })], now).reason, "QUARANTINED"); // D attempt 2
assert.equal(evaluateNormalEligibility([base({ finalState: "PROVIDER_RATE_LIMIT", retryClass: "PROVIDER_RATE_LIMIT", countsTowardRetryLimit: false, nextEligibleAt: null })], now).reason, "RATE_LIMIT_RETRY_ELIGIBLE"); // E
for (const state of ["REVISION_REQUIRED", "REJECTED", "VERIFICATION_INSUFFICIENT", "READY_FOR_PUBLICATION", "WAITING_FOR_HUMAN_REVIEW"]) assert.equal(evaluateNormalEligibility([base({ finalState: state, retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null })], now).reason, "PERMANENT_OUTCOME"); // F-J
assert.equal(evaluateNormalEligibility([base({ completedAt: null, finalState: null, startedAt: "2026-09-23T00:00:00Z" })], now).reason, "STALE_ACTIVE"); // J
assert.deepEqual(attemptOutcomeFromPipelineResult({ finalState: "BLOCKED_REJECTED", stopStage: "verifier", stopReason: "VERIFIER_INPUT_TOO_LARGE" }, now), {
  finalState: "REJECTED", stopStage: "verifier", stopReason: "VERIFIER_INPUT_TOO_LARGE", retryClass: "REJECTED", countsTowardRetryLimit: false, nextEligibleAt: null,
});
const staleAttemptRecovery = base({ finalState: "ABORTED", stopStage: "attempt_registry", stopReason: "STALE_ATTEMPT_RECOVERED", retryClass: "TECHNICAL_FAILURE", countsTowardRetryLimit: false, nextEligibleAt: now.toISOString() });
assert.deepEqual(evaluateNormalEligibility([staleAttemptRecovery], now), { eligible: true, reason: "STALE_ATTEMPT_RECOVERY" });
const historicalAbort = base({ eventKey: "synthetic-historical-abort", finalState: "ABORTED", stopStage: "editor", stopReason: "CAPACITY_RESUME_EVIDENCE_UNAVAILABLE", retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null });
assert.equal(evaluateNormalEligibility([historicalAbort], now).reason, "PERMANENT_OUTCOME");
assert.equal(evaluateNormalEligibility([base({ finalState: "ABORTED", stopReason: "STALE_ATTEMPT_RECOVERED", retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: now.toISOString() })], now).reason, "PERMANENT_OUTCOME", "abort retry requires the complete stale-recovery contract");
assert.equal(evaluateNormalEligibility([base({ ...staleAttemptRecovery, nextEligibleAt: "2026-09-24T00:00:00.000Z" })], now).reason, "COOLDOWN");
assert.equal(nextUtcPeriodStart(now), "2026-09-24T00:00:00.000Z");

const registry = new InMemoryPipelineEventAttemptRegistry();
const concurrent = await Promise.all([
  registry.claim({ eventKey: "event-concurrent", pipelineRunId: "run-1", startedAt: now.toISOString(), now: now.toISOString() }),
  registry.claim({ eventKey: "event-concurrent", pipelineRunId: "run-2", startedAt: now.toISOString(), now: now.toISOString() }),
]);
assert.equal(concurrent.filter((result) => result.status === "ACQUIRED").length, 1);
assert.equal(registry.snapshot().filter((attempt) => attempt.eventKey === "event-concurrent").length, 1, "only one concurrent attempt is created for an event");
const other = await registry.claim({ eventKey: "event-other", pipelineRunId: "run-3", startedAt: now.toISOString(), now: now.toISOString() });
assert.equal(other.status, "ACQUIRED");

const activeFixture = base({ eventKey: "event-active", completedAt: null, finalState: null, startedAt: now.toISOString() });
const activeRegistry = new InMemoryPipelineEventAttemptRegistry([activeFixture]);
assert.equal((await activeRegistry.getEligibility(["event-active"], now)).get("event-active").reason, "ACTIVE");
assert.equal((await activeRegistry.claim({ eventKey: "event-active", pipelineRunId: "run-active-duplicate", startedAt: now.toISOString(), now: now.toISOString() })).status, "ALREADY_ACTIVE");
assert.equal(activeRegistry.snapshot().length, 1);

const deferredFixture = base({ eventKey: "event-deferred", completedAt: null, finalState: null, stopStage: "editor", stopReason: "PROVIDER_CAPACITY_EXHAUSTED", retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null });
const deferredRegistry = new InMemoryPipelineEventAttemptRegistry([deferredFixture]);
assert.equal((await deferredRegistry.getEligibility(["event-deferred"], now)).get("event-deferred").reason, "RESUME_REQUIRED");
assert.equal((await deferredRegistry.claim({ eventKey: "event-deferred", pipelineRunId: "run-deferred-duplicate", startedAt: now.toISOString(), now: now.toISOString() })).status, "INELIGIBLE");
assert.equal(deferredRegistry.snapshot().length, 1);

const abortRegistry = new InMemoryPipelineEventAttemptRegistry([historicalAbort]);
assert.equal((await abortRegistry.getEligibility(["synthetic-historical-abort"], now)).get("synthetic-historical-abort").reason, "PERMANENT_OUTCOME");
assert.equal((await abortRegistry.claim({ eventKey: "synthetic-historical-abort", pipelineRunId: "run-no-abort-replay", startedAt: now.toISOString(), now: now.toISOString() })).status, "INELIGIBLE");
assert.equal(abortRegistry.snapshot().length, 1);
assert.equal((await abortRegistry.getEligibility(["event-unrelated-new"], now)).get("event-unrelated-new").eligible, true);

const ordered = ["event-failed", "event-eligible", "event-never"].map((eventKey) => ({ eventKey }));
const eligible = await registry.getEligibility(ordered.map((item) => item.eventKey), now);
const selected = ordered.filter((item) => eligible.get(item.eventKey)?.eligible).slice(0, 1);
assert.equal(selected[0].eventKey, "event-failed");
const failed = await registry.claim({ eventKey: "event-failed", pipelineRunId: "run-failed", startedAt: "2026-09-23T01:00:00Z", now: "2026-09-23T01:00:00Z" });
assert.equal(failed.status, "ACQUIRED");
if (failed.status === "ACQUIRED") await registry.finalize({ attemptId: failed.attempt.id, pipelineRunId: "run-failed", completedAt: "2026-09-23T01:01:00Z", finalState: "TECHNICAL_FAILURE", stopStage: "editor", stopReason: "EDITOR_OUTPUT_REJECTED", retryClass: "TECHNICAL_FAILURE", countsTowardRetryLimit: true, nextEligibleAt: "2026-09-24T00:00:00Z" });
const afterFilter = await registry.getEligibility(ordered.map((item) => item.eventKey), now);
assert.equal(ordered.filter((item) => afterFilter.get(item.eventKey)?.eligible)[0].eventKey, "event-eligible");
console.log(JSON.stringify({ status: "SUCCESS", abortedEventBlocked: true, staleRecoveryRetryPreserved: true, activeAndDeferredAttemptsNotDuplicated: true, concurrentClaims: concurrent.map((result) => result.status), unrelatedEventEligible: true, groqCalls: 0 }));
