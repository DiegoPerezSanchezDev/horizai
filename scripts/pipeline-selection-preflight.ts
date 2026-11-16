import { randomUUID } from "node:crypto";
import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { createPipelineConfig } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import type { PipelineRunContext } from "../lib/agents/pipeline/pipeline-types.ts";
import { applyExtractionFreshness, freshExtractionResults } from "../lib/agents/extraction/freshness-policy.ts";

function eventOrder(left: { sourceItems: Array<{ publishedAt: string | null }>; eventKey: string }, right: { sourceItems: Array<{ publishedAt: string | null }>; eventKey: string }): number {
  const first = (event: typeof left) => event.sourceItems.map((item) => item.publishedAt ? Date.parse(item.publishedAt) : Number.MAX_SAFE_INTEGER).sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER;
  return first(left) - first(right) || left.eventKey.localeCompare(right.eventKey);
}

const config = createPipelineConfig({ dryRun: true, publish: false, hours: 48, limit: 1, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1 });
const pipeline = createProductionPipeline({ config, persistTraceability: true });
const run: PipelineRunContext = { schemaVersion: 1, runId: randomUUID(), dryRun: true, startedAt: new Date().toISOString(), trigger: "manual", agentVersions: {} };

const discovery = await pipeline.stages.discovery({ run, config });
const extraction = applyExtractionFreshness(await pipeline.stages.extraction({ run, config, discovery }), new Date(run.startedAt), config.hours);
const freshExtraction = { ...extraction, results: freshExtractionResults(extraction) };
const clustering = await pipeline.stages.clustering({ run, config, extraction: freshExtraction });
const extracted = freshExtraction.results.flatMap((item) => item.item ? [item.item] : []);
const rawIds = new Map(extraction.results.map((item) => [item.candidate.externalId, item.rawItemId]));
const ordered = clustering.events.map((event) => ({ event, items: extracted.filter((item) => new Set(event.sourceItems.map((source) => source.candidateId)).has(item.candidateId)), sources: pipeline.stages.sourceMetadata(event, extracted.filter((item) => new Set(event.sourceItems.map((source) => source.candidateId)).has(item.candidateId)), rawIds) })).filter((item) => item.items.length > 0).sort((left, right) => eventOrder(left.event, right.event));
const registry = new SupabasePipelineEventAttemptRepository(createSupabaseServerClient());
const eligibility = await registry.getEligibility(ordered.map((item) => item.event.eventKey), new Date());
const selected = ordered.filter((item) => eligibility.get(item.event.eventKey)?.eligible === true).slice(0, config.limit);
const item = selected[0];
console.log(JSON.stringify({ status: "SUCCESS", runId: run.runId, hours: 48, limit: 1, candidatesDiscovered: discovery.candidatesDiscovered, rawItemsCreated: discovery.persisted, rawItemsReused: discovery.persistSkipped, extractionValidBeforeFreshness: extraction.freshness?.evaluated ?? 0, extractionSuccess: extracted.length, extractionFailures: extraction.failed, freshItems: extraction.freshness?.fresh ?? 0, staleItemsExcluded: extraction.freshness?.stale ?? 0, clusteredEvents: clustering.events.length, eligibleEvents: ordered.filter((entry) => eligibility.get(entry.event.eventKey)?.eligible).length, selectedEventKey: item?.event.eventKey ?? null, selectedTitle: item?.event.canonicalTitle ?? null, selectedSourceId: item?.sources[0]?.sourceId ?? null, selectedRawItemId: item?.sources[0]?.rawItemId ?? null, rawItemOwnership: item?.sources.every((source) => Boolean(source.rawItemId)) ?? false, providerCalls: 0, groqCalls: 0 }, null, 2));
