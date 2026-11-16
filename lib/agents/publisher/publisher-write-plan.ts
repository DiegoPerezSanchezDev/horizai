import type { PublicationPayload } from "../contracts/index.ts";
import { calculateGuardedImportanceScore } from "../ranker/rank-score.ts";
import { PublisherError } from "./publisher-errors.ts";
import type { PublisherLookup, PublisherMaterializationPlan, PublisherWritePlan } from "./publisher-types.ts";

function entityKey(entityType: string, canonicalName: string, countryCode: string | null): string {
  return `${entityType}\u0000${canonicalName}\u0000${countryCode ?? ""}`;
}

function assertRanking(payload: PublicationPayload): void {
  const recomputed = calculateGuardedImportanceScore(payload.verification.status, {
    impact: payload.scores.impact,
    novelty: payload.scores.novelty,
    reach: payload.scores.reach,
    credibility: payload.scores.credibility,
    economicImpact: payload.scores.economicImpact,
    momentum: payload.scores.momentum,
  });
  if (recomputed !== payload.scores.importanceScore) throw new PublisherError("publication_ranking_mismatch", "Ranking-v1 importance score does not match its deterministic recomputation");
}

function assertCollectionIdentity(payload: PublicationPayload): void {
  const sourceIds = payload.sources.map((source) => source.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) throw new PublisherError("publication_idempotency_conflict", "Publication payload contains duplicate source identities");
  const categorySlugs = payload.categories.map((category) => category.categorySlug);
  if (new Set(categorySlugs).size !== categorySlugs.length) throw new PublisherError("publication_idempotency_conflict", "Publication payload contains duplicate category identities");
  const entityKeys = payload.entities.map((entity) => entityKey(entity.entityType, entity.canonicalName, entity.countryCode));
  if (new Set(entityKeys).size !== entityKeys.length) throw new PublisherError("publication_idempotency_conflict", "Publication payload contains duplicate entity identities");
  if (payload.categories.filter((category) => category.isPrimary).length > 1) throw new PublisherError("publication_invalid_category", "Publication payload contains multiple primary categories");
}

function assertRegion(payload: PublicationPayload, lookup: PublisherLookup): void {
  if (payload.region.code === null) {
    if (payload.region.latitude !== null || payload.region.longitude !== null) throw new PublisherError("publication_invalid_geo", "Coordinates require a resolved region");
    return;
  }
  if (!lookup.region || !lookup.region.is_active || lookup.region.code !== payload.region.code) throw new PublisherError("publication_invalid_region", "Publication region is not active or could not be resolved");
  if (lookup.region.latitude !== payload.region.latitude || lookup.region.longitude !== payload.region.longitude) throw new PublisherError("publication_invalid_geo", "Publication coordinates do not match the active region registry");
}

export function buildPublisherWritePlan(payload: PublicationPayload, lookup: PublisherLookup): PublisherWritePlan {
  if (payload.critic.decision !== "pass") throw new PublisherError("publication_not_approved", "Publisher requires CriticResult.decision=pass");
  if (payload.eventKey !== payload.verification.eventKey || payload.eventKey !== payload.critic.eventKey) throw new PublisherError("publication_lineage_mismatch", "PublicationPayload stages do not share the same eventKey");
  assertRanking(payload);
  assertCollectionIdentity(payload);
  if (lookup.event && lookup.event.event_key !== payload.eventKey) throw new PublisherError("publication_idempotency_conflict", "Resolved event does not match the publication eventKey");
  if (!lookup.event && payload.sources.some((source) => !source.rawItemId)) throw new PublisherError("publication_missing_raw_item", "A new publication event requires rawItemId for every source");
  if (lookup.articleBySlug && (!lookup.event || lookup.articleBySlug.event_id !== lookup.event.id)) throw new PublisherError("publication_idempotency_conflict", "Publication slug belongs to another event");
  assertRegion(payload, lookup);

  const requestedSourceIds = payload.sources.map((source) => source.sourceId);
  if (requestedSourceIds.some((id) => !lookup.sources.has(id))) throw new PublisherError("publication_missing_source", "One or more publication sources do not exist");
  if (lookup.event && requestedSourceIds.some((id) => !lookup.eventSourceIds.has(id))) throw new PublisherError("publication_source_traceability_missing", "One or more publication sources are not linked to the event");

  const requestedCategorySlugs = payload.categories.map((category) => category.categorySlug);
  if (requestedCategorySlugs.some((slug) => !lookup.categories.has(slug))) throw new PublisherError("publication_invalid_category", "One or more publication categories are not active");

  const entities = payload.entities.map((entity) => {
    const existing = lookup.entities.get(entityKey(entity.entityType, entity.canonicalName, entity.countryCode));
    return {
      entityId: existing?.id ?? null,
      entityType: entity.entityType,
      canonicalName: entity.canonicalName,
      countryCode: entity.countryCode,
      operation: existing ? "reuse_exact" as const : "insert_exact" as const,
      role: entity.role,
    };
  });

  return {
    publisherVersion: "publisher-v1",
    eventKey: payload.eventKey,
    event: { eventId: lookup.event?.id ?? null, operation: lookup.event ? "update_existing" : "insert", eventStatus: "active", reviewStatus: "approved", regionId: lookup.region?.id ?? null },
    article: { eventId: lookup.event?.id ?? null, existingArticleId: lookup.articleByEvent?.id ?? null, operation: lookup.articleByEvent ? "update_same_event" : "insert", idempotencyKey: lookup.event ? "event_id" : "event_key_then_event_id", slug: payload.article.slug, publicationStatus: "published" },
    eventSources: { operation: lookup.event ? "reuse_existing" : "insert_idempotent", sourceIds: requestedSourceIds },
    categories: payload.categories.map((category) => ({ categoryId: lookup.categories.get(category.categorySlug)!.id, categorySlug: category.categorySlug, isPrimary: category.isPrimary })),
    entities,
    articleCategories: "upsert_by_article_and_category",
    articleEntities: "upsert_by_article_and_entity",
    activityHistory: { operation: "none", reason: "publication_does_not_recalculate_aggregates" },
  };
}

/**
 * Builds a zero-write plan. Missing database identities remain null and are
 * materialized only by the future atomic publish transaction.
 */
export function buildPublisherMaterializationPlan(payload: PublicationPayload, lookup: PublisherLookup): PublisherMaterializationPlan {
  if (payload.critic.decision !== "pass") throw new PublisherError("publication_not_approved", "Publisher requires CriticResult.decision=pass");
  if (payload.eventKey !== payload.verification.eventKey || payload.eventKey !== payload.critic.eventKey) throw new PublisherError("publication_lineage_mismatch", "PublicationPayload stages do not share the same eventKey");
  assertRanking(payload);
  assertCollectionIdentity(payload);
  assertRegion(payload, lookup);

  if (lookup.event && lookup.event.event_key !== payload.eventKey) throw new PublisherError("publication_idempotency_conflict", "Resolved event does not match the publication eventKey");
  if (lookup.event && lookup.event.canonical_title !== payload.event.canonicalTitle) throw new PublisherError("publication_idempotency_conflict", "Publication title does not match the existing event");
  if (lookup.articleBySlug && (!lookup.event || lookup.articleBySlug.event_id !== lookup.event.id)) throw new PublisherError("publication_idempotency_conflict", "Publication slug belongs to another event");

  const requestedSourceIds = payload.sources.map((source) => source.sourceId);
  if (requestedSourceIds.some((id) => !lookup.sources.has(id))) throw new PublisherError("publication_missing_source", "One or more publication sources do not exist");
  if (lookup.event && requestedSourceIds.some((id) => !lookup.eventSourceIds.has(id))) throw new PublisherError("publication_source_traceability_missing", "One or more publication sources are not linked to the existing event");

  const requestedCategorySlugs = payload.categories.map((category) => category.categorySlug);
  if (requestedCategorySlugs.some((slug) => !lookup.categories.has(slug))) throw new PublisherError("publication_invalid_category", "One or more publication categories are not active");

  const eventResolution: "reuse_existing" | "would_create" = lookup.event ? "reuse_existing" : "would_create";
  const articleResolution: "reuse_existing" | "would_create" = lookup.articleByEvent ? "reuse_existing" : "would_create";
  const entities = payload.entities.map((entity) => {
    const existing = lookup.entities.get(entityKey(entity.entityType, entity.canonicalName, entity.countryCode));
    return {
      entityId: existing?.id ?? null,
      entityType: entity.entityType,
      canonicalName: entity.canonicalName,
      countryCode: entity.countryCode,
      resolution: existing ? "reuse_existing" as const : "would_create" as const,
      role: entity.role,
    };
  });

  return {
    publisherVersion: "publisher-v1",
    eventKey: payload.eventKey,
    event: { resolution: eventResolution, databaseId: lookup.event?.id ?? null, regionId: lookup.region?.id ?? null },
    article: { resolution: articleResolution, databaseId: lookup.articleByEvent?.id ?? null, operation: lookup.articleByEvent ? "reuse_existing" : "would_create", slug: payload.article.slug, idempotencyKey: "event_key_then_event_id" },
    sources: requestedSourceIds.map((sourceId) => ({ sourceId, resolution: "reuse_existing" as const })),
    categories: payload.categories.map((category) => ({ categoryId: lookup.categories.get(category.categorySlug)!.id, categorySlug: category.categorySlug, isPrimary: category.isPrimary, resolution: "reuse_existing" as const })),
    entities,
    relations: { eventSources: lookup.event ? "already_linked" : "would_link", articleCategories: "would_link", articleEntities: "would_link" },
    activityHistory: "none",
  };
}
