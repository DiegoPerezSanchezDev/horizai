import { readFile } from "node:fs/promises";
import { atomicHumanReviewGateway } from "./fixtures/atomic-human-review-gateway.mjs";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, createStaticPipelineQuota } from "../lib/agents/pipeline/index.ts";

const handoff = JSON.parse(await readFile(process.argv[2], "utf8"));
const { snapshot, evidence, attempt } = handoff;
const freshRegistry = new InMemoryPipelineEventAttemptRegistry([attempt]);
const freshFixture = createOfflineStages();
for (const stage of ["verifier", "translator", "editor", "classifier", "ranker", "critic"]) {
  const original = freshFixture.stages[stage];
  freshFixture.stages[stage] = async (...args) => {
    const outcome = await original(...args);
    return { ...outcome, providerRequestsUsed: 0, attempts: 0, retries: 0, telemetry: undefined };
  };
}
const reviewIds = [];
const resumed = new PipelineOrchestrator({
  stages: freshFixture.stages,
  quota: createStaticPipelineQuota(100),
  attemptRegistry: freshRegistry,
  humanReviewGateway: atomicHumanReviewGateway(freshRegistry, ({ attemptId }) => reviewIds.push(attemptId)),
  capacityResumeSnapshotWriter: async () => ({ path: "memory://m35-resume-child" }),
  runId: "synthetic-m35-fresh-process",
  config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
});
const result = await resumed.resumeCapacityDeferred({ snapshot, evidence, ownerId: "synthetic-m35-owner" });
const storedAttempt = freshRegistry.snapshot()[0];
process.stdout.write(JSON.stringify({
  finalState: result.finalState,
  stages: freshFixture.calls,
  providerRequestsUsed: result.requestsUsed,
  attemptCount: freshRegistry.snapshot().length,
  attemptId: storedAttempt.id,
  attemptFinalState: storedAttempt.finalState,
  reviewCount: reviewIds.length,
  rawItemCount: snapshot.sources.filter((source) => source.rawItemId).length,
}));
