import type { Json } from "../../../types/database.ts";
import { publicationPayloadSchema, type PublicationPayload } from "../contracts/index.ts";
import { PublisherError, type PublisherErrorCode } from "./publisher-errors.ts";
import type { PublisherExecutionResult, PublisherInput, PublisherLookup } from "./publisher-types.ts";
import { buildPublisherMaterializationPlan, buildPublisherWritePlan } from "./publisher-write-plan.ts";
import type { FactualRemediationPublicationTarget, PublisherRepository, ReviewedPublicationTarget } from "./publisher-repository.ts";
import { publisherVersion } from "./publisher-types.ts";
import { validatePublisherInputs } from "./publisher-validation.ts";
import { assertHumanReviewPublicationTarget } from "./human-review-policy.ts";

async function resolveLookup(payload: PublicationPayload, repository: PublisherRepository): Promise<PublisherLookup> {
  const event = await repository.findEventByKey(payload.eventKey);
  const requestedCategorySlugs = payload.categories.map((category) => category.categorySlug);
  const requestedSourceIds = payload.sources.map((source) => source.sourceId);
  const requestedEntities = payload.entities.map((entity) => ({ entityType: entity.entityType, canonicalName: entity.canonicalName, countryCode: entity.countryCode }));
  const [region, categories, sources, eventSourceIds, articleByEvent, articleBySlug, entities] = await Promise.all([
    payload.region.code ? repository.findActiveRegion(payload.region.code) : Promise.resolve(null),
    repository.findActiveCategories(requestedCategorySlugs),
    repository.findSources(requestedSourceIds),
    event ? repository.findEventSourceIds(event.id) : Promise.resolve([]),
    event ? repository.findArticleByEventId(event.id) : Promise.resolve(null),
    repository.findArticleBySlug(payload.article.slug),
    repository.findExactEntities(requestedEntities),
  ]);
  return {
    event,
    region,
    categories: new Map(categories.map((category) => [category.slug, category])),
    sources: new Map(sources.map((source) => [source.id, source])),
    eventSourceIds: new Set(eventSourceIds),
    articleByEvent,
    articleBySlug,
    entities: new Map(entities.map((entity) => [`${entity.entity_type}\u0000${entity.canonical_name}\u0000${entity.country_code ?? ""}`, entity])),
  };
}

export class Publisher {
  readonly version = publisherVersion;
  private readonly repository: PublisherRepository;

  constructor(repository: PublisherRepository) {
    this.repository = repository;
  }

  async preview(input: PublisherInput): Promise<PublisherExecutionResult> {
    const payload = publicationPayloadSchema.parse(input.payload);
    const validatedInput = { ...input, payload };
    validatePublisherInputs(validatedInput);
    const lookup = await resolveLookup(payload, this.repository);
    const writePlan = buildPublisherMaterializationPlan(payload, lookup);
    const eventWouldBeCreated = writePlan.event.resolution === "would_create";
    return {
      status: "success",
      dryRun: true,
      summary: {
        idempotencyOutcome: eventWouldBeCreated || writePlan.article.resolution === "would_create" ? "dry_run_new" : "dry_run_existing",
        transactionAttempted: false,
        transactionCommitted: false,
        articleCreated: false,
        articleUpdated: false,
        articleId: writePlan.article.databaseId,
        categoriesLinkedCount: writePlan.categories.length,
        entitiesLinkedCount: writePlan.entities.length,
        sourcesLinkedCount: writePlan.sources.length,
        activityRowsCreated: 0,
        eventAction: eventWouldBeCreated ? "WOULD_CREATE" : "REUSE",
        eventId: writePlan.event.databaseId,
        articleAction: writePlan.article.operation === "would_create" ? "WOULD_CREATE" : "REUSE",
        entitiesCreated: writePlan.entities.filter((entity) => entity.resolution === "would_create").length,
        entitiesReused: writePlan.entities.filter((entity) => entity.resolution === "reuse_existing").length,
        sourcesResolved: writePlan.sources.length,
        relationsCreated: 0,
        publisherVersion: this.version,
      },
      writePlan,
    };
  }

  async publish(input: PublisherInput, options: { dryRun?: boolean; factualRemediation?: FactualRemediationPublicationTarget; reviewedPublication?: ReviewedPublicationTarget } = {}): Promise<PublisherExecutionResult> {
    if (options.dryRun ?? true) return this.preview(input);
    if (options.factualRemediation && options.reviewedPublication) throw new Error("PUBLICATION_LIFECYCLE_TARGET_AMBIGUOUS");
    if (options.factualRemediation || !options.reviewedPublication) throw new Error("HUMAN_APPROVAL_REQUIRED");
    assertHumanReviewPublicationTarget(options.reviewedPublication);
    const payload = publicationPayloadSchema.parse(input.payload);
    const validatedInput = { ...input, payload };
    validatePublisherInputs(validatedInput);
    const lookup = await resolveLookup(payload, this.repository);
    const writePlan = buildPublisherWritePlan(payload, lookup);
    try {
      if (options.reviewedPublication && !this.repository.publishReviewedAtomic) throw new Error("reviewed_publisher_repository_required");
      const committed = await this.repository.publishReviewedAtomic!(payload as unknown as Json, options.reviewedPublication);
      const articleWasExisting = Boolean(lookup.articleByEvent);
      return {
        status: "success",
        dryRun: false,
        summary: {
          idempotencyOutcome: articleWasExisting ? "deterministic_update" : "new_article",
          transactionAttempted: true,
          transactionCommitted: true,
          articleCreated: !articleWasExisting,
          articleUpdated: articleWasExisting,
          articleId: committed.articleId,
          categoriesLinkedCount: committed.categoriesLinkedCount,
          entitiesLinkedCount: committed.entitiesLinkedCount,
          sourcesLinkedCount: committed.sourcesLinkedCount,
          activityRowsCreated: committed.activityRowsCreated,
          eventAction: committed.eventAction,
          eventId: committed.eventId,
          articleAction: committed.articleAction,
          entitiesCreated: committed.entitiesCreated,
          entitiesReused: committed.entitiesReused,
          sourcesResolved: committed.sourcesLinkedCount,
          relationsCreated: committed.relationsCreated,
          publisherVersion: this.version,
        },
        writePlan,
      };
    } catch (error) {
      if (error instanceof Error && /^human_review_[a-z_]+$/.test(error.message)) throw error;
      const message = error instanceof Error && /^publication_[a-z_]+$/.test(error.message) ? error.message : "publication_transaction_failed";
      throw new PublisherError(message as PublisherErrorCode, "Atomic publication failed");
    }
  }
}
