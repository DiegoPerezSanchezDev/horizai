import { publicationPayloadSchema, type PublicationPayload } from "../contracts/index.ts";
import { buildPublicationScores } from "../publisher/publication-payload.ts";
import type { PipelineEventContext } from "./pipeline-types.ts";

/** Build the same strict payload used by the production Publisher from fresh remediation-stage outputs. */
export function buildFactualRemediationPublicationPayload(context: PipelineEventContext): PublicationPayload {
  if (!context.verification || !context.translation || !context.editorial || !context.classification || !context.geo || !context.ranking || !context.critic) {
    throw new Error("FACTUAL_REMEDIATION_PUBLICATION_REQUIRES_FRESH_STAGE_LINEAGE");
  }
  const publishedByCandidate = new Map(context.event.sourceItems.map((item) => [item.candidateId, item.publishedAt]));
  const verification = context.verification;
  const editorial = context.editorial;
  const classification = context.classification;
  const geo = context.geo;
  const ranking = context.ranking;
  const critic = context.critic;
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
