import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editorPipelineCheckpointSchema, parseSafeEditorPipelineCheckpoint, readSafeEditorPipelineCheckpoint, writeEditorPipelineCheckpointAtomic } from "../lib/agents/classifier/classifier-checkpoint.ts";
import { classifierPipelineCheckpointSchema, parseSafeClassifierPipelineCheckpoint, readSafeClassifierPipelineCheckpoint, writeClassifierPipelineCheckpointAtomic } from "../lib/agents/classifier/classifier-pipeline-checkpoint.ts";
import { classifierFixtures } from "../lib/agents/classifier/classifier-fixtures.ts";
import { canonicalEditorialDraft, canonicalEditorInput } from "../lib/agents/editor/editor-fixtures.ts";

const fixture = classifierFixtures[0];
const checkpoint = {
  schemaVersion: 1,
  eventKey: canonicalEditorInput.event.eventKey,
  canonicalTitle: canonicalEditorInput.event.canonicalTitle,
  verification: { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, ...canonicalEditorInput.verification, primarySourceId: canonicalEditorInput.sources[0].sourceId, supportingSourceIds: [], reason: "Checkpoint fixture", },
  translation: { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, sourceLanguage: "en", targetLanguage: "es", translatedTitle: canonicalEditorInput.translation.translatedTitle, translatedFacts: canonicalEditorInput.translation.translatedFacts, translatedSourceMaterial: canonicalEditorInput.translation.translatedSourceMaterial, preservedNames: canonicalEditorInput.translation.preservedNames, translationNotes: canonicalEditorInput.translation.translationNotes },
  editorial: canonicalEditorialDraft,
  sources: [{ sourceId: canonicalEditorInput.sources[0].sourceId, sourceName: canonicalEditorInput.sources[0].sourceName, sourceItemId: "fixture-editor-item", language: "en", sourceType: canonicalEditorInput.sources[0].sourceType, countryCode: "US" }],
};

assert.doesNotThrow(() => editorPipelineCheckpointSchema.parse(checkpoint));
assert.throws(() => parseSafeEditorPipelineCheckpoint(JSON.stringify({ ...checkpoint, raw_content: "forbidden" })), /prohibited fields/);
assert.throws(() => parseSafeEditorPipelineCheckpoint(JSON.stringify({ ...checkpoint, eventKey: "different" })), /identifiers/);
assert.throws(() => parseSafeEditorPipelineCheckpoint(JSON.stringify({ ...checkpoint, editorial: { ...checkpoint.editorial, reasoning: "forbidden" } })), /prohibited fields/);

const root = await mkdtemp(join(tmpdir(), "horizai-classifier-checkpoint-"));
try {
  const target = join(root, "pipeline-editor-checkpoint.json");
  const written = await writeEditorPipelineCheckpointAtomic(checkpoint, target);
  assert.ok(written.bytes > 0);
  const loaded = await readSafeEditorPipelineCheckpoint(target);
  assert.equal(loaded.eventKey, checkpoint.eventKey);
  assert.equal(loaded.editorial.eventKey, checkpoint.eventKey);
  await assert.rejects(access(`${target}.tmp`));
  const raw = await readFile(target, "utf8");
  assert.doesNotMatch(raw, /"(?:reasoning|api[_-]?key|authorization|chainofthought)"\s*:/i);
} finally {
  await rm(root, { recursive: true, force: true });
}

assert.equal(fixture.input.event.eventKey, "fixture-new-openai-model");

const classifierCheckpoint = {
  schemaVersion: 1,
  eventKey: canonicalEditorInput.event.eventKey,
  canonicalTitle: canonicalEditorInput.event.canonicalTitle,
  event: { eventKey: canonicalEditorInput.event.eventKey, canonicalTitle: canonicalEditorInput.event.canonicalTitle, sourceCount: 1, occurredAt: "2026-09-14T10:00:00.000Z", latestPublishedAt: "2026-09-14T10:00:00.000Z" },
  verification: checkpoint.verification,
  translation: { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, sourceLanguage: "en", targetLanguage: "es", translatedTitle: canonicalEditorInput.translation.translatedTitle, translatedFacts: canonicalEditorInput.translation.translatedFacts, preservedNames: canonicalEditorInput.translation.preservedNames, translationNotes: canonicalEditorInput.translation.translationNotes },
  editorial: { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, headlineEs: canonicalEditorialDraft.headlineEs, summaryEs: canonicalEditorialDraft.summaryEs, whyItMattersEs: canonicalEditorialDraft.whyItMattersEs, keyPoints: canonicalEditorialDraft.keyPoints },
  classification: { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, ...fixture.expected, latitude: 39.8283, longitude: -98.5795 },
  sources: checkpoint.sources,
  createdAt: "2026-09-14T10:00:00.000Z",
};
assert.doesNotThrow(() => classifierPipelineCheckpointSchema.parse(classifierCheckpoint));
assert.throws(() => parseSafeClassifierPipelineCheckpoint(JSON.stringify({ ...classifierCheckpoint, article: "forbidden" })), /unrecognized key|checkpoint/i);
const classifierRoot = await mkdtemp(join(tmpdir(), "horizai-classifier-pipeline-checkpoint-"));
try {
  const target = join(classifierRoot, "pipeline-classifier-checkpoint.json");
  const written = await writeClassifierPipelineCheckpointAtomic(classifierCheckpoint, target);
  assert.ok(written.bytes > 0);
  const loaded = await readSafeClassifierPipelineCheckpoint(target);
  assert.equal(loaded.eventKey, classifierCheckpoint.eventKey);
  assert.equal(loaded.classification.eventKey, classifierCheckpoint.eventKey);
  await assert.rejects(access(`${target}.tmp`));
} finally {
  await rm(classifierRoot, { recursive: true, force: true });
}

console.log("Classifier checkpoint unit fixtures passed");
