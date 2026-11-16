import { randomUUID } from "node:crypto";
import { assessCandidateEvidence } from "../extraction/evidence-quality.ts";
import { initialRequestsRequired, remainingRequestsRequired, providerPipelineStages } from "./pipeline-budget.ts";
import { createRevisionPlan } from "./revision-orchestration.ts";
import { checkpointStages, writeAndVerifyCheckpoint } from "./pipeline-checkpoints.ts";
import { safePipelineLog } from "./pipeline-observability.ts";
import { pipelineStages } from "./pipeline-state.ts";
import { AgentError, errorSummary, getAgentFailureDetails, getProviderDiagnostics } from "../runtime/agent-errors.ts";
import { ZodError } from "zod";
import type { ClusterRunResult } from "../clustering/cluster-types.ts";
import type { DiscoveryRunResult } from "../discovery/discovery-types.ts";
import type { ExtractionRunResult } from "../extraction/extraction-types.ts";
import type { DiscoveryCandidate } from "../contracts/index.ts";
import { classificationResultSchema, criticResultSchema, editorialDraftSchema, pipelineRunContextSchema, rankingResultSchema, translationResultSchema, verificationResultSchema, type CriticResult, type EditorialDraft, type ClassificationResult, type ExtractedItem, type RankingResult, type TranslationResult, type VerificationResult } from "../contracts/index.ts";
import type { PipelineCandidateExtractionOutcome, PipelineConfig, PipelineDiscoverySummary, PipelineEventContext, PipelineEventResult, PipelineExtractionSummary, PipelineFailureSummary, PipelineOrchestratorOptions, PipelineRunContext, PipelineRunResult, PipelineStage, PipelineStageOutcome, PipelineStageStats } from "./pipeline-types.ts";
import { attemptOutcomeFromPipelineResult } from "./event-attempt-policy.ts";
import { assessCapacityResume, capacityResumePreviousStages, capacityResumeStages, capacityResumeSnapshotsMatch, checkpointSha256, nextCapacityResumeGeneration, parseCapacityResumeSnapshot, type CapacityResumeEvidence, type CapacityResumeSnapshot, type CapacityResumeStage } from "./provider-capacity-resume.ts";
import type { CapacityResumeOwnership } from "./event-attempt-repository.ts";
import { assertFactualRemediationLease, factualRemediationIncident, remediationFinalizationPolicy, type FactualRemediationLease } from "./factual-remediation.ts";
import { assertEventStageAssignment } from "../runtime/free-provider-router.ts";
import type { ContinuationCheckpointManifest } from "./factual-remediation-continuation.ts";
import { assertSupervisedEventLineageIsIndependent, isSafelyRejectedSupervisedAttempt, SUPERVISED_EVENT_ATTEMPT_LIMIT, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT } from "./supervised-throughput-policy.ts";

const defaultConfig: PipelineConfig = { dryRun: true, publish: false, hours: 24, limit: 1, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1 };
type PipelineAgentOutput = VerificationResult | TranslationResult | EditorialDraft | ClassificationResult | import("./pipeline-types.ts").GeoStageOutput | RankingResult | CriticResult | import("../publisher/publisher-types.ts").PublisherExecutionResult;

function validateConfig(config: PipelineConfig): void {
  if (!config.dryRun && !config.publish) throw new Error("Pipeline writes require explicit publish=true");
  if (!Number.isFinite(config.hours) || config.hours <= 0 || config.hours > 168) throw new Error("Pipeline hours must be between 0 and 168");
  if (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > 100) throw new Error("Pipeline limit must be an integer between 1 and 100");
  if (!Number.isInteger(config.maxRevisionAttempts) || config.maxRevisionAttempts < 1) throw new Error("maxRevisionAttempts must be a positive integer");
  if (config.mode === "supervised" && (!config.dryRun || config.publish || config.automaticRevision || config.limit > SUPERVISED_EVENT_ATTEMPT_LIMIT)) throw new Error("SUPERVISED_MODE_REQUIRES_DRY_RUN_NO_PUBLISH_NO_AUTO_REVISION_AND_LIMIT_AT_MOST_3");
}

function eventItems(event: PipelineEventContext["event"], extracted: ExtractedItem[]): ExtractedItem[] {
  const ids = new Set(event.sourceItems.map((item) => item.candidateId));
  return extracted.filter((item) => ids.has(item.candidateId));
}

function eventOrder(left: PipelineEventContext["event"], right: PipelineEventContext["event"]): number {
  const leftDate = left.sourceItems.map((item) => item.publishedAt ? Date.parse(item.publishedAt) : Number.MAX_SAFE_INTEGER).sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER;
  const rightDate = right.sourceItems.map((item) => item.publishedAt ? Date.parse(item.publishedAt) : Number.MAX_SAFE_INTEGER).sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER;
  return leftDate - rightDate || left.eventKey.localeCompare(right.eventKey);
}

function hasCompleteSupervisedSourceLineage(initial: Pick<PipelineEventContext, "event" | "items" | "sources">): boolean {
  if (initial.sources.length === 0 || initial.sources.length !== initial.event.sourceItems.length) return false;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const eventSources = new Map(initial.event.sourceItems.map((item) => [item.candidateId, item.sourceId]));
  const items = new Map(initial.items.map((item) => [item.candidateId, item]));
  const seenRawIds = new Set<string>();
  for (const source of initial.sources) {
    const item = items.get(source.sourceItemId);
    if (!item || eventSources.get(source.sourceItemId) !== source.sourceId || !uuid.test(source.sourceId)
      || !source.rawItemId || !uuid.test(source.rawItemId) || seenRawIds.has(source.rawItemId)
      || source.sourceUrl !== item.canonicalUrl) return false;
    seenRawIds.add(source.rawItemId);
  }
  return initial.event.sourceItems.every((item) => initial.sources.some((source) => source.sourceItemId === item.candidateId && source.sourceId === item.sourceId));
}

function stageStats(): Record<PipelineStage, PipelineStageStats> {
  return Object.fromEntries(pipelineStages.map((stage) => [stage, { status: "not_started", count: 0, failures: 0, skips: 0, requests: 0, totalLatencyMs: 0 }])) as Record<PipelineStage, PipelineStageStats>;
}

function discoverySummary(discovery: DiscoveryRunResult | undefined): PipelineDiscoverySummary | null {
  if (!discovery) return null;
  const rawItemIds = new Set(discovery.traceability.map((item) => item.rawItemId));
  return {
    discoveredCandidates: discovery.candidatesDiscovered,
    candidatesAfterDeduplication: discovery.candidates.length,
    duplicateUrls: discovery.duplicateUrls,
    duplicateContentHashes: discovery.duplicateContentHashes,
    invalidCandidates: discovery.invalidCandidates,
    undatedExcluded: discovery.undatedExcluded,
    rawItemsInserted: discovery.persisted,
    rawItemsUpdated: discovery.traceability.filter((item) => item.updated === true).length,
    rawItemsReused: discovery.persistSkipped,
    rawItemPersistenceErrors: discovery.persistErrors,
    rawItemsTouched: rawItemIds.size,
  };
}

function rawItemMappingOutcome(value: string | undefined, fallback: string): PipelineCandidateExtractionOutcome["discoveryRawItemMapping"] {
  const outcome = value ?? fallback;
  if (outcome === "created") return "CREATED";
  if (outcome === "updated") return "UPDATED";
  if (outcome === "reused") return "REUSED";
  if (outcome === "failed") return "FAILED";
  if (outcome === "not_requested") return "NOT_REQUESTED";
  return "NOT_RECORDED";
}

function extractionMappingOutcome(value: string | undefined, fallback: string): PipelineCandidateExtractionOutcome["extractionRawItemMapping"] {
  const outcome = value ?? fallback;
  if (outcome === "created") return "CREATED";
  if (outcome === "updated") return "UPDATED";
  if (outcome === "reused") return "REUSED";
  if (outcome === "failed") return "FAILED";
  if (outcome === "not_requested") return "NOT_REQUESTED";
  return "NOT_RECORDED";
}

function candidateOutcomes(
  selected: DiscoveryCandidate[],
  discovery: DiscoveryRunResult | undefined,
  extraction: ExtractionRunResult | undefined,
  clustering: ClusterRunResult | undefined,
  eventResults: PipelineEventResult[],
): PipelineCandidateExtractionOutcome[] {
  const discoveryPersistence = new Map((discovery?.persistenceOutcomes ?? []).map((item) => [item.sourceItemId, item]));
  const discoveryTrace = new Map((discovery?.traceability ?? []).map((item) => [item.sourceItemId, item]));
  const extractionTrace = new Map((extraction?.traceability ?? []).map((item) => [item.sourceItemId, item]));
  const extractionResults = new Map((extraction?.results ?? []).map((item) => [item.candidate.externalId, item]));
  const eventByCandidate = new Map<string, string>();
  for (const event of clustering?.events ?? []) for (const source of event.sourceItems) eventByCandidate.set(source.candidateId, event.eventKey);
  const eventResultByKey = new Map(eventResults.map((item) => [item.eventKey, item]));

  return selected.map((candidate): PipelineCandidateExtractionOutcome => {
    const result = extractionResults.get(candidate.externalId);
    const discoveryOutcome = discoveryPersistence.get(candidate.externalId);
    const discoveredTrace = discoveryTrace.get(candidate.externalId);
    const extractedTrace = extractionTrace.get(candidate.externalId);
    const rawItemId = result?.rawItemId ?? extractedTrace?.rawItemId ?? discoveredTrace?.rawItemId ?? discoveryOutcome?.rawItemId ?? null;
    const discoveryFallback = discoveredTrace ? (discoveredTrace.updated ? "updated" : discoveredTrace.action)
      : discoveryOutcome ? discoveryOutcome.outcome
      : discovery && (discovery.persisted > 0 || discovery.persistSkipped > 0 || discovery.persistErrors > 0) ? "not_recorded" : "not_requested";
    const discoveryRawItemMapping = rawItemMappingOutcome(discoveryOutcome?.outcome, discoveryFallback);
    const extractionRawItemMapping = extractionMappingOutcome(
      result?.rawItemMappingOutcome ?? (extractedTrace ? (extractedTrace.updated ? "updated" : extractedTrace.action) : undefined),
      extraction && (extraction.persisted > 0 || extraction.persistUpdated || extraction.persistSkipped > 0 || extraction.persistErrors > 0) ? "not_recorded" : "not_requested",
    );
    const extractionAttempted = result?.attempted ?? Boolean(result);
    const fetchOutcome: PipelineCandidateExtractionOutcome["fetchOutcome"] = result?.fetchOutcome === "succeeded" ? "SUCCEEDED"
      : result?.fetchOutcome === "blocked" ? "BLOCKED"
      : result?.fetchOutcome === "failed" ? "FAILED"
      : result?.fetchOutcome === "metadata_fallback" ? "METADATA_FALLBACK"
      : result?.fetchOutcome === "not_attempted" ? "NOT_ATTEMPTED"
      : result?.status === "blocked" ? "BLOCKED"
      : result?.status === "success" || result?.error?.code === "parse_error" || result?.error?.code === "empty_content" ? "SUCCEEDED"
      : result ? "FAILED" : "NOT_ATTEMPTED";
    const extractionOutcome: PipelineCandidateExtractionOutcome["extractionOutcome"] = result?.status === "success" ? "SUCCEEDED"
      : result ? "FAILED" : extraction ? "NOT_ATTEMPTED" : "UNRESOLVED";
    const failureCode = extractionRawItemMapping === "FAILED" ? "RAW_ITEM_PERSISTENCE_FAILED" : result?.error?.code ?? null;
    const parserOutcome: PipelineCandidateExtractionOutcome["parserOutcome"] = result?.parserOutcome === "succeeded" ? "SUCCEEDED"
      : result?.parserOutcome === "failed" || result?.error?.code === "parse_error" ? "FAILED"
      : result?.parserOutcome === "not_reached" ? "NOT_REACHED"
      : result?.status === "success" || result?.error?.code === "empty_content" ? "SUCCEEDED"
      : result ? "NOT_REACHED" : "UNKNOWN";
    const eventKey = eventByCandidate.get(candidate.externalId);
    const eventResult = eventKey ? eventResultByKey.get(eventKey) : undefined;
    const qualityGateOutcome: PipelineCandidateExtractionOutcome["qualityGateOutcome"] = eventResult?.evidenceQuality
      ? eventResult.evidenceQuality.eligible ? "ELIGIBLE" : "INSUFFICIENT"
      : "NOT_REACHED";
    let terminalOutcome: PipelineCandidateExtractionOutcome["terminalOutcome"];
    if (!result) terminalOutcome = extraction ? "NOT_ATTEMPTED" : "RUNTIME_ERROR_UNRESOLVED";
    else if (extractionRawItemMapping === "FAILED") terminalOutcome = "PERSISTENCE_FAILED";
    else if (result.error?.code === "parse_error") terminalOutcome = "PARSER_FAILED";
    else if (result.status === "blocked" || result.error?.code === "blocked") terminalOutcome = "FETCH_BLOCKED";
    else if (result.error?.code === "empty_content") terminalOutcome = "EMPTY_BODY";
    else if (result.status === "success") terminalOutcome = "EXTRACTION_SUCCEEDED";
    else if (fetchOutcome === "FAILED") terminalOutcome = "FETCH_FAILED";
    else terminalOutcome = "OTHER_FAILURE";
    return {
      candidateId: candidate.externalId,
      sourceId: candidate.sourceId,
      rawItemId,
      discoveryRawItemMapping,
      extractionRawItemMapping,
      extractionAttempted,
      fetchOutcome,
      extractionOutcome,
      failureCode,
      parserOutcome,
      qualityGateOutcome,
      terminalOutcome,
    };
  });
}

function extractionSummary(
  extraction: ExtractionRunResult | undefined,
  discovery: DiscoveryRunResult | undefined,
  selected: DiscoveryCandidate[],
  clustering: ClusterRunResult | undefined,
  eventResults: PipelineEventResult[],
): PipelineExtractionSummary | null {
  if (!extraction && selected.length === 0) return null;
  const selectedIds = new Set(selected.map((candidate) => candidate.externalId));
  const allResults = extraction?.results ?? [];
  const results = allResults.filter((result) => selectedIds.has(result.candidate.externalId));
  const outcomes = candidateOutcomes(selected, discovery, extraction, clustering, eventResults);
  const errorCodeCounts = new Map<string, number>();
  for (const result of results) {
    if (result.error?.code) errorCodeCounts.set(result.error.code, (errorCodeCounts.get(result.error.code) ?? 0) + 1);
  }
  const rawItemIds = new Set([
    ...(discovery?.traceability ?? []).map((item) => item.rawItemId),
    ...(extraction?.traceability ?? []).map((item) => item.rawItemId),
  ]);
  const extractionAttempts = results.filter((result) => result.attempted !== false).length;
  return {
    candidatesSelected: selected.length,
    extractedItems: results.filter((result) => result.item !== null).length,
    successfulResults: results.filter((result) => result.status === "success").length,
    blockedResults: results.filter((result) => result.status === "blocked").length,
    failedResults: results.filter((result) => result.status === "failed").length,
    errorCodeCounts: Object.fromEntries([...errorCodeCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
    persisted: extraction?.persisted ?? 0,
    persistUpdated: extraction?.persistUpdated ?? (extraction?.traceability.filter((item) => item.updated === true).length ?? 0),
    persistSkipped: extraction?.persistSkipped ?? 0,
    persistErrors: extraction?.persistErrors ?? 0,
    extractionAttempts,
    unexpectedResults: allResults.length - results.length,
    extractionSucceeded: results.filter((result) => result.status === "success").length,
    extractionFailed: results.filter((result) => result.status !== "success").length,
    extractionSkipped: Math.max(0, selected.length - extractionAttempts),
    rawItemsTouched: rawItemIds.size,
    rawItemsInserted: (discovery?.persisted ?? 0) + (extraction?.persisted ?? 0),
    rawItemsUpdated: (discovery?.traceability.filter((item) => item.updated === true).length ?? 0) + (extraction?.persistUpdated ?? extraction?.traceability.filter((item) => item.updated === true).length ?? 0),
    rawItemsReused: (discovery?.persistSkipped ?? 0) + (extraction?.persistSkipped ?? 0),
    rawItemPersistenceErrors: (discovery?.persistErrors ?? 0) + (extraction?.persistErrors ?? 0),
    candidateOutcomes: outcomes,
  };
}

function failureEvent(eventKey: string, stage: PipelineStage, reason: string, requestsUsed: number, checkpoints: PipelineEventResult["checkpoints"], telemetry: PipelineEventResult["telemetry"], failure?: PipelineFailureSummary): PipelineEventResult {
  return { eventKey, finalState: "FAILED", stopStage: stage, stopReason: reason, criticDecision: null, publicationOutcome: null, requestsUsed, checkpoints, telemetry, ...(failure ? { failure } : {}), revisionRequired: false, revisionStage: null };
}

function hasTrustworthyContinuationCriticUsage(outcome: PipelineStageOutcome<PipelineAgentOutput>): boolean {
  const telemetry = outcome.telemetry;
  const inputTokens = telemetry?.inputTokens;
  const outputTokens = telemetry?.outputTokens;
  const totalTokens = telemetry?.totalTokens;
  return outcome.provider === "groq"
    && outcome.model === "openai/gpt-oss-20b"
    && outcome.providerRequestsUsed === 1
    && telemetry?.provider === "groq"
    && telemetry.model === "openai/gpt-oss-20b"
    && telemetry.providerRequestDispatched === true
    && telemetry.providerRequestsUsed === 1
    && telemetry.providerUnit === "tokens"
    && telemetry.providerUnitUsageKnown === true
    && typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0
    && typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0
    && typeof totalTokens === "number" && Number.isSafeInteger(totalTokens) && totalTokens > 0
    && inputTokens + outputTokens === totalTokens;
}

function sanitizedFailureMessage(error: unknown): string {
  if (error instanceof ZodError) return "Pipeline input failed local schema validation";
  const message = errorSummary(error).message.replace(/(?:api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, "[redacted]");
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "Pipeline stage failed";
}

function invalidPaths(error: unknown, diagnostics: ReturnType<typeof getProviderDiagnostics>): string[] {
  if (diagnostics?.invalidPaths) return diagnostics.invalidPaths.slice(0, 20);
  if (error instanceof ZodError) return error.issues.map((issue) => issue.path.length === 0 ? "<root>" : issue.path.map((part) => typeof part === "number" ? `[${part}]` : String(part)).join(".")).slice(0, 20);
  return [];
}

function pipelineFailureSummary(error: unknown, stage: PipelineStage): PipelineFailureSummary {
  const details = getAgentFailureDetails(error);
  const diagnostics = details.diagnostics ?? getProviderDiagnostics(error);
  const summary = errorSummary(error);
  const providerRateLimit = diagnostics?.httpStatus === 429
    || diagnostics?.errorCategory === "RATE_LIMIT"
    || details.telemetry?.providerHttpStatus === 429
    || details.telemetry?.errorCategory === "RATE_LIMIT"
    || details.telemetry?.status === "FREE_TIER_LIMIT_REACHED";
  const errorCode = error instanceof AgentError && error.code === "EDITOR_GROUNDING_REJECTED"
    ? error.code
    : error instanceof ZodError ? "LOCAL_SCHEMA_VALIDATION_ERROR" : providerRateLimit ? "FREE_TIER_LIMIT_REACHED" : (diagnostics?.failureKind ?? (summary.code || "PIPELINE_STAGE_FAILED"));
  return {
    stage,
    errorCode,
    errorMessage: sanitizedFailureMessage(error),
    providerRequestDispatched: diagnostics?.providerRequestDispatched ?? false,
    providerRequestsUsed: details.providerRequestsUsed ?? (diagnostics?.providerRequestDispatched ? 1 : 0),
    attempts: details.attempts,
    retries: Math.max(0, details.attempts - 1),
    httpStatus: diagnostics?.httpStatus ?? null,
    checkpointWritten: false,
    invalidPaths: invalidPaths(error, diagnostics),
    ...(details.telemetry ? { telemetry: details.telemetry } : {}),
  };
}

function attemptPersistenceFailure(error: unknown, operation: "CAPACITY_DEFER" | "FINALIZE"): { stopReason: string; details: NonNullable<PipelineEventResult["persistenceFailure"]> } {
  const message = error instanceof Error ? error.message : "";
  const pattern = /^(EVENT_ATTEMPT_[A-Z_]+)(?::([A-Z0-9]+))?$/;
  const match = pattern.exec(message);
  const errorCode = match?.[1] ?? `EVENT_ATTEMPT_${operation}_FAILED`;
  const actualDatabaseCode = match?.[2] ?? null;
  const stopReason = `${errorCode}${actualDatabaseCode ? `:${actualDatabaseCode}` : ""}`;
  return {
    stopReason,
    details: {
      operation,
      errorCode,
      databaseCode: actualDatabaseCode,
      commitState: actualDatabaseCode && /^[0-9A-Z]{5}$/.test(actualDatabaseCode) ? "NOT_COMMITTED" : "UNKNOWN",
    },
  };
}

function validateStageOutput(stage: PipelineStage, value: unknown): void {
  if (stage === "verifier") verificationResultSchema.parse(value);
  else if (stage === "translator") translationResultSchema.parse(value);
  else if (stage === "editor") editorialDraftSchema.parse(value);
  else if (stage === "classifier") classificationResultSchema.parse(value);
  else if (stage === "ranker") rankingResultSchema.parse(value);
  else if (stage === "critic") criticResultSchema.parse(value);
}

export class PipelineOrchestrator {
  private readonly options: PipelineOrchestratorOptions;
  private readonly config: PipelineConfig;
  private readonly now: () => Date;

  constructor(options: PipelineOrchestratorOptions) {
    if (!options.quota) throw new Error("Pipeline quota inspector is required for fail-closed execution");
    this.options = options;
    this.config = { ...defaultConfig, ...options.config };
    this.now = options.now ?? (() => new Date());
    validateConfig(this.config);
    if (this.config.mode === "supervised" && (!options.humanReviewGateway || !options.attemptRegistry)) throw new Error("SUPERVISED_MODE_REQUIRES_REVIEW_GATEWAY_AND_ATTEMPT_REGISTRY");
  }

  async run(): Promise<PipelineRunResult> {
    const startedAt = this.now().toISOString();
    const run: PipelineRunContext = {
      schemaVersion: 1,
      runId: this.options.runId ?? randomUUID(),
      dryRun: this.config.dryRun,
      startedAt,
      trigger: this.config.trigger ?? "manual",
      agentVersions: this.options.agentVersions ?? {},
    };
    pipelineRunContextSchema.parse(run);
    const persistence = this.options.persistence;
    const persistedRunId = await persistence?.start(run) ?? null;
    const stats = stageStats();
    const eventResults: PipelineEventResult[] = [];
    let discovery: DiscoveryRunResult | undefined;
    let extraction: ExtractionRunResult | undefined;
    let clustering: ClusterRunResult | undefined;
    let selectedCandidates: DiscoveryCandidate[] = [];
    try {
      const discoveryOutput = await this.runDeterministicStage("discovery", () => this.options.stages.discovery({ run, config: this.config }), stats);
      const discovered = this.config.mode === "supervised"
        ? { ...discoveryOutput, candidates: discoveryOutput.candidates.slice(0, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT) }
        : discoveryOutput;
      discovery = discoveryOutput;
      selectedCandidates = discovered.candidates;
      const extracted = await this.runDeterministicStage("extraction", () => this.options.stages.extraction({ run, config: this.config, discovery: discovered }), stats);
      extraction = extracted;
      const clustered = await this.runDeterministicStage("clustering", () => this.options.stages.clustering({ run, config: this.config, extraction: extracted }), stats);
      clustering = clustered;
    } catch (error) {
      const completedAt = this.now().toISOString();
      const result: PipelineRunResult = {
        runId: run.runId, startedAt, completedAt, finalState: "FAILED", candidatesDiscovered: discovery?.candidatesDiscovered ?? 0, extractedItems: extraction?.results.filter((item) => item.item !== null).length ?? 0, extractionSummary: extractionSummary(extraction, discovery, selectedCandidates, clustering, []), discoverySummary: discoverySummary(discovery), clusteredEvents: clustering?.events.length ?? 0, eventsAttempted: 0, eventsPublished: 0, eventsDryRunReady: 0, eventsAwaitingHumanReview: 0, eventsSkipped: 0, eventsFailed: 1, eventsBlocked: 0, providerRequestsUsed: 0, stageStats: stats, eventResults: [], quotaBefore: null, quotaAfter: null,
      };
      await persistence?.finish(persistedRunId, result);
      throw error;
    }
    const extractionResult = extraction;
    const clusteringResult = clustering;
    const discoveryResult = discovery;
    const extractedItems = extractionResult.results.flatMap((item) => item.item ? [item.item] : []);
    const rawItemIds = new Map(extractionResult.results.map((result) => [result.candidate.externalId, result.rawItemId]));
    const orderedEvents = clusteringResult.events.map((event) => ({ event, items: eventItems(event, extractedItems), sources: this.options.stages.sourceMetadata(event, eventItems(event, extractedItems), rawItemIds) })).filter((item) => item.items.length > 0).sort((left, right) => eventOrder(left.event, right.event));
    const events = this.options.attemptRegistry ? await this.filterEligibleEvents(orderedEvents) : orderedEvents;
    const selectedEvents = events.slice(0, this.config.limit);
    if (this.config.mode === "supervised") assertSupervisedEventLineageIsIndependent(selectedEvents.map(({ event }) => event));
    const quotaBefore = this.options.quota ? await this.options.quota.remaining() : null;
    for (const event of selectedEvents) {
      const result = await this.runEvent(event, run, stats, persistedRunId);
      eventResults.push(result);
      // A review-ready candidate no longer ends the cycle: later events may still be attempted within the same
      // attempt limit (3), provider request cap (18) and per-event budget checks. Anything else still stops it.
      if (this.config.mode === "supervised" && !isSafelyRejectedSupervisedAttempt(result) && result.finalState !== "WAITING_FOR_HUMAN_REVIEW") break;
    }
    const completedAt = this.now().toISOString();
    const eventsPublished = eventResults.filter((item) => item.publicationOutcome === "new_article" || item.publicationOutcome === "deterministic_update").length;
    const eventsDryRunReady = eventResults.filter((item) => item.finalState === "READY_FOR_PUBLICATION_DRY_RUN").length;
    const eventsAwaitingHumanReview = eventResults.filter((item) => item.finalState === "WAITING_FOR_HUMAN_REVIEW").length;
    const eventsSkipped = eventResults.filter((item) => item.finalState === "SKIPPED").length;
    const eventsFailed = eventResults.filter((item) => item.finalState === "FAILED").length;
    const eventsBlocked = eventResults.filter((item) => item.finalState === "BLOCKED" || item.finalState.startsWith("BLOCKED_")).length;
    const providerRequestsUsed = eventResults.reduce((sum, item) => sum + item.requestsUsed, 0);
    const quotaAfter = this.options.quota ? await this.options.quota.remaining() : null;
    const supervisedCleanStops = this.config.mode === "supervised" && eventResults.length > 0
      && eventResults.every((item) => isSafelyRejectedSupervisedAttempt(item) || item.finalState === "WAITING_FOR_HUMAN_REVIEW");
    const finalState = eventResults.some((item) => item.finalState === "DEFERRED_PROVIDER_CAPACITY")
      ? "DEFERRED_PROVIDER_CAPACITY"
      : quotaBefore !== null && quotaBefore < initialRequestsRequired() && eventResults.some((item) => item.stopReason === "BLOCKED_INSUFFICIENT_DAILY_BUDGET")
      ? "BLOCKED_BUDGET"
      : eventsFailed > 0 || (eventsBlocked > 0 && !supervisedCleanStops) ? "SUCCESS_WITH_FAILURES" : "SUCCESS";
    const eventsAttempted = this.config.mode === "supervised" ? eventResults.filter((item) => Boolean(item.attemptId)).length : eventResults.length;
    const result: PipelineRunResult = { runId: run.runId, startedAt, completedAt, finalState, candidatesDiscovered: discoveryResult.candidatesDiscovered, extractedItems: extractedItems.length, extractionSummary: extractionSummary(extractionResult, discoveryResult, selectedCandidates, clusteringResult, eventResults), discoverySummary: discoverySummary(discoveryResult), clusteredEvents: clusteringResult.events.length, eventsAttempted, eventsPublished, eventsDryRunReady, eventsAwaitingHumanReview, eventsSkipped, eventsFailed, eventsBlocked, providerRequestsUsed, stageStats: stats, eventResults, quotaBefore, quotaAfter };
    await persistence?.finish(persistedRunId, result);
    return result;
  }

  /**
   * Runs the one server-authorized incident remediation from a fresh Verifier
   * context. Normal run(), scheduler, bridge, and retry callers never use this
   * entry point or its incident-specific attempt claim.
   */
  async runFactualRemediation(input: {
    lease: FactualRemediationLease;
    initial: { event: PipelineEventContext["event"]; items: PipelineEventContext["items"]; sources: PipelineEventContext["sources"] };
  }): Promise<PipelineEventResult> {
    if (this.config.mode === "supervised") throw new Error("SUPERVISED_AUTOMATIC_FACTUAL_REMEDIATION_DISABLED");
    assertFactualRemediationLease(input.lease);
    if (!this.options.attemptRegistry) throw new Error("FACTUAL_REMEDIATION_ATTEMPT_REGISTRY_REQUIRED");
    if (!this.options.factualRemediationAttemptGuard) throw new Error("FACTUAL_REMEDIATION_ATTEMPT_GUARD_REQUIRED");
    await this.options.factualRemediationAttemptGuard.assertOwned(input.lease);
    if (this.config.dryRun || !this.config.publish) throw new Error("FACTUAL_REMEDIATION_REQUIRES_EXPLICIT_PUBLISH_MODE");
    if (this.config.automaticRevision) throw new Error("FACTUAL_REMEDIATION_AUTOMATIC_REVISION_FORBIDDEN");
    if (this.options.quota?.provider !== "groq") throw new Error("FACTUAL_REMEDIATION_GROQ_QUOTA_REQUIRED");
    if (input.initial.event.eventKey !== factualRemediationIncident.eventKey
      || input.initial.event.sourceItems.length !== 1
      || input.initial.sources.length !== 1
      || input.initial.sources[0]?.rawItemId !== factualRemediationIncident.rawItemId
      || input.initial.sources[0]?.sourceId !== factualRemediationIncident.sourceId) {
      throw new Error("FACTUAL_REMEDIATION_INPUT_LINEAGE_MISMATCH");
    }

    const startedAt = this.now();
    const run: PipelineRunContext = {
      schemaVersion: 1,
      runId: input.lease.attempt.pipelineRunId,
      dryRun: false,
      startedAt: startedAt.toISOString(),
      trigger: "manual",
      agentVersions: this.options.agentVersions ?? {},
    };
    const stats = stageStats();
    const initial: PipelineEventContext = {
      event: input.initial.event,
      items: input.initial.items,
      sources: input.initial.sources,
      factualRemediationTarget: {
        attemptId: input.lease.attempt.id,
        pipelineRunId: input.lease.attempt.pipelineRunId,
        articleId: input.lease.articleId,
        articleSlug: input.lease.articleSlug,
      },
    };

    let result: PipelineEventResult;
    try {
      // runEventStages always creates a new context and begins at Verifier;
      // it does not load any historical checkpoint as stage state.
      result = await this.runEventStages(initial, run, stats, null);
    } catch (error) {
      await this.options.attemptRegistry.finalize({
        attemptId: input.lease.attempt.id,
        pipelineRunId: input.lease.attempt.pipelineRunId,
        completedAt: this.now().toISOString(),
        finalState: "ABORTED",
        stopStage: "verifier",
        stopReason: "FACTUAL_REMEDIATION_ORCHESTRATOR_ABORTED",
        retryClass: "NONE",
        countsTowardRetryLimit: false,
        nextEligibleAt: null,
      });
      throw error;
    }

    const outcome = remediationFinalizationPolicy(attemptOutcomeFromPipelineResult(result, startedAt));
    await this.options.attemptRegistry.finalize({
      attemptId: input.lease.attempt.id,
      pipelineRunId: input.lease.attempt.pipelineRunId,
      completedAt: this.now().toISOString(),
      ...outcome,
    });
    return result;
  }

  /** Continues the existing terminal fifth attempt at Critic; it never claims or finalizes an event-attempt row. */
  async runFactualRemediationContinuation(input: {
    attemptId: string;
    originalPipelineRunId: string;
    continuationPipelineRunId: string;
    resumeExecutionId: string;
    initial: PipelineEventContext;
    manifest: ContinuationCheckpointManifest;
    guard: {
      assertOwned(attemptId: string, continuationPipelineRunId: string, resumeExecutionId: string, manifest: ContinuationCheckpointManifest): Promise<void>;
      finish(input: { attemptId: string; continuationPipelineRunId: string; criticDecision: CriticResult["decision"] | null; stopStage: "critic" | "publisher"; stopReason: string; providerRequestsUsed: number }): Promise<void>;
    };
  }): Promise<PipelineEventResult> {
    if (this.config.mode === "supervised") throw new Error("SUPERVISED_AUTOMATIC_FACTUAL_REMEDIATION_DISABLED");
    if (input.attemptId !== "a82482be-58d8-4fc6-ac16-946d0906257b"
      || input.originalPipelineRunId !== "db368f10-d9c1-4897-b752-b3d2cb156e09"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.continuationPipelineRunId)
      || input.continuationPipelineRunId === input.originalPipelineRunId
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.resumeExecutionId)
      || input.resumeExecutionId === input.continuationPipelineRunId
      || input.resumeExecutionId === input.originalPipelineRunId) {
      throw new Error("FACTUAL_REMEDIATION_CONTINUATION_IDENTITY_INVALID");
    }
    if (!input.initial.criticInputOverride
      || input.initial.event.eventKey !== factualRemediationIncident.eventKey
      || input.initial.event.sourceItems.length !== 1
      || input.initial.sources.length !== 1
      || input.initial.sources[0]?.rawItemId !== factualRemediationIncident.rawItemId
      || input.initial.sources[0]?.sourceId !== factualRemediationIncident.sourceId
      || input.initial.criticInputOverride.event.eventKey !== factualRemediationIncident.eventKey) {
      throw new Error("FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_LINEAGE_INVALID");
    }
    if (this.config.dryRun || !this.config.publish || this.config.automaticRevision
      || this.options.quota?.provider !== "groq") {
      throw new Error("FACTUAL_REMEDIATION_CONTINUATION_EXECUTION_GUARDS_INVALID");
    }

    // The guard rereads both the continuation row and archived article immediately before Critic.
    await input.guard.assertOwned(input.attemptId, input.continuationPipelineRunId, input.resumeExecutionId, input.manifest);
    const startedAt = this.now();
    const run: PipelineRunContext = {
      schemaVersion: 1,
      runId: input.continuationPipelineRunId,
      dryRun: false,
      startedAt: startedAt.toISOString(),
      trigger: "manual",
      agentVersions: this.options.agentVersions ?? {},
    };
    const initial: PipelineEventContext = {
      ...input.initial,
      factualRemediationTarget: {
        attemptId: input.attemptId,
        pipelineRunId: input.continuationPipelineRunId,
        resumeExecutionId: input.resumeExecutionId,
        articleId: factualRemediationIncident.articleId,
        articleSlug: factualRemediationIncident.articleSlug,
        continuation: true,
      },
    };
    const result = await this.runEventStages(initial, run, stageStats(), null, true);
    if (result.finalState === "SUCCESS" && result.criticDecision === "pass") return result;

    await input.guard.finish({
      attemptId: input.attemptId,
      continuationPipelineRunId: input.continuationPipelineRunId,
      criticDecision: result.criticDecision,
      stopStage: result.stopStage === "publisher" ? "publisher" : "critic",
      stopReason: result.stopReason ?? result.finalState,
      providerRequestsUsed: result.requestsUsed,
    });
    return result;
  }

  /** Resumes the same supervised attempt at its first undispatched provider stage. */
  async resumeCapacityDeferred(input: { snapshot: unknown; evidence: CapacityResumeEvidence; ownerId?: string }): Promise<PipelineEventResult> {
    if (this.config.mode !== "supervised") throw new Error("CAPACITY_RESUME_REQUIRES_SUPERVISED_MODE");
    const registry = this.options.attemptRegistry;
    if (!registry?.claimCapacityResume || !registry.releaseCapacityResume || !registry.loadCapacityResumeSnapshot) throw new Error("CAPACITY_RESUME_ATTEMPT_GUARD_REQUIRED");
    const snapshot = parseCapacityResumeSnapshot(input.snapshot);
    const identity = { attemptId: snapshot.attemptId, eventKey: snapshot.eventKey, pipelineRunId: snapshot.pipelineRunId, resumeStage: snapshot.resumeStage };
    const storedSnapshot = await registry.loadCapacityResumeSnapshot(identity);
    if (!storedSnapshot || !capacityResumeSnapshotsMatch(snapshot, storedSnapshot)) throw new Error("CAPACITY_RESUME_STALE_SNAPSHOT");
    const assessment = assessCapacityResume(snapshot, input.evidence, { ownerId: input.ownerId });
    if (!assessment.valid) throw new Error(`CAPACITY_RESUME_NOT_SAFE:${assessment.reasons.join(",")}`);
    const ownership: CapacityResumeOwnership = { attemptId: snapshot.attemptId, eventKey: snapshot.eventKey, pipelineRunId: snapshot.pipelineRunId, ownerId: assessment.ownerId, resumeStage: snapshot.resumeStage };
    if (!await registry.claimCapacityResume(ownership)) throw new Error("CAPACITY_RESUME_ALREADY_CLAIMED_OR_NOT_DEFERRED");

    let released = false;
    try {
      const claimedSnapshot = await registry.loadCapacityResumeSnapshot(identity);
      if (!claimedSnapshot || !capacityResumeSnapshotsMatch(snapshot, claimedSnapshot)) throw new Error("CAPACITY_RESUME_STALE_SNAPSHOT");
      const startedAt = this.now();
      const run: PipelineRunContext = {
        schemaVersion: 1,
        runId: snapshot.pipelineRunId,
        dryRun: true,
        startedAt: startedAt.toISOString(),
        trigger: "manual",
        agentVersions: this.options.agentVersions ?? {},
      };
      const initial: PipelineEventContext = {
        event: snapshot.event,
        items: snapshot.items,
        sources: snapshot.sources,
        ...(snapshot.verification ? { verification: snapshot.verification } : {}),
        ...(snapshot.translation ? { translation: snapshot.translation } : {}),
        ...(snapshot.editorial ? { editorial: snapshot.editorial } : {}),
        providerAccounting: snapshot.providerAccounting,
        durableCheckpoints: snapshot.checkpoints,
        ...(snapshot.classification ? { classification: snapshot.classification } : {}),
        ...(snapshot.geo ? { geo: snapshot.geo } : {}),
        ...(snapshot.ranking ? { ranking: snapshot.ranking } : {}),
        ...(snapshot.criticInputOverride ? { criticInputOverride: snapshot.criticInputOverride } : {}),
      };
      const previousTelemetry = Object.fromEntries(Object.entries(snapshot.providerAccounting).map(([stage, value]) => [stage, {
        agentVersion: value.agentVersion,
        model: value.model,
        attempts: value.attempts,
        retries: value.retries,
        providerRequestsUsed: value.providerRequestsUsed,
        latencyMs: value.latencyMs,
        status: "success" as const,
      }])) as PipelineEventResult["telemetry"];
      const result = await this.runEventStages(initial, run, stageStats(), null, false, snapshot.attemptId, {
        startStage: snapshot.resumeStage,
        checkpoints: snapshot.checkpoints,
        telemetry: previousTelemetry,
        providerAccounting: snapshot.providerAccounting,
        resumeGeneration: snapshot.resumeGeneration,
      }, snapshot.attemptStartedAt ?? input.evidence.attempt.startedAt ?? snapshot.providerAccounting.verifier?.startedAt);
      if (result.finalState === "DEFERRED_PROVIDER_CAPACITY" || result.finalState === "DEFERRED_WORKER_TIME_BUDGET") {
        const nextStage = result.stopStage;
        const nextSnapshot = result.capacityResumeSnapshot;
        const budgetDefer = result.finalState === "DEFERRED_WORKER_TIME_BUDGET";
        if (!nextStage || !capacityResumeStages.includes(nextStage as CapacityResumeStage)
          || (budgetDefer ? !registry.deferWorkerTimeBudget : !registry.deferCapacity)
          || !nextSnapshot || nextSnapshot.resumeStage !== nextStage
          || (result.failure && (result.failure.providerRequestDispatched !== false || result.failure.providerRequestsUsed !== 0))) throw new Error("CAPACITY_RESUME_NEXT_STAGE_INVALID");
        const deferInput = {
          attemptId: snapshot.attemptId,
          eventKey: snapshot.eventKey,
          pipelineRunId: snapshot.pipelineRunId,
          stopStage: nextStage as CapacityResumeStage,
          snapshot: nextSnapshot,
          ownerId: assessment.ownerId,
          claimedStage: snapshot.resumeStage,
          providerRequestDispatched: false,
          providerRequestsUsed: 0,
        } as const;
        if (budgetDefer) await registry.deferWorkerTimeBudget!(deferInput);
        else await registry.deferCapacity!(deferInput);
        delete result.capacityResumeSnapshot;
        released = true;
        return result;
      }
      // The successful review RPC atomically creates WAITING and completes this
      // attempt. Match the normal supervised path: it owns this terminalization.
      if (result.finalState === "WAITING_FOR_HUMAN_REVIEW") {
        const critic = result.checkpoints.critic;
        if (result.criticDecision !== "pass" || !result.humanReviewId
          || !critic?.written || !critic.readable || !critic.valid) throw new Error("HUMAN_REVIEW_TERMINAL_TRANSITION_NOT_PROVEN");
        released = true;
        return result;
      }
      const attemptStartedAt = snapshot.attemptStartedAt ?? input.evidence.attempt.startedAt ?? snapshot.providerAccounting.verifier?.startedAt;
      if (!attemptStartedAt || !Number.isFinite(Date.parse(attemptStartedAt))) throw new Error("CAPACITY_RESUME_ORIGINAL_ATTEMPT_START_MISSING");
      await registry.finalize({
        attemptId: snapshot.attemptId,
        pipelineRunId: snapshot.pipelineRunId,
        completedAt: this.now().toISOString(),
        ...attemptOutcomeFromPipelineResult(result, new Date(attemptStartedAt)),
      });
      released = true;
      return result;
    } finally {
      if (!released) await registry.releaseCapacityResume(ownership).catch(() => undefined);
    }
  }

  private async runDeterministicStage<T>(stage: PipelineStage, operation: () => Promise<T>, stats: Record<PipelineStage, PipelineStageStats>): Promise<T> {
    const started = Date.now(); stats[stage] = { ...stats[stage], status: "running" };
    try { const output = await operation(); stats[stage] = { ...stats[stage], status: "success", count: 1, totalLatencyMs: Date.now() - started }; return output; }
    catch (error) { stats[stage] = { ...stats[stage], status: "failed", count: 1, failures: 1, totalLatencyMs: Date.now() - started }; throw error; }
  }

  private async filterEligibleEvents(events: Array<{ event: PipelineEventContext["event"]; items: PipelineEventContext["items"]; sources: PipelineEventContext["sources"] }>): Promise<Array<{ event: PipelineEventContext["event"]; items: PipelineEventContext["items"]; sources: PipelineEventContext["sources"] }>> {
    if (!this.options.attemptRegistry) return events;
    const eligibility = await this.options.attemptRegistry.getEligibility(events.map((item) => item.event.eventKey), this.now());
    return events.filter((item) => eligibility.get(item.event.eventKey)?.eligible === true);
  }

  private async runEvent(initial: { event: PipelineEventContext["event"]; items: PipelineEventContext["items"]; sources: PipelineEventContext["sources"] }, run: PipelineRunContext, stats: Record<PipelineStage, PipelineStageStats>, persistedRunId: string | null): Promise<PipelineEventResult> {
    const registry = this.options.attemptRegistry;
    const startedAt = this.now();
    let claim: Awaited<ReturnType<NonNullable<typeof registry>["claim"]>> | null = null;
    if (registry) {
      claim = await registry.claim({ eventKey: initial.event.eventKey, pipelineRunId: run.runId, startedAt: startedAt.toISOString(), now: startedAt.toISOString() });
      if (claim.status !== "ACQUIRED") {
        return { eventKey: initial.event.eventKey, finalState: "BLOCKED", stopStage: "verifier", stopReason: `BLOCKED_EVENT_ATTEMPT_${claim.status}`, criticDecision: null, publicationOutcome: null, requestsUsed: 0, checkpoints: {}, telemetry: {}, revisionRequired: false, revisionStage: null };
      }
    }
    const evidenceQuality = assessCandidateEvidence(initial.event.canonicalTitle, initial.items);
    let result: PipelineEventResult;
    if (!evidenceQuality.eligible) {
      for (const stage of ["verifier", "translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"] as const) {
        stats[stage] = { ...stats[stage], status: "skipped", skips: stats[stage].skips + 1 };
      }
      await safePipelineLog(this.options.persistence, persistedRunId, { level: "info", step: "EXTRACTION_EVIDENCE_INSUFFICIENT", message: "Selected candidate has insufficient related body evidence before Verifier", payload: { eventKey: initial.event.eventKey, evidenceQuality } });
      result = { eventKey: initial.event.eventKey, finalState: "SKIPPED", stopStage: "extraction", stopReason: evidenceQuality.terminalReason, evidenceQuality, criticDecision: null, publicationOutcome: null, requestsUsed: 0, checkpoints: {}, telemetry: {}, revisionRequired: false, revisionStage: null };
    } else {
      result = await this.runEventStages(initial, run, stats, persistedRunId, false, claim?.status === "ACQUIRED" ? claim.attempt.id : undefined, undefined, claim?.status === "ACQUIRED" ? claim.attempt.startedAt : undefined);
      result.evidenceQuality = evidenceQuality;
    }
    if (claim?.status === "ACQUIRED") result.attemptId = claim.attempt.id;
    if (registry && claim?.status === "ACQUIRED" && result.finalState !== "WAITING_FOR_HUMAN_REVIEW") {
      try {
        if (result.finalState === "DEFERRED_PROVIDER_CAPACITY") {
          const snapshot = result.capacityResumeSnapshot;
          if (!registry.deferCapacity) throw new Error("EVENT_ATTEMPT_CAPACITY_DEFER_UNSUPPORTED");
          if (!snapshot || snapshot.resumeStage !== result.stopStage
            || result.failure?.providerRequestDispatched !== false || result.failure.providerRequestsUsed !== 0) {
            throw new Error("EVENT_ATTEMPT_CAPACITY_SNAPSHOT_REQUIRED");
          }
          await registry.deferCapacity({
            attemptId: claim.attempt.id,
            eventKey: initial.event.eventKey,
            pipelineRunId: run.runId,
            stopStage: snapshot.resumeStage,
            snapshot,
            providerRequestDispatched: false,
            providerRequestsUsed: 0,
          });
          delete result.capacityResumeSnapshot;
        } else if (result.finalState === "DEFERRED_WORKER_TIME_BUDGET") {
          const snapshot = result.capacityResumeSnapshot;
          if (!registry.deferWorkerTimeBudget || !snapshot || snapshot.resumeStage !== result.stopStage) throw new Error("EVENT_ATTEMPT_WORKER_BUDGET_SNAPSHOT_REQUIRED");
          await registry.deferWorkerTimeBudget({
            attemptId: claim.attempt.id,
            eventKey: initial.event.eventKey,
            pipelineRunId: run.runId,
            stopStage: snapshot.resumeStage,
            snapshot,
            providerRequestDispatched: false,
            providerRequestsUsed: 0,
          });
          delete result.capacityResumeSnapshot;
        } else {
          const outcome = attemptOutcomeFromPipelineResult(result, startedAt);
          await registry.finalize({ attemptId: claim.attempt.id, pipelineRunId: run.runId, completedAt: this.now().toISOString(), ...outcome });
        }
      } catch (error) {
        const operation = result.finalState === "DEFERRED_PROVIDER_CAPACITY" || result.finalState === "DEFERRED_WORKER_TIME_BUDGET" ? "CAPACITY_DEFER" : "FINALIZE";
        const persistenceFailure = attemptPersistenceFailure(error, operation);
        result = {
          ...result,
          finalState: "FAILED",
          stopReason: persistenceFailure.stopReason,
          persistenceFailure: persistenceFailure.details,
        };
      }
    }
    delete result.capacityResumeSnapshot;
    if (claim?.status === "ACQUIRED") result.attemptId = claim.attempt.id;
    return result;
  }

  private async runEventStages(initial: PipelineEventContext, run: PipelineRunContext, stats: Record<PipelineStage, PipelineStageStats>, persistedRunId: string | null, criticOnly = false, attemptId?: string, resume?: { startStage: PipelineStage; checkpoints: PipelineEventResult["checkpoints"]; telemetry: PipelineEventResult["telemetry"]; providerAccounting: Partial<Record<"verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic", import("../runtime/runtime-types.ts").AgentTelemetry>>; resumeGeneration?: number }, attemptStartedAt?: string): Promise<PipelineEventResult> {
    const context: PipelineEventContext = { ...initial, ...(attemptId ? { eventAttemptId: attemptId } : {}) };
    const checkpoints: PipelineEventResult["checkpoints"] = { ...resume?.checkpoints };
    const telemetry: PipelineEventResult["telemetry"] = { ...resume?.telemetry };
    const providerAccounting: Partial<Record<"verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic", import("../runtime/runtime-types.ts").AgentTelemetry>> = { ...resume?.providerAccounting };
    context.durableCheckpoints = { ...checkpoints };
    context.providerAccounting = { ...providerAccounting };
    let requestsUsed = 0;
    if (this.config.mode === "supervised" && !hasCompleteSupervisedSourceLineage(initial)) {
      return { eventKey: initial.event.eventKey, finalState: "BLOCKED", stopStage: "verifier", stopReason: "SUPERVISED_SOURCE_RAW_LINEAGE_INCOMPLETE", criticDecision: null, publicationOutcome: null, requestsUsed, checkpoints: {}, telemetry: {}, revisionRequired: false, revisionStage: null };
    }
    const stageOrder: Array<"verifier" | "translator" | "editor" | "classifier" | "geo" | "ranker" | "critic" | "publisher"> = ["verifier", "translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"];
    await safePipelineLog(this.options.persistence, persistedRunId, { level: "info", step: "EVENT_STARTED", message: "Pipeline event started", payload: { eventKey: initial.event.eventKey } });
    const firstStage = resume?.startStage ?? (criticOnly ? "critic" : "verifier");
    if (!stageOrder.includes(firstStage as (typeof stageOrder)[number])) throw new Error("PIPELINE_RESUME_STAGE_INVALID");
    const stages = stageOrder.slice(stageOrder.indexOf(firstStage as (typeof stageOrder)[number]));
    let capacityResumeSnapshotPath: string | undefined;
    let capacityResumeSnapshot: CapacityResumeSnapshot | undefined;
    const resumeGeneration = nextCapacityResumeGeneration(resume?.resumeGeneration);
    for (const stage of stages) {
        if (stage !== "geo" && stage !== "publisher") {
        const required = remainingRequestsRequired(stage);
        if (required > 0 && this.options.quota && await this.options.quota.remaining() < required) {
          stats[stage] = { ...stats[stage], status: "skipped", skips: stats[stage].skips + 1 };
          return { eventKey: initial.event.eventKey, finalState: "BLOCKED", stopStage: stage, stopReason: "BLOCKED_INSUFFICIENT_DAILY_BUDGET", criticDecision: context.critic?.decision ?? null, publicationOutcome: null, requestsUsed, checkpoints, telemetry, revisionRequired: false, revisionStage: null };
        }
      }
      const started = Date.now();
      stats[stage] = { ...stats[stage], status: "running" };
      try {
        if (this.config.mode === "supervised" && attemptId && this.options.capacityResumeSnapshotWriter && capacityResumeStages.includes(stage as CapacityResumeStage)) {
          const resumeStage = stage as CapacityResumeStage;
          const prior = capacityResumePreviousStages[resumeStage];
          const hasPriorState = prior.every((name) => checkpoints[name] && providerAccounting[name]);
          const hasCanonicalOutputs = resumeStage === "verifier"
            ? !context.verification && !context.translation
            : resumeStage === "translator"
              ? Boolean(context.verification && !context.translation)
              : Boolean(context.verification && context.translation
                && (resumeStage === "editor" || context.editorial)
                && (resumeStage === "editor" || resumeStage === "classifier" || (context.classification && context.geo))
                && (resumeStage !== "critic" || context.ranking));
          if (hasPriorState && hasCanonicalOutputs) {
            const priorCheckpoints = Object.fromEntries(prior.map((name) => [name, checkpoints[name]])) as CapacityResumeSnapshot["checkpoints"];
            const priorAccounting = Object.fromEntries(prior.map((name) => [name, providerAccounting[name]])) as CapacityResumeSnapshot["providerAccounting"];
            const baseSnapshot = {
              schemaVersion: 1 as const,
              kind: "SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME" as const,
              attemptId,
              pipelineRunId: run.runId,
              eventKey: initial.event.eventKey,
              resumeStage,
              attemptStartedAt: attemptStartedAt ?? run.startedAt,
              event: context.event,
              items: context.items,
              sources: context.sources,
              ...(context.verification ? { verification: context.verification } : {}),
              ...(context.translation ? { translation: context.translation } : {}),
              ...(context.editorial ? { editorial: context.editorial } : {}),
              ...(context.classification ? { classification: context.classification } : {}),
              ...(context.geo ? { geo: context.geo } : {}),
              ...(context.ranking ? { ranking: context.ranking } : {}),
              ...(context.criticInputOverride ? { criticInputOverride: context.criticInputOverride } : {}),
              checkpoints: priorCheckpoints,
              providerAccounting: priorAccounting,
              nextStageDispatchCount: 0 as const,
              nextStageCheckpointPresent: false as const,
              ...(resumeStage === "classifier" ? { classifierDispatchCount: 0 as const, classifierCheckpointPresent: false as const } : {}),
              resumeGeneration,
            };
            const hashes = await checkpointSha256(priorCheckpoints);
            capacityResumeSnapshot = parseCapacityResumeSnapshot({ ...baseSnapshot, checkpointSha256: hashes });
            const saved = await this.options.capacityResumeSnapshotWriter({ ...baseSnapshot, checkpointSha256: hashes });
            capacityResumeSnapshotPath = saved.path;
          }
        }
        if (this.config.mode === "supervised" && ["verifier", "translator", "editor", "classifier", "ranker", "critic"].includes(stage)
          && this.options.shouldStartSemanticStage
          && !this.options.shouldStartSemanticStage(stage as "verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic")) {
          if (!capacityResumeSnapshot) throw new Error("WORKER_TIME_BUDGET_RESUME_SNAPSHOT_REQUIRED");
          stats[stage] = { ...stats[stage], status: "skipped", skips: stats[stage].skips + 1, totalLatencyMs: stats[stage].totalLatencyMs + Date.now() - started };
          return { eventKey: initial.event.eventKey, finalState: "DEFERRED_WORKER_TIME_BUDGET", stopStage: stage as CapacityResumeStage, stopReason: "WORKER_TIME_BUDGET_EXHAUSTED", criticDecision: context.critic?.decision ?? null, publicationOutcome: null, requestsUsed, checkpoints, telemetry, revisionRequired: false, revisionStage: null, capacityResumeSnapshot };
        }
        const outcome = await this.invokeStage(stage, context, run);
        if (outcome.eventKey !== initial.event.eventKey) throw new Error("PIPELINE_EVENT_KEY_MISMATCH");
        if (context.providerAssignment && providerPipelineStages.includes(stage as (typeof providerPipelineStages)[number])) {
          if (!outcome.provider) throw new Error("EVENT_PROVIDER_ASSIGNMENT_MISSING");
          if (outcome.provider !== "groq" && outcome.provider !== "cloudflare_workers_ai") throw new Error("EVENT_PROVIDER_ASSIGNMENT_NOT_FREE_ROUTABLE");
          assertEventStageAssignment(context.providerAssignment, initial.event.eventKey, outcome.provider, outcome.model);
        }
        validateStageOutput(stage, outcome.output);
        requestsUsed += outcome.providerRequestsUsed;
        telemetry[stage] = this.telemetry(outcome, "success");
        if (["verifier", "translator", "editor", "classifier", "ranker", "critic"].includes(stage) && outcome.telemetry) {
          providerAccounting[stage as keyof typeof providerAccounting] = outcome.telemetry;
        }
        stats[stage] = { ...stats[stage], requests: stats[stage].requests + outcome.providerRequestsUsed };
        if (criticOnly && stage === "critic" && !hasTrustworthyContinuationCriticUsage(outcome)) {
          throw new AgentError("FACTUAL_REMEDIATION_CRITIC_USAGE_UNKNOWN", "Critic provider usage was not reliably settled");
        }
        const checkpoint = checkpointStages.includes(stage) ? await writeAndVerifyCheckpoint(stage, initial.event.eventKey, outcome.checkpoint) : undefined;
        if (checkpoint) checkpoints[stage] = checkpoint;
        context.durableCheckpoints = { ...checkpoints };
        context.providerAccounting = { ...providerAccounting };
        if (stage === "verifier" && (outcome.output as VerificationResult).verifiedFacts.length === 0) {
          stats[stage] = { ...stats[stage], status: "success", count: stats[stage].count + 1, totalLatencyMs: stats[stage].totalLatencyMs + Date.now() - started };
          await safePipelineLog(this.options.persistence, persistedRunId, { level: "warn", step: "VERIFICATION_SKIPPED", message: "Event skipped because verification has no verified facts", payload: { eventKey: initial.event.eventKey, reason: "SKIPPED_VERIFICATION_INSUFFICIENT" } });
          for (const downstream of ["translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"] as const) {
            stats[downstream] = { ...stats[downstream], status: "skipped", skips: stats[downstream].skips + 1 };
          }
          return { eventKey: initial.event.eventKey, finalState: "SKIPPED", stopStage: "verifier", stopReason: "SKIPPED_VERIFICATION_INSUFFICIENT", criticDecision: null, publicationOutcome: null, requestsUsed, checkpoints, telemetry, revisionRequired: false, revisionStage: null };
        }
        this.assignOutput(context, stage, outcome);
        stats[stage] = { ...stats[stage], status: "success", count: stats[stage].count + 1, totalLatencyMs: stats[stage].totalLatencyMs + Date.now() - started };
        await safePipelineLog(this.options.persistence, persistedRunId, { level: "info", step: `${stage.toUpperCase()}_SUCCESS`, message: `Pipeline stage ${stage} succeeded`, payload: { eventKey: initial.event.eventKey, requestsUsed: outcome.providerRequestsUsed, attempts: outcome.attempts } });
        if (stage === "verifier" && (outcome.output as VerificationResult).status === "rejected") {
          for (const downstream of ["translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"] as const) {
            stats[downstream] = { ...stats[downstream], status: "skipped", skips: stats[downstream].skips + 1 };
          }
          return { eventKey: initial.event.eventKey, finalState: "SKIPPED", stopStage: "verifier", stopReason: "VERIFICATION_REJECTED", criticDecision: null, publicationOutcome: null, requestsUsed, checkpoints, telemetry, revisionRequired: false, revisionStage: null };
        }
        if (stage === "critic") {
          const critic = outcome.output as CriticResult;
          if (critic.decision !== "pass") {
            if (critic.decision === "reject") return { eventKey: initial.event.eventKey, finalState: "BLOCKED_REJECTED", stopStage: "critic", stopReason: "BLOCKED_REJECTED", criticDecision: critic.decision, publicationOutcome: null, requestsUsed, checkpoints, telemetry, revisionRequired: false, revisionStage: null };
            const revisionPlan = createRevisionPlan({ decision: critic.decision, revisionAttempt: 0, remainingRequests: await this.options.quota!.remaining(), maxRevisionAttempts: this.config.maxRevisionAttempts });
            return {
              eventKey: initial.event.eventKey,
              finalState: "BLOCKED_REVISION_REQUIRED",
              stopStage: "critic",
              stopReason: "BLOCKED_REVISION_REQUIRED",
              criticDecision: critic.decision,
              publicationOutcome: null,
              requestsUsed,
              checkpoints,
              telemetry,
              revisionRequired: true,
              revisionStage: revisionPlan.requestedStage,
              revision: {
                revisionRequired: true,
                revisionRequestedStage: revisionPlan.requestedStage,
                revisionAttempt: revisionPlan.revisionAttempt,
                maxRevisionAttempts: revisionPlan.maxRevisionAttempts,
                revisionRequestsRequired: revisionPlan.requestsRequiredWorstCase,
                revisionBudgetAllowed: revisionPlan.allowed,
                revisionStarted: false,
                revisionCompleted: false,
                revisionFinalDecision: critic.decision,
                checkpointsToInvalidate: revisionPlan.checkpointsToInvalidate,
                preservedCheckpoints: revisionPlan.preservedCheckpoints,
              },
            };
          }
          if (this.config.mode === "supervised") {
            if (critic.decision !== "pass") throw new Error("SUPERVISED_REVIEW_REQUIRES_CRITIC_PASS");
            if (!attemptId || !this.options.humanReviewGateway) throw new Error("SUPERVISED_REVIEW_ATTEMPT_ID_REQUIRED");
            const created = await this.options.humanReviewGateway.createReview({ context, run, attemptId, checkpoints, providerAccounting });
            return {
              eventKey: initial.event.eventKey,
              finalState: "WAITING_FOR_HUMAN_REVIEW",
              stopStage: "human_review",
              stopReason: "HUMAN_REVIEW_PENDING",
              criticDecision: critic.decision,
              publicationOutcome: null,
              requestsUsed,
              checkpoints,
              telemetry,
              revisionRequired: false,
              revisionStage: null,
              humanReviewId: created.reviewId,
              reviewPackageSha256: created.packageSha256,
            };
          }
        }
        if (stage === "publisher") {
          const publisher = outcome.output as import("../publisher/publisher-types.ts").PublisherExecutionResult;
          return { eventKey: initial.event.eventKey, finalState: this.config.dryRun ? "READY_FOR_PUBLICATION_DRY_RUN" : "SUCCESS", stopStage: null, stopReason: null, criticDecision: context.critic?.decision ?? null, publicationOutcome: publisher.summary.idempotencyOutcome, requestsUsed, checkpoints, telemetry, revisionRequired: false, revisionStage: null };
        }
      } catch (error) {
        const failure = pipelineFailureSummary(error, stage);
        const reason = failure.errorCode === "FREE_TIER_LIMIT_REACHED" ? "PROVIDER_RATE_LIMIT" : failure.errorCode;
        requestsUsed += failure.providerRequestsUsed;
        stats[stage] = { ...stats[stage], requests: stats[stage].requests + failure.providerRequestsUsed };
        if (reason === "PROVIDER_CAPACITY_EXHAUSTED" && failure.providerRequestDispatched === false && failure.providerRequestsUsed === 0) {
          stats[stage] = { ...stats[stage], status: "skipped", skips: stats[stage].skips + 1, totalLatencyMs: stats[stage].totalLatencyMs + Date.now() - started };
          await safePipelineLog(this.options.persistence, persistedRunId, { level: "warn", step: "PROVIDER_CAPACITY_DEFERRED", message: "Provider capacity stopped the stage before dispatch; the attempt remains resumable", payload: { eventKey: initial.event.eventKey, stage } });
          return { eventKey: initial.event.eventKey, finalState: "DEFERRED_PROVIDER_CAPACITY", stopStage: stage, stopReason: "PROVIDER_CAPACITY_EXHAUSTED", criticDecision: context.critic?.decision ?? null, publicationOutcome: null, requestsUsed, checkpoints, telemetry, failure, revisionRequired: false, revisionStage: null, ...(capacityResumeSnapshotPath ? { capacityResumeSnapshotPath } : {}), ...(capacityResumeSnapshot ? { capacityResumeSnapshot } : {}) };
        }
        stats[stage] = { ...stats[stage], status: "failed", count: stats[stage].count + 1, failures: stats[stage].failures + 1, totalLatencyMs: stats[stage].totalLatencyMs + Date.now() - started };
        await safePipelineLog(this.options.persistence, persistedRunId, { level: "error", step: `${stage.toUpperCase()}_FAILED`, message: "Pipeline stage failed closed", payload: { eventKey: initial.event.eventKey, errorCode: reason } });
        if (reason === "EDITOR_GROUNDING_REJECTED") {
          return { ...failureEvent(initial.event.eventKey, stage, reason, requestsUsed, checkpoints, telemetry, failure), finalState: "BLOCKED_REJECTED" };
        }
        if (reason === "VERIFIER_INPUT_TOO_LARGE" && stage === "verifier") {
          return { ...failureEvent(initial.event.eventKey, stage, reason, requestsUsed, checkpoints, telemetry, failure), finalState: "BLOCKED_REJECTED" };
        }
        return failureEvent(initial.event.eventKey, stage, reason, requestsUsed, checkpoints, telemetry, failure);
      }
    }
    return failureEvent(initial.event.eventKey, "publisher", "PIPELINE_PUBLISHER_NOT_REACHED", requestsUsed, checkpoints, telemetry);
  }

  private async invokeStage(stage: "verifier" | "translator" | "editor" | "classifier" | "geo" | "ranker" | "critic" | "publisher", context: PipelineEventContext, run: PipelineRunContext): Promise<PipelineStageOutcome<PipelineAgentOutput>> {
    if (stage === "publisher") return this.options.stages.publisher(context, run, { dryRun: this.config.dryRun || !this.config.publish });
    return this.options.stages[stage](context, run) as Promise<PipelineStageOutcome<PipelineAgentOutput>>;
  }

  private assignOutput(context: PipelineEventContext, stage: string, outcome: PipelineStageOutcome<PipelineAgentOutput>): void {
    if (stage === "verifier") context.verification = outcome.output as VerificationResult;
    else if (stage === "translator") context.translation = outcome.output as import("../contracts/index.ts").TranslationResult;
    else if (stage === "editor") context.editorial = outcome.output as import("../contracts/index.ts").EditorialDraft;
    else if (stage === "classifier") context.classification = outcome.output as import("../contracts/index.ts").ClassificationResult;
    else if (stage === "geo") context.geo = outcome.output as import("./pipeline-types.ts").GeoStageOutput;
    else if (stage === "ranker") context.ranking = outcome.output as import("../contracts/index.ts").RankingResult;
    else if (stage === "critic") context.critic = outcome.output as import("../contracts/index.ts").CriticResult;
  }

  private telemetry(outcome: PipelineStageOutcome<PipelineAgentOutput>, status: "success" | "failed" | "skipped"): import("./pipeline-types.ts").StageTelemetrySummary {
    return { agentVersion: outcome.agentVersion, model: outcome.model, attempts: outcome.attempts, retries: outcome.retries, providerRequestsUsed: outcome.providerRequestsUsed, ...(outcome.telemetry ? { inputTokens: outcome.telemetry.inputTokens, outputTokens: outcome.telemetry.outputTokens, totalTokens: outcome.telemetry.totalTokens } : {}), latencyMs: outcome.latencyMs, status };
  }
}

export function createPipelineConfig(input: Partial<PipelineConfig> = {}): PipelineConfig {
  const config = { ...defaultConfig, ...input };
  validateConfig(config);
  return config;
}
