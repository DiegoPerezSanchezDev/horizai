import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentError, setAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { InMemoryPipelineEventAttemptRegistry } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { PipelineOrchestrator } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import { createStaticPipelineQuota } from "../lib/agents/pipeline/pipeline-budget.ts";
import { makeOutcome, offlineClusterResult, offlineDiscoveryResult, offlineExtractionResult } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { isSafelyRejectedSupervisedAttempt, SUPERVISED_EVENT_ATTEMPT_LIMIT, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT, SUPERVISED_PROVIDER_REQUEST_LIMIT } from "../lib/agents/pipeline/supervised-throughput-policy.ts";
import { summarizeSupervisedExecution, runAndFinalizeSupervisedExecution } from "../lib/agents/pipeline/scheduler/scheduler-terminal-contract.ts";
import { supervisedSchedulerOutcome } from "../lib/agents/pipeline/supervised-run-outcome.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { criticResultSchema } from "../lib/agents/contracts/index.ts";

const fixedDate = new Date("2026-10-11T10:00:00.000Z");
const sourceId = validFixtures.DiscoveryCandidate.sourceId;
const eventKeyFor = (index) => `synthetic-throughput-${String(index + 1).padStart(2, "0")}`;
const candidateIdFor = (index) => `synthetic-candidate-${String(index + 1).padStart(2, "0")}`;
const rawIdFor = (index) => `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;

function entries(count) {
  return Array.from({ length: count }, (_, index) => {
    const candidateId = candidateIdFor(index);
    const canonicalUrl = `https://example.com/synthetic/story-${index + 1}`;
    const candidate = { ...structuredClone(validFixtures.DiscoveryCandidate), externalId: candidateId, url: canonicalUrl };
    const item = { ...structuredClone(validFixtures.ExtractedItem), candidateId, url: canonicalUrl, canonicalUrl };
    const event = {
      ...structuredClone(validFixtures.ClusteredEvent),
      eventKey: eventKeyFor(index),
      sourceItems: [{ ...structuredClone(validFixtures.ClusteredEvent.sourceItems[0]), candidateId, sourceId, url: canonicalUrl }],
    };
    return { candidate, item, event, rawItemId: rawIdFor(index) };
  });
}

function telemetry(stage, eventKey) {
  return {
    status: "SUCCESS", provider: "groq", providerUnit: "tokens", providerUnitUsageKnown: true,
    estimatedNeurons: null, actualProviderUnitUsage: 30, providerRequestDispatched: true,
    errorCategory: null, rateLimitHeaders: null, providerRateLimit: null, providerHttpStatus: 200,
    model: "synthetic-groq-model", agentVersion: `${stage}-synthetic-v1`, structuredOutputMode: "json_object",
    reasoningEffort: "low", includeReasoning: false, finishReason: "stop", providerRequestsUsed: 1,
    attempts: 1, retries: 0, latencyMs: 1, inputTokens: 20, outputTokens: 10, totalTokens: 30,
    requestBytes: 100, responseBytes: 100, zodValid: true,
    startedAt: fixedDate.toISOString(), finishedAt: fixedDate.toISOString(), eventKey,
  };
}

function makeFailure(code, stage, eventKey, dispatched = true, providerBudget = null) {
  if (dispatched) providerBudget?.reserve("groq", SUPERVISED_PROVIDER_REQUEST_LIMIT);
  const error = new AgentError(code, `Synthetic ${code}`, undefined, { providerRequestDispatched: dispatched, failureKind: code });
  const stageTelemetry = telemetry(stage, eventKey);
  stageTelemetry.providerRequestDispatched = dispatched;
  stageTelemetry.providerRequestsUsed = dispatched ? 1 : 0;
  setAgentFailureDetails(error, {
    attempts: dispatched ? 1 : 0,
    providerRequestsUsed: dispatched ? 1 : 0,
    latencyMs: 1,
    diagnostics: { providerRequestDispatched: dispatched, failureKind: code },
    telemetry: stageTelemetry,
  });
  return error;
}

function fixtureRun({ count = 6, behaviors = {}, limit = SUPERVISED_EVENT_ATTEMPT_LIMIT, lineageCollision = false } = {}) {
  const allEntries = entries(count);
  const calls = [];
  const providerBudget = new ProviderScopedDailyRequestBudget(() => new Date(fixedDate), SUPERVISED_PROVIDER_REQUEST_LIMIT);
  const reviewIds = [];
  const reviewBindings = [];
  const criticLineage = [];
  const stageEventKeys = [];
  const extractionSelectionCounts = [];
  let checkpointRoot;
  let currentConcurrency = 0;
  let maximumConcurrency = 0;
  const track = async (stage, eventKey, operation) => {
    calls.push({ stage, eventKey, requestsReservedAtStart: providerBudget.snapshot("groq").requests });
    if (eventKey) stageEventKeys.push({ stage, eventKey });
    currentConcurrency += 1;
    maximumConcurrency = Math.max(maximumConcurrency, currentConcurrency);
    try { await Promise.resolve(); return await operation(); }
    finally { currentConcurrency -= 1; }
  };
  const response = (stage, output, eventKey, requestCount = 1) => {
    for (let request = 0; request < requestCount; request += 1) providerBudget.reserve("groq", SUPERVISED_PROVIDER_REQUEST_LIMIT);
    const outcome = makeOutcome(output, stage, eventKey, { requests: requestCount, checkpoint: stage !== "geo" });
    return {
      ...outcome,
      ...(stage !== "geo" ? { checkpoint: async () => {
        const path = join(checkpointRoot, `${stage}-${eventKey}.json`);
        await writeFile(path, JSON.stringify({ stage, eventKey, synthetic: true }), "utf8");
        return { stage, path, eventKey, written: true, readable: true, valid: true };
      } } : { checkpoint: undefined }),
      telemetry: requestCount ? telemetry(stage, eventKey) : undefined,
    };
  };
  const pipelineStages = {
    async discovery() {
      return track("discovery", null, async () => ({ ...offlineDiscoveryResult, candidates: allEntries.map((entry) => entry.candidate), candidatesDiscovered: allEntries.length }));
    },
    async extraction({ discovery }) {
      extractionSelectionCounts.push(discovery.candidates.length);
      return track("extraction", null, async () => {
        const selected = discovery.candidates.map((candidate) => allEntries.find((entry) => entry.candidate.externalId === candidate.externalId));
        const results = selected.map((entry) => ({ ...offlineExtractionResult.results[0], candidate: entry.candidate, item: entry.item, contentLength: entry.item.content.length, rawItemId: entry.rawItemId }));
        return { ...offlineExtractionResult, limit: selected.length, candidatesSelected: selected.length, results, full: results.length, averageContentLength: results.length ? Math.round(results.reduce((sum, entry) => sum + entry.contentLength, 0) / results.length) : 0 };
      });
    },
    async clustering({ extraction }) {
      return track("clustering", null, async () => {
        const selectedIds = new Set(extraction.results.map((entry) => entry.candidate.externalId));
        const selected = allEntries.filter((entry) => selectedIds.has(entry.candidate.externalId));
        const events = selected.map((entry) => entry.event);
        if (lineageCollision && events.length > 1) events[1] = { ...events[1], sourceItems: [{ ...events[1].sourceItems[0], candidateId: events[0].sourceItems[0].candidateId }] };
        return { ...offlineClusterResult, extractedItems: selected.length, events, singleSourceEvents: selected.length, largestCluster: selected.length ? 1 : 0 };
      });
    },
    sourceMetadata(event, items, rawItemIds) {
      const item = items[0];
      return [{ sourceId, sourceItemId: item.candidateId, rawItemId: rawItemIds.get(item.candidateId), sourceName: "Synthetic source", sourceUrl: item.canonicalUrl, language: "en", sourceType: "official", countryCode: "US" }];
    },
    async verifier(context) {
      return track("verifier", context.event.eventKey, async () => {
        const behavior = behaviors[context.event.eventKey];
        if (behavior === "verifier-input-too-large") throw makeFailure("VERIFIER_INPUT_TOO_LARGE", "verifier", context.event.eventKey, false, providerBudget);
        if (behavior === "verifier-capacity") throw makeFailure("PROVIDER_CAPACITY_EXHAUSTED", "verifier", context.event.eventKey, false, providerBudget);
        if (behavior === "verifier-reject") return response("verifier", { ...structuredClone(validFixtures.VerificationResult), eventKey: context.event.eventKey, status: "rejected" }, context.event.eventKey);
        return response("verifier", validFixtures.VerificationResult, context.event.eventKey);
      });
    },
    async translator(context) {
      return track("translator", context.event.eventKey, async () => {
        if (behaviors[context.event.eventKey] === "technical") throw makeFailure("LOCAL_SYNTHETIC_FAILURE", "translator", context.event.eventKey, true, providerBudget);
        return response("translator", validFixtures.TranslationResult, context.event.eventKey);
      });
    },
    async editor(context) {
      return track("editor", context.event.eventKey, async () => {
        const behavior = behaviors[context.event.eventKey];
        if (behavior === "grounding") throw makeFailure("EDITOR_GROUNDING_REJECTED", "editor", context.event.eventKey, true, providerBudget);
        if (behavior === "malformed-editor") throw makeFailure("LOCAL_SCHEMA_VALIDATION_ERROR", "editor", context.event.eventKey, true, providerBudget);
        if (behavior === "capacity") throw makeFailure("PROVIDER_CAPACITY_EXHAUSTED", "editor", context.event.eventKey, false, providerBudget);
        return response("editor", validFixtures.EditorialDraft, context.event.eventKey);
      });
    },
    async classifier(context) {
      return track("classifier", context.event.eventKey, async () => response("classifier", validFixtures.ClassificationResult, context.event.eventKey));
    },
    async geo(context) {
      return track("geo", context.event.eventKey, async () => response("geo", { eventKey: context.event.eventKey, primaryRegionCode: "US", countryCodes: ["US"], latitude: 39.8283, longitude: -98.5795, resolutionLevel: "region", resolvedFrom: "region_registry", provenance: "reference_registry" }, context.event.eventKey, 0));
    },
    async ranker(context) {
      return track("ranker", context.event.eventKey, async () => response("ranker", validFixtures.RankingResult, context.event.eventKey));
    },
    async critic(context, run) {
      return track("critic", context.event.eventKey, async () => {
        const behavior = behaviors[context.event.eventKey];
        if (behavior === "critic-technical") throw makeFailure("LOCAL_SYNTHETIC_CRITIC_FAILURE", "critic", context.event.eventKey, true, providerBudget);
        if (behavior === "malformed-critic") return response("critic", { ...validFixtures.CriticResult, decision: "PASS" }, context.event.eventKey);
        const decision = behavior === "critic-reject" ? "reject" : behavior === "critic-revise" ? "revise_editorial" : "pass";
        criticLineage.push({ attemptId: context.eventAttemptId ?? null, eventKey: context.event.eventKey, pipelineRunId: run.runId, decision });
        return response("critic", { ...validFixtures.CriticResult, eventKey: context.event.eventKey, decision }, context.event.eventKey);
      });
    },
    async publisher() { throw new Error("SUPERVISED_THROUGHPUT_TEST_PUBLISHER_MUST_NOT_RUN"); },
  };
  const attemptRegistry = new InMemoryPipelineEventAttemptRegistry();
  const orchestrator = new PipelineOrchestrator({
    stages: pipelineStages,
    quota: createStaticPipelineQuota(100),
    attemptRegistry,
    humanReviewGateway: { async createReview({ attemptId, context, run }) {
      reviewIds.push(attemptId);
      reviewBindings.push({ attemptId, eventKey: context.event.eventKey, pipelineRunId: run.runId });
      const attempt = attemptRegistry.snapshot().find((entry) => entry.id === attemptId);
      assert.ok(attempt, "the waiting review is bound to the claimed synthetic attempt");
      await attemptRegistry.finalize({ attemptId, pipelineRunId: run.runId, completedAt: fixedDate.toISOString(), finalState: "WAITING_FOR_HUMAN_REVIEW", stopStage: "human_review", stopReason: "HUMAN_REVIEW_PENDING", retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null });
      return { reviewId: crypto.randomUUID(), packageSha256: "a".repeat(64) };
    } },
    capacityResumeSnapshotWriter: async () => ({ path: "memory://synthetic-capacity-resume" }),
    now: () => new Date(fixedDate),
    runId: "33333333-3333-4333-8333-333333333333",
    config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1 },
  });
  let ran = false;
  return {
    async run() {
      if (ran) throw new Error("SYNTHETIC_FIXTURE_ALREADY_RUN");
      ran = true;
      checkpointRoot = await mkdtemp(join(tmpdir(), "horizai-supervised-throughput-"));
      try { return await orchestrator.run(); }
      finally {
        assert.ok(checkpointRoot.startsWith(join(tmpdir(), "horizai-supervised-throughput-")));
        await rm(checkpointRoot, { recursive: true, force: true });
      }
    },
    attemptRegistry, calls, reviewIds, reviewBindings, criticLineage, stageEventKeys, extractionSelectionCounts, providerBudget,
    get maximumConcurrency() { return maximumConcurrency; },
  };
}

assert.equal(SUPERVISED_EXTRACTION_CANDIDATE_LIMIT, 6);
assert.equal(SUPERVISED_EVENT_ATTEMPT_LIMIT, 5);
assert.equal(SUPERVISED_PROVIDER_REQUEST_LIMIT, 36);
assert.equal(isSafelyRejectedSupervisedAttempt({ finalState: "BLOCKED_REJECTED", stopStage: "critic", stopReason: "BLOCKED_REJECTED" }), true);
assert.equal(isSafelyRejectedSupervisedAttempt({ finalState: "BLOCKED_REJECTED", stopStage: "verifier", stopReason: "VERIFIER_INPUT_TOO_LARGE" }), true);
assert.equal(isSafelyRejectedSupervisedAttempt({ finalState: "BLOCKED_REVISION_REQUIRED", stopStage: "critic", stopReason: "BLOCKED_REVISION_REQUIRED", criticDecision: "revise_editorial" }), true);
assert.equal(isSafelyRejectedSupervisedAttempt({ finalState: "BLOCKED_REVISION_REQUIRED", stopStage: "critic", stopReason: "BLOCKED_REVISION_REQUIRED", criticDecision: "pass" }), false, "continuation is limited to the exact Critic semantic terminal");
assert.equal(isSafelyRejectedSupervisedAttempt({ finalState: "BLOCKED_REVISION_REQUIRED", stopStage: "editor", stopReason: "BLOCKED_REVISION_REQUIRED", criticDecision: "revise_editorial" }), false);
assert.equal(isSafelyRejectedSupervisedAttempt({ finalState: "FAILED", stopStage: "editor", stopReason: "LOCAL_SCHEMA_VALIDATION_ERROR" }), false);

// An irreducible Verifier evidence package is a safe local rejection and may consume the next isolated candidate without a provider request.
{
  const fixture = fixtureRun({ count: 3, behaviors: { [eventKeyFor(0)]: "verifier-input-too-large", [eventKeyFor(1)]: "verifier-reject" } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => [event.finalState, event.stopStage, event.stopReason, event.requestsUsed]), [
    ["BLOCKED_REJECTED", "verifier", "VERIFIER_INPUT_TOO_LARGE", 0],
    ["SKIPPED", "verifier", "VERIFICATION_REJECTED", 1],
    ["WAITING_FOR_HUMAN_REVIEW", "human_review", "HUMAN_REVIEW_PENDING", 6],
  ]);
  assert.equal(result.eventResults[0].failure.providerRequestDispatched, false);
  assert.equal(result.eventResults[0].failure.providerRequestsUsed, 0);
  assert.equal(result.eventsAttempted, 3);
  assert.equal(fixture.providerBudget.snapshot("groq").requests, 7, "only the following accepted/rejected Verifier and review candidate requests are accounted");
  assert.equal(fixture.attemptRegistry.snapshot()[0].finalState, "REJECTED");
}

// A schema-valid Critic revision is terminal for its event, but safely consumes that candidate.
{
  const validRevision = criticResultSchema.parse({ ...validFixtures.CriticResult, decision: "revise_editorial" });
  assert.equal(validRevision.decision, "revise_editorial");
  const fixture = fixtureRun({ count: 2, behaviors: { [eventKeyFor(0)]: "critic-revise" } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => event.finalState), ["BLOCKED_REVISION_REQUIRED", "WAITING_FOR_HUMAN_REVIEW"]);
  assert.deepEqual(result.eventResults.map((event) => event.stopReason), ["BLOCKED_REVISION_REQUIRED", "HUMAN_REVIEW_PENDING"]);
  assert.equal(result.eventResults[0].criticDecision, "revise_editorial");
  assert.equal(result.eventResults[0].revision?.revisionStarted, false, "supervised mode does not start automatic remediation");
  assert.equal(result.eventsAttempted, 2);
  assert.equal(result.eventsAwaitingHumanReview, 1);
  assert.equal(fixture.reviewIds.length, 1);
  const attempts = fixture.attemptRegistry.snapshot();
  assert.deepEqual(attempts.map((attempt) => [attempt.finalState, attempt.stopReason, attempt.retryClass, attempt.countsTowardRetryLimit]), [
    ["REVISION_REQUIRED", "BLOCKED_REVISION_REQUIRED", "REVISION_REQUIRED", false],
    ["WAITING_FOR_HUMAN_REVIEW", "HUMAN_REVIEW_PENDING", "NONE", false],
  ]);
  assert.equal(attempts[0].id === fixture.reviewIds[0], false, "revision attempt cannot create or own the next candidate's review");
  assert.equal(attempts[1].id, fixture.reviewIds[0], "the sole review is bound to the PASS attempt");
  assert.deepEqual(fixture.criticLineage.map((entry) => [entry.attemptId, entry.eventKey, entry.pipelineRunId, entry.decision]), result.eventResults.map((event) => [event.attemptId, event.eventKey, result.runId, event.criticDecision]));
  assert.deepEqual(fixture.reviewBindings, [{ attemptId: attempts[1].id, eventKey: attempts[1].eventKey, pipelineRunId: result.runId }], "review lineage uses the second candidate's PASS attempt only");
  assert.notEqual(attempts[0].id, attempts[1].id);
  assert.notEqual(attempts[0].eventKey, attempts[1].eventKey);
  assert.equal(attempts.every((attempt) => attempt.pipelineRunId === result.runId), true, "attempts share only the daily pipeline-run grouping");
  assert.equal(fixture.calls.filter((call) => call.stage === "editor" && call.eventKey === eventKeyFor(0)).length, 1, "revise_editorial does not dispatch Editor again");
  assert.equal(fixture.calls.filter((call) => call.stage === "critic").length, 2);
  assert.equal(fixture.calls.some((call) => call.stage === "publisher"), false);
  assert.equal(result.providerRequestsUsed, 12, "six requests per candidate are accounted in one shared run budget");
  assert.equal(fixture.providerBudget.snapshot("groq").requests, 12, "attempt two inherits the run reservation ledger; the first six are not reset");
  assert.equal(fixture.calls.find((call) => call.stage === "verifier" && call.eventKey === eventKeyFor(1))?.requestsReservedAtStart, 6, "after attempt one used six reservations, twelve remain in the shared hard cap");
  assert.ok(result.providerRequestsUsed <= SUPERVISED_PROVIDER_REQUEST_LIMIT);
  assert.equal(fixture.maximumConcurrency, 1);
  for (const event of result.eventResults) {
    assert.ok(Object.values(event.checkpoints).every((checkpoint) => checkpoint.eventKey === event.eventKey));
  }
  assert.notEqual(result.eventResults[0].checkpoints.critic?.path, result.eventResults[1].checkpoints.critic?.path, "Critic evidence checkpoints remain event-scoped");
  assert.equal(supervisedSchedulerOutcome(result).schedulerDecision, "WAITING_FOR_HUMAN_REVIEW");
}

// Six candidates are extracted, but a safe rejection followed by review-ready candidates continues until the 5-attempt limit.
{
  const fixture = fixtureRun({ count: 8, behaviors: { [eventKeyFor(0)]: "grounding" } });
  const result = await fixture.run();
  assert.deepEqual(fixture.extractionSelectionCounts, [6]);
  assert.equal(result.extractionSummary.candidatesSelected, 6);
  assert.equal(result.eventResults.length, 5, JSON.stringify(result.eventResults.map(({ eventKey, finalState, stopStage, stopReason, failure }) => ({ eventKey, finalState, stopStage, stopReason, failure }))));
  assert.equal(result.eventsAttempted, 5);
  assert.equal(result.eventsAwaitingHumanReview, 4);
  assert.equal(fixture.reviewIds.length, 4);
  assert.equal(fixture.attemptRegistry.snapshot().length, 5);
  assert.notEqual(fixture.attemptRegistry.snapshot()[0].id, fixture.attemptRegistry.snapshot()[1].id);
  assert.notEqual(fixture.attemptRegistry.snapshot()[0].eventKey, fixture.attemptRegistry.snapshot()[1].eventKey);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(5)), false, "the attempt limit still stops the cycle");
  assert.equal(fixture.maximumConcurrency, 1);
  assert.equal(result.eventsPublished, 0);
  assert.deepEqual(fixture.attemptRegistry.snapshot().map((attempt) => attempt.finalState), ["REJECTED", "WAITING_FOR_HUMAN_REVIEW", "WAITING_FOR_HUMAN_REVIEW", "WAITING_FOR_HUMAN_REVIEW", "WAITING_FOR_HUMAN_REVIEW"]);
  assert.equal(result.eventResults[0].stopStage, "editor");
  assert.equal(result.eventResults[1].stopStage, "human_review", "Critic PASS on the second attempt is review-ready and the cycle continues");
  for (const event of result.eventResults) {
    assert.ok(event.attemptId);
    assert.ok(Object.values(event.checkpoints).every((checkpoint) => checkpoint.eventKey === event.eventKey), "checkpoints remain bound to their own event lineage");
  }
  assert.notEqual(result.eventResults[0].eventKey, result.eventResults[1].eventKey);
}

// A safe Editor rejection followed by a safe Critic rejection may continue to a third attempt.
{
  const fixture = fixtureRun({ count: 6, behaviors: { [eventKeyFor(0)]: "grounding", [eventKeyFor(1)]: "critic-reject" } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => event.finalState), ["BLOCKED_REJECTED", "BLOCKED_REJECTED", "WAITING_FOR_HUMAN_REVIEW", "WAITING_FOR_HUMAN_REVIEW", "WAITING_FOR_HUMAN_REVIEW"]);
  assert.equal(result.eventsAttempted, 5);
  assert.equal(fixture.attemptRegistry.snapshot().length, 5);
  assert.equal(fixture.reviewIds.length, 3);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(5)), false);
}

// Verifier rejection, Critic rejection, and grounding rejection consume exactly five isolated attempts.
{
  const fixture = fixtureRun({ count: 6, behaviors: { [eventKeyFor(0)]: "verifier-reject", [eventKeyFor(1)]: "critic-reject", [eventKeyFor(2)]: "grounding", [eventKeyFor(3)]: "verifier-reject", [eventKeyFor(4)]: "critic-reject" } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => event.finalState), ["SKIPPED", "BLOCKED_REJECTED", "BLOCKED_REJECTED", "SKIPPED", "BLOCKED_REJECTED"]);
  assert.equal(result.eventsAttempted, 5);
  assert.equal(fixture.attemptRegistry.snapshot().length, 5);
  assert.equal(fixture.reviewIds.length, 0, "Critic REJECT is a safe semantic terminal and never creates human review");
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(5)), false, "attempt six is impossible after the deterministic five-attempt cap");
  assert.deepEqual(fixture.attemptRegistry.snapshot().map((attempt) => attempt.finalState), ["REJECTED", "REJECTED", "REJECTED", "REJECTED", "REJECTED"]);
  assert.equal(result.finalState, "SUCCESS", "a run containing only safe rejections is non-technical completion");
  assert.deepEqual(supervisedSchedulerOutcome(result), { runStatus: "succeeded", finalDecision: "allowed", schedulerDecision: "COMPLETED", stopReason: "ALL_CANDIDATES_SAFELY_REJECTED" });
}

// Critic revision, Editor grounding rejection, and Verifier rejection exhaust the safe five-candidate budget.
{
  const fixture = fixtureRun({ count: 6, behaviors: { [eventKeyFor(0)]: "critic-revise", [eventKeyFor(1)]: "grounding", [eventKeyFor(2)]: "verifier-reject", [eventKeyFor(3)]: "critic-revise", [eventKeyFor(4)]: "grounding" } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => [event.finalState, event.stopReason]), [
    ["BLOCKED_REVISION_REQUIRED", "BLOCKED_REVISION_REQUIRED"],
    ["BLOCKED_REJECTED", "EDITOR_GROUNDING_REJECTED"],
    ["SKIPPED", "VERIFICATION_REJECTED"],
    ["BLOCKED_REVISION_REQUIRED", "BLOCKED_REVISION_REQUIRED"],
    ["BLOCKED_REJECTED", "EDITOR_GROUNDING_REJECTED"],
  ]);
  assert.equal(result.eventsAttempted, 5);
  assert.equal(result.finalState, "SUCCESS");
  assert.ok(result.providerRequestsUsed <= SUPERVISED_PROVIDER_REQUEST_LIMIT);
  assert.equal(fixture.attemptRegistry.snapshot().length, 5);
  assert.equal(fixture.reviewIds.length, 0);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(5)), false, "no sixth candidate starts after the cap");
  const outcome = supervisedSchedulerOutcome(result);
  assert.deepEqual(outcome, { runStatus: "succeeded", finalDecision: "allowed", schedulerDecision: "COMPLETED", stopReason: "ALL_CANDIDATES_SAFELY_REJECTED" });
  const summary = summarizeSupervisedExecution(result, outcome);
  assert.equal(summary.attemptsRejectedSafely, 5);
  assert.equal(summary.attemptsTechnicalFailure, 0);
  assert.deepEqual(summary.eventFinalStates.map((event) => event.stopReason), ["BLOCKED_REVISION_REQUIRED", "EDITOR_GROUNDING_REJECTED", "VERIFICATION_REJECTED", "BLOCKED_REVISION_REQUIRED", "EDITOR_GROUNDING_REJECTED"]);
  assert.ok(summary.eventFinalStates.every((event) => event.terminalClass === "SAFE_REJECTION"));
}

// Five safe Critic revisions share one hard run-scoped ledger within the request cap.
{
  const fixture = fixtureRun({ count: 6, behaviors: { [eventKeyFor(0)]: "critic-revise", [eventKeyFor(1)]: "critic-revise", [eventKeyFor(2)]: "critic-revise", [eventKeyFor(3)]: "critic-revise", [eventKeyFor(4)]: "critic-revise" } });
  const result = await fixture.run();
  assert.equal(result.eventsAttempted, 5);
  assert.ok(result.providerRequestsUsed <= SUPERVISED_PROVIDER_REQUEST_LIMIT);
  assert.equal(fixture.providerBudget.snapshot("groq").requests, result.providerRequestsUsed);
  assert.equal(fixture.attemptRegistry.snapshot().length, SUPERVISED_EVENT_ATTEMPT_LIMIT);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(5)), false);
  assert.equal(supervisedSchedulerOutcome(result).stopReason, "ALL_CANDIDATES_SAFELY_REJECTED");
}

// Ambiguous candidate-to-event lineage fails before any event attempt is claimed.
{
  const fixture = fixtureRun({ count: 3, lineageCollision: true });
  await assert.rejects(() => fixture.run(), /SUPERVISED_EVENT_LINEAGE_AMBIGUOUS/);
  assert.equal(fixture.attemptRegistry.snapshot().length, 0);
  assert.equal(fixture.calls.some((call) => call.stage === "verifier"), false);
}

// Technical failure, capacity defer and malformed Editor output stop immediately. A review-ready candidate does not (see below).
for (const [behavior, expectedState] of [["technical", "FAILED"], ["capacity", "DEFERRED_PROVIDER_CAPACITY"], ["malformed-editor", "FAILED"]]) {
  const fixture = fixtureRun({ count: 4, behaviors: { [eventKeyFor(0)]: behavior === "waiting" ? undefined : behavior } });
  const result = await fixture.run();
  assert.equal(result.eventResults[0]?.finalState, expectedState);
  assert.equal(result.eventResults.length, 1);
  assert.equal(result.eventsAttempted, 1);
  assert.equal(fixture.attemptRegistry.snapshot().length, 1);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(1)), false);
}

// Review-ready candidates keep the cycle going up to the attempt limit; no event beyond the limit is touched.
{
  const fixture = fixtureRun({ count: 7 });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => event.finalState), Array(5).fill("WAITING_FOR_HUMAN_REVIEW"));
  assert.equal(fixture.reviewIds.length, 5);
  assert.equal(result.providerRequestsUsed, 30, "five events at six requests each stay within the 36-request cap");
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(5)), false);
}

// After one safe Editor rejection, a Critic runtime or schema failure is technical and stops before attempt three.
for (const behavior of ["critic-technical", "malformed-critic"]) {
  const fixture = fixtureRun({ count: 4, behaviors: { [eventKeyFor(0)]: "grounding", [eventKeyFor(1)]: behavior } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => event.finalState), ["BLOCKED_REJECTED", "FAILED"]);
  assert.equal(result.eventResults[1].stopStage, "critic");
  assert.equal(result.eventsAttempted, 2);
  assert.equal(fixture.attemptRegistry.snapshot().length, 2);
  assert.equal(fixture.reviewIds.length, 0);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(2)), false);
  assert.equal(supervisedSchedulerOutcome(result).schedulerDecision, "TECHNICAL_FAILURE");
}

// A semantic revision may continue once, but the next actual technical failure stops the daily run.
{
  const fixture = fixtureRun({ count: 4, behaviors: { [eventKeyFor(0)]: "critic-revise", [eventKeyFor(1)]: "technical" } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => event.finalState), ["BLOCKED_REVISION_REQUIRED", "FAILED"]);
  assert.equal(result.eventsAttempted, 2);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(2)), false);
  assert.deepEqual(supervisedSchedulerOutcome(result), { runStatus: "failed", finalDecision: "failed", schedulerDecision: "TECHNICAL_FAILURE", stopReason: "LOCAL_SYNTHETIC_FAILURE" });
}

// A semantic revision may continue once, but a pre-dispatch capacity defer stops before candidate three.
{
  const fixture = fixtureRun({ count: 4, behaviors: { [eventKeyFor(0)]: "critic-revise", [eventKeyFor(1)]: "capacity" } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => event.finalState), ["BLOCKED_REVISION_REQUIRED", "DEFERRED_PROVIDER_CAPACITY"]);
  assert.equal(result.eventsAttempted, 2);
  assert.equal(fixture.attemptRegistry.snapshot().length, 2);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(2)), false);
  assert.deepEqual(supervisedSchedulerOutcome(result), { runStatus: "blocked", finalDecision: "blocked", schedulerDecision: "STOPPED_CAPACITY", stopReason: "PROVIDER_CAPACITY_EXHAUSTED" });
}

// First-stage Verifier capacity defer stops the daily execution before candidate two.
{
  const fixture = fixtureRun({ count: 4, behaviors: { [eventKeyFor(0)]: "verifier-capacity" } });
  const result = await fixture.run();
  assert.equal(result.eventResults.length, 1);
  assert.equal(result.eventResults[0].finalState, "DEFERRED_PROVIDER_CAPACITY");
  assert.equal(result.eventResults[0].stopStage, "verifier");
  assert.equal(result.eventsAttempted, 1);
  assert.equal(fixture.attemptRegistry.snapshot().length, 1);
  assert.equal(fixture.calls.some((call) => call.stage === "verifier" && call.eventKey === eventKeyFor(1)), false);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(1)), false, "capacity defer does not select candidate two");
  assert.deepEqual(supervisedSchedulerOutcome(result), { runStatus: "blocked", finalDecision: "blocked", schedulerDecision: "STOPPED_CAPACITY", stopReason: "PROVIDER_CAPACITY_EXHAUSTED" });
}

// A safe rejection may be followed by an unsafe Editor failure; the latter stops before attempt three.
{
  const fixture = fixtureRun({ count: 4, behaviors: { [eventKeyFor(0)]: "verifier-reject", [eventKeyFor(1)]: "malformed-editor" } });
  const result = await fixture.run();
  assert.deepEqual(result.eventResults.map((event) => event.finalState), ["SKIPPED", "FAILED"]);
  assert.equal(result.eventsAttempted, 2);
  assert.equal(fixture.attemptRegistry.snapshot().length, 2);
  assert.equal(fixture.calls.some((call) => call.eventKey === eventKeyFor(2)), false);
  assert.equal(supervisedSchedulerOutcome(result).schedulerDecision, "TECHNICAL_FAILURE");
}

// A run-scoped cap counts reservations across UTC rollover and prevents request nineteen.
{
  let current = new Date("2026-10-11T23:59:59.000Z");
  const budget = new ProviderScopedDailyRequestBudget(() => current, SUPERVISED_PROVIDER_REQUEST_LIMIT);
  for (let index = 0; index < SUPERVISED_PROVIDER_REQUEST_LIMIT; index += 1) budget.reserve("groq", 40);
  assert.equal(budget.snapshot("groq").requests, 36);
  current = new Date("2026-10-12T00:00:01.000Z");
  assert.throws(() => budget.reserve("groq", 40), { code: "DAILY_REQUEST_LIMIT_REACHED" });
  assert.equal(budget.snapshot("groq").requests, 0, "the UTC ledger is separate while the per-run hard cap remains consumed");
}

// The canonical UTC identity and fenced daily claim are shared with the background worker.
{
  const source = readFileSync(new URL("./supervised-pipeline-run.ts", import.meta.url), "utf8");
  assert.match(source, /schedulerKickoffMetadata\(now\)/);
  assert.match(source, /const triggerId = metadata\.triggerId/);
  assert.match(source, /control\.claim\(\{ metadata, ownerId: ownerRunId, now \}\)/);
  assert.equal((source.match(/scheduler\.acquire\(/g) ?? []).length, 1);
  assert.match(source, /function utcDate\(date: Date\): string \{ return date\.toISOString\(\)\.slice\(0, 10\); \}/);
}

// Scheduler finalization aggregates attempt lineage and provider accounting once for the whole run.
{
  const fixture = fixtureRun({ count: 2, behaviors: { [eventKeyFor(0)]: "grounding" } });
  const result = await fixture.run();
  const outcome = supervisedSchedulerOutcome(result);
  const summary = summarizeSupervisedExecution(result, outcome);
  assert.equal(summary.attemptsStarted, 2);
  assert.equal(summary.attemptsRejectedSafely, 1);
  assert.equal(summary.attemptsTechnicalFailure, 0);
  assert.equal(summary.attemptsDeferred, 0);
  assert.equal(summary.reviewsCreated, 1);
  assert.equal(summary.providerRequests, result.providerRequestsUsed);
  assert.equal(summary.finalOutcome, "WAITING_FOR_HUMAN_REVIEW");
  assert.equal((summary.eventFinalStates).length, 2);
  assert.deepEqual((summary.eventFinalStates).map((event) => event.attemptId), result.eventResults.map((event) => event.attemptId));
  assert.equal((summary.eventFinalStates).reduce((sum, event) => sum + event.providerRequests, 0), result.providerRequestsUsed);
  assert.equal((summary.eventFinalStates).every((event) => event.tokenUsageKnown), true);
  assert.equal((summary.eventFinalStates).reduce((sum, event) => sum + event.totalTokens, 0), result.providerRequestsUsed * 30);

  let finishCalls = 0;
  const finalized = await runAndFinalizeSupervisedExecution({
    triggerId: "supervised-candidates:2026-10-11", ownerRunId: "44444444-4444-4444-8444-444444444444", startedAt: fixedDate,
    pipelineRunId: () => result.runId, execute: async () => result, quotaUsed: () => 0, quotaRemaining: () => 0,
    finishExecution: async (input) => {
      finishCalls += 1;
      assert.equal(input.eventAttempts, 2);
      assert.equal(input.requestsUsed, result.providerRequestsUsed);
      assert.equal(input.eventFinalStates.length, 2);
      return true;
    },
  });
  assert.equal(finishCalls, 1);
  assert.equal(finalized.outcome.schedulerDecision, "WAITING_FOR_HUMAN_REVIEW");
}

console.log("supervised throughput fixtures passed: extraction 6, sequential attempts 5, safe continue, stop states, isolated lineage, hard request cap, one trigger, aggregate accounting, exactly-once finalizer; provider calls 0");
