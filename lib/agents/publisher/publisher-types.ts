import type { ArticleRow, CategoryRow, EntityRow, EventRow, RegionRow, SourceRow } from "./publisher-repository.ts";
import type { EditorialDraft, PublicationPayload, TranslationResult, VerificationResult } from "../contracts/index.ts";

export const publisherVersion = "publisher-v1" as const;

export type PublisherLineage = {
  eventKey: string;
  verificationEventKey: string;
  translationEventKey: string;
  editorialEventKey: string;
  classificationEventKey: string;
  rankingEventKey: string;
  criticEventKey: string;
};

export type PublisherValidationContext = {
  translation: TranslationResult;
  editorSources: Array<{
    sourceId: string;
    sourceName: string;
    canonicalUrl: string;
    sourceType: string;
  }>;
};

export type PublisherInput = {
  payload: PublicationPayload;
  lineage: PublisherLineage;
  validationContext?: PublisherValidationContext;
  revisionLineage?: PublisherRevisionLineage;
};

export type PublisherRevisionLineage = {
  revisionId: string;
  eventKey: string;
  revisionAttempt: number;
  checkpointRevisionAttempts: Record<"verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic", number>;
};

export type PublisherLookup = {
  event: EventRow | null;
  region: RegionRow | null;
  categories: Map<string, CategoryRow>;
  sources: Map<string, SourceRow>;
  eventSourceIds: Set<string>;
  articleByEvent: ArticleRow | null;
  articleBySlug: ArticleRow | null;
  entities: Map<string, EntityRow>;
};

export type PublisherWritePlan = {
  publisherVersion: typeof publisherVersion;
  eventKey: string;
  event: {
    eventId: string | null;
    operation: "insert" | "update_existing";
    eventStatus: "active";
    reviewStatus: "approved";
    regionId: string | null;
  };
  article: {
    eventId: string | null;
    existingArticleId: string | null;
    operation: "insert" | "update_same_event";
    idempotencyKey: "event_id" | "event_key_then_event_id";
    slug: string;
    publicationStatus: "published";
  };
  eventSources: {
    operation: "insert_idempotent" | "reuse_existing";
    sourceIds: string[];
  };
  categories: Array<{
    categoryId: string;
    categorySlug: string;
    isPrimary: boolean;
  }>;
  entities: Array<{
    entityId: string | null;
    entityType: string;
    canonicalName: string;
    countryCode: string | null;
    operation: "reuse_exact" | "insert_exact";
    role: string;
  }>;
  articleCategories: "upsert_by_article_and_category";
  articleEntities: "upsert_by_article_and_entity";
  activityHistory: {
    operation: "none";
    reason: "publication_does_not_recalculate_aggregates";
  };
};

export type PublisherMaterializationResolution = "reuse_existing" | "would_create";

/** Read-only dry-run plan. Database identifiers are null until the atomic publish transaction materializes them. */
export type PublisherMaterializationPlan = {
  publisherVersion: typeof publisherVersion;
  eventKey: string;
  event: {
    resolution: PublisherMaterializationResolution;
    databaseId: string | null;
    regionId: string | null;
  };
  article: {
    resolution: PublisherMaterializationResolution;
    databaseId: string | null;
    operation: "would_create" | "reuse_existing";
    slug: string;
    idempotencyKey: "event_key_then_event_id";
  };
  sources: Array<{
    sourceId: string;
    resolution: "reuse_existing";
  }>;
  categories: Array<{
    categoryId: string;
    categorySlug: string;
    isPrimary: boolean;
    resolution: "reuse_existing";
  }>;
  entities: Array<{
    entityId: string | null;
    entityType: string;
    canonicalName: string;
    countryCode: string | null;
    resolution: PublisherMaterializationResolution;
    role: string;
  }>;
  relations: {
    eventSources: "would_link" | "already_linked";
    articleCategories: "would_link";
    articleEntities: "would_link";
  };
  activityHistory: "none";
};

export type PublisherExecutionResult = {
  status: "success";
  dryRun: boolean;
  summary: {
    idempotencyOutcome: "new_article" | "deterministic_update" | "dry_run_new" | "dry_run_existing";
    transactionAttempted: boolean;
    transactionCommitted: boolean;
    articleCreated: boolean;
    articleUpdated: boolean;
    articleId: string | null;
    categoriesLinkedCount: number;
    entitiesLinkedCount: number;
    sourcesLinkedCount: number;
    activityRowsCreated: number;
    eventAction?: "created" | "reused" | "WOULD_CREATE" | "REUSE";
    eventId?: string | null;
    articleAction?: "created" | "reused" | "updated" | "WOULD_CREATE" | "REUSE";
    entitiesCreated?: number;
    entitiesReused?: number;
    sourcesResolved?: number;
    relationsCreated?: number;
    publisherVersion?: typeof publisherVersion;
  };
  writePlan: PublisherWritePlan | PublisherMaterializationPlan;
};

export type PublisherCheckpointInput = {
  eventKey: string;
  verification: VerificationResult;
  translation: TranslationResult;
  editorial: EditorialDraft;
  validationContext: PublisherValidationContext;
};
