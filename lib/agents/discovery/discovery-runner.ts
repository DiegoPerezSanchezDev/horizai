import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/database.ts";
import { createSupabaseServerClient } from "../../supabase/server-client.ts";
import { fetchFeed, FeedFetchError } from "./feed-fetcher.ts";
import { parseFeed } from "./feed-parser.ts";
import { normalizeCandidate } from "./normalize-candidate.ts";
import { getActiveDiscoverySources } from "./source-registry.ts";
import { persistRawItem, rawItemInputFromCandidate, type RawItemPersistenceOutcome, type RawItemTraceability } from "../ingestion/raw-item-repository.ts";
import type {
  CandidateRecord,
  DiscoveryRunOptions,
  DiscoveryRunResult,
  ParsedFeedItem,
  SourceDiscoveryResult,
  SourceRegistryEntry,
} from "./discovery-types.ts";

const defaultTimeoutMs = 15_000;
const defaultConcurrency = 4;

function assertHours(hours: number): void {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error("hours must be greater than 0 and no more than 168");
  }
}

export function isWithinDiscoveryWindow(item: ParsedFeedItem, cutoff: number, now: number): boolean {
  if (!item.dateReliable || !item.publishedAt) return false;
  const publishedAt = Date.parse(item.publishedAt);
  return publishedAt >= cutoff && publishedAt <= now + 5 * 60 * 1000;
}

function emptySourceResult(
  source: SourceRegistryEntry,
  startedAt: number,
  error: SourceDiscoveryResult["error"] = null
): SourceDiscoveryResult {
  return {
    source,
    status: "empty",
    discovered: 0,
    valid: 0,
    invalid: 0,
    undatedExcluded: 0,
    error,
    durationMs: Date.now() - startedAt,
  };
}

async function discoverSource(
  source: SourceRegistryEntry,
  cutoff: number,
  now: Date,
  timeoutMs: number
): Promise<{ result: SourceDiscoveryResult; records: CandidateRecord[] }> {
  const startedAt = Date.now();
  if (!source.feedUrl || (source.discoveryMethod !== "rss" && source.discoveryMethod !== "atom")) {
    return { result: emptySourceResult(source, startedAt, { code: "feed_not_configured", message: "No RSS/Atom feed configured" }), records: [] };
  }

  let xml: string;
  try {
    xml = (await fetchFeed(source.feedUrl, timeoutMs)).text;
  } catch (error) {
    const fetchError = error instanceof FeedFetchError ? error : new FeedFetchError("request failed", "http_error");
    return {
      result: {
        ...emptySourceResult(source, startedAt),
        status: fetchError.code,
        error: { code: fetchError.code, message: fetchError.message, statusCode: fetchError.statusCode },
        durationMs: Date.now() - startedAt,
      },
      records: [],
    };
  }

  let items: ParsedFeedItem[];
  try {
    items = parseFeed(xml);
  } catch (error) {
    return {
      result: {
        ...emptySourceResult(source, startedAt),
        status: "parse_error",
        error: { code: "parse_error", message: error instanceof Error ? error.message : "XML parse failed" },
        durationMs: Date.now() - startedAt,
      },
      records: [],
    };
  }

  if (items.length === 0) {
    return { result: emptySourceResult(source, startedAt), records: [] };
  }

  let undatedExcluded = 0;
  let invalid = 0;
  const records: CandidateRecord[] = [];
  for (const item of items) {
    if (!item.dateReliable) {
      undatedExcluded += 1;
      continue;
    }
    if (!isWithinDiscoveryWindow(item, cutoff, now.getTime())) continue;

    const normalized = normalizeCandidate(source, item, now);
    if ("error" in normalized) {
      invalid += 1;
      continue;
    }
    records.push(normalized.record);
  }

  return {
    result: {
      source,
      status: "success",
      discovered: items.length,
      valid: records.length,
      invalid,
      undatedExcluded,
      error: null,
      durationMs: Date.now() - startedAt,
    },
    records,
  };
}

export function deduplicateCandidates(records: CandidateRecord[]): {
  records: CandidateRecord[];
  duplicateUrls: number;
  duplicateContentHashes: number;
} {
  const seenUrls = new Set<string>();
  const seenContentHashes = new Set<string>();
  const deduplicated: CandidateRecord[] = [];
  let duplicateUrls = 0;
  let duplicateContentHashes = 0;

  for (const record of records) {
    if (seenUrls.has(record.canonicalUrl)) {
      duplicateUrls += 1;
      continue;
    }
    if (record.contentHash && seenContentHashes.has(`${record.candidate.sourceId}:${record.contentHash}`)) {
      duplicateContentHashes += 1;
      continue;
    }
    seenUrls.add(record.canonicalUrl);
    if (record.contentHash) seenContentHashes.add(`${record.candidate.sourceId}:${record.contentHash}`);
    deduplicated.push(record);
  }

  return { records: deduplicated, duplicateUrls, duplicateContentHashes };
}

type DiscoverySupabaseClient = SupabaseClient<Database>;

async function persistCandidate(
  supabase: DiscoverySupabaseClient,
  record: CandidateRecord
): Promise<RawItemTraceability> {
  return persistRawItem(supabase, rawItemInputFromCandidate(record.candidate, record.contentHash));
}

async function persistCandidates(
  supabase: DiscoverySupabaseClient,
  records: CandidateRecord[]
): Promise<{ persisted: number; persistSkipped: number; persistErrors: number; traceability: RawItemTraceability[]; persistenceOutcomes: RawItemPersistenceOutcome[] }> {
  let persisted = 0;
  let persistSkipped = 0;
  let persistErrors = 0;
  const traceability: RawItemTraceability[] = [];
  const persistenceOutcomes: RawItemPersistenceOutcome[] = [];

  for (const record of records) {
    try {
      const result = await persistCandidate(supabase, record);
      traceability.push(result);
      persistenceOutcomes.push({ sourceItemId: result.sourceItemId, sourceId: result.sourceId, rawItemId: result.rawItemId, outcome: result.updated ? "updated" : result.action });
      if (result.action === "created") persisted += 1;
      else persistSkipped += 1;
    } catch (error) {
      persistErrors += 1;
      persistenceOutcomes.push({ sourceItemId: record.candidate.externalId, sourceId: record.candidate.sourceId, rawItemId: null, outcome: "failed" });
      console.error(`persist error for ${record.candidate.sourceName}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  return { persisted, persistSkipped, persistErrors, traceability, persistenceOutcomes };
}

async function updateSourceHealth(
  supabase: DiscoverySupabaseClient,
  sourceResults: SourceDiscoveryResult[],
  now: Date
): Promise<void> {
  for (const result of sourceResults) {
    const failed = result.status === "timeout" || result.status === "http_error" || result.status === "parse_error";
    const errorText = result.error?.message ?? null;
    const update = {
      last_checked_at: now.toISOString(),
      last_fetched_at: now.toISOString(),
      last_success_at: failed ? undefined : now.toISOString(),
      last_error: errorText,
      last_error_at: failed ? now.toISOString() : null,
    };
    const { error } = await supabase.from("sources").update(update).eq("id", result.source.id);
    if (error) console.error(`source health update failed for ${result.source.name}: ${error.message}`);
  }
}

export async function discoverFromSources(
  sources: SourceRegistryEntry[],
  options: DiscoveryRunOptions,
  supabase?: DiscoverySupabaseClient
): Promise<DiscoveryRunResult> {
  assertHours(options.hours);
  const startedAt = new Date();
  const now = options.now ?? startedAt;
  const cutoff = now.getTime() - options.hours * 60 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? defaultConcurrency, 5));
  const results: Array<{ result: SourceDiscoveryResult; records: CandidateRecord[] } | undefined> = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < sources.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await discoverSource(sources[index], cutoff, now, timeoutMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(sources.length, 1)) }, () => worker()));

  const sourceResults = results.map((entry) => entry?.result).filter((entry): entry is SourceDiscoveryResult => Boolean(entry));
  const allRecords = results.flatMap((entry) => entry?.records ?? []);
  const deduplicated = deduplicateCandidates(allRecords);
  let persisted = 0;
  let persistSkipped = 0;
  let persistErrors = 0;
  let traceability: RawItemTraceability[] = [];
  let persistenceOutcomes: RawItemPersistenceOutcome[] = deduplicated.records.map(({ candidate }) => ({ sourceItemId: candidate.externalId, sourceId: candidate.sourceId, rawItemId: null, outcome: "not_requested" }));

  if (options.persist) {
    const activeSupabase = supabase ?? createSupabaseServerClient();
    ({ persisted, persistSkipped, persistErrors, traceability, persistenceOutcomes } = await persistCandidates(activeSupabase, deduplicated.records));
    await updateSourceHealth(activeSupabase, sourceResults, now);
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    hours: options.hours,
    sources: sourceResults,
    candidates: deduplicated.records.map((record) => record.candidate),
    candidatesDiscovered: allRecords.length,
    duplicateUrls: deduplicated.duplicateUrls,
    duplicateContentHashes: deduplicated.duplicateContentHashes,
    invalidCandidates: sourceResults.reduce((sum, result) => sum + result.invalid, 0),
    undatedExcluded: sourceResults.reduce((sum, result) => sum + result.undatedExcluded, 0),
    persisted,
    persistSkipped,
    persistErrors,
    traceability,
    persistenceOutcomes,
  };
}

export async function runDiscovery(options: DiscoveryRunOptions): Promise<DiscoveryRunResult> {
  const sources = await getActiveDiscoverySources();
  return discoverFromSources(sources, options, options.supabase);
}
