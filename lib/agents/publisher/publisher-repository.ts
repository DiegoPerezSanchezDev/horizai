import type { Json } from "../../../types/database.ts";
import type { HumanReviewPublicationAuthorization } from "./human-review-policy.ts";

export type EventRow = {
  id: string;
  event_key: string | null;
  canonical_title: string;
  primary_region_id: string | null;
  primary_country_code: string | null;
  occurred_at: string | null;
};

export type RegionRow = { id: string; code: string; latitude: number | null; longitude: number | null; is_active: boolean };
export type CategoryRow = { id: string; slug: string; is_active: boolean };
export type SourceRow = { id: string; name: string; url: string; is_active: boolean };
export type ArticleRow = { id: string; event_id: string; slug: string; publication_status: string };
export type EntityRow = { id: string; entity_type: string; canonical_name: string; country_code: string | null };
export type FactualRemediationPublicationTarget = { attemptId: string; pipelineRunId: string; articleId: string; articleSlug: string; continuation?: true };
export type ReviewedPublicationTarget = {
  reviewId: string;
  eventKey: string;
  attemptId: string;
  pipelineRunId: string;
  draftId: string;
  draftSha256: string;
  packageSha256: string;
  checkpoints: Json;
  sourceLineage: Json;
  approvalTargetRevisionSha256?: string | null;
  authorization: HumanReviewPublicationAuthorization;
};
export type AtomicPublicationResult = {
  eventId: string;
  articleId: string;
  eventAction: "created" | "reused";
  articleAction: "created" | "reused" | "updated";
  articleOperation: "upsert_by_event_id";
  categoriesLinkedCount: number;
  entitiesLinkedCount: number;
  entitiesCreated: number;
  entitiesReused: number;
  sourcesLinkedCount: number;
  relationsCreated: number;
  activityRowsCreated: number;
};

export type PublisherRepository = {
  findEventByKey(eventKey: string): Promise<EventRow | null>;
  findActiveRegion(code: string): Promise<RegionRow | null>;
  findActiveCategories(slugs: string[]): Promise<CategoryRow[]>;
  findSources(ids: string[]): Promise<SourceRow[]>;
  findEventSourceIds(eventId: string): Promise<string[]>;
  findArticleByEventId(eventId: string): Promise<ArticleRow | null>;
  findArticleBySlug(slug: string): Promise<ArticleRow | null>;
  findExactEntities(entities: Array<{ entityType: string; canonicalName: string; countryCode: string | null }>): Promise<EntityRow[]>;
  publishAtomic(payload: Json): Promise<{
    eventId: string;
    articleId: string;
    eventAction: "created" | "reused";
    articleAction: "created" | "reused" | "updated";
    articleOperation: "upsert_by_event_id";
    categoriesLinkedCount: number;
    entitiesLinkedCount: number;
    entitiesCreated: number;
    entitiesReused: number;
    sourcesLinkedCount: number;
    relationsCreated: number;
    activityRowsCreated: number;
  }>;
  publishReviewedAtomic?(payload: Json, target: ReviewedPublicationTarget): Promise<AtomicPublicationResult>;
  publishFactualRemediationAtomic?(payload: Json, target: FactualRemediationPublicationTarget): Promise<AtomicPublicationResult>;
};
