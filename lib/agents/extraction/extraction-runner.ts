import { JSDOM } from "jsdom";
import type { SupabaseClient } from "@supabase/supabase-js";
import { extractedItemSchema, type DiscoveryCandidate, type ExtractedItem, type ExtractionQuality } from "../contracts/index.ts";
import { runDiscovery } from "../discovery/discovery-runner.ts";
import { canonicalizeUrl } from "../discovery/canonical-url.ts";
import { createSupabaseServerClient } from "../../supabase/server-client.ts";
import type { Database } from "../../../types/database.ts";
import { ContentFetchError, fetchContent } from "./content-fetcher.ts";
import { hashContent } from "./content-hash.ts";
import { extractPageMetadata } from "./metadata-extractor.ts";
import { persistRawItem, rawItemInputFromExtraction, type RawItemTraceability } from "../ingestion/raw-item-repository.ts";
import { extractReadableContent } from "./readability-extractor.ts";
import type { ExtractionResult, ExtractionRunOptions, ExtractionRunResult } from "./extraction-types.ts";

const defaultTimeoutMs = 15_000;
const defaultConcurrency = 3;

function truncate(value: string | null, maxLength: number): string | null {
  return value ? value.trim().slice(0, maxLength) : null;
}

function validLanguage(value: string | null): string | null {
  return value && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(value) ? value : null;
}

function baseMetadata(candidate: DiscoveryCandidate, finalUrl: string, contentType: string, quality: ExtractionQuality) {
  return {
    sourceId: candidate.sourceId,
    sourceName: candidate.sourceName,
    sourceCountryCode: candidate.possibleCountryCode,
    sourceRegionCode: candidate.possibleRegionCode,
    finalUrl,
    contentType,
    extractionQuality: quality,
  };
}

function makeExtractedItem(
  candidate: DiscoveryCandidate,
  values: {
    canonicalUrl: string;
    title: string | null;
    description: string | null;
    author: string | null;
    publishedAt: string | null;
    language: string | null;
    content: string;
    metadata: Record<string, unknown>;
    extractionQuality: ExtractionQuality;
  }
): ExtractedItem {
  return extractedItemSchema.parse({
    schemaVersion: 1,
    candidateId: candidate.externalId,
    url: candidate.url,
    canonicalUrl: values.canonicalUrl,
    title: truncate(values.title, 500) ?? candidate.titleOriginal,
    description: truncate(values.description, 3_000) ?? candidate.excerptOriginal,
    author: truncate(values.author, 300),
    publishedAt: values.publishedAt,
    language: validLanguage(values.language) ?? candidate.language,
    content: values.content,
    contentHash: hashContent(values.content),
    metadata: values.metadata,
    extractionQuality: values.extractionQuality,
  });
}

function failureResult(
  candidate: DiscoveryCandidate,
  startedAt: number,
  status: "blocked" | "failed",
  error: { code: string; message: string; statusCode?: number },
  fetchOutcome: ExtractionResult["fetchOutcome"],
  parserOutcome: ExtractionResult["parserOutcome"] = "not_reached",
): ExtractionResult {
  return {
    candidate,
    status,
    quality: "failed",
    item: null,
    contentLength: 0,
    error,
    durationMs: Date.now() - startedAt,
    rawItemId: null,
    attempted: true,
    fetchOutcome,
    parserOutcome,
    rawItemMappingOutcome: "not_requested",
    rawItemUpdated: false,
  };
}

function metadataOnlyResult(candidate: DiscoveryCandidate, startedAt: number, contentType: string): ExtractionResult | null {
  if (!candidate.excerptOriginal) return null;
  const quality: ExtractionQuality = "metadata_only";
  const item = makeExtractedItem(candidate, {
    canonicalUrl: canonicalizeUrl(candidate.url),
    title: candidate.titleOriginal,
    description: candidate.excerptOriginal,
    author: null,
    publishedAt: candidate.publishedAt,
    language: candidate.language,
    content: candidate.excerptOriginal,
    metadata: {
      ...baseMetadata(candidate, candidate.url, contentType, quality),
      fallback: "discovery_excerpt",
      publisherName: null,
      dateSource: candidate.publishedAt ? "rss" : null,
      openGraph: {},
      jsonLd: null,
    },
    extractionQuality: quality,
  });
  return {
    candidate,
    status: "success",
    quality,
    item,
    contentLength: item.content.length,
    error: null,
    durationMs: Date.now() - startedAt,
    rawItemId: null,
    attempted: true,
    fetchOutcome: "metadata_fallback",
    parserOutcome: "not_reached",
    rawItemMappingOutcome: "not_requested",
    rawItemUpdated: false,
  };
}

export async function extractCandidate(candidate: DiscoveryCandidate, timeoutMs = defaultTimeoutMs): Promise<ExtractionResult> {
  const startedAt = Date.now();
  let fetchOutcome: ExtractionResult["fetchOutcome"] = "not_attempted";
  try {
    let fetched;
    try {
      fetched = await fetchContent(candidate.url, timeoutMs);
      fetchOutcome = "succeeded";
    } catch (error) {
      if (error instanceof ContentFetchError) {
        if (error.code === "content_type") {
          const fallback = metadataOnlyResult(candidate, startedAt, error.contentType ?? "unknown");
          if (fallback) return fallback;
        }
        const blocked = error.code === "blocked";
        return failureResult(candidate, startedAt, blocked ? "blocked" : "failed", {
          code: error.code,
          message: error.message,
          statusCode: error.statusCode,
        }, blocked ? "blocked" : "failed");
      }
      return failureResult(candidate, startedAt, "failed", {
        code: "fetch_error",
        message: error instanceof Error ? error.message : "content fetch failed",
      }, "failed");
    }

    const document = new JSDOM(fetched.html, { url: fetched.finalUrl }).window.document;
    const metadata = extractPageMetadata(document as never, candidate, fetched.finalUrl, fetched.contentType);
    const readable = extractReadableContent(document as never);
    const content = readable.content ?? metadata.description ?? candidate.excerptOriginal;
    if (!content) {
      return failureResult(candidate, startedAt, "failed", { code: "empty_content", message: "no editorial content or description found" }, "succeeded", "succeeded");
    }

    const quality: ExtractionQuality = readable.content ? readable.quality : "metadata_only";
    const item = makeExtractedItem(candidate, {
      canonicalUrl: metadata.canonicalUrl ?? canonicalizeUrl(fetched.finalUrl),
      title: metadata.title,
      description: metadata.description,
      author: metadata.author,
      publishedAt: metadata.publishedAt,
      language: metadata.language,
      content,
      metadata: {
        ...baseMetadata(candidate, fetched.finalUrl, fetched.contentType, quality),
        publisherName: metadata.publisherName,
        dateSource: metadata.dateSource,
        openGraph: metadata.openGraph,
        jsonLd: metadata.jsonLd,
      },
      extractionQuality: quality,
    });
    return {
      candidate,
      status: "success",
      quality,
      item,
      contentLength: item.content.length,
      error: null,
      durationMs: Date.now() - startedAt,
      rawItemId: null,
      attempted: true,
      fetchOutcome,
      parserOutcome: "succeeded",
      rawItemMappingOutcome: "not_requested",
      rawItemUpdated: false,
    };
  } catch (error) {
    return failureResult(candidate, startedAt, "failed", {
      code: "parse_error",
      message: error instanceof Error ? error.message : "HTML extraction failed",
    }, fetchOutcome === "not_attempted" ? "failed" : fetchOutcome, "failed");
  }
}

type ExtractionSupabaseClient = SupabaseClient<Database>;
async function persistExtractionResult(
  supabase: ExtractionSupabaseClient,
  result: ExtractionResult
): Promise<RawItemTraceability> {
  return persistRawItem(supabase, rawItemInputFromExtraction(result), { updateExisting: true, skipIfProcessed: true });
}

export async function persistExtractionResults(
  supabase: ExtractionSupabaseClient,
  results: ExtractionResult[]
): Promise<{ persisted: number; persistUpdated: number; persistSkipped: number; persistErrors: number; traceability: RawItemTraceability[] }> {
  let persisted = 0;
  let persistUpdated = 0;
  let persistSkipped = 0;
  let persistErrors = 0;
  const traceability: RawItemTraceability[] = [];
  for (const result of results) {
    try {
      const outcome = await persistExtractionResult(supabase, result);
      result.rawItemId = outcome.rawItemId;
      result.rawItemUpdated = outcome.updated === true;
      result.rawItemMappingOutcome = outcome.updated ? "updated" : outcome.action;
      traceability.push(outcome);
      if (outcome.updated) persistUpdated += 1;
      else if (outcome.action === "reused") persistSkipped += 1;
      else persisted += 1;
    } catch (error) {
      persistErrors += 1;
      result.rawItemMappingOutcome = "failed";
      result.rawItemUpdated = false;
      console.error(`persist error for ${result.candidate.sourceName}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  return { persisted, persistUpdated, persistSkipped, persistErrors, traceability };
}

export async function runExtraction(options: ExtractionRunOptions): Promise<ExtractionRunResult> {
  if (!Number.isFinite(options.hours) || options.hours <= 0 || options.hours > 168) throw new Error("hours must be greater than 0 and no more than 168");
  if (!Number.isInteger(options.limit) || options.limit <= 0 || options.limit > 100) throw new Error("limit must be an integer between 1 and 100");
  const startedAt = new Date();
  const discovery = await runDiscovery({ hours: options.hours, persist: false, now: options.now });
  const candidates = discovery.candidates.slice(0, options.limit);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? defaultConcurrency, 3));
  const results: Array<ExtractionResult | undefined> = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < candidates.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await extractCandidate(candidates[index], options.timeoutMs ?? defaultTimeoutMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(candidates.length, 1)) }, () => worker()));
  const completed = results.filter((result): result is ExtractionResult => Boolean(result));
  let persisted = 0;
  let persistUpdated = 0;
  let persistSkipped = 0;
  let persistErrors = 0;
  let traceability: RawItemTraceability[] = [];
  if (options.persist) {
    ({ persisted, persistUpdated, persistSkipped, persistErrors, traceability } = await persistExtractionResults(options.supabase ?? createSupabaseServerClient(), completed));
  }

  const contentResults = completed.filter((result) => result.item !== null);
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    hours: options.hours,
    limit: options.limit,
    candidatesSelected: candidates.length,
    results: completed,
    full: completed.filter((result) => result.quality === "full").length,
    partial: completed.filter((result) => result.quality === "partial").length,
    metadataOnly: completed.filter((result) => result.quality === "metadata_only").length,
    blocked: completed.filter((result) => result.status === "blocked").length,
    failed: completed.filter((result) => result.status === "failed").length,
    averageContentLength: contentResults.length === 0 ? 0 : Math.round(contentResults.reduce((sum, result) => sum + result.contentLength, 0) / contentResults.length),
    persisted,
    persistUpdated,
    persistSkipped,
    persistErrors,
    traceability,
  };
}
