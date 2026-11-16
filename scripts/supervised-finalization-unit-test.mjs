import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  persistedSchedulerDecisionValues,
  persistedSchedulerTerminal,
  runAndFinalizeSupervisedExecution,
} from "../lib/agents/pipeline/scheduler/scheduler-terminal-contract.ts";

const pipelineRunId = "55555555-5555-4555-8555-555555555555";
const startedAt = new Date("2026-10-11T10:00:00.000Z");
const schedulerMigration = readFileSync(new URL("../supabase/migrations/20260921000012_scheduler_execution_telemetry.sql", import.meta.url), "utf8");
const schedulerDecisionConstraint = schedulerMigration.match(/scheduler_runs_decision_value_check[\s\S]*?in\s*\(([^)]*)\)/i)?.[1];
assert.ok(schedulerDecisionConstraint, "the existing scheduler decision check constraint is present");
const migrationDecisionValues = [...schedulerDecisionConstraint.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
assert.deepEqual([...persistedSchedulerDecisionValues].sort(), migrationDecisionValues, "the application mapping matches the immutable migration decision enum");
const resultBase = (overrides = {}) => ({
  runId: pipelineRunId,
  startedAt: startedAt.toISOString(),
  completedAt: "2026-10-11T10:01:00.000Z",
  finalState: "SUCCESS",
  candidatesDiscovered: 1,
  extractedItems: 1,
  discoverySummary: undefined,
  extractionSummary: undefined,
  clusteredEvents: 1,
  eventsAttempted: 1,
  eventsPublished: 0,
  eventsDryRunReady: 0,
  eventsAwaitingHumanReview: 0,
  eventsSkipped: 0,
  eventsFailed: 0,
  eventsBlocked: 0,
  providerRequestsUsed: 3,
  stageStats: {},
  eventResults: [],
  quotaBefore: 10,
  quotaAfter: 7,
  ...overrides,
});

function noEligibleResult() {
  return resultBase({
    finalState: "SUCCESS",
    extractedItems: 0,
    eventsAttempted: 0,
    providerRequestsUsed: 0,
    eventResults: [],
    extractionSummary: {
      candidatesSelected: 1,
      extractedItems: 0,
      successfulResults: 0,
      blockedResults: 1,
      failedResults: 0,
      errorCodeCounts: { blocked: 1 },
      persisted: 0,
      persistSkipped: 0,
      persistErrors: 0,
      rawItemPersistenceErrors: 0,
      extractionAttempts: 1,
      extractionSkipped: 0,
      extractionFailed: 1,
      extractionSucceeded: 0,
      unexpectedResults: 0,
      candidateOutcomes: [{
        candidateId: "synthetic-candidate",
        extractionAttempted: true,
        terminalOutcome: "FETCH_BLOCKED",
        parserOutcome: "NOT_REACHED",
        discoveryRawItemMapping: "NOT_REQUESTED",
        extractionRawItemMapping: "NOT_REQUESTED",
      }],
    },
  });
}

async function runFinalizer(result, { throws = null, finalizerReturns = true } = {}) {
  const calls = [];
  let pipelineStarted = false;
  const execution = runAndFinalizeSupervisedExecution({
    triggerId: "supervised-candidates:2026-10-11",
    ownerRunId: "44444444-4444-4444-8444-444444444444",
    startedAt,
    pipelineRunId: () => pipelineStarted ? pipelineRunId : null,
    quotaUsed: () => 0,
    quotaRemaining: () => 0,
    now: () => new Date("2026-10-11T10:02:00.000Z"),
    execute: async () => {
      pipelineStarted = true;
      if (throws) throw throws;
      return result;
    },
    finishExecution: async (input) => {
      calls.push(input);
      return finalizerReturns;
    },
  });
  return { execution, calls };
}

for (const semantic of [
  "COMPLETED",
  "NO_ELIGIBLE_EXTRACTED_ITEMS",
  "WAITING_FOR_HUMAN_REVIEW",
  "CANDIDATE_NOT_VERIFIED",
  "CANDIDATE_REJECTED",
  "CANDIDATE_SAFELY_REJECTED",
  "CRITIC_BLOCKED",
  "STOPPED_CAPACITY",
  "DEFERRED_PROVIDER_CAPACITY",
  "BLOCKED_BUDGET",
  "TECHNICAL_FAILURE",
  ...persistedSchedulerDecisionValues,
]) {
  const stored = persistedSchedulerTerminal({ schedulerDecision: semantic, stopReason: null });
  assert.ok(persistedSchedulerDecisionValues.includes(stored.schedulerDecision));
}
assert.deepEqual(persistedSchedulerTerminal({ schedulerDecision: "NO_ELIGIBLE_EXTRACTED_ITEMS", stopReason: null }), {
  schedulerDecision: "COMPLETED", stopReason: "NO_ELIGIBLE_EXTRACTED_ITEMS",
});
assert.deepEqual(persistedSchedulerTerminal({ schedulerDecision: "WAITING_FOR_HUMAN_REVIEW", stopReason: null }), {
  schedulerDecision: "COMPLETED", stopReason: "WAITING_FOR_HUMAN_REVIEW",
});
assert.deepEqual(persistedSchedulerTerminal({ schedulerDecision: "CANDIDATE_REJECTED", stopReason: "EDITOR_GROUNDING_REJECTED" }), {
  schedulerDecision: "BLOCKED_REJECTED", stopReason: "EDITOR_GROUNDING_REJECTED",
});
assert.deepEqual(persistedSchedulerTerminal({ schedulerDecision: "STOPPED_CAPACITY", stopReason: null }), {
  schedulerDecision: "BLOCKED_PROVIDER_RATE_LIMIT", stopReason: "PROVIDER_CAPACITY_EXHAUSTED",
});
assert.deepEqual(persistedSchedulerTerminal({ schedulerDecision: "TECHNICAL_FAILURE", stopReason: null }), {
  schedulerDecision: "FAILED", stopReason: "SUPERVISED_PIPELINE_FAILED",
});

const safeRejection = resultBase({
  finalState: "SUCCESS_WITH_FAILURES",
  eventsBlocked: 1,
  eventResults: [{ attemptId: "66666666-6666-4666-8666-666666666666", eventKey: "synthetic-event", finalState: "BLOCKED_REJECTED", stopStage: "editor", stopReason: "EDITOR_GROUNDING_REJECTED", requestsUsed: 3 }],
});
const safe = await runFinalizer(safeRejection);
const safeResult = await safe.execution;
assert.equal(safe.calls.length, 1, "safe rejection is finalized exactly once");
assert.equal(safe.calls[0].pipelineRunId, pipelineRunId);
assert.equal(safeResult.outcome.schedulerDecision, "COMPLETED");
assert.equal(safeResult.outcome.stopReason, "ALL_CANDIDATES_SAFELY_REJECTED");
assert.deepEqual(persistedSchedulerTerminal(safe.calls[0]), { schedulerDecision: "COMPLETED", stopReason: "ALL_CANDIDATES_SAFELY_REJECTED" });
assert.equal(safeResult.result.eventsPublished, 0);

const revisionTerminal = resultBase({
  finalState: "SUCCESS_WITH_FAILURES",
  eventsBlocked: 1,
  eventResults: [{ attemptId: "66666666-6666-4666-8666-666666666667", eventKey: "synthetic-revision-event", finalState: "BLOCKED_REVISION_REQUIRED", stopStage: "critic", stopReason: "BLOCKED_REVISION_REQUIRED", criticDecision: "revise_editorial", requestsUsed: 6 }],
  providerRequestsUsed: 6,
});
const revisionFinalized = await runFinalizer(revisionTerminal);
const revisionExecution = await revisionFinalized.execution;
assert.equal(revisionFinalized.calls.length, 1, "a semantic Critic revision still finalizes the scheduler once");
assert.equal(revisionFinalized.calls[0].pipelineRunId, pipelineRunId);
assert.equal(revisionExecution.outcome.runStatus, "succeeded");
assert.equal(revisionExecution.outcome.schedulerDecision, "COMPLETED");
assert.equal(revisionExecution.outcome.stopReason, "ALL_CANDIDATES_SAFELY_REJECTED");
assert.notEqual(revisionExecution.outcome.stopReason, "SUPERVISED_PIPELINE_FAILED");
assert.equal(revisionFinalized.calls[0].eventFinalStates[0].terminalClass, "SAFE_REJECTION");
assert.equal(revisionFinalized.calls[0].eventFinalStates[0].finalState, "BLOCKED_REVISION_REQUIRED");
assert.equal(revisionFinalized.calls[0].eventFinalStates[0].stopReason, "BLOCKED_REVISION_REQUIRED", "the per-attempt scheduler payload preserves the specific Critic terminal reason");
assert.deepEqual(persistedSchedulerTerminal(revisionFinalized.calls[0]), { schedulerDecision: "COMPLETED", stopReason: "ALL_CANDIDATES_SAFELY_REJECTED" });

const technicalError = new Error("synthetic pipeline failure");
const technical = await runFinalizer(null, { throws: technicalError });
await assert.rejects(technical.execution, (error) => error === technicalError);
assert.equal(technical.calls.length, 1, "technical exception is finalized exactly once");
assert.equal(technical.calls[0].runStatus, "failed");
assert.equal(technical.calls[0].schedulerDecision, "TECHNICAL_FAILURE");
assert.equal(technical.calls[0].pipelineRunId, pipelineRunId, "pipeline lineage survives a thrown stage error");
assert.deepEqual(persistedSchedulerTerminal(technical.calls[0]), { schedulerDecision: "FAILED", stopReason: "SUPERVISED_EXECUTION_FAILED" });
assert.equal(technical.calls[0].eventAttempts, 0, "the legacy integer column retains its schema-compatible lower bound");
assert.equal(technical.calls[0].requestsUsed, 0, "the legacy integer column retains its schema-compatible lower bound");
assert.deepEqual(technical.calls[0].eventFinalStates[0].unknownCounters, ["attemptsStarted", "providerRequests", "inputTokens", "outputTokens", "totalTokens"], "unknown counters are explicit in JSON instead of being silently represented as known zeros");
assert.equal(technical.calls[0].eventFinalStates[0].attemptsStarted, null);
assert.equal(technical.calls[0].eventFinalStates[0].providerRequests, null);

const typedThrown = await runFinalizer(null, { throws: new Error("EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023") });
await assert.rejects(typedThrown.execution, /EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023/);
assert.equal(typedThrown.calls[0].stopReason, "EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023", "typed persistence cause survives an outer exception");
assert.deepEqual(typedThrown.calls[0].eventFinalStates[0].unknownCounters, ["attemptsStarted", "providerRequests", "inputTokens", "outputTokens", "totalTokens"]);

const empty = await runFinalizer(noEligibleResult());
const emptyResult = await empty.execution;
assert.equal(empty.calls.length, 1);
assert.equal(emptyResult.outcome.schedulerDecision, "NO_ELIGIBLE_EXTRACTED_ITEMS");
assert.deepEqual(persistedSchedulerTerminal(empty.calls[0]), { schedulerDecision: "COMPLETED", stopReason: "NO_ELIGIBLE_EXTRACTED_ITEMS" });

const capacityResult = resultBase({
  finalState: "DEFERRED_PROVIDER_CAPACITY",
  eventResults: [{ eventKey: "capacity-event", finalState: "DEFERRED_PROVIDER_CAPACITY", stopStage: "editor", stopReason: "PROVIDER_CAPACITY_EXHAUSTED", requestsUsed: 2 }],
});
const capacity = await runFinalizer(capacityResult);
const capacityExecution = await capacity.execution;
assert.equal(capacity.calls.length, 1);
assert.equal(capacityExecution.outcome.schedulerDecision, "STOPPED_CAPACITY");
assert.equal(capacity.calls[0].pipelineRunId, pipelineRunId);
assert.deepEqual(persistedSchedulerTerminal(capacity.calls[0]), { schedulerDecision: "BLOCKED_PROVIDER_RATE_LIMIT", stopReason: "PROVIDER_CAPACITY_EXHAUSTED" });

const reviewResult = resultBase({
  eventsAwaitingHumanReview: 1,
  eventResults: [{ attemptId: "77777777-7777-4777-8777-777777777777", eventKey: "review-event", finalState: "WAITING_FOR_HUMAN_REVIEW", stopStage: "human_review", stopReason: "HUMAN_REVIEW_PENDING", requestsUsed: 6 }],
  providerRequestsUsed: 6,
});
const review = await runFinalizer(reviewResult);
const reviewExecution = await review.execution;
assert.equal(review.calls.length, 1);
assert.equal(reviewExecution.outcome.schedulerDecision, "WAITING_FOR_HUMAN_REVIEW");
assert.equal(review.calls[0].pipelineRunId, pipelineRunId);
assert.equal(review.calls[0].eventFinalStates[0].finalState, "WAITING_FOR_HUMAN_REVIEW");
assert.equal(review.calls[0].eventAttempts, 1);
assert.equal(review.calls[0].requestsUsed, 6);
assert.equal(reviewResult.eventsPublished, 0);
assert.deepEqual(persistedSchedulerTerminal(review.calls[0]), { schedulerDecision: "COMPLETED", stopReason: "WAITING_FOR_HUMAN_REVIEW" });

const rejectedFinalizer = await runFinalizer(safeRejection, { finalizerReturns: false });
await assert.rejects(rejectedFinalizer.execution, /SUPERVISED_DAILY_RUN_FINALIZE_NOT_OWNED/);
assert.equal(rejectedFinalizer.calls.length, 1, "failed terminal update is not retried by a generic fallback");

console.log("supervised scheduler finalization fixtures passed: safe rejection, technical exception, no eligible items, provider capacity, human review, lineage, persisted decision contract, exactly-once finalizer");
