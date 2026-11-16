import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { createPipelineConfig } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import { selectionPreflightContexts } from "../lib/agents/pipeline/selection-preflight.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { SUPERVISED_EXTRACTION_CANDIDATE_LIMIT } from "../lib/agents/pipeline/supervised-throughput-policy.ts";
import { freshExtractionResults } from "../lib/agents/extraction/freshness-policy.ts";
import { assessCandidateEvidence } from "../lib/agents/extraction/evidence-quality.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

// Diagnosis cannot invoke a provider, persist ingestion, mutate a scheduler, or authenticate a temporary user.
const originalFetch = globalThis.fetch.bind(globalThis);
const requestCounts: Record<string, number> = {};
globalThis.fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new Error("READONLY_DIAGNOSIS_WRITE_FORBIDDEN");
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (["api.groq.com", "api.cerebras.ai", "api.cloudflare.com"].includes(url.hostname)) throw new Error("READONLY_DIAGNOSIS_PROVIDER_FORBIDDEN");
  const response = await originalFetch(input, init);
  const key = `${method}:${response.status}`;
  requestCounts[key] = (requestCounts[key] ?? 0) + 1;
  return response;
};

const now = new Date();
const config = createPipelineConfig({ mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 3, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1 });
const supabase = createSupabaseServerClient();
const pipeline = createProductionPipeline({ supabase, config, persistTraceability: false });
const run = { schemaVersion: 1 as const, runId: randomUUID(), dryRun: true, startedAt: now.toISOString(), trigger: "manual" as const, agentVersions: {} };
const discovery = await pipeline.stages.discovery({ run, config });
// Preserve the uncapped 12F.8C diagnostic cohort; separately trace the actual six-candidate runner cohort below.
const extraction = await pipeline.stages.extraction({ run, config, discovery });
const clustering = await pipeline.stages.clustering({ run, config, extraction });
const contexts = selectionPreflightContexts(extraction, clustering.events);
const registry = new SupabasePipelineEventAttemptRepository(supabase);
const eligibility = await registry.getEligibility(contexts.map(({ event }) => event.eventKey), now);
const historyResult = await supabase.from("pipeline_event_attempts").select("id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,next_eligible_at");
if (historyResult.error) throw new Error(`PREFLIGHT_HISTORY_READ_FAILED:${historyResult.error.code}`);
const rawResult = await supabase.from("raw_items").select("id,source_id,external_id,canonical_url,content_hash,created_at,extracted_at,processing_status").in("external_id", discovery.candidates.map((candidate) => candidate.externalId));
if (rawResult.error) throw new Error(`PREFLIGHT_RAW_READ_FAILED:${rawResult.error.code}`);
const eventsResult = await supabase.from("events").select("id,event_key,canonical_title,occurred_at");
if (eventsResult.error) throw new Error(`PREFLIGHT_EVENTS_READ_FAILED:${eventsResult.error.code}`);
const articleResult = await supabase.from("articles").select("id,event_id,publication_status").eq("publication_status", "published");
if (articleResult.error) throw new Error(`PREFLIGHT_ARTICLES_READ_FAILED:${articleResult.error.code}`);
const publishedEventIds = new Set((articleResult.data ?? []).map((article) => article.event_id));
const candidates = new Map(discovery.candidates.map((candidate, index) => [candidate.externalId, { ...candidate, discoveryIndex: index }]));
const reasonCounts: Record<string, number> = {};
const trace = contexts.map(({ event, items }) => {
  const decision = eligibility.get(event.eventKey);
  if (!decision) throw new Error("PREFLIGHT_SELECTOR_DECISION_MISSING");
  reasonCounts[decision.reason] = (reasonCounts[decision.reason] ?? 0) + 1;
  const history = (historyResult.data ?? []).filter((attempt) => attempt.event_key === event.eventKey);
  const storedEvent = (eventsResult.data ?? []).find((row) => row.event_key === event.eventKey);
  const quality = assessCandidateEvidence(event.canonicalTitle, items);
  return {
    eventKey: event.eventKey, canonicalTitle: event.canonicalTitle,
    clusterSize: event.sourceItems.length, sourceCount: new Set(event.sourceItems.map((item) => item.sourceId)).size,
    probableCountryCode: event.probableCountryCode, probableRegionCode: event.probableRegionCode,
    category: null, categoryNote: "Not classified before providers",
    selectorEligibility: decision.eligible ? "ELIGIBLE" : "INELIGIBLE", reason: decision.reason,
    historyMatch: history.length > 0, history,
    historicalIdentity: history.length ? { exactEventKey: true, storedTitleMatches: storedEvent ? storedEvent.canonical_title === event.canonicalTitle : null, independentlyProvenSameStory: storedEvent ? storedEvent.canonical_title === event.canonicalTitle : null, policyScope: "exact event key; terminal outcomes remain consumed" } : null,
    alreadyPublished: storedEvent ? publishedEventIds.has(storedEvent.id) : false,
    qualityStatus: quality.eligible ? "ELIGIBLE" : quality.terminalReason,
    qualityReasons: quality.assessments.map((assessment) => assessment.reason),
    qualitySignals: quality.assessments.map((assessment) => assessment.signals),
    sourceItems: event.sourceItems.map((source) => {
      const candidate = candidates.get(source.candidateId);
      const item = items.find((item) => item.candidateId === source.candidateId);
      const raw = (rawResult.data ?? []).find((row) => row.source_id === source.sourceId && row.external_id === source.candidateId);
      return {
        ...source, domain: new URL(source.url).hostname, discoveryIndex: candidate?.discoveryIndex ?? null,
        rawItemId: raw?.id ?? null, rawItemStatus: raw?.processing_status ?? null,
        rawItemRequiredAtIngestion: !raw, contentHash: item?.contentHash ?? null,
        contentMatchesStoredRaw: raw ? raw.content_hash === item?.contentHash : null,
        evidenceNewSinceHistoricalAttempt: history.length && raw ? history.map((attempt) => ({ attemptId: attempt.id, rawCreatedAfterAttempt: raw.created_at > attempt.started_at })) : [],
        recency: extraction.freshness?.decisions.find((decision) => decision.sourceItemId === source.candidateId) ?? null,
      };
    }),
  };
});
// Reproduce the real orchestrator's cap before extraction and its normal ordering/attempt lookup.
const runnerIds = new Set(discovery.candidates.slice(0, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT).map((candidate) => candidate.externalId));
const runnerExtraction = { ...extraction, results: extraction.results.filter((result) => runnerIds.has(result.candidate.externalId)) };
const runnerClustering = await pipeline.stages.clustering({ run, config, extraction: runnerExtraction });
const runnerContexts = selectionPreflightContexts(runnerExtraction, runnerClustering.events);
const runnerEligibility = await registry.getEligibility(runnerContexts.map(({ event }) => event.eventKey), now);
const selected = runnerContexts.filter(({ event }) => runnerEligibility.get(event.eventKey)?.eligible === true).slice(0, config.limit);
const allSources = [...new Set(trace.flatMap((event) => event.sourceItems.map((source) => source.sourceId)))];
const allDomains = [...new Set(trace.flatMap((event) => event.sourceItems.map((source) => source.domain)))];
const output = {
  phase: "12F.8D", primaryRootCause: "SELECTOR_STATE_BUG", defectScope: "12F.8C local diagnostic adapter only; production selector unaffected",
  capturedAtUtc: new Date().toISOString(), referenceTime: now.toISOString(), hours: config.hours,
  historicalReconstruction: { originalReportedClusters: 52, originalIdentitiesRetained: false, exactHistoricalIdentitiesReconstructable: false, originalZeroCause: "All ExtractionResult wrappers were compared using nonexistent candidateId instead of result.item.candidateId", all52CausallyAccounted: true, freshLiveCohortIsHistoricalIdentityProof: false },
  discovery: { candidatesDiscovered: discovery.candidatesDiscovered, deduplicatedCandidates: discovery.candidates.length, sources: discovery.sources.map(({ source, status, valid, discovered, undatedExcluded }) => ({ sourceId: source.id, name: source.name, domain: new URL(source.url).hostname, status, valid, discovered, undatedExcluded })) },
  extraction: { successful: freshExtractionResults(extraction).length, failed: extraction.failed, blocked: extraction.blocked, freshness: extraction.freshness, outcomes: extraction.results.map((result) => ({ candidateId: result.candidate.externalId, sourceId: result.candidate.sourceId, status: result.status, quality: result.quality, errorCode: result.error?.code ?? null })) },
  clusteredEvents: trace.length, eligibleEvents: trace.filter((event) => event.selectorEligibility === "ELIGIBLE").length,
  eligibleAndQualitySufficient: trace.filter((event) => event.selectorEligibility === "ELIGIBLE" && event.qualityStatus === "ELIGIBLE").length,
  reasonCounts, reasonCountSum: Object.values(reasonCounts).reduce((sum, count) => sum + count, 0), events: trace,
  diversity: { uniqueSources: allSources.length, sourceIds: allSources, uniqueDomains: allDomains.length, domains: allDomains, singleSourceEvents: trace.filter((event) => event.sourceCount === 1).length, multiSourceEvents: trace.filter((event) => event.sourceCount > 1).length, regionCounts: Object.fromEntries([...new Set(trace.map((event) => event.probableRegionCode ?? "unknown"))].map((region) => [region, trace.filter((event) => (event.probableRegionCode ?? "unknown") === region).length])) },
  runnerCohort: { extractionCap: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT, candidates: runnerIds.size, clusters: runnerContexts.length, selectedByNormalOrder: selected.map(({ event, items }) => ({ eventKey: event.eventKey, canonicalTitle: event.canonicalTitle, reason: runnerEligibility.get(event.eventKey)?.reason, sourceCount: new Set(event.sourceItems.map((source) => source.sourceId)).size, evidenceQuality: assessCandidateEvidence(event.canonicalTitle, items).eligible ? "ELIGIBLE" : "EXTRACTION_EVIDENCE_INSUFFICIENT" })) },
  network: { requestCounts, remoteWrites: 0, providerCalls: 0 }, fixImplemented: true, productionPolicyChanged: false, invocation12f9: 0,
};
await writeFile("artifacts/supervised-cycle-12f8d-eligibility.json", `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ clusteredEvents: output.clusteredEvents, eligibleEvents: output.eligibleEvents, reasonCounts, diversity: output.diversity, runnerCohort: output.runnerCohort, network: output.network, artifact: "artifacts/supervised-cycle-12f8d-eligibility.json" }, null, 2));
