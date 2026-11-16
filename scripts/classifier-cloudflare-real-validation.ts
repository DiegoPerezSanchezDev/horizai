import { randomUUID } from "node:crypto";
import { getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import {
  assertCloudflareNoRequestDelta,
  assertCloudflareOneRequestDelta,
  assertCloudflareUtcPeriod,
  checkCloudflareBaselineCapacity,
  cloudflareAccountingDelta,
  createCloudflareAccountingBaseline,
  type CloudflareAccountingBaseline,
} from "../lib/agents/runtime/provider-accounting-baseline.ts";
import {
  estimateCloudflareNeurons,
  freeProviderRouterEnabled,
  readCloudflareNeuronRates,
  readProviderCapacityConfig,
} from "../lib/agents/runtime/free-provider-router.ts";
import {
  assertFreeProviderRequest,
  CLOUDFLARE_LLAMA_VALIDATION_MODEL,
  cloudflareModelPolicy,
  freeProviderPolicy,
} from "../lib/agents/runtime/provider-cost-policy.ts";
import {
  createCloudflareWorkersAIValidationCandidateProvider,
  CloudflareWorkersAIModelProvider,
} from "../lib/agents/runtime/cloudflare-workers-ai-provider.ts";
import {
  createSupervisedValidationEventKey,
  supervisedValidationFixtureAllowlist,
  validateSupervisedCloudflareStageValidation,
} from "../lib/agents/runtime/cloudflare-stage-validation.ts";
import { toStrictProviderJsonSchema } from "../lib/agents/runtime/strict-json-schema.ts";
import type { AgentRunMetadata, ModelConfig, ProviderDiagnostics, RequestReservation } from "../lib/agents/runtime/runtime-types.ts";
import { classificationResultSchema } from "../lib/agents/contracts/index.ts";
import {
  ClassifierAgent,
  classifierAgentVersion,
  classifierGenerationSchema,
  classifierSystemInstructions,
  getClassifierModelConfig,
} from "../lib/agents/classifier/classifier-agent.ts";
import { buildClassifierModelInput } from "../lib/agents/classifier/classifier-input.ts";
import { classifierFixtureRegistry, classifierFixtures } from "../lib/agents/classifier/classifier-fixtures.ts";
import type { ClassifierInput, ClassifierModelInput } from "../lib/agents/classifier/classifier-types.ts";
import { normalizeEntityGroups } from "../lib/agents/classifier/classifier-normalizer.ts";
import { resolveGeo } from "../lib/agents/classifier/geo-resolver.ts";
import type { ReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import type { Json } from "../types/database.ts";

const STAGE = "classifier" as const;
const FIXTURE = supervisedValidationFixtureAllowlist[STAGE];
const PURPOSE = "classifier_stage_validation" as const;
const PROVIDER = "cloudflare_workers_ai" as const;
const DAILY_HARD_NEURON_ALLOCATION = 10_000;
const EXPECTED_SOFT_LIMIT_RATIO = 0.85;
const MAX_CALLS = 1;
const MAX_RETRIES = 0;
const EXPECTED_OUTPUT_TOKENS = 1_200;
let dispatchedInferenceCalls = 0;

type JsonObject = Record<string, unknown>;
type Db = ReturnType<typeof createSupabaseServerClient>;

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`BLOCKED_MISSING_${name}`);
  return value;
}

async function exactCount(
  query: PromiseLike<{ count: number | null; error: { message: string } | null }>,
  code: string,
): Promise<number> {
  const response = await query;
  if (response.error || response.count === null) throw new Error(code);
  return response.count;
}

function fixtureForEvent(eventKey: string): ClassifierInput {
  const fixture = classifierFixtures[0];
  check(fixture.name === "fixture-new-openai-model" && FIXTURE === "classifier:fixture-new-openai-model", "BLOCKED_UNEXPECTED_CANONICAL_CLASSIFIER_FIXTURE");
  const input = structuredClone(fixture.input) as ClassifierInput;
  input.event.eventKey = eventKey;
  return input;
}

function utcDayCapacityCheck(
  baseline: CloudflareAccountingBaseline,
  capacity: ReturnType<typeof readProviderCapacityConfig>,
  estimatedNeurons: number,
) {
  return checkCloudflareBaselineCapacity({
    baseline,
    dailyNeuronAllocation: capacity.dailyNeuronAllocation!,
    estimatedNextRequestNeurons: estimatedNeurons,
    ...(capacity.dailyRequestLimit === undefined ? {} : { dailyRequestLimit: capacity.dailyRequestLimit }),
    softLimitRatio: capacity.softLimitRatio,
  });
}

type Preflight = {
  db: Db;
  baseline: CloudflareAccountingBaseline;
  expectedUtcDate: string;
  eventKey: string;
  input: ClassifierInput;
  modelInput: ClassifierModelInput;
  modelConfig: ModelConfig;
  capacity: ReturnType<typeof readProviderCapacityConfig>;
  rates: ReturnType<typeof readCloudflareNeuronRates>;
  registry: ReferenceRegistry;
  estimatedInputTokens: number;
  estimatedNeurons: number;
  projectedReservedNeurons: number;
  softAllocation: number;
  projectedSoftRemainingNeurons: number;
  fixtureInputChars: number;
  strictSchemaChars: number;
  articlesBefore: number;
  syntheticEventAttemptsBefore: number;
  agentRunsBefore: number;
  productionModel: string;
};

async function assertMigration24Capability(db: Db, requestDate: string): Promise<void> {
  const probe = await db.rpc("reserve_cloudflare_supervised_stage_validation_capacity", {
    p_run_id: randomUUID(),
    p_stage: "__preflight_invalid__" as never,
    p_agent_name: STAGE,
    p_agent_version: classifierAgentVersion,
    p_event_key: "not-a-validation-event",
    p_fixture: FIXTURE,
    p_attempt: 1,
    p_validation_purpose: PURPOSE,
    p_provider: PROVIDER,
    p_model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    p_request_date: requestDate,
    p_request_limit: 1,
    p_daily_neuron_allocation: DAILY_HARD_NEURON_ALLOCATION,
    p_estimated_neurons: 1,
  });
  check(
    probe.error !== null && probe.error.message.includes("stage is outside the supervised validation allowlist"),
    "BLOCKED_MIGRATION24_RPC_OR_SERVICE_ROLE",
  );
}

async function readBaseline(db: Db, expectedUtcDate?: string): Promise<CloudflareAccountingBaseline> {
  const beforeRead = new Date();
  const requestDate = utcToday(beforeRead);
  if (expectedUtcDate !== undefined) check(requestDate === expectedUtcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_CHANGED");
  const usage = await new SupabaseAgentLogger(db).getProviderDailyUsage(PROVIDER, requestDate);
  const capturedAt = new Date();
  check(utcToday(capturedAt) === requestDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_CHANGED");
  const baseline = createCloudflareAccountingBaseline(usage, capturedAt);
  assertCloudflareUtcPeriod(requestDate, capturedAt);
  return baseline;
}

async function preparePreflight(): Promise<Preflight> {
  const productionConfig = getClassifierModelConfig();
  check(process.env.AGENT_PROVIDER?.trim().toLowerCase() === "groq", "BLOCKED_PRODUCTION_PROVIDER_CHANGED");
  check((freeProviderPolicy.groq.approvedModels as readonly string[]).includes(productionConfig.model), "BLOCKED_PRODUCTION_CLASSIFIER_MODEL_NOT_FREE_APPROVED");
  check(productionConfig.allowPaidFallback === false && productionConfig.failOnRateLimit, "BLOCKED_PRODUCTION_COST_POLICY");
  check(!freeProviderRouterEnabled(), "BLOCKED_PRODUCTION_ROUTER_MUST_REMAIN_DISABLED");
  check(classifierAgentVersion === "classifier-v1", "BLOCKED_UNEXPECTED_CLASSIFIER_VERSION");
  check(productionConfig.maxOutputTokens === EXPECTED_OUTPUT_TOKENS, "BLOCKED_CLASSIFIER_OUTPUT_BUDGET_CHANGED");

  const validation = validateSupervisedCloudflareStageValidation({
    stage: STAGE,
    fixture: FIXTURE,
    provider: PROVIDER,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    agentVersion: classifierAgentVersion,
    maxAttempts: MAX_CALLS,
    maxRetries: MAX_RETRIES,
  });
  check(validation.validationPurpose === PURPOSE && validation.agentVersion === classifierAgentVersion, "BLOCKED_SUPERVISED_IDENTITY_MISMATCH");

  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  requiredEnv("CLOUDFLARE_AI_API_TOKEN");
  const validationEnv = { ...process.env, CLOUDFLARE_MODEL: CLOUDFLARE_LLAMA_VALIDATION_MODEL };
  const capacity = readProviderCapacityConfig(PROVIDER, validationEnv);
  check(capacity.configured && capacity.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_CLOUDFLARE_CONFIGURATION");
  check(capacity.dailyNeuronAllocation === DAILY_HARD_NEURON_ALLOCATION, "BLOCKED_CLOUDFLARE_HARD_ALLOCATION");
  check(capacity.softLimitRatio === EXPECTED_SOFT_LIMIT_RATIO, "BLOCKED_CLOUDFLARE_SOFT_ALLOCATION");
  check(cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].freeApproved
    && cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].structuredProductionApproved === "CANDIDATE"
    && !cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].productionRoutingEnabled,
  "BLOCKED_CLOUDFLARE_VALIDATION_ONLY_POLICY");
  assertFreeProviderRequest(PROVIDER, CLOUDFLARE_LLAMA_VALIDATION_MODEL, capacity.endpoint);
  check(capacity.endpoint === `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`, "BLOCKED_CLOUDFLARE_ENDPOINT_MISMATCH");

  const modelConfig: ModelConfig = {
    ...productionConfig,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    maxRetries: MAX_RETRIES,
    dailyRequestLimit: MAX_CALLS,
  };
  check(modelConfig.maxRetries === 0 && modelConfig.dailyRequestLimit === 1, "BLOCKED_ONE_SHOT_GUARD");
  check(modelConfig.maxOutputTokens === EXPECTED_OUTPUT_TOKENS && modelConfig.allowPaidFallback === false, "BLOCKED_CLASSIFIER_BUDGET_OR_PAID_PATH");

  check(!Object.hasOwn(classifierGenerationSchema.shape, "latitude") && !Object.hasOwn(classifierGenerationSchema.shape, "longitude"), "BLOCKED_GEO_MUST_REMAIN_DETERMINISTIC");
  const eventKey = createSupervisedValidationEventKey(STAGE, randomUUID());
  const input = fixtureForEvent(eventKey);
  const registry = classifierFixtureRegistry;
  const builtInput = buildClassifierModelInput(input, {
    regionCodes: [...registry.regions.keys()],
    categorySlugs: [...registry.categories.keys()],
  });
  check(builtInput.input.allowedCategorySlugs.length === registry.categories.size && registry.categories.has("modelos"), "BLOCKED_CANONICAL_CATEGORY_REGISTRY_INVALID");
  check(builtInput.input.allowedRegionCodes.length === registry.regions.size && registry.regions.has("US"), "BLOCKED_CANONICAL_REGION_REGISTRY_INVALID");
  const strictSchemaChars = JSON.stringify(toStrictProviderJsonSchema(classifierGenerationSchema)).length;
  const estimatedInputTokens = Math.ceil((classifierSystemInstructions.length + JSON.stringify(builtInput.input).length + strictSchemaChars) / 2) + 128;
  const rates = readCloudflareNeuronRates(process.env, CLOUDFLARE_LLAMA_VALIDATION_MODEL);
  const estimatedNeurons = estimateCloudflareNeurons({ inputTokens: estimatedInputTokens, outputTokens: modelConfig.maxOutputTokens, ...rates });

  requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  requiredEnv("SUPABASE_SECRET_KEY");
  const db = createSupabaseServerClient();
  const expectedUtcDate = utcToday();
  await assertMigration24Capability(db, expectedUtcDate);
  const baseline = await readBaseline(db, expectedUtcDate);
  const capacityCheck = utcDayCapacityCheck(baseline, capacity, estimatedNeurons);
  check(baseline.reservedEstimatedNeurons + estimatedNeurons <= DAILY_HARD_NEURON_ALLOCATION, "BLOCKED_HARD_CAPACITY_INSUFFICIENT");

  const articlesBefore = await exactCount(db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE");
  const syntheticEventAttemptsBefore = await exactCount(
    db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }).eq("event_key", eventKey),
    "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE",
  );
  check(syntheticEventAttemptsBefore === 0, "BLOCKED_VALIDATION_EVENT_ATTEMPT_ALREADY_EXISTS");
  const agentRunsBefore = await exactCount(db.from("agent_runs").select("id", { count: "exact", head: true }), "BLOCKED_AGENT_RUN_COUNT_UNAVAILABLE");

  return {
    db,
    baseline,
    expectedUtcDate,
    eventKey,
    input,
    modelInput: builtInput.input,
    modelConfig,
    capacity,
    rates,
    registry,
    estimatedInputTokens,
    estimatedNeurons,
    projectedReservedNeurons: baseline.reservedEstimatedNeurons + estimatedNeurons,
    softAllocation: Math.floor(capacity.dailyNeuronAllocation! * capacity.softLimitRatio),
    projectedSoftRemainingNeurons: capacityCheck.softRemainingAfterReservation,
    fixtureInputChars: builtInput.inputChars,
    strictSchemaChars,
    articlesBefore,
    syntheticEventAttemptsBefore,
    agentRunsBefore,
    productionModel: productionConfig.model,
  };
}

function preflightReport(context: Preflight) {
  return {
    status: "PRE_FLIGHT_READY_FOR_ONE_SHOT_VALIDATION",
    inferenceCalls: 0,
    migration24: "REUSED_REMOTE_AND_RPC_CAPABILITY_CONFIRMED",
    newMigrationRequired: false,
    stage: STAGE,
    validationPurpose: PURPOSE,
    agentVersion: classifierAgentVersion,
    fixture: FIXTURE,
    fixtureOrigin: "classifierFixtures[0] shared with classifier:unit; synthetic controlled material",
    syntheticEventKey: true,
    provider: PROVIDER,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    productionProvider: "groq",
    productionClassifierModel: context.productionModel,
    productionRouterEnabled: freeProviderRouterEnabled(),
    paidFallbackEnabled: context.modelConfig.allowPaidFallback,
    structuredOutputMode: context.modelConfig.structuredOutputMode,
    maxOutputTokens: context.modelConfig.maxOutputTokens,
    providerTokenField: "max_tokens",
    maxRetries: context.modelConfig.maxRetries,
    maxCalls: MAX_CALLS,
    utcPeriod: context.baseline.utcDate,
    baselineCapturedAt: context.baseline.capturedAt,
    baselineReservations: context.baseline.reservations,
    baselineDispatchedRequests: context.baseline.dispatchedRequests,
    baselineReservedNeurons: context.baseline.reservedEstimatedNeurons,
    hardAllocationNeurons: context.capacity.dailyNeuronAllocation,
    softAllocationNeurons: context.softAllocation,
    estimatedClassifierReservationNeurons: context.estimatedNeurons,
    projectedReservedNeurons: context.projectedReservedNeurons,
    projectedSoftRemainingNeurons: context.projectedSoftRemainingNeurons,
    systemPromptChars: classifierSystemInstructions.length,
    fixtureInputChars: context.fixtureInputChars,
    strictSchemaChars: context.strictSchemaChars,
    estimatedInputTokens: context.estimatedInputTokens,
    neuronRates: context.rates,
    fixtureRegistry: { regions: context.registry.regions.size, categories: context.registry.categories.size },
    allowedCategoryCount: context.modelInput.allowedCategorySlugs.length,
    allowedRegionCount: context.modelInput.allowedRegionCodes.length,
    categoryRules: { minimum: 0, maximum: 3, duplicates: "rejected by generation schema", ordering: "preserved; no sorting rule" },
    geographicOwnership: "deterministic; model output schema has no coordinates",
    productionArticlesBefore: context.articlesBefore,
    productionEventAttemptsBefore: context.syntheticEventAttemptsBefore,
    productionAgentRunsBefore: context.agentRunsBefore,
    semanticCategoryQuality: "NOT_CERTIFIED",
  };
}

class ClassifierValidationLogger extends SupabaseAgentLogger {
  private readonly db: Db;
  private readonly context: Preflight;
  runId: string | null = null;

  constructor(db: Db, context: Preflight) {
    super(db);
    this.db = db;
    this.context = context;
  }

  override async startRun(metadata: AgentRunMetadata, startedAt: string): Promise<string | null> {
    check(metadata.provider === PROVIDER && metadata.agentName === STAGE, "BLOCKED_NON_CLASSIFIER_CLOUDFLARE_RUN");
    check(metadata.agentVersion === classifierAgentVersion && metadata.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_CLASSIFIER_IDENTITY_MISMATCH");
    check(metadata.eventKey === this.context.eventKey, "BLOCKED_NON_SYNTHETIC_VALIDATION_EVENT");
    this.runId = await super.startRun(metadata, startedAt);
    if (!this.runId) throw new Error("BLOCKED_VALIDATION_RUN_NOT_CREATED");
    const { error } = await this.db.from("agent_runs").update({
      config: {
        agentName: metadata.agentName,
        agentVersion: metadata.agentVersion,
        eventKey: metadata.eventKey,
        model: metadata.model,
        provider: metadata.provider,
        dryRun: true,
        validationPurpose: PURPOSE,
        fixture: FIXTURE,
        syntheticIdentity: true,
      },
    }).eq("id", this.runId);
    if (error) throw new Error("BLOCKED_VALIDATION_RUN_METADATA_NOT_PERSISTED");
    return this.runId;
  }

  override async reserveRequest(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    _localLimit: number,
    requestDate: string,
  ): Promise<RequestReservation> {
    assertCloudflareUtcPeriod(this.context.expectedUtcDate);
    check(requestDate === this.context.expectedUtcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
    const currentBaseline = await readBaseline(this.db, this.context.expectedUtcDate);
    const capacityCheck = utcDayCapacityCheck(currentBaseline, this.context.capacity, this.context.estimatedNeurons);
    this.context.baseline = currentBaseline;
    this.context.projectedReservedNeurons = currentBaseline.reservedEstimatedNeurons + this.context.estimatedNeurons;
    this.context.projectedSoftRemainingNeurons = capacityCheck.softRemainingAfterReservation;
    return this.reserveCloudflareSupervisedStageValidationCapacity(
      runId,
      metadata,
      STAGE,
      FIXTURE,
      attempt,
      this.context.capacity.dailyRequestLimit ?? null,
      requestDate,
      this.context.capacity.dailyNeuronAllocation!,
      this.context.estimatedNeurons,
    );
  }

  override async markRequestDispatched(runId: string | null, reservationId: number, requestDate: string): Promise<boolean> {
    assertCloudflareUtcPeriod(this.context.expectedUtcDate);
    check(requestDate === this.context.expectedUtcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
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

function responseFormatValid(body: JsonObject, mode: ModelConfig["structuredOutputMode"]): boolean {
  const format = object(body.response_format);
  if (mode === "json_object") return format.type === "json_object";
  const schema = object(format.json_schema);
  return format.type === "json_schema" && schema.strict === (mode === "strict_schema");
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function deterministicChecks(
  result: Awaited<ReturnType<ClassifierAgent["classify"]>> | null,
  context: Preflight,
): { resultZod: boolean; categoryRegistry: boolean; regionRegistry: boolean; geoRegistry: boolean; entityNormalization: boolean; overall: boolean } {
  const output = result?.output;
  if (!output || !result) return { resultZod: false, categoryRegistry: false, regionRegistry: false, geoRegistry: false, entityNormalization: false, overall: false };
  const resultZod = classificationResultSchema.safeParse(output).success;
  const categoryRegistry = output.categorySlugs.length <= 3
    && new Set(output.categorySlugs).size === output.categorySlugs.length
    && output.categorySlugs.every((slug) => context.registry.categories.has(slug));
  const regionRegistry = output.primaryRegionCode === null || context.registry.regions.has(output.primaryRegionCode);
  const resolved = resolveGeo({ regionCode: output.primaryRegionCode }, context.registry);
  const geoRegistry = output.latitude === resolved.latitude && output.longitude === resolved.longitude
    && result.geo.latitude === resolved.latitude && result.geo.longitude === resolved.longitude
    && result.geo.resolutionLevel === resolved.resolutionLevel && result.geo.resolvedFrom === resolved.resolvedFrom;
  const normalized = normalizeEntityGroups({
    companies: output.companies,
    models: output.models,
    people: output.people,
    technologies: output.technologies,
  });
  const entityNormalization = sameValues(output.companies, normalized.companies)
    && sameValues(output.models, normalized.models)
    && sameValues(output.people, normalized.people)
    && sameValues(output.technologies, normalized.technologies);
  const identifiers = output.eventKey === context.eventKey && output.schemaVersion === 1;
  return {
    resultZod,
    categoryRegistry,
    regionRegistry,
    geoRegistry,
    entityNormalization,
    overall: resultZod && categoryRegistry && regionRegistry && geoRegistry && entityNormalization && identifiers,
  };
}

function classifyFailure(error: unknown, diagnostics: ProviderDiagnostics): string {
  if (diagnostics.httpStatus === 429) return "PROVIDER_RATE_LIMIT";
  if (diagnostics.httpStatus === 401 || diagnostics.httpStatus === 403) return "BLOCKED_CLOUDFLARE_AUTH";
  if (diagnostics.httpStatus === 400 || diagnostics.httpStatus === 413) return "BLOCKED_CLOUDFLARE_CLASSIFIER_CONTRACT";
  if (diagnostics.httpStatus === 200 && diagnostics.finishReason === "length") return "BLOCKED_OUTPUT_BUDGET";
  if (error instanceof Error && /category outside the active registry/i.test(error.message)) return "BLOCKED_CLOUDFLARE_CLASSIFIER_CATEGORY";
  if (error instanceof Error && /region outside the active registry|non-ISO country code/i.test(error.message)) return "BLOCKED_CLOUDFLARE_CLASSIFIER_REGISTRY";
  if (diagnostics.httpStatus === 200 && (diagnostics.failureKind === "LOCAL_JSON_PARSE_ERROR" || diagnostics.failureKind === "LOCAL_SCHEMA_VALIDATION_ERROR")) return "BLOCKED_CLOUDFLARE_CLASSIFIER_CONTRACT";
  return "CANONICAL_PROVIDER_OR_RUNTIME_ERROR";
}

function sanitizedFailureDiagnostics(diagnostics: ProviderDiagnostics): JsonObject {
  return {
    httpStatus: diagnostics.httpStatus ?? null,
    finishReason: diagnostics.finishReason ?? null,
    failureKind: diagnostics.failureKind ?? null,
    validationResult: diagnostics.validationResult ?? null,
    invalidPaths: diagnostics.invalidPaths ?? [],
    missingFields: diagnostics.responseMissingTopLevelFields ?? diagnostics.failedGenerationMissingRequiredFields ?? [],
    zodIssues: (diagnostics.zodIssues ?? []).map(({ path, code }) => ({ path, code })),
  };
}

async function executeOneShot(context: Preflight): Promise<void> {
  context.baseline = await readBaseline(context.db, context.expectedUtcDate);
  const beforeCapacity = utcDayCapacityCheck(context.baseline, context.capacity, context.estimatedNeurons);
  context.projectedReservedNeurons = context.baseline.reservedEstimatedNeurons + context.estimatedNeurons;
  context.projectedSoftRemainingNeurons = beforeCapacity.softRemainingAfterReservation;
  process.stdout.write(`${JSON.stringify(preflightReport(context), null, 2)}\n`);

  const logger = new ClassifierValidationLogger(context.db, context);
  let externalCalls = 0;
  const guardedFetch: typeof fetch = async (url, init) => {
    check(externalCalls < MAX_CALLS, "BLOCKED_MORE_THAN_ONE_CLOUDFLARE_REQUEST");
    assertCloudflareUtcPeriod(context.expectedUtcDate);
    check(String(url) === context.capacity.endpoint, "BLOCKED_NON_CLOUDFLARE_ENDPOINT");
    check(init?.method === "POST", "BLOCKED_NON_POST_PROVIDER_REQUEST");
    const body = object(JSON.parse(String(init.body ?? "{}")) as unknown);
    check(body.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_NON_ALLOWLISTED_MODEL");
    check(body.max_tokens === context.modelConfig.maxOutputTokens && !Object.hasOwn(body, "max_completion_tokens"), "BLOCKED_CLOUDFLARE_OUTPUT_TOKEN_FIELD");
    check(body.stream === false && !Object.hasOwn(body, "tools") && !Object.hasOwn(body, "tool_choice"), "BLOCKED_TOOLS_OR_STREAMING_ENABLED");
    check(responseFormatValid(body, context.modelConfig.structuredOutputMode), "BLOCKED_CLASSIFIER_STRUCTURED_OUTPUT_MODE");
    externalCalls += 1;
    dispatchedInferenceCalls = externalCalls;
    return fetch(url, { ...init, redirect: "error" });
  };
  const provider = createCloudflareWorkersAIValidationCandidateProvider(guardedFetch);
  check(provider instanceof CloudflareWorkersAIModelProvider && provider.providerId === PROVIDER, "BLOCKED_NON_CLOUDFLARE_PROVIDER");

  let result: Awaited<ReturnType<ClassifierAgent["classify"]>> | null = null;
  let failure: unknown;
  try {
    result = await new ClassifierAgent(provider, logger).classify(context.input, {
      modelConfig: context.modelConfig,
      requestBudget: new DailyRequestBudget(() => new Date()),
      dryRun: true,
      registry: context.registry,
    });
  } catch (error) {
    failure = error;
  }

  const failureDetails = failure ? getAgentFailureDetails(failure) : null;
  const diagnostics = object(result?.diagnostics ?? failureDetails?.diagnostics ?? failureDetails?.telemetry) as ProviderDiagnostics;
  const usage = result?.usage ?? diagnostics.usage ?? {};
  const attempts = result?.attempts ?? failureDetails?.attempts ?? 0;
  const retries = Math.max(0, attempts - 1);
  const httpStatus = typeof diagnostics.httpStatus === "number" ? diagnostics.httpStatus : null;
  const finishReason = typeof diagnostics.finishReason === "string" ? diagnostics.finishReason : null;
  const checks = deterministicChecks(result, context);
  const attemptsPass = attempts === 1 && retries === 0 && externalCalls === 1 && result?.providerRequestsUsed === 1;
  const noTruncation = finishReason !== "length";
  const technicalPass = httpStatus === 200 && noTruncation && diagnostics.contentJsonParseable === true
    && diagnostics.validationResult === "valid" && checks.overall && attemptsPass
    && diagnostics.provider === PROVIDER && result?.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL;

  let delta = { reservations: 0, dispatchedRequests: 0, reservedEstimatedNeurons: 0 };
  let accountingPass = false;
  try {
    assertCloudflareUtcPeriod(context.expectedUtcDate);
    const after = await new SupabaseAgentLogger(context.db).getProviderDailyUsage(PROVIDER, context.expectedUtcDate);
    delta = cloudflareAccountingDelta(context.baseline, after);
    if (externalCalls === 1) assertCloudflareOneRequestDelta(delta, context.estimatedNeurons);
    else assertCloudflareNoRequestDelta(delta);
    accountingPass = true;
  } catch {
    accountingPass = false;
  }

  const articlesAfter = await exactCount(context.db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE_AFTER");
  const syntheticEventAttemptsAfter = await exactCount(
    context.db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }).eq("event_key", context.eventKey),
    "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE_AFTER",
  );
  const agentRunsAfter = await exactCount(context.db.from("agent_runs").select("id", { count: "exact", head: true }), "BLOCKED_AGENT_RUN_COUNT_UNAVAILABLE_AFTER");
  const sideEffectsPass = articlesAfter === context.articlesBefore
    && syntheticEventAttemptsAfter === context.syntheticEventAttemptsBefore
    && agentRunsAfter === context.agentRunsBefore + (logger.runId ? 1 : 0);

  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : null;
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : null;
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : null;
  const latencyMs = result?.latencyMs ?? failureDetails?.latencyMs ?? null;
  const requestBytes = typeof diagnostics.requestMetrics?.bodyBytes === "number" ? diagnostics.requestMetrics.bodyBytes : null;
  const responseBytes = typeof diagnostics.responseBodyBytes === "number" ? diagnostics.responseBodyBytes : null;
  const postResponseEstimate = inputTokens !== null && outputTokens !== null
    ? estimateCloudflareNeurons({ inputTokens, outputTokens, ...context.rates })
    : null;
  const actualNeurons = typeof diagnostics.actualProviderUnitUsage === "number" ? diagnostics.actualProviderUnitUsage : null;
  let validationLogPass = false;
  let secretsPersisted = false;
  let stageStatus = "NOT_VALIDATED";
  const runId = result?.runId ?? logger.runId;

  if (runId) {
    const metadata: AgentRunMetadata = {
      agentName: STAGE,
      agentVersion: classifierAgentVersion,
      eventKey: context.eventKey,
      model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
      provider: PROVIDER,
      dryRun: true,
    };
    const successfulContract = technicalPass && accountingPass && sideEffectsPass;
    stageStatus = successfulContract ? "REAL_VALIDATED" : "NOT_VALIDATED";
    try {
      await logger.log(runId, metadata, {
        level: successfulContract ? "info" : "warn",
        step: "classifier_stage_validation_result",
        message: "Supervised Classifier stage validation completed",
        payload: {
          validationPurpose: PURPOSE,
          fixture: FIXTURE,
          syntheticIdentity: true,
          stageValidationStatus: stageStatus,
          agentVersion: classifierAgentVersion,
          provider: PROVIDER,
          model: result?.model ?? CLOUDFLARE_LLAMA_VALIDATION_MODEL,
          httpStatus,
          finishReason,
          attempts,
          retries,
          latencyMs,
          inputTokens,
          outputTokens,
          totalTokens,
          requestBytes,
          responseBytes,
          estimatedReservationNeurons: context.estimatedNeurons,
          postResponseEstimatedNeurons: postResponseEstimate,
          actualNeurons: actualNeurons ?? "UNKNOWN",
          classificationResultZod: checks.resultZod,
          deterministicChecks: checks.overall,
          categoryRegistryValidation: checks.categoryRegistry,
          regionRegistryValidation: checks.regionRegistry,
          geoRegistryValidation: checks.geoRegistry,
          entityNormalization: checks.entityNormalization,
          categoryCount: result?.categoryCount ?? null,
          countryCount: result?.countryCount ?? null,
          entityCount: result?.entityCount ?? null,
          responseRepair: false,
          accountingDelta: delta,
          semanticCategoryQuality: "NOT_CERTIFIED",
        } as unknown as Json,
        durationMs: latencyMs ?? undefined,
      });

      const [runResponse, logsResponse] = await Promise.all([
        context.db.from("agent_runs").select("id,status,provider,dry_run,config,stats").eq("id", runId).maybeSingle(),
        context.db.from("agent_logs").select("step,payload,provider,provider_unit,provider_unit_amount").eq("run_id", runId),
      ]);
      if (!runResponse.error && runResponse.data && !logsResponse.error && logsResponse.data) {
        const serialized = JSON.stringify([runResponse.data.config, runResponse.data.stats, logsResponse.data]);
        const secretValues = ["AGENT_API_KEY", "CLOUDFLARE_AI_API_TOKEN", "SUPABASE_SECRET_KEY"]
          .map((name) => process.env[name]?.trim())
          .filter((value): value is string => Boolean(value));
        secretsPersisted = secretValues.some((secret) => serialized.includes(secret));
        const config = object(runResponse.data.config);
        const stats = object(runResponse.data.stats);
        const telemetry = object(stats.telemetry);
        const reservation = logsResponse.data.find((entry) => entry.step === "provider_request_reserved");
        const reservationPayload = object(reservation?.payload);
        const summaryLog = logsResponse.data.find((entry) => entry.step === "classifier_stage_validation_result");
        const summaryPayload = object(object(summaryLog?.payload).details);
        validationLogPass = runResponse.data.provider === PROVIDER
          && runResponse.data.status === "succeeded"
          && runResponse.data.dry_run === true
          && config.validationPurpose === PURPOSE
          && config.fixture === FIXTURE
          && config.agentVersion === classifierAgentVersion
          && telemetry.provider === PROVIDER
          && telemetry.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL
          && telemetry.providerHttpStatus === 200
          && telemetry.attempts === 1
          && telemetry.retries === 0
          && typeof telemetry.latencyMs === "number"
          && reservation?.provider === PROVIDER
          && reservation.provider_unit === "neurons"
          && reservation.provider_unit_amount === context.estimatedNeurons
          && reservationPayload.providerRequestDispatched === true
          && summaryPayload.stageValidationStatus === stageStatus
          && summaryPayload.classificationResultZod === checks.resultZod
          && summaryPayload.categoryRegistryValidation === checks.categoryRegistry
          && logsResponse.data.some((entry) => entry.step === "completed");
      }
    } catch {
      validationLogPass = false;
    }
  }

  if (externalCalls === 0 && logger.runId && delta.reservations === 0 && delta.dispatchedRequests === 0) {
    await logger.cleanupUndispatchedRun();
  }

  const ready = stageStatus === "REAL_VALIDATED" && accountingPass && sideEffectsPass && validationLogPass && !secretsPersisted;
  const finalUsage = await new SupabaseAgentLogger(context.db).getProviderDailyUsage(PROVIDER, context.expectedUtcDate).catch(() => null);
  const finalDelta = finalUsage ? cloudflareAccountingDelta(context.baseline, finalUsage) : delta;
  const failureCode = ready ? "NONE" : classifyFailure(failure, diagnostics);
  const finalReport = {
    status: ready ? "REAL_VALIDATED" : "NOT_VALIDATED",
    failureCode,
    migration24: "REUSED",
    newMigrationRequired: false,
    preflight: "PASS",
    utcPeriod: context.expectedUtcDate,
    baselineReservations: context.baseline.reservations,
    baselineDispatched: context.baseline.dispatchedRequests,
    baselineReservedNeurons: context.baseline.reservedEstimatedNeurons,
    stage: STAGE,
    classifierImplementation: "REAL",
    classifierVersion: classifierAgentVersion,
    fixture: FIXTURE,
    fixtureOrigin: "classifierFixtures[0] shared with classifier:unit; synthetic controlled material",
    registryOrigin: "classifierFixtureRegistry shared with classifier:unit",
    provider: PROVIDER,
    model: result?.model ?? CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    classifierMaxOutputTokens: context.modelConfig.maxOutputTokens,
    structuredOutputMode: context.modelConfig.structuredOutputMode,
    estimatedReservationNeurons: context.estimatedNeurons,
    projectedReservedNeurons: context.projectedReservedNeurons,
    hardAllocationNeurons: context.capacity.dailyNeuronAllocation,
    softAllocationNeurons: context.softAllocation,
    projectedSoftRemainingNeurons: context.projectedSoftRemainingNeurons,
    fixtureRegistryRegions: context.registry.regions.size,
    fixtureRegistryCategories: context.registry.categories.size,
    newCloudflareCalls: externalCalls,
    groqCalls: 0,
    cerebrasCalls: 0,
    otherLlmStageCalls: 0,
    productionEventAttemptsCreated: syntheticEventAttemptsAfter - context.syntheticEventAttemptsBefore,
    publishedArticlesCreated: articlesAfter - context.articlesBefore,
    httpStatus: httpStatus ?? "UNKNOWN",
    finishReason: finishReason ?? "UNKNOWN",
    structuredJson: diagnostics.contentJsonParseable === true ? "PASS" : "FAIL",
    classificationResultZod: checks.resultZod ? "PASS" : "FAIL",
    deterministicChecks: checks.overall ? "PASS" : "FAIL",
    categoryRegistryValidation: checks.categoryRegistry ? "PASS" : "FAIL",
    regionRegistryValidation: checks.regionRegistry ? "PASS" : "FAIL",
    geoRegistryValidation: checks.geoRegistry ? "PASS" : "FAIL",
    countryIsoValidation: result ? "PASS" : "NOT_APPLICABLE",
    entityNormalization: checks.entityNormalization ? "PASS" : "FAIL",
    categoryCount: result?.categoryCount ?? "UNKNOWN",
    categoryRule: "0–3 unique slugs, validated against fixture registry; no ordering rule",
    responseRepair: "NO",
    attempts,
    retries,
    inputTokens: inputTokens ?? "UNKNOWN",
    outputTokens: outputTokens ?? "UNKNOWN",
    totalTokens: totalTokens ?? "UNKNOWN",
    latencyMs: latencyMs ?? "UNKNOWN",
    requestBytes: requestBytes ?? "UNKNOWN",
    responseBytes: responseBytes ?? "UNKNOWN",
    postResponseEstimatedNeurons: postResponseEstimate ?? "UNKNOWN",
    actualNeurons: actualNeurons ?? "UNKNOWN",
    reservationDelta: finalDelta.reservations,
    dispatchDelta: finalDelta.dispatchedRequests,
    reservedNeuronDelta: finalDelta.reservedEstimatedNeurons,
    postReservations: finalUsage?.requestsReserved ?? "UNKNOWN",
    postDispatched: finalUsage?.requestsDispatched ?? "UNKNOWN",
    postReservedNeurons: finalUsage?.neuronsUsed ?? "UNKNOWN",
    postSoftRemainingNeurons: finalUsage?.neuronsUsed === undefined
      ? "UNKNOWN"
      : Math.floor(context.capacity.dailyNeuronAllocation! * context.capacity.softLimitRatio) - finalUsage.neuronsUsed,
    reservationToPostResponseEstimateRatio: postResponseEstimate && postResponseEstimate > 0
      ? Number((context.estimatedNeurons / postResponseEstimate).toFixed(2))
      : "UNKNOWN",
    accounting: accountingPass ? "PASS" : "FAIL",
    telemetry: validationLogPass && !secretsPersisted ? "PASS" : "FAIL",
    secretPersisted: secretsPersisted ? "YES" : "NO",
    semanticCategoryQuality: "NOT_CERTIFIED",
    technicalAllStagesValidated: false,
    semanticEditorialQualityGate: "NOT_VALIDATED",
    productionRouterEnabled: false,
    paidPathEnabled: false,
    dryRun: true,
    sanitizedFailureDiagnostics: ready ? null : {
      ...sanitizedFailureDiagnostics(diagnostics),
      deterministicFailureCode: failureCode,
    },
    ready,
  };
  process.stdout.write(`${JSON.stringify(finalReport, null, 2)}\n`);
  if (!ready) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  check(args.length === 1 && (args[0] === "--preflight" || args[0] === "--execute-one-shot"), "BLOCKED_INVALID_VALIDATION_MODE");
  const context = await preparePreflight();
  if (args[0] === "--preflight") {
    process.stdout.write(`${JSON.stringify(preflightReport(context), null, 2)}\n`);
    return;
  }
  await executeOneShot(context);
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_:-]{3,120}$/.test(error.message)
    ? error.message
    : "BLOCKED_CLASSIFIER_CLOUDFLARE_PREFLIGHT";
  process.stderr.write(`${JSON.stringify({
    status: dispatchedInferenceCalls === 0 ? "PREFLIGHT_BLOCKED" : "POST_DISPATCH_FAILURE",
    failureCode: dispatchedInferenceCalls === 0 ? code : "BLOCKED_CLASSIFIER_VALIDATION_POST_DISPATCH",
    inferenceCalls: dispatchedInferenceCalls,
  })}\n`);
  process.exitCode = 1;
});
