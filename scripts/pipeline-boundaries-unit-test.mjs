import assert from "node:assert/strict";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { editorInputSchema } from "../lib/agents/editor/editor-types.ts";
import { buildEditorInput } from "../lib/agents/editor/editor-input.ts";
import { classifierInputSchema } from "../lib/agents/classifier/classifier-types.ts";
import { buildClassifierInput } from "../lib/agents/classifier/classifier-input.ts";
import { rankerInputSchema } from "../lib/agents/ranker/ranker-types.ts";
import { buildRankerPipelineInput } from "../lib/agents/ranker/ranker-input.ts";
import { criticInputSchema } from "../lib/agents/critic/critic-types.ts";
import { buildCriticInput } from "../lib/agents/critic/critic-input.ts";
import { buildPublisherInputBoundary } from "../lib/agents/pipeline/pipeline-boundaries.ts";
import { publicationPayloadSchema } from "../lib/agents/contracts/index.ts";
import { buildPipelineSourceMetadata } from "../lib/agents/pipeline/create-production-pipeline.ts";

const eventKey = validFixtures.ClusteredEvent.eventKey;
const verification = { ...structuredClone(validFixtures.VerificationResult), eventKey };
const translation = { ...structuredClone(validFixtures.TranslationResult), eventKey };
const editorial = { ...structuredClone(validFixtures.EditorialDraft), eventKey };
const classification = { ...structuredClone(validFixtures.ClassificationResult), eventKey };
const ranking = { ...structuredClone(validFixtures.RankingResult), eventKey };
const source = { sourceId: validFixtures.DiscoveryCandidate.sourceId, sourceName: validFixtures.DiscoveryCandidate.sourceName, sourceItemId: validFixtures.ExtractedItem.candidateId, language: "en", sourceType: "official", countryCode: "US" };
const rawItemId = "44444444-4444-4444-8444-444444444444";
const pipelineSources = buildPipelineSourceMetadata(validFixtures.ClusteredEvent, [validFixtures.ExtractedItem], new Map([[validFixtures.ExtractedItem.candidateId, rawItemId]]));
assert.equal(pipelineSources[0].sourceItemId, validFixtures.ExtractedItem.candidateId);
assert.equal(pipelineSources[0].rawItemId, rawItemId);
assert.notEqual(pipelineSources[0].sourceItemId, pipelineSources[0].rawItemId);
const editorSources = [{ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: validFixtures.ExtractedItem.canonicalUrl, sourceType: "official" }];

const editorInput = buildEditorInput({ event: { eventKey, canonicalTitle: validFixtures.ClusteredEvent.canonicalTitle }, verification, translation, sources: editorSources });
editorInputSchema.parse(editorInput);
assert.deepEqual(Object.keys(editorInput.translation).sort(), ["preservedNames", "translatedFacts", "translatedTitle", "translatedSourceMaterial", "translationNotes"].sort());
assert.deepEqual(Object.keys(editorInput.verification).sort(), ["status", "confidenceScore", "verifiedFacts", "uncertainClaims", "contradictions"].sort());

const classifierInput = buildClassifierInput({ event: { eventKey, canonicalTitle: validFixtures.ClusteredEvent.canonicalTitle }, verification, translation, editorial, sources: [{ sourceName: source.sourceName, sourceType: source.sourceType, countryCode: source.countryCode }] });
classifierInputSchema.parse(classifierInput);
assert.deepEqual(Object.keys(classifierInput.verification).sort(), ["status", "confidenceScore", "verifiedFacts", "uncertainClaims", "contradictions"].sort());
assert.deepEqual(Object.keys(classifierInput.translation).sort(), ["translatedTitle", "translatedFacts", "preservedNames"].sort());
assert.deepEqual(Object.keys(classifierInput.editorial).sort(), ["headlineEs", "summaryEs", "keyPoints"].sort());

const rankerInput = buildRankerPipelineInput({
  event: { eventKey, canonicalTitle: validFixtures.ClusteredEvent.canonicalTitle, sourceCount: 1, occurredAt: validFixtures.ClusteredEvent.probableOccurredAt, latestPublishedAt: validFixtures.ClusteredEvent.probableOccurredAt },
  verification,
  translation,
  editorial,
  classification,
});
rankerInputSchema.parse(rankerInput);
assert.deepEqual(Object.keys(rankerInput.verification).sort(), ["status", "confidenceScore", "verifiedFacts", "uncertainClaims", "contradictions"].sort());
assert.deepEqual(Object.keys(rankerInput.translation).sort(), ["translatedTitle", "translatedFacts"].sort());
assert.deepEqual(Object.keys(rankerInput.editorial).sort(), ["headlineEs", "summaryEs", "whyItMattersEs", "keyPoints"].sort());
assert.deepEqual(Object.keys(rankerInput.classification).sort(), ["primaryRegionCode", "countryCodes", "categorySlugs", "companies", "models", "people", "technologies"].sort());

const rankingCheckpoint = {
  result: ranking,
  formulaVersion: "ranker-v1",
  momentumAvailable: false,
  deterministicSignals: { credibility: 80, reach: 40, momentum: 50, sourceCount: 1, contradictionPenalty: 0, uncertaintyPenalty: 0, geographicReachSignal: 10 },
};
const criticInput = buildCriticInput({
  event: { eventKey, canonicalTitle: validFixtures.ClusteredEvent.canonicalTitle, sourceCount: 1, occurredAt: validFixtures.ClusteredEvent.probableOccurredAt, latestPublishedAt: validFixtures.ClusteredEvent.probableOccurredAt },
  verification,
  translation,
  editorial,
  classification,
  ranking: rankingCheckpoint,
  sources: [source],
  geo: { latitude: 39.8283, longitude: -98.5795, resolutionLevel: "region", resolvedFrom: "region_registry" },
});
criticInputSchema.parse(criticInput);
assert.deepEqual(Object.keys(criticInput.geo).sort(), ["latitude", "longitude", "resolutionLevel", "resolvedFrom"].sort());

const publicationPayload = { ...structuredClone(validFixtures.PublicationPayload), eventKey, verification: { ...structuredClone(validFixtures.PublicationPayload.verification), eventKey }, critic: { ...structuredClone(validFixtures.PublicationPayload.critic), eventKey } };
const publisherInput = buildPublisherInputBoundary({
  payload: publicationPayload,
  lineage: { eventKey, verificationEventKey: eventKey, translationEventKey: eventKey, editorialEventKey: eventKey, classificationEventKey: eventKey, rankingEventKey: eventKey, criticEventKey: eventKey },
  validationContext: { translation, editorSources },
});
publicationPayloadSchema.parse(publisherInput.payload);
assert.equal(publisherInput.lineage.criticEventKey, eventKey);

console.log("pipeline:boundaries:unit: OK (explicit projections, strict downstream schemas, anti-spread keys, publisher payload validation)");
