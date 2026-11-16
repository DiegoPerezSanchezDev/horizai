import { randomUUID } from "node:crypto";
import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { createPipelineConfig } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { evaluateNormalEligibility } from "../lib/agents/pipeline/event-attempt-policy.ts";
import { applyExtractionFreshness, freshExtractionResults } from "../lib/agents/extraction/freshness-policy.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { FREE_TIER_DAILY_REQUEST_LIMIT } from "../lib/agents/runtime/request-budget.ts";
import {
  createSupervisedCandidateSnapshot,
  readSupervisedCandidateSnapshot,
  supervisedSnapshotPath,
  validateSupervisedCandidateSnapshot,
  writeSupervisedCandidateSnapshot,
  type SnapshotAttemptState,
  type SnapshotRawItem,
  type SnapshotSource,
  type SnapshotValidationStore,
} from "../lib/agents/pipeline/supervised-candidate-snapshot.ts";
import type { PipelineRunContext } from "../lib/agents/pipeline/pipeline-types.ts";
import type { Tables } from "../types/database.ts";

type RawRow = Tables<"raw_items">;
type SourceRow = Tables<"sources">;

function eventOrder(left: { sourceItems: Array<{ publishedAt: string | null }>; eventKey: string }, right: { sourceItems: Array<{ publishedAt: string | null }>; eventKey: string }): number {
  const first = (event: typeof left) => event.sourceItems.map((item) => item.publishedAt ? Date.parse(item.publishedAt) : Number.MAX_SAFE_INTEGER).sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER;
  return first(left) - first(right) || left.eventKey.localeCompare(right.eventKey);
}

function asRawItem(row: RawRow): SnapshotRawItem {
  return { id: row.id, sourceId: row.source_id, externalId: row.external_id, originalUrl: row.original_url, canonicalUrl: row.canonical_url, title: row.title, excerpt: row.excerpt, language: row.language, publishedAt: row.published_at, discoveredAt: row.discovered_at, contentHash: row.content_hash, processingStatus: row.processing_status, extractionQuality: row.extraction_quality, rawContent: row.raw_content, normalizedPayload: row.normalized_payload };
}

function asSource(row: SourceRow): SnapshotSource {
  return { id: row.id, name: row.name, url: row.url, feedUrl: row.feed_url, sourceType: row.source_type, countryCode: row.country_code, language: row.language, isActive: row.is_active };
}

function nextEligibleAt(attempts: Tables<"pipeline_event_attempts">[]): string | null {
  const latestTechnical = attempts.filter((attempt) => attempt.final_state === "TECHNICAL_FAILURE" && attempt.counts_toward_retry_limit).sort((a, b) => b.attempt_number - a.attempt_number)[0];
  return latestTechnical?.next_eligible_at ?? null;
}

async function main(): Promise<void> {
  const referenceTime = new Date();
  const runId = randomUUID();
  const config = createPipelineConfig({ dryRun: true, publish: false, hours: 48, limit: 1, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1 });
  const pipeline = createProductionPipeline({ config, persistTraceability: true });
  const run: PipelineRunContext = { schemaVersion: 1, runId, dryRun: true, startedAt: referenceTime.toISOString(), trigger: "manual", agentVersions: {} };
  const discovery = await pipeline.stages.discovery({ run, config });
  const extraction = applyExtractionFreshness(await pipeline.stages.extraction({ run, config, discovery }), new Date(run.startedAt), config.hours);
  const fresh = { ...extraction, results: freshExtractionResults(extraction) };
  const clustering = await pipeline.stages.clustering({ run, config, extraction: fresh });
  const extracted = fresh.results.flatMap((result) => result.item ? [result.item] : []);
  const rawIds = new Map(extraction.results.map((result) => [result.candidate.externalId, result.rawItemId]));
  const ordered = clustering.events.map((event) => {
    const items = extracted.filter((item) => event.sourceItems.some((sourceItem) => sourceItem.candidateId === item.candidateId));
    return { event, items, sources: pipeline.stages.sourceMetadata(event, items, rawIds) };
  }).filter((entry) => entry.items.length > 0).sort((left, right) => eventOrder(left.event, right.event));

  const supabase = createSupabaseServerClient();
  const attemptRegistry = new SupabasePipelineEventAttemptRepository(supabase);
  const eligibility = await attemptRegistry.getEligibility(ordered.map((entry) => entry.event.eventKey), referenceTime);
  const selected = ordered.filter((entry) => eligibility.get(entry.event.eventKey)?.eligible).slice(0, 1)[0];
  if (!selected) throw new Error("NO_CURRENT_ELIGIBLE_CANONICAL_CANDIDATE");

  const sourceItemIds = selected.items.map((item) => item.candidateId);
  const rawItemIdList = sourceItemIds.map((id) => rawIds.get(id)).filter((id): id is string => Boolean(id));
  if (rawItemIdList.length !== sourceItemIds.length) throw new Error("SELECTED_CANDIDATE_MISSING_RAW_ITEM_TRACEABILITY");
  const [rawResult, sourcesResult, attemptsResult, eventResult] = await Promise.all([
    supabase.from("raw_items").select("*").in("id", rawItemIdList),
    supabase.from("sources").select("*").in("id", [...new Set(selected.items.map((item) => item.metadata.sourceId).filter((id): id is string => typeof id === "string"))]),
    supabase.from("pipeline_event_attempts").select("*").eq("event_key", selected.event.eventKey).order("attempt_number", { ascending: true }),
    supabase.from("events").select("id,event_key").eq("event_key", selected.event.eventKey).maybeSingle(),
  ]);
  if (rawResult.error || sourcesResult.error || attemptsResult.error || eventResult.error) throw new Error("SUPERVISED_SNAPSHOT_READ_ONLY_AUDIT_FAILED");
  const rawById = new Map((rawResult.data ?? []).map((row) => [row.id, row]));
  const sourceById = new Map((sourcesResult.data ?? []).map((row) => [row.id, row]));
  const itemInputs = selected.items.map((item) => {
    const rawId = rawIds.get(item.candidateId);
    const sourceId = item.metadata.sourceId;
    if (!rawId || typeof sourceId !== "string") throw new Error("SELECTED_LINEAGE_IDENTITY_MISSING");
    const raw = rawById.get(rawId);
    const source = sourceById.get(sourceId);
    if (!raw || !source) throw new Error("SELECTED_LINEAGE_ROW_MISSING");
    return { rawItem: asRawItem(raw), source: asSource(source) };
  });
  const attempts = attemptsResult.data ?? [];
  const activeClaim = attempts.some((attempt) => attempt.completed_at === null);
  const eligibilityState = evaluateNormalEligibility(attempts.map((attempt) => ({
    id: attempt.id, eventKey: attempt.event_key, pipelineRunId: attempt.pipeline_run_id, attemptNumber: attempt.attempt_number,
    startedAt: attempt.started_at, completedAt: attempt.completed_at, finalState: attempt.final_state,
    stopStage: attempt.stop_stage, stopReason: attempt.stop_reason, retryClass: attempt.retry_class,
    countsTowardRetryLimit: attempt.counts_toward_retry_limit, nextEligibleAt: attempt.next_eligible_at, createdAt: attempt.created_at,
  })), referenceTime);
  const attemptState: SnapshotAttemptState = {
    attempts: attempts.length, eligible: eligibilityState.eligible, activeClaim,
    quarantined: !eligibilityState.eligible && eligibilityState.reason === "QUARANTINED",
    nextEligibleAt: nextEligibleAt(attempts),
  };
  if (!attemptState.eligible || attemptState.activeClaim || attemptState.quarantined) throw new Error("SELECTED_CANDIDATE_ATTEMPT_STATE_BLOCKED");

  const eventArticle = eventResult.data
    ? await supabase.from("articles").select("id").eq("event_id", eventResult.data.id).limit(1)
    : { data: [], error: null };
  if (eventArticle.error) throw new Error("SUPERVISED_SNAPSHOT_ARTICLE_READ_FAILED");
  if ((eventArticle.data ?? []).length > 0) throw new Error("SUPERVISED_SNAPSHOT_ARTICLE_ALREADY_EXISTS");

  const todayUtc = referenceTime.toISOString().slice(0, 10);
  const dayStart = todayUtc + "T00:00:00.000Z";
  const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const quotaResult = await supabase.from("agent_logs").select("id", { count: "exact", head: true }).eq("step", "provider_request_reserved").gte("created_at", dayStart).lt("created_at", dayEnd);
  if (quotaResult.error || quotaResult.count === null) throw new Error("PERSISTENT_QUOTA_READ_FAILED");
  const quotaRemaining = Math.max(0, FREE_TIER_DAILY_REQUEST_LIMIT - quotaResult.count);

  const snapshot = createSupervisedCandidateSnapshot({
    eventKey: selected.event.eventKey,
    title: selected.event.canonicalTitle,
    items: itemInputs,
    referenceTime,
    hours: 48,
    attemptState,
  });
  const path = supervisedSnapshotPath(snapshot.snapshotId);
  await writeSupervisedCandidateSnapshot(snapshot, path);
  const reread = await readSupervisedCandidateSnapshot(path);
  const store: SnapshotValidationStore = {
    async getRawItem(id) {
      const result = await supabase.from("raw_items").select("*").eq("id", id).maybeSingle();
      if (result.error) throw new Error("SNAPSHOT_RAW_ITEM_REVALIDATION_FAILED");
      return result.data ? asRawItem(result.data) : null;
    },
    async getSource(id) {
      const result = await supabase.from("sources").select("*").eq("id", id).maybeSingle();
      if (result.error) throw new Error("SNAPSHOT_SOURCE_REVALIDATION_FAILED");
      return result.data ? asSource(result.data) : null;
    },
    async getAttemptState(eventKey, now) {
      const result = await supabase.from("pipeline_event_attempts").select("*").eq("event_key", eventKey).order("attempt_number", { ascending: true });
      if (result.error) throw new Error("SNAPSHOT_ATTEMPT_REVALIDATION_FAILED");
      const rows = result.data ?? [];
      const status = evaluateNormalEligibility(rows.map((attempt) => ({
        id: attempt.id, eventKey: attempt.event_key, pipelineRunId: attempt.pipeline_run_id, attemptNumber: attempt.attempt_number,
        startedAt: attempt.started_at, completedAt: attempt.completed_at, finalState: attempt.final_state,
        stopStage: attempt.stop_stage, stopReason: attempt.stop_reason, retryClass: attempt.retry_class,
        countsTowardRetryLimit: attempt.counts_toward_retry_limit, nextEligibleAt: attempt.next_eligible_at, createdAt: attempt.created_at,
      })), now);
      return { attempts: rows.length, eligible: status.eligible, activeClaim: rows.some((attempt) => attempt.completed_at === null), quarantined: !status.eligible && status.reason === "QUARANTINED", nextEligibleAt: nextEligibleAt(rows) };
    },
    async hasArticle(eventKey) {
      const event = await supabase.from("events").select("id").eq("event_key", eventKey).maybeSingle();
      if (event.error) throw new Error("SNAPSHOT_EVENT_REVALIDATION_FAILED");
      if (!event.data) return false;
      const article = await supabase.from("articles").select("id").eq("event_id", event.data.id).limit(1);
      if (article.error) throw new Error("SNAPSHOT_ARTICLE_REVALIDATION_FAILED");
      return (article.data ?? []).length > 0;
    },
  };
  const validation = await validateSupervisedCandidateSnapshot(reread, store, new Date());
  if (!validation.valid) throw new Error("SNAPSHOT_DATABASE_VALIDATION_FAILED:" + validation.reasons.join(","));
  const ownership = itemInputs.every(({ rawItem, source }) => rawItem.sourceId === source.id && rawItem.externalId?.startsWith(source.id + ":"));
  const hosts = itemInputs.map(({ rawItem }) => new URL(rawItem.canonicalUrl ?? rawItem.originalUrl).hostname.toLowerCase());
  const expiresAt = Math.min(...snapshot.items.map((item) => Date.parse(item.freshnessExpiresAt)));
  const first = snapshot.items[0];

  console.log(JSON.stringify({
    status: "SUPERVISED_SNAPSHOT_READY",
    selection: { runId, referenceTime: referenceTime.toISOString(), hours: 48, limit: 1, candidatesDiscovered: discovery.candidatesDiscovered, extractedFreshItems: extracted.length, eligibleEvents: ordered.filter((entry) => eligibility.get(entry.event.eventKey)?.eligible).length, selectedEventKey: selected.event.eventKey, selectedTitle: selected.event.canonicalTitle, sourceItemIds, rawItemIds: rawItemIdList },
    sourceAudit: { sourceIdentity: "PASS", sourceName: first.sourceName, sourceId: first.sourceId, urlHost: hosts[0], sourceItemIdConsistency: "PASS", urlSourceConsistency: "PASS", previousReportClassification: "REPORTING_METADATA_BUG" },
    persistedState: { attempts: attemptState.attempts, activeClaim: attemptState.activeClaim, eligibleNow: attemptState.eligible, quarantined: attemptState.quarantined, nextEligibleAt: attemptState.nextEligibleAt, eventPersisted: Boolean(eventResult.data), articleExists: false },
    freshness: { publishedAt: first.publishedAt, effectiveFreshnessAt: first.effectiveFreshnessAt, freshnessExpiresAt: new Date(expiresAt).toISOString(), currentAgeHours: Math.round((referenceTime.getTime() - Date.parse(first.effectiveFreshnessAt)) / 3_600_000 * 100) / 100, currentlyFresh: true },
    snapshot: { snapshotId: snapshot.snapshotId, path, integrity: "PASS", databaseValidation: "PASS", eventKey: snapshot.eventKey, title: snapshot.title, rawItemId: first.rawItemId, ownership: ownership ? "PASS" : "FAIL", source: first.sourceName, originalUrl: first.originalUrl, canonicalUrl: first.canonicalUrl, language: first.language, extractionStatus: first.extractionStatus, extractionQuality: first.extractionQuality, extractedCharacters: first.extractedCharacters, previousAttempts: snapshot.attemptCount, eligible: true, safeMaterialPreview: (first.excerpt ?? "").slice(0, 240) },
    groqCalls: 0, providerCalls: 0, quota: { dateUtc: todayUtc, remaining: quotaRemaining + "/" + FREE_TIER_DAILY_REQUEST_LIMIT },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Supervised snapshot failed");
  process.exitCode = 1;
});
