import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../../types/database.ts";
import { createSupabaseServerClient } from "../../supabase/server-client.ts";
import type { AtomicPublicationResult, FactualRemediationPublicationTarget, PublisherRepository, ReviewedPublicationTarget } from "./publisher-repository.ts";
import type { EntityRow } from "./publisher-repository.ts";
import { assertHumanReviewPublicationTarget } from "./human-review-policy.ts";

type Client = SupabaseClient<Database>;

function entityKey(entityType: string, canonicalName: string, countryCode: string | null): string {
  return `${entityType}\u0000${canonicalName}\u0000${countryCode ?? ""}`;
}

export class SupabasePublisherRepository implements PublisherRepository {
  private readonly supabase: Client;

  constructor(supabase: Client = createSupabaseServerClient()) {
    this.supabase = supabase;
  }

  async findEventByKey(eventKey: string) {
    const response = await this.supabase.from("events").select("id,event_key,canonical_title,primary_region_id,primary_country_code,occurred_at").eq("event_key", eventKey).maybeSingle();
    if (response.error) throw new Error("Unable to resolve publication event");
    return response.data;
  }

  async findActiveRegion(code: string) {
    const response = await this.supabase.from("regions").select("id,code,latitude,longitude,is_active").eq("code", code).eq("is_active", true).maybeSingle();
    if (response.error) throw new Error("Unable to resolve publication region");
    return response.data;
  }

  async findActiveCategories(slugs: string[]) {
    if (slugs.length === 0) return [];
    const response = await this.supabase.from("categories").select("id,slug,is_active").in("slug", slugs).eq("is_active", true);
    if (response.error) throw new Error("Unable to resolve publication categories");
    return response.data ?? [];
  }

  async findSources(ids: string[]) {
    if (ids.length === 0) return [];
    const response = await this.supabase.from("sources").select("id,name,url,is_active").in("id", ids);
    if (response.error) throw new Error("Unable to resolve publication sources");
    return response.data ?? [];
  }

  async findRawItemOwnership(rawItemId: string, sourceId: string): Promise<boolean> {
    const response = await this.supabase
      .from("raw_items")
      .select("id", { count: "exact", head: true })
      .eq("id", rawItemId)
      .eq("source_id", sourceId);
    if (response.error) throw new Error("Unable to resolve raw item ownership");
    return response.count === 1;
  }

  async findEventSourceIds(eventId: string) {
    const response = await this.supabase.from("event_sources").select("source_id").eq("event_id", eventId);
    if (response.error) throw new Error("Unable to resolve event source traceability");
    return (response.data ?? []).map((row) => row.source_id);
  }

  async findArticleByEventId(eventId: string) {
    const response = await this.supabase.from("articles").select("id,event_id,slug,publication_status").eq("event_id", eventId).maybeSingle();
    if (response.error) throw new Error("Unable to resolve publication article");
    return response.data;
  }

  async findArticleBySlug(slug: string) {
    const response = await this.supabase.from("articles").select("id,event_id,slug,publication_status").eq("slug", slug).maybeSingle();
    if (response.error) throw new Error("Unable to resolve publication slug");
    return response.data;
  }

  async findExactEntities(entities: Array<{ entityType: string; canonicalName: string; countryCode: string | null }>): Promise<EntityRow[]> {
    if (entities.length === 0) return [];
    const types = [...new Set(entities.map((entity) => entity.entityType))];
    const names = [...new Set(entities.map((entity) => entity.canonicalName))];
    const response = await this.supabase.from("entities").select("id,entity_type,canonical_name,country_code").in("entity_type", types).in("canonical_name", names);
    if (response.error) throw new Error("Unable to resolve publication entities");
    const requested = new Set(entities.map((entity) => entityKey(entity.entityType, entity.canonicalName, entity.countryCode)));
    return (response.data ?? []).filter((entity) => requested.has(entityKey(entity.entity_type, entity.canonical_name, entity.country_code)));
  }

  async publishAtomic(payload: Json): Promise<AtomicPublicationResult> {
    void payload;
    throw new Error("HUMAN_APPROVAL_REQUIRED");
  }

  async publishReviewedAtomic(payload: Json, target: ReviewedPublicationTarget) {
    assertHumanReviewPublicationTarget(target);
    if (String((payload as Record<string, Json>).eventKey ?? "") !== target.eventKey) throw new Error("HUMAN_APPROVAL_REQUIRED");
    const response = await this.supabase.rpc("publish_reviewed_article_atomic", {
      p_review_id: target.reviewId,
      p_event_key: String((payload as Record<string, Json>).eventKey ?? ""),
      p_attempt_id: target.attemptId,
      p_pipeline_run_id: target.pipelineRunId,
      p_draft_id: target.draftId,
      p_draft_sha256: target.draftSha256,
      p_checkpoint_hashes: target.checkpoints,
      p_source_lineage: target.sourceLineage,
      p_publication_payload: payload,
    });
    if (response.error) {
      const safeCode = response.error.message.match(/(?:human_review|publication)_[a-z_]+/)?.[0];
      throw new Error(safeCode ?? "reviewed_publication_transaction_failed");
    }
    const value = response.data;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("reviewed_publication_transaction_failed");
    const result = value as Record<string, Json | undefined>;
    if (result.humanReviewId !== target.reviewId || result.humanReviewStatus !== "PUBLISHED" || typeof result.eventId !== "string" || typeof result.articleId !== "string" || !["created", "reused"].includes(String(result.eventAction)) || !["created", "reused", "updated"].includes(String(result.articleAction)) || result.articleOperation !== "upsert_by_event_id" || typeof result.categoriesLinkedCount !== "number" || typeof result.entitiesLinkedCount !== "number" || typeof result.entitiesCreated !== "number" || typeof result.entitiesReused !== "number" || typeof result.sourcesLinkedCount !== "number" || typeof result.relationsCreated !== "number" || typeof result.activityRowsCreated !== "number") throw new Error("reviewed_publication_transaction_failed");
    return {
      eventId: result.eventId, articleId: result.articleId,
      eventAction: result.eventAction as "created" | "reused",
      articleAction: result.articleAction as "created" | "reused" | "updated",
      articleOperation: "upsert_by_event_id" as const,
      categoriesLinkedCount: result.categoriesLinkedCount, entitiesLinkedCount: result.entitiesLinkedCount,
      entitiesCreated: result.entitiesCreated, entitiesReused: result.entitiesReused,
      sourcesLinkedCount: result.sourcesLinkedCount, relationsCreated: result.relationsCreated,
      activityRowsCreated: result.activityRowsCreated,
    };
  }

  async publishFactualRemediationAtomic(payload: Json, target: FactualRemediationPublicationTarget): Promise<AtomicPublicationResult> {
    void payload;
    void target;
    throw new Error("HUMAN_APPROVAL_REQUIRED");
  }
}
