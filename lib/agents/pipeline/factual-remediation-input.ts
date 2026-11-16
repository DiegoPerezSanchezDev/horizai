import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clusterExtractedItems } from "../clustering/cluster-runner.ts";
import { extractedItemSchema, type ExtractedItem } from "../contracts/index.ts";
import { candidateExternalId, canonicalizeUrl } from "../discovery/canonical-url.ts";
import { hashContent } from "../extraction/content-hash.ts";
import type { Database } from "../../../types/database.ts";
import { factualRemediationIncident } from "./factual-remediation.ts";
import type { PipelineEventContext, PipelineSourceMetadata } from "./pipeline-types.ts";

type Client = SupabaseClient<Database>;
export type FactualRemediationInput = Pick<PipelineEventContext, "event" | "items" | "sources">;

function assertSourceHost(urlValue: string, sourceUrls: string[]): void {
  const targetHost = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, "");
  const knownHosts = sourceUrls.map((value) => new URL(value).hostname.toLowerCase().replace(/^www\./, ""));
  if (!knownHosts.includes(targetHost)) throw new Error("FACTUAL_REMEDIATION_SOURCE_HOST_MISMATCH");
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Loads only the incident's persisted event/raw/source lineage. It performs no discovery or web fetch. */
export async function loadFactualRemediationInput(supabase: Client): Promise<FactualRemediationInput> {
  const target = factualRemediationIncident;
  const [eventResult, articleResult, sourceLinksResult] = await Promise.all([
    supabase.from("events").select("id,event_key,canonical_title,event_status,review_status").eq("id", target.eventId).maybeSingle(),
    supabase.from("articles").select("id,event_id,slug,publication_status").eq("id", target.articleId).maybeSingle(),
    supabase.from("event_sources").select("raw_item_id,source_id").eq("event_id", target.eventId),
  ]);
  if (eventResult.error || articleResult.error || sourceLinksResult.error) throw new Error("FACTUAL_REMEDIATION_LINEAGE_READ_FAILED");
  const eventRow = eventResult.data;
  const articleRow = articleResult.data;
  const sourceLinks = sourceLinksResult.data ?? [];
  if (!eventRow || eventRow.event_key !== target.eventKey || eventRow.event_status !== "active" || eventRow.review_status !== "approved") throw new Error("FACTUAL_REMEDIATION_EVENT_IDENTITY_MISMATCH");
  if (!articleRow || articleRow.event_id !== target.eventId || articleRow.slug !== target.articleSlug || articleRow.publication_status !== "archived") throw new Error("FACTUAL_REMEDIATION_ARTICLE_NOT_ARCHIVED");
  if (sourceLinks.length !== 1 || sourceLinks[0]?.raw_item_id !== target.rawItemId || sourceLinks[0]?.source_id !== target.sourceId) throw new Error("FACTUAL_REMEDIATION_RAW_LINEAGE_MISMATCH");

  const [rawResult, sourceResult] = await Promise.all([
    supabase.from("raw_items").select("id,source_id,original_url,canonical_url,external_id,title,excerpt,raw_content,language,published_at,content_hash,extraction_quality,processing_status,normalized_payload").eq("id", target.rawItemId).maybeSingle(),
    supabase.from("sources").select("id,name,url,feed_url,source_type,country_code,language,is_active").eq("id", target.sourceId).maybeSingle(),
  ]);
  if (rawResult.error || sourceResult.error) throw new Error("FACTUAL_REMEDIATION_RAW_READ_FAILED");
  const raw = rawResult.data;
  const source = sourceResult.data;
  if (!raw || !source || !source.is_active || source.id !== raw.source_id || source.name !== "TechCrunch AI") throw new Error("FACTUAL_REMEDIATION_SOURCE_OWNERSHIP_MISMATCH");
  if (raw.external_id !== "e8dd0363-f51e-4381-9fb2-c02ee81f4d41:97a055038b0de18e8e86e495b37445d7"
    || raw.processing_status !== "extracted" || raw.extraction_quality !== "full"
    || raw.content_hash !== target.rawContentHash
    || !raw.raw_content || raw.raw_content.length !== target.rawContentLength
    || createHash("sha256").update(raw.raw_content, "utf8").digest("hex") !== target.rawContentSha256
    || hashContent(raw.raw_content) !== raw.content_hash) {
    throw new Error("FACTUAL_REMEDIATION_STORED_EXTRACTION_CHANGED");
  }
  const url = raw.canonical_url ?? raw.original_url;
  const sourceUrls = [source.url, source.feed_url].filter((value): value is string => Boolean(value));
  assertSourceHost(raw.original_url, sourceUrls);
  assertSourceHost(url, sourceUrls);
  if (raw.external_id !== candidateExternalId(source.id, canonicalizeUrl(raw.original_url))) throw new Error("FACTUAL_REMEDIATION_SOURCE_ITEM_ID_MISMATCH");

  const item: ExtractedItem = extractedItemSchema.parse({
    schemaVersion: 1,
    candidateId: raw.external_id,
    url: raw.original_url,
    canonicalUrl: url,
    title: raw.title,
    description: raw.excerpt,
    author: null,
    publishedAt: raw.published_at,
    language: raw.language ?? source.language,
    content: raw.raw_content,
    contentHash: raw.content_hash,
    extractionQuality: raw.extraction_quality,
    metadata: {
      ...metadataObject(raw.normalized_payload),
      sourceId: source.id,
      sourceName: source.name,
      sourceType: source.source_type,
      sourceCountryCode: source.country_code,
    },
  });
  const clustered = clusterExtractedItems([item]).events;
  const event = clustered.find((candidate) => candidate.eventKey === target.eventKey);
  if (!event || event.canonicalTitle !== eventRow.canonical_title || event.sourceItems.length !== 1) throw new Error("FACTUAL_REMEDIATION_EVENT_RECONSTRUCTION_MISMATCH");

  const sourceItem = event.sourceItems[0];
  if (!sourceItem || sourceItem.candidateId !== item.candidateId || sourceItem.sourceId !== source.id) throw new Error("FACTUAL_REMEDIATION_CLUSTER_LINEAGE_MISMATCH");
  const sources: PipelineSourceMetadata[] = [{
    sourceId: source.id,
    sourceItemId: item.candidateId,
    rawItemId: raw.id,
    sourceName: source.name,
    sourceUrl: item.canonicalUrl,
    sourceType: source.source_type,
    countryCode: source.country_code,
    language: item.language,
  }];
  return { event, items: [item], sources };
}
