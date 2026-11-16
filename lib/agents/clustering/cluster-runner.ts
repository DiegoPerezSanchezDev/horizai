import type { SupabaseClient } from "@supabase/supabase-js";
import { clusteredEventSchema, type ClusteredEvent, type ExtractedItem } from "../contracts/index.ts";
import { runExtraction } from "../extraction/extraction-runner.ts";
import { clusteringConfig, type ClusteringConfig } from "./clustering-config.ts";
import { calculateClusterConfidence } from "./cluster-confidence.ts";
import { buildEventKey, chooseCanonicalTitle } from "./event-key.ts";
import { comparableItem } from "./normalize-event-text.ts";
import { scoreCandidatePair } from "./similarity.ts";
import type {
  ClusterReport,
  ClusterRunOptions,
  ClusterRunResult,
  ComparableItem,
  EventCluster,
  PairScore,
} from "./cluster-types.ts";
import type { Database, Json } from "../../../types/database.ts";

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("|");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function eventSourceCount(event: ClusteredEvent): number {
  return new Set(event.sourceItems.map((item) => item.sourceId)).size;
}

function majorityValue(items: ComparableItem[], field: "sourceCountryCode" | "sourceRegionCode"): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = item[field];
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}

function probableOccurredAt(items: ComparableItem[]): string | null {
  const dates = items.map((item) => item.publishedAtMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
  return dates.length === 0 ? null : new Date(dates[Math.floor(dates.length / 2)]).toISOString();
}

function buildClusterEvent(cluster: EventCluster): ClusteredEvent {
  const canonicalTitle = chooseCanonicalTitle(cluster.items);
  const clusterConfidence = calculateClusterConfidence(cluster.items, cluster.pairScores);
  const sourceItems = cluster.items.map((entry) => ({
    candidateId: entry.item.candidateId,
    sourceId: entry.sourceId,
    sourceName: entry.sourceName,
    url: entry.item.canonicalUrl,
    title: entry.item.title,
    publishedAt: entry.item.publishedAt,
  }));
  return clusteredEventSchema.parse({
    schemaVersion: 1,
    eventKey: buildEventKey(cluster.items, canonicalTitle),
    canonicalTitle,
    sourceItems,
    probableOccurredAt: probableOccurredAt(cluster.items),
    probableCountryCode: majorityValue(cluster.items, "sourceCountryCode"),
    probableRegionCode: majorityValue(cluster.items, "sourceRegionCode"),
    clusterConfidence,
  });
}

function clusterReasons(cluster: EventCluster): string[] {
  const reasons = cluster.pairScores.flatMap((pair) => pair.reasons);
  const sourceCount = new Set(cluster.items.map((item) => item.sourceId)).size;
  return uniqueStrings([
    `${sourceCount} fuente${sourceCount === 1 ? "" : "s"} distinta${sourceCount === 1 ? "" : "s"}`,
    ...reasons,
    ...(cluster.needsReview ? ["existe un par cercano al umbral; needs_review"] : []),
  ]);
}

export function clusterExtractedItems(items: ExtractedItem[], config: ClusteringConfig = clusteringConfig): {
  events: ClusteredEvent[];
  report: ClusterReport;
  duplicatesRemoved: number;
  needsReview: number;
  possibleFalseMerges: string[];
} {
  const seenUrls = new Set<string>();
  const uniqueItems = items.filter((item) => {
    if (seenUrls.has(item.canonicalUrl)) return false;
    seenUrls.add(item.canonicalUrl);
    return true;
  });
  const comparable = uniqueItems.map(comparableItem);
  const pairScores: PairScore[] = [];
  const pairMap = new Map<string, PairScore>();
  for (let leftIndex = 0; leftIndex < comparable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < comparable.length; rightIndex += 1) {
      const score = scoreCandidatePair(comparable[leftIndex], comparable[rightIndex], config);
      pairScores.push(score);
      pairMap.set(pairKey(score.leftCandidateId, score.rightCandidateId), score);
    }
  }

  const clusters: EventCluster[] = [];
  for (const item of comparable) {
    const compatible = clusters.filter((cluster) => cluster.items.every((member) => {
      const score = pairMap.get(pairKey(item.item.candidateId, member.item.candidateId));
      return score?.decision === "merge";
    }));
    const selected = compatible.sort((left, right) => {
      const leftAverage = left.items.reduce((sum, member) => sum + (pairMap.get(pairKey(item.item.candidateId, member.item.candidateId))?.score ?? 0), 0) / left.items.length;
      const rightAverage = right.items.reduce((sum, member) => sum + (pairMap.get(pairKey(item.item.candidateId, member.item.candidateId))?.score ?? 0), 0) / right.items.length;
      return rightAverage - leftAverage;
    })[0];
    if (selected) {
      selected.items.push(item);
    } else {
      clusters.push({ items: [item], pairScores: [], needsReview: false, ambiguousPairs: [] });
    }
  }

  const ambiguousPairs = pairScores.filter((pair) => pair.decision === "needs_review");
  for (const cluster of clusters) {
    const memberIds = new Set(cluster.items.map((item) => item.item.candidateId));
    cluster.pairScores = pairScores.filter((pair) => memberIds.has(pair.leftCandidateId) && memberIds.has(pair.rightCandidateId));
    cluster.ambiguousPairs = ambiguousPairs.filter((pair) => memberIds.has(pair.leftCandidateId) || memberIds.has(pair.rightCandidateId));
    cluster.needsReview = cluster.ambiguousPairs.length > 0;
  }

  const events = clusters.map(buildClusterEvent);
  const report: ClusterReport = {
    generatedAt: new Date().toISOString(),
    config,
    extractedItems: items.length,
    duplicatesRemoved: items.length - uniqueItems.length,
    pairScores,
    ambiguousPairs,
    clusters: clusters.map((cluster, index) => ({
      eventKey: events[index].eventKey,
      canonicalTitle: events[index].canonicalTitle,
      clusterConfidence: events[index].clusterConfidence,
      needsReview: cluster.needsReview,
      members: events[index].sourceItems,
      pairScores: cluster.pairScores,
      reasons: clusterReasons(cluster),
    })),
  };
  return {
    events,
    report,
    duplicatesRemoved: items.length - uniqueItems.length,
    needsReview: ambiguousPairs.length,
    possibleFalseMerges: [],
  };
}

type ClusterSupabaseClient = SupabaseClient<Database>;
type EventInsert = Database["public"]["Tables"]["events"]["Insert"];
type EventSourceInsert = Database["public"]["Tables"]["event_sources"]["Insert"];

export async function persistClusterEvents(
  supabase: ClusterSupabaseClient,
  events: ClusteredEvent[],
  comparableItems: Map<string, ExtractedItem>,
  rawItemIds: ReadonlyMap<string, string | null>,
): Promise<Pick<ClusterRunResult, "persistedEvents" | "persistedEventSources" | "persistSkipped" | "persistErrors">> {
  const regionsResult = await supabase.from("regions").select("id,code");
  if (regionsResult.error) throw new Error(`read regions for cluster persistence: ${regionsResult.error.message}`);
  const regionIds = new Map((regionsResult.data ?? []).map((region) => [region.code, region.id]));
  let persistedEvents = 0;
  let persistedEventSources = 0;
  let persistSkipped = 0;
  let persistErrors = 0;

  for (const event of events) {
    const sourceRows: Array<Omit<EventSourceInsert, "event_id">> = [];
    for (const [index, sourceItem] of event.sourceItems.entries()) {
      if (!comparableItems.has(sourceItem.candidateId) || !rawItemIds.get(sourceItem.candidateId)) {
        persistErrors += 1;
        console.error(`persist event blocked: missing exact raw_item for ${sourceItem.candidateId}`);
        continue;
      }
      sourceRows.push({ raw_item_id: rawItemIds.get(sourceItem.candidateId)!, source_id: sourceItem.sourceId, is_primary: index === 0 });
    }
    if (sourceRows.length !== event.sourceItems.length) {
      persistSkipped += 1;
      continue;
    }
    const regionId = event.probableRegionCode ? regionIds.get(event.probableRegionCode) ?? null : null;
    const payload: EventInsert = {
      event_key: event.eventKey,
      canonical_title: event.canonicalTitle,
      event_status: "candidate",
      confidence_score: event.clusterConfidence / 100,
      primary_region_id: regionId,
      primary_country_code: event.probableCountryCode,
      occurred_at: event.probableOccurredAt,
      occurred_at_precision: event.probableOccurredAt ? "day" : "unknown",
      review_status: "pending",
      review_notes: eventSourceCount(event) > 1 ? null : "Single-source event; retained conservatively.",
      classification_payload: { sourceCount: event.sourceItems.length } as Json,
    };
    const eventResult = await supabase.from("events").upsert(payload, { onConflict: "event_key" }).select("id,event_key").single();
    if (eventResult.error || !eventResult.data) {
      persistErrors += 1;
      console.error(`persist event error ${event.eventKey}: ${eventResult.error?.message ?? "no event returned"}`);
      continue;
    }
    persistedEvents += 1;

    if (sourceRows.length > 0) {
      const relationResult = await supabase.from("event_sources").upsert(sourceRows.map((row) => ({ ...row, event_id: eventResult.data.id })), { onConflict: "event_id,raw_item_id" });
      if (relationResult.error) {
        persistErrors += 1;
        console.error(`persist event_sources error ${event.eventKey}: ${relationResult.error.message}`);
      } else {
        persistedEventSources += sourceRows.length;
      }
    } else {
      persistSkipped += 1;
    }
  }
  return { persistedEvents, persistedEventSources, persistSkipped, persistErrors };
}

export async function runClustering(options: ClusterRunOptions): Promise<ClusterRunResult> {
  const extraction = await runExtraction({
    hours: options.hours,
    limit: options.limit,
    persist: options.persist,
    now: options.now,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    supabase: options.supabase,
  });
  const extractedItems = extraction.results.flatMap((result) => result.item ? [result.item] : []);
  const clustered = clusterExtractedItems(extractedItems, options.config ?? clusteringConfig);
  let persistedEvents = 0;
  let persistedEventSources = 0;
  let persistSkipped = 0;
  let persistErrors = 0;
  if (options.persist) {
    const supabase = options.supabase ?? undefined;
    const client = supabase ?? (await import("../../supabase/server-client.ts")).createSupabaseServerClient();
    const itemMap = new Map(extractedItems.map((item) => [item.candidateId, item]));
    const rawItemIds = new Map(extraction.results.map((result) => [result.candidate.externalId, result.rawItemId]));
    ({ persistedEvents, persistedEventSources, persistSkipped, persistErrors } = await persistClusterEvents(client, clustered.events, itemMap, rawItemIds));
  }
  return {
    extractedItems: extractedItems.length,
    duplicatesRemoved: clustered.duplicatesRemoved,
    events: clustered.events,
    multiSourceEvents: clustered.events.filter((event) => eventSourceCount(event) > 1).length,
    singleSourceEvents: clustered.events.filter((event) => eventSourceCount(event) === 1).length,
    largestCluster: Math.max(0, ...clustered.events.map(eventSourceCount)),
    needsReview: clustered.needsReview,
    possibleFalseMerges: clustered.possibleFalseMerges,
    report: clustered.report,
    persistedEvents,
    persistedEventSources,
    persistSkipped,
    persistErrors,
  };
}
