import type { PublicationPayload } from "../contracts/index.ts";
import type { CriticPipelineCheckpoint } from "./critic-pipeline-checkpoint.ts";
import type { PublisherInput, PublisherValidationContext } from "./publisher-types.ts";
import { PublisherError } from "./publisher-errors.ts";

export type CheckpointPublicationMaterialization = {
  sources: Array<{ sourceId: string; sourceName: string; url: string; publishedAt: string | null; sourceType: string }>;
  categoryConfidence: Record<string, number>;
  entityConfidence: Record<string, number>;
  entityRoles: Record<string, "subject" | "mentioned" | "source" | "other">;
};

type CheckpointSourceRow = { id: string; name: string; url: string };

/**
 * Builds only the deterministic context needed to preview a checkpoint.
 * The 100 scores mean exact registry/natural-key resolution, not an LLM
 * confidence claim; real publication still requires an explicit materializer.
 */
export function buildCheckpointDryRunMaterialization(checkpoint: CriticPipelineCheckpoint, sources: CheckpointSourceRow[]): CheckpointPublicationMaterialization {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const resolvedSources = checkpoint.sources.map((source) => {
    const resolved = sourceMap.get(source.sourceId);
    if (!resolved) throw new PublisherError("publication_missing_source", "Checkpoint source could not be resolved");
    return { sourceId: resolved.id, sourceName: resolved.name, url: resolved.url, publishedAt: null, sourceType: source.sourceType ?? "unknown" };
  });
  const categoryConfidence = Object.fromEntries(checkpoint.classification.categorySlugs.map((slug) => [slug, 100]));
  const entityConfidence: Record<string, number> = {};
  const entityRoles: CheckpointPublicationMaterialization["entityRoles"] = {};
  const entities = [
    ...checkpoint.classification.companies.map((canonicalName) => ({ entityType: "organization", canonicalName })),
    ...checkpoint.classification.models.map((canonicalName) => ({ entityType: "model", canonicalName })),
    ...checkpoint.classification.people.map((canonicalName) => ({ entityType: "person", canonicalName })),
    ...checkpoint.classification.technologies.map((canonicalName) => ({ entityType: "product", canonicalName })),
  ];
  for (const entity of entities) {
    const key = entityKey(entity.entityType, entity.canonicalName, null);
    entityConfidence[key] = 100;
    entityRoles[key] = "mentioned";
  }
  return { sources: resolvedSources, categoryConfidence, entityConfidence, entityRoles };
}

function entityKey(entityType: string, canonicalName: string, countryCode: string | null): string {
  return `${entityType}\u0000${canonicalName}\u0000${countryCode ?? ""}`;
}

export function buildPublisherInputFromCriticCheckpoint(checkpoint: CriticPipelineCheckpoint, materialization: CheckpointPublicationMaterialization): PublisherInput {
  if (checkpoint.critic.decision !== "pass") throw new PublisherError("publication_not_approved", "Critic checkpoint is not approved for publication");
  const importanceScore = checkpoint.ranking.result.importanceScore;
  if (importanceScore === undefined || importanceScore === null) throw new PublisherError("publication_ranking_mismatch", "Checkpoint does not contain a deterministic importance score");
  const sourceMap = new Map(materialization.sources.map((source) => [source.sourceId, source]));
  const sources = checkpoint.sources.map((source) => {
    const resolved = sourceMap.get(source.sourceId);
    if (!resolved) throw new PublisherError("publication_missing_source", "Checkpoint source could not be resolved");
    return { sourceId: resolved.sourceId, sourceName: resolved.sourceName, url: resolved.url, isPrimary: source.sourceId === checkpoint.verification.primarySourceId, publishedAt: resolved.publishedAt };
  });
  const categories = checkpoint.classification.categorySlugs.map((categorySlug, index) => {
    const confidenceScore = materialization.categoryConfidence[categorySlug];
    if (confidenceScore === undefined) throw new PublisherError("publication_missing_validation_context", `Missing deterministic confidence for category ${index}`);
    return { categorySlug, isPrimary: index === 0, confidenceScore };
  });
  const entities = [
    ...checkpoint.classification.companies.map((canonicalName) => ({ entityType: "organization" as const, canonicalName, countryCode: null, source: "companies" })),
    ...checkpoint.classification.models.map((canonicalName) => ({ entityType: "model" as const, canonicalName, countryCode: null, source: "models" })),
    ...checkpoint.classification.people.map((canonicalName) => ({ entityType: "person" as const, canonicalName, countryCode: null, source: "people" })),
    ...checkpoint.classification.technologies.map((canonicalName) => ({ entityType: "product" as const, canonicalName, countryCode: null, source: "technologies" })),
  ].map(({ entityType, canonicalName }) => {
    const countryCode = null;
    const key = entityKey(entityType, canonicalName, countryCode);
    const confidenceScore = materialization.entityConfidence[key];
    const role = materialization.entityRoles[key];
    if (confidenceScore === undefined || role === undefined) throw new PublisherError("publication_missing_validation_context", "Missing deterministic confidence or role for classified entity");
    return { entityType, canonicalName, countryCode, role, confidenceScore };
  });
  const payload: PublicationPayload = {
    schemaVersion: 1,
    eventKey: checkpoint.eventKey,
    event: { canonicalTitle: checkpoint.event.canonicalTitle, probableOccurredAt: checkpoint.event.occurredAt, probableCountryCode: checkpoint.classification.countryCodes[0] ?? null, probableRegionCode: checkpoint.classification.primaryRegionCode },
    article: { slug: checkpoint.editorial.suggestedSlug, headlineEs: checkpoint.editorial.headlineEs, dekEs: checkpoint.editorial.dekEs, summaryEs: checkpoint.editorial.summaryEs, whyItMattersEs: checkpoint.editorial.whyItMattersEs, bodyEs: checkpoint.editorial.bodyEs, keyPoints: checkpoint.editorial.keyPoints },
    sources,
    categories,
    entities,
    region: { code: checkpoint.classification.primaryRegionCode, latitude: checkpoint.geo.latitude, longitude: checkpoint.geo.longitude },
    scores: { impact: checkpoint.ranking.result.impact, novelty: checkpoint.ranking.result.novelty, reach: checkpoint.ranking.result.reach, credibility: checkpoint.ranking.result.credibility, economicImpact: checkpoint.ranking.result.economicImpact, momentum: checkpoint.ranking.result.momentum, importanceScore },
    verification: checkpoint.verification,
    critic: checkpoint.critic,
  };
  const validationContext: PublisherValidationContext = {
    translation: checkpoint.translation,
    editorSources: sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: source.url, sourceType: "website" })),
  };
  const sameEvent = { eventKey: checkpoint.eventKey, verificationEventKey: checkpoint.verification.eventKey, translationEventKey: checkpoint.translation.eventKey, editorialEventKey: checkpoint.editorial.eventKey, classificationEventKey: checkpoint.classification.eventKey, rankingEventKey: checkpoint.ranking.result.eventKey, criticEventKey: checkpoint.critic.eventKey };
  return { payload, lineage: sameEvent, validationContext };
}
