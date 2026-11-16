import type { SupabaseClient } from "@supabase/supabase-js";
import type { DiscoveryCandidate, ExtractedItem } from "../contracts/index.ts";
import type { Database, Json } from "../../../types/database.ts";
import type { ExtractionResult } from "../extraction/extraction-types.ts";

type Client = SupabaseClient<Database>;
type RawItemInsert = Database["public"]["Tables"]["raw_items"]["Insert"];

export type RawItemTraceability = {
  sourceItemId: string;
  rawItemId: string;
  sourceId: string;
  action: "created" | "reused";
  /** True only when this call issued an update to an existing raw_items row. */
  updated?: boolean;
};

export type RawItemPersistenceOutcome = {
  sourceItemId: string;
  sourceId: string;
  rawItemId: string | null;
  outcome: "created" | "updated" | "reused" | "failed" | "not_requested";
};

export type RawItemPersistenceInput = RawItemInsert & {
  sourceItemId: string;
};

export type RawItemPersistenceOptions = {
  updateExisting?: boolean;
  skipIfProcessed?: boolean;
};

export type RawItemPersistenceResult = RawItemTraceability;

const processedStatuses = new Set(["processed", "extracted", "extraction_partial"]);

function sourceItemIdForCandidate(candidate: DiscoveryCandidate): string {
  return candidate.externalId;
}

function sourceItemIdForExtraction(result: ExtractionResult): string {
  return result.candidate.externalId;
}

function metadataJson(item: ExtractedItem | null): Json | null {
  return item ? (item.metadata as Json) : null;
}

export function rawItemInputFromCandidate(candidate: DiscoveryCandidate, contentHash: string | null): RawItemPersistenceInput {
  return {
    sourceItemId: sourceItemIdForCandidate(candidate),
    source_id: candidate.sourceId,
    original_url: candidate.url,
    canonical_url: candidate.url,
    external_id: candidate.externalId,
    title: candidate.titleOriginal,
    excerpt: candidate.excerptOriginal,
    raw_content: null,
    content_type: "article",
    language: candidate.language,
    published_at: candidate.publishedAt,
    discovered_at: candidate.discoveredAt,
    content_hash: contentHash,
    processing_status: "pending",
  };
}

export function rawItemInputFromExtraction(result: ExtractionResult): RawItemPersistenceInput {
  const item = result.item;
  return {
    sourceItemId: sourceItemIdForExtraction(result),
    source_id: result.candidate.sourceId,
    original_url: result.candidate.url,
    canonical_url: item?.canonicalUrl ?? result.candidate.url,
    external_id: result.candidate.externalId,
    title: item?.title ?? result.candidate.titleOriginal,
    excerpt: item?.description ?? result.candidate.excerptOriginal,
    raw_content: item?.content ?? null,
    content_type: "article",
    language: item?.language ?? result.candidate.language,
    published_at: item?.publishedAt ?? result.candidate.publishedAt,
    discovered_at: result.candidate.discoveredAt,
    content_hash: item?.contentHash ?? null,
    processing_status: item ? (result.quality === "full" ? "extracted" : "extraction_partial") : "extraction_failed",
    processing_attempts: 1,
    extraction_quality: item?.extractionQuality ?? "failed",
    extracted_at: item ? new Date().toISOString() : null,
    error_code: result.error?.code ?? null,
    error_message: result.error?.message ?? null,
    normalized_payload: metadataJson(item),
  };
}

async function assertSourceExists(client: Client, sourceId: string): Promise<void> {
  const source = await client.from("sources").select("id").eq("id", sourceId).maybeSingle();
  if (source.error) throw new Error("Unable to resolve raw item source");
  if (!source.data) throw new Error("Raw item source does not exist");
}

/**
 * Persists a raw item through the database's unique source-item identity.
 * The insert is the concurrency arbiter; a unique violation is resolved by an
 * exact identity lookup, never by URL/title similarity.
 */
export async function persistRawItem(
  client: Client,
  input: RawItemPersistenceInput,
  options: RawItemPersistenceOptions = {},
): Promise<RawItemPersistenceResult> {
  await assertSourceExists(client, input.source_id);
  const { sourceItemId, ...payload } = input;
  const inserted = await client.from("raw_items").insert(payload).select("id").maybeSingle();
  if (!inserted.error && inserted.data) {
    return { sourceItemId, rawItemId: inserted.data.id, sourceId: input.source_id, action: "created", updated: false };
  }
  if (inserted.error?.code !== "23505") {
    throw new Error(`persist raw_item failed: ${inserted.error?.message ?? "no row returned"}`);
  }

  const existing = await client
    .from("raw_items")
    .select("id,processing_status,processing_attempts")
    .eq("source_id", input.source_id)
    .eq("external_id", sourceItemId)
    .maybeSingle();
  if (existing.error || !existing.data) throw new Error("Raw item conflict could not be resolved by exact source identity");

  const skippedProcessed = options.skipIfProcessed && processedStatuses.has(existing.data.processing_status);
  const updated = options.updateExisting === true && !skippedProcessed;
  if (updated) {
    const update = await client.from("raw_items").update({ ...payload, processing_attempts: existing.data.processing_attempts + 1 }).eq("id", existing.data.id);
    if (update.error) throw new Error(`update raw_item failed: ${update.error.message}`);
  }

  return { sourceItemId, rawItemId: existing.data.id, sourceId: input.source_id, action: "reused", updated };
}
