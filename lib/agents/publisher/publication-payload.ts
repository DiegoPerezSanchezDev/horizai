import { publicationPayloadSchema, type PublicationPayload, type RankingResult } from "../contracts/index.ts";
import { PublisherError } from "./publisher-errors.ts";
import type { PipelineEventContext } from "../pipeline/pipeline-types.ts";

/** Project Ranker output onto the strict score fields accepted by PublicationPayload. */
export function buildPublicationScores(ranking: RankingResult): PublicationPayload["scores"] {
  const importanceScore = ranking.importanceScore;
  if (importanceScore === undefined || importanceScore === null) {
    throw new PublisherError("publication_ranking_mismatch", "Publisher requires a deterministic importance score");
  }

  return {
    impact: ranking.impact,
    novelty: ranking.novelty,
    reach: ranking.reach,
    credibility: ranking.credibility,
    economicImpact: ranking.economicImpact,
    momentum: ranking.momentum,
    importanceScore,
  };
}

/** Deterministically materialize the exact strict article payload reviewed before publication. */
export function buildPipelinePublicationPayload(context: PipelineEventContext): PublicationPayload {
  if (!context.verification || !context.translation || !context.editorial || !context.classification || !context.geo || !context.ranking || !context.critic) {
    throw new Error("PUBLICATION_PAYLOAD_REQUIRES_COMPLETE_PIPELINE_LINEAGE");
  }
  const { verification, editorial, classification, geo, ranking, critic } = context;
  const publishedByCandidate = new Map(context.event.sourceItems.map((item) => [item.candidateId, item.publishedAt]));
  return publicationPayloadSchema.parse({
    schemaVersion: 1,
    eventKey: context.event.eventKey,
    event: {
      canonicalTitle: context.event.canonicalTitle,
      probableOccurredAt: context.event.probableOccurredAt,
      probableCountryCode: classification.countryCodes[0] ?? context.event.probableCountryCode,
      probableRegionCode: classification.primaryRegionCode,
    },
    article: {
      slug: editorial.suggestedSlug,
      headlineEs: editorial.headlineEs,
      dekEs: editorial.dekEs,
      summaryEs: editorial.summaryEs,
      whyItMattersEs: editorial.whyItMattersEs,
      bodyEs: editorial.bodyEs,
      keyPoints: editorial.keyPoints,
    },
    sources: context.sources.map((source) => ({
      sourceId: source.sourceId,
      rawItemId: source.rawItemId ?? undefined,
      sourceName: source.sourceName,
      url: source.sourceUrl,
      isPrimary: source.sourceId === verification.primarySourceId,
      publishedAt: publishedByCandidate.get(source.sourceItemId) ?? null,
    })),
    categories: classification.categorySlugs.map((categorySlug, index) => ({ categorySlug, isPrimary: index === 0, confidenceScore: 100 })),
    entities: [
      ...classification.companies.map((canonicalName) => ({ entityType: "organization" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...classification.models.map((canonicalName) => ({ entityType: "model" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...classification.people.map((canonicalName) => ({ entityType: "person" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...classification.technologies.map((canonicalName) => ({ entityType: "product" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
    ],
    region: { code: classification.primaryRegionCode, latitude: geo.latitude, longitude: geo.longitude },
    scores: buildPublicationScores(ranking),
    verification,
    critic,
  });
}
