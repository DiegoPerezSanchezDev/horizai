import assert from "node:assert/strict";
import { atomicHumanReviewGateway } from "./fixtures/atomic-human-review-gateway.mjs";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildEditorInput, buildEditorModelInput } from "../lib/agents/editor/editor-input.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, assessCapacityResume, createStaticPipelineQuota } from "../lib/agents/pipeline/index.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { readSafeTranslatorCheckpoint, writeTranslatorCheckpointAtomic } from "../lib/agents/translator/translator-checkpoint.ts";
import { buildTranslatorModelInput } from "../lib/agents/translator/translator-input.ts";

const incident = {
  attemptId: "dfada4fd-d9c6-4aa8-bfef-6d9447267e06",
  pipelineRunId: "3aa65ec9-448f-42ea-b53c-39bc24c70fb8",
  eventKey: "event-0c4ed88cddcd4f96c3d6f2983ced7de7",
};
const checkpointScript = fileURLToPath(import.meta.url);

async function prepareEditorFromPersistedCheckpoints(verifierPath, translatorPath) {
  const [verifier, translator] = await Promise.all([
    readSafeTranslatorCheckpoint(verifierPath),
    readSafeTranslatorCheckpoint(translatorPath),
  ]);
  assert.equal(verifier.translationResult, undefined);
  assert.ok(translator.translationResult);
  assert.equal(verifier.eventKey, translator.eventKey);
  assert.deepEqual(verifier.event, translator.event);
  assert.deepEqual(verifier.verification, translator.verification);

  const sourceMetadata = new Map(translator.sources.map((source) => [source.sourceItemId, source]));
  const editorSources = translator.event.sourceItems.map((item) => {
    const metadata = sourceMetadata.get(item.candidateId);
    assert.ok(metadata, "every persisted event source has Translator checkpoint metadata");
    assert.equal(metadata.sourceId, item.sourceId);
    assert.ok(item.url);
    return {
      sourceId: item.sourceId,
      sourceName: metadata.sourceName,
      canonicalUrl: item.url,
      sourceType: metadata.sourceType,
    };
  });
  const editorInput = buildEditorInput({
    event: { eventKey: translator.event.eventKey, canonicalTitle: translator.event.canonicalTitle },
    verification: translator.verification,
    translation: translator.translationResult,
    sources: editorSources,
  });
  const built = buildEditorModelInput(editorInput);
  assert.ok(built.inputChars > 0);
  const checkpointHashes = {
    verifier: createHash("sha256").update(await readFile(verifierPath)).digest("hex"),
    translator: createHash("sha256").update(await readFile(translatorPath)).digest("hex"),
  };
  return {
    status: "PROVIDER_DISPATCH_READY",
    verifierReused: true,
    translatorReused: true,
    candidateCount: translator.event.sourceItems.length,
    editorInputChars: built.inputChars,
    checkpointHashes,
    verifierEventKeyMatches: verifier.eventKey === incident.eventKey,
    translatorEventKeyMatches: translator.eventKey === incident.eventKey,
  };
}

if (process.argv[2] === "--checkpoint-child") {
  const prepared = await prepareEditorFromPersistedCheckpoints(process.argv[3], process.argv[4]);
  process.stdout.write(JSON.stringify(prepared));
} else {
  const checkpointRoot = await mkdtemp(join(tmpdir(), "horizai-recovery-checkpoints-"));
  try {
  const persistedEvent = structuredClone(validFixtures.ClusteredEvent);
  persistedEvent.eventKey = incident.eventKey;
  const persistedVerification = { ...structuredClone(validFixtures.VerificationResult), eventKey: incident.eventKey };
  const persistedTranslation = { ...structuredClone(validFixtures.TranslationResult), eventKey: incident.eventKey };
  const persistedSources = persistedEvent.sourceItems.map((item) => ({
    sourceId: item.sourceId, sourceItemId: item.candidateId, sourceName: item.sourceName,
    language: "en", sourceType: "official", countryCode: "US",
  }));
  const verifierCheckpoint = {
    schemaVersion: 1, eventKey: incident.eventKey, event: persistedEvent,
    verification: persistedVerification, sourceLanguage: "en", sources: persistedSources,
    translatorModelInput: buildTranslatorModelInput({
      schemaVersion: 1, event: persistedEvent, verification: persistedVerification,
      sourceLanguage: "en", sources: persistedSources,
    }).input,
  };
  incident.verifierPath = join(checkpointRoot, "verifier.json");
  incident.translatorPath = join(checkpointRoot, "translator.json");
  await writeTranslatorCheckpointAtomic(verifierCheckpoint, incident.verifierPath);
  await writeTranslatorCheckpointAtomic({ ...verifierCheckpoint, translationResult: persistedTranslation }, incident.translatorPath);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", checkpointScript, "--checkpoint-child", incident.verifierPath, incident.translatorPath], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(child.status, 0, "fresh-process checkpoint replay completes without provider dispatch");
  const checkpointResult = JSON.parse(child.stdout);
  assert.equal(checkpointResult.status, "PROVIDER_DISPATCH_READY");
  assert.equal(checkpointResult.verifierReused, true);
  assert.equal(checkpointResult.translatorReused, true);
  assert.equal(checkpointResult.verifierEventKeyMatches, true);
  assert.equal(checkpointResult.translatorEventKeyMatches, true);
  assert.match(checkpointResult.checkpointHashes.verifier, /^[a-f0-9]{64}$/);
  assert.match(checkpointResult.checkpointHashes.translator, /^[a-f0-9]{64}$/);

  const event = structuredClone(validFixtures.ClusteredEvent);
  event.eventKey = incident.eventKey;
  const item = structuredClone(validFixtures.ExtractedItem);
  item.metadata.sourceId = event.sourceItems[0].sourceId;
  const source = {
    sourceId: event.sourceItems[0].sourceId,
    sourceItemId: event.sourceItems[0].candidateId,
    rawItemId: randomUUID(),
    sourceName: event.sourceItems[0].sourceName,
    sourceUrl: item.canonicalUrl,
    sourceType: "official",
    countryCode: "US",
    language: "en",
  };
  const verification = { ...structuredClone(validFixtures.VerificationResult), eventKey: incident.eventKey };
  const translation = { ...structuredClone(validFixtures.TranslationResult), eventKey: incident.eventKey };
  const checkpoint = (stage, hash) => ({ stage, eventKey: incident.eventKey, path: `memory://${stage}/${incident.eventKey}`, written: true, readable: true, valid: true, sha256: hash });
  const verifierHash = "a".repeat(64);
  const translatorHash = "b".repeat(64);
  const tokenTelemetry = (stage) => ({
    status: "SUCCESS", provider: "groq", providerUnit: "tokens", providerUnitUsageKnown: true,
    providerRequestDispatched: true, providerRequestsUsed: 1, attempts: 1, retries: 0,
    inputTokens: 100, outputTokens: 50, totalTokens: 150,
    agentVersion: `${stage}-fixture-v1`, model: "offline-synthetic", latencyMs: 1,
    startedAt: "2026-10-09T00:00:00.000Z", finishedAt: "2026-10-09T00:00:00.001Z",
  });
  const snapshot = {
    schemaVersion: 1,
    kind: "SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME",
    attemptId: incident.attemptId,
    pipelineRunId: incident.pipelineRunId,
    eventKey: incident.eventKey,
    resumeStage: "editor",
    event,
    items: [item],
    sources: [source],
    verification,
    translation,
    checkpoints: { verifier: checkpoint("verifier", verifierHash), translator: checkpoint("translator", translatorHash) },
    checkpointSha256: { verifier: verifierHash, translator: translatorHash },
    providerAccounting: { verifier: tokenTelemetry("verifier"), translator: tokenTelemetry("translator") },
    nextStageDispatchCount: 0,
    nextStageCheckpointPresent: false,
    resumeGeneration: 0,
  };
  const attempt = {
    id: incident.attemptId,
    eventKey: incident.eventKey,
    pipelineRunId: incident.pipelineRunId,
    attemptNumber: 1,
    startedAt: "2026-10-09T00:00:00.000Z",
    completedAt: null,
    finalState: null,
    stopStage: "editor",
    stopReason: "PROVIDER_CAPACITY_EXHAUSTED",
    retryClass: "NONE",
    countsTowardRetryLimit: false,
    nextEligibleAt: null,
    createdAt: "2026-10-09T00:00:00.000Z",
    capacityResumeSnapshot: snapshot,
  };
  const evidence = {
    attempt: { attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, completedAt: null, finalState: null, stopStage: "editor", stopReason: "PROVIDER_CAPACITY_EXHAUSTED", countsTowardRetryLimit: false },
    currentEvent: structuredClone(event),
    currentSources: [structuredClone(source)],
    currentItems: [structuredClone(item)],
    currentCheckpointSha256: { verifier: verifierHash, translator: translatorHash },
    nextStageDispatchCount: 0,
    nextStageCheckpointPresent: false,
    unresolvedProviderUsage: false,
    activeOwner: false,
    terminalEditorialRejection: false,
  };
  const assessment = assessCapacityResume(snapshot, evidence, { ownerId: "synthetic-editor-resume" });
  assert.equal(assessment.valid, true);
  assert.equal(assessment.firstStage, "editor");
  assert.equal(assessment.previousModelCallsToRepeat, 0);

  const fixture = createOfflineStages();
  const providerStages = ["editor", "classifier", "ranker", "critic"];
  for (const stage of providerStages) {
    const original = fixture.stages[stage];
    fixture.stages[stage] = async (...args) => {
      const outcome = await original(...args);
      return { ...outcome, providerRequestsUsed: 0, attempts: 0, retries: 0, telemetry: undefined };
    };
  }
  const attempts = new InMemoryPipelineEventAttemptRegistry([attempt]);
  const orchestrator = new PipelineOrchestrator({
    stages: fixture.stages,
    quota: createStaticPipelineQuota(20),
    attemptRegistry: attempts,
    humanReviewGateway: atomicHumanReviewGateway(attempts),
    runId: incident.pipelineRunId,
    config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
  });
  const result = await orchestrator.resumeCapacityDeferred({ snapshot, evidence, ownerId: "synthetic-editor-resume" });
  assert.equal(result.finalState, "WAITING_FOR_HUMAN_REVIEW");
  assert.equal(result.requestsUsed, 0);
  assert.deepEqual(fixture.calls, ["editor", "classifier", "geo", "ranker", "critic"]);
  assert.equal(fixture.calls.includes("verifier"), false);
  assert.equal(fixture.calls.includes("translator"), false);
  assert.equal(fixture.calls.includes("discovery"), false);
  assert.equal(fixture.calls.includes("publisher"), false);
  assert.equal(attempts.snapshot().length, 1);
  assert.equal(attempts.snapshot()[0].id, incident.attemptId);
  assert.equal(attempts.snapshot()[0].attemptNumber, 1);
  assert.equal(attempts.snapshot()[0].finalState, "WAITING_FOR_HUMAN_REVIEW");

  console.log("12F.3 recovery regression: PASS (fresh-process checkpoint reuse, Editor first stage, zero duplicate stages, same synthetic attempt, zero provider requests, supervised review stop)");
  } finally {
    assert.equal(dirname(resolve(checkpointRoot)), resolve(tmpdir()));
    assert.ok(basename(checkpointRoot).startsWith("horizai-recovery-checkpoints-"));
    await rm(checkpointRoot, { recursive: true, force: true });
  }
}
