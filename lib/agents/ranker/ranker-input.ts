import type { ClassificationResult, EditorialDraft, TranslationResult, VerificationResult } from "../contracts/index.ts";
import { rankerInputSchema, type RankerInput } from "./ranker-types.ts";

export function buildRankerPipelineInput(input: {
  event: RankerInput["event"];
  verification: VerificationResult;
  translation: RankerInput["translation"];
  editorial: Pick<EditorialDraft, "headlineEs" | "summaryEs" | "whyItMattersEs" | "keyPoints">;
  classification: ClassificationResult;
}): RankerInput {
  return rankerInputSchema.parse({
    schemaVersion: 1,
    event: input.event,
    verification: {
      status: input.verification.status,
      confidenceScore: input.verification.confidenceScore,
      verifiedFacts: input.verification.verifiedFacts,
      uncertainClaims: input.verification.uncertainClaims,
      contradictions: input.verification.contradictions,
    },
    translation: {
      translatedTitle: input.translation.translatedTitle,
      translatedFacts: input.translation.translatedFacts.map(({ sourceText, translatedText }) => ({ sourceText, translatedText })),
    },
    editorial: {
      headlineEs: input.editorial.headlineEs,
      summaryEs: input.editorial.summaryEs,
      whyItMattersEs: input.editorial.whyItMattersEs,
      keyPoints: input.editorial.keyPoints,
    },
    classification: {
      primaryRegionCode: input.classification.primaryRegionCode,
      countryCodes: input.classification.countryCodes,
      categorySlugs: input.classification.categorySlugs,
      companies: input.classification.companies,
      models: input.classification.models,
      people: input.classification.people,
      technologies: input.classification.technologies,
    },
  });
}

export function buildRankerInput(input: {
  event: { eventKey: string; canonicalTitle: string; occurredAt: string | null; sourceItems: Array<{ publishedAt: string | null }> };
  verification: VerificationResult;
  translation: Pick<TranslationResult, "translatedTitle" | "translatedFacts">;
  editorial: Pick<EditorialDraft, "headlineEs" | "summaryEs" | "whyItMattersEs" | "keyPoints">;
  classification: ClassificationResult;
}): RankerInput {
  const publishedDates = input.event.sourceItems.flatMap((item) => item.publishedAt ? [Date.parse(item.publishedAt)] : []);
  const latestPublishedAt = publishedDates.length > 0 ? new Date(Math.max(...publishedDates)).toISOString() : null;
  return {
    schemaVersion: 1,
    event: {
      eventKey: input.event.eventKey,
      canonicalTitle: input.event.canonicalTitle,
      sourceCount: input.event.sourceItems.length,
      occurredAt: input.event.occurredAt,
      latestPublishedAt,
    },
    verification: {
      status: input.verification.status,
      confidenceScore: input.verification.confidenceScore,
      verifiedFacts: input.verification.verifiedFacts,
      uncertainClaims: input.verification.uncertainClaims,
      contradictions: input.verification.contradictions,
    },
    translation: {
      translatedTitle: input.translation.translatedTitle,
      translatedFacts: input.translation.translatedFacts.map(({ sourceText, translatedText }) => ({ sourceText, translatedText })),
    },
    editorial: {
      headlineEs: input.editorial.headlineEs,
      summaryEs: input.editorial.summaryEs,
      whyItMattersEs: input.editorial.whyItMattersEs,
      keyPoints: input.editorial.keyPoints,
    },
    classification: {
      primaryRegionCode: input.classification.primaryRegionCode,
      countryCodes: input.classification.countryCodes,
      categorySlugs: input.classification.categorySlugs,
      companies: input.classification.companies,
      models: input.classification.models,
      people: input.classification.people,
      technologies: input.classification.technologies,
    },
  };
}
