import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { createReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { createStaticPipelineQuota } from "../lib/agents/pipeline/pipeline-budget.ts";
import { offlineClusterResult, offlineDiscoveryResult, offlineExtractionResult } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { createProductionPipeline, fixturePublicationPayload } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { executeScheduledPipeline } from "../lib/agents/pipeline/scheduler/scheduler-execution.ts";
import { editorInputSchema } from "../lib/agents/editor/editor-types.ts";
import { classifierInputSchema } from "../lib/agents/classifier/classifier-types.ts";
import { rankerInputSchema } from "../lib/agents/ranker/ranker-types.ts";
import { criticInputSchema } from "../lib/agents/critic/critic-types.ts";

for (const [name, value] of Object.entries({ AGENT_PROVIDER: "mock", AGENT_API_URL: "https://mock.invalid/v1", AGENT_API_KEY: "unit-only", AGENT_MODEL_VERIFY: "mock-verifier", AGENT_MODEL_TRANSLATE: "mock-translator", AGENT_MODEL_EDITOR: "mock-editor", AGENT_MODEL_CLASSIFY: "mock-classifier", AGENT_MODEL_RANK: "mock-ranker", AGENT_MODEL_CRITIC: "mock-critic", AGENT_DAILY_REQUEST_LIMIT: "20", AGENT_MAX_OUTPUT_TOKENS: "1200", AGENT_FAIL_ON_RATE_LIMIT: "true", AGENT_ALLOW_PAID_FALLBACK: "false" })) process.env[name] = value;

const eventKey = offlineClusterResult.events[0].eventKey;
const sourceId = validFixtures.DiscoveryCandidate.sourceId;
const copy = (value, extra = {}) => ({ ...structuredClone(value), ...extra });
const result = (agentName, output, extra = {}) => ({ output, runId: null, agentName, agentVersion: `${agentName}-mock-v1`, model: "mock-model", attempts: 1, latencyMs: 1, diagnostics: { providerRequestDispatched: true }, ...extra });
const calls = [];
const seenInputs = {};
const remember = (name, input, output, extra = {}) => { seenInputs[name] = input; calls.push(name); return Promise.resolve(result(name, copy(output, { eventKey }), extra)); };

const verifierOutput = copy(validFixtures.VerificationResult, { eventKey, supportingSourceIds: [] });
const translationOutput = copy(validFixtures.TranslationResult, { eventKey });
const editorialOutput = copy(validFixtures.EditorialDraft, { eventKey });
const classificationOutput = copy(validFixtures.ClassificationResult, { eventKey });
const rankingOutput = copy(validFixtures.RankingResult, { eventKey });
const criticOutput = copy(validFixtures.CriticResult, { eventKey, decision: "pass" });
const agents = {
  verifier: { verify: (input, options) => { assert.equal(options.modelConfig.maxRetries, 0); return remember("verifier", input, verifierOutput); } },
  translator: { translate: (input, options) => { assert.equal(options.modelConfig.maxRetries, 0); return remember("translator", input, translationOutput); } },
  editor: { edit: (input, options) => { assert.equal(options.modelConfig.maxRetries, 0); return remember("editor", input, editorialOutput); } },
  classifier: { classify: (input, options) => { assert.equal(options.modelConfig.maxRetries, 0); return remember("classifier", input, classificationOutput, { geo: { latitude: 39.8283, longitude: -98.5795, resolutionLevel: "country", resolvedFrom: "country_registry" }, categoryCount: 1, countryCount: 1, entityCount: 1 }); } },
  ranker: { rank: (input, options) => { assert.equal(options.modelConfig.maxRetries, 0); return remember("ranker", input, rankingOutput, { signals: { credibility: 80, reach: 40, momentum: 50, sourceCount: 1, contradictionPenalty: 0, uncertaintyPenalty: 0, geographicReachSignal: 10, momentumAvailable: false }, formulaVersion: "ranker-v1" }); } },
  critic: { critique: (input, options) => { assert.equal(options.modelConfig.maxRetries, 0); return remember("critic", input, criticOutput, { prechecks: { passed: true, issues: [] }, routedStage: null, generation: { findings: [] } }); } },
};

const payload = fixturePublicationPayload(eventKey);
const repository = {
  async findEventByKey(key) { return { id: "00000000-0000-0000-0000-000000000010", event_key: key, canonical_title: payload.event.canonicalTitle, primary_region_id: "00000000-0000-0000-0000-000000000011", primary_country_code: "US", occurred_at: null }; },
  async findActiveRegion(code) { return code ? { id: "00000000-0000-0000-0000-000000000011", code, latitude: payload.region.latitude, longitude: payload.region.longitude, is_active: true } : null; },
  async findActiveCategories(slugs) { return slugs.map((slug, index) => ({ id: `00000000-0000-0000-0000-00000000002${index}`, slug, is_active: true })); },
  async findSources(ids) { return ids.map((id) => ({ id, name: "Fixture source", url: payload.sources[0].url, is_active: true })); },
  async findEventSourceIds() { return [sourceId]; },
  async findArticleByEventId() { return null; },
  async findArticleBySlug() { return null; },
  async findExactEntities(entities) { return entities.map((entity, index) => ({ id: `00000000-0000-0000-0000-00000000003${index}`, entity_type: entity.entityType, canonical_name: entity.canonicalName, country_code: entity.countryCode })); },
  async publishAtomic() { throw new Error("must not publish during wiring unit"); },
};
const root = await mkdtemp(join(tmpdir(), "horizai-pipeline-wiring-"));
try {
  const pipeline = createProductionPipeline({
    supabase: { from() { return { select() { return { async limit() { return { error: null }; } }; } }; } },
    logger: { startRun: async () => null, reserveRequest: async () => ({ allowed: true, dailyCount: 1, dailyLimit: 20, requestDate: "2026-01-01" }), releaseRequest: async () => true, markRequestDispatched: async () => true, getRemainingRequests: async () => ({ requestDate: "2026-01-01", dailyLimit: 20, used: 0, remaining: 20 }), log: async () => {}, finishRun: async () => {} },
    provider: { async generateStructured() { throw new Error("provider must not be called by wiring unit"); } },
    registry: createReferenceRegistry([{ code: "US", name: "United States", latitude: 39.8283, longitude: -98.5795 }], [{ slug: "modelos", name: "Modelos" }]),
    quota: createStaticPipelineQuota(6),
    requestBudget: { reserve: () => ({ dailyCount: 1, requestDate: "2026-01-01" }), markRateLimited: () => {}, release: () => {}, snapshot: () => ({ day: "2026-01-01", requests: 0 }) },
    publisherRepository: repository,
    publicationPayloadFactory: () => payload,
    checkpointRoot: root,
    config: { hours: 24, limit: 1, dryRun: true, publish: false },
    agents,
    deterministic: { discovery: async () => offlineDiscoveryResult, extraction: async () => offlineExtractionResult, clustering: async () => offlineClusterResult },
  });
  assert.deepEqual(Object.values(pipeline.configs).map((config) => config.maxRetries), [0, 0, 0, 0, 0, 0]);
  const run = await pipeline.orchestrator.run();
  assert.equal(run.finalState, "SUCCESS", JSON.stringify(run.eventResults));
  assert.equal(run.eventsAttempted, 1);
  assert.equal(run.eventsDryRunReady, 1);
  assert.deepEqual(calls, ["verifier", "translator", "editor", "classifier", "ranker", "critic"]);
  assert.equal(seenInputs.verifier.sources[0].sourceItemId, undefined);
  assert.equal(seenInputs.translator.sources[0].sourceItemId, validFixtures.ExtractedItem.candidateId);
  assert.equal(seenInputs.editor.sources[0].canonicalUrl, validFixtures.ExtractedItem.canonicalUrl);
  const projectedEditorInput = editorInputSchema.parse(seenInputs.editor);
  const expectedEditorTranslationKeys = ["preservedNames", "translatedFacts", "translatedTitle", "translatedSourceMaterial", "translationNotes"].sort();
  assert.deepEqual(Object.keys(projectedEditorInput.translation).sort(), expectedEditorTranslationKeys);
  for (const key of ["schemaVersion", "eventKey", "sourceLanguage", "targetLanguage"]) assert.equal(key in projectedEditorInput.translation, false);
  assert.equal(projectedEditorInput.translation.translatedTitle, translationOutput.translatedTitle);
  assert.equal(projectedEditorInput.translation.translatedFacts.length, translationOutput.translatedFacts.length);
  assert.deepEqual(Object.keys(projectedEditorInput.verification).sort(), ["contradictions", "confidenceScore", "status", "uncertainClaims", "verifiedFacts"].sort());
  assert.equal(seenInputs.classifier.sources[0].sourceName, validFixtures.DiscoveryCandidate.sourceName);
  const projectedClassifierInput = classifierInputSchema.parse(seenInputs.classifier);
  assert.deepEqual(Object.keys(projectedClassifierInput.verification).sort(), ["contradictions", "confidenceScore", "status", "uncertainClaims", "verifiedFacts"].sort());
  assert.deepEqual(Object.keys(projectedClassifierInput.translation).sort(), ["preservedNames", "translatedFacts", "translatedTitle"].sort());
  assert.deepEqual(Object.keys(projectedClassifierInput.editorial).sort(), ["headlineEs", "keyPoints", "summaryEs"].sort());
  assert.equal("schemaVersion" in projectedClassifierInput.verification, false);
  assert.equal("eventKey" in projectedClassifierInput.verification, false);
  const projectedRankerInput = rankerInputSchema.parse(seenInputs.ranker);
  assert.deepEqual(Object.keys(projectedRankerInput.verification).sort(), ["contradictions", "confidenceScore", "status", "uncertainClaims", "verifiedFacts"].sort());
  assert.deepEqual(Object.keys(projectedRankerInput.translation).sort(), ["translatedFacts", "translatedTitle"].sort());
  assert.deepEqual(Object.keys(projectedRankerInput.editorial).sort(), ["headlineEs", "keyPoints", "summaryEs", "whyItMattersEs"].sort());
  assert.deepEqual(Object.keys(projectedRankerInput.classification).sort(), ["categorySlugs", "companies", "models", "people", "primaryRegionCode", "technologies", "countryCodes"].sort());
  const projectedCriticInput = criticInputSchema.parse(seenInputs.critic);
  assert.deepEqual(Object.keys(projectedCriticInput.geo).sort(), ["latitude", "longitude", "resolutionLevel", "resolvedFrom"].sort());
  assert.equal(projectedCriticInput.geo.resolutionLevel, "region");
  assert.equal(projectedCriticInput.geo.resolvedFrom, "region_registry");
  assert.deepEqual(Object.keys(projectedCriticInput.verification).sort(), ["schemaVersion", "eventKey", "status", "confidenceScore", "primarySourceId", "supportingSourceIds", "contradictions", "uncertainClaims", "reason", "verifiedFacts"].sort());
  assert.deepEqual(Object.keys(projectedCriticInput.translation).sort(), ["eventKey", "preservedNames", "schemaVersion", "sourceLanguage", "targetLanguage", "translatedFacts", "translatedSourceMaterial", "translatedTitle", "translationNotes"].sort());
  assert.deepEqual(Object.keys(projectedCriticInput.editorial).sort(), ["schemaVersion", "eventKey", "headlineEs", "dekEs", "summaryEs", "whyItMattersEs", "bodyEs", "keyPoints", "suggestedSlug"].sort());
  assert.equal(seenInputs.critic.sources[0].sourceItemId, validFixtures.ExtractedItem.candidateId);
  assert.equal(seenInputs.critic.sourceEvidence[0].sourceItemId, validFixtures.ExtractedItem.candidateId);
  assert.equal(seenInputs.critic.sourceEvidence[0].canonicalUrl, validFixtures.ExtractedItem.canonicalUrl);
  assert.equal(seenInputs.critic.sourceEvidence[0].contentHash, validFixtures.ExtractedItem.contentHash);
  assert.ok(seenInputs.critic.sourceEvidence[0].contentExcerpt.length <= 1_000);
  assert.equal(run.eventResults[0].checkpoints.verifier.valid, true);
  assert.equal(run.eventResults[0].checkpoints.critic.valid, true);
  const schedulerCalls = { acquire: 0, finishExecution: 0, release: 0 };
  let bridgeFactoryOptions;
  const schedulerRepository = {
    async acquire() { schedulerCalls.acquire += 1; return { status: "acquired", runId: "66666666-6666-4666-8666-666666666666", ownerRunId: "77777777-7777-4777-8777-777777777777", triggerId: "test:composition", expiresAt: "2026-09-21T11:00:00.000Z" }; },
    async finish() { return true; },
    async finishExecution() { schedulerCalls.finishExecution += 1; return true; },
    async release() { schedulerCalls.release += 1; return true; },
  };
  const bridged = await executeScheduledPipeline({ mode: "execute", authorized: true, testNamespace: "test:composition", triggerId: "test:composition:one", now: new Date("2026-09-21T10:00:00.000Z"), hours: 48, repository: schedulerRepository, readQuota: async () => ({ dailyLimit: 20, used: 0, remaining: 20 }), pipelineFactory: (options) => { bridgeFactoryOptions = options; return pipeline; } });
  assert.equal(bridged.pipelineInvoked, true);
  assert.equal(bridged.finalEventState, "READY_FOR_PUBLICATION_DRY_RUN");
  assert.equal(schedulerCalls.acquire, 1);
  assert.equal(schedulerCalls.finishExecution, 1);
  assert.equal(schedulerCalls.release, 1);
  assert.deepEqual(bridgeFactoryOptions.config, { hours: 48, limit: 1, dryRun: true, publish: false, trigger: "scheduled", automaticRevision: false, maxRevisionAttempts: 1 });
  console.log("pipeline:wiring:unit: OK (offline adapters, maxRetries=0, checkpoints, dry-run publisher)");
} finally {
  await rm(root, { recursive: true, force: true });
}
