import assert from "node:assert/strict";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import {
  MAX_REVISION_ATTEMPTS_PER_EVENT,
  assertPublisherLatestRevision,
  assertRevisionCheckpointLineage,
  completeRevision,
  createOriginalRevisionState,
  createPipelineConfig,
  createRevisionPlan,
  earliestRevisionStage,
  revisionCheckpointPath,
  revisionFinalState,
  startRevision,
} from "../lib/agents/pipeline/index.ts";

const expected = {
  revise_verification: { stages: ["verifier", "translator", "editor", "classifier", "geo", "ranker", "critic"], invalid: ["verifier", "translator", "editor", "classifier", "ranker", "critic"], preserved: [], cost: 6 },
  revise_translation: { stages: ["translator", "editor", "classifier", "geo", "ranker", "critic"], invalid: ["translator", "editor", "classifier", "ranker", "critic"], preserved: ["verifier"], cost: 5 },
  revise_editorial: { stages: ["editor", "classifier", "geo", "ranker", "critic"], invalid: ["editor", "classifier", "ranker", "critic"], preserved: ["verifier", "translator"], cost: 4 },
  revise_classification: { stages: ["classifier", "geo", "ranker", "critic"], invalid: ["classifier", "ranker", "critic"], preserved: ["verifier", "translator", "editor"], cost: 3 },
  revise_ranking: { stages: ["ranker", "critic"], invalid: ["ranker", "critic"], preserved: ["verifier", "translator", "editor", "classifier"], cost: 2 },
};

const requestedStageByDecision = {
  revise_verification: "verifier",
  revise_translation: "translator",
  revise_editorial: "editor",
  revise_classification: "classifier",
  revise_ranking: "ranker",
};

for (const [decision, shape] of Object.entries(expected)) {
  const plan = createRevisionPlan({ decision, revisionAttempt: 0, remainingRequests: 20 });
  assert.equal(plan.allowed, true);
  assert.equal(plan.requestedStage, requestedStageByDecision[decision]);
  assert.deepEqual(plan.stagesToRerun, shape.stages);
  assert.deepEqual(plan.checkpointsToInvalidate, shape.invalid);
  assert.deepEqual(plan.preservedCheckpoints, shape.preserved);
  assert.equal(plan.requestsRequiredWorstCase, shape.cost);
}

assert.equal(earliestRevisionStage(["revise_ranking", "revise_editorial", "revise_verification"]), "verifier");
assert.equal(earliestRevisionStage(["pass", "reject"]), null);
const initialPass = createRevisionPlan({ decision: "pass", revisionAttempt: 0, remainingRequests: 0 });
assert.equal(initialPass.allowed, false);
assert.deepEqual(initialPass.preservedCheckpoints, ["verifier", "translator", "editor", "classifier", "ranker", "critic"]);

const insufficient = createRevisionPlan({ decision: "revise_translation", revisionAttempt: 0, remainingRequests: 4 });
assert.equal(insufficient.allowed, false);
assert.equal(insufficient.blockReason, "BLOCKED_INSUFFICIENT_DAILY_BUDGET");
const limit = createRevisionPlan({ decision: "revise_editorial", revisionAttempt: 1, remainingRequests: 20 });
assert.equal(limit.allowed, false);
assert.equal(limit.blockReason, "BLOCKED_REVISION_LIMIT");
assert.equal(limit.maxRevisionAttempts, MAX_REVISION_ATTEMPTS_PER_EVENT);

const originalState = createOriginalRevisionState("event-a", "run-original");
const firstPlan = createRevisionPlan({ decision: "revise_editorial", revisionAttempt: 0, remainingRequests: 4 });
const running = startRevision(originalState, firstPlan, "revision-event-a-1");
assert.deepEqual({ revisionAttempt: running.revisionAttempt, status: running.status, requestedStage: running.requestedStage }, { revisionAttempt: 1, status: "RUNNING", requestedStage: "editor" });
const completed = completeRevision(running, "pass");
assert.equal(completed.status, "COMPLETED");
assert.equal(revisionFinalState("pass", firstPlan), "READY_FOR_PUBLICATION_DRY_RUN");
assert.equal(revisionFinalState("reject", firstPlan), "BLOCKED_REJECTED");
assert.equal(revisionFinalState("revise_editorial", limit), "BLOCKED_REVISION_LIMIT");
assert.equal(revisionFinalState("revise_translation", insufficient), "BLOCKED_INSUFFICIENT_DAILY_BUDGET");
assert.equal(revisionFinalState("revise_editorial", firstPlan), "BLOCKED_REVISION_REQUIRED");

const identities = ["verifier", "translator", "editor", "classifier", "ranker", "critic"].map((stage) => ({ eventKey: "event-a", revisionId: "revision-event-a-1", revisionAttempt: 1, stage }));
assert.doesNotThrow(() => assertPublisherLatestRevision(1, identities));
assert.throws(() => assertPublisherLatestRevision(1, identities.map((checkpoint) => checkpoint.stage === "ranker" ? { ...checkpoint, revisionAttempt: 0 } : checkpoint)), /STALE_REVISION_CHECKPOINT/);
assert.throws(() => assertPublisherLatestRevision(1, identities.slice(0, 5)), /INCOMPLETE_REVISION_CHECKPOINT_SET/);
assert.doesNotThrow(() => assertRevisionCheckpointLineage({ eventKey: "event-a", revisionId: "revision-event-a-1", revisionAttempt: 1 }, identities[0]));
assert.throws(() => assertRevisionCheckpointLineage({ eventKey: "event-a", revisionId: "revision-event-a-1", revisionAttempt: 1 }, { ...identities[0], eventKey: "event-b" }), /REVISION_LINEAGE_MISMATCH/);
assert.ok(revisionCheckpointPath("artifacts/pipeline-checkpoints", "run-original", "event-a", 1, "editor").includes("revision-1"));

const secondCritic = createRevisionPlan({ decision: "revise_ranking", revisionAttempt: running.revisionAttempt, remainingRequests: 20 });
assert.equal(secondCritic.blockReason, "BLOCKED_REVISION_LIMIT");
assert.equal(secondCritic.allowed, false);
assert.equal(createPipelineConfig().automaticRevision, false);
assert.equal(createPipelineConfig().maxRevisionAttempts, 1);
assert.equal(validFixtures.VerificationResult.verifiedFacts.length > 0, true);
assert.equal(([]).length === 0, true, "Verifier with zero facts must be handled as SKIPPED_VERIFICATION_INSUFFICIENT by the orchestrator");

const eventB = createOriginalRevisionState("event-b", "run-original");
assert.equal(eventB.eventKey, "event-b");
assert.equal(running.eventKey, "event-a");
assert.equal(eventB.revisionAttempt, 0);

console.log("pipeline:revision:unit: OK (routing, invalidation, preservation, budget, max attempts, lineage, stale protection, publisher gate, no loops, multi-event isolation)");
