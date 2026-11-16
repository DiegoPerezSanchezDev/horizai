import assert from "node:assert/strict";
import { atomicHumanReviewGateway } from "./fixtures/atomic-human-review-gateway.mjs";
import { readFileSync } from "node:fs";
import { identity, rowHash, validatePreClaim, validateM34Create, cumulativeAccounting } from "./supervised-cycle-12f12h-critic-human-review.mjs";
import { createCapacityResumeRequestBudget } from "../lib/agents/pipeline/supervised-request-cap-contract.ts";
import { readCapacityResumeSnapshot } from "../lib/agents/pipeline/provider-capacity-resume.ts";
import { PipelineOrchestrator } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import { InMemoryPipelineEventAttemptRegistry } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { createStaticPipelineQuota } from "../lib/agents/pipeline/pipeline-budget.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";

const originalFetch = globalThis.fetch;
let remoteRequests = 0;
globalThis.fetch = async () => { remoteRequests += 1; throw new Error("OFFLINE_H_GATE_NETWORK_FORBIDDEN"); };
try {
  const { snapshot } = await readCapacityResumeSnapshot(`artifacts/pipeline-checkpoints/${identity.pipelineRunId}/capacity-resume-${identity.eventKey}-critic-g1.json`);
  const target = { id: identity.attemptId, event_key: identity.eventKey, pipeline_run_id: identity.pipelineRunId, completed_at: null, final_state: null, stop_stage: "critic", stop_reason: "PROVIDER_CAPACITY_EXHAUSTED", counts_toward_retry_limit: false, capacity_resume_snapshot: snapshot };
  const hashes = snapshot.checkpointSha256;
  const previous = { preflightEvidence: { rowHashes: { attempts: { [identity.attemptId]: rowHash(target) } }, checkpoints: { hashes } } };
  validatePreClaim(target, snapshot, previous, hashes, true);
  for (const changed of [{ ...target, counts_toward_retry_limit: true }, { ...target, final_state: "WAITING_FOR_HUMAN_REVIEW" }, { ...target, pipeline_run_id: "different-run" }]) {
    assert.throws(() => validatePreClaim(changed, snapshot, previous, hashes, true), /PRECLAIM_ATTEMPT_CHANGED/);
  }
  assert.throws(() => validatePreClaim(target, snapshot, previous, hashes, false), /CRITIC_CHECKPOINT_PRESENT/);
  assert.throws(() => validatePreClaim(target, snapshot, previous, { ...hashes, ranker: "f".repeat(64) }, true), /CHECKPOINT_CHANGED/);
  assert.throws(() => validatePreClaim(target, { ...snapshot, resumeGeneration: 2 }, previous, hashes, true), /SNAPSHOT_CHANGED/);
  assert.deepEqual(createCapacityResumeRequestBudget(snapshot).executionSnapshot(), { cap: 18, requests: 5, remaining: 13 });
  // Execute generation 1 through the real orchestrator, entirely in memory.
  for (const decision of ["pass", "revise_editorial"]) {
    const fixture = createOfflineStages({ critic: decision === "pass" ? "pass" : "revise" });
    const attempt = { id: identity.attemptId, eventKey: identity.eventKey, pipelineRunId: identity.pipelineRunId, attemptNumber: 1,
      startedAt: snapshot.attemptStartedAt, completedAt: null, finalState: null, stopStage: "critic", stopReason: "PROVIDER_CAPACITY_EXHAUSTED",
      retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null, capacityResumeSnapshot: snapshot };
    const registry = new InMemoryPipelineEventAttemptRegistry([attempt]);
    let reviews = 0;
    const orchestrator = new PipelineOrchestrator({ stages: fixture.stages, quota: createStaticPipelineQuota(13), attemptRegistry: registry,
      humanReviewGateway: atomicHumanReviewGateway(registry, (input) => { assert.equal(input.checkpoints.critic.valid, true); reviews += 1; }),
      runId: identity.pipelineRunId, config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
    });
    const evidence = { attempt: { attemptId: identity.attemptId, eventKey: identity.eventKey, pipelineRunId: identity.pipelineRunId, startedAt: attempt.startedAt,
      completedAt: null, finalState: null, stopStage: "critic", stopReason: "PROVIDER_CAPACITY_EXHAUSTED", countsTowardRetryLimit: false },
      currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items, currentCheckpointSha256: hashes,
      nextStageDispatchCount: 0, nextStageCheckpointPresent: false, unresolvedProviderUsage: false, activeOwner: false, terminalEditorialRejection: false };
    const result = await orchestrator.resumeCapacityDeferred({ snapshot, evidence, ownerId: "synthetic-h-owner" });
    assert.equal(result.finalState, decision === "pass" ? "WAITING_FOR_HUMAN_REVIEW" : "BLOCKED_REVISION_REQUIRED");
    assert.deepEqual(fixture.calls, ["critic"]); assert.equal(reviews, decision === "pass" ? 1 : 0);
    assert.equal(registry.snapshot().length, 1); assert.equal(registry.snapshot()[0].id, identity.attemptId);
    await assert.rejects(() => orchestrator.resumeCapacityDeferred({ snapshot, evidence, ownerId: "synthetic-second-owner" }));
  }
  const hash = "a".repeat(64);
  const body = { p_attempt_id: identity.attemptId, p_event_key: identity.eventKey, p_pipeline_run_id: identity.pipelineRunId, p_review_manifest: { checkpoints: { critic: { identity: `${identity.pipelineRunId}:${identity.attemptId}:critic:${identity.eventKey}`, sha256: hash } } } };
  const durable = { attemptId: identity.attemptId, eventKey: identity.eventKey, critic: { decision: "pass" } };
  validateM34Create(body, durable, hash);
  assert.deepEqual(cumulativeAccounting({ newDispatches: 1, settled: true, newInputTokens: 20, newOutputTokens: 4, newTotalTokens: 24 }), { requests: 6, inputTokens: 6768, outputTokens: 1621, totalTokens: 8389, actualTokensKnown: true });
  assert.deepEqual(cumulativeAccounting({ newDispatches: 1, settled: false, newInputTokens: 0, newOutputTokens: 0, newTotalTokens: 0 }), { requests: 6, inputTokens: null, outputTokens: null, totalTokens: null, actualTokensKnown: false });
  assert.throws(() => validateM34Create({ ...body, p_attempt_id: "other-attempt" }, durable, hash), /LINEAGE_MISMATCH/);
  assert.throws(() => validateM34Create(body, { ...durable, attemptId: "other-attempt" }, hash), /DURABLE_PASS_REQUIRED/);
  assert.throws(() => validateM34Create(body, { ...durable, critic: { decision: "revise_editorial" } }, hash), /DURABLE_PASS_REQUIRED/);
  assert.throws(() => validateM34Create(body, durable, "b".repeat(64)), /CHECKPOINT_PROOF_MISMATCH/);
  const source = readFileSync(new URL("./supervised-cycle-12f12h-critic-human-review.mjs", import.meta.url), "utf8");
  assert.equal((source.match(/\.resumeCapacityDeferred\(/g) ?? []).length, 1);
  assert.equal(source.includes("pipeline.preflight("), false, "the diagnostic preflight must not repeat");
  assert.equal(source.includes(".orchestrator.run("), false, "no daily scheduler/candidate run");
  assert.match(source, /SECOND_PROVIDER_CALL_FORBIDDEN/); assert.match(source, /SECOND_REVIEW_FORBIDDEN/); assert.match(source, /SECOND_CLAIM_FORBIDDEN/);
  assert.match(source, /INCIDENT_DUPLICATE_STAGE_DISPATCH/); assert.match(source, /validateM34Create\(body, durable, hash\)/);
  assert.ok(source.indexOf("validateM34Create(body, durable, hash)") < source.indexOf("await originalFetch(request)"));
  const factory = readFileSync(new URL("./capacity-resume-production-pipeline.ts", import.meta.url), "utf8");
  assert.match(factory, /publicationPayloadFactory: buildPipelinePublicationPayload/);
  assert.match(factory, /mode: "supervised"/); assert.match(factory, /publish: false/); assert.match(factory, /automaticRevision: false/);
  assert.equal(remoteRequests, 0);
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify({ status: "PASS", generation1CriticOnly: "PASS", preClaimMismatchStopsBeforeMutation: "PASS", budget: "5/18/13", durableM34BeforeReview: "PASS", canonicalMaterializerWired: "PASS", singleResumeClaimProviderAndReview: "PASS", newDiagnosticPreflights: 0, remoteRequests: 0, providerCalls: 0 }));
