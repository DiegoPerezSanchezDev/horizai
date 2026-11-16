import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  nodeCheckpointFileSystem,
  parseSafeTranslatorCheckpoint,
  readSafeTranslatorCheckpoint,
  translatorCheckpointSchema,
  writeTranslatorCheckpointAtomic,
} from "../lib/agents/translator/translator-checkpoint.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const eventKey = "checkpoint-fixture-event";
const checkpoint = {
  schemaVersion: 1,
  eventKey,
  event: {
    schemaVersion: 1,
    eventKey,
    canonicalTitle: "Checkpoint fixture",
    sourceItems: [{
      candidateId: "fixture-item",
      sourceId,
      sourceName: "Fixture source",
      url: "https://example.com/fixture",
      title: "Checkpoint fixture",
      publishedAt: "2026-09-14T08:00:00Z",
    }],
    probableOccurredAt: "2026-09-14T08:00:00Z",
    probableCountryCode: "US",
    probableRegionCode: "US",
    clusterConfidence: 80,
  },
  verification: {
    schemaVersion: 1,
    eventKey,
    status: "single_source",
    confidenceScore: 70,
    primarySourceId: sourceId,
    supportingSourceIds: [],
    contradictions: [],
    verifiedFacts: [{ claim: "The model supports 128K tokens.", sourceIds: [sourceId] }],
    uncertainClaims: [],
    reason: "One fixture source supports the claim.",
  },
  sourceLanguage: "en",
  sources: [{
    sourceId,
    sourceName: "Fixture source",
    sourceItemId: "fixture-item",
    language: "en",
    sourceType: "technology_press",
    countryCode: "US",
  }],
  translatorModelInput: {
    schemaVersion: 1,
    eventKey,
    canonicalTitle: "Checkpoint fixture",
    sourceLanguage: "en",
    targetLanguage: "es",
    sources: [{ sourceId, sourceName: "Fixture source", sourceItemId: "fixture-item", language: "en" }],
    verifiedFacts: [{ claim: "The model supports 128K tokens.", sourceIds: [sourceId] }],
    uncertainClaims: [],
    contradictions: [],
  },
};

assert.doesNotThrow(() => translatorCheckpointSchema.parse(checkpoint));
assert.throws(() => parseSafeTranslatorCheckpoint(JSON.stringify({ ...checkpoint, raw_content: "<html>secret</html>" })), /prohibited fields/);
assert.throws(() => parseSafeTranslatorCheckpoint(JSON.stringify({ ...checkpoint, eventKey: "different" })), /Checkpoint identifiers/);

const root = await mkdtemp(join(tmpdir(), "horizai-checkpoint-"));
try {
  const target = join(root, "pipeline-verifier-checkpoint.json");
  const written = await writeTranslatorCheckpointAtomic(checkpoint, target);
  assert.equal(written.path, target);
  assert.ok(written.bytes > 0);
  const loaded = await readSafeTranslatorCheckpoint(target);
  assert.equal(loaded.eventKey, eventKey);
  assert.equal(loaded.verification.verifiedFacts.length, 1);
  await assert.rejects(access(`${target}.tmp`));

  const failingFileSystem = {
    ...nodeCheckpointFileSystem,
    async rename() { throw new Error("simulated disk failure"); },
  };
  const failedTarget = join(root, "failed-checkpoint.json");
  await assert.rejects(() => writeTranslatorCheckpointAtomic(checkpoint, failedTarget, failingFileSystem), /Unable to atomically write/);
  await assert.rejects(access(`${failedTarget}.tmp`));
  await assert.rejects(access(failedTarget));
} finally {
  await rm(root, { recursive: true, force: true });
}

const replaySource = await readFile("scripts/translator-replay-test.ts", "utf8");
assert.match(replaySource, /readSafeTranslatorCheckpoint/);
assert.match(replaySource, /maxRetries: 0/);
const classifierPipelineSource = await readFile("scripts/classifier-test.ts", "utf8");
const checkpointWritePosition = classifierPipelineSource.indexOf("writeTranslatorCheckpointAtomic");
const translatorCallPosition = classifierPipelineSource.indexOf("new TranslatorAgent(provider");
assert.ok(checkpointWritePosition >= 0);
assert.ok(translatorCallPosition > checkpointWritePosition);
console.log("Translator checkpoint unit fixtures passed");
