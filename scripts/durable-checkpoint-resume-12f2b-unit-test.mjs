import assert from "node:assert/strict";
import { atomicHumanReviewGateway } from "./fixtures/atomic-human-review-gateway.mjs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { buildTranslatorModelInput } from "../lib/agents/translator/translator-input.ts";
import { buildEditorInput } from "../lib/agents/editor/editor-input.ts";
import { buildClassifierInput } from "../lib/agents/classifier/classifier-input.ts";
import { buildRankerPipelineInput } from "../lib/agents/ranker/ranker-input.ts";
import { buildCriticInput, buildCriticModelInput, buildCriticSourceEvidence } from "../lib/agents/critic/critic-input.ts";
import { criticInputSchema } from "../lib/agents/critic/critic-types.ts";
import { buildPipelinePublicationPayload } from "../lib/agents/publisher/publication-payload.ts";
import { buildHumanReviewSnapshot } from "../lib/agents/publisher/human-review.ts";
import { writeTranslatorCheckpointAtomic, readSafeTranslatorCheckpoint } from "../lib/agents/translator/translator-checkpoint.ts";
import { writeTranslatorEditorCheckpointAtomic, readSafeTranslatorEditorCheckpoint } from "../lib/agents/editor/translator-editor-checkpoint.ts";
import { writeClassifierPipelineCheckpointAtomic, readSafeClassifierPipelineCheckpoint } from "../lib/agents/classifier/classifier-pipeline-checkpoint.ts";
import { buildRankerPipelineCheckpoint, writeRankerPipelineCheckpointAtomic, readSafeRankerPipelineCheckpoint } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";
import { buildCriticPipelineCheckpoint, writeCriticPipelineCheckpointAtomic, readSafeCriticPipelineCheckpoint } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { AgentError } from "../lib/agents/runtime/agent-errors.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, createStaticPipelineQuota, assessCapacityResume, checkpointSha256, readCapacityResumeSnapshot, writeCapacityResumeSnapshot } from "../lib/agents/pipeline/index.ts";

const stages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"];
const root = await mkdtemp(join(tmpdir(), "horizai-durable-checkpoint-12f2b-"));

function makeSourceContext() {
  const event = structuredClone(validFixtures.ClusteredEvent);
  const item = structuredClone(validFixtures.ExtractedItem);
  item.metadata.sourceId = event.sourceItems[0].sourceId;
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
  const translatorSources = [{
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    sourceItemId: source.sourceItemId,
    language: "en",
    sourceType: "official",
    countryCode: "US",
  }];
  const editorSources = [{ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: source.sourceUrl, sourceType: "official" }];
  return { event, item, source, translatorSources, editorSources };
}

function timestamp() { return "2026-10-07T20:00:00.000Z"; }

function telemetry(stage) {
  return {
    status: "SUCCESS", provider: "groq", providerUnit: "tokens", providerUnitUsageKnown: true,
    actualProviderUnitUsage: 10, providerRequestDispatched: true, errorCategory: null, rateLimitHeaders: null,
    providerHttpStatus: 200, model: "offline-synthetic", agentVersion: `${stage}-fixture-v1`,
    structuredOutputMode: "strict_schema", reasoningEffort: null, includeReasoning: false, finishReason: "stop",
    providerRequestsUsed: 1, attempts: 1, retries: 0, latencyMs: 1, inputTokens: 6, outputTokens: 4, totalTokens: 10,
    requestBytes: 100, responseBytes: 100, zodValid: true, startedAt: timestamp(), finishedAt: timestamp(),
  };
}

function wrapFixture(fixture, { checkpointRoot, deferAt = null } = {}) {
  for (const stage of stages) {
    const original = fixture.stages[stage];
    fixture.stages[stage] = async (...args) => {
      if (stage === deferAt) {
        fixture.calls.push(stage);
        throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "synthetic pre-dispatch capacity stop", undefined, {
          providerRequestDispatched: false,
          failureKind: "PROVIDER_CAPACITY_EXHAUSTED",
        });
      }
      const outcome = await original(...args);
      const [context] = args;
      const path = join(checkpointRoot, `${context.event.eventKey}-${stage}.json`);
      return {
        ...outcome,
        telemetry: telemetry(stage),
        provider: "groq",
        checkpoint: async () => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, `${JSON.stringify({ stage, eventKey: context.event.eventKey, output: outcome.output }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
          return { stage, eventKey: context.event.eventKey, path, written: true, readable: true, valid: true };
        },
      };
    };
  }
  return fixture;
}

async function resumeChild(inputPath) {
  const run = JSON.parse(await readFile(inputPath, "utf8"));
  const loaded = await readCapacityResumeSnapshot(run.snapshotPath);
  const snapshot = loaded.snapshot;
  const hashes = await checkpointSha256(snapshot.checkpoints);
  const evidence = {
    attempt: {
      attemptId: run.attempt.id,
      eventKey: run.attempt.eventKey,
      pipelineRunId: run.attempt.pipelineRunId,
      completedAt: run.attempt.completedAt,
      finalState: run.attempt.finalState,
      stopStage: run.attempt.stopStage,
      stopReason: run.attempt.stopReason,
      countsTowardRetryLimit: run.attempt.countsTowardRetryLimit,
    },
    currentEvent: snapshot.event,
    currentSources: snapshot.sources,
    currentItems: snapshot.items,
    currentCheckpointSha256: hashes,
    nextStageDispatchCount: 0,
    nextStageCheckpointPresent: false,
    unresolvedProviderUsage: false,
    activeOwner: false,
    terminalEditorialRejection: false,
  };
  const registry = new InMemoryPipelineEventAttemptRegistry([run.attempt]);
  const fixture = wrapFixture(createOfflineStages(), { checkpointRoot: run.checkpointRoot });
  const orchestrator = new PipelineOrchestrator({
    stages: fixture.stages,
    quota: createStaticPipelineQuota(20),
    attemptRegistry: registry,
    humanReviewGateway: atomicHumanReviewGateway(registry),
    now: () => new Date(timestamp()),
    runId: run.attempt.pipelineRunId,
    config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
    capacityResumeSnapshotWriter: async (value) => writeCapacityResumeSnapshot(value, join(run.snapshotRoot, `${value.eventKey}-${value.resumeStage}-g${value.resumeGeneration}.json`)),
  });
  const result = await orchestrator.resumeCapacityDeferred({ snapshot, evidence, ownerId: randomUUID() });
  process.stdout.write(JSON.stringify({
    finalState: result.finalState,
    firstStage: snapshot.resumeStage,
    calls: fixture.calls,
    requestsUsed: result.requestsUsed,
    publisherCalls: fixture.calls.filter((stage) => stage === "publisher").length,
    attemptRows: registry.snapshot(),
    priorHashesBefore: hashes,
    priorHashesAfter: await checkpointSha256(snapshot.checkpoints),
  }));
}

if (process.argv[2] === "--resume-child") {
  await resumeChild(process.argv[3]);
} else {
  try {
    const { event, item, source, translatorSources, editorSources } = makeSourceContext();
    const verification = structuredClone(validFixtures.VerificationResult);
    const translation = structuredClone(validFixtures.TranslationResult);
    const editorial = structuredClone(validFixtures.EditorialDraft);
    const classification = structuredClone(validFixtures.ClassificationResult);
    const rankingResult = structuredClone(validFixtures.RankingResult);
    const criticResult = structuredClone(validFixtures.CriticResult);
    const paths = Object.fromEntries(stages.map((stage) => [stage, join(root, `${stage}.json`)]));

    const translatorInput = { schemaVersion: 1, event, verification, sourceLanguage: "en", sources: translatorSources };
    const verifierCheckpoint = {
      schemaVersion: 1, eventKey: event.eventKey, event, verification, sourceLanguage: "en", sources: translatorSources,
      translatorModelInput: buildTranslatorModelInput(translatorInput).input,
    };
    await writeTranslatorCheckpointAtomic(verifierCheckpoint, paths.verifier);
    const loadedVerifier = await readSafeTranslatorCheckpoint(paths.verifier);
    assert.deepEqual(buildTranslatorModelInput({ ...translatorInput, verification: loadedVerifier.verification }).input, verifierCheckpoint.translatorModelInput);

    const translatorCheckpoint = { ...verifierCheckpoint, translationResult: translation };
    await writeTranslatorCheckpointAtomic(translatorCheckpoint, paths.translator);
    const loadedTranslator = await readSafeTranslatorCheckpoint(paths.translator);
    assert.deepEqual(loadedTranslator.translationResult, translation);
    const editorInput = buildEditorInput({ event: { eventKey: event.eventKey, canonicalTitle: event.canonicalTitle }, verification: loadedTranslator.verification, translation: loadedTranslator.translationResult, sources: editorSources });
    assert.ok(editorInput);

    const editorCheckpoint = {
      schemaVersion: 1, eventKey: event.eventKey, canonicalTitle: event.canonicalTitle, event, verification,
      translation, editorial, sources: editorSources,
    };
    await writeTranslatorEditorCheckpointAtomic(editorCheckpoint, paths.editor);
    const loadedEditor = await readSafeTranslatorEditorCheckpoint(paths.editor);
    assert.deepEqual(loadedEditor.editorial, editorial);
    assert.equal(loadedEditor.editorial.eventKey, event.eventKey);
    const classifierInput = buildClassifierInput({
      event: { eventKey: event.eventKey, canonicalTitle: event.canonicalTitle },
      verification: loadedEditor.verification,
      translation: loadedEditor.translation,
      editorial: loadedEditor.editorial,
      sources: [{ sourceName: source.sourceName, sourceType: source.sourceType, countryCode: source.countryCode }],
    });
    assert.ok(classifierInput);

    const classifierCheckpoint = {
      schemaVersion: 1, eventKey: event.eventKey, canonicalTitle: event.canonicalTitle,
      event: { eventKey: event.eventKey, canonicalTitle: event.canonicalTitle, sourceCount: 1, occurredAt: event.probableOccurredAt, latestPublishedAt: event.sourceItems[0].publishedAt },
      verification,
      translation: { schemaVersion: 1, eventKey: event.eventKey, sourceLanguage: "en", targetLanguage: "es", translatedTitle: translation.translatedTitle, translatedFacts: translation.translatedFacts, preservedNames: translation.preservedNames, translationNotes: translation.translationNotes },
      editorial: { schemaVersion: 1, eventKey: event.eventKey, headlineEs: editorial.headlineEs, summaryEs: editorial.summaryEs, whyItMattersEs: editorial.whyItMattersEs, keyPoints: editorial.keyPoints },
      classification, sources: translatorSources, createdAt: timestamp(),
    };
    await writeClassifierPipelineCheckpointAtomic(classifierCheckpoint, paths.classifier);
    const loadedClassifier = await readSafeClassifierPipelineCheckpoint(paths.classifier);
    const rankerInput = buildRankerPipelineInput({
      event: loadedClassifier.event, verification: loadedClassifier.verification,
      translation: loadedClassifier.translation, editorial: loadedClassifier.editorial,
      classification: loadedClassifier.classification,
    });
    assert.ok(rankerInput);

    const ranking = {
      result: rankingResult, formulaVersion: "ranker-v1", momentumAvailable: true,
      deterministicSignals: { credibility: 88, reach: 63, momentum: 66, sourceCount: 1, contradictionPenalty: 0, uncertaintyPenalty: 0, geographicReachSignal: 0 },
    };
    const criticInput = buildCriticInput({
      event: { eventKey: event.eventKey, canonicalTitle: event.canonicalTitle, sourceCount: 1, occurredAt: event.probableOccurredAt, latestPublishedAt: event.sourceItems[0].publishedAt },
      verification, translation, editorial, classification, ranking, sources: translatorSources,
      sourceEvidence: buildCriticSourceEvidence([source], [item]),
      geo: { latitude: 39.8283, longitude: -98.5795, resolutionLevel: "region", resolvedFrom: "region_registry" },
    });
    const rankerCheckpoint = buildRankerPipelineCheckpoint(criticInput, ranking, timestamp());
    await writeRankerPipelineCheckpointAtomic(rankerCheckpoint, paths.ranker);
    const loadedRanker = await readSafeRankerPipelineCheckpoint(paths.ranker);
    const loadedCriticInput = criticInputSchema.parse({
      schemaVersion: 1, event: loadedRanker.event, verification: loadedRanker.verification, translation: loadedRanker.translation,
      editorial: loadedRanker.editorial, classification: loadedRanker.classification, ranking: loadedRanker.ranking,
      sources: loadedRanker.sources, sourceEvidence: loadedRanker.sourceEvidence, geo: loadedRanker.geo,
    });
    assert.ok(buildCriticModelInput(loadedCriticInput).input);

    const sourceLineage = [{
      sourceId: source.sourceId, sourceItemId: source.sourceItemId, rawItemId: source.rawItemId, sourceName: source.sourceName,
      contentHash: item.contentHash, canonicalUrl: item.canonicalUrl, publishedAt: event.sourceItems[0].publishedAt,
    }];
    const accounting = Object.fromEntries(stages.map((stage) => {
      const value = telemetry(stage);
      return [stage, {
        provider: "groq", model: value.model, requestCount: 1, attempts: 1, retries: 0,
        providerRequestDispatched: true, providerUnit: "tokens", providerUnitUsageKnown: true,
        actualProviderUnitUsage: 10, inputTokens: 6, outputTokens: 4, totalTokens: 10, settlement: "SETTLED",
      }];
    }));
    const reviewAttemptId = randomUUID();
    const criticCheckpoint = buildCriticPipelineCheckpoint(loadedRanker, criticResult, timestamp(), {
      canonicalEvent: event, sourceLineage, providerAccounting: accounting,
    }, reviewAttemptId);
    await writeCriticPipelineCheckpointAtomic(criticCheckpoint, paths.critic);
    const loadedCritic = await readSafeCriticPipelineCheckpoint(paths.critic);
    assert.deepEqual(loadedCritic.critic, criticResult);
    assert.deepEqual(loadedCritic.reviewPackageContext.sourceLineage, sourceLineage);
    assert.deepEqual(Object.keys(loadedCritic.reviewPackageContext.providerAccounting), stages);
    const resumedReviewContext = {
      event: loadedCritic.reviewPackageContext.canonicalEvent,
      items: [],
      sources: loadedCritic.sources.map((entry) => {
        const lineage = loadedCritic.reviewPackageContext.sourceLineage.find((sourceEntry) => sourceEntry.sourceItemId === entry.sourceItemId);
        return { ...entry, sourceUrl: lineage.canonicalUrl, rawItemId: lineage.rawItemId };
      }),
      verification: loadedCritic.verification,
      translation: loadedCritic.translation,
      editorial: loadedCritic.editorial,
      classification: loadedCritic.classification,
      geo: {
        eventKey: loadedCritic.eventKey,
        primaryRegionCode: loadedCritic.classification.primaryRegionCode,
        countryCodes: loadedCritic.classification.countryCodes,
        latitude: loadedCritic.geo.latitude,
        longitude: loadedCritic.geo.longitude,
        resolutionLevel: loadedCritic.geo.resolutionLevel,
        resolvedFrom: loadedCritic.geo.resolvedFrom,
        provenance: loadedCritic.geo.resolvedFrom ? "reference_registry" : "unresolved",
      },
      ranking: loadedCritic.ranking.result,
      critic: loadedCritic.critic,
    };
    const reviewRunId = randomUUID();
    const reviewCheckpoints = Object.fromEntries(stages.map((stage) => [stage, {
      stage, eventKey: event.eventKey, path: paths[stage], written: true, readable: true, valid: true,
    }]));
    const reconstructedReview = await buildHumanReviewSnapshot({
      context: resumedReviewContext,
      run: { schemaVersion: 1, runId: reviewRunId, dryRun: true, startedAt: timestamp(), trigger: "manual", agentVersions: {} },
      attemptId: reviewAttemptId,
      checkpoints: reviewCheckpoints,
      providerAccounting: {},
      durableProviderAccounting: loadedCritic.reviewPackageContext.providerAccounting,
      durableSourceLineage: loadedCritic.reviewPackageContext.sourceLineage,
      publicationPayload: buildPipelinePublicationPayload(resumedReviewContext),
      sourceRegistryUrls: new Map([[source.sourceId, source.sourceUrl]]),
      checkpointRoot: root,
    });
    assert.equal(reconstructedReview.artifact.eventKey, event.eventKey);
    assert.equal(reconstructedReview.artifact.sourceLineage[0].content_hash, item.contentHash);

    const legacyEditorPath = join(root, "legacy-editor-without-payload.json");
    const legacyEditor = structuredClone(loadedEditor);
    delete legacyEditor.editorial;
    await writeFile(legacyEditorPath, JSON.stringify(legacyEditor), "utf8");
    const loadedLegacyEditor = await readSafeTranslatorEditorCheckpoint(legacyEditorPath);
    assert.equal(loadedLegacyEditor.editorial, undefined, "legacy payload remains absent and cannot be reused by the resume guard");
    assert.equal(loadedEditor.editorial.eventKey, event.eventKey);

    const durableResumeResults = [];
    const scriptPath = fileURLToPath(import.meta.url);
    for (const deferAt of ["classifier", "ranker", "critic"]) {
      const scenarioRoot = join(root, `scenario-${deferAt}`);
      const checkpointRoot = join(scenarioRoot, "checkpoints");
      const snapshotRoot = join(scenarioRoot, "snapshots");
      const attemptRunId = randomUUID();
      const initialFixture = wrapFixture(createOfflineStages(), { checkpointRoot, deferAt });
      const attemptRegistry = new InMemoryPipelineEventAttemptRegistry();
      const orchestrator = new PipelineOrchestrator({
        stages: initialFixture.stages, quota: createStaticPipelineQuota(20), attemptRegistry,
        humanReviewGateway: atomicHumanReviewGateway(attemptRegistry),
        runId: attemptRunId, now: () => new Date(timestamp()),
        config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
        capacityResumeSnapshotWriter: async (value) => writeCapacityResumeSnapshot(value, join(snapshotRoot, `${value.eventKey}-${value.resumeStage}-g${value.resumeGeneration}.json`)),
      });
      const firstRun = await orchestrator.run();
      assert.equal(firstRun.eventResults[0].finalState, "DEFERRED_PROVIDER_CAPACITY", `defer before ${deferAt}`);
      assert.equal(firstRun.eventResults[0].stopStage, deferAt);
      assert.ok(firstRun.eventResults[0].capacityResumeSnapshotPath);
      const [attempt] = attemptRegistry.snapshot();
      assert.ok(attempt);
      assert.equal(attempt.id, attemptRegistry.snapshot()[0].id);
      assert.equal(attempt.attemptNumber, 1);
      assert.equal(attempt.countsTowardRetryLimit, false);
      assert.equal(attempt.finalState, null);
      assert.equal(attempt.stopReason, "PROVIDER_CAPACITY_EXHAUSTED");
      const persistedSnapshot = (await readCapacityResumeSnapshot(firstRun.eventResults[0].capacityResumeSnapshotPath)).snapshot;
      const persistedHashes = await checkpointSha256(persistedSnapshot.checkpoints);
      const baseEvidence = {
        attempt: { attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, completedAt: null, finalState: null, stopStage: attempt.stopStage, stopReason: attempt.stopReason, countsTowardRetryLimit: attempt.countsTowardRetryLimit },
        currentEvent: persistedSnapshot.event, currentSources: persistedSnapshot.sources, currentItems: persistedSnapshot.items,
        currentCheckpointSha256: persistedHashes, nextStageDispatchCount: 0, nextStageCheckpointPresent: false,
        unresolvedProviderUsage: false, activeOwner: false, terminalEditorialRejection: false,
      };
      assert.equal(assessCapacityResume(persistedSnapshot, baseEvidence).valid, true, `valid ${deferAt} snapshot is resumable`);
      const lastCompletedStage = Object.keys(persistedHashes).at(-1);
      const negativeCases = [
        ["missing editorial payload", { ...persistedSnapshot, editorial: undefined }, baseEvidence],
        ["invalid editor payload schema", { ...persistedSnapshot, editorial: { ...persistedSnapshot.editorial, eventKey: "mismatched-event" } }, baseEvidence],
        ["changed checkpoint hash", persistedSnapshot, { ...baseEvidence, currentCheckpointSha256: { ...persistedHashes, [lastCompletedStage]: "f".repeat(64) } }],
        ["unsettled provider usage", persistedSnapshot, { ...baseEvidence, unresolvedProviderUsage: true }],
        ["changed source/raw lineage", persistedSnapshot, { ...baseEvidence, currentSources: persistedSnapshot.sources.map((value, index) => index === 0 ? { ...value, rawItemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } : value) }],
        ["changed event", persistedSnapshot, { ...baseEvidence, currentEvent: { ...persistedSnapshot.event, canonicalTitle: "changed" } }],
        ["changed attempt", persistedSnapshot, { ...baseEvidence, attempt: { ...baseEvidence.attempt, attemptId: randomUUID() } }],
        ["next stage dispatched", persistedSnapshot, { ...baseEvidence, nextStageDispatchCount: 1 }],
        ["next stage checkpoint exists", persistedSnapshot, { ...baseEvidence, nextStageCheckpointPresent: true }],
        ["another owner active", persistedSnapshot, { ...baseEvidence, activeOwner: true }],
        ["terminal verification rejection", persistedSnapshot, { ...baseEvidence, terminalEditorialRejection: true }],
      ];
      for (const [label, snapshotValue, evidence] of negativeCases) {
        assert.equal(assessCapacityResume(snapshotValue, evidence).valid, false, `${label} blocks ${deferAt} resume`);
      }
      const childInputPath = join(scenarioRoot, "resume-input.json");
      await mkdir(scenarioRoot, { recursive: true });
      await writeFile(childInputPath, JSON.stringify({
        snapshotPath: firstRun.eventResults[0].capacityResumeSnapshotPath,
        checkpointRoot, snapshotRoot, attempt,
      }), "utf8");
      const child = spawnSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", scriptPath, "--resume-child", childInputPath], {
        cwd: process.cwd(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      });
      assert.equal(child.status, 0, `fresh child resume before ${deferAt}: ${child.stderr}`);
      const resumed = JSON.parse(child.stdout.trim());
      assert.equal(resumed.finalState, "WAITING_FOR_HUMAN_REVIEW");
      assert.equal(resumed.firstStage, deferAt);
      assert.equal(resumed.publisherCalls, 0);
      assert.ok(resumed.attemptRows.length === 1, "fresh process did not create a duplicate attempt");
      assert.equal(resumed.attemptRows[0].id, attempt.id);
      assert.equal(resumed.attemptRows[0].attemptNumber, 1);
      assert.equal(resumed.attemptRows[0].finalState, "WAITING_FOR_HUMAN_REVIEW");
      assert.deepEqual(resumed.priorHashesAfter, resumed.priorHashesBefore, "previous checkpoint bytes remain unchanged through resume");
      const expectedCalls = deferAt === "classifier" ? ["classifier", "geo", "ranker", "critic"] : deferAt === "ranker" ? ["ranker", "critic"] : ["critic"];
      assert.deepEqual(resumed.calls, expectedCalls, `only first missing stage and downstream ran after ${deferAt}`);
      durableResumeResults.push({ deferAt, result: resumed, expectedCalls });
    }

    const testReport = {
      stageRoundtrips: {
        verifier: "PASS",
        translator: "PASS",
        editor: "PASS",
        classifier: "PASS",
        ranker: "PASS",
        critic: "PASS",
      },
      editorOutputPersistedAndClassifierInputBuilt: true,
      historicalEditorEditorialAbsent: true,
      criticReviewContextPersisted: true,
      reviewPackageRebuiltFromCriticCheckpoint: true,
      capacityDefers: durableResumeResults.map(({ deferAt, result }) => ({ stage: deferAt, freshProcessResume: result.finalState === "WAITING_FOR_HUMAN_REVIEW", calls: result.calls, sameAttempt: result.attemptRows.length === 1, publisherCalls: result.publisherCalls })),
      providerCalls: 0,
      historicalAttemptModified: false,
    };
    console.log(JSON.stringify(testReport));
  } finally {
    const resolvedRoot = resolve(root);
    if (!resolvedRoot.startsWith(resolve(tmpdir()))) throw new Error("DURABLE_CHECKPOINT_TEST_TEMP_PATH_INVALID");
    await rm(root, { recursive: true, force: true });
  }
}
