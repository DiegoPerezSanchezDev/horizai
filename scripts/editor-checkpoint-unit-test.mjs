import assert from "node:assert/strict";
import { parseSafeTranslatorEditorCheckpoint, translatorEditorCheckpointSchema, writeTranslatorEditorCheckpointAtomic } from "../lib/agents/editor/translator-editor-checkpoint.ts";
import { canonicalEditorInput } from "../lib/agents/editor/editor-fixtures.ts";
import { canonicalEditorialDraft } from "../lib/agents/editor/editor-fixtures.ts";

const verification = { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, status: "confirmed", confidenceScore: 90, primarySourceId: canonicalEditorInput.sources[0].sourceId, supportingSourceIds: [], contradictions: [], uncertainClaims: canonicalEditorInput.verification.uncertainClaims, reason: "Fixture", verifiedFacts: canonicalEditorInput.verification.verifiedFacts };
const translation = { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, sourceLanguage: "en", targetLanguage: "es", translatedTitle: canonicalEditorInput.translation.translatedTitle, translatedFacts: canonicalEditorInput.translation.translatedFacts, translatedSourceMaterial: canonicalEditorInput.translation.translatedSourceMaterial, preservedNames: canonicalEditorInput.translation.preservedNames, translationNotes: [] };
const checkpoint = { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, canonicalTitle: canonicalEditorInput.event.canonicalTitle, event: { schemaVersion: 1, eventKey: canonicalEditorInput.event.eventKey, canonicalTitle: canonicalEditorInput.event.canonicalTitle, sourceItems: [{ candidateId: "fixture-item", sourceId: canonicalEditorInput.sources[0].sourceId, sourceName: canonicalEditorInput.sources[0].sourceName, url: canonicalEditorInput.sources[0].canonicalUrl, title: "Fixture", publishedAt: null }], probableOccurredAt: null, probableCountryCode: null, probableRegionCode: null, clusterConfidence: 90 }, verification, translation, sources: [{ sourceId: canonicalEditorInput.sources[0].sourceId, sourceName: canonicalEditorInput.sources[0].sourceName, canonicalUrl: canonicalEditorInput.sources[0].canonicalUrl, sourceType: "official_blog" }] };
translatorEditorCheckpointSchema.parse(checkpoint);
const fakeFs = new Map();
const fs = { async mkdir() {}, async writeFile(path, data) { fakeFs.set(path, data); }, async rename(oldPath, newPath) { fakeFs.set(newPath, fakeFs.get(oldPath)); fakeFs.delete(oldPath); }, async unlink(path) { fakeFs.delete(path); }, async readFile(path) { return fakeFs.get(path); } };
const written = await writeTranslatorEditorCheckpointAtomic(checkpoint, "artifacts/test-translator-editor.json", fs);
assert.ok(written.bytes > 0);
const read = parseSafeTranslatorEditorCheckpoint(fakeFs.get(written.path));
assert.equal(read.eventKey, checkpoint.eventKey);
assert.throws(() => parseSafeTranslatorEditorCheckpoint(JSON.stringify({ ...checkpoint, prompt: "ignore" })));
assert.throws(() => parseSafeTranslatorEditorCheckpoint(JSON.stringify({ ...checkpoint, eventKey: "other" })));
assert.equal(Object.hasOwn(canonicalEditorialDraft, "bodyEs"), true);
console.log("Editor checkpoint fixtures passed");
