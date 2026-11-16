import assert from "node:assert/strict";
import { createOfflineStages, offlineClusterResult, offlineDiscoveryResult, offlineExtractionResult } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, createStaticPipelineQuota, evaluateNormalEligibility, supervisedSchedulerOutcome } from "../lib/agents/pipeline/index.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createLoggerPipelinePersistence } from "../lib/agents/pipeline/pipeline-observability.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { AgentError, setAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { buildAgentTelemetry } from "../lib/agents/runtime/telemetry.ts";
import { canonicalEditorInput, canonicalEditorialDraft } from "../lib/agents/editor/editor-fixtures.ts";
import { validateEditorialDraftOutput } from "../lib/agents/editor/editor-output-guard.ts";

const now = () => new Date("2026-09-16T12:00:00.000Z");
const run = async (scenario = {}, options = {}) => {
  const fixture = createOfflineStages(scenario);
  const logger = new InMemoryAgentLogger();
  const result = await new PipelineOrchestrator({
    stages: fixture.stages,
    quota: options.quota ?? createStaticPipelineQuota(6),
    persistence: createLoggerPipelinePersistence(logger),
    now,
    runId: options.runId ?? "33333333-3333-4333-8333-333333333333",
    config: { dryRun: true, publish: false, hours: 24, limit: options.limit ?? 1 },
  }).run();
  return { fixture, logger, result };
};

const happy = await run();
assert.equal(happy.result.finalState, "SUCCESS");
assert.equal(happy.result.eventResults[0].finalState, "READY_FOR_PUBLICATION_DRY_RUN");
assert.deepEqual(happy.fixture.calls, ["discovery", "extraction", "clustering", "verifier", "translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"]);
assert.equal(happy.result.eventResults[0].requestsUsed, 6);
assert.equal(happy.result.providerRequestsUsed, 6);
assert.equal(Object.keys(happy.result.eventResults[0].checkpoints).length, 6);
assert.equal(happy.fixture.publisherDryRuns[0], true);
assert.equal(happy.logger.runs.length, 1);
assert.equal(happy.logger.runs[0].status, "succeeded");
assert.equal(happy.result.quotaBefore, 6);
assert.equal(happy.result.quotaAfter, 6);
assert.equal(happy.result.eventResults[0].telemetry.verifier.retries, 0);

const skipped = await run({ verifier: "skip" });
assert.equal(skipped.result.eventResults[0].finalState, "SKIPPED");
assert.equal(skipped.result.eventResults[0].stopReason, "SKIPPED_VERIFICATION_INSUFFICIENT");
assert.equal(skipped.result.eventResults[0].requestsUsed, 1);
assert.deepEqual(skipped.fixture.calls, ["discovery", "extraction", "clustering", "verifier"]);
assert.equal(skipped.result.stageStats.publisher.status, "skipped");

for (const [stage, nextStage] of [["translator", "editor"], ["editor", "classifier"], ["classifier", "geo"], ["ranker", "critic"]]) {
  const value = await run({ [stage]: "fail" });
  assert.equal(value.result.eventResults[0].finalState, "FAILED");
  assert.equal(value.result.eventResults[0].stopStage, stage);
  assert.equal(value.fixture.calls.includes(nextStage), false);
}

const criticRevision = await run({ critic: "revise" });
assert.equal(criticRevision.result.eventResults[0].finalState, "BLOCKED_REVISION_REQUIRED");
assert.equal(criticRevision.result.eventResults[0].stopReason, "BLOCKED_REVISION_REQUIRED");
assert.equal(criticRevision.result.eventResults[0].revisionRequired, true);
assert.equal(criticRevision.result.eventResults[0].revisionStage, "editor");
assert.equal(criticRevision.fixture.calls.includes("publisher"), false);

const criticReject = await run({ critic: "reject" });
assert.equal(criticReject.result.eventResults[0].stopReason, "BLOCKED_REJECTED");
assert.equal(criticReject.result.eventResults[0].revisionRequired, false);
assert.equal(criticReject.fixture.calls.includes("publisher"), false);

const checkpointFailure = await run({ checkpointFailure: "verifier" });
assert.equal(checkpointFailure.result.eventResults[0].finalState, "FAILED");
assert.equal(checkpointFailure.result.eventResults[0].stopReason, "checkpoint_failed");
assert.deepEqual(checkpointFailure.result.eventResults[0].failure, { stage: "verifier", errorCode: "checkpoint_failed", errorMessage: "Missing mandatory verifier checkpoint", providerRequestDispatched: false, providerRequestsUsed: 0, attempts: 0, retries: 0, httpStatus: null, checkpointWritten: false, invalidPaths: [] });
assert.equal(checkpointFailure.fixture.calls.includes("translator"), false);
assert.equal(checkpointFailure.result.eventResults[0].requestsUsed, 1);

const stale = createOfflineStages();
const originalVerifier = stale.stages.verifier;
stale.stages.verifier = async (...args) => {
  const outcome = await originalVerifier(...args);
  return { ...outcome, checkpoint: async () => ({ stage: "verifier", path: "memory://stale", eventKey: "stale-event", written: true, readable: true, valid: true }) };
};
const staleResult = await new PipelineOrchestrator({ stages: stale.stages, quota: createStaticPipelineQuota(6), now, config: { dryRun: true, publish: false, hours: 24, limit: 1 } }).run();
assert.equal(staleResult.eventResults[0].finalState, "FAILED");
assert.equal(staleResult.eventResults[0].stopReason, "checkpoint_failed");
assert.equal(staleResult.eventResults[0].requestsUsed, 1);

const insufficient = await run({}, { quota: createStaticPipelineQuota(5) });
assert.equal(insufficient.finalState ?? insufficient.result.finalState, "BLOCKED_BUDGET");
assert.equal(insufficient.result.eventResults[0].stopReason, "BLOCKED_INSUFFICIENT_DAILY_BUDGET");
assert.equal(insufficient.result.eventResults[0].requestsUsed, 0);
assert.equal(insufficient.fixture.calls.includes("verifier"), false);

const exact = await run({}, { quota: createStaticPipelineQuota(6) });
assert.equal(exact.result.eventResults[0].finalState, "READY_FOR_PUBLICATION_DRY_RUN");
assert.equal(exact.result.eventResults[0].requestsUsed, 6);

const secondEvent = {
  ...structuredClone(validFixtures.ClusteredEvent),
  eventKey: "ai-chip-production-2026-09-13",
  canonicalTitle: "A second independent AI chip event",
  sourceItems: [{ ...structuredClone(validFixtures.ClusteredEvent.sourceItems[0]), candidateId: "tech-2026-002", url: "https://example.com/news/ai-chip-2", title: "Second AI chip enters production" }],
};
const multi = createOfflineStages({ failEventKey: secondEvent.eventKey, failStage: "translator" });
// Keep the extraction title aligned with its production-availability body so
// this fixture still reaches the intended Translator technical-failure branch.
multi.stages.discovery = async () => ({ ...offlineDiscoveryResult, candidates: [validFixtures.DiscoveryCandidate, { ...structuredClone(validFixtures.DiscoveryCandidate), externalId: "tech-2026-002", url: "https://example.com/news/ai-chip-2", titleOriginal: "Second AI chip enters production" }], candidatesDiscovered: 2 });
multi.stages.extraction = async () => ({ ...offlineExtractionResult, candidatesSelected: 2, results: [...offlineExtractionResult.results, { ...offlineExtractionResult.results[0], candidate: { ...offlineExtractionResult.results[0].candidate, externalId: "tech-2026-002", url: "https://example.com/news/ai-chip-2", titleOriginal: "Second AI chip enters production" }, item: { ...offlineExtractionResult.results[0].item, candidateId: "tech-2026-002", url: "https://example.com/news/ai-chip-2", canonicalUrl: "https://example.com/news/ai-chip-2", title: "Second AI chip enters production" } }], full: 2 });
multi.stages.clustering = async () => ({ ...offlineClusterResult, extractedItems: 2, events: [validFixtures.ClusteredEvent, secondEvent], singleSourceEvents: 2 });
const multiResult = await new PipelineOrchestrator({ stages: multi.stages, quota: createStaticPipelineQuota(12), now, config: { dryRun: true, publish: false, hours: 24, limit: 2 } }).run();
assert.equal(multiResult.eventResults.length, 2);
assert.equal(multiResult.eventResults[0].finalState, "READY_FOR_PUBLICATION_DRY_RUN");
assert.equal(multiResult.eventResults[1].finalState, "FAILED");
assert.equal(multiResult.eventResults[1].stopStage, "translator");
assert.equal(multiResult.eventsDryRunReady, 1);
assert.equal(multi.calls.filter((stage) => stage === "publisher").length, 1);

const guardFixture = createOfflineStages();
const guardError = new AgentError("EDITOR_GROUNDING_REJECTED", "Editorial draft deterministic grounding rejected: unsupported numeric token", undefined, {
  httpStatus: 200,
  providerRequestDispatched: true,
  finishReason: "stop",
  usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
  requestMetrics: { bodyBytes: 900, systemPromptChars: 10, inputChars: 20, schemaChars: 30, sourceCount: 1, originalContentChars: [100], sentContentChars: [100], truncated: [false] },
  responseBodyBytes: 500,
  validationResult: "invalid",
  failureKind: "DETERMINISTIC_GROUNDING_REJECTION",
  guardFailureType: "NUMERIC_UNSUPPORTED_TOKEN",
  rejectedToken: "9999",
  tokenType: "year",
  draftField: "bodyEs",
});
const guardTelemetry = buildAgentTelemetry({
  status: "DETERMINISTIC_GROUNDING_REJECTION",
  model: "mock-editor",
  agentVersion: "editor-v2",
  config: { model: "mock-editor", timeoutMs: 100, maxRetries: 0, retryBackoffMs: 0, maxOutputTokens: 1200, dailyRequestLimit: 20, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "json_object" },
  diagnostics: guardError.diagnostics,
  attempts: 1,
  providerRequestsUsed: 1,
  latencyMs: 12,
  startedAt: "2026-09-16T12:00:00.000Z",
  finishedAt: "2026-09-16T12:00:00.012Z",
});
setAgentFailureDetails(guardError, { attempts: 1, providerRequestsUsed: 1, latencyMs: 12, diagnostics: guardError.diagnostics, telemetry: guardTelemetry });
const originalGuardEditor = guardFixture.stages.editor;
guardFixture.stages.editor = async () => {
  guardFixture.calls.push("editor");
  void originalGuardEditor;
  throw guardError;
};
const guardAttempts = new InMemoryPipelineEventAttemptRegistry();
const guardResult = await new PipelineOrchestrator({ stages: guardFixture.stages, quota: createStaticPipelineQuota(6), attemptRegistry: guardAttempts, now, config: { dryRun: true, publish: false, hours: 24, limit: 1 } }).run();
const guardEvent = guardResult.eventResults[0];
assert.equal(guardEvent.finalState, "BLOCKED_REJECTED");
assert.equal(guardEvent.stopStage, "editor");
assert.equal(guardEvent.stopReason, "EDITOR_GROUNDING_REJECTED");
assert.equal(guardEvent.requestsUsed, 3);
assert.equal(guardResult.providerRequestsUsed, 3);
assert.equal(guardEvent.failure?.providerRequestDispatched, true);
assert.equal(guardEvent.failure?.providerRequestsUsed, 1);
assert.equal(guardEvent.failure?.httpStatus, 200);
assert.equal(guardEvent.failure?.attempts, 1);
assert.equal(guardEvent.failure?.telemetry?.inputTokens, 40);
assert.equal(guardEvent.failure?.telemetry?.outputTokens, 20);
assert.equal(guardEvent.failure?.telemetry?.requestBytes, 900);
assert.equal(guardEvent.failure?.telemetry?.responseBytes, 500);
assert.equal(guardEvent.checkpoints.editor, undefined);
assert.equal(guardFixture.calls.includes("classifier"), false);
assert.equal(guardFixture.calls.includes("ranker"), false);
assert.equal(guardFixture.calls.includes("critic"), false);
assert.equal(guardFixture.calls.includes("publisher"), false);
assert.deepEqual(supervisedSchedulerOutcome(guardResult), { runStatus: "succeeded", finalDecision: "allowed", schedulerDecision: "COMPLETED", stopReason: "ALL_CANDIDATES_SAFELY_REJECTED" });
assert.deepEqual(guardAttempts.snapshot().map(({ finalState, stopReason, retryClass, countsTowardRetryLimit }) => ({ finalState, stopReason, retryClass, countsTowardRetryLimit })), [
  { finalState: "REJECTED", stopReason: "EDITOR_GROUNDING_REJECTED", retryClass: "REJECTED", countsTowardRetryLimit: false },
]);

let unsupportedDateError;
try {
  validateEditorialDraftOutput(canonicalEditorInput, {
    ...canonicalEditorialDraft,
    bodyEs: `${canonicalEditorialDraft.bodyEs} La empresa fue fundada en 2021.`,
  });
} catch (error) {
  unsupportedDateError = error;
}
assert.ok(unsupportedDateError instanceof AgentError);
assert.equal(unsupportedDateError.code, "EDITOR_GROUNDING_REJECTED");
assert.equal(unsupportedDateError.diagnostics?.rejectedToken, "2021");
const dateGuardFixture = createOfflineStages();
dateGuardFixture.stages.editor = async () => { dateGuardFixture.calls.push("editor"); throw unsupportedDateError; };
const dateGuardAttempts = new InMemoryPipelineEventAttemptRegistry();
const dateGuardResult = await new PipelineOrchestrator({
  stages: dateGuardFixture.stages,
  quota: createStaticPipelineQuota(6),
  attemptRegistry: dateGuardAttempts,
  now,
  config: { dryRun: true, publish: false, hours: 24, limit: 1 },
}).run();
assert.equal(dateGuardResult.eventResults[0].finalState, "BLOCKED_REJECTED");
assert.equal(dateGuardResult.eventResults[0].stopReason, "EDITOR_GROUNDING_REJECTED");
assert.equal(dateGuardFixture.calls.includes("classifier"), false);
assert.equal(dateGuardFixture.calls.includes("publisher"), false);
assert.equal(dateGuardAttempts.snapshot()[0]?.finalState, "REJECTED");
assert.equal(dateGuardAttempts.snapshot()[0]?.countsTowardRetryLimit, false);

const schemaFailureFixture = createOfflineStages();
const schemaFailure = new AgentError("invalid_structured_output", "Editor output did not match EditorialDraft", undefined, {
  providerRequestDispatched: true,
  validationResult: "invalid",
  failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR",
});
schemaFailureFixture.stages.editor = async () => { schemaFailureFixture.calls.push("editor"); throw schemaFailure; };
const schemaFailureAttempts = new InMemoryPipelineEventAttemptRegistry();
const schemaFailureResult = await new PipelineOrchestrator({
  stages: schemaFailureFixture.stages,
  quota: createStaticPipelineQuota(6),
  attemptRegistry: schemaFailureAttempts,
  now,
  config: { dryRun: true, publish: false, hours: 24, limit: 1 },
}).run();
assert.equal(schemaFailureResult.eventResults[0].finalState, "FAILED", "malformed structured output remains a technical failure");
assert.equal(schemaFailureResult.eventResults[0].stopReason, "LOCAL_SCHEMA_VALIDATION_ERROR");
assert.equal(schemaFailureAttempts.snapshot()[0]?.finalState, "TECHNICAL_FAILURE");
assert.equal(schemaFailureAttempts.snapshot()[0]?.countsTowardRetryLimit, true);
assert.equal(schemaFailureFixture.calls.includes("classifier"), false);

const rateLimitFixture = createOfflineStages();
const rateLimitDiagnostics = { httpStatus: 429, providerRequestDispatched: true, failureKind: "PROVIDER_HTTP_ERROR" };
const rateLimitError = new AgentError("provider_permanent", "Provider rate limit", undefined, rateLimitDiagnostics);
const rateLimitTelemetry = buildAgentTelemetry({
  status: "FREE_TIER_LIMIT_REACHED", model: "mock-critic", agentVersion: "critic-v3",
  config: { model: "mock-critic", timeoutMs: 100, maxRetries: 0, retryBackoffMs: 0, maxOutputTokens: 1200, dailyRequestLimit: 20, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "json_object" },
  diagnostics: rateLimitDiagnostics, attempts: 1, providerRequestsUsed: 1, latencyMs: 467,
  startedAt: "2026-09-16T12:00:00.000Z", finishedAt: "2026-09-16T12:00:00.467Z",
});
setAgentFailureDetails(rateLimitError, { attempts: 1, providerRequestsUsed: 1, latencyMs: 467, diagnostics: rateLimitDiagnostics, telemetry: rateLimitTelemetry });
rateLimitFixture.stages.critic = async () => { rateLimitFixture.calls.push("critic"); throw rateLimitError; };
const rateLimitAttempts = new InMemoryPipelineEventAttemptRegistry();
const rateLimitRunId = "44444444-4444-4444-8444-444444444444";
const rateLimitResult = await new PipelineOrchestrator({
  stages: rateLimitFixture.stages, quota: createStaticPipelineQuota(6), persistence: createLoggerPipelinePersistence(new InMemoryAgentLogger()),
  attemptRegistry: rateLimitAttempts, now, runId: rateLimitRunId,
  config: { dryRun: true, publish: false, hours: 24, limit: 1 },
}).run();
const rateLimitEvent = rateLimitResult.eventResults[0];
assert.equal(rateLimitEvent.stopStage, "critic");
assert.equal(rateLimitEvent.stopReason, "PROVIDER_RATE_LIMIT");
assert.equal(rateLimitEvent.failure?.errorCode, "FREE_TIER_LIMIT_REACHED");
assert.equal(rateLimitEvent.failure?.httpStatus, 429);
assert.equal(rateLimitEvent.failure?.attempts, 1);
assert.equal(rateLimitEvent.failure?.retries, 0);
assert.equal(rateLimitEvent.requestsUsed, 6);
assert.ok(rateLimitEvent.checkpoints.ranker);
assert.equal(rateLimitEvent.checkpoints.critic, undefined);
assert.equal(rateLimitFixture.calls.includes("publisher"), false);
const repairedPolicyAttempt = rateLimitAttempts.snapshot()[0];
assert.equal(repairedPolicyAttempt.finalState, "PROVIDER_RATE_LIMIT");
assert.equal(repairedPolicyAttempt.countsTowardRetryLimit, false);
assert.equal(repairedPolicyAttempt.stopStage, "critic");
assert.equal(repairedPolicyAttempt.stopReason, "PROVIDER_RATE_LIMIT");
assert.equal(rateLimitAttempts.snapshot().filter((attempt) => attempt.finalState === "TECHNICAL_FAILURE" && attempt.countsTowardRetryLimit).length, 0);
assert.deepEqual(evaluateNormalEligibility(rateLimitAttempts.snapshot(), now), { eligible: true, reason: "RATE_LIMIT_RETRY_ELIGIBLE" });

const capacityFixture = createOfflineStages();
capacityFixture.stages.classifier = async () => {
  capacityFixture.calls.push("classifier");
  throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "TPM pacing requires waiting", undefined, { providerRequestDispatched: false, failureKind: "PROVIDER_CAPACITY_EXHAUSTED" });
};
const capacityRun = await new PipelineOrchestrator({
  stages: capacityFixture.stages,
  quota: createStaticPipelineQuota(6),
  now,
  runId: "55555555-5555-4555-8555-555555555555",
  config: { dryRun: true, publish: false, hours: 24, limit: 1 },
}).run();
const capacityEvent = capacityRun.eventResults[0];
assert.equal(capacityRun.finalState, "DEFERRED_PROVIDER_CAPACITY");
assert.equal(capacityEvent.finalState, "DEFERRED_PROVIDER_CAPACITY");
assert.equal(capacityEvent.stopReason, "PROVIDER_CAPACITY_EXHAUSTED");
assert.equal(capacityEvent.failure?.providerRequestDispatched, false);
assert.equal(capacityEvent.failure?.providerRequestsUsed, 0);
assert.equal(capacityEvent.requestsUsed, 3);
assert.equal(capacityRun.eventsAttempted, 1);
assert.equal(capacityFixture.calls.includes("translator"), true);
assert.equal(capacityFixture.calls.includes("editor"), true);
assert.equal(capacityFixture.calls.includes("ranker"), false);
assert.equal(capacityFixture.calls.includes("publisher"), false);
assert.equal(capacityEvent.capacityResumeSnapshot, undefined, "standard mode does not expose an unpersisted supervised resume snapshot");

console.log("Pipeline unit fixtures passed: state machine, skips, failures, checkpoints, budget, accounting, multi-event isolation, dry-run, provider 429 routing, no retries");
