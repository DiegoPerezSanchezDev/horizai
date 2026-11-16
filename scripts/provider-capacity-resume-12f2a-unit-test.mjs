import assert from "node:assert/strict";
import { atomicHumanReviewGateway } from "./fixtures/atomic-human-review-gateway.mjs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, createStaticPipelineQuota, assessCapacityResume, checkpointSha256, evaluateNormalEligibility, readCapacityResumeSnapshot, supervisedSchedulerOutcome, writeCapacityResumeSnapshot } from "../lib/agents/pipeline/index.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { capacityResumeStages } from "../lib/agents/pipeline/provider-capacity-resume.ts";

assert.deepEqual(capacityResumeStages, ["verifier", "translator", "editor", "classifier", "ranker", "critic"], "M35 adds durable resume from the first missing provider stage while preserving M33 downstream stages");

const event = structuredClone(validFixtures.ClusteredEvent);
const eventKey = event.eventKey;
const item = structuredClone(validFixtures.ExtractedItem);
const sourceId = event.sourceItems[0].sourceId;
const source = {
  sourceId,
  sourceItemId: event.sourceItems[0].candidateId,
  rawItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceName: event.sourceItems[0].sourceName,
  sourceUrl: item.canonicalUrl,
  sourceType: "official",
  countryCode: "US",
  language: "en",
};
const checkpoint = (stage, sha) => ({ stage, eventKey, path: `memory://${stage}/${eventKey}`, written: true, readable: true, valid: true, sha256: sha });
const telemetry = (stage, tokens) => ({
  status: "SUCCESS", provider: "groq", providerUnit: "tokens", providerUnitUsageKnown: true,
  providerRequestDispatched: true, providerRequestsUsed: 1, attempts: 1, retries: 0,
  inputTokens: tokens - 20, outputTokens: 20, totalTokens: tokens,
  agentVersion: `${stage}-v1`, model: "offline-recorded-model", latencyMs: 1,
  startedAt: "2026-10-07T19:30:00.000Z", finishedAt: "2026-10-07T19:30:00.001Z",
});
const hashes = { verifier: "a".repeat(64), translator: "b".repeat(64), editor: "c".repeat(64) };
const attemptId = randomUUID();
const pipelineRunId = randomUUID();
const snapshot = {
  schemaVersion: 1,
  kind: "SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME",
  attemptId,
  pipelineRunId,
  eventKey,
  resumeStage: "classifier",
  event,
  items: [item],
  sources: [source],
  verification: structuredClone(validFixtures.VerificationResult),
  translation: structuredClone(validFixtures.TranslationResult),
  editorial: structuredClone(validFixtures.EditorialDraft),
  checkpoints: { verifier: checkpoint("verifier", hashes.verifier), translator: checkpoint("translator", hashes.translator), editor: checkpoint("editor", hashes.editor) },
  checkpointSha256: hashes,
  providerAccounting: { verifier: telemetry("verifier", 2586), translator: telemetry("translator", 1225), editor: telemetry("editor", 1576) },
  classifierDispatchCount: 0,
  classifierCheckpointPresent: false,
  nextStageDispatchCount: 0,
  nextStageCheckpointPresent: false,
  resumeGeneration: 0,
};
const attempt = {
  id: attemptId, eventKey, pipelineRunId, attemptNumber: 1,
  startedAt: "2026-10-07T19:30:00.000Z", completedAt: null, finalState: null,
  stopStage: "classifier", stopReason: "PROVIDER_CAPACITY_EXHAUSTED", retryClass: "NONE",
  countsTowardRetryLimit: false, nextEligibleAt: null, createdAt: "2026-10-07T19:30:00.000Z", capacityResumeSnapshot: snapshot,
};
const evidence = {
  attempt: { attemptId, eventKey, pipelineRunId, completedAt: null, finalState: null, stopStage: "classifier", stopReason: "PROVIDER_CAPACITY_EXHAUSTED", countsTowardRetryLimit: false },
  currentEvent: structuredClone(event),
  currentSources: [structuredClone(source)],
  currentItems: [structuredClone(item)],
  currentCheckpointSha256: { ...hashes },
  classifierDispatchCount: 0,
  classifierCheckpointPresent: false,
  unresolvedProviderUsage: false,
  activeOwner: false,
  terminalEditorialRejection: false,
};

const assessment = assessCapacityResume(snapshot, evidence, { ownerId: "synthetic-owner" });
assert.equal(assessment.valid, true);
assert.equal(assessment.firstStage, "classifier");
assert.equal(assessment.previousModelCallsToRepeat, 0);
const reverseKeyOrder = (value) => Array.isArray(value)
  ? value.map(reverseKeyOrder)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverseKeyOrder(entry)]))
    : value;
assert.equal(assessCapacityResume(snapshot, { ...evidence, currentEvent: reverseKeyOrder(event) }).valid, true);
assert.equal(evaluateNormalEligibility([{ ...attempt, startedAt: "2026-10-01T00:00:00.000Z" }], new Date("2026-10-07T20:00:00.000Z")).reason, "RESUME_REQUIRED");
const temporaryRoot = await mkdtemp(join(tmpdir(), "horizai-capacity-resume-12f2a-"));
try {
  const durableCheckpoints = {};
  for (const stage of ["verifier", "translator", "editor"]) {
    const checkpointPath = join(temporaryRoot, `${stage}.json`);
    await writeFile(checkpointPath, `${stage}-synthetic-checkpoint\n`, "utf8");
    durableCheckpoints[stage] = { ...snapshot.checkpoints[stage], path: checkpointPath };
  }
  const snapshotWithoutFixtureHashes = { ...snapshot };
  delete snapshotWithoutFixtureHashes.checkpointSha256;
  const snapshotPath = join(temporaryRoot, "capacity-resume.json");
  await writeCapacityResumeSnapshot({ ...snapshotWithoutFixtureHashes, checkpoints: durableCheckpoints }, snapshotPath);
  const loaded = await readCapacityResumeSnapshot(snapshotPath);
  const diskHashes = await checkpointSha256(loaded.snapshot.checkpoints);
  assert.deepEqual(diskHashes, loaded.snapshot.checkpointSha256);
  assert.equal(loaded.snapshot.eventKey, eventKey);
} finally {
  if (!resolve(temporaryRoot).startsWith(resolve(tmpdir()))) throw new Error("CAPACITY_RESUME_TEST_TEMP_PATH_INVALID");
  await rm(temporaryRoot, { recursive: true, force: true });
}
const schedulerCapacity = supervisedSchedulerOutcome({
  finalState: "DEFERRED_PROVIDER_CAPACITY", eventsAwaitingHumanReview: 0, eventsFailed: 0, eventsBlocked: 0,
  eventsSkipped: 0, eventsAttempted: 1, eventResults: [{ finalState: "DEFERRED_PROVIDER_CAPACITY", stopReason: "PROVIDER_CAPACITY_EXHAUSTED" }],
});
assert.deepEqual(schedulerCapacity, { runStatus: "blocked", finalDecision: "blocked", schedulerDecision: "STOPPED_CAPACITY", stopReason: "PROVIDER_CAPACITY_EXHAUSTED" });
assert.notEqual(schedulerCapacity.runStatus, "succeeded");

const negativeCases = [
  ["changed checkpoint", { ...evidence, currentCheckpointSha256: { ...hashes, editor: "d".repeat(64) } }],
  ["changed lineage", { ...evidence, currentSources: [{ ...source, rawItemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] }],
  ["changed event", { ...evidence, currentEvent: { ...event, eventKey: "event-changed" } }],
  ["changed attempt", { ...evidence, attempt: { ...evidence.attempt, attemptId: randomUUID() } }],
  ["ambiguous classifier dispatch", { ...evidence, classifierDispatchCount: 1 }],
  ["classifier checkpoint exists", { ...evidence, classifierCheckpointPresent: true }],
  ["unsettled upstream usage", { ...evidence, unresolvedProviderUsage: true }],
  ["active owner", { ...evidence, activeOwner: true }],
  ["terminal editorial rejection", { ...evidence, terminalEditorialRejection: true }],
  ["finalized historical row", { ...evidence, attempt: { ...evidence.attempt, completedAt: "2026-10-07T19:32:06.285Z", finalState: "TECHNICAL_FAILURE" } }],
];
for (const [label, changedEvidence] of negativeCases) {
  const rejected = assessCapacityResume(snapshot, changedEvidence);
  assert.equal(rejected.valid, false, label);
  assert.ok(rejected.reasons.length > 0, label);
}

const fixture = createOfflineStages();
for (const stage of ["classifier", "ranker", "critic"]) {
  const original = fixture.stages[stage];
  fixture.stages[stage] = async (...args) => {
    const outcome = await original(...args);
    return { ...outcome, providerRequestsUsed: 0, attempts: 0, retries: 0, telemetry: undefined };
  };
}
const attempts = new InMemoryPipelineEventAttemptRegistry([attempt]);
const orchestrator = new PipelineOrchestrator({
  stages: fixture.stages,
  quota: createStaticPipelineQuota(3),
  attemptRegistry: attempts,
  humanReviewGateway: atomicHumanReviewGateway(attempts),
  now: () => new Date("2026-10-07T20:00:00.000Z"),
  runId: pipelineRunId,
  config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
});
const resumed = await orchestrator.resumeCapacityDeferred({ snapshot, evidence, ownerId: "synthetic-owner" });
assert.equal(resumed.finalState, "WAITING_FOR_HUMAN_REVIEW");
assert.deepEqual(fixture.calls, ["classifier", "geo", "ranker", "critic"]);
assert.equal(fixture.calls.includes("verifier"), false);
assert.equal(fixture.calls.includes("translator"), false);
assert.equal(fixture.calls.includes("editor"), false);
assert.equal(fixture.calls.includes("discovery"), false);
assert.equal(fixture.calls.includes("publisher"), false);
assert.equal(resumed.requestsUsed, 0);
assert.equal(resumed.checkpoints.verifier.path, snapshot.checkpoints.verifier.path);
assert.equal(resumed.checkpoints.translator.path, snapshot.checkpoints.translator.path);
assert.equal(resumed.checkpoints.editor.path, snapshot.checkpoints.editor.path);
assert.equal(attempts.snapshot().length, 1);
assert.equal(attempts.snapshot()[0].id, attemptId);
assert.equal(attempts.snapshot()[0].finalState, "WAITING_FOR_HUMAN_REVIEW");
assert.equal(attempts.snapshot()[0].attemptNumber, 1);
assert.equal(fixture.calls.filter((stage) => stage === "classifier").length, 1);
const secondResumeAssessment = assessCapacityResume(snapshot, {
  ...evidence,
  attempt: {
    ...evidence.attempt,
    completedAt: attempts.snapshot()[0].completedAt,
    finalState: attempts.snapshot()[0].finalState,
  },
});
assert.equal(secondResumeAssessment.valid, false);
assert.ok(!secondResumeAssessment.valid && secondResumeAssessment.reasons.includes("ATTEMPT_NOT_RESUMABLE_DEFERRED"));

console.log("provider capacity resume 12F.2a: PASS (same attempt, first stage Classifier, zero duplicate calls/attempts, fail-closed lineage/accounting guards, synthetic human-review stop, no Publisher)");
