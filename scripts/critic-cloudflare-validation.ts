import { randomUUID } from "node:crypto";
import { CriticAgent, getCriticModelConfig } from "../lib/agents/critic/critic-agent.ts";
import { canonicalCriticInput } from "../lib/agents/critic/critic-fixtures.ts";
import { buildCriticModelInput } from "../lib/agents/critic/critic-input.ts";
import { criticSystemInstructions, criticAgentVersion, criticRoutingVersion } from "../lib/agents/critic/critic-prompt.ts";
import { runCriticPrechecks } from "../lib/agents/critic/critic-prechecks.ts";
import { criticCurrentGenerationSchema, criticInputSchema } from "../lib/agents/critic/critic-types.ts";
import { criticResultSchema } from "../lib/agents/contracts/index.ts";
import { loadActiveReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { assertCloudflareOneRequestDelta, assertCloudflareUtcPeriod, checkCloudflareBaselineCapacity, cloudflareAccountingDelta, createCloudflareAccountingBaseline, type CloudflareAccountingBaseline } from "../lib/agents/runtime/provider-accounting-baseline.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { createCloudflareWorkersAIValidationCandidateProvider, CloudflareWorkersAIModelProvider } from "../lib/agents/runtime/cloudflare-workers-ai-provider.ts";
import { assertFreeProviderRequest, CLOUDFLARE_LLAMA_VALIDATION_MODEL, cloudflareModelPolicy, freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { estimateCloudflareNeurons, freeProviderRouterEnabled, readCloudflareNeuronRates, readProviderCapacityConfig } from "../lib/agents/runtime/free-provider-router.ts";
import { toStrictProviderJsonSchema } from "../lib/agents/runtime/strict-json-schema.ts";
import type { AgentRunMetadata, ModelConfig, RequestReservation } from "../lib/agents/runtime/runtime-types.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import type { Json } from "../types/database.ts";

const MAX_REQUESTS = 1;
const MAX_RETRIES = 0;
const FREE_DAILY_NEURON_ALLOCATION = 10_000;
const EXPECTED_SOFT_LIMIT_RATIO = 0.85;
const VALIDATION_PURPOSE = "critic_stage_validation" as const;
const EVENT_KEY_PREFIX = "supervised-validation:critic_stage_validation:";
const eventKeyPattern = /^supervised-validation:critic_stage_validation:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function fixtureForEvent(eventKey: string) {
  check(eventKeyPattern.test(eventKey), "BLOCKED_INVALID_VALIDATION_IDENTITY");
  const input = structuredClone(canonicalCriticInput);
  input.event.eventKey = eventKey;
  input.verification.eventKey = eventKey;
  input.translation.eventKey = eventKey;
  input.editorial.eventKey = eventKey;
  input.classification.eventKey = eventKey;
  input.ranking.result.eventKey = eventKey;
  return criticInputSchema.parse(input);
}

function makeReportInput(input: ReturnType<typeof fixtureForEvent>) {
  const built = buildCriticModelInput(input);
  const schema = toStrictProviderJsonSchema(criticCurrentGenerationSchema);
  const promptChars = criticSystemInstructions.length;
  const inputJsonChars = JSON.stringify(built.input).length;
  const schemaJsonChars = JSON.stringify(schema).length;
  // Conservative existing project estimate: chars / 2, fixed framing allowance,
  // then model rates and the configured neuron safety margin.
  const estimatedInputTokens = Math.ceil((promptChars + inputJsonChars + schemaJsonChars) / 2) + 128;
  return { built, promptChars, inputJsonChars, schemaJsonChars, estimatedInputTokens };
}

class CriticValidationLogger extends SupabaseAgentLogger {
  readonly db: ReturnType<typeof createSupabaseServerClient>;
  readonly allocation: number;
  readonly configuredRequestLimit: number | null;
  readonly estimatedNeurons: number;
  readonly baseline: CloudflareAccountingBaseline;
  runId: string | null = null;

  constructor(
    db: ReturnType<typeof createSupabaseServerClient>,
    allocation: number,
    configuredRequestLimit: number | null,
    estimatedNeurons: number,
    baseline: CloudflareAccountingBaseline,
  ) {
    super(db);
    this.db = db;
    this.allocation = allocation;
    this.configuredRequestLimit = configuredRequestLimit;
    this.estimatedNeurons = estimatedNeurons;
    this.baseline = baseline;
  }

  override async startRun(metadata: AgentRunMetadata, startedAt: string): Promise<string | null> {
    check(metadata.provider === "cloudflare_workers_ai", "BLOCKED_NON_CLOUDFLARE_RUN");
    check(metadata.agentName === "critic" && metadata.agentVersion === criticAgentVersion, "BLOCKED_NON_CRITIC_RUN");
    check(metadata.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_NON_ALLOWLISTED_MODEL");
    check(typeof metadata.eventKey === "string" && eventKeyPattern.test(metadata.eventKey), "BLOCKED_INVALID_VALIDATION_IDENTITY");
    this.runId = await super.startRun(metadata, startedAt);
    return this.runId;
  }

  override reserveRequest(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    _localAttemptLimit: number,
    requestDate: string,
  ): Promise<RequestReservation> {
    assertCloudflareUtcPeriod(this.baseline.utcDate);
    check(requestDate === this.baseline.utcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
    check(attempt === 1 && metadata.eventKey !== null && eventKeyPattern.test(metadata.eventKey), "BLOCKED_VALIDATION_ATTEMPT");
    return this.reserveCloudflareSupervisedCriticValidationCapacity(
      runId,
      metadata,
      attempt,
      this.configuredRequestLimit,
      requestDate,
      this.allocation,
      this.estimatedNeurons,
    );
  }

  override async markRequestDispatched(runId: string | null, reservationId: number, requestDate: string): Promise<boolean> {
    assertCloudflareUtcPeriod(this.baseline.utcDate);
    check(requestDate === this.baseline.utcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
    return super.markRequestDispatched(runId, reservationId, requestDate);
  }

  async cleanupUndispatchedRun(): Promise<boolean> {
    if (!this.runId) return true;
    const logs = await this.db.from("agent_logs").delete().eq("run_id", this.runId);
    if (logs.error) return false;
    const run = await this.db.from("agent_runs").delete().eq("id", this.runId);
    return !run.error;
  }
}

type Preflight = {
  db: ReturnType<typeof createSupabaseServerClient>;
  logger: SupabaseAgentLogger;
  baseline: CloudflareAccountingBaseline;
  eventKey: string;
  input: ReturnType<typeof fixtureForEvent>;
  registry: Awaited<ReturnType<typeof loadActiveReferenceRegistry>>;
  modelConfig: ModelConfig;
  capacity: ReturnType<typeof readProviderCapacityConfig>;
  rates: ReturnType<typeof readCloudflareNeuronRates>;
  estimatedInputTokens: number;
  estimatedNeurons: number;
  projectedReservedNeurons: number;
  projectedSoftRemainingNeurons: number;
  articlesBefore: number;
  eventAttemptsBefore: number;
  expectedPromptChars: number;
  expectedInputJsonChars: number;
  expectedSchemaJsonChars: number;
};

async function exactCount(query: PromiseLike<{ count: number | null; error: { message: string } | null }>, code: string): Promise<number> {
  const result = await query;
  if (result.error || result.count === null) throw new Error(code);
  return result.count;
}

async function preparePreflight(): Promise<Preflight> {
  const configuredCritic = getCriticModelConfig();
  const provider = process.env.AGENT_PROVIDER?.trim().toLowerCase();
  check(provider === "groq", "BLOCKED_PRODUCTION_PROVIDER_CHANGED");
  check((freeProviderPolicy.groq.approvedModels as readonly string[]).includes(configuredCritic.model), "BLOCKED_PRODUCTION_CRITIC_MODEL_NOT_FREE_APPROVED");
  check(configuredCritic.allowPaidFallback === false, "BLOCKED_PAID_FALLBACK_ENABLED");
  check(!freeProviderRouterEnabled(), "BLOCKED_PRODUCTION_ROUTER_MUST_REMAIN_DISABLED");

  const model = CLOUDFLARE_LLAMA_VALIDATION_MODEL;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_AI_API_TOKEN?.trim();
  check(Boolean(accountId && token), "BLOCKED_CLOUDFLARE_CONFIGURATION");
  const validationEnv = { ...process.env, CLOUDFLARE_MODEL: model };
  const capacity = readProviderCapacityConfig("cloudflare_workers_ai", validationEnv);
  check(capacity.configured && capacity.model === model, "BLOCKED_CLOUDFLARE_CAPACITY");
  check(capacity.dailyNeuronAllocation === FREE_DAILY_NEURON_ALLOCATION, "BLOCKED_CLOUDFLARE_FREE_ALLOCATION");
  check(capacity.softLimitRatio === EXPECTED_SOFT_LIMIT_RATIO, "BLOCKED_CLOUDFLARE_SOFT_LIMIT");
  check(cloudflareModelPolicy[model].freeApproved
    && cloudflareModelPolicy[model].structuredProductionApproved === "CANDIDATE"
    && !cloudflareModelPolicy[model].productionRoutingEnabled, "BLOCKED_CLOUDFLARE_VALIDATION_ONLY_POLICY");
  check(cloudflareModelPolicy["@cf/openai/gpt-oss-20b"].structuredProductionApproved === false, "BLOCKED_GPT_OSS_MUST_REMAIN_UNAPPROVED");
  const rates = readCloudflareNeuronRates(process.env, model);
  check(rates.inputNeuronsPerMillionTokens === 26_668
    && rates.outputNeuronsPerMillionTokens === 204_805
    && rates.safetyMarginBps === 12_500, "BLOCKED_CLOUDFLARE_RATE_OR_MARGIN_MISMATCH");
  assertFreeProviderRequest("cloudflare_workers_ai", model, capacity.endpoint);

  const eventKey = EVENT_KEY_PREFIX + randomUUID();
  const input = fixtureForEvent(eventKey);
  const registry = await loadActiveReferenceRegistry();
  const prechecks = runCriticPrechecks(input, { registry });
  check(prechecks.passed, "BLOCKED_CRITIC_FIXTURE_PRECHECK_FAILED");
  const inputBuild = makeReportInput(input);
  check(inputBuild.built.evidenceCatalog.length > 0, "BLOCKED_CRITIC_FIXTURE_HAS_NO_EVIDENCE");
  check(inputBuild.built.evidenceCatalog.every((entry, index) => entry.evidenceIndex === index), "BLOCKED_CRITIC_FIXTURE_EVIDENCE_INDICES_INVALID");

  const modelConfig: ModelConfig = {
    ...configuredCritic,
    model,
    maxRetries: MAX_RETRIES,
    dailyRequestLimit: MAX_REQUESTS,
  };
  check(modelConfig.maxRetries === 0 && modelConfig.dailyRequestLimit === 1, "BLOCKED_ONE_SHOT_GUARD");
  check(modelConfig.failOnRateLimit && !modelConfig.allowPaidFallback, "BLOCKED_COST_POLICY");
  check(modelConfig.maxOutputTokens === configuredCritic.maxOutputTokens, "BLOCKED_OUTPUT_BUDGET_CHANGED");

  const estimatedNeurons = estimateCloudflareNeurons({
    inputTokens: inputBuild.estimatedInputTokens,
    outputTokens: modelConfig.maxOutputTokens,
    ...rates,
  });
  const db = createSupabaseServerClient();
  const logger = new SupabaseAgentLogger(db);
  const requestDate = utcToday();
  const usage = await logger.getProviderDailyUsage("cloudflare_workers_ai", requestDate);
  const baseline = createCloudflareAccountingBaseline(usage, new Date());
  assertCloudflareUtcPeriod(baseline.utcDate);
  const capacityCheck = checkCloudflareBaselineCapacity({
    baseline,
    dailyNeuronAllocation: capacity.dailyNeuronAllocation!,
    estimatedNextRequestNeurons: estimatedNeurons,
    ...(capacity.dailyRequestLimit === undefined ? {} : { dailyRequestLimit: capacity.dailyRequestLimit }),
    softLimitRatio: capacity.softLimitRatio,
  });
  const articlesBefore = await exactCount(db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE");
  const eventAttemptsBefore = await exactCount(
    db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }).eq("event_key", eventKey),
    "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE",
  );
  check(eventAttemptsBefore === 0, "BLOCKED_VALIDATION_EVENT_ATTEMPT_ALREADY_EXISTS");

  return {
    db, logger, baseline, eventKey, input, registry, modelConfig, capacity, rates,
    estimatedInputTokens: inputBuild.estimatedInputTokens,
    estimatedNeurons,
    projectedReservedNeurons: baseline.reservedEstimatedNeurons + estimatedNeurons,
    projectedSoftRemainingNeurons: capacityCheck.softRemainingAfterReservation,
    articlesBefore,
    eventAttemptsBefore,
    expectedPromptChars: inputBuild.promptChars,
    expectedInputJsonChars: inputBuild.inputJsonChars,
    expectedSchemaJsonChars: inputBuild.schemaJsonChars,
  };
}

function preflightReport(context: Preflight) {
  return {
    status: "PRE_FLIGHT_READY_FOR_ONE_SHOT_VALIDATION",
    inferenceNetworkDisabled: true,
    provider: "cloudflare_workers_ai",
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    validationPurpose: VALIDATION_PURPOSE,
    criticVersion: criticAgentVersion,
    routingVersion: criticRoutingVersion,
    fixtureOrigin: "existing critic:unit canonicalCriticInput",
    fixtureEventKeyIsSynthetic: true,
    deterministicPrechecks: "PASS",
    evidenceCatalog: "PASS",
    configuredProductionProvider: "groq",
    configuredProductionCriticModel: getCriticModelConfig().model,
    productionRouterEnabled: false,
    paidPathEnabled: false,
    outputTokensUsed: context.modelConfig.maxOutputTokens,
    structuredOutputMode: context.modelConfig.structuredOutputMode,
    maxRetries: context.modelConfig.maxRetries,
    localRequestLimit: context.modelConfig.dailyRequestLimit,
    configuredCloudflareDailyRequestLimit: context.capacity.dailyRequestLimit ?? "UNCONFIGURED_OPTIONAL",
    utcPeriod: context.baseline.utcDate,
    baselineCapturedAt: context.baseline.capturedAt,
    baselineReservations: context.baseline.reservations,
    baselineDispatchedRequests: context.baseline.dispatchedRequests,
    baselineReservedNeurons: context.baseline.reservedEstimatedNeurons,
    dailyHardAllocation: context.capacity.dailyNeuronAllocation,
    dailySoftAllocation: Math.floor(context.capacity.dailyNeuronAllocation! * context.capacity.softLimitRatio),
    estimatedPromptChars: context.expectedPromptChars,
    estimatedInputJsonChars: context.expectedInputJsonChars,
    estimatedStrictSchemaChars: context.expectedSchemaJsonChars,
    estimatedInputTokens: context.estimatedInputTokens,
    inputNeuronsPerMillionTokens: context.rates.inputNeuronsPerMillionTokens,
    outputNeuronsPerMillionTokens: context.rates.outputNeuronsPerMillionTokens,
    safetyMarginBps: context.rates.safetyMarginBps,
    estimatedCriticReservationNeurons: context.estimatedNeurons,
    projectedReservedNeurons: context.projectedReservedNeurons,
    projectedSoftRemainingNeurons: context.projectedSoftRemainingNeurons,
    preflightInferenceCalls: 0,
  };
}

function responseFormatValid(body: Record<string, unknown>, mode: ModelConfig["structuredOutputMode"]): boolean {
  const responseFormat = object(body.response_format);
  if (mode === "json_object") return responseFormat.type === "json_object";
  const schema = object(responseFormat.json_schema);
  return responseFormat.type === "json_schema" && schema.strict === (mode === "strict_schema");
}

function safeStatusFromError(error: unknown, httpStatus: number | undefined, finishReason: string | null | undefined, diagnostics: Record<string, unknown>): string {
  if (httpStatus === 200 && finishReason === "length") return "BLOCKED_OUTPUT_BUDGET";
  if (httpStatus === 200 && diagnostics.evidenceIndicesValid === false) return "BLOCKED_CLOUDFLARE_CRITIC_EVIDENCE";
  if (httpStatus === 200 && diagnostics.validationResult === "invalid") return "BLOCKED_CLOUDFLARE_CRITIC_CONTRACT";
  if (httpStatus === 429) return "PROVIDER_RATE_LIMIT";
  if (httpStatus === 401 || httpStatus === 403) return "BLOCKED_CLOUDFLARE_AUTH";
  if (httpStatus === 400 || httpStatus === 413) return "BLOCKED_CLOUDFLARE_CRITIC_CONTRACT";
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "CANONICAL_PROVIDER_OR_RUNTIME_ERROR";
}

async function executeOneShot(context: Preflight): Promise<void> {
  const report = preflightReport(context);
  console.log(JSON.stringify(report, null, 2));

  const logger = new CriticValidationLogger(
    context.db,
    context.capacity.dailyNeuronAllocation!,
    context.capacity.dailyRequestLimit ?? null,
    context.estimatedNeurons,
    context.baseline,
  );
  let externalRequests = 0;
  const endpoint = context.capacity.endpoint;
  const guardedFetch: typeof fetch = async (url, init) => {
    assertCloudflareUtcPeriod(context.baseline.utcDate);
    check(String(url) === endpoint, "BLOCKED_NON_CLOUDFLARE_ENDPOINT");
    const body = object(JSON.parse(String(init?.body ?? "{}")) as unknown);
    check(body.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_NON_ALLOWLISTED_MODEL");
    check(body.max_tokens === context.modelConfig.maxOutputTokens && !("max_completion_tokens" in body), "BLOCKED_OUTPUT_TOKEN_FIELD");
    check(body.stream === false && !("tools" in body), "BLOCKED_STREAM_OR_TOOLS");
    check(responseFormatValid(body, context.modelConfig.structuredOutputMode), "BLOCKED_STRUCTURED_OUTPUT_MODE");
    check(externalRequests < MAX_REQUESTS, "BLOCKED_MORE_THAN_ONE_CLOUDFLARE_REQUEST");
    externalRequests += 1;
    return fetch(url, init);
  };
  const provider = createCloudflareWorkersAIValidationCandidateProvider(guardedFetch);
  check(provider instanceof CloudflareWorkersAIModelProvider && provider.providerId === "cloudflare_workers_ai", "BLOCKED_NON_CLOUDFLARE_PROVIDER");

  let result: Awaited<ReturnType<CriticAgent["critique"]>> | null = null;
  let failure: unknown;
  try {
    result = await new CriticAgent(provider, logger).critique(context.input, {
      modelConfig: context.modelConfig,
      requestBudget: new DailyRequestBudget(() => new Date()),
      dryRun: true,
      registry: context.registry,
    });
  } catch (error) {
    failure = error;
  }

  const failureDetails = failure ? getAgentFailureDetails(failure) : null;
  const diagnostics = object(result?.diagnostics ?? failureDetails?.diagnostics ?? failureDetails?.telemetry);
  const usage = object(result?.usage ?? diagnostics.usage);
  const attempts = result?.attempts ?? failureDetails?.attempts ?? 0;
  const retries = Math.max(0, attempts - 1);
  const httpStatus = typeof diagnostics.httpStatus === "number" ? diagnostics.httpStatus : undefined;
  const finishReason = typeof diagnostics.finishReason === "string" ? diagnostics.finishReason : null;
  const generationZodValid = result !== null || diagnostics.validationResult === "valid";
  const finalZodValid = result ? criticResultSchema.safeParse(result.output).success : false;
  const deterministicPrechecksPassed = result?.prechecks.passed === true || diagnostics.deterministicPrechecksPassed === true;
  const evidenceResolutionPassed = result?.diagnostics?.evidenceRefsValidated === true
    && result?.diagnostics?.evidenceIndicesValid !== false
    || diagnostics.evidenceRefsValidated === true && diagnostics.evidenceIndicesValid !== false;
  const canonicalDecision = result?.output.decision ?? null;
  const canonicalDecisionValid = canonicalDecision !== null && criticResultSchema.shape.decision.safeParse(canonicalDecision).success;
  const effectiveModelMatches = result?.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL;
  const outputLength = finishReason === "length";
  const contractPass = httpStatus === 200 && !outputLength && generationZodValid && finalZodValid
    && deterministicPrechecksPassed && evidenceResolutionPassed && canonicalDecisionValid
    && effectiveModelMatches && attempts === 1 && retries === 0 && externalRequests === 1;
  const tokenInput = typeof usage.inputTokens === "number" ? usage.inputTokens : null;
  const tokenOutput = typeof usage.outputTokens === "number" ? usage.outputTokens : null;
  const tokenTotal = typeof usage.totalTokens === "number" ? usage.totalTokens : null;
  const postResponseNeuronEstimate = tokenInput !== null && tokenOutput !== null
    ? estimateCloudflareNeurons({
      inputTokens: tokenInput,
      outputTokens: tokenOutput,
      ...context.rates,
    })
    : null;

  assertCloudflareUtcPeriod(context.baseline.utcDate);
  const finalUsage = await logger.getProviderDailyUsage("cloudflare_workers_ai", context.baseline.utcDate);
  const accountingDelta = cloudflareAccountingDelta(context.baseline, finalUsage);
  let accountingPass = false;
  if (externalRequests === 1) {
    try {
      assertCloudflareOneRequestDelta(accountingDelta, context.estimatedNeurons);
      accountingPass = true;
    } catch {
      accountingPass = false;
    }
  } else {
    accountingPass = accountingDelta.reservations === 0
      && accountingDelta.dispatchedRequests === 0
      && accountingDelta.reservedEstimatedNeurons === 0;
  }

  const attemptCountAfter = await exactCount(
    context.db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }).eq("event_key", context.eventKey),
    "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE_AFTER_RUN",
  );
  const articlesAfter = await exactCount(context.db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE_AFTER_RUN");
  const sideEffectsPass = attemptCountAfter === context.eventAttemptsBefore
    && articlesAfter === context.articlesBefore;

  const runId = result?.runId ?? logger.runId;
  let telemetryPass = false;
  let secretsPersisted = false;
  if (runId) {
    const run = await context.db.from("agent_runs").select("id,status,provider,config,stats,finished_at").eq("id", runId).maybeSingle();
    const logs = await context.db.from("agent_logs").select("step,payload,provider").eq("run_id", runId);
    if (!run.error && run.data && !logs.error && logs.data) {
      const serialized = JSON.stringify([run.data.config, run.data.stats, logs.data]);
      const secretValues = ["AGENT_API_KEY", "CEREBRAS_API_KEY", "CLOUDFLARE_AI_API_TOKEN", "SUPABASE_SECRET_KEY"]
        .map((name) => process.env[name]?.trim())
        .filter((value): value is string => Boolean(value));
      secretsPersisted = secretValues.some((secret) => serialized.includes(secret));
      const persistedStats = object(run.data.stats);
      const persistedTelemetry = object(persistedStats.telemetry);
      telemetryPass = run.data.provider === "cloudflare_workers_ai"
        && run.data.status === "succeeded"
        && object(run.data.config).validationPurpose === VALIDATION_PURPOSE
        && persistedTelemetry.provider === "cloudflare_workers_ai"
        && persistedTelemetry.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL
        && typeof persistedTelemetry.providerHttpStatus === "number"
        && typeof persistedTelemetry.attempts === "number"
        && typeof persistedTelemetry.latencyMs === "number"
        && logs.data.some((entry) => entry.step === "provider_request_reserved")
        && logs.data.some((entry) => entry.step === "completed" || entry.step === "failed");
    }
  }

  const stageStatus = contractPass && accountingPass && sideEffectsPass && telemetryPass && !secretsPersisted
    ? "REAL_VALIDATED"
    : "NOT_VALIDATED";
  if (runId) {
    const metadata: AgentRunMetadata = {
      agentName: "critic",
      agentVersion: criticAgentVersion,
      eventKey: context.eventKey,
      model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
      provider: "cloudflare_workers_ai",
      dryRun: true,
    };
    await logger.log(runId, metadata, {
      level: stageStatus === "REAL_VALIDATED" ? "info" : "warn",
      step: "critic_stage_validation_result",
      message: "Supervised Critic stage validation completed",
      payload: {
        validationPurpose: VALIDATION_PURPOSE,
        stageValidationStatus: stageStatus,
        agentVersion: criticAgentVersion,
        routingVersion: criticRoutingVersion,
        provider: "cloudflare_workers_ai",
        model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
        httpStatus: httpStatus ?? null,
        finishReason,
        attempts,
        retries,
        inputTokens: tokenInput,
        outputTokens: tokenOutput,
        totalTokens: tokenTotal,
        estimatedReservationNeurons: context.estimatedNeurons,
        postResponseNeuronEstimate,
        actualNeurons: "UNKNOWN",
        zodValid: generationZodValid && finalZodValid,
        deterministicPrechecksPassed,
        evidenceResolutionPassed,
        canonicalDecision,
        findingsCount: result?.generation.findings.length ?? null,
      } as unknown as Json,
    });
  }

  if (externalRequests === 0
    && logger.runId
    && accountingDelta.reservations === 0
    && accountingDelta.dispatchedRequests === 0) {
    await logger.cleanupUndispatchedRun();
  }

  const safeResult = {
    status: stageStatus,
    validationPurpose: VALIDATION_PURPOSE,
    provider: "cloudflare_workers_ai",
    model: result?.model ?? CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    criticVersion: criticAgentVersion,
    routingVersion: criticRoutingVersion,
    fixtureOrigin: "existing critic:unit canonicalCriticInput",
    dryRun: true,
    newCloudflareInferenceCalls: externalRequests,
    groqCalls: 0,
    cerebrasCalls: 0,
    otherAgentCalls: 0,
    httpStatus: httpStatus ?? "UNKNOWN",
    finishReason: finishReason ?? "UNKNOWN",
    criticGenerationZod: generationZodValid ? "PASS" : "FAIL",
    criticResultZod: finalZodValid ? "PASS" : "FAIL",
    deterministicPrechecks: deterministicPrechecksPassed ? "PASS" : "FAIL",
    evidenceResolution: evidenceResolutionPassed ? "PASS" : "FAIL",
    canonicalDecision,
    canonicalDecisionValid,
    effectiveModelMatches,
    findingsCount: result?.generation.findings.length ?? "UNKNOWN",
    responseRepair: "NO",
    attempts,
    retries,
    inputTokens: tokenInput ?? "UNKNOWN",
    outputTokens: tokenOutput ?? "UNKNOWN",
    totalTokens: tokenTotal ?? "UNKNOWN",
    latencyMs: result?.latencyMs ?? failureDetails?.latencyMs ?? "UNKNOWN",
    requestBytes: object(diagnostics.requestMetrics).bodyBytes ?? "UNKNOWN",
    responseBytes: diagnostics.responseBodyBytes ?? "UNKNOWN",
    maxOutputTokens: context.modelConfig.maxOutputTokens,
    estimatedReservationNeurons: context.estimatedNeurons,
    postResponseNeuronEstimate: postResponseNeuronEstimate ?? "UNKNOWN",
    actualNeurons: diagnostics.actualProviderUnitUsage ?? "UNKNOWN",
    baselineReservations: context.baseline.reservations,
    baselineDispatched: context.baseline.dispatchedRequests,
    baselineReservedNeurons: context.baseline.reservedEstimatedNeurons,
    reservationDelta: accountingDelta.reservations,
    dispatchDelta: accountingDelta.dispatchedRequests,
    reservedNeuronDelta: accountingDelta.reservedEstimatedNeurons,
    postReservations: finalUsage.requestsReserved,
    postDispatched: finalUsage.requestsDispatched,
    postReservedNeurons: finalUsage.neuronsUsed,
    projectedSoftRemainingNeurons: context.projectedSoftRemainingNeurons,
    accounting: accountingPass ? "PASS" : "FAIL",
    telemetryPersisted: telemetryPass ? "PASS" : "FAIL",
    secretPersisted: secretsPersisted ? "YES" : "NO",
    productionEventAttemptsCreated: attemptCountAfter - context.eventAttemptsBefore,
    articlesCreatedByValidation: articlesAfter - context.articlesBefore,
    productionRouterEnabled: false,
    paidPathEnabled: false,
    errorClassification: failure ? safeStatusFromError(failure, httpStatus, finishReason, diagnostics) : null,
    ready: stageStatus === "REAL_VALIDATED",
  };
  console.log(JSON.stringify(safeResult, null, 2));
  if (stageStatus !== "REAL_VALIDATED") process.exitCode = 1;
}

const args = process.argv.slice(2);
if (args.length !== 1 || (args[0] !== "--preflight" && args[0] !== "--execute-one-shot")) {
  console.error("BLOCKED: specify exactly --preflight or --execute-one-shot.");
  process.exitCode = 1;
} else {
  try {
    const context = await preparePreflight();
    if (args[0] === "--preflight") console.log(JSON.stringify(preflightReport(context), null, 2));
    else await executeOneShot(context);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "PREFLIGHT_BLOCKED";
    console.error(JSON.stringify({
      status: "PREFLIGHT_BLOCKED",
      inferenceNetworkDisabled: true,
      errorCode: code,
      provider: "cloudflare_workers_ai",
      model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
      newCloudflareInferenceCalls: 0,
    }, null, 2));
    process.exitCode = 1;
  }
}
