import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { clusterExtractedItems } from "../lib/agents/clustering/cluster-runner.ts";
import type { ClusterRunResult } from "../lib/agents/clustering/cluster-types.ts";
import { applyExtractionFreshness } from "../lib/agents/extraction/freshness-policy.ts";
import type { ExtractionRunResult } from "../lib/agents/extraction/extraction-types.ts";
import type { DiscoveryRunResult } from "../lib/agents/discovery/discovery-types.ts";
import { createSupervisedSnapshotStages, resolveApprovedSupervisedSnapshotPath } from "../lib/agents/pipeline/supervised-snapshot-execution.ts";
import { createProductionPipeline, type ProductionPipelineOptions } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { createPipelineConfig } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import type { PipelineEventAttemptRegistry } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { attemptOutcomeFromPipelineResult, evaluateNormalEligibility } from "../lib/agents/pipeline/event-attempt-policy.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import {
  readSupervisedCandidateSnapshot,
  validateSupervisedCandidateSnapshot,
  type SnapshotAttemptState,
  type SnapshotRawItem,
  type SnapshotSource,
  type SnapshotValidationStore,
} from "../lib/agents/pipeline/supervised-candidate-snapshot.ts";
import { extractedItemSchema, publicationPayloadSchema, type ExtractedItem, type PublicationPayload } from "../lib/agents/contracts/index.ts";
import type { PipelineEventContext } from "../lib/agents/pipeline/pipeline-types.ts";
import type { PublisherInput } from "../lib/agents/publisher/publisher-types.ts";
import { validateRealPublicationReadiness } from "../lib/agents/publisher/publication-readiness.ts";
import { buildPublicationScores } from "../lib/agents/publisher/publication-payload.ts";
import { SupabasePublisherRepository } from "../lib/agents/publisher/supabase-publisher-repository.ts";
import type { Tables } from "../types/database.ts";

const approvedSnapshotId = "b6f66b19-1281-406c-9bdd-0fdb18b46d08";
const approvedEventKey = "event-5c80fcd1a4e5b0d010308f37d646625a";
type RawRow = Tables<"raw_items">;
type SourceRow = Tables<"sources">;

function rawItem(row: RawRow): SnapshotRawItem {
  return { id: row.id, sourceId: row.source_id, externalId: row.external_id, originalUrl: row.original_url, canonicalUrl: row.canonical_url, title: row.title, excerpt: row.excerpt, language: row.language, publishedAt: row.published_at, discoveredAt: row.discovered_at, contentHash: row.content_hash, processingStatus: row.processing_status, extractionQuality: row.extraction_quality, rawContent: row.raw_content, normalizedPayload: row.normalized_payload };
}

function sourceRow(row: SourceRow): SnapshotSource {
  return { id: row.id, name: row.name, url: row.url, feedUrl: row.feed_url, sourceType: row.source_type, countryCode: row.country_code, language: row.language, isActive: row.is_active };
}

function attemptState(attempts: Tables<"pipeline_event_attempts">[], now: Date): SnapshotAttemptState {
  const mapped = attempts.map((attempt) => ({
    id: attempt.id, eventKey: attempt.event_key, pipelineRunId: attempt.pipeline_run_id, attemptNumber: attempt.attempt_number,
    startedAt: attempt.started_at, completedAt: attempt.completed_at, finalState: attempt.final_state,
    stopStage: attempt.stop_stage, stopReason: attempt.stop_reason, retryClass: attempt.retry_class,
    countsTowardRetryLimit: attempt.counts_toward_retry_limit, nextEligibleAt: attempt.next_eligible_at, createdAt: attempt.created_at,
  }));
  const eligibility = evaluateNormalEligibility(mapped, now);
  const latestTechnical = attempts.filter((attempt) => attempt.final_state === "TECHNICAL_FAILURE" && attempt.counts_toward_retry_limit).sort((a, b) => b.attempt_number - a.attempt_number)[0];
  return {
    attempts: attempts.length,
    eligible: eligibility.eligible,
    activeClaim: attempts.some((attempt) => attempt.completed_at === null),
    quarantined: !eligibility.eligible && eligibility.reason === "QUARANTINED",
    nextEligibleAt: latestTechnical?.next_eligible_at ?? null,
  };
}

function createSnapshotStore(supabase: ReturnType<typeof createSupabaseServerClient>): SnapshotValidationStore {
  return {
    async getRawItem(id) {
      const result = await supabase.from("raw_items").select("*").eq("id", id).maybeSingle();
      if (result.error) throw new Error("SNAPSHOT_RAW_ITEM_READ_FAILED");
      return result.data ? rawItem(result.data) : null;
    },
    async getSource(id) {
      const result = await supabase.from("sources").select("*").eq("id", id).maybeSingle();
      if (result.error) throw new Error("SNAPSHOT_SOURCE_READ_FAILED");
      return result.data ? sourceRow(result.data) : null;
    },
    async getAttemptState(eventKey, now) {
      const result = await supabase.from("pipeline_event_attempts").select("*").eq("event_key", eventKey).order("attempt_number", { ascending: true });
      if (result.error) throw new Error("SNAPSHOT_ATTEMPT_READ_FAILED");
      return attemptState(result.data ?? [], now);
    },
    async hasArticle(eventKey) {
      const event = await supabase.from("events").select("id").eq("event_key", eventKey).maybeSingle();
      if (event.error) throw new Error("SNAPSHOT_EVENT_READ_FAILED");
      if (!event.data) return false;
      const article = await supabase.from("articles").select("id").eq("event_id", event.data.id).limit(1);
      if (article.error) throw new Error("SNAPSHOT_ARTICLE_READ_FAILED");
      return (article.data ?? []).length > 0;
    },
  };
}

function buildPublisherInput(context: PipelineEventContext): PublisherInput {
  if (!context.verification || !context.translation || !context.editorial || !context.classification || !context.geo || !context.ranking || !context.critic) throw new Error("PUBLICATION_PREVIEW_REQUIRES_COMPLETE_LINEAGE");
  const publishedByCandidate = new Map(context.event.sourceItems.map((item) => [item.candidateId, item.publishedAt]));
  const payload: PublicationPayload = publicationPayloadSchema.parse({
    schemaVersion: 1,
    eventKey: context.event.eventKey,
    event: {
      canonicalTitle: context.event.canonicalTitle,
      probableOccurredAt: context.event.probableOccurredAt,
      probableCountryCode: context.classification.countryCodes[0] ?? context.event.probableCountryCode,
      probableRegionCode: context.classification.primaryRegionCode,
    },
    article: {
      slug: context.editorial.suggestedSlug,
      headlineEs: context.editorial.headlineEs,
      dekEs: context.editorial.dekEs,
      summaryEs: context.editorial.summaryEs,
      whyItMattersEs: context.editorial.whyItMattersEs,
      bodyEs: context.editorial.bodyEs,
      keyPoints: context.editorial.keyPoints,
    },
    sources: context.sources.map((source) => ({
      sourceId: source.sourceId,
      rawItemId: source.rawItemId ?? undefined,
      sourceName: source.sourceName,
      url: source.sourceUrl,
      isPrimary: source.sourceId === context.verification?.primarySourceId,
      publishedAt: publishedByCandidate.get(source.sourceItemId) ?? null,
    })),
    categories: context.classification.categorySlugs.map((categorySlug, index) => ({ categorySlug, isPrimary: index === 0, confidenceScore: 100 })),
    entities: [
      ...context.classification.companies.map((canonicalName) => ({ entityType: "organization" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...context.classification.models.map((canonicalName) => ({ entityType: "model" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...context.classification.people.map((canonicalName) => ({ entityType: "person" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...context.classification.technologies.map((canonicalName) => ({ entityType: "product" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
    ],
    region: { code: context.classification.primaryRegionCode, latitude: context.geo.latitude, longitude: context.geo.longitude },
    scores: buildPublicationScores(context.ranking),
    verification: context.verification,
    critic: context.critic,
  });
  const eventKey = context.event.eventKey;
  return {
    payload,
    lineage: { eventKey, verificationEventKey: eventKey, translationEventKey: eventKey, editorialEventKey: eventKey, classificationEventKey: eventKey, rankingEventKey: eventKey, criticEventKey: eventKey },
    validationContext: {
      translation: context.translation,
      editorSources: context.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: source.sourceUrl, sourceType: source.sourceType ?? "unknown" })),
    },
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message.replace(/(?:api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, "[redacted]").slice(0, 300) : "Supervised pipeline failed";
}

async function main(): Promise<void> {
  const snapshotPath = resolveApprovedSupervisedSnapshotPath(process.argv.slice(2), approvedSnapshotId);
  const snapshot = await readSupervisedCandidateSnapshot(snapshotPath);
  if (snapshot.snapshotId !== approvedSnapshotId || snapshot.eventKey !== approvedEventKey || snapshot.items.length !== 1) throw new Error("APPROVED_SNAPSHOT_IDENTITY_MISMATCH");

  const supabase = createSupabaseServerClient();
  const store = createSnapshotStore(supabase);
  const initialValidation = await validateSupervisedCandidateSnapshot(snapshot, store, new Date());
  if (!initialValidation.valid) throw new Error("SNAPSHOT_VALIDATION_FAILED:" + initialValidation.reasons.join(","));
  const itemSnapshot = snapshot.items[0];
  if (Date.now() >= Date.parse(itemSnapshot.freshnessExpiresAt)) throw new Error("SNAPSHOT_EXPIRED_BEFORE_PROVIDER");

  const rawResult = await supabase.from("raw_items").select("*").eq("id", itemSnapshot.rawItemId).single();
  const sourceResult = await supabase.from("sources").select("*").eq("id", itemSnapshot.sourceId).single();
  if (rawResult.error || sourceResult.error) throw new Error("SNAPSHOT_CONTENT_READ_FAILED");
  const raw = rawItem(rawResult.data);
  const source = sourceRow(sourceResult.data);
  if (!raw.rawContent) throw new Error("SNAPSHOT_CONTENT_MISSING");
  const normalized = typeof raw.normalizedPayload === "object" && raw.normalizedPayload !== null && !Array.isArray(raw.normalizedPayload) ? raw.normalizedPayload as Record<string, unknown> : {};
  const extracted: ExtractedItem = extractedItemSchema.parse({
    schemaVersion: 1,
    candidateId: itemSnapshot.sourceItemId,
    url: itemSnapshot.originalUrl,
    canonicalUrl: itemSnapshot.canonicalUrl,
    title: itemSnapshot.title,
    description: itemSnapshot.excerpt,
    author: typeof normalized.author === "string" ? normalized.author : null,
    publishedAt: itemSnapshot.publishedAt,
    language: itemSnapshot.language,
    content: raw.rawContent,
    contentHash: itemSnapshot.contentHash,
    metadata: { ...normalized, sourceId: source.id, sourceName: source.name, sourceCountryCode: source.countryCode },
    extractionQuality: itemSnapshot.extractionQuality,
  });
  const candidate = {
    schemaVersion: 1 as const,
    externalId: itemSnapshot.sourceItemId,
    sourceId: source.id,
    sourceName: source.name,
    url: itemSnapshot.originalUrl,
    titleOriginal: itemSnapshot.title,
    excerptOriginal: itemSnapshot.excerpt,
    language: itemSnapshot.language,
    publishedAt: itemSnapshot.publishedAt,
    discoveredAt: itemSnapshot.discoveredAt,
    possibleCountryCode: source.countryCode,
    possibleRegionCode: typeof normalized.sourceRegionCode === "string" ? normalized.sourceRegionCode : null,
  };
  const referenceNow = new Date();
  const extractionBase: ExtractionRunResult = {
    startedAt: referenceNow.toISOString(), finishedAt: referenceNow.toISOString(), hours: snapshot.hours, limit: 1,
    candidatesSelected: 1,
    results: [{ candidate, status: "success", quality: itemSnapshot.extractionQuality, item: extracted, contentLength: raw.rawContent.length, error: null, durationMs: 0, rawItemId: raw.id }],
    full: itemSnapshot.extractionQuality === "full" ? 1 : 0,
    partial: itemSnapshot.extractionQuality === "partial" ? 1 : 0,
    metadataOnly: itemSnapshot.extractionQuality === "metadata_only" ? 1 : 0,
    blocked: 0, failed: 0, averageContentLength: raw.rawContent.length, persisted: 0, persistSkipped: 0, persistErrors: 0,
    traceability: [{ sourceItemId: itemSnapshot.sourceItemId, rawItemId: itemSnapshot.rawItemId, sourceId: itemSnapshot.sourceId, action: "reused" }],
  };
  const extraction = applyExtractionFreshness(extractionBase, referenceNow, snapshot.hours);
  if (!extraction.freshness?.decisions[0]?.eligible) throw new Error("SNAPSHOT_EXPIRED_BEFORE_PROVIDER");
  const clusterResult = clusterExtractedItems([extracted]);
  const targetEvent = clusterResult.events.find((event) => event.eventKey === snapshot.eventKey);
  if (!targetEvent || targetEvent.canonicalTitle !== snapshot.title || targetEvent.sourceItems.length !== snapshot.items.length) throw new Error("SNAPSHOT_EVENTKEY_RECONSTRUCTION_MISMATCH");
  const clustering: ClusterRunResult = {
    extractedItems: 1, duplicatesRemoved: 0, events: [targetEvent], multiSourceEvents: 0, singleSourceEvents: 1, largestCluster: 1,
    needsReview: 0, possibleFalseMerges: [], report: clusterResult.report, persistedEvents: 0, persistedEventSources: 0, persistSkipped: 0, persistErrors: 0,
  };
  const discovery: DiscoveryRunResult = {
    startedAt: referenceNow.toISOString(), finishedAt: referenceNow.toISOString(), hours: snapshot.hours, sources: [], candidates: [candidate],
    candidatesDiscovered: 1, duplicateUrls: 0, duplicateContentHashes: 0, invalidCandidates: 0, undatedExcluded: 0,
    persisted: 0, persistSkipped: 0, persistErrors: 0,
    traceability: [{ sourceItemId: itemSnapshot.sourceItemId, rawItemId: itemSnapshot.rawItemId, sourceId: itemSnapshot.sourceId, action: "reused" }],
  };

  const executionState: {
    publisherInput: PublisherInput | null;
    acquired: { id: string; eventKey: string; pipelineRunId: string; startedAt: string } | null;
    finalized: boolean;
  } = { publisherInput: null, acquired: null, finalized: false };
  const pipelineRunId = randomUUID();
  const config = createPipelineConfig({ dryRun: true, publish: false, hours: snapshot.hours, limit: 1, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1 });
  const stages = createSupervisedSnapshotStages({ snapshot, discovery, extraction, clustering });
  const delegate = new SupabasePipelineEventAttemptRepository(supabase);
  const pipelineRef: { current: ReturnType<typeof createProductionPipeline> | null } = { current: null };
  const attemptRegistry: PipelineEventAttemptRegistry = {
    async getEligibility(eventKeys, now) {
      if (eventKeys.length !== 1 || eventKeys[0] !== snapshot.eventKey) throw new Error("SUPERVISED_EVENT_SCOPE_VIOLATION");
      const checkedAt = new Date();
      const validation = await validateSupervisedCandidateSnapshot(snapshot, store, checkedAt);
      if (!validation.valid) throw new Error("SNAPSHOT_INVALID_BEFORE_CLAIM:" + validation.reasons.join(","));
      if (checkedAt.getTime() >= Date.parse(itemSnapshot.freshnessExpiresAt)) throw new Error("SNAPSHOT_EXPIRED_BEFORE_PROVIDER");
      if (!pipelineRef.current || await pipelineRef.current.quota.remaining() < 6) throw new Error("BLOCKED_INSUFFICIENT_DAILY_BUDGET");
      return delegate.getEligibility(eventKeys, now);
    },
    async claim(input) {
      if (input.eventKey !== snapshot.eventKey || input.pipelineRunId !== pipelineRunId) throw new Error("SUPERVISED_CLAIM_IDENTITY_MISMATCH");
      const checkedAt = new Date();
      const validation = await validateSupervisedCandidateSnapshot(snapshot, store, checkedAt);
      if (!validation.valid) throw new Error("SNAPSHOT_INVALID_AT_CLAIM:" + validation.reasons.join(","));
      if (checkedAt.getTime() >= Date.parse(itemSnapshot.freshnessExpiresAt)) throw new Error("SNAPSHOT_EXPIRED_BEFORE_PROVIDER");
      if (!pipelineRef.current || await pipelineRef.current.quota.remaining() < 6) throw new Error("BLOCKED_INSUFFICIENT_DAILY_BUDGET");
      const result = await delegate.claim(input);
      if (result.status === "ACQUIRED") executionState.acquired = { id: result.attempt.id, eventKey: result.attempt.eventKey, pipelineRunId: result.attempt.pipelineRunId, startedAt: result.attempt.startedAt };
      return result;
    },
    async finalize(input) { await delegate.finalize(input); executionState.finalized = true; },
  };
  const pipelineOptions: ProductionPipelineOptions = {
    supabase,
    persistTraceability: false,
    runId: pipelineRunId,
    config,
    deterministic: stages,
    attemptRegistry,
    publicationPayloadFactory(context) { executionState.publisherInput = buildPublisherInput(context); return executionState.publisherInput.payload; },
  };
  const pipeline = createProductionPipeline(pipelineOptions);
  pipelineRef.current = pipeline;
  const preflight = await pipeline.preflight();
  if (preflight.provider.toLowerCase() !== "groq") throw new Error("PREFLIGHT_PROVIDER_NOT_GROQ");
  if (Object.values(preflight.maxRetries).some((retries) => retries !== 0)) throw new Error("PREFLIGHT_RETRIES_NOT_ZERO");
  if (preflight.allowPaidFallback || !preflight.failOnRateLimit) throw new Error("PREFLIGHT_COST_GUARD_INVALID");
  if (preflight.requiredRequests !== 6 || preflight.quotaRemaining < 6) throw new Error("BLOCKED_INSUFFICIENT_DAILY_BUDGET");

  const quotaBefore = preflight.quotaRemaining;
  let result: Awaited<ReturnType<typeof pipeline.orchestrator.run>> | null = null;
  let unexpectedFailure: unknown = null;
  try {
    result = await pipeline.orchestrator.run();
  } catch (error) {
    unexpectedFailure = error;
  } finally {
    if (executionState.acquired && !executionState.finalized) {
      const status = await supabase.from("pipeline_event_attempts").select("completed_at").eq("id", executionState.acquired.id).eq("pipeline_run_id", pipelineRunId).maybeSingle();
      if (status.error) throw new Error("SUPERVISED_ATTEMPT_FINALIZATION_STATUS_READ_FAILED");
      if (status.data?.completed_at) executionState.finalized = true;
    }
    if (executionState.acquired && !executionState.finalized) {
      const fallbackOutcome = attemptOutcomeFromPipelineResult({
        finalState: "FAILED", stopStage: "verifier", stopReason: "SUPERVISED_EXECUTOR_EXCEPTION",
        failure: { errorCode: "SUPERVISED_EXECUTOR_EXCEPTION" },
      }, new Date(executionState.acquired.startedAt));
      await delegate.finalize({ attemptId: executionState.acquired.id, pipelineRunId, completedAt: new Date().toISOString(), ...fallbackOutcome });
      executionState.finalized = true;
    }
  }

  const quotaAfter = await pipeline.quota.remaining();
  const attemptRows = await supabase.from("pipeline_event_attempts").select("*").eq("event_key", snapshot.eventKey).eq("pipeline_run_id", pipelineRunId).maybeSingle();
  if (attemptRows.error) throw new Error("SUPERVISED_FINAL_ATTEMPT_READ_FAILED");
  const finalAttempt = attemptRows.data;
  const eventResult = result?.eventResults.find((event) => event.eventKey === snapshot.eventKey) ?? null;
  const telemetry = eventResult?.telemetry ?? {};
  const requestDate = new Date().toISOString().slice(0, 10);
  const dayStart = requestDate + "T00:00:00.000Z";
  const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const dispatchedRows = await supabase.from("agent_logs").select("payload").eq("step", "provider_request_reserved").filter("payload->>eventKey", "eq", snapshot.eventKey).gte("created_at", dayStart).lt("created_at", dayEnd);
  if (dispatchedRows.error) throw new Error("PROVIDER_ACCOUNTING_READ_FAILED");
  const dispatchedCalls = (dispatchedRows.data ?? []).filter((row) => typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload) && row.payload.providerRequestDispatched === true).length;
  const requestsUsed = eventResult?.requestsUsed ?? 0;
  const runRequests = result?.providerRequestsUsed ?? 0;
  const quotaDelta = quotaBefore - quotaAfter;
  const accountingPass = unexpectedFailure === null && dispatchedCalls === requestsUsed && requestsUsed === runRequests && quotaDelta === runRequests;

  const duplicateState = await (async () => {
    const event = await supabase.from("events").select("id").eq("event_key", snapshot.eventKey).maybeSingle();
    if (event.error) throw new Error("DUPLICATE_EVENT_CHECK_FAILED");
    const article = event.data ? await supabase.from("articles").select("id").eq("event_id", event.data.id).limit(1) : { data: [], error: null };
    if (article.error) throw new Error("DUPLICATE_ARTICLE_CHECK_FAILED");
    const slug = executionState.publisherInput?.payload.article.slug;
    const bySlug = slug ? await supabase.from("articles").select("id").eq("slug", slug).limit(1) : { data: [], error: null };
    if (bySlug.error) throw new Error("DUPLICATE_SLUG_CHECK_FAILED");
    return { eventExists: Boolean(event.data), articleForEvent: (article.data ?? []).length > 0, articleForSlug: (bySlug.data ?? []).length > 0 };
  })();

  let readiness: Awaited<ReturnType<typeof validateRealPublicationReadiness>> | null = null;
  let anonVisible: boolean | null = null;
  if (eventResult?.criticDecision === "pass" && executionState.publisherInput) {
    readiness = await validateRealPublicationReadiness(executionState.publisherInput, new SupabasePublisherRepository(supabase));
    const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!publicUrl || !publishableKey) throw new Error("PUBLIC_SUPABASE_READ_CONFIG_MISSING");
    const publicClient = createClient(publicUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const visible = await publicClient.from("public_published_articles").select("slug").eq("slug", executionState.publisherInput.payload.article.slug).maybeSingle();
    if (visible.error) throw new Error("PUBLIC_VISIBILITY_READ_FAILED");
    anonVisible = Boolean(visible.data);
  }

  const stagesReport = Object.fromEntries(["verifier", "translator", "editor", "classifier", "ranker", "critic"].map((stage) => {
    const stageTelemetry = telemetry[stage as keyof typeof telemetry];
    const failedStage = eventResult?.failure?.stage === stage ? eventResult.failure : null;
    const failedTelemetry = failedStage?.telemetry;
    if (failedStage && failedTelemetry) return [stage, { status: "failed", agentVersion: failedTelemetry.agentVersion, model: failedTelemetry.model, attempts: failedTelemetry.attempts, retries: failedTelemetry.retries, requests: failedStage.providerRequestsUsed, latencyMs: failedTelemetry.latencyMs, errorCode: failedStage.errorCode }];
    return [stage, stageTelemetry ? { status: stageTelemetry.status, agentVersion: stageTelemetry.agentVersion, model: stageTelemetry.model, attempts: stageTelemetry.attempts, retries: stageTelemetry.retries, requests: stageTelemetry.providerRequestsUsed, latencyMs: stageTelemetry.latencyMs } : { status: "NOT_RUN" }];
  }));
  const report = {
    approvedSnapshotId: snapshot.snapshotId, snapshotValidation: "PASS", snapshotFreshnessBeforeProvider: "PASS", snapshotContentIdentity: "PASS",
    quotaPreflight: "PASS", atomicClaim: executionState.acquired ? "ACQUIRED" : eventResult?.stopReason ?? "NOT_RUN", pipelineRunId,
    pipelineExecuted: Boolean(result), eventKey: snapshot.eventKey, stages: stagesReport,
    pipelineFinalState: result?.finalState ?? "FAILED", eventFinalState: eventResult?.finalState ?? "FAILED", stopStage: eventResult?.stopStage ?? null, stopReason: eventResult?.stopReason ?? (unexpectedFailure ? failureMessage(unexpectedFailure) : null),
    attemptFinalized: Boolean(finalAttempt?.completed_at), attemptOutcome: finalAttempt ? { finalState: finalAttempt.final_state, stopStage: finalAttempt.stop_stage, stopReason: finalAttempt.stop_reason, retryClass: finalAttempt.retry_class, countsTowardRetryLimit: finalAttempt.counts_toward_retry_limit, completedAt: finalAttempt.completed_at } : null,
    publicationReadiness: readiness ? (readiness.ready ? "PASS" : "FAIL") : "NOT_RUN",
    publicationPayload: executionState.publisherInput ? "PASS" : "NOT_RUN",
    materializationPreview: eventResult?.finalState === "READY_FOR_PUBLICATION_DRY_RUN" ? "PASS" : "NOT_RUN",
    materialization: eventResult?.publicationOutcome ?? null,
    candidateVisibleToAnon: anonVisible === null ? "NOT_CHECKED" : anonVisible ? "YES" : "NO",
    rpcCalled: false, articleWrites: 0, requestAccounting: accountingPass ? "PASS" : "FAIL",
    dispatchedProviderAttempts: dispatchedCalls, eventRequestsUsed: requestsUsed, pipelineRequestsUsed: runRequests, persistentQuotaDelta: quotaDelta,
    groqCalls: dispatchedCalls, quotaBefore: quotaBefore + "/" + preflight.dailyRequestLimit + " remaining", quotaAfter: quotaAfter + "/" + preflight.dailyRequestLimit + " remaining",
    publish: false, productionCron: "DISABLED", model: preflight.models,
    quotaRequirements: { maxRetries: preflight.maxRetries, maxOutputTokens: preflight.maxOutputTokens, paidFallback: preflight.allowPaidFallback },
  };
  console.log(JSON.stringify(report, null, 2));

  if (unexpectedFailure) return;
  if (eventResult?.criticDecision === "pass" && readiness?.ready && executionState.publisherInput && eventResult.finalState === "READY_FOR_PUBLICATION_DRY_RUN" && accountingPass && !duplicateState.articleForEvent && !duplicateState.articleForSlug && anonVisible === false) {
    console.log("\n========================\nHUMAN PUBLICATION PREVIEW\n========================");
    console.log("HEADLINE\n" + executionState.publisherInput.payload.article.headlineEs);
    console.log("\nDEK / SUMMARY\n" + executionState.publisherInput.payload.article.dekEs + "\n\n" + executionState.publisherInput.payload.article.summaryEs);
    console.log("\nPOR QUÉ IMPORTA\n" + executionState.publisherInput.payload.article.whyItMattersEs);
    console.log("\nBODY\n" + executionState.publisherInput.payload.article.bodyEs);
    console.log("\nKEY POINTS\n" + executionState.publisherInput.payload.article.keyPoints.join("\n"));
    console.log("\nREGIÓN\n" + (executionState.publisherInput.payload.region.code ?? "N/A"));
    console.log("\nPAÍSES\n" + (executionState.publisherInput.payload.event.probableCountryCode ?? "N/A"));
    console.log("\nCATEGORÍAS\n" + executionState.publisherInput.payload.categories.map((category) => category.categorySlug).join(", "));
    console.log("\nENTIDADES\n" + executionState.publisherInput.payload.entities.map((entity) => entity.canonicalName).join(", "));
    console.log("\nFUENTES PÚBLICAS\n" + executionState.publisherInput.payload.sources.map((source) => source.sourceName + " — " + source.url).join("\n"));
    console.log("\nSLUG\n" + executionState.publisherInput.payload.article.slug);
    console.log("\nIMAGE AVAILABLE:\nNO");
    console.log("\nRANKING CONTEXT\n" + JSON.stringify({ importanceScore: executionState.publisherInput.payload.scores.importanceScore, impact: executionState.publisherInput.payload.scores.impact, novelty: executionState.publisherInput.payload.scores.novelty, economicImpact: executionState.publisherInput.payload.scores.economicImpact, credibility: executionState.publisherInput.payload.scores.credibility, reach: executionState.publisherInput.payload.scores.reach, momentum: executionState.publisherInput.payload.scores.momentum }, null, 2));
    console.log("\nFINAL STATUS: READY_FOR_HUMAN_PUBLICATION_APPROVAL");
  } else {
    console.log("\nFINAL STATUS: TRACEABLE_PIPELINE_VALIDATED_BUT_" + (eventResult?.finalState ?? "FAILED"));
  }
}

main().catch((error: unknown) => {
  console.error(failureMessage(error));
  process.exitCode = 1;
});
