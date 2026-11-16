import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createOfflineStages, offlineDiscoveryResult, offlineExtractionResult } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, createStaticPipelineQuota } from "../lib/agents/pipeline/index.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { buildPipelinePublicationPayload } from "../lib/agents/publisher/publication-payload.ts";
import { attachHumanReviewId, buildHumanReviewSnapshot, humanReviewArtifactPath, humanReviewArtifactSchema, humanReviewManifestSchema, humanReviewCheckpointStages, sha256, verifyHumanReviewArtifact, writeHumanReviewArtifact } from "../lib/agents/publisher/human-review.ts";
import { canonicalCriticInput } from "../lib/agents/critic/critic-fixtures.ts";
import { buildRankerPipelineCheckpoint } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";
import { buildCriticPipelineCheckpoint, writeCriticPipelineCheckpointAtomic } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { SupabaseHumanReviewRepository } from "../lib/agents/publisher/human-review-repository.ts";
import { Publisher } from "../lib/agents/publisher/publisher-agent.ts";
import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { VerifierAgent } from "../lib/agents/verifier/verifier-agent.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { MockModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { buildHumanReviewDecision, buildHumanReviewInspection, buildHumanReviewListEntry } from "../lib/agents/publisher/human-review-operator.ts";
import { parseHumanReviewOperatorStatus } from "../lib/agents/publisher/human-review-status.ts";
import { assertDailyHumanReviewPublicationLimit, assertHumanReviewDecisionAllowed, assertHumanReviewPublishable, assertSupervisedCandidateLimit, assertSupervisedCandidateAdmission, assertHumanReviewPublicationAuthorization } from "../lib/agents/publisher/human-review-policy.ts";

const runId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const reviewId = "55555555-5555-4555-8555-555555555555";
const eventKey = validFixtures.ClusteredEvent.eventKey;
const now = () => new Date("2026-10-06T12:00:00.000Z");

function reviewRegistry() {
  const finalizeCalls = [];
  const attempt = {
    id: attemptId, eventKey, pipelineRunId: runId, attemptNumber: 1,
    startedAt: now().toISOString(), completedAt: null, finalState: null,
    stopStage: null, stopReason: null, retryClass: "NONE", countsTowardRetryLimit: false,
    nextEligibleAt: null, createdAt: now().toISOString(),
  };
  return {
    attempt,
    finalizeCalls,
    async getEligibility(keys) { return new Map(keys.map((key) => [key, { eligible: true, reason: "NEVER_ATTEMPTED" }])); },
    async claim(input) { assert.equal(input.pipelineRunId, runId); return { status: "ACQUIRED", attempt }; },
    async finalize(input) { finalizeCalls.push(input); },
  };
}

const fixture = createOfflineStages();
const fixtureCriticStage = fixture.stages.critic;
fixture.stages.critic = async (context, run) => {
  assert.equal(context.eventAttemptId, attemptId, "the live Critic stage receives the exact claimed event attempt");
  return fixtureCriticStage(context, run);
};
const registry = reviewRegistry();
let gatewayCalls = 0;
const gateway = {
  async createReview(input) {
    gatewayCalls += 1;
    assert.equal(input.attemptId, attemptId);
    assert.equal(input.run.runId, runId);
    assert.equal(input.context.critic.decision, "pass");
    assert.deepEqual(Object.keys(input.checkpoints).filter((stage) => humanReviewCheckpointStages.includes(stage)), [...humanReviewCheckpointStages]);
    return { reviewId, packageSha256: "a".repeat(64) };
  },
};
const result = await new PipelineOrchestrator({
  stages: fixture.stages,
  quota: createStaticPipelineQuota(6),
  attemptRegistry: registry,
  humanReviewGateway: gateway,
  runId,
  now,
  config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 3, automaticRevision: false, maxRevisionAttempts: 1 },
}).run();
assert.equal(result.eventResults[0].finalState, "WAITING_FOR_HUMAN_REVIEW");
assert.equal(result.eventResults[0].stopStage, "human_review");
assert.equal(result.eventResults[0].humanReviewId, reviewId);
assert.equal(result.eventsAwaitingHumanReview, 1);
assert.equal(result.eventsPublished, 0);
assert.equal(result.eventsAttempted, 1);
assert.equal(fixture.calls.includes("publisher"), false, "supervised mode stops before Publisher");
assert.equal(registry.finalizeCalls.length, 0, "migration 31's create-review RPC atomically finalizes the attempt");
assert.equal(gatewayCalls, 1, "same attempt creates one review package");
assert.equal(fixture.publisherDryRuns.length, 0);

const criticPersistenceFixture = createOfflineStages({ checkpointFailure: "critic" });
const criticPersistenceRegistry = reviewRegistry();
let criticPersistenceGateCalls = 0;
const criticPersistenceFailure = await new PipelineOrchestrator({
  stages: criticPersistenceFixture.stages,
  quota: createStaticPipelineQuota(6),
  attemptRegistry: criticPersistenceRegistry,
  humanReviewGateway: { async createReview() { criticPersistenceGateCalls += 1; throw new Error("GATE_MUST_NOT_RUN_WITHOUT_DURABLE_CRITIC_PASS"); } },
  runId,
  now,
  config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 3, automaticRevision: false, maxRevisionAttempts: 1 },
}).run();
assert.equal(criticPersistenceFailure.eventResults[0].finalState, "FAILED");
assert.equal(criticPersistenceFailure.eventResults[0].stopStage, "critic");
assert.equal(criticPersistenceGateCalls, 0, "transient PASS cannot reach the human-review gate when checkpoint persistence is absent");

const incompleteLineageFixture = createOfflineStages();
const completeMetadata = incompleteLineageFixture.stages.sourceMetadata;
incompleteLineageFixture.stages.sourceMetadata = (...args) => completeMetadata(...args).map((source) => ({ ...source, rawItemId: null }));
const incompleteLineageRegistry = reviewRegistry();
const incompleteLineageResult = await new PipelineOrchestrator({
  stages: incompleteLineageFixture.stages,
  quota: createStaticPipelineQuota(6),
  attemptRegistry: incompleteLineageRegistry,
  humanReviewGateway: gateway,
  runId,
  now,
  config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false, maxRevisionAttempts: 1 },
}).run();
assert.equal(incompleteLineageResult.eventResults[0].stopReason, "SUPERVISED_SOURCE_RAW_LINEAGE_INCOMPLETE");
assert.equal(incompleteLineageFixture.calls.includes("verifier"), false, "missing raw lineage stops before the first model call");
assert.equal(incompleteLineageRegistry.finalizeCalls.length, 1, "the blocked pre-model attempt is finalized exactly once");

const allReviewChecks = { factsAcceptable: true, attributionAcceptable: true, uncertaintyPreserved: true, headlineAcceptable: true, summaryAcceptable: true, noUnsupportedMaterialClaims: true, sourceChainAcceptable: true };
assertHumanReviewDecisionAllowed({ currentStatus: "WAITING_FOR_HUMAN_REVIEW", decision: "APPROVE", reviewerId: "editor-1", checks: allReviewChecks });
assert.throws(() => assertHumanReviewDecisionAllowed({ currentStatus: "WAITING_FOR_HUMAN_REVIEW", decision: "APPROVE", reviewerId: "editor-1", checks: { ...allReviewChecks, attributionAcceptable: false } }), /ALL_SEVEN_CHECKS/);
assert.throws(() => assertHumanReviewDecisionAllowed({ currentStatus: "REJECTED", decision: "APPROVE", reviewerId: "editor-1", checks: allReviewChecks }), /DECISION_NOT_ALLOWED/);
assert.doesNotThrow(() => assertHumanReviewDecisionAllowed({ currentStatus: "WAITING_FOR_HUMAN_REVIEW", decision: "HOLD", reviewerId: "editor-1", checks: allReviewChecks }));
assert.doesNotThrow(() => assertHumanReviewDecisionAllowed({ currentStatus: "WAITING_FOR_HUMAN_REVIEW", decision: "REJECT", reviewerId: "editor-1", checks: allReviewChecks }));
assert.throws(() => assertHumanReviewPublishable("HOLD"), /NOT_APPROVED/);
assert.throws(() => assertHumanReviewPublishable("REJECTED"), /NOT_APPROVED/);
assertHumanReviewPublishable("APPROVED");
assertDailyHumanReviewPublicationLimit(0, 2);
assert.throws(() => assertDailyHumanReviewPublicationLimit(2, 1), /DAILY_PUBLICATION_LIMIT/);
assert.throws(() => assertDailyHumanReviewPublicationLimit(0, 3), /DAILY_PUBLICATION_LIMIT/);
assertSupervisedCandidateLimit(5);
assert.throws(() => assertSupervisedCandidateLimit(6), /CANDIDATE_LIMIT/);
let admittedCandidates = 0;
for (let count = 0; count < 5; count += 1) {
  assertSupervisedCandidateAdmission(admittedCandidates, 1);
  admittedCandidates += 1;
}
assert.equal(admittedCandidates, 5, "0 to 5 candidate admissions are allowed");
assert.throws(() => assertSupervisedCandidateAdmission(admittedCandidates, 1), /CANDIDATE_LIMIT/);
const validPublicationAuthorization = {
  action: "APPROVE", status: "APPROVED", eventKey, attemptId, pipelineRunId: runId,
  draftId: `${runId}:${eventKey}`, draftSha256: "b".repeat(64), packageSha256: "c".repeat(64),
  checkpoints: {}, sourceLineage: [],
  criticPass: true, usageSettled: true, factualReviewPassed: true, attributionReviewPassed: true,
  uncertaintyReviewPassed: true, headlineReviewPassed: true, summaryReviewPassed: true,
  noUnsupportedMaterialClaims: true, sourceChainPassed: true,
  approvalTargetKind: "ORIGINAL", approvalTargetRevisionSha256: null, approvedRevisionSha256: null,
  lineageCurrent: true, manifestCurrent: true, approvalConsumed: false, publishedToday: 0,
};
assert.doesNotThrow(() => assertHumanReviewPublicationAuthorization(validPublicationAuthorization));
assert.throws(() => assertHumanReviewPublicationAuthorization({ ...validPublicationAuthorization, publishedToday: 2 }), /DAILY_PUBLICATION_LIMIT/);
for (const invalid of [
  { status: "WAITING_FOR_HUMAN_REVIEW" }, { action: "HOLD" }, { factualReviewPassed: false },
  { attributionReviewPassed: false }, { criticPass: false }, { usageSettled: false },
  { uncertaintyReviewPassed: false }, { headlineReviewPassed: false }, { summaryReviewPassed: false },
  { noUnsupportedMaterialClaims: false }, { sourceChainPassed: false },
  { lineageCurrent: false }, { manifestCurrent: false }, { approvalConsumed: true },
]) assert.throws(() => assertHumanReviewPublicationAuthorization({ ...validPublicationAuthorization, ...invalid }), /HUMAN_APPROVAL_REQUIRED/);
const parsedStatus = parseHumanReviewOperatorStatus({
  utcDay: "2026-10-06", asOfUtc: "2026-10-06T12:00:00.000Z",
  totalReviews: 5, waitingReviews: 1, holdReviews: 1, rejectedReviews: 1, approvedReviews: 1,
  approveReviews: 2, publishingReviews: 0, publishedReviews: 1, consumedReviews: 1,
  candidatesToday: 3, attemptsToday: 4, awaitingReview: 1, held: 1, rejected: 1,
  approved: 1, consumed: 1, publishedToday: 1, failedToday: 0, groqRequests: 5,
  groqTokens: 100, groqUnknownUsage: 0, activeWork: 1, stuckWork: 0,
});
assert.equal(parsedStatus.candidatesToday, 3);
assert.equal(parsedStatus.groqTokens, 100);
assert.equal(parsedStatus.waitingReviews, 1);
assert.equal(parsedStatus.consumedReviews, 1);
assert.throws(() => parseHumanReviewOperatorStatus({ utcDay: "2026-10-06", asOfUtc: "2026-10-06T12:00:00.000Z", totalReviews: -1 }), /STATUS_QUERY_INVALID/);

for (const critic of ["revise", "reject"]) {
  const failedFixture = createOfflineStages({ critic });
  let created = 0;
  const eventRegistry = reviewRegistry();
  const failed = await new PipelineOrchestrator({
    stages: failedFixture.stages,
    quota: createStaticPipelineQuota(6),
    attemptRegistry: eventRegistry,
    humanReviewGateway: { async createReview() { created += 1; return { reviewId, packageSha256: "a".repeat(64) }; } },
    runId,
    now,
    config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 3, automaticRevision: false, maxRevisionAttempts: 1 },
  }).run();
  assert.notEqual(failed.eventResults[0].finalState, "WAITING_FOR_HUMAN_REVIEW");
  assert.equal(created, 0, `${critic} Critic decision never creates a review`);
  assert.equal(failedFixture.calls.includes("publisher"), false);
}

const concurrentFixture = createOfflineStages();
const firstEvent = structuredClone(validFixtures.ClusteredEvent);
const secondCandidateId = "synthetic-concurrency-candidate-2";
const secondUrl = "https://example.com/news/synthetic-concurrency-2";
const secondCandidate = { ...structuredClone(validFixtures.DiscoveryCandidate), externalId: secondCandidateId, url: secondUrl };
const secondItem = { ...structuredClone(validFixtures.ExtractedItem), candidateId: secondCandidateId, url: secondUrl, canonicalUrl: secondUrl };
const secondEvent = { ...structuredClone(validFixtures.ClusteredEvent), eventKey: `${eventKey}-synthetic-2`, sourceItems: [{ ...structuredClone(validFixtures.ClusteredEvent.sourceItems[0]), candidateId: secondCandidateId, url: secondUrl }] };
concurrentFixture.stages.discovery = async () => ({ ...offlineDiscoveryResult, candidates: [validFixtures.DiscoveryCandidate, secondCandidate], candidatesDiscovered: 2 });
concurrentFixture.stages.extraction = async () => ({ ...offlineExtractionResult, limit: 2, candidatesSelected: 2, results: [{ ...offlineExtractionResult.results[0], rawItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { ...offlineExtractionResult.results[0], candidate: secondCandidate, item: secondItem, contentLength: secondItem.content.length, rawItemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }], full: 2 });
const originalClustering = concurrentFixture.stages.clustering;
concurrentFixture.stages.clustering = async (input) => ({ ...await originalClustering(input), extractedItems: 2, events: [firstEvent, secondEvent], singleSourceEvents: 2 });
concurrentFixture.stages.sourceMetadata = (_event, items, rawItemIds) => items.map((item) => ({ sourceId: validFixtures.DiscoveryCandidate.sourceId, sourceItemId: item.candidateId, rawItemId: rawItemIds.get(item.candidateId), sourceName: validFixtures.DiscoveryCandidate.sourceName, sourceUrl: item.canonicalUrl, language: "en", sourceType: "official", countryCode: "US" }));
const originalVerifier = concurrentFixture.stages.verifier;
let activeModelStages = 0;
let maximumActiveModelStages = 0;
concurrentFixture.stages.verifier = async (context, run) => {
  activeModelStages += 1;
  maximumActiveModelStages = Math.max(maximumActiveModelStages, activeModelStages);
  await new Promise((resolve) => setTimeout(resolve, 2));
  try { return await originalVerifier(context, run); } finally { activeModelStages -= 1; }
};
const concurrencyResult = await new PipelineOrchestrator({
  stages: concurrentFixture.stages, quota: createStaticPipelineQuota(20), attemptRegistry: reviewRegistry(), humanReviewGateway: gateway,
  runId, now,
  config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 3, automaticRevision: false, maxRevisionAttempts: 1 },
}).run();
assert.ok(concurrencyResult.eventsAttempted >= 1 && concurrencyResult.eventsAttempted <= 3, "a WAITING review no longer stops the cycle; it continues up to the attempt limit");
assert.equal(concurrencyResult.eventsAwaitingHumanReview, concurrencyResult.eventsAttempted, "every attempted event waits for human review");
assert.equal(maximumActiveModelStages, 1, "SUPERVISED event model execution is sequential, with concurrency one");

const remediationBlockFixture = createOfflineStages();
const remediationBlocker = new PipelineOrchestrator({
  stages: remediationBlockFixture.stages, quota: createStaticPipelineQuota(10), attemptRegistry: reviewRegistry(), humanReviewGateway: gateway,
  config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 3, automaticRevision: false, maxRevisionAttempts: 1 },
});
await assert.rejects(() => remediationBlocker.runFactualRemediation({}), /SUPERVISED_AUTOMATIC_FACTUAL_REMEDIATION_DISABLED/);
await assert.rejects(() => remediationBlocker.runFactualRemediationContinuation({}), /SUPERVISED_AUTOMATIC_FACTUAL_REMEDIATION_DISABLED/);

for (const invalid of [
  { publish: true },
  { dryRun: false },
  { automaticRevision: true },
  { limit: 6 },
]) {
  assert.throws(() => new PipelineOrchestrator({
    stages: createOfflineStages().stages,
    quota: createStaticPipelineQuota(6),
    attemptRegistry: new InMemoryPipelineEventAttemptRegistry(),
    humanReviewGateway: gateway,
    config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 3, automaticRevision: false, maxRevisionAttempts: 1, ...invalid },
  }), /Pipeline writes require|SUPERVISED_MODE_REQUIRES/);
}

const reviewTemp = await mkdtemp(join(tmpdir(), "horizai-supervised-review-"));
try {
  const checkpointRoot = resolve(reviewTemp, "pipeline-checkpoints");
  const checkpointDir = join(checkpointRoot, runId);
  await mkdir(checkpointDir, { recursive: true });
  const checkpoints = {};
  const criticCheckpointInput = structuredClone(canonicalCriticInput);
  criticCheckpointInput.event.eventKey = eventKey;
  criticCheckpointInput.verification.eventKey = eventKey;
  criticCheckpointInput.translation.eventKey = eventKey;
  criticCheckpointInput.editorial.eventKey = eventKey;
  criticCheckpointInput.classification.eventKey = eventKey;
  criticCheckpointInput.ranking.result.eventKey = eventKey;
  const { ranking, ...beforeRanking } = criticCheckpointInput;
  const rankerCheckpoint = buildRankerPipelineCheckpoint(beforeRanking, ranking, now().toISOString());
  const durableCriticResult = { ...structuredClone(validFixtures.CriticResult), eventKey, decision: "pass" };
  const durableCriticCheckpoint = buildCriticPipelineCheckpoint(rankerCheckpoint, durableCriticResult, now().toISOString(), undefined, attemptId);
  for (const stage of humanReviewCheckpointStages) {
    const path = join(checkpointDir, `${stage}-${eventKey}.json`);
    if (stage === "critic") await writeCriticPipelineCheckpointAtomic(durableCriticCheckpoint, path);
    else await writeFile(path, `synthetic checkpoint: ${stage}\n`, "utf8");
    checkpoints[stage] = { stage, path, eventKey, written: true, readable: true, valid: true };
  }

  const context = {
    event: structuredClone(validFixtures.ClusteredEvent),
    items: [structuredClone(validFixtures.ExtractedItem)],
    sources: [{
      sourceId: validFixtures.DiscoveryCandidate.sourceId,
      sourceItemId: validFixtures.ExtractedItem.candidateId,
      rawItemId: "66666666-6666-4666-8666-666666666666",
      sourceName: "Synthetic Source",
      sourceUrl: "https://example.com/source",
      sourceType: "official",
      countryCode: "US",
      language: "en",
    }],
    verification: { ...structuredClone(validFixtures.VerificationResult), eventKey },
    translation: { ...structuredClone(validFixtures.TranslationResult), eventKey },
    editorial: { ...structuredClone(validFixtures.EditorialDraft), eventKey },
    classification: { ...structuredClone(validFixtures.ClassificationResult), eventKey },
    geo: { eventKey, primaryRegionCode: "US", countryCodes: ["US"], latitude: 39.8283, longitude: -98.5795, resolutionLevel: "region", resolvedFrom: "region_registry", provenance: "reference_registry" },
    ranking: { ...structuredClone(validFixtures.RankingResult), eventKey },
    critic: durableCriticResult,
  };
  const configEnvNames = ["AGENT_MODEL_VERIFY", "AGENT_MODEL_TRANSLATE", "AGENT_MODEL_EDITOR", "AGENT_MODEL_CLASSIFY", "AGENT_MODEL_RANK", "AGENT_MODEL_CRITIC", "AGENT_MAX_RETRIES"];
  const savedConfigEnv = new Map(configEnvNames.map((name) => [name, process.env[name]]));
  for (const name of configEnvNames.filter((name) => name.startsWith("AGENT_MODEL_"))) process.env[name] = "synthetic-config-model";
  process.env.AGENT_MAX_RETRIES = "2";
  try {
    const dispatchedConfigs = [];
    const provider = new MockModelProvider((request) => {
      dispatchedConfigs.push(request.config);
      return { ...structuredClone(validFixtures.VerificationResult), eventKey };
    });
    const productionLogger = new InMemoryAgentLogger();
    const production = createProductionPipeline({
      supabase: {}, logger: productionLogger, provider, quota: { provider: "groq", async remaining() { return 100; } },
      requestBudget: new ProviderScopedDailyRequestBudget(), attemptRegistry: {}, factualRemediationAttemptGuard: {},
      config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 3, automaticRevision: false, maxRevisionAttempts: 1 },
      agents: { verifier: new VerifierAgent(provider, productionLogger) },
    });
    await production.stages.verifier(context, { schemaVersion: 1, runId, dryRun: true, startedAt: now().toISOString(), trigger: "manual", agentVersions: {} });
    assert.equal(provider.calls, 1, "the synthetic mock provider was the only dispatched provider");
    assert.equal(dispatchedConfigs[0].maxRetries, 0, "the actual structured request uses zero retries in SUPERVISED mode");
    assert.equal(dispatchedConfigs[0].allowPaidFallback, false, "the dispatched request has no paid fallback");
    assert.equal(dispatchedConfigs[0].allowProviderPacingWait, false, "supervised mode defers TPM capacity instead of waiting inside a daily run");
    assert.equal(productionLogger.runs[0].metadata.pipelineRunId, runId, "stage provider accounting is attributable to the supervised pipeline run");
  } finally {
    for (const [name, value] of savedConfigEnv) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  const payload = buildPipelinePublicationPayload(context);
  const providerAccounting = Object.fromEntries(humanReviewCheckpointStages.map((stage) => [stage, {
    status: "SUCCESS", provider: "groq", providerUnit: "tokens", providerUnitUsageKnown: true,
    actualProviderUnitUsage: 42, providerRequestDispatched: true, errorCategory: null,
    rateLimitHeaders: null, providerHttpStatus: 200, model: "openai/gpt-oss-20b", agentVersion: `${stage}-v1`,
    structuredOutputMode: "strict_schema", reasoningEffort: "low", includeReasoning: false, finishReason: "stop",
    providerRequestsUsed: 1, attempts: 1, retries: 0, latencyMs: 5, inputTokens: 12, outputTokens: 30,
    totalTokens: 42, requestBytes: 1, responseBytes: 1, zodValid: true,
    startedAt: now().toISOString(), finishedAt: now().toISOString(),
  }]));
  const snapshot = await buildHumanReviewSnapshot({
    context,
    run: { schemaVersion: 1, runId, dryRun: true, startedAt: now().toISOString(), trigger: "manual", agentVersions: {} },
    attemptId,
    checkpoints,
    providerAccounting,
    publicationPayload: payload,
    sourceRegistryUrls: new Map([[validFixtures.DiscoveryCandidate.sourceId, "https://example.com/source"]]),
    checkpointRoot,
    createdAt: now().toISOString(),
  });
  assert.equal(snapshot.manifest.schemaVersion, "1");
  assert.equal(Object.keys(snapshot.manifest.checkpoints).length, 6);
  assert.equal(snapshot.artifact.reviewManifest.manifestSha256, snapshot.manifest.manifestSha256);
  assert.equal(snapshot.artifact.reviewEvidence.providerAccounting.critic.settlement, "SETTLED");
  assert.equal(snapshot.artifact.sourceLineage[0].raw_item_id, "66666666-6666-4666-8666-666666666666");
  assert.equal(verifyHumanReviewArtifact(snapshot.artifact), true);
  assert.equal(snapshot.manifest.checkpoints.critic.identity, `${runId}:${attemptId}:critic:${eventKey}`, "Critic checkpoint identity binds event, attempt, stage, and run");
  const restoredCritic = { ...context, critic: undefined };
  const restoredCriticPayload = buildPipelinePublicationPayload({ ...restoredCritic, critic: durableCriticCheckpoint.critic });
  const freshProcessInput = {
    context: restoredCritic,
    run: { schemaVersion: 1, runId, dryRun: true, startedAt: now().toISOString(), trigger: "manual", agentVersions: {} },
    attemptId,
    checkpoints,
    providerAccounting,
    publicationPayload: restoredCriticPayload,
    sourceRegistryUrls: [[validFixtures.DiscoveryCandidate.sourceId, "https://example.com/source"]],
    checkpointRoot,
    createdAt: now().toISOString(),
  };
  const freshProcessInputPath = join(reviewTemp, "fresh-process-review-input.json");
  await writeFile(freshProcessInputPath, JSON.stringify(freshProcessInput), "utf8");
  const humanReviewModuleUrl = pathToFileURL(resolve("lib/agents/publisher/human-review.ts")).href;
  const freshProcessScript = `import { readFile } from "node:fs/promises"; import { buildHumanReviewSnapshot } from ${JSON.stringify(humanReviewModuleUrl)}; const input = JSON.parse(await readFile(process.env.HUMAN_REVIEW_FRESH_PROCESS_INPUT, "utf8")); const snapshot = await buildHumanReviewSnapshot({ ...input, sourceRegistryUrls: new Map(input.sourceRegistryUrls) }); console.log(JSON.stringify({ decision: snapshot.artifact.reviewEvidence.critic.decision, identity: snapshot.manifest.checkpoints.critic.identity }));`;
  const freshProcess = spawnSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "--input-type=module", "-e", freshProcessScript], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, HUMAN_REVIEW_FRESH_PROCESS_INPUT: freshProcessInputPath },
  });
  assert.equal(freshProcess.status, 0, `fresh-process review resume must succeed: ${freshProcess.stderr}`);
  const freshProcessResult = JSON.parse(freshProcess.stdout.trim());
  assert.equal(freshProcessResult.decision, "pass", "a fresh process rebuilds the review from the durable Critic checkpoint");
  assert.equal(freshProcessResult.identity, `${runId}:${attemptId}:critic:${eventKey}`);
  await assert.rejects(() => buildHumanReviewSnapshot({
    context: restoredCritic,
    run: { schemaVersion: 1, runId, dryRun: true, startedAt: now().toISOString(), trigger: "manual", agentVersions: {} },
    attemptId: "99999999-9999-4999-8999-999999999999",
    checkpoints,
    providerAccounting,
    publicationPayload: restoredCriticPayload,
    sourceRegistryUrls: new Map([[validFixtures.DiscoveryCandidate.sourceId, "https://example.com/source"]]),
    checkpointRoot,
  }), /DURABLE_CRITIC_PASS_NOT_PROVEN/);
  assert.equal(humanReviewArtifactSchema.safeParse({ ...snapshot.artifact, unknownContractField: true }).success, false, "unknown review contract fields fail strict Zod parsing");
  assert.equal(humanReviewArtifactSchema.safeParse(Object.fromEntries(Object.entries(snapshot.artifact).filter(([key]) => key !== "reviewEvidence"))).success, false, "missing required review evidence fails strict Zod parsing");
  assert.equal(humanReviewManifestSchema.safeParse({ ...snapshot.manifest, manifestSha256: "f".repeat(64) }).success, true);
  assert.equal(verifyHumanReviewArtifact({ ...snapshot.artifact, reviewManifest: { ...snapshot.artifact.reviewManifest, checkpoints: { ...snapshot.artifact.checkpoints, editor: { ...snapshot.artifact.checkpoints.editor, sha256: "f".repeat(64) } } } }), false, "canonical review manifest hash detects checkpoint changes");
  const unsettledAccounting = { ...providerAccounting, critic: { ...providerAccounting.critic, providerUnitUsageKnown: false } };
  await assert.rejects(() => buildHumanReviewSnapshot({
    context, run: { schemaVersion: 1, runId, dryRun: true, startedAt: now().toISOString(), trigger: "manual", agentVersions: {} },
    attemptId, checkpoints, providerAccounting: unsettledAccounting, publicationPayload: payload,
    sourceRegistryUrls: new Map([[validFixtures.DiscoveryCandidate.sourceId, "https://example.com/source"]]), checkpointRoot,
  }), /PROVIDER_USAGE_UNSETTLED:critic/);
  const operatorRow = {
    id: reviewId, event_key: eventKey, attempt_id: attemptId, status: "WAITING_FOR_HUMAN_REVIEW",
    reviewer_id: null, reviewer_approved: null, facts_acceptable: null, attribution_acceptable: null,
    uncertainty_preserved: null, headline_acceptable: null, summary_acceptable: null,
    no_unsupported_material_claims: null, source_chain_acceptable: null,
    created_at: now().toISOString(), updated_at: now().toISOString(),
  };
  const listed = buildHumanReviewListEntry(operatorRow, snapshot.artifact);
  assert.equal(listed.event, eventKey);
  assert.equal(listed.headline, snapshot.artifact.draft.headlineEs);
  assert.equal(listed.sources[0].url, snapshot.artifact.publicationPayload.sources[0].url);
  assert.equal(listed.critic.decision, "pass");
  assert.equal(listed.waitingSince, operatorRow.created_at);
  const inspected = buildHumanReviewInspection(operatorRow, snapshot.artifact, "PASS");
  assert.equal(inspected.summary, snapshot.artifact.draft.summaryEs);
  assert.equal(inspected.body, snapshot.artifact.draft.bodyEs);
  assert.equal(inspected.providerAccounting.critic.settlement, "SETTLED");
  assert.equal(inspected.reviewManifest.manifestSha256, snapshot.manifest.manifestSha256);
  const approvedMutation = buildHumanReviewDecision({ reviewId, row: operatorRow, decision: "APPROVE", reviewerId: "operator-1", checks: allReviewChecks });
  assert.equal(approvedMutation.decision, "APPROVE");
  assert.equal(buildHumanReviewDecision({ reviewId, row: operatorRow, decision: "HOLD", reviewerId: "operator-1", checks: { ...allReviewChecks, factsAcceptable: false } }).decision, "HOLD");
  assert.equal(buildHumanReviewDecision({ reviewId, row: operatorRow, decision: "REJECT", reviewerId: "operator-1", checks: { ...allReviewChecks, attributionAcceptable: false } }).decision, "REJECT");
  assert.throws(() => buildHumanReviewDecision({ reviewId, row: operatorRow, decision: "APPROVE", reviewerId: "operator-1", checks: { ...allReviewChecks, factsAcceptable: false } }), /ALL_SEVEN_CHECKS/);
  const rpcCalls = [];
  let consumed = false;
  const fakeSupabase = { async rpc(name, args) {
    rpcCalls.push({ name, args });
    if (name === "create_pipeline_human_review") return { data: { reviewId, status: "WAITING_FOR_HUMAN_REVIEW", draftSha256: snapshot.artifact.draftSha256 }, error: null };
    if (name === "decide_pipeline_human_review") return { data: { reviewId, status: "APPROVED", reviewedAt: now().toISOString() }, error: null };
    if (name === "publish_reviewed_article_atomic") {
      if (consumed) return { data: null, error: { message: "human_review_already_consumed" } };
      consumed = true;
      return { data: { humanReviewId: reviewId, humanReviewStatus: "PUBLISHED", eventId: "synthetic-event", articleId: "synthetic-article", eventAction: "created", articleAction: "created", articleOperation: "upsert_by_event_id", categoriesLinkedCount: 1, entitiesLinkedCount: 0, entitiesCreated: 0, entitiesReused: 0, sourcesLinkedCount: 1, relationsCreated: 1, activityRowsCreated: 0 }, error: null };
    }
    throw new Error(`UNEXPECTED_RPC:${name}`);
  } };
  const reviewRepository = new SupabaseHumanReviewRepository(fakeSupabase);
  const createdReview = await reviewRepository.create({ artifact: snapshot.artifact, manifest: snapshot.manifest });
  const resumedCreatedReview = await reviewRepository.create({ artifact: snapshot.artifact, manifest: snapshot.manifest });
  assert.equal(createdReview.status, "WAITING_FOR_HUMAN_REVIEW");
  assert.equal(resumedCreatedReview.reviewId, createdReview.reviewId, "replayed create for the same attempt resolves to the same single review");
  assert.equal(rpcCalls[0].name, "create_pipeline_human_review");
  assert.equal(rpcCalls[0].args.p_review_manifest.manifestSha256, snapshot.manifest.manifestSha256);
  const approvedReview = await reviewRepository.decide({ reviewId, decision: "APPROVE", reviewerId: "operator-1", checks: allReviewChecks });
  assert.equal(approvedReview.status, "APPROVED");
  assert.deepEqual(rpcCalls[2].args.p_facts_acceptable, true);
  assert.deepEqual(rpcCalls[2].args.p_attribution_acceptable, true);
  const storedArtifact = attachHumanReviewId(snapshot.artifact, reviewId);
  const storedAuthorization = {
    ...validPublicationAuthorization,
    eventKey: storedArtifact.eventKey, attemptId: storedArtifact.attemptId, pipelineRunId: storedArtifact.pipelineRunId,
    draftId: storedArtifact.draftId, draftSha256: storedArtifact.draftSha256, packageSha256: storedArtifact.packageSha256,
    checkpoints: storedArtifact.checkpoints, sourceLineage: storedArtifact.sourceLineage,
  };
  const publishedReview = await reviewRepository.publishReviewed({ reviewId, artifact: storedArtifact, authorization: storedAuthorization });
  assert.equal(publishedReview.articleId, "synthetic-article");
  assert.equal(rpcCalls[3].name, "publish_reviewed_article_atomic");
  await assert.rejects(() => reviewRepository.publishReviewed({ reviewId, artifact: storedArtifact, authorization: storedAuthorization }), /already_consumed/);
  assert.equal(snapshot.artifact.checkpoints.critic.sha256, sha256(await readFile(checkpoints.critic.path)));
  const artifactPath = await writeHumanReviewArtifact(join(reviewTemp, "packages"), snapshot.artifact);
  assert.ok(artifactPath.endsWith(`${attemptId}.json`));
  assert.throws(() => humanReviewArtifactPath(join(reviewTemp, "packages"), "../secret"), /ATTEMPT_ID_INVALID/);

  const staleBytes = await readFile(checkpoints.editor.path);
  await writeFile(checkpoints.editor.path, Buffer.concat([staleBytes, Buffer.from("changed") ]));
  const liveEditorHash = sha256(await readFile(checkpoints.editor.path));
  assert.notEqual(liveEditorHash, snapshot.artifact.checkpoints.editor.sha256, "a changed checkpoint is detectable as stale");
  const tampered = { ...snapshot.artifact, draft: { ...snapshot.artifact.draft, headlineEs: "Changed without approval" } };
  assert.equal(verifyHumanReviewArtifact(tampered), false, "the review package hash binds the full editorial draft");
  const wrongLineage = { ...context, sources: [{ ...context.sources[0], rawItemId: null }] };
  await assert.rejects(() => buildHumanReviewSnapshot({
    context: wrongLineage, run: { schemaVersion: 1, runId, dryRun: true, startedAt: now().toISOString(), trigger: "manual", agentVersions: {} },
    attemptId, checkpoints, providerAccounting, publicationPayload: buildPipelinePublicationPayload(wrongLineage),
    sourceRegistryUrls: new Map([[validFixtures.DiscoveryCandidate.sourceId, "https://example.com/source"]]), checkpointRoot,
  }), /SOURCE_LINEAGE_INCOMPLETE/);
} finally {
  await rm(reviewTemp, { recursive: true, force: true });
}

const payload = structuredClone(validFixtures.PublicationPayload);
payload.sources = payload.sources.map((source, index) => ({ ...source, rawItemId: source.rawItemId ?? `77777777-7777-4777-8777-${String(index + 1).padStart(12, "0")}` }));
const key = payload.eventKey;
const validationContext = {
  translation: { ...structuredClone(validFixtures.TranslationResult), eventKey: key },
  editorSources: [{ sourceId: payload.sources[0].sourceId, sourceName: payload.sources[0].sourceName, canonicalUrl: payload.sources[0].url, sourceType: "website" }],
};
const lineage = Object.fromEntries(["eventKey", "verificationEventKey", "translationEventKey", "editorialEventKey", "classificationEventKey", "rankingEventKey", "criticEventKey"].map((name) => [name, key]));
const lookup = {
  event: null, region: { id: "region", code: "US", latitude: 39.8283, longitude: -98.5795, is_active: true },
  categories: payload.categories.map((category, index) => ({ id: `cat-${index}`, slug: category.categorySlug, is_active: true })),
  sources: payload.sources.map((source) => ({ id: source.sourceId, name: source.sourceName, url: source.url, is_active: true })),
  eventSourceIds: [], articleByEvent: null, articleBySlug: null, entities: [],
};
let rawAtomicCalls = 0;
let reviewedAtomicCalls = 0;
const committed = { eventId: "event", articleId: "article", eventAction: "created", articleAction: "created", articleOperation: "upsert_by_event_id", categoriesLinkedCount: 1, entitiesLinkedCount: 0, entitiesCreated: 0, entitiesReused: 0, sourcesLinkedCount: 1, relationsCreated: 1, activityRowsCreated: 0 };
const repository = {
  async findEventByKey() { return lookup.event; }, async findActiveRegion() { return lookup.region; },
  async findActiveCategories() { return lookup.categories; }, async findSources() { return lookup.sources; },
  async findEventSourceIds() { return lookup.eventSourceIds; }, async findArticleByEventId() { return lookup.articleByEvent; },
  async findArticleBySlug() { return lookup.articleBySlug; }, async findExactEntities() { return lookup.entities; },
  async publishAtomic() { rawAtomicCalls += 1; return committed; },
  async publishReviewedAtomic(_payload, target) { if (reviewedAtomicCalls > 0) throw new Error("human_review_already_consumed"); reviewedAtomicCalls += 1; assert.equal(target.reviewId, reviewId); return committed; },
};
const publisherInput = { payload, lineage, validationContext };
await assert.rejects(() => new Publisher(repository).publish(publisherInput, { dryRun: false }), /HUMAN_APPROVAL_REQUIRED/);
await assert.rejects(() => new Publisher(repository).publish(publisherInput, { dryRun: false, factualRemediation: { attemptId, pipelineRunId: runId, articleId: "article", articleSlug: payload.article.slug } }), /HUMAN_APPROVAL_REQUIRED/);
assert.equal(rawAtomicCalls, 0, "ordinary Publisher cannot use boolean publish mode as authorization");
const reviewedTarget = { reviewId, eventKey: key, attemptId, pipelineRunId: runId, draftId: `${runId}:${key}`, draftSha256: validPublicationAuthorization.draftSha256, packageSha256: validPublicationAuthorization.packageSha256, checkpoints: {}, sourceLineage: [], approvalTargetRevisionSha256: null, authorization: { ...validPublicationAuthorization, eventKey: key, attemptId, pipelineRunId: runId, draftId: `${runId}:${key}` } };
for (const mutation of [
  { eventKey: "wrong-event" }, { attemptId: reviewId }, { pipelineRunId: attemptId },
  { draftSha256: "d".repeat(64) }, { packageSha256: "e".repeat(64) }, { checkpoints: { editor: "changed" } },
  { sourceLineage: [{ source_id: "changed" }] },
]) await assert.rejects(() => new Publisher(repository).publish(publisherInput, { dryRun: false, reviewedPublication: { ...reviewedTarget, ...mutation } }), /HUMAN_APPROVAL_REQUIRED/);
const published = await new Publisher(repository).publish(publisherInput, { dryRun: false, reviewedPublication: reviewedTarget });
assert.equal(published.summary.transactionCommitted, true);
assert.equal(reviewedAtomicCalls, 1, "approved path invokes the reviewed atomic repository method");
assert.equal(rawAtomicCalls, 0);
await assert.rejects(() => new Publisher(repository).publish(publisherInput, { dryRun: false, reviewedPublication: reviewedTarget }), /human_review_already_consumed/);
assert.equal(reviewedAtomicCalls, 1, "a consumed synthetic approval cannot be used twice");

console.log("Supervised human review fixtures passed: stop after Critic, no review on non-pass, strict mode config, package/checkpoint tamper detection, exact source binding, and one-use reviewed Publisher path");
