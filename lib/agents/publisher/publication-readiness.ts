import { publicationPayloadSchema } from "../contracts/index.ts";
import { buildPublisherMaterializationPlan } from "./publisher-write-plan.ts";
import { PublisherError } from "./publisher-errors.ts";
import { assertPublisherLineage, validatePublisherInputs } from "./publisher-validation.ts";
import type { ArticleRow, CategoryRow, EntityRow, EventRow, PublisherRepository, RegionRow, SourceRow } from "./publisher-repository.ts";
import type { PublisherInput, PublisherLookup } from "./publisher-types.ts";

export type PublicationReadinessIssueCode =
  | "publication_invalid_payload"
  | "publication_not_approved"
  | "publication_lineage_mismatch"
  | "publication_missing_source"
  | "publication_missing_raw_item"
  | "publication_source_traceability_missing"
  | "publication_invalid_category"
  | "publication_invalid_region"
  | "publication_invalid_entity"
  | "publication_lookup_failed";

export type PublicationReadinessIssue = {
  code: PublicationReadinessIssueCode;
  message: string;
};

export type PublicationReadinessRepository = Pick<
  PublisherRepository,
  | "findEventByKey"
  | "findActiveRegion"
  | "findActiveCategories"
  | "findSources"
  | "findEventSourceIds"
  | "findArticleByEventId"
  | "findArticleBySlug"
  | "findExactEntities"
> & {
  findRawItemOwnership(rawItemId: string, sourceId: string): Promise<boolean>;
};

export type PublicationReadinessResult = {
  ready: boolean;
  issues: PublicationReadinessIssue[];
  eventResolution: "would_create" | "reuse_existing" | "unknown";
  rawItemOwnershipChecked: number;
};

function issue(code: PublicationReadinessIssueCode, message: string): PublicationReadinessIssue {
  return { code, message };
}

function entityKey(entityType: string, canonicalName: string, countryCode: string | null): string {
  return `${entityType}\u0000${canonicalName}\u0000${countryCode ?? ""}`;
}

function publisherErrorIssue(error: unknown): PublicationReadinessIssue {
  if (error instanceof PublisherError) {
    let code: PublicationReadinessIssueCode = "publication_invalid_payload";
    switch (error.code) {
      case "publication_not_approved":
      case "publication_lineage_mismatch":
      case "publication_invalid_category":
      case "publication_invalid_region":
      case "publication_missing_source":
      case "publication_missing_raw_item":
      case "publication_source_traceability_missing":
        code = error.code;
        break;
    }
    return issue(code, error.message);
  }
  return issue("publication_invalid_payload", "Publisher payload did not pass deterministic validation");
}

function buildLookup(
  event: EventRow | null,
  region: RegionRow | null,
  categories: CategoryRow[],
  sources: SourceRow[],
  eventSourceIds: string[],
  articleByEvent: ArticleRow | null,
  articleBySlug: ArticleRow | null,
  entities: EntityRow[],
): PublisherLookup {
  return {
    event,
    region,
    categories: new Map(categories.map((category) => [category.slug, category])),
    sources: new Map(sources.map((source) => [source.id, source])),
    eventSourceIds: new Set(eventSourceIds),
    articleByEvent,
    articleBySlug,
    entities: new Map(entities.map((entity) => [entityKey(entity.entity_type, entity.canonical_name, entity.country_code), entity])),
  };
}

/**
 * Read-only publication gate. It deliberately never calls the atomic publish
 * RPC and fails closed when a registry or lineage check cannot be completed.
 */
export async function validateRealPublicationReadiness(
  input: PublisherInput,
  repository: PublicationReadinessRepository,
): Promise<PublicationReadinessResult> {
  const parsed = publicationPayloadSchema.safeParse(input.payload);
  const issues: PublicationReadinessIssue[] = [];
  if (!parsed.success) {
    issues.push(issue("publication_invalid_payload", "PublicationPayload failed its runtime contract"));
    return { ready: false, issues, eventResolution: "unknown", rawItemOwnershipChecked: 0 };
  }

  try {
    assertPublisherLineage(input);
  } catch (error) {
    issues.push(publisherErrorIssue(error));
  }

  try {
    validatePublisherInputs(input);
  } catch (error) {
    issues.push(publisherErrorIssue(error));
  }

  const payload = parsed.data;
  const sourceIds = payload.sources.map((source) => source.sourceId);
  const categorySlugs = payload.categories.map((category) => category.categorySlug);
  const entityIdentities = payload.entities.map((entity) => ({
    entityType: entity.entityType,
    canonicalName: entity.canonicalName,
    countryCode: entity.countryCode,
  }));

  let event: EventRow | null = null;
  let region: RegionRow | null = null;
  let categories: CategoryRow[] = [];
  let sources: SourceRow[] = [];
  let eventSourceIds: string[] = [];
  let articleByEvent: ArticleRow | null = null;
  let articleBySlug: ArticleRow | null = null;
  let entities: EntityRow[] = [];
  let rawItemOwnershipChecked = 0;

  try {
    event = await repository.findEventByKey(payload.eventKey);
    region = payload.region.code === null ? null : await repository.findActiveRegion(payload.region.code);
    categories = await repository.findActiveCategories(categorySlugs);
    sources = await repository.findSources(sourceIds);
    eventSourceIds = event ? await repository.findEventSourceIds(event.id) : [];
    articleByEvent = event ? await repository.findArticleByEventId(event.id) : null;
    articleBySlug = await repository.findArticleBySlug(payload.article.slug);
    entities = await repository.findExactEntities(entityIdentities);

    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    if (sourceIds.some((sourceId) => !sourceMap.get(sourceId)?.is_active)) {
      issues.push(issue("publication_missing_source", "Every publication source must exist and be active"));
    }
    if (payload.region.code !== null && !region) {
      issues.push(issue("publication_invalid_region", "Publication region is not active"));
    }
    if (new Set(entityIdentities.map((entity) => entityKey(entity.entityType, entity.canonicalName, entity.countryCode))).size !== entityIdentities.length) {
      issues.push(issue("publication_invalid_entity", "Publication payload contains duplicate entity identities"));
    }

    const rawItemsToCheck = event
      ? payload.sources.filter((source) => source.rawItemId)
      : payload.sources;
    for (const source of rawItemsToCheck) {
      if (!source.rawItemId) {
        issues.push(issue("publication_missing_raw_item", "A new event requires rawItemId for every source"));
        continue;
      }
      rawItemOwnershipChecked += 1;
      if (!(await repository.findRawItemOwnership(source.rawItemId, source.sourceId))) {
        issues.push(issue("publication_missing_raw_item", "rawItemId must belong to its declared source"));
      }
    }

    const lookup = buildLookup(event, region, categories, sources, eventSourceIds, articleByEvent, articleBySlug, entities);
    buildPublisherMaterializationPlan(payload, lookup);
  } catch (error) {
    if (error instanceof PublisherError) {
      issues.push(publisherErrorIssue(error));
    } else {
      issues.push(issue("publication_lookup_failed", "Publication readiness lookup failed closed"));
    }
  }

  const uniqueIssues = [...new Map(issues.map((item) => [`${item.code}:${item.message}`, item])).values()];
  return {
    ready: uniqueIssues.length === 0,
    issues: uniqueIssues,
    eventResolution: event ? "reuse_existing" : "would_create",
    rawItemOwnershipChecked,
  };
}
