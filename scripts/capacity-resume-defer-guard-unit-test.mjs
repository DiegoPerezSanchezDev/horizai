import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { assertCapacityResumeDeferGuard } from "../lib/agents/pipeline/capacity-resume-defer-guard.ts";
import { capacityResumePreviousStages, capacityResumeStages } from "../lib/agents/pipeline/provider-capacity-resume.ts";

const event = structuredClone(validFixtures.ClusteredEvent);
const eventKey = event.eventKey;
const item = structuredClone(validFixtures.ExtractedItem);
const source = {
  sourceId: event.sourceItems[0].sourceId,
  sourceItemId: event.sourceItems[0].candidateId,
  rawItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceName: event.sourceItems[0].sourceName,
  sourceUrl: item.canonicalUrl,
  sourceType: "official",
  countryCode: "US",
  language: "en",
};
const identity = { attemptId: randomUUID(), pipelineRunId: randomUUID(), eventKey };
const checkpoint = (stage) => ({ stage, eventKey, path: `memory://${stage}/${eventKey}`, written: true, readable: true, valid: true, sha256: "a".repeat(64) });
const telemetry = (stage) => ({ status: "SUCCESS", provider: "groq", providerUnit: "tokens", providerUnitUsageKnown: true, providerRequestDispatched: true, providerRequestsUsed: 1, attempts: 1, retries: 0, inputTokens: 20, outputTokens: 10, totalTokens: 30, agentVersion: `${stage}-v1`, model: "fixture", latencyMs: 1, startedAt: "2026-10-21T00:00:00.000Z", finishedAt: "2026-10-21T00:00:00.001Z" });

function snapshotFor(resumeStage) {
  const stages = capacityResumePreviousStages[resumeStage];
  const snapshot = {
    schemaVersion: 1,
    kind: "SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME",
    ...identity,
    resumeStage,
    attemptStartedAt: "2026-10-21T00:00:00.000Z",
    event,
    items: [item],
    sources: [source],
    checkpoints: Object.fromEntries(stages.map((stage) => [stage, checkpoint(stage)])),
    checkpointSha256: Object.fromEntries(stages.map((stage) => [stage, "a".repeat(64)])),
    providerAccounting: Object.fromEntries(stages.map((stage) => [stage, telemetry(stage)])),
    nextStageDispatchCount: 0,
    nextStageCheckpointPresent: false,
    resumeGeneration: 1,
  };
  if (resumeStage === "classifier") {
    snapshot.classifierDispatchCount = 0;
    snapshot.classifierCheckpointPresent = false;
  }
  if (resumeStage !== "verifier") snapshot.verification = structuredClone(validFixtures.VerificationResult);
  if (!["verifier", "translator"].includes(resumeStage)) snapshot.translation = structuredClone(validFixtures.TranslationResult);
  if (!["verifier", "translator", "editor"].includes(resumeStage)) snapshot.editorial = structuredClone(validFixtures.EditorialDraft);
  if (["ranker", "critic"].includes(resumeStage)) {
    snapshot.classification = structuredClone(validFixtures.ClassificationResult);
    snapshot.geo = { eventKey, primaryRegionCode: null, countryCodes: ["US"], latitude: null, longitude: null, resolutionLevel: "country", resolvedFrom: "country_registry", provenance: "classifier" };
  }
  if (resumeStage === "critic") snapshot.ranking = structuredClone(validFixtures.RankingResult);
  if (resumeStage === "verifier") {
    delete snapshot.providerAccounting.verifier;
    delete snapshot.checkpointSha256.verifier;
  }
  return snapshot;
}

function input(resumeStage, claimedStage = resumeStage) {
  return { ...identity, claimedStage, resumeStage, snapshot: snapshotFor(resumeStage), previousGeneration: 0, providerRequestDispatched: false, providerRequestsUsed: 0, countsTowardRetryLimit: false };
}

for (const stage of capacityResumeStages) {
  const claimStage = stage === "critic" ? "ranker" : stage;
  assert.doesNotThrow(() => assertCapacityResumeDeferGuard(input(stage, claimStage)), `${stage} defer accepted`);
}
assert.doesNotThrow(() => assertCapacityResumeDeferGuard(input("critic", "ranker")), "forward defer from Ranker to Critic accepted");
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("editor"), resumeStage: "geo" }), /CAPACITY_DEFER_STAGE_UNSUPPORTED/);
assert.throws(() => assertCapacityResumeDeferGuard(input("editor", "ranker")), /CAPACITY_DEFER_STAGE_REGRESSION/);
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("ranker"), snapshot: snapshotFor("critic") }), /CAPACITY_DEFER_SNAPSHOT_LINEAGE_OR_STAGE_MISMATCH/);
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("ranker"), snapshot: { ...snapshotFor("ranker"), attemptId: randomUUID() } }), /CAPACITY_DEFER_SNAPSHOT_LINEAGE_OR_STAGE_MISMATCH/);
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("critic"), providerRequestDispatched: true, providerRequestsUsed: 1 }), /CAPACITY_DEFER_PENDING_STAGE_ALREADY_DISPATCHED/);
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("critic"), providerRequestDispatched: false, providerRequestsUsed: 1 }), /CAPACITY_DEFER_PENDING_STAGE_ALREADY_DISPATCHED/);
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("ranker"), snapshot: { ...snapshotFor("ranker"), resumeGeneration: 3 } }), /CAPACITY_DEFER_GENERATION_INVALID/);
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("ranker"), previousGeneration: 1000 }), /CAPACITY_DEFER_GENERATION_INVALID/);
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("ranker"), countsTowardRetryLimit: true }), /CAPACITY_DEFER_COUNTS_TOWARD_RETRY_LIMIT/);
const brokenCheckpoints = snapshotFor("critic"); delete brokenCheckpoints.checkpoints.ranker; delete brokenCheckpoints.checkpointSha256.ranker; delete brokenCheckpoints.providerAccounting.ranker;
assert.throws(() => assertCapacityResumeDeferGuard({ ...input("critic"), snapshot: brokenCheckpoints }), /CAPACITY_RESUME_SNAPSHOT_CONTRACT_INVALID/);

console.log(JSON.stringify({ supportedStages: capacityResumeStages, editorDefer: "PASS", rankerDefer: "PASS", criticDefer: "PASS", allSupportedProviderStages: "PASS", unknownStage: "REJECT", completedStageRegression: "REJECT", mismatchedSnapshotStage: "REJECT", alreadyDispatched: "REJECTED_BY_PRE_DISPATCH_CONTRACT", invalidGeneration: "REJECT", sameAttemptLineage: "PASS" }));
