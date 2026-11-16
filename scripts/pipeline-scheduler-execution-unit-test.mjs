import assert from "node:assert/strict";
import { executeScheduledPipeline, runSchedulerExecution } from "../lib/agents/pipeline/index.ts";
import { defaultOfflineCapacityConfig, getFreeProviderCapacitySnapshot } from "../lib/agents/runtime/free-provider-router.ts";

const now = new Date("2026-09-21T10:00:00.000Z");
const quota = { dailyLimit: 20, admissionLimit: 16, used: 0, remaining: 16 };
const dateUtc = now.toISOString().slice(0, 10);
const emptyUsage = (provider) => ({ provider, dateUtc, requestsReserved: 0, requestsDispatched: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenUsageKnown: false, unknownTokenRequests: 0, neuronsUsed: 0, neuronUsageKnown: true });
const providerCapacity = getFreeProviderCapacitySnapshot({
  configs: { groq: defaultOfflineCapacityConfig("groq", "openai/gpt-oss-20b", 20, null), cloudflare_workers_ai: defaultOfflineCapacityConfig("cloudflare_workers_ai", "@cf/openai/gpt-oss-20b", null, 10_000) },
  usage: { groq: emptyUsage("groq"), cloudflare_workers_ai: emptyUsage("cloudflare_workers_ai") },
  blocks: { groq: null, cloudflare_workers_ai: null }, now, estimatedEventRequests: 6, estimatedEventTokens: 1_000, estimatedEventNeurons: 2_381,
});

function fakeRepository(mode = "acquired") {
  const calls = { acquire: 0, finish: 0, finishExecution: 0, release: 0, releasedOwner: null };
  return {
    calls,
    async acquire() { calls.acquire += 1; return { status: mode, runId: "33333333-3333-4333-8333-333333333333", ownerRunId: "44444444-4444-4444-8444-444444444444", triggerId: "test:bridge", expiresAt: "2026-09-21T11:00:00.000Z" }; },
    async finish() { calls.finish += 1; return true; },
    async finishExecution() { calls.finishExecution += 1; return true; },
    async release(input) { calls.release += 1; calls.releasedOwner = input.ownerRunId; return input.ownerRunId !== "wrong-owner"; },
  };
}

function pipelineFixture(finalState, stopReason = null, requestsUsed = 6, failure) {
  return {
    preflight: async () => ({ quotaRemaining: 20 }),
    orchestrator: { run: async () => ({ runId: "55555555-5555-4555-8555-555555555555", startedAt: now.toISOString(), completedAt: now.toISOString(), finalState: finalState === "FAILED" ? "FAILED" : "SUCCESS", candidatesDiscovered: 1, extractedItems: 1, clusteredEvents: 1, eventsAttempted: 1, eventsPublished: 0, eventsDryRunReady: finalState === "READY_FOR_PUBLICATION_DRY_RUN" ? 1 : 0, eventsSkipped: finalState === "SKIPPED" ? 1 : 0, eventsFailed: finalState === "FAILED" ? 1 : 0, eventsBlocked: finalState.startsWith("BLOCKED") ? 1 : 0, providerRequestsUsed: requestsUsed, stageStats: {}, quotaBefore: 20, quotaAfter: 20, eventResults: [{ eventKey: "event-bridge", finalState, stopStage: finalState === "FAILED" ? "verifier" : null, stopReason, criticDecision: null, publicationOutcome: null, requestsUsed, checkpoints: {}, telemetry: {}, ...(failure ? { failure } : {}) }] }) },
  };
}

async function run(finalState, stopReason, expected) {
  const repository = fakeRepository();
  let factoryOptions;
  const result = await executeScheduledPipeline({ mode: "execute", authorized: true, testNamespace: "test:bridge", triggerId: `test:bridge:${finalState}`, now, hours: 48, repository, readQuota: async () => quota, readCapacity: async () => providerCapacity, pipelineFactory: (options) => { factoryOptions = options; return pipelineFixture(finalState, stopReason, finalState === "SKIPPED" ? 1 : 6, finalState === "FAILED" ? { errorCode: stopReason, httpStatus: stopReason === "FREE_TIER_LIMIT_REACHED" ? 429 : null, providerRequestDispatched: true, attempts: 1, retries: 0, latencyMs: 1, invalidPaths: [], errorMessage: "sanitized" } : undefined); } });
  assert.equal(result.finalEventState, finalState);
  assert.equal(result.schedulerDecision, expected);
  assert.equal(result.pipelineInvoked, true);
  assert.equal(result.leaseReleased, true);
  assert.equal(repository.calls.finishExecution, 1);
  assert.equal(repository.calls.release, 1);
  assert.deepEqual(factoryOptions.config, { hours: 48, limit: 1, dryRun: true, publish: false, trigger: "scheduled", automaticRevision: false, maxRevisionAttempts: 1 });
  assert.equal(result.providerCapacityBefore.groq.dimensions.requests.hardLimit, 20);
  assert.equal(result.providerCapacityBefore.groq.dimensions.requests.softLimit, 17);
  assert.equal(result.providerCapacityBefore.cloudflare_workers_ai.dimensions.neurons.hardLimit, 10_000);
  assert.equal(result.providerCapacityAfter, providerCapacity);
  return result;
}

const happy = await run("READY_FOR_PUBLICATION_DRY_RUN", null, "COMPLETED");
assert.equal(happy.completed, 1);
assert.equal(happy.requestsUsed, 6);
assert.equal(happy.quotaBefore.provider, "groq");
assert.equal(happy.quotaAfter.provider, "groq");
const skipped = await run("SKIPPED", "SKIPPED_VERIFICATION_INSUFFICIENT", "COMPLETED");
assert.equal(skipped.skipped, 1);
const revision = await run("BLOCKED_REVISION_REQUIRED", "BLOCKED_REVISION_REQUIRED", "BLOCKED_REVISION_REQUIRED");
assert.equal(revision.blocked, 1);
const rejected = await run("BLOCKED_REJECTED", "BLOCKED_REJECTED", "BLOCKED_REJECTED");
assert.equal(rejected.blocked, 1);
const failed = await run("FAILED", "PIPELINE_STAGE_FAILED", "FAILED");
assert.equal(failed.failed, 1);
const rateLimited = await run("FAILED", "FREE_TIER_LIMIT_REACHED", "BLOCKED_PROVIDER_RATE_LIMIT");
assert.equal(rateLimited.stopReason, "BLOCKED_PROVIDER_RATE_LIMIT");

const releaseFailureRepository = fakeRepository();
const originalRelease = releaseFailureRepository.release.bind(releaseFailureRepository);
let releaseFailureCalls = 0;
releaseFailureRepository.release = async (input) => {
  releaseFailureCalls += 1;
  if (releaseFailureCalls === 1) throw new Error("synthetic release failure after terminal update");
  return originalRelease(input);
};
await assert.rejects(() => executeScheduledPipeline({
  mode: "execute", authorized: true, testNamespace: "test:bridge", triggerId: "test:bridge:release-after-finalize", now,
  repository: releaseFailureRepository, readQuota: async () => quota, readCapacity: async () => providerCapacity,
  pipelineFactory: () => pipelineFixture("READY_FOR_PUBLICATION_DRY_RUN"),
}), /synthetic release failure after terminal update/);
assert.equal(releaseFailureRepository.calls.finishExecution, 1);
assert.equal(releaseFailureRepository.calls.finish, 0, "a post-finalization error cannot overwrite the terminal row through legacy finish");

const preflightRepository = fakeRepository();
const preflight = await runSchedulerExecution({ mode: "preflight", authorized: true, testNamespace: "test:bridge-preflight", triggerId: "test:bridge-preflight:one", now, repository: preflightRepository, readQuota: async () => quota, readCapacity: async () => providerCapacity, pipelineFactory: () => { throw new Error("preflight must not construct pipeline"); } });
assert.equal(preflight.pipelineInvoked, false);
assert.equal(preflight.schedulerDecision, "PREFLIGHT");
assert.equal(preflight.leaseReleased, true);
assert.equal(preflightRepository.calls.finishExecution, 0);

for (const mode of ["busy", "duplicate"]) {
  const repository = fakeRepository(mode);
  const result = await executeScheduledPipeline({ mode: "execute", authorized: true, testNamespace: "test:bridge", triggerId: `test:bridge:${mode}`, now, repository, readQuota: async () => quota, pipelineFactory: () => { throw new Error("pipeline must not be constructed"); } });
  assert.equal(result.pipelineInvoked, false);
  assert.equal(result.leaseReleased, false);
  assert.equal(repository.calls.finishExecution, 0);
  assert.equal(repository.calls.release, 0);
  assert.equal(result.stopReason, mode === "busy" ? "BLOCKED_RUN_ALREADY_ACTIVE" : "BLOCKED_DUPLICATE_TRIGGER");
}

const insufficientRepository = fakeRepository();
const insufficient = await executeScheduledPipeline({ mode: "execute", authorized: true, testNamespace: "test:bridge", triggerId: "test:bridge:insufficient", now, repository: insufficientRepository, readQuota: async () => ({ dailyLimit: 20, admissionLimit: 16, used: 15, remaining: 1 }), readCapacity: async () => providerCapacity, pipelineFactory: () => { throw new Error("pipeline must not be constructed"); } });
assert.equal(insufficient.pipelineInvoked, false);
assert.equal(insufficient.stopReason, "BLOCKED_INSUFFICIENT_DAILY_BUDGET");
assert.equal(insufficientRepository.calls.release, 1);

await assert.rejects(() => executeScheduledPipeline({ mode: "execute", authorized: false, testNamespace: "test:bridge", now, repository: fakeRepository(), readQuota: async () => quota }), /SCHEDULER_EXECUTION_NOT_AUTHORIZED/);
await assert.rejects(() => executeScheduledPipeline({ mode: "execute", authorized: true, testNamespace: "production:unsafe", now, repository: fakeRepository(), readQuota: async () => quota }), /SCHEDULER_EXECUTION_REQUIRES_TEST_NAMESPACE/);
await assert.rejects(() => executeScheduledPipeline({ mode: "execute", authorized: true, testNamespace: "test:bridge", now, repository: fakeRepository(), readQuota: async () => quota, pipelineFactory: () => { throw new Error("local failure"); } }), /local failure/);

console.log("pipeline:scheduler:execution:unit: OK (explicit mode, policy gates, one-event override, composition bridge, mapping, fail-closed, 429 stop, lease finally, duplicate/active/budget blocks, publish false, automatic revision false)");
