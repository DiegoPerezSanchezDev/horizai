import type { TranslatorInput } from "./translator-types.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const otherSourceId = "22222222-2222-4222-8222-222222222222";

/** Shared canonical input fixture from translator:unit. */
export const canonicalTranslatorInput: TranslatorInput = {
  schemaVersion: 1,
  event: {
    schemaVersion: 1,
    eventKey: "gpt-5-launch-2026",
    canonicalTitle: "OpenAI launches GPT-5",
    sourceItems: [{
      candidateId: "candidate-1",
      sourceId,
      sourceName: "Example Tech Journal",
      url: "https://example.com/gpt-5",
      title: "OpenAI launches GPT-5",
      publishedAt: "2026-09-12T08:00:00Z",
    }],
    probableOccurredAt: "2026-09-12T08:00:00Z",
    probableCountryCode: "US",
    probableRegionCode: "US",
    clusterConfidence: 88,
  },
  verification: {
    schemaVersion: 1,
    eventKey: "gpt-5-launch-2026",
    status: "single_source",
    confidenceScore: 90,
    primarySourceId: sourceId,
    supportingSourceIds: [],
    contradictions: [{ claim: "The release date is disputed.", sourceIds: [sourceId, otherSourceId] }],
    verifiedFacts: [{ claim: "OpenAI launched GPT-5 with 128K tokens and a $4.2 billion investment.", sourceIds: [sourceId] }],
    uncertainClaims: [{ claim: "The company may expand access next quarter.", sourceIds: [sourceId] }],
    reason: "The supplied source states the launch details.",
  },
  sourceLanguage: "en",
  sources: [{
    sourceId,
    sourceName: "Example Tech Journal",
    sourceItemId: "candidate-1",
    language: "en",
    sourceType: "technology_press",
    countryCode: "US",
  }],
};
