import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { atomicHumanReviewGateway } from "./fixtures/atomic-human-review-gateway.mjs";
import { identity, validateExistingReview, readOnlyValidation } from "./supervised-cycle-12f12i-review-handoff.mjs";
import { parseHumanReviewOperatorInspection } from "../lib/agents/publisher/human-review-read-repository.ts";
import { humanReviewSourceLineageSha256 } from "../lib/agents/publisher/human-review-source-lineage-hash.ts";
import { readCapacityResumeSnapshot } from "../lib/agents/pipeline/provider-capacity-resume.ts";
import { PipelineOrchestrator } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import { InMemoryPipelineEventAttemptRegistry } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { createStaticPipelineQuota } from "../lib/agents/pipeline/pipeline-budget.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { migration37Filename } from "./supabase-direct-migration-command.mjs";
import { assertOnlyM37DryRun } from "./migration37-validation-runner.mjs";

let remoteRequests = 0; const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { remoteRequests++; throw new Error("OFFLINE_TEST_NETWORK_FORBIDDEN"); };
try {
  const historical = readFileSync("supabase/migrations/20261007215233_human_review_operator_read_rpc.sql", "utf8").replaceAll("\r", "");
  const migration = readFileSync(`supabase/migrations/${migration37Filename}`, "utf8").replaceAll("\r", "");
  const functionSql = (source) => source.match(/create(?: or replace)? function public\.get_pipeline_human_review_operator_inspect[\s\S]*?\$function\$;/i)?.[0];
  assert.equal(functionSql(migration), functionSql(historical).replace("create function", "create or replace function").replace("    'draft_sha256', r.draft_sha256,", "    'draft_sha256', r.draft_sha256,\n    'source_lineage_sha256', r.source_lineage_sha256,"));
  assert.equal((migration.match(/create or replace function/gi) ?? []).length, 1);
  assert.doesNotMatch(migration, /\b(?:alter table|grant select|insert into|update public|delete from)\b/i);
  assert.match(migration, /revoke all on function[^;]+from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[^;]+to service_role/);
  assert.deepEqual(assertOnlyM37DryRun(`pending ${migration37Filename}`), [migration37Filename]);
  assert.throws(() => assertOnlyM37DryRun(`pending ${migration37Filename} 20261021120000_other.sql`));
  const oldResponse = JSON.parse(readFileSync("artifacts/supervised-cycle-12f12h-inspect-response.json", "utf8"));
  assert.throws(() => parseHumanReviewOperatorInspection(oldResponse), /INSPECT_INVALID/);
  const artifact = JSON.parse(readFileSync(`artifacts/human-review-packages/${identity.attemptId}.json`, "utf8"));
  const hash = humanReviewSourceLineageSha256(artifact.sourceLineage);
  assert.equal(hash, oldResponse.review.review_manifest.sourceLineageSha256, "must match the digest actually stored by PostgreSQL M31");
  assert.equal(humanReviewSourceLineageSha256(artifact.sourceLineage.map((e) => Object.fromEntries(Object.entries(e).reverse()))), hash, "JSONB key insertion order must not affect digest");
  assert.notEqual(humanReviewSourceLineageSha256([{ ...artifact.sourceLineage[0], source_url: "https://example.test/changed" }]), hash);
  const corrected = { ...oldResponse, review: { ...oldResponse.review, source_lineage_sha256: hash } };
  const parsed = parseHumanReviewOperatorInspection(corrected); assert.equal(parsed.review.consumed_at, null); assert.equal(parsed.review.status, "WAITING_FOR_HUMAN_REVIEW");
  await validateExistingReview(parsed.review, artifact);
  for (const field of ["attempt_id", "pipeline_run_id"]) {
    assert.throws(() => parseHumanReviewOperatorInspection({ ...corrected, review: { ...corrected.review, [field]: "11111111-1111-4111-8111-111111111111" } }), /INSPECT_INVALID/);
    const consistentlyWrong = structuredClone(corrected.review);
    consistentlyWrong[field] = "11111111-1111-4111-8111-111111111111";
    consistentlyWrong.review_manifest[field === "attempt_id" ? "attemptId" : "pipelineRunId"] = consistentlyWrong[field];
    await assert.rejects(() => validateExistingReview(consistentlyWrong, artifact), /IDENTITY_OR_STATE_CHANGED/);
  }
  for (const mutate of [
    (r) => { r.review_manifest.checkpoints.critic.sha256 = "a".repeat(64); },
    (r) => { r.review_manifest.checkpoints.critic.identity = "wrong-attempt:critic"; },
    (r) => { r.source_lineage[0].content_hash = "changed-hash"; },
    (r) => { r.source_lineage_sha256 = "a".repeat(64); },
  ]) { const changed = structuredClone(parsed.review); mutate(changed); await assert.rejects(() => validateExistingReview(changed, artifact)); }
  assert.match(readOnlyValidation.toString(), /READ_ONLY_OPERATION_REQUIRED/);
  assert.doesNotMatch(readOnlyValidation.toString(), /\.resumeCapacityDeferred\(|\.finalize\(|\.createReview\(/);

  const { snapshot } = await readCapacityResumeSnapshot(`artifacts/pipeline-checkpoints/${identity.pipelineRunId}/capacity-resume-${identity.eventKey}-critic-g1.json`);
  for (const scenario of ["success", "review-failure", "m34-failure", "unexpected-finalize-conflict", "pre-existing-terminal"]) {
    const attempt = { id: identity.attemptId, eventKey: identity.eventKey, pipelineRunId: identity.pipelineRunId, attemptNumber: 1, startedAt: snapshot.attemptStartedAt,
      completedAt: scenario === "pre-existing-terminal" ? new Date().toISOString() : null, finalState: scenario === "pre-existing-terminal" ? "FAILED" : null,
      stopStage: "critic", stopReason: "PROVIDER_CAPACITY_EXHAUSTED", retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null, capacityResumeSnapshot: snapshot };
    const registry = new InMemoryPipelineEventAttemptRegistry([attempt]); let finalizations = 0, reviews = 0, releases = 0;
    const finalize = registry.finalize.bind(registry); registry.finalize = async (input) => { finalizations++; if (scenario === "unexpected-finalize-conflict") throw new Error("EVENT_ATTEMPT_FINALIZE_FAILED:P0001"); return finalize(input); };
    const release = registry.releaseCapacityResume.bind(registry); registry.releaseCapacityResume = async (input) => { releases++; return release(input); };
    const fixture = createOfflineStages({ critic: scenario === "unexpected-finalize-conflict" ? "revise" : "pass" });
    const gateway = atomicHumanReviewGateway(registry, () => { reviews++; });
    const failingGateway = { async createReview(input) { if (scenario === "m34-failure") throw new Error("human_review_critic_proof_invalid"); if (scenario === "review-failure") throw new Error("human_review_create_failed"); return gateway.createReview(input); } };
    const orchestrator = new PipelineOrchestrator({ stages: fixture.stages, quota: createStaticPipelineQuota(13), attemptRegistry: registry, humanReviewGateway: failingGateway,
      runId: identity.pipelineRunId, config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false } });
    const evidence = { attempt: { attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, startedAt: attempt.startedAt, completedAt: null, finalState: null, stopStage: "critic", stopReason: "PROVIDER_CAPACITY_EXHAUSTED", countsTowardRetryLimit: false },
      currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items, currentCheckpointSha256: snapshot.checkpointSha256,
      nextStageDispatchCount: 0, nextStageCheckpointPresent: false, unresolvedProviderUsage: false, activeOwner: false, terminalEditorialRejection: false };
    if (scenario === "pre-existing-terminal") { await assert.rejects(() => orchestrator.resumeCapacityDeferred({ snapshot, evidence })); assert.equal(finalizations, 0); assert.equal(reviews, 0); assert.deepEqual(fixture.calls, []); continue; }
    if (scenario === "unexpected-finalize-conflict") { await assert.rejects(() => orchestrator.resumeCapacityDeferred({ snapshot, evidence }), /EVENT_ATTEMPT_FINALIZE_FAILED:P0001/); assert.equal(reviews, 0); assert.equal(finalizations, 1); assert.equal(releases, 1); assert.equal(registry.snapshot()[0].stopReason, "PROVIDER_CAPACITY_EXHAUSTED", "failed finalization releases ownership and leaves no ACTIVE attempt"); continue; }
    const result = await orchestrator.resumeCapacityDeferred({ snapshot, evidence });
    assert.equal(finalizations, 1, "one semantic owner only; successful review RPC performs the only completion");
    assert.ok(registry.snapshot()[0].completedAt); assert.notEqual(registry.snapshot()[0].finalState, null);
    if (scenario === "success") {
      assert.equal(result.finalState, "WAITING_FOR_HUMAN_REVIEW"); assert.equal(reviews, 1); assert.equal(releases, 0);
      await assert.rejects(() => gateway.createReview({ attemptId: identity.attemptId }), /human_review_attempt_not_waiting/);
      await assert.rejects(() => orchestrator.resumeCapacityDeferred({ snapshot, evidence })); assert.equal(finalizations, 1); assert.equal(reviews, 1);
    } else { assert.notEqual(result.finalState, "WAITING_FOR_HUMAN_REVIEW"); assert.equal(reviews, 0); }
    assert.deepEqual(fixture.calls, ["critic"]);
  }
  assert.equal(remoteRequests, 0);
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify({ status: "PASS", m37ExactProjectionOnly: true, storedJsonbDigest: "PASS", populatedInspect: "PASS", wrongLineageAndCriticProofRejected: true, atomicTerminalizationOnlyOnce: true, reviewAndM34FailuresFailClosed: true, duplicateAndCompletedAttemptsBlocked: true, unexpectedP0001Propagates: true, remoteRequests: 0, providerCalls: 0 }));
