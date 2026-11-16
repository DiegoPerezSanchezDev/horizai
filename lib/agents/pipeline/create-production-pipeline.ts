import type { SupabaseClient } from "@supabase/supabase-js";
import { rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "../../../types/database.ts";
import { validFixtures } from "../contracts/fixtures.ts";
import type { ClusteredEvent, ExtractedItem, PublicationPayload, TranslationResult } from "../contracts/index.ts";
import { runDiscovery } from "../discovery/discovery-runner.ts";
import { extractCandidate, persistExtractionResults } from "../extraction/extraction-runner.ts";
import type { ExtractionResult, ExtractionRunResult } from "../extraction/extraction-types.ts";
import { applyExtractionFreshness, freshExtractionResults } from "../extraction/freshness-policy.ts";
import { clusterExtractedItems } from "../clustering/cluster-runner.ts";
import type { ClusterRunResult } from "../clustering/cluster-types.ts";
import { VerifierAgent, getVerifierModelConfig, verifierAgentVersion } from "../verifier/verifier-agent.ts";
import type { VerifierInput } from "../verifier/verifier-types.ts";
import { TranslatorAgent, getTranslatorModelConfig, translatorAgentVersion } from "../translator/translator-agent.ts";
import type { TranslatorInput, TranslatorModelInput } from "../translator/translator-types.ts";
import { buildTranslatorModelInput } from "../translator/translator-input.ts";
import { readSafeTranslatorCheckpoint, writeTranslatorCheckpointAtomic, type TranslatorCheckpoint } from "../translator/translator-checkpoint.ts";
import { EditorAgent, getEditorModelConfig, editorAgentVersion } from "../editor/editor-agent.ts";
import { buildEditorInput } from "../editor/editor-input.ts";
import type { EditorInput } from "../editor/editor-types.ts";
import { readSafeTranslatorEditorCheckpoint, writeTranslatorEditorCheckpointAtomic, type TranslatorEditorCheckpoint } from "../editor/translator-editor-checkpoint.ts";
import { ClassifierAgent, getClassifierModelConfig, classifierAgentVersion } from "../classifier/classifier-agent.ts";
import { buildClassifierInput } from "../classifier/classifier-input.ts";
import { loadActiveReferenceRegistry, type ReferenceRegistry } from "../classifier/geo-registry.ts";
import { resolveGeo } from "../classifier/geo-resolver.ts";
import { readSafeClassifierPipelineCheckpoint, writeClassifierPipelineCheckpointAtomic, type ClassifierPipelineCheckpoint } from "../classifier/classifier-pipeline-checkpoint.ts";
import { RankerAgent, getRankerModelConfig, rankerAgentVersion } from "../ranker/ranker-agent.ts";
import { buildRankerPipelineInput } from "../ranker/ranker-input.ts";
import { buildRankerPipelineCheckpoint, readSafeRankerPipelineCheckpoint, writeRankerPipelineCheckpointAtomic, type RankerPipelineCheckpoint } from "../critic/ranker-pipeline-checkpoint.ts";
import { CriticAgent, getCriticModelConfig, criticAgentVersion } from "../critic/critic-agent.ts";
import { buildCriticInput, buildCriticSourceEvidence } from "../critic/critic-input.ts";
import { buildCriticPipelineCheckpoint, readSafeCriticPipelineCheckpoint, writeCriticPipelineCheckpointAtomic, type CriticReviewPackageContext } from "../publisher/critic-pipeline-checkpoint.ts";
import { createConfiguredModelProvider, type ModelProvider } from "../runtime/model-provider.ts";
import { defaultProviderScopedDailyRequestBudget, ProviderScopedDailyRequestBudget, DailyRequestBudget, validateCostGuardConfig } from "../runtime/request-budget.ts";
import type { AgentExecutionResult, AgentLogger, AgentTelemetry, ModelConfig } from "../runtime/runtime-types.ts";
import { SupabaseAgentLogger } from "../runtime/agent-logger.ts";
import { freeProviderRouterEnabled, readGroqAtomicCapacityLimits } from "../runtime/free-provider-router.ts";
import { createSupabaseServerClient } from "../../supabase/server-client.ts";
import { Publisher } from "../publisher/publisher-agent.ts";
import { SupabasePublisherRepository } from "../publisher/supabase-publisher-repository.ts";
import type { PublisherValidationContext } from "../publisher/publisher-types.ts";
import { validatePublisherInputs } from "../publisher/publisher-validation.ts";
import { buildPublisherInputBoundary } from "./pipeline-boundaries.ts";
import type { PublisherRepository } from "../publisher/publisher-repository.ts";
import { attachHumanReviewId, buildHumanReviewSnapshot, writeHumanReviewArtifact, type HumanReviewGateway } from "../publisher/human-review.ts";
import { SupabaseHumanReviewRepository } from "../publisher/human-review-repository.ts";
import type { PipelineConfig, PipelineEventContext, PipelineQuota, PipelineRunContext, PipelineSourceMetadata, PipelineStage, PipelineStageOutcome, PipelineStages, GeoStageOutput } from "./pipeline-types.ts";
import { PipelineOrchestrator, createPipelineConfig } from "./pipeline-orchestrator.ts";
import { createLoggerPipelinePersistence } from "./pipeline-observability.ts";
import { createPersistentPipelineQuota } from "./pipeline-budget.ts";
import { SupabasePipelineEventAttemptRepository, type PipelineEventAttemptRegistry } from "./event-attempt-repository.ts";
import { SupabaseFactualRemediationRepository } from "./factual-remediation-repository.ts";
import type { FactualRemediationAttemptGuard } from "./factual-remediation.ts";
import { writeCapacityResumeSnapshot } from "./provider-capacity-resume.ts";

// Server-only composition root: client entrypoints are denied by ESLint and the
// privileged Supabase export also has a Next.js server-only boundary.

type Client = SupabaseClient<Database>;
type RankSignalsLike = { credibility: number; reach: number; momentum: number; sourceCount: number; contradictionPenalty: number; uncertaintyPenalty: number; geographicReachSignal: number; momentumAvailable: boolean };
type PublicationPayloadFactory = (context: PipelineEventContext) => PublicationPayload;

export type ProductionPipelineOptions = {
  supabase?: Client;
  logger?: AgentLogger;
  provider?: ModelProvider;
  registry?: ReferenceRegistry;
  quota?: PipelineQuota;
  requestBudget?: DailyRequestBudget | ProviderScopedDailyRequestBudget;
  attemptRegistry?: PipelineEventAttemptRegistry;
  factualRemediationAttemptGuard?: FactualRemediationAttemptGuard;
  publisherRepository?: PublisherRepository;
  publicationPayloadFactory?: PublicationPayloadFactory;
  checkpointRoot?: string;
  humanReviewArtifactRoot?: string;
  runId?: string;
  /** Internal ingestion switch. It never authorizes publication writes. */
  persistTraceability?: boolean;
  config?: Partial<PipelineConfig>;
  deterministic?: Pick<PipelineStages, "discovery" | "extraction" | "clustering">;
  agents?: { verifier?: VerifierAgent; translator?: TranslatorAgent; editor?: EditorAgent; classifier?: ClassifierAgent; ranker?: RankerAgent; critic?: CriticAgent };
  /** Optional construction observer for safe local diagnostics. */
  onConstructionStep?: (step: string) => void;
  /** Scheduler worker deadline guard, consulted before semantic provider calls. */
  shouldStartSemanticStage?: (stage: "verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic") => boolean;
};

export type ProductionAgentConfigs = { verifier: ModelConfig; translator: ModelConfig; editor: ModelConfig; classifier: ModelConfig; ranker: ModelConfig; critic: ModelConfig };
export type ProductionPipeline = { orchestrator: PipelineOrchestrator; stages: PipelineStages; configs: ProductionAgentConfigs; quota: PipelineQuota; preflight: () => Promise<ProductionPreflight> };
export type ProductionPreflight = { provider: string; quotaProvider: "groq"; models: Record<string, string>; maxRetries: Record<string, number>; dailyRequestLimit: number; maxOutputTokens: number; failOnRateLimit: boolean; allowPaidFallback: boolean; allowProviderPacingWait: boolean; supabaseConnected: boolean; quotaRemaining: number; requiredRequests: number; adapters: Record<string, "wired"> };

export function applyProductionModePolicy(configs: ProductionAgentConfigs, mode: PipelineConfig["mode"] = "standard"): ProductionAgentConfigs {
  if (mode !== "supervised") return configs;
  return Object.fromEntries(Object.entries(configs).map(([stage, config]) => [stage, { ...config, maxRetries: 0, allowPaidFallback: false, allowProviderPacingWait: false }])) as ProductionAgentConfigs;
}

function productionConfigs(mode: PipelineConfig["mode"] = "standard", step: (name: string, action: () => unknown) => unknown): ProductionAgentConfigs {
  const groqCapacity = step("provider.groq-capacity-limits", () => readGroqAtomicCapacityLimits()) as ReturnType<typeof readGroqAtomicCapacityLimits>;
  const withGroqCapacity = (config: ModelConfig): ModelConfig => ({ ...config, ...(groqCapacity ? { groqCapacity } : {}) });
  const zeroRetries = (config: ModelConfig): ModelConfig => ({ ...config, maxRetries: 0 });
  const configured = {
    verifier: withGroqCapacity(zeroRetries(step("provider.model-config.verifier", () => getVerifierModelConfig()) as ModelConfig)),
    translator: withGroqCapacity(zeroRetries(step("provider.model-config.translator", () => getTranslatorModelConfig()) as ModelConfig)),
    editor: withGroqCapacity(zeroRetries(step("provider.model-config.editor", () => getEditorModelConfig()) as ModelConfig)),
    classifier: withGroqCapacity(zeroRetries(step("provider.model-config.classifier", () => getClassifierModelConfig()) as ModelConfig)),
    ranker: withGroqCapacity(zeroRetries(step("provider.model-config.ranker", () => getRankerModelConfig()) as ModelConfig)),
    critic: withGroqCapacity(zeroRetries(step("provider.model-config.critic", () => getCriticModelConfig()) as ModelConfig)),
  };
  const configs = applyProductionModePolicy(configured, mode);
  for (const [stage, config] of Object.entries(configs)) step(`provider.cost-guard.${stage}`, () => validateCostGuardConfig(config));
  return configs;
}

function safePart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180); }
function checkpointPath(root: string, run: PipelineRunContext, stage: PipelineStage, eventKey: string): string { return join(root, safePart(run.runId), `${safePart(stage)}-${safePart(eventKey)}.json`); }
function stageRequests(result: AgentExecutionResult<unknown>): number { return result.providerRequestsUsed; }
function outcome<T extends { eventKey: string }>(result: AgentExecutionResult<T>, stage: PipelineStage, checkpoint?: () => Promise<{ path: string; written: boolean; readable: boolean; valid: boolean }>): PipelineStageOutcome<T> {
  const attempts = result.attempts;
  const provider = result.telemetry?.provider;
  return { output: result.output, eventKey: result.output.eventKey, agentVersion: result.agentVersion, model: result.model, ...(provider === "groq" || provider === "cerebras" || provider === "cloudflare_workers_ai" ? { provider } : {}), attempts, retries: Math.max(0, attempts - 1), providerRequestsUsed: stageRequests(result), latencyMs: result.latencyMs, telemetry: result.telemetry, checkpoint: checkpoint ? async () => { const value = await checkpoint(); return { stage, eventKey: result.output.eventKey, ...value }; } : undefined };
}

function sourceLanguage(context: PipelineEventContext): string { return context.items[0]?.language ?? "en"; }
function metadataString(item: ExtractedItem, key: string): string | null { const value = item.metadata[key]; return typeof value === "string" ? value : null; }
export function buildPipelineSourceMetadata(event: ClusteredEvent, items: ExtractedItem[], rawItemIds: ReadonlyMap<string, string | null> = new Map()): PipelineSourceMetadata[] {
  const byId = new Map(items.map((item) => [item.candidateId, item]));
  return event.sourceItems.map((sourceItem): PipelineSourceMetadata => { const item = byId.get(sourceItem.candidateId); if (!item) throw new Error(`Missing extracted item ${sourceItem.candidateId}`); return { sourceId: sourceItem.sourceId, sourceItemId: sourceItem.candidateId, rawItemId: rawItemIds.get(sourceItem.candidateId) ?? null, sourceName: sourceItem.sourceName, sourceUrl: item.canonicalUrl, sourceType: metadataString(item, "sourceType"), countryCode: metadataString(item, "sourceCountryCode"), language: item.language }; });
}
function translatorSources(context: PipelineEventContext) { const fallbackLanguage = sourceLanguage(context) as TranslatorInput["sourceLanguage"]; return context.sources.map(({ sourceId, sourceName, sourceItemId, language, sourceType, countryCode }) => ({ sourceId, sourceName, sourceItemId, language: language ?? fallbackLanguage, sourceType: sourceType ?? null, countryCode: countryCode ?? null })); }
function editorSources(context: PipelineEventContext) { return context.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: source.sourceUrl, sourceType: source.sourceType ?? "unknown" })); }
function rankEvent(context: PipelineEventContext) { const dates = context.event.sourceItems.map((item) => item.publishedAt).filter((date): date is string => Boolean(date)).sort(); return { eventKey: context.event.eventKey, canonicalTitle: context.event.canonicalTitle, sourceCount: new Set(context.event.sourceItems.map((item) => item.sourceId)).size, occurredAt: context.event.probableOccurredAt, latestPublishedAt: dates.at(-1) ?? null }; }
function requireContext<T>(value: T | undefined, name: string): T { if (!value) throw new Error(`PIPELINE_MISSING_${name.toUpperCase()}`); return value; }
function rankSignals(result: RankSignalsLike) { return { credibility: result.credibility, reach: result.reach, momentum: result.momentum, sourceCount: result.sourceCount, contradictionPenalty: result.contradictionPenalty, uncertaintyPenalty: result.uncertaintyPenalty, geographicReachSignal: result.geographicReachSignal }; }
function criticInput(context: PipelineEventContext, rankingCheckpoint: RankerPipelineCheckpoint["ranking"]) {
  if (context.criticInputOverride) return context.criticInputOverride;
  const event = rankEvent(context);
  return buildCriticInput({ event, verification: requireContext(context.verification, "verification"), translation: requireContext(context.translation, "translation"), editorial: requireContext(context.editorial, "editorial"), classification: requireContext(context.classification, "classification"), ranking: rankingCheckpoint, sources: translatorSources(context), sourceEvidence: buildCriticSourceEvidence(context.sources, context.items), geo: { latitude: context.geo?.latitude ?? null, longitude: context.geo?.longitude ?? null, resolutionLevel: context.geo?.resolutionLevel ?? "unresolved", resolvedFrom: context.geo?.resolvedFrom ?? null } });
}

function settledReviewAccounting(telemetry: AgentTelemetry | undefined): CriticReviewPackageContext["providerAccounting"]["critic"] {
  if (!telemetry || telemetry.status !== "SUCCESS" || !["groq", "cerebras", "cloudflare_workers_ai"].includes(telemetry.provider)
    || telemetry.providerRequestDispatched !== true || telemetry.providerRequestsUsed < 1 || telemetry.providerRequestsUsed !== telemetry.attempts || telemetry.retries !== 0
    || telemetry.providerUnitUsageKnown !== true || !Number.isSafeInteger(telemetry.actualProviderUnitUsage) || (telemetry.actualProviderUnitUsage ?? 0) < 1) {
    throw new Error("CRITIC_REVIEW_PROVIDER_USAGE_UNSETTLED");
  }
  if (telemetry.provider === "groq" && (telemetry.providerUnit !== "tokens" || telemetry.totalTokens === null
    || telemetry.inputTokens === null || telemetry.outputTokens === null
    || telemetry.inputTokens + telemetry.outputTokens !== telemetry.totalTokens
    || telemetry.actualProviderUnitUsage !== telemetry.totalTokens)) throw new Error("CRITIC_REVIEW_PROVIDER_USAGE_UNSETTLED");
  if (telemetry.provider === "cloudflare_workers_ai" && telemetry.providerUnit !== "neurons") throw new Error("CRITIC_REVIEW_PROVIDER_USAGE_UNSETTLED");
  if (telemetry.provider === "cerebras" && (telemetry.inputTokens === null || telemetry.outputTokens === null || telemetry.totalTokens === null
    || telemetry.inputTokens + telemetry.outputTokens > telemetry.totalTokens)) throw new Error("CRITIC_REVIEW_PROVIDER_USAGE_UNSETTLED");
  return {
    provider: telemetry.provider as CriticReviewPackageContext["providerAccounting"]["critic"]["provider"],
    model: telemetry.model,
    requestCount: telemetry.providerRequestsUsed,
    attempts: telemetry.attempts,
    retries: telemetry.retries,
    providerRequestDispatched: true,
    providerUnit: telemetry.providerUnit ?? null,
    providerUnitUsageKnown: true,
    actualProviderUnitUsage: telemetry.actualProviderUnitUsage!,
    inputTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    totalTokens: telemetry.totalTokens,
    settlement: "SETTLED",
  };
}

function durableCriticReviewContext(context: PipelineEventContext, criticTelemetry: AgentTelemetry | undefined): CriticReviewPackageContext {
  const byCandidate = new Map(context.items.map((item) => [item.candidateId, item]));
  const publishedByCandidate = new Map(context.event.sourceItems.map((item) => [item.candidateId, item.publishedAt]));
  const sourceLineage = context.sources.map((source) => {
    const item = byCandidate.get(source.sourceItemId);
    if (!item || !source.rawItemId) throw new Error("CRITIC_REVIEW_SOURCE_LINEAGE_INCOMPLETE");
    return {
      sourceId: source.sourceId,
      sourceItemId: source.sourceItemId,
      rawItemId: source.rawItemId,
      sourceName: source.sourceName,
      contentHash: item.contentHash,
      canonicalUrl: item.canonicalUrl,
      publishedAt: publishedByCandidate.get(source.sourceItemId) ?? null,
    };
  });
  const accounting = context.providerAccounting ?? {};
  return {
    canonicalEvent: context.event,
    sourceLineage,
    providerAccounting: {
      verifier: settledReviewAccounting(accounting.verifier),
      translator: settledReviewAccounting(accounting.translator),
      editor: settledReviewAccounting(accounting.editor),
      classifier: settledReviewAccounting(accounting.classifier),
      ranker: settledReviewAccounting(accounting.ranker),
      critic: settledReviewAccounting(criticTelemetry),
    },
  };
}

function checkpointRoot(root?: string): string { return root ?? "artifacts/pipeline-checkpoints"; }

export function createProductionPipeline(options: ProductionPipelineOptions = {}): ProductionPipeline {
  const step = <T>(name: string, action: () => T): T => { options.onConstructionStep?.(name); return action(); };
  if (step("provider-router.guard", () => freeProviderRouterEnabled())) throw new Error("FREE_PROVIDER_ROUTER_NOT_ACTIVATED_IN_PRODUCTION");
  const supabase = step("supabase.client", () => options.supabase ?? createSupabaseServerClient());
  const logger = step("runtime.agent-logger", () => options.logger ?? new SupabaseAgentLogger(supabase));
  const provider = step("provider.client", () => options.provider ?? createConfiguredModelProvider());
  const configs = productionConfigs(options.config?.mode, step);
  const requestBudget = step("provider.request-budget", () => options.requestBudget ?? defaultProviderScopedDailyRequestBudget);
  const quota = step("pipeline.quota", () => options.quota ?? createPersistentPipelineQuota(logger, { dailyLimit: configs.verifier.dailyRequestLimit }));
  const root = step("pipeline.checkpoint-root", () => checkpointRoot(options.checkpointRoot));
  const verifier = step("agent.verifier", () => options.agents?.verifier ?? new VerifierAgent(provider, logger));
  const translator = step("agent.translator", () => options.agents?.translator ?? new TranslatorAgent(provider, logger));
  const editor = step("agent.editor", () => options.agents?.editor ?? new EditorAgent(provider, logger));
  const classifier = step("agent.classifier", () => options.agents?.classifier ?? new ClassifierAgent(provider, logger));
  const ranker = step("agent.ranker", () => options.agents?.ranker ?? new RankerAgent(provider, logger));
  const critic = step("agent.critic", () => options.agents?.critic ?? new CriticAgent(provider, logger));
  const attemptRegistry = step("repository.event-attempt-registry", () => options.attemptRegistry ?? (typeof (supabase as unknown as { rpc?: unknown }).rpc === "function" ? new SupabasePipelineEventAttemptRepository(supabase) : undefined));
  const factualRemediationAttemptGuard = step("repository.factual-remediation", () => options.factualRemediationAttemptGuard ?? new SupabaseFactualRemediationRepository(supabase));
  const humanReviewRepository = step("repository.human-review", () => new SupabaseHumanReviewRepository(supabase));
  const humanReviewGateway: HumanReviewGateway = {
    async createReview(input) {
      if (!options.publicationPayloadFactory) throw new Error("PIPELINE_PUBLICATION_MATERIALIZER_REQUIRED");
      if (input.context.eventAttemptId && input.context.eventAttemptId !== input.attemptId) throw new Error("HUMAN_REVIEW_ATTEMPT_CONTEXT_MISMATCH");
      const criticCheckpoint = input.checkpoints.critic;
      if (!criticCheckpoint?.path || criticCheckpoint.stage !== "critic" || criticCheckpoint.eventKey !== input.context.event.eventKey
        || !criticCheckpoint.written || !criticCheckpoint.readable || !criticCheckpoint.valid) throw new Error("HUMAN_REVIEW_CHECKPOINT_INVALID:critic");
      const criticPath = resolve(criticCheckpoint.path);
      const criticRelativePath = relative(resolve(root), criticPath);
      if (criticRelativePath === "" || criticRelativePath === ".." || criticRelativePath.startsWith(`..${sep}`) || isAbsolute(criticRelativePath)) {
        throw new Error("HUMAN_REVIEW_CHECKPOINT_OUTSIDE_ROOT:critic");
      }
      const durableCritic = await readSafeCriticPipelineCheckpoint(criticPath);
      if (durableCritic.eventKey !== input.context.event.eventKey || durableCritic.attemptId !== input.attemptId || durableCritic.critic.decision !== "pass") {
        throw new Error("HUMAN_REVIEW_DURABLE_CRITIC_PASS_NOT_PROVEN");
      }
      const reviewContext: PipelineEventContext = { ...input.context, eventAttemptId: input.attemptId, critic: durableCritic.critic };
      const payload = options.publicationPayloadFactory(reviewContext);
      const lineage = { eventKey: reviewContext.event.eventKey, verificationEventKey: reviewContext.event.eventKey, translationEventKey: reviewContext.event.eventKey, editorialEventKey: reviewContext.event.eventKey, classificationEventKey: reviewContext.event.eventKey, rankingEventKey: reviewContext.event.eventKey, criticEventKey: reviewContext.event.eventKey };
      const validationContext: PublisherValidationContext = { translation: requireContext(reviewContext.translation, "translation"), editorSources: editorSources(reviewContext) };
      validatePublisherInputs(buildPublisherInputBoundary({ payload, lineage, validationContext }));
      const sourceIds = [...new Set(reviewContext.sources.map((source) => source.sourceId))];
      const sourcesResponse = await supabase.from("sources").select("id,url").in("id", sourceIds);
      if (sourcesResponse.error) throw new Error("HUMAN_REVIEW_SOURCE_REGISTRY_READ_FAILED");
      const sourceRegistryUrls = new Map((sourcesResponse.data ?? []).map((source) => [source.id, source.url]));
      const snapshot = await buildHumanReviewSnapshot({
        context: reviewContext,
        run: input.run,
        attemptId: input.attemptId,
        checkpoints: input.checkpoints,
        providerAccounting: input.providerAccounting,
        publicationPayload: payload,
        sourceRegistryUrls,
        checkpointRoot: root,
      });
      const artifactRoot = options.humanReviewArtifactRoot ?? "artifacts/human-review-packages";
      await writeHumanReviewArtifact(artifactRoot, snapshot.artifact);
      const created = await humanReviewRepository.create(snapshot);
      if (created.status !== "WAITING_FOR_HUMAN_REVIEW") throw new Error("HUMAN_REVIEW_CREATE_NOT_WAITING");
      const artifact = attachHumanReviewId(snapshot.artifact, created.reviewId);
      await writeHumanReviewArtifact(artifactRoot, artifact);
      return { reviewId: created.reviewId, packageSha256: snapshot.manifest.packageSha256 };
    },
  };
  let registryPromise: Promise<ReferenceRegistry> | null = step("classifier.reference-registry-promise", () => options.registry ? Promise.resolve(options.registry) : null);
  const rankingByEvent = new Map<string, RankerPipelineCheckpoint["ranking"]>();
  const registry = async () => { registryPromise ??= loadActiveReferenceRegistry(supabase); return registryPromise; };

  const stages: PipelineStages = step("pipeline.stage-wiring", () => ({
    async discovery(input) { return options.deterministic?.discovery ? options.deterministic.discovery(input) : runDiscovery({ hours: input.config.hours, persist: options.persistTraceability === true, now: new Date(input.run.startedAt), supabase }); },
    async extraction(input): Promise<ExtractionRunResult> {
      if (options.deterministic?.extraction) return options.deterministic.extraction(input);
      const { config, discovery } = input;
      const startedAt = new Date().toISOString(); const results: ExtractionResult[] = [];
      for (const candidate of discovery.candidates) results.push(await extractCandidate(candidate));
      const completed = results.filter((result) => result.item !== null);
      let persisted = 0;
      let persistUpdated = 0;
      let persistSkipped = 0;
      let persistErrors = 0;
      let traceability: ExtractionRunResult["traceability"] = [];
      if (options.persistTraceability === true) ({ persisted, persistUpdated, persistSkipped, persistErrors, traceability } = await persistExtractionResults(supabase, results));
      return applyExtractionFreshness({ startedAt, finishedAt: new Date().toISOString(), hours: config.hours, limit: discovery.candidates.length, candidatesSelected: discovery.candidates.length, results, full: results.filter((r) => r.quality === "full").length, partial: results.filter((r) => r.quality === "partial").length, metadataOnly: results.filter((r) => r.quality === "metadata_only").length, blocked: results.filter((r) => r.status === "blocked").length, failed: results.filter((r) => r.status === "failed").length, averageContentLength: completed.length ? Math.round(completed.reduce((sum, r) => sum + r.contentLength, 0) / completed.length) : 0, persisted, persistUpdated, persistSkipped, persistErrors, traceability }, new Date(input.run.startedAt), config.hours);
    },
    async clustering(input): Promise<ClusterRunResult> {
      if (options.deterministic?.clustering) return options.deterministic.clustering(input);
      const { extraction } = input;
      const items = freshExtractionResults(extraction).flatMap((result) => result.item ? [result.item] : []); const clustered = clusterExtractedItems(items);
      const sourceCount = (event: ClusteredEvent) => new Set(event.sourceItems.map((item) => item.sourceId)).size;
      const persistedEvents = 0;
      const persistedEventSources = 0;
      const persistSkipped = 0;
      const persistErrors = 0;
      // Fase 10F-A.2 deliberately persists only ingestion lineage. Editorial
      // event/event_sources writes belong to the later publication transaction.
      return { extractedItems: items.length, duplicatesRemoved: clustered.duplicatesRemoved, events: clustered.events, multiSourceEvents: clustered.events.filter((e) => sourceCount(e) > 1).length, singleSourceEvents: clustered.events.filter((e) => sourceCount(e) === 1).length, largestCluster: Math.max(0, ...clustered.events.map(sourceCount)), needsReview: clustered.needsReview, possibleFalseMerges: clustered.possibleFalseMerges, report: clustered.report, persistedEvents, persistedEventSources, persistSkipped, persistErrors };
    },
    sourceMetadata(event, items, rawItemIds) {
      return buildPipelineSourceMetadata(event, items, rawItemIds);
    },
    async verifier(context, run) { const input: VerifierInput = { event: context.event, items: context.items, sources: context.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, sourceUrl: source.sourceUrl, sourceType: source.sourceType, countryCode: source.countryCode, language: source.language })) }; const result = await verifier.verify(input, { dryRun: run.dryRun, modelConfig: configs.verifier, requestBudget, pipelineRunId: run.runId }); const path = checkpointPath(root, run, "verifier", context.event.eventKey); const checkpoint: TranslatorCheckpoint = { schemaVersion: 1, eventKey: context.event.eventKey, event: context.event, verification: result.output, sourceLanguage: sourceLanguage(context) as TranslatorCheckpoint["sourceLanguage"], sources: translatorSources(context), translatorModelInput: buildTranslatorModelInput({ schemaVersion: 1, event: context.event, verification: result.output, sourceLanguage: sourceLanguage(context) as TranslatorInput["sourceLanguage"], sources: translatorSources(context) }).input }; return outcome(result, "verifier", async () => { await writeTranslatorCheckpointAtomic(checkpoint, path); const read = await readSafeTranslatorCheckpoint(path); return { path, written: true, readable: true, valid: read.eventKey === context.event.eventKey }; }); },
    async translator(context, run) { const input: TranslatorInput = { schemaVersion: 1, event: context.event, verification: requireContext(context.verification, "verification"), sourceLanguage: sourceLanguage(context) as TranslatorInput["sourceLanguage"], sources: translatorSources(context) }; const result = await translator.translate(input, { dryRun: run.dryRun, modelConfig: configs.translator, requestBudget, pipelineRunId: run.runId }); const path = checkpointPath(root, run, "translator", context.event.eventKey); const modelInput: TranslatorModelInput = buildTranslatorModelInput(input).input; const checkpoint: TranslatorCheckpoint = { schemaVersion: 1, eventKey: input.event.eventKey, event: input.event, verification: input.verification, translationResult: result.output, sourceLanguage: input.sourceLanguage, sources: input.sources, translatorModelInput: modelInput }; return outcome(result, "translator", async () => { await writeTranslatorCheckpointAtomic(checkpoint, path); const read = await readSafeTranslatorCheckpoint(path); return { path, written: true, readable: true, valid: read.eventKey === input.event.eventKey && read.translationResult?.eventKey === input.event.eventKey }; }); },
    async editor(context, run) { const translation = requireContext(context.translation, "translation"); const verification = requireContext(context.verification, "verification"); const input: EditorInput = buildEditorInput({ event: { eventKey: context.event.eventKey, canonicalTitle: context.event.canonicalTitle }, verification, translation, sources: editorSources(context) }); const result = await editor.edit(input, { dryRun: run.dryRun, modelConfig: configs.editor, requestBudget, pipelineRunId: run.runId }); const path = checkpointPath(root, run, "editor", context.event.eventKey); const checkpoint: TranslatorEditorCheckpoint = { schemaVersion: 1, eventKey: context.event.eventKey, canonicalTitle: context.event.canonicalTitle, event: context.event, verification, translation, editorial: result.output, sources: input.sources }; return outcome(result, "editor", async () => { await writeTranslatorEditorCheckpointAtomic(checkpoint, path); const read = await readSafeTranslatorEditorCheckpoint(path); return { path, written: true, readable: true, valid: read.eventKey === context.event.eventKey && read.editorial?.eventKey === context.event.eventKey }; }); },
    async classifier(context, run) { const verification = requireContext(context.verification, "verification"); const translation = requireContext(context.translation, "translation"); const editorial = requireContext(context.editorial, "editorial"); const input = buildClassifierInput({ event: { eventKey: context.event.eventKey, canonicalTitle: context.event.canonicalTitle }, verification, translation, editorial, sources: context.sources.map(({ sourceName, sourceType, countryCode }) => ({ sourceName, sourceType: sourceType ?? null, countryCode: countryCode ?? null })) }); const result = await classifier.classify(input, { dryRun: run.dryRun, modelConfig: configs.classifier, requestBudget, registry: await registry(), pipelineRunId: run.runId }); const path = checkpointPath(root, run, "classifier", context.event.eventKey); const checkpoint: ClassifierPipelineCheckpoint = { schemaVersion: 1, eventKey: context.event.eventKey, canonicalTitle: context.event.canonicalTitle, event: rankEvent(context), verification, translation: { schemaVersion: 1, eventKey: context.event.eventKey, sourceLanguage: sourceLanguage(context) as TranslationResult["sourceLanguage"], targetLanguage: "es", translatedTitle: input.translation.translatedTitle, translatedFacts: translation.translatedFacts, preservedNames: input.translation.preservedNames, translationNotes: translation.translationNotes }, editorial: { schemaVersion: 1, eventKey: context.event.eventKey, headlineEs: input.editorial.headlineEs, summaryEs: input.editorial.summaryEs, whyItMattersEs: editorial.whyItMattersEs, keyPoints: input.editorial.keyPoints }, classification: result.output, sources: translatorSources(context), createdAt: new Date().toISOString() }; return outcome(result, "classifier", async () => { await writeClassifierPipelineCheckpointAtomic(checkpoint, path); const read = await readSafeClassifierPipelineCheckpoint(path); return { path, written: true, readable: true, valid: read.eventKey === context.event.eventKey }; }); },
    async geo(context) { const classification = requireContext(context.classification, "classification"); const resolved = resolveGeo({ regionCode: classification.primaryRegionCode }, await registry()); const output: GeoStageOutput = { eventKey: context.event.eventKey, primaryRegionCode: classification.primaryRegionCode, countryCodes: classification.countryCodes, latitude: resolved.latitude, longitude: resolved.longitude, resolutionLevel: resolved.resolutionLevel, resolvedFrom: resolved.resolvedFrom, provenance: resolved.resolvedFrom ? "reference_registry" : "unresolved" }; return { output, eventKey: output.eventKey, agentVersion: "geo-resolver-v1", model: "deterministic", attempts: 0, retries: 0, providerRequestsUsed: 0, latencyMs: 0 }; },
    async ranker(context, run) { const translation = requireContext(context.translation, "translation"); const editorial = requireContext(context.editorial, "editorial"); const classification = requireContext(context.classification, "classification"); const verification = requireContext(context.verification, "verification"); const input = buildRankerPipelineInput({ event: rankEvent(context), verification, translation, editorial, classification }); const result = await ranker.rank(input, { dryRun: run.dryRun, modelConfig: configs.ranker, requestBudget, pipelineRunId: run.runId }); const path = checkpointPath(root, run, "ranker", context.event.eventKey); const ranking = { result: result.output, formulaVersion: result.formulaVersion, momentumAvailable: result.signals.momentumAvailable, deterministicSignals: rankSignals(result.signals) }; rankingByEvent.set(context.event.eventKey, ranking); const fullInput = criticInput(context, ranking); context.criticInputOverride = fullInput; const checkpoint = buildRankerPipelineCheckpoint(fullInput, ranking); return outcome(result, "ranker", async () => { await writeRankerPipelineCheckpointAtomic(checkpoint, path); const read = await readSafeRankerPipelineCheckpoint(path); return { path, written: true, readable: true, valid: read.eventKey === context.event.eventKey }; }); },
    async critic(context, run) { const ranking = requireContext(context.ranking, "ranking"); const rankingCheckpoint = rankingByEvent.get(context.event.eventKey) ?? { result: ranking, formulaVersion: "ranker-v1", momentumAvailable: false, deterministicSignals: { credibility: ranking.credibility, reach: ranking.reach, momentum: ranking.momentum, sourceCount: context.sources.length, contradictionPenalty: 0, uncertaintyPenalty: 0, geographicReachSignal: 0 } }; const input = criticInput(context, rankingCheckpoint); const criticAttemptId = context.eventAttemptId ?? context.factualRemediationTarget?.attemptId; const result = await critic.critique(input, { dryRun: run.dryRun, modelConfig: configs.critic, requestBudget, registry: await registry(), pipelineRunId: run.runId, ...(criticAttemptId ? { attemptId: criticAttemptId } : {}) }); const path = checkpointPath(root, run, "critic", context.event.eventKey); const rankCheckpoint = buildRankerPipelineCheckpoint(input, rankingCheckpoint); const reviewContext = options.config?.mode === "supervised" ? durableCriticReviewContext(context, result.telemetry) : undefined; const checkpoint = buildCriticPipelineCheckpoint(rankCheckpoint, result.output, new Date().toISOString(), reviewContext, criticAttemptId); return outcome(result, "critic", async () => { await writeCriticPipelineCheckpointAtomic(checkpoint, path); const read = await readSafeCriticPipelineCheckpoint(path); return { path, written: true, readable: true, valid: read.eventKey === context.event.eventKey && (options.config?.mode !== "supervised" || Boolean(read.reviewPackageContext)) && (!criticAttemptId || read.attemptId === criticAttemptId) }; }); },
    async publisher(context, _run, publishOptions) { const factory = options.publicationPayloadFactory; if (!factory) throw new Error("PIPELINE_PUBLICATION_MATERIALIZER_REQUIRED"); const generatedPayload = factory(context); const remediationTarget = context.factualRemediationTarget; if (remediationTarget && generatedPayload.eventKey !== context.event.eventKey) throw new Error("FACTUAL_REMEDIATION_PUBLICATION_EVENT_MISMATCH"); const actualPayload = remediationTarget ? { ...generatedPayload, article: { ...generatedPayload.article, slug: remediationTarget.articleSlug } } : generatedPayload; const repository = options.publisherRepository ?? new SupabasePublisherRepository(supabase); const publisher = new Publisher(repository); const lineage = { eventKey: context.event.eventKey, verificationEventKey: context.event.eventKey, translationEventKey: context.event.eventKey, editorialEventKey: context.event.eventKey, classificationEventKey: context.event.eventKey, rankingEventKey: context.event.eventKey, criticEventKey: context.event.eventKey }; const validationContext: PublisherValidationContext = { translation: requireContext(context.translation, "translation"), editorSources: editorSources(context) }; const input = buildPublisherInputBoundary({ payload: actualPayload, lineage, validationContext }); const result = await publisher.publish(input, { dryRun: publishOptions.dryRun, ...(remediationTarget ? { factualRemediation: remediationTarget } : {}) }); return { output: result, eventKey: context.event.eventKey, agentVersion: "publisher-v1", model: "deterministic", attempts: 0, retries: 0, providerRequestsUsed: 0, latencyMs: 0 }; },
  }));
  const pipelineConfig = step("pipeline.config", () => createPipelineConfig(options.config));
  const orchestrator = step("pipeline.orchestrator", () => new PipelineOrchestrator({ stages, quota, attemptRegistry, factualRemediationAttemptGuard, humanReviewGateway, capacityResumeSnapshotWriter: async (snapshot) => writeCapacityResumeSnapshot(snapshot, join(root, safePart(snapshot.pipelineRunId), `capacity-resume-${safePart(snapshot.eventKey)}-${snapshot.resumeStage}-g${snapshot.resumeGeneration}.json`)), shouldStartSemanticStage: options.shouldStartSemanticStage, config: pipelineConfig, persistence: pipelineConfig.mode === "supervised" ? createLoggerPipelinePersistence(logger) : undefined, runId: options.runId, agentVersions: { verifier: verifierAgentVersion, translator: translatorAgentVersion, editor: editorAgentVersion, classifier: classifierAgentVersion, ranker: rankerAgentVersion, critic: criticAgentVersion, publisher: "publisher-v1" } }));
  const preflight = step("pipeline.preflight-function", () => async (): Promise<ProductionPreflight> => { const response = await supabase.from("regions").select("id").limit(1); if (response.error) throw new Error("Supabase preflight connection failed", { cause: response.error }); const remaining = await quota.remaining(); return { provider: process.env.AGENT_PROVIDER?.trim() ?? "", quotaProvider: quota.provider ?? "groq", models: Object.fromEntries(Object.entries(configs).map(([key, value]) => [key, value.model])), maxRetries: Object.fromEntries(Object.entries(configs).map(([key, value]) => [key, value.maxRetries])), dailyRequestLimit: configs.verifier.dailyRequestLimit, maxOutputTokens: configs.verifier.maxOutputTokens, failOnRateLimit: configs.verifier.failOnRateLimit, allowPaidFallback: configs.verifier.allowPaidFallback, allowProviderPacingWait: configs.verifier.allowProviderPacingWait !== false, supabaseConnected: true, quotaRemaining: remaining, requiredRequests: 6, adapters: { discovery: "wired", extraction: "wired", clustering: "wired", verifier: "wired", translator: "wired", editor: "wired", classifier: "wired", geo: "wired", ranker: "wired", critic: "wired", publisher: "wired" } }; });
  return step("pipeline.return", () => ({ orchestrator, stages, configs, quota, preflight }));
}

export async function removeProductionCheckpointRun(root: string, runId: string): Promise<void> { await rm(join(root, safePart(runId)), { recursive: true, force: true }); }

// Kept as a small, typed fixture factory for wiring tests; production publication still requires explicit materialization.
export function fixturePublicationPayload(eventKey: string): PublicationPayload { return { ...structuredClone(validFixtures.PublicationPayload), eventKey, verification: { ...validFixtures.PublicationPayload.verification, eventKey }, critic: { ...validFixtures.PublicationPayload.critic, eventKey } }; }
