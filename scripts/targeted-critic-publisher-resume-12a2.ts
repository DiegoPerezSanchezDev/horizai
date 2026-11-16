import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { readSafeTranslatorCheckpoint } from "../lib/agents/translator/translator-checkpoint.ts";
import { readSafeTranslatorEditorCheckpoint } from "../lib/agents/editor/translator-editor-checkpoint.ts";
import { readSafeClassifierPipelineCheckpoint } from "../lib/agents/classifier/classifier-pipeline-checkpoint.ts";
import { readSafeRankerPipelineCheckpoint, type RankerPipelineCheckpoint } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";
import { buildCriticPipelineCheckpoint, readSafeCriticPipelineCheckpoint, writeCriticPipelineCheckpointAtomic } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { loadActiveReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { projectClassificationGeo } from "../lib/agents/classifier/geo-resolver.ts";
import { CriticAgent, criticAgentVersion, criticSystemInstructions, getCriticModelConfig } from "../lib/agents/critic/critic-agent.ts";
import { buildCriticModelInput } from "../lib/agents/critic/critic-input.ts";
import { criticInputSchema, criticCurrentGenerationSchema, type CriticInput } from "../lib/agents/critic/critic-types.ts";
import { resolveCriticGeneration } from "../lib/agents/critic/critic-evidence-catalog.ts";
import { runCriticPrechecks } from "../lib/agents/critic/critic-prechecks.ts";
import { rankerFormulaVersion } from "../lib/agents/ranker/ranker-prompt.ts";
import { calculateGuardedImportanceScore } from "../lib/agents/ranker/rank-score.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { DailyRequestBudget, validateCostGuardConfig } from "../lib/agents/runtime/request-budget.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { readGroqAtomicCapacityLimits, freeProviderRouterEnabled } from "../lib/agents/runtime/free-provider-router.ts";
import { decideGroqTpmPacing, estimateGroqStageTokenRequirement } from "../lib/agents/runtime/groq-capacity-pacing.ts";
import { toStrictProviderJsonSchema } from "../lib/agents/runtime/strict-json-schema.ts";
import { errorSummary, getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { attemptOutcomeFromPipelineResult, evaluateNormalEligibility } from "../lib/agents/pipeline/event-attempt-policy.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { buildPublisherInputBoundary } from "../lib/agents/pipeline/pipeline-boundaries.ts";
import { buildPublicationScores } from "../lib/agents/publisher/publication-payload.ts";
import { publicationPayloadSchema, type CriticResult } from "../lib/agents/contracts/index.ts";
import { validatePublisherInputs } from "../lib/agents/publisher/publisher-validation.ts";
import { validateRealPublicationReadiness } from "../lib/agents/publisher/publication-readiness.ts";
import { SupabasePublisherRepository } from "../lib/agents/publisher/supabase-publisher-repository.ts";
import { Publisher } from "../lib/agents/publisher/publisher-agent.ts";
import type { PublisherInput } from "../lib/agents/publisher/publisher-types.ts";
import type { Tables } from "../types/database.ts";
import { isDeepStrictEqual } from "node:util";

const eventKey = "event-cbbf85234317a442f59ece63ef1b40c8";
const priorPipelineRunId = "ce894b55-5c50-44dc-87db-58bcbf09834b";
const cooldownUntil = "2026-09-29T00:00:00Z";
const checkpointRoot = resolve("artifacts/pipeline-checkpoints", priorPipelineRunId);
const artifactPath = resolve("artifacts/targeted-critic-publisher-resume-12a2.json");
const modelName = "openai/gpt-oss-20b";
const expectedStages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
type AttemptRow = Tables<"pipeline_event_attempts">;
type RawItemRow = Pick<Tables<"raw_items">, "id" | "source_id" | "canonical_url" | "published_at" | "processing_status" | "extraction_quality">;
type JsonObject = Record<string, unknown>;

function fail(code: string): never { throw new Error(code); }
function object(value: unknown): JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function sha256(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function normalizeAttempt(row: AttemptRow) {
  return { id: row.id, eventKey: row.event_key, pipelineRunId: row.pipeline_run_id, attemptNumber: row.attempt_number, startedAt: row.started_at, completedAt: row.completed_at, finalState: row.final_state, stopStage: row.stop_stage, stopReason: row.stop_reason, retryClass: row.retry_class, countsTowardRetryLimit: row.counts_toward_retry_limit, nextEligibleAt: row.next_eligible_at, createdAt: row.created_at };
}
function criticInput(checkpoint: RankerPipelineCheckpoint): CriticInput {
  return { schemaVersion: 1, event: checkpoint.event, verification: checkpoint.verification, translation: checkpoint.translation, editorial: checkpoint.editorial, classification: checkpoint.classification, ranking: checkpoint.ranking, sources: checkpoint.sources, sourceEvidence: checkpoint.sourceEvidence, geo: checkpoint.geo };
}
function changedPaths(left: unknown, right: unknown, path = ""): string[] {
  if (isDeepStrictEqual(left, right)) return [];
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) => changedPaths((left as JsonObject)[key], (right as JsonObject)[key], path ? `${path}.${key}` : key));
  }
  return [path || "<root>"];
}
function withoutClassificationCoordinates(value: unknown): unknown {
  const copy = structuredClone(value) as JsonObject;
  const classification = object(copy.classification);
  delete classification.latitude;
  delete classification.longitude;
  return { ...copy, classification };
}
function rankingValid(checkpoint: RankerPipelineCheckpoint): boolean {
  const result = checkpoint.ranking.result;
  const expected = calculateGuardedImportanceScore(checkpoint.verification.status, {
    impact: result.impact, novelty: result.novelty, reach: result.reach,
    credibility: result.credibility, economicImpact: result.economicImpact, momentum: result.momentum,
  });
  return checkpoint.ranking.formulaVersion === rankerFormulaVersion && result.importanceScore === expected;
}

type SourceAssociation = { sourceItemId: string; sourceId: string; sourceName: string; sourceType: string | null; countryCode: string | null; canonicalUrl: string; rawItem: RawItemRow };

function makePublisherInput(checkpoint: RankerPipelineCheckpoint, sourceRows: SourceAssociation[], critic: CriticResult): PublisherInput {
  const bySourceItem = new Map(sourceRows.map((source) => [source.sourceItemId, source]));
  const payload = publicationPayloadSchema.parse({
    schemaVersion: 1,
    eventKey,
    event: {
      canonicalTitle: checkpoint.event.canonicalTitle,
      probableOccurredAt: checkpoint.event.occurredAt,
      probableCountryCode: checkpoint.classification.countryCodes[0] ?? null,
      probableRegionCode: checkpoint.classification.primaryRegionCode,
    },
    article: {
      slug: checkpoint.editorial.suggestedSlug,
      headlineEs: checkpoint.editorial.headlineEs,
      dekEs: checkpoint.editorial.dekEs,
      summaryEs: checkpoint.editorial.summaryEs,
      whyItMattersEs: checkpoint.editorial.whyItMattersEs,
      bodyEs: checkpoint.editorial.bodyEs,
      keyPoints: checkpoint.editorial.keyPoints,
    },
    sources: checkpoint.sources.map((source) => {
      const resolved = bySourceItem.get(source.sourceItemId);
      if (!resolved) fail("PUBLISHER_SOURCE_CHECKPOINT_MISMATCH");
      return { sourceId: source.sourceId, rawItemId: resolved.rawItem.id, sourceName: source.sourceName, url: resolved.canonicalUrl, isPrimary: source.sourceId === checkpoint.verification.primarySourceId, publishedAt: resolved.rawItem.published_at };
    }),
    categories: checkpoint.classification.categorySlugs.map((categorySlug, index) => ({ categorySlug, isPrimary: index === 0, confidenceScore: 100 })),
    entities: [
      ...checkpoint.classification.companies.map((canonicalName) => ({ entityType: "organization" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...checkpoint.classification.models.map((canonicalName) => ({ entityType: "model" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...checkpoint.classification.people.map((canonicalName) => ({ entityType: "person" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...checkpoint.classification.technologies.map((canonicalName) => ({ entityType: "product" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
    ],
    region: { code: checkpoint.classification.primaryRegionCode, latitude: checkpoint.geo.latitude, longitude: checkpoint.geo.longitude },
    scores: buildPublicationScores(checkpoint.ranking.result),
    verification: checkpoint.verification,
    critic,
  });
  const lineage = { eventKey, verificationEventKey: eventKey, translationEventKey: eventKey, editorialEventKey: eventKey, classificationEventKey: eventKey, rankingEventKey: eventKey, criticEventKey: eventKey };
  const validationContext = {
    translation: checkpoint.translation,
    editorSources: checkpoint.sources.map((source) => {
      const resolved = bySourceItem.get(source.sourceItemId);
      if (!resolved) fail("PUBLISHER_SOURCE_CHECKPOINT_MISMATCH");
      return { sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: resolved.canonicalUrl, sourceType: resolved.sourceType ?? "unknown" };
    }),
  };
  return buildPublisherInputBoundary({ payload, lineage, validationContext });
}

function reservationDetails(value: unknown): JsonObject {
  const payload = object(value);
  return Object.keys(object(payload.details)).length > 0 ? object(payload.details) : payload;
}
function reservationDispatched(value: unknown): boolean {
  const payload = object(value); const details = reservationDetails(value);
  return payload.providerRequestDispatched === true || details.providerRequestDispatched === true;
}
function reservationTokenState(value: unknown): string | null {
  const payload = object(value); const details = reservationDetails(value);
  const state = payload.tokenUsageState ?? details.tokenUsageState;
  return typeof state === "string" ? state : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--preflight-only", "--execute"].includes(args[0]!)) fail("EXPECTED_PRECISELY_ONE_MODE_FLAG");
  if (existsSync(artifactPath) && args[0] === "--execute") fail("12A2_ARTIFACT_ALREADY_EXISTS_PRESERVE_EXISTING");
  const execute = args[0] === "--execute";
  const startedAt = new Date();
  const startedAtUtc = startedAt.toISOString();
  const requestDateUtc = startedAtUtc.slice(0, 10);
  const resumePipelineRunId = randomUUID();
  const report: JsonObject = {
    phase: "12A.2",
    eventKey,
    startedAtUtc,
    resumePipelineRunId,
    cooldownState: { requiredUntil: cooldownUntil, checkedAtUtc: startedAtUtc, elapsed: Date.parse(startedAtUtc) >= Date.parse(cooldownUntil) },
    attemptClaim: { status: "NOT_ACQUIRED" },
    capacityBaseline: null,
    checkpointRecovery: null,
    oldGeo: null,
    correctedGeo: null,
    criticInputDiff: null,
    criticCall: { status: "NOT_RUN", providerCalls: 0 },
    criticDecision: null,
    publisherReadiness: "NOT_RUN",
    publicationResult: "NOT_RUN",
    eventId: null,
    articleId: null,
    slug: null,
    publicViewVerification: "NOT_RUN",
    frontendQA: "PENDING_LOCAL_QA",
    capacityFinal: null,
    tests: "PENDING_OFFLINE_REGRESSIONS",
  };
  const writeReport = async () => {
    await mkdir(resolve("artifacts"), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  let attemptClaim: Awaited<ReturnType<SupabasePipelineEventAttemptRepository["claim"]>> | null = null;
  let attemptFinalized = false;
  let stageAtFailure = "preflight";
  let execution: Awaited<ReturnType<CriticAgent["critique"]>> | null = null;
  let publisherCommitted = false;
  let finalAttemptOutcome: ReturnType<typeof attemptOutcomeFromPipelineResult> | null = null;
  let publicationRepository: SupabasePublisherRepository | null = null;
  let publisherInput: PublisherInput | null = null;
  let supabase: ReturnType<typeof createSupabaseServerClient> | null = null;
  let logger: SupabaseAgentLogger | null = null;
  let attemptRegistry: SupabasePipelineEventAttemptRepository | null = null;
  const files = {
    verifier: resolve(checkpointRoot, `verifier-${eventKey}.json`),
    translator: resolve(checkpointRoot, `translator-${eventKey}.json`),
    editor: resolve(checkpointRoot, `editor-${eventKey}.json`),
    classifier: resolve(checkpointRoot, `classifier-${eventKey}.json`),
    ranker: resolve(checkpointRoot, `ranker-${eventKey}.json`),
    critic: resolve(checkpointRoot, `critic-${eventKey}.json`),
  };

  try {
    if (!report.cooldownState || !object(report.cooldownState).elapsed) fail("BLOCKED_ATTEMPT_COOLDOWN");
    const [verifierCheckpoint, translatorCheckpoint, editorCheckpoint, classifierCheckpoint, rankerCheckpoint, oldCriticCheckpoint] = await Promise.all([
      readSafeTranslatorCheckpoint(files.verifier), readSafeTranslatorCheckpoint(files.translator),
      readSafeTranslatorEditorCheckpoint(files.editor), readSafeClassifierPipelineCheckpoint(files.classifier),
      readSafeRankerPipelineCheckpoint(files.ranker), readSafeCriticPipelineCheckpoint(files.critic),
    ]);
    if ([verifierCheckpoint.eventKey, translatorCheckpoint.eventKey, editorCheckpoint.eventKey, classifierCheckpoint.eventKey, rankerCheckpoint.eventKey, oldCriticCheckpoint.eventKey].some((key) => key !== eventKey)) fail("CHECKPOINT_EVENT_KEY_MISMATCH");
    const editorSnapshotFields = ["schemaVersion", "eventKey", "headlineEs", "summaryEs", "whyItMattersEs", "keyPoints"] as const;
    const classifierEditorialAligned = editorSnapshotFields.every((field) => isDeepStrictEqual(classifierCheckpoint.editorial[field], rankerCheckpoint.editorial[field]));
    const alignment = {
      verifier: isDeepStrictEqual(verifierCheckpoint.verification, rankerCheckpoint.verification),
      translator: isDeepStrictEqual(editorCheckpoint.translation, rankerCheckpoint.translation),
      editorPersistedSubset: classifierEditorialAligned,
      editorFullDraftMatchesCriticCheckpoint: isDeepStrictEqual(rankerCheckpoint.editorial, oldCriticCheckpoint.editorial),
      classifier: isDeepStrictEqual(classifierCheckpoint.classification, rankerCheckpoint.classification),
      ranker: isDeepStrictEqual(rankerCheckpoint.ranking, oldCriticCheckpoint.ranking),
      rankerScoreRecomputed: rankingValid(rankerCheckpoint),
    };
    if (!Object.values(alignment).every(Boolean)) fail("UPSTREAM_CHECKPOINT_ALIGNMENT_FAILED");
    if (oldCriticCheckpoint.critic.decision !== "pass") fail("OLD_CRITIC_CHECKPOINT_DECISION_UNEXPECTED");

    supabase = createSupabaseServerClient();
    logger = new SupabaseAgentLogger(supabase);
    attemptRegistry = new SupabasePipelineEventAttemptRepository(supabase);
    publicationRepository = new SupabasePublisherRepository(supabase);
    const now = new Date();
    const historyResult = await supabase.from("pipeline_event_attempts").select("*").eq("event_key", eventKey).order("attempt_number", { ascending: true });
    if (historyResult.error || !historyResult.data) fail("ATTEMPT_HISTORY_READ_FAILED");
    const attemptValues = historyResult.data.map(normalizeAttempt);
    const eligibility = evaluateNormalEligibility(attemptValues, now);
    if (!eligibility.eligible) fail(`ATTEMPT_NOT_ELIGIBLE_${eligibility.reason}`);
    const activeAttempt = historyResult.data.some((row) => row.completed_at === null);
    if (activeAttempt) fail("ACTIVE_ATTEMPT_EXISTS");

    const registry = await loadActiveReferenceRegistry(supabase);
    const projectedGeo = projectClassificationGeo(rankerCheckpoint.classification, registry);
    const projectedCheckpoint: RankerPipelineCheckpoint = { ...rankerCheckpoint, classification: projectedGeo.classification, geo: projectedGeo.geo };
    const input = criticInput(projectedCheckpoint);
    const criticSchemaCheck = criticInputSchema.safeParse(input);
    if (!criticSchemaCheck.success) fail("CRITIC_INPUT_SCHEMA_FAILED");
    const prechecks = runCriticPrechecks(input, { registry });
    if (!prechecks.passed) fail(`CRITIC_DETERMINISTIC_PRECHECK_FAILED:${prechecks.issues.map((issue) => issue.code).join(",")}`);
    const oldModelInput = buildCriticModelInput(criticInput(oldCriticCheckpoint)).input;
    const newModelInput = buildCriticModelInput(input).input;
    const inputDiffPaths = changedPaths(oldModelInput, newModelInput);
    if (!isDeepStrictEqual(withoutClassificationCoordinates(oldModelInput), withoutClassificationCoordinates(newModelInput))
      || !isDeepStrictEqual(inputDiffPaths.sort(), ["classification.latitude", "classification.longitude"])) fail("CRITIC_MODEL_INPUT_CHANGED_OUTSIDE_GEO_PROJECTION");

    const modelProvider = createConfiguredModelProvider();
    const baseModelConfig = getCriticModelConfig();
    const groqLimits = readGroqAtomicCapacityLimits();
    if (!groqLimits) fail("GROQ_ATOMIC_CAPACITY_CONFIG_MISSING");
    const modelConfig = { ...baseModelConfig, maxRetries: 0, groqCapacity: groqLimits };
    validateCostGuardConfig(modelConfig);
    const providerConfig = {
      provider: process.env.AGENT_PROVIDER?.trim().toLowerCase() ?? null,
      adapter: modelProvider.providerId,
      model: modelConfig.model,
      criticVersion: criticAgentVersion,
      maxRetries: modelConfig.maxRetries,
      allowPaidFallback: modelConfig.allowPaidFallback,
      failOnRateLimit: modelConfig.failOnRateLimit,
      routerEnabled: freeProviderRouterEnabled(),
      apiKeyPresent: Boolean(process.env.AGENT_API_KEY?.trim()),
      capacityLimits: groqLimits,
    };
    if (providerConfig.provider !== "groq" || providerConfig.adapter !== "groq" || providerConfig.model !== modelName || providerConfig.criticVersion !== "critic-v3"
      || providerConfig.maxRetries !== 0 || providerConfig.allowPaidFallback || !providerConfig.failOnRateLimit || providerConfig.routerEnabled || !providerConfig.apiKeyPresent) fail("CRITIC_PROVIDER_CONFIG_MISMATCH");

    const currentInput = buildCriticModelInput(input);
    const estimated = estimateGroqStageTokenRequirement({
      systemInstructionChars: criticSystemInstructions.length,
      modelInputChars: JSON.stringify(currentInput.input).length,
      schemaChars: JSON.stringify(toStrictProviderJsonSchema(criticCurrentGenerationSchema)).length,
      maxOutputTokens: modelConfig.maxOutputTokens,
    });
    const [usage, requestQuota, providerBlock, eventTpm, globalLatestResult, reservationLogResult] = await Promise.all([
      logger.getProviderDailyUsage("groq", requestDateUtc),
      logger.getRemainingRequests(modelConfig.dailyRequestLimit, requestDateUtc),
      logger.getProviderRateLimitState("groq"),
      logger.getLatestProviderRateLimitTelemetry("groq", eventKey),
      supabase.from("agent_runs").select("id,finished_at,provider,config,stats").eq("provider", "groq").not("finished_at", "is", null).order("finished_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("agent_logs").select("provider,payload,provider_unit,provider_unit_amount,created_at,run_id").eq("step", "provider_request_reserved").gte("created_at", `${requestDateUtc}T00:00:00.000Z`).lt("created_at", new Date(Date.parse(`${requestDateUtc}T00:00:00.000Z`) + 86_400_000).toISOString()).range(0, 999),
    ]);
    if (globalLatestResult.error || reservationLogResult.error || !reservationLogResult.data) fail("CAPACITY_BASELINE_READ_FAILED");
    const groqReservations = reservationLogResult.data.filter((row) => row.provider === "groq" || row.provider === null && reservationDetails(row.payload).provider === "groq");
    const unknownDispatchedReservations = groqReservations.filter((row) => reservationDispatched(row.payload) && row.provider_unit === "tokens" && reservationTokenState(row.payload) !== "settled").length;
    const requestSoftRemaining = Math.max(0, groqLimits.requestSoftLimit - usage.requestsReserved);
    const tokenSoftRemaining = Math.max(0, groqLimits.tokenSoftLimit - usage.totalTokens);
    const tpmDecision = decideGroqTpmPacing({ isFirstStage: false, providerHeaders: eventTpm, estimatedStageTokenRequirement: estimated.estimatedStageTokenRequirement, tokenLimitTpm: groqLimits.tokenMinuteHardLimit ?? 0 });
    const projectedRequests = usage.requestsReserved + 1;
    const projectedTokens = usage.totalTokens + estimated.estimatedStageTokenRequirement;
    const blockActive = Boolean(providerBlock?.blockedUntil && Date.parse(providerBlock.blockedUntil) > Date.now());
    if (!usage.tokenUsageKnown || usage.unknownTokenRequests > 0 || unknownDispatchedReservations > 0) fail("BLOCKED_GROQ_ACCOUNTING_UNKNOWN");
    if (usage.requestsReserved !== requestQuota.used || requestQuota.remaining < 1) fail("BLOCKED_GROQ_REQUEST_LEDGER_MISMATCH_OR_EMPTY");
    if (projectedRequests > groqLimits.requestHardLimit || projectedRequests > groqLimits.requestSoftLimit) fail("BLOCKED_GROQ_REQUEST_CAPACITY");
    if (projectedTokens > groqLimits.tokenHardLimit || projectedTokens > groqLimits.tokenSoftLimit) fail("BLOCKED_GROQ_TOKEN_CAPACITY");
    if (blockActive) fail("BLOCKED_ACTIVE_GROQ_PROVIDER_LIMIT");
    if (tpmDecision.decision === "BLOCKED_SINGLE_STAGE_TPM_SAFETY" || tpmDecision.decision === "BLOCKED_TPM_RESET_UNKNOWN") fail(`BLOCKED_GROQ_TPM_${tpmDecision.reason}`);

    const artifactFiles = await Promise.all(Object.entries(files).map(async ([stage, path]) => ({ stage, sha256: sha256(await readFile(path)) })));
    const sourceAssociations: SourceAssociation[] = [];
    for (const source of rankerCheckpoint.sources) {
      const editorSource = editorCheckpoint.sources.find((candidate) => candidate.sourceId === source.sourceId);
      if (!editorSource || editorSource.sourceName !== source.sourceName || !editorSource.canonicalUrl) fail("PUBLISHER_SOURCE_CHECKPOINT_ALIGNMENT_FAILED");
      const rawResult = await supabase.from("raw_items").select("id,source_id,canonical_url,published_at,processing_status,extraction_quality")
        .eq("source_id", source.sourceId).eq("canonical_url", editorSource.canonicalUrl);
      if (rawResult.error || !rawResult.data || rawResult.data.length !== 1) fail("PUBLISHER_RAW_ITEM_RESOLUTION_FAILED");
      const rawItem = rawResult.data[0] as RawItemRow;
      if (rawItem.source_id !== source.sourceId || rawItem.processing_status !== "extracted" || rawItem.extraction_quality !== "full") fail("PUBLISHER_RAW_ITEM_OWNERSHIP_OR_QUALITY_FAILED");
      sourceAssociations.push({ sourceItemId: source.sourceItemId, sourceId: source.sourceId, sourceName: source.sourceName, sourceType: editorSource.sourceType, countryCode: source.countryCode ?? null, canonicalUrl: editorSource.canonicalUrl, rawItem });
    }
    const slug = projectedCheckpoint.editorial.suggestedSlug;
    const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!publicUrl || !publishableKey) fail("PUBLIC_SUPABASE_READ_CONFIG_MISSING");
    const publicClient = createClient(publicUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const [eventBefore, articleBefore, publicSlugBefore, publicCountBefore, historyCountBefore, originalRunsResult] = await Promise.all([
      supabase.from("events").select("id,event_key").eq("event_key", eventKey),
      supabase.from("articles").select("id,slug,event_id").eq("slug", slug),
      publicClient.from("public_published_articles").select("slug").eq("slug", slug),
      publicClient.from("public_published_articles").select("slug", { count: "exact", head: true }),
      supabase.from("activity_history").select("id", { count: "exact", head: true }),
      supabase.from("agent_runs").select("id,provider,status,config,stats,started_at,finished_at").contains("config", { eventKey }).order("started_at", { ascending: true }),
    ]);
    if (eventBefore.error || articleBefore.error || publicSlugBefore.error || publicCountBefore.error || historyCountBefore.error || originalRunsResult.error) fail("PUBLICATION_BASELINE_READ_FAILED");
    if ((eventBefore.data ?? []).length !== 0 || (articleBefore.data ?? []).length !== 0 || (publicSlugBefore.data ?? []).length !== 0 || publicCountBefore.count === null) fail("PUBLICATION_ALREADY_EXISTS_OR_PUBLIC_COUNT_UNKNOWN");
    const historicalRuns = originalRunsResult.data ?? [];
    const historicalStageRows = historicalRuns.map((row) => {
      const config = object(row.config); const telemetry = object(object(row.stats).telemetry);
      return { agentName: config.agentName, provider: row.provider, status: row.status, model: config.model, providerRequestsUsed: telemetry.providerRequestsUsed, totalTokens: telemetry.totalTokens };
    });
    const historicalRequests = historicalStageRows.reduce((total, row) => total + (Number.isSafeInteger(row.providerRequestsUsed) ? Number(row.providerRequestsUsed) : 0), 0);
    const historicalTokens = historicalStageRows.reduce((total, row) => total + (Number.isSafeInteger(row.totalTokens) ? Number(row.totalTokens) : 0), 0);
    const hasStages = expectedStages.every((stage) => historicalStageRows.some((row) => row.agentName === stage && row.provider === "groq" && row.status === "succeeded" && row.model === modelName && row.providerRequestsUsed === 1));
    if (!hasStages || historicalRequests !== 6 || historicalTokens !== 9_881) fail("HISTORICAL_UPSTREAM_USAGE_OR_STAGE_SET_MISMATCH");

    const provisionalInput = makePublisherInput(projectedCheckpoint, sourceAssociations, oldCriticCheckpoint.critic);
    publicationPayloadSchema.parse(provisionalInput.payload);
    validatePublisherInputs(provisionalInput);
    const regionCode = projectedCheckpoint.classification.primaryRegionCode;
    if (!regionCode) fail("PROJECTED_REGION_CODE_MISSING");
    const region = registry.regions.get(regionCode);
    if (!region || region.latitude !== projectedCheckpoint.geo.latitude || region.longitude !== projectedCheckpoint.geo.longitude) fail("PROJECTED_REGION_REGISTRY_MISMATCH");
    const capacityBaseline = {
      requestDateUtc,
      usage,
      requestQuota,
      unknownDispatchedReservations,
      activeProviderBlock: blockActive ? providerBlock?.blockedUntil : null,
      requestSoftLimit: groqLimits.requestSoftLimit,
      tokenSoftLimit: groqLimits.tokenSoftLimit,
      softRpdRemaining: requestSoftRemaining,
      softTpdRemaining: tokenSoftRemaining,
      eventTpm,
      globalLatestTpm: object(object(globalLatestResult.data?.stats).telemetry).providerRateLimit ?? null,
      eventTpmSourceFinishedAt: globalLatestResult.data?.finished_at ?? null,
      projectedRequests,
      projectedTokens,
      estimated,
      tpmDecision,
    };
    const artifact = {
      phase: "12A.2",
      currentUtc: startedAtUtc,
      requestDateUtc,
      provider: providerConfig,
      capacityBaseline,
      historicalGroq: { calls: historicalRequests, tokens: historicalTokens, stages: historicalStageRows.map(({ agentName, providerRequestsUsed, totalTokens }) => ({ agentName, providerRequestsUsed, totalTokens })) },
      attemptEligibility: { ...eligibility, priorAttemptCount: attemptValues.length, technicalFailuresCounting: attemptValues.filter((item) => item.finalState === "TECHNICAL_FAILURE" && item.countsTowardRetryLimit).length },
      checkpointRecovery: { readSafe: true, paths: files, hashes: artifactFiles, stageAlignment: alignment, noUpstreamReplay: true, originalCriticApprovalReusable: false },
      oldGeo: { region: oldCriticCheckpoint.classification.primaryRegionCode, countryCodes: oldCriticCheckpoint.classification.countryCodes, latitude: oldCriticCheckpoint.classification.latitude, longitude: oldCriticCheckpoint.classification.longitude, criticGeo: oldCriticCheckpoint.geo },
      correctedGeo: { region: projectedCheckpoint.classification.primaryRegionCode, countryCodes: projectedCheckpoint.classification.countryCodes, latitude: projectedCheckpoint.classification.latitude, longitude: projectedCheckpoint.classification.longitude, geo: projectedCheckpoint.geo, regionRegistryName: region.name },
      criticInputDiff: { changedModelInputPaths: inputDiffPaths, oldCoordinates: { latitude: oldModelInput.geo.latitude, longitude: oldModelInput.geo.longitude }, correctedCoordinates: { latitude: newModelInput.geo.latitude, longitude: newModelInput.geo.longitude }, semanticModelInputUnchanged: true, deterministicPrechecks: { passed: prechecks.passed, issues: prechecks.issues.map((issue) => issue.code) }, schema: "PASS", publisherProjectionPrecursor: "PASS" },
      publisherBaseline: { slug, publicArticleCountBefore: publicCountBefore.count, publicSlugAbsent: (publicSlugBefore.data ?? []).length === 0, eventAbsent: (eventBefore.data ?? []).length === 0, articleSlugAbsent: (articleBefore.data ?? []).length === 0, activityHistoryCountBefore: historyCountBefore.count, rawItems: sourceAssociations.map((row) => ({ sourceId: row.sourceId, sourceName: row.sourceName, rawItemId: row.rawItem.id, canonicalUrl: row.canonicalUrl, processingStatus: row.rawItem.processing_status, extractionQuality: row.rawItem.extraction_quality, ownedBySource: row.rawItem.source_id === row.sourceId })) },
      cooldownState: { requiredUntil: cooldownUntil, elapsed: Date.parse(startedAtUtc) >= Date.parse(cooldownUntil) },
      attemptClaim: { status: "NOT_ACQUIRED" },
      criticCall: { status: "NOT_RUN", providerCalls: 0 },
      criticDecision: null,
      publisherReadiness: "NOT_RUN",
      publicationResult: "NOT_RUN",
      publicViewVerification: "NOT_RUN",
      frontendQA: "PENDING_LOCAL_QA",
      capacityFinal: null,
      tests: "PENDING_OFFLINE_REGRESSIONS",
    };
    Object.assign(report, artifact);
    if (!execute) {
      console.log(JSON.stringify({ status: "PREFLIGHT_PASSED_NO_CALL", providerCalls: 0, artifact: report }, null, 2));
      return;
    }

    const claimTime = new Date();
    const claim = await attemptRegistry.claim({ eventKey, pipelineRunId: resumePipelineRunId, startedAt: claimTime.toISOString(), now: claimTime.toISOString() });
    attemptClaim = claim;
    if (claim.status !== "ACQUIRED") fail(`ATTEMPT_CLAIM_${claim.status}`);
    report.attemptClaim = { status: claim.status, attemptId: claim.attempt.id, attemptNumber: claim.attempt.attemptNumber, pipelineRunId: claim.attempt.pipelineRunId, startedAt: claim.attempt.startedAt };
    await writeReport();

    stageAtFailure = "critic";
    const critic = new CriticAgent(modelProvider, logger);
    execution = await critic.critique(input, { dryRun: false, modelConfig, requestBudget: new DailyRequestBudget(), registry });
    const generationResolution = resolveCriticGeneration(currentInput.evidenceCatalog, execution.generation);
    const criticCall = {
      status: "COMPLETED",
      runId: execution.runId,
      agentVersion: execution.agentVersion,
      model: execution.model,
      provider: execution.telemetry?.provider ?? null,
      providerHttpStatus: execution.telemetry?.providerHttpStatus ?? null,
      attempts: execution.attempts,
      maxRetries: modelConfig.maxRetries,
      providerRequestsUsed: execution.providerRequestsUsed,
      inputTokens: execution.telemetry?.inputTokens ?? null,
      outputTokens: execution.telemetry?.outputTokens ?? null,
      totalTokens: execution.telemetry?.totalTokens ?? null,
      latencyMs: execution.latencyMs,
      providerRateLimit: execution.telemetry?.providerRateLimit ?? null,
      deterministicPrechecks: { passed: execution.prechecks.passed, issues: execution.prechecks.issues.map((issue) => issue.code) },
      outputSchemaValid: true,
      findings: generationResolution.generation.findings.map((finding) => ({
        kind: finding.kind, stage: finding.stage, severity: finding.severity,
        ...(finding.kind === "issue" ? { dimension: finding.dimension, message: finding.message } : { claim: finding.claim, reason: finding.reason }),
        evidence: finding.evidenceRefs.map((ref) => { const item = currentInput.evidenceCatalog.find((entry) => entry.canonicalRef === ref); return { ref, evidenceType: item?.evidenceType ?? null, stage: item?.stage ?? null, preview: item?.preview.slice(0, 160) ?? null }; }),
      })),
      resolvedEvidenceRefsCount: generationResolution.resolvedEvidenceRefsCount,
    };
    report.criticCall = criticCall;
    report.criticDecision = { decision: execution.output.decision, severity: execution.output.severity, issues: execution.output.issues, unsupportedClaims: execution.output.unsupportedClaims, notes: execution.output.notes };

    if (execution.prechecks.passed && execution.providerRequestsUsed === 1 && execution.attempts === 1) {
      if (!execution.runId) fail("CRITIC_RUN_ID_MISSING_AFTER_DISPATCH");
      const [usedAfter, quotaAfter, reservationLogResult, agentRunResult] = await Promise.all([
        logger.getProviderDailyUsage("groq", requestDateUtc),
        logger.getRemainingRequests(modelConfig.dailyRequestLimit, requestDateUtc),
        supabase.from("agent_logs").select("provider,payload,provider_unit,provider_unit_amount,created_at").eq("run_id", execution.runId).eq("step", "provider_request_reserved"),
        supabase.from("agent_runs").select("id,provider,config,stats,status").eq("id", execution.runId).maybeSingle(),
      ]);
      if (reservationLogResult.error || agentRunResult.error || !reservationLogResult.data || !agentRunResult.data) fail("CRITIC_PERSISTENT_ACCOUNTING_READ_FAILED");
      const telemetry = object(object(agentRunResult.data.stats).telemetry);
      const reservations = reservationLogResult.data;
      const reservation = reservations.length === 1 ? reservations[0] : null;
      const dispatched = reservation ? reservationDispatched(reservation.payload) : false;
      const actualTotal = Number.isSafeInteger(execution.telemetry?.inputTokens) && Number.isSafeInteger(execution.telemetry?.outputTokens)
        ? Number(execution.telemetry?.inputTokens) + Number(execution.telemetry?.outputTokens) : null;
      const settled = reservation ? reservationTokenState(reservation.payload) === "settled" && reservation.provider_unit === "tokens"
        && actualTotal !== null && Number.isSafeInteger(reservation.provider_unit_amount) && Number(reservation.provider_unit_amount) === actualTotal : false;
      const ledgerCheck = {
        reservationCount: reservations.length,
        provider: reservation?.provider ?? null,
        dispatched,
        tokenUsageState: reservation ? reservationTokenState(reservation.payload) : null,
        providerUnit: reservation?.provider_unit ?? null,
        providerUnitAmount: reservation?.provider_unit_amount ?? null,
        trustworthyTelemetryTokens: Number.isSafeInteger(execution.telemetry?.inputTokens) && Number.isSafeInteger(execution.telemetry?.outputTokens) && Number(execution.telemetry?.inputTokens) + Number(execution.telemetry?.outputTokens) > 0,
        settled,
        ledgerRequestCountAfter: usedAfter.requestsReserved,
        ledgerDispatchedAfter: usedAfter.requestsDispatched,
        ledgerUnknownTokenRequestsAfter: usedAfter.unknownTokenRequests,
        dailyRequestQuotaUsedAfter: quotaAfter.used,
        runProvider: agentRunResult.data.provider,
        runStatus: agentRunResult.data.status,
        telemetryProvider: telemetry.provider,
        telemetryModel: telemetry.model,
        telemetryProviderRequestsUsed: telemetry.providerRequestsUsed,
      };
      report.capacityFinal = { requestDateUtc, usage: usedAfter, requestQuota: quotaAfter, unknownDispatchedReservations: usedAfter.unknownTokenRequests, criticReservation: ledgerCheck, historicalPilotGroqCalls: 6, historicalPilotGroqTokens: 9_881 };
      if (ledgerCheck.reservationCount !== 1 || ledgerCheck.provider !== "groq" || !ledgerCheck.dispatched || !ledgerCheck.trustworthyTelemetryTokens || !ledgerCheck.settled
        || ledgerCheck.runProvider !== "groq" || ledgerCheck.telemetryProvider !== "groq" || ledgerCheck.telemetryModel !== modelName || ledgerCheck.telemetryProviderRequestsUsed !== 1
        || usedAfter.requestsReserved !== Number(object(object(report.capacityBaseline).usage).requestsReserved) + 1
        || usedAfter.requestsDispatched !== Number(object(object(report.capacityBaseline).usage).requestsDispatched) + 1
        || usedAfter.unknownTokenRequests !== 0) {
        report.criticCall = { ...criticCall, accounting: ledgerCheck, accountingStatus: "UNKNOWN_OR_INCONSISTENT_ESTIMATE_RETAINED" };
        fail("CRITIC_ACCOUNTING_UNKNOWN_AFTER_DISPATCH");
      }
    } else {
      fail("CRITIC_EXECUTION_DID_NOT_USE_EXACTLY_ONE_PROVIDER_REQUEST");
    }

    const newCriticCheckpointPath = resolve("artifacts/pipeline-checkpoints", resumePipelineRunId, `critic-${eventKey}.json`);
    if (existsSync(newCriticCheckpointPath)) fail("NEW_CRITIC_CHECKPOINT_PATH_ALREADY_EXISTS");
    const criticCheckpoint = buildCriticPipelineCheckpoint(projectedCheckpoint, execution.output);
    await writeCriticPipelineCheckpointAtomic(criticCheckpoint, newCriticCheckpointPath);
    report.checkpointRecovery = { ...object(report.checkpointRecovery), newCriticCheckpoint: newCriticCheckpointPath, historicalCheckpointFilesRewritten: false };

    if (execution.output.decision === "reject") {
      report.publicationResult = "NOT_PUBLISHED_CRITIC_REJECTED";
      finalAttemptOutcome = attemptOutcomeFromPipelineResult({ finalState: "BLOCKED_REJECTED", stopStage: "critic", stopReason: "BLOCKED_REJECTED" }, claim.attempt.startedAt ? new Date(claim.attempt.startedAt) : startedAt);
    } else if (execution.output.decision !== "pass") {
      report.publicationResult = "NOT_PUBLISHED_CRITIC_REQUIRES_REVIEW";
      finalAttemptOutcome = attemptOutcomeFromPipelineResult({ finalState: "BLOCKED_REVISION_REQUIRED", stopStage: "critic", stopReason: "BLOCKED_REVISION_REQUIRED" }, claim.attempt.startedAt ? new Date(claim.attempt.startedAt) : startedAt);
    } else {
      stageAtFailure = "publisher";
      publisherInput = makePublisherInput(projectedCheckpoint, sourceAssociations, execution.output);
      publicationPayloadSchema.parse(publisherInput.payload);
      validatePublisherInputs(publisherInput);
      const readiness = await validateRealPublicationReadiness(publisherInput, publicationRepository);
      report.publisherReadiness = { ready: readiness.ready, issues: readiness.issues.map((issue) => issue.code), eventResolution: readiness.eventResolution, rawItemOwnershipChecked: readiness.rawItemOwnershipChecked };
      if (!readiness.ready || readiness.rawItemOwnershipChecked !== sourceAssociations.length) fail("FINAL_PUBLISHER_READINESS_FAILED");
      const [lastEvent, lastArticle, lastPublicSlug] = await Promise.all([
        supabase.from("events").select("id,event_key").eq("event_key", eventKey),
        supabase.from("articles").select("id,slug,event_id").eq("slug", publisherInput.payload.article.slug),
        publicClient.from("public_published_articles").select("slug").eq("slug", publisherInput.payload.article.slug),
      ]);
      if (lastEvent.error || lastArticle.error || lastPublicSlug.error || (lastEvent.data ?? []).length > 0 || (lastArticle.data ?? []).length > 0 || (lastPublicSlug.data ?? []).length > 0) fail("PUBLICATION_DUPLICATE_GUARD_FAILED");
      const publisherResult = await new Publisher(publicationRepository).publish(publisherInput, { dryRun: false });
      publisherCommitted = publisherResult.summary.transactionCommitted;
      report.publicationResult = { status: publisherResult.status, dryRun: publisherResult.dryRun, summary: publisherResult.summary };
      report.eventId = publisherResult.summary.eventId;
      report.articleId = publisherResult.summary.articleId;
      report.slug = publisherInput.payload.article.slug;
      if (!publisherResult.summary.transactionAttempted || !publisherResult.summary.transactionCommitted || !publisherResult.summary.articleCreated) fail("PUBLISHER_ATOMIC_MATERIALIZATION_RESULT_UNEXPECTED");
      finalAttemptOutcome = attemptOutcomeFromPipelineResult({ finalState: "SUCCESS", stopStage: null, stopReason: null }, claim.attempt.startedAt ? new Date(claim.attempt.startedAt) : startedAt);
      await attemptRegistry.finalize({ attemptId: claim.attempt.id, pipelineRunId: resumePipelineRunId, completedAt: new Date().toISOString(), ...finalAttemptOutcome });
      attemptFinalized = true;

      const eventRead = await supabase.from("events").select("id,event_key,canonical_title,primary_region_id,primary_country_code").eq("event_key", eventKey);
      if (eventRead.error || !eventRead.data) fail("PUBLISHED_EVENT_READBACK_FAILED");
      const eventRows = eventRead.data;
      const materializedEventId = eventRows.length === 1 ? eventRows[0]!.id : null;
      if (!materializedEventId) fail("PUBLISHED_EVENT_COUNT_INVALID");
      const [articleRows, slugRows, eventSources, categoryLinks, entityLinks, publicRows, publicCountAfter, historyCountAfter] = await Promise.all([
        supabase.from("articles").select("id,event_id,slug,headline_es,summary_es,why_it_matters_es,publication_status,published_at,importance_score,critic_status").eq("event_id", materializedEventId),
        supabase.from("articles").select("id,slug,event_id").eq("slug", publisherInput.payload.article.slug),
        supabase.from("event_sources").select("event_id,raw_item_id,source_id,is_primary").eq("event_id", materializedEventId),
        supabase.from("article_categories").select("article_id,category_id,is_primary,confidence_score").eq("article_id", String(publisherResult.summary.articleId)),
        supabase.from("article_entities").select("article_id,entity_id,role,confidence_score").eq("article_id", String(publisherResult.summary.articleId)),
        publicClient.from("public_published_articles").select("slug,headline_es,summary_es,why_it_matters_es,published_at,region_code,region_name,region_latitude,region_longitude,categories,sources,entities").eq("slug", publisherInput.payload.article.slug),
        publicClient.from("public_published_articles").select("slug", { count: "exact", head: true }),
        supabase.from("activity_history").select("id", { count: "exact", head: true }),
      ]);
      if (articleRows.error || slugRows.error || eventSources.error || categoryLinks.error || entityLinks.error || publicRows.error || publicCountAfter.error || historyCountAfter.error) fail("PUBLIC_CONTRACT_READBACK_FAILED");
      const articles = articleRows.data ?? [];
      const slugs = slugRows.data ?? [];
      const publicArticles = publicRows.data ?? [];
      const article = articles.length === 1 ? articles[0]! : null;
      const publicArticle = publicArticles.length === 1 ? publicArticles[0]! : null;
      const eventSourcesData = eventSources.data ?? [];
      const categoryData = categoryLinks.data ?? [];
      const entityData = entityLinks.data ?? [];
      const duplicatesNone = eventRows.length === 1 && articles.length === 1 && slugs.length === 1 && publicArticles.length === 1;
      const mapCanonical = publicArticle?.region_code === "GLOBAL" && publicArticle.region_latitude === 20 && publicArticle.region_longitude === 0;
      const publicVisible = Boolean(publicArticle && publicArticle.published_at && article?.publication_status === "published");
      report.eventId = materializedEventId;
      report.articleId = article?.id ?? publisherResult.summary.articleId;
      report.slug = article?.slug ?? publisherInput.payload.article.slug;
      report.publicViewVerification = {
        visible: publicVisible,
        publicRowsBySlug: publicArticles.length,
        publicArticleCountBefore: publicCountBefore.count,
        publicArticleCountAfter: publicCountAfter.count,
        eventRows: eventRows.map((row) => ({ id: row.id, eventKey: row.event_key, canonicalTitle: row.canonical_title, primaryRegionId: row.primary_region_id, primaryCountryCode: row.primary_country_code })),
        articleRows: articles.map((row) => ({ id: row.id, eventId: row.event_id, slug: row.slug, publicationStatus: row.publication_status, publishedAt: row.published_at, importanceScore: row.importance_score, criticStatus: row.critic_status })),
        eventSources: eventSourcesData,
        articleCategories: categoryData,
        articleEntities: entityData,
        activityHistoryRowsCreated: publisherResult.summary.activityRowsCreated,
        activityHistoryCountBefore: historyCountBefore.count,
        activityHistoryCountAfter: historyCountAfter.count,
        duplicatesNone,
        map: { regionCode: publicArticle?.region_code ?? null, regionName: publicArticle?.region_name ?? null, latitude: publicArticle?.region_latitude ?? null, longitude: publicArticle?.region_longitude ?? null, canonicalExpected: mapCanonical },
        publicArticle: publicArticle ? { headline: publicArticle.headline_es, summary: publicArticle.summary_es, whyItMatters: publicArticle.why_it_matters_es, publishedAt: publicArticle.published_at, categories: publicArticle.categories, sources: publicArticle.sources } : null,
      };
      report.contentReview = publicArticle ? {
        headline: publicArticle.headline_es,
        summary: publicArticle.summary_es,
        whyItMatters: publicArticle.why_it_matters_es,
        categories: publicArticle.categories,
        region: { code: publicArticle.region_code, name: publicArticle.region_name },
        countryCodes: publisherInput.payload.event.probableCountryCode ? [publisherInput.payload.event.probableCountryCode] : [],
        mapCoordinates: { latitude: publicArticle.region_latitude, longitude: publicArticle.region_longitude },
        sources: publicArticle.sources,
        importance: publisherInput.payload.scores.importanceScore,
        criticDecision: execution.output.decision,
        slug: publisherInput.payload.article.slug,
      } : null;
      if (!publicVisible || !duplicatesNone || !mapCanonical || publicCountBefore.count !== 0 || publicCountAfter.count !== 1) fail("PUBLIC_ARTICLE_CONTRACT_VERIFICATION_FAILED");
      const finalUsage = await logger.getProviderDailyUsage("groq", requestDateUtc);
      const finalQuota = await logger.getRemainingRequests(modelConfig.dailyRequestLimit, requestDateUtc);
      report.capacityFinal = {
        requestDateUtc,
        groqRequestsAccountedUtcDay: finalUsage.requestsReserved,
        groqRequestsDispatchedUtcDay: finalUsage.requestsDispatched,
        groqTokensAccountedUtcDay: finalUsage.totalTokens,
        unknownDispatchedReservations: finalUsage.unknownTokenRequests,
        softRpdLimit: groqLimits.requestSoftLimit,
        softRpdRemaining: Math.max(0, groqLimits.requestSoftLimit - finalUsage.requestsReserved),
        softTpdLimit: groqLimits.tokenSoftLimit,
        softTpdRemaining: Math.max(0, groqLimits.tokenSoftLimit - finalUsage.totalTokens),
        requestQuota: finalQuota,
        historicalPilotGroqCalls: 6,
        historicalPilotGroqTokens: 9_881,
        totalPilotGroqCallsIncluding12A2: 6 + finalUsage.requestsDispatched,
        totalPilotGroqTokensIncluding12A2: 9_881 + finalUsage.totalTokens,
        cloudflareCalls: 0,
        cerebrasCalls: 0,
        retries: execution.attempts - 1,
        fallbackCalls: 0,
        providerRateLimit: execution.telemetry?.providerRateLimit ?? null,
      };
    }
    if (!finalAttemptOutcome && attemptClaim?.status === "ACQUIRED") {
      const decision = execution?.output.decision;
      if (decision === "reject") finalAttemptOutcome = attemptOutcomeFromPipelineResult({ finalState: "BLOCKED_REJECTED", stopStage: "critic", stopReason: "BLOCKED_REJECTED" }, startedAt);
      else if (decision && decision !== "pass") finalAttemptOutcome = attemptOutcomeFromPipelineResult({ finalState: "BLOCKED_REVISION_REQUIRED", stopStage: "critic", stopReason: "BLOCKED_REVISION_REQUIRED" }, startedAt);
      if (finalAttemptOutcome) {
        await attemptRegistry.finalize({ attemptId: attemptClaim.attempt.id, pipelineRunId: resumePipelineRunId, completedAt: new Date().toISOString(), ...finalAttemptOutcome });
        attemptFinalized = true;
      }
    }
  } catch (error) {
    const summary = errorSummary(error);
    const details = getAgentFailureDetails(error);
    const providerRequestsUsed = execution?.providerRequestsUsed ?? details.providerRequestsUsed ?? details.telemetry?.providerRequestsUsed ?? 0;
    report.failure = { stage: stageAtFailure, code: summary.code || (error instanceof Error ? error.message.slice(0, 120) : "12A2_FAILED"), providerRequestsUsed, providerHttpStatus: details.telemetry?.providerHttpStatus ?? details.diagnostics?.httpStatus ?? null };
    if (stageAtFailure === "critic" && providerRequestsUsed > 0) report.criticCall = { ...object(report.criticCall), status: "TECHNICAL_FAILURE", providerRequestsUsed, attempts: details.attempts, telemetry: details.telemetry ? { status: details.telemetry.status, providerHttpStatus: details.telemetry.providerHttpStatus, inputTokens: details.telemetry.inputTokens, outputTokens: details.telemetry.outputTokens, totalTokens: details.telemetry.totalTokens } : null };
    if (attemptClaim?.status === "ACQUIRED" && !attemptFinalized && attemptRegistry) {
      try {
        const errorCode = summary.code || "12A2_TECHNICAL_FAILURE";
        const telemetry = details.telemetry;
        if (publisherCommitted) {
          finalAttemptOutcome = attemptOutcomeFromPipelineResult({ finalState: "SUCCESS", stopStage: null, stopReason: null }, startedAt);
        } else if (telemetry?.providerHttpStatus === 429 || telemetry?.status === "FREE_TIER_LIMIT_REACHED" || errorCode === "FREE_TIER_LIMIT_REACHED") {
          finalAttemptOutcome = attemptOutcomeFromPipelineResult({ finalState: "FAILED", stopStage: stageAtFailure, stopReason: "PROVIDER_RATE_LIMIT", failure: { errorCode: "PROVIDER_RATE_LIMIT", httpStatus: 429, telemetry: { status: telemetry?.status, providerHttpStatus: telemetry?.providerHttpStatus } } }, startedAt);
        } else if (providerRequestsUsed === 0) {
          finalAttemptOutcome = { finalState: "CANCELLED", stopStage: stageAtFailure, stopReason: errorCode, retryClass: "CANCELLED", countsTowardRetryLimit: false, nextEligibleAt: null };
        } else {
          finalAttemptOutcome = attemptOutcomeFromPipelineResult({ finalState: "FAILED", stopStage: stageAtFailure, stopReason: errorCode, failure: { errorCode, httpStatus: telemetry?.providerHttpStatus ?? details.diagnostics?.httpStatus ?? null, telemetry: telemetry ? { status: telemetry.status, providerHttpStatus: telemetry.providerHttpStatus, errorCategory: telemetry.errorCategory } : undefined } }, startedAt);
        }
        await attemptRegistry.finalize({ attemptId: attemptClaim.attempt.id, pipelineRunId: resumePipelineRunId, completedAt: new Date().toISOString(), ...finalAttemptOutcome });
        attemptFinalized = true;
        report.attemptClaim = { ...object(report.attemptClaim), finalized: true, outcome: finalAttemptOutcome };
      } catch (finalizeError) {
        report.attemptFinalizationError = errorSummary(finalizeError).code;
      }
    }
    report.status = "STOPPED_AFTER_FAILURE";
    await writeReport();
    console.log(JSON.stringify({ status: report.status, failure: report.failure, providerCalls: object(report.criticCall).providerRequestsUsed ?? 0, artifact: "artifacts/targeted-critic-publisher-resume-12a2.json" }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (attemptClaim?.status === "ACQUIRED" && !attemptFinalized && attemptRegistry) {
    await attemptRegistry.finalize({ attemptId: attemptClaim.attempt.id, pipelineRunId: resumePipelineRunId, completedAt: new Date().toISOString(), ...(finalAttemptOutcome ?? { finalState: "CANCELLED" as const, stopStage: "critic", stopReason: "NON_PUBLISHABLE_CRITIC_RESULT", retryClass: "CANCELLED" as const, countsTowardRetryLimit: false, nextEligibleAt: null }) });
    attemptFinalized = true;
    report.attemptClaim = { ...object(report.attemptClaim), finalized: true, outcome: finalAttemptOutcome };
  }
  const originalHashesAfter = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([stage, path]) => [stage, sha256(await readFile(path))])));
  const recordedHashes = object(report.checkpointRecovery).hashes;
  const expectedHashes = Array.isArray(recordedHashes) ? Object.fromEntries(recordedHashes.map((item) => { const row = object(item); return [String(row.stage), String(row.sha256)]; })) : {};
  report.checkpointRecovery = { ...object(report.checkpointRecovery), historicalCheckpointHashesAfter: originalHashesAfter, historicalCheckpointFilesUnchanged: isDeepStrictEqual(expectedHashes, originalHashesAfter) };
  report.status = execution?.output.decision === "pass" && publisherCommitted ? "PUBLISHED_PUBLIC_CONTRACT_PENDING_FRONTEND_QA" : execution?.output.decision === "pass" ? "CRITIC_PASS_PUBLICATION_NOT_COMPLETED" : "CRITIC_NON_PUBLISHABLE_STOPPED";
  report.completedAtUtc = new Date().toISOString();
  await writeReport();
  console.log(JSON.stringify({ status: report.status, eventKey, criticDecision: object(report.criticDecision).decision ?? null, publicationResult: report.publicationResult, eventId: report.eventId, articleId: report.articleId, slug: report.slug, artifact: "artifacts/targeted-critic-publisher-resume-12a2.json" }, null, 2));
  if (report.status !== "PUBLISHED_PUBLIC_CONTRACT_PENDING_FRONTEND_QA" && report.status !== "CRITIC_NON_PUBLISHABLE_STOPPED") process.exitCode = 1;
}

main().catch((error: unknown) => {
  const safe = error instanceof Error ? error.message.replace(/(?:api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, "[redacted]").slice(0, 300) : "TARGETED_CRITIC_PUBLISHER_RESUME_FAILED";
  console.error(safe);
  process.exitCode = 1;
});
