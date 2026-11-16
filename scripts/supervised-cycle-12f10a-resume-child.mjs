import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentError } from "../lib/agents/runtime/agent-errors.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, createStaticPipelineQuota, writeCapacityResumeSnapshot } from "../lib/agents/pipeline/index.ts";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const fixture = createOfflineStages();
fixture.stages.editor = async () => {
  fixture.calls.push("editor");
  throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "synthetic pre-dispatch capacity stop", undefined, {
    providerRequestDispatched: false,
    failureKind: "PROVIDER_CAPACITY_EXHAUSTED",
  });
};
const registry = new InMemoryPipelineEventAttemptRegistry([input.attempt]);
const orchestrator = new PipelineOrchestrator({
  stages: fixture.stages,
  quota: createStaticPipelineQuota(20),
  attemptRegistry: registry,
  humanReviewGateway: { async createReview() { throw new Error("SYNTHETIC_TEST_MUST_NOT_CREATE_REVIEW"); } },
  runId: input.attempt.pipelineRunId,
  now: () => new Date(input.startedAt),
  config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
  capacityResumeSnapshotWriter: async (snapshot) => writeCapacityResumeSnapshot(
    snapshot,
    join(input.snapshotRoot, `${snapshot.eventKey}-${snapshot.resumeStage}-g${snapshot.resumeGeneration}.json`),
  ),
});
const result = await orchestrator.resumeCapacityDeferred({ snapshot: input.snapshot, evidence: input.evidence, ownerId: input.ownerId });
const updatedAttempt = registry.snapshot()[0];
assert.ok(updatedAttempt);
assert.equal(updatedAttempt.id, input.attempt.id);
assert.equal(updatedAttempt.attemptNumber, 1);
assert.equal(result.finalState, "DEFERRED_PROVIDER_CAPACITY");
assert.equal(result.requestsUsed, 0);
assert.deepEqual(fixture.calls, ["editor"]);
assert.equal(fixture.calls.includes("verifier"), false);
assert.equal(fixture.calls.includes("translator"), false);
assert.equal(fixture.calls.includes("publisher"), false);
process.stdout.write(JSON.stringify({
  finalState: result.finalState,
  requestsUsed: result.requestsUsed,
  firstStage: input.snapshot.resumeStage,
  calls: fixture.calls,
  attempt: updatedAttempt,
}));
