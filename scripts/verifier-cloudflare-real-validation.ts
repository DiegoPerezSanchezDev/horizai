import { randomUUID } from "node:crypto";
import { AgentError, getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
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
import {
  verificationResultSchema,
  verificationStatusSchema,
  type VerificationResult,
} from "../lib/agents/contracts/index.ts";
import { createVerifierInputFixture } from "../lib/agents/verifier/verifier-fixtures.ts";
import { buildVerifierModelInput } from "../lib/agents/verifier/verifier-input-builder.ts";
import { VerifierAgent, getVerifierModelConfig, verifierAgentVersion, verifierSystemInstructions } from "../lib/agents/verifier/verifier-agent.ts";
import { verifierInputSchema } from "../lib/agents/verifier/verifier-types.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import type { Json } from "../types/database.ts";

const STAGE = "verifier" as const;
const FIXTURE = supervisedValidationFixtureAllowlist[STAGE];
const PURPOSE = "verifier_stage_validation" as const;
const PROVIDER = "cloudflare_workers_ai" as const;
const DAILY_HARD_NEURON_ALLOCATION = 10_000;
const SOFT_LIMIT_RATIO = 0.85;
const MAX_CALLS = 1;
const MAX_RETRIES = 0;
const EXPECTED_OUTPUT_TOKENS = 1_200;
let dispatchedInferenceCalls = 0;

type JsonObject = Record<string, unknown>;
type Db = ReturnType<typeof createSupabaseServerClient>;
type VerifierInput = ReturnType<typeof createVerifierInputFixture>;

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
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

function inputForEvent(eventKey: string): VerifierInput {
  const input = createVerifierInputFixture("confirmed", 2);
  input.event.eventKey = eventKey;
  return input;
}

function inputCharacterLimit(): number {
  const raw = process.env.AGENT_MAX_INPUT_CHARS?.trim();
  const value = raw ? Number(raw) : 12_000;
  check(Number.isInteger(value) && value >= 2 && value <= 12_000, "BLOCKED_VERIFIER_INPUT_LIMIT");
  return value;
}

type Preflight = {
  db: Db;
  baseline: CloudflareAccountingBaseline;
  eventKey: string;
  input: VerifierInput;
  modelConfig: ModelConfig;
  capacity: ReturnType<typeof readProviderCapacityConfig>;
  rates: ReturnType<typeof readCloudflareNeuronRates>;
  estimatedInputTokens: number;
  estimatedNeurons: number;
  projectedReservedNeurons: number;
  softAllocation: number;
  projectedSoftRemainingNeurons: number;
  articlesBefore: number;
  eventAttemptsBefore: number;
  agentRunsBefore: number;
  fixtureInputChars: number;
  strictSchemaChars: number;
  sourceIds: string[];
  productionModel: string;
};

async function assertMigration24Capability(db: Db, requestDate: string): Promise<void> {
  // Deliberately invalid allowlist stage: the RPC must exist and reject before any writes.
  const probe = await db.rpc("reserve_cloudflare_supervised_stage_validation_capacity", {
    p_run_id: randomUUID(),
    p_stage: "__preflight_invalid__" as never,
    p_agent_name: STAGE,
    p_agent_version: verifierAgentVersion,
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

async function preparePreflight(): Promise<Preflight> {
  const productionConfig = getVerifierModelConfig();
  check(process.env.AGENT_PROVIDER?.trim().toLowerCase() === "groq", "BLOCKED_PRODUCTION_PROVIDER_CHANGED");
  check((freeProviderPolicy.groq.approvedModels as readonly string[]).includes(productionConfig.model), "BLOCKED_PRODUCTION_VERIFIER_MODEL_NOT_FREE_APPROVED");
  check(productionConfig.allowPaidFallback === false && productionConfig.failOnRateLimit, "BLOCKED_PRODUCTION_COST_POLICY");
  check(!freeProviderRouterEnabled(), "BLOCKED_PRODUCTION_ROUTER_MUST_REMAIN_DISABLED");
  check(verifierAgentVersion === "verifier-v1", "BLOCKED_UNEXPECTED_VERIFIER_VERSION");
  check(productionConfig.maxOutputTokens === EXPECTED_OUTPUT_TOKENS, "BLOCKED_VERIFIER_OUTPUT_BUDGET_CHANGED");

  const validation = validateSupervisedCloudflareStageValidation({
    stage: STAGE,
    fixture: FIXTURE,
    provider: PROVIDER,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    agentVersion: verifierAgentVersion,
    maxAttempts: MAX_CALLS,
    maxRetries: MAX_RETRIES,
  });
  check(validation.validationPurpose === PURPOSE && validation.agentVersion === verifierAgentVersion, "BLOCKED_SUPERVISED_IDENTITY_MISMATCH");

  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  requiredEnv("CLOUDFLARE_AI_API_TOKEN");
  const validationEnv = { ...process.env, CLOUDFLARE_MODEL: CLOUDFLARE_LLAMA_VALIDATION_MODEL };
  const capacity = readProviderCapacityConfig(PROVIDER, validationEnv);
  check(capacity.configured && capacity.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_CLOUDFLARE_CONFIGURATION");
  check(capacity.dailyNeuronAllocation === DAILY_HARD_NEURON_ALLOCATION, "BLOCKED_CLOUDFLARE_HARD_ALLOCATION");
  check(capacity.softLimitRatio === SOFT_LIMIT_RATIO, "BLOCKED_CLOUDFLARE_SOFT_ALLOCATION");
  check(cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].freeApproved
    && cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].structuredProductionApproved === "CANDIDATE"
    && !cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].productionRoutingEnabled,
  "BLOCKED_CLOUDFLARE_VALIDATION_ONLY_POLICY");
  check(!cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].productionRoutingEnabled, "BLOCKED_AUTOMATIC_CLOUDFLARE_ROUTING_ENABLED");
  assertFreeProviderRequest(PROVIDER, CLOUDFLARE_LLAMA_VALIDATION_MODEL, capacity.endpoint);
  check(capacity.endpoint === `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`, "BLOCKED_CLOUDFLARE_ENDPOINT_MISMATCH");

  const modelConfig: ModelConfig = {
    ...productionConfig,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    maxRetries: MAX_RETRIES,
    dailyRequestLimit: MAX_CALLS,
  };
  check(modelConfig.maxRetries === 0 && modelConfig.dailyRequestLimit === 1, "BLOCKED_ONE_SHOT_GUARD");
  check(modelConfig.maxOutputTokens === EXPECTED_OUTPUT_TOKENS, "BLOCKED_VERIFIER_OUTPUT_BUDGET_CHANGED");

  const eventKey = createSupervisedValidationEventKey(STAGE, randomUUID());
  const input = inputForEvent(eventKey);
  const parsedInput = verifierInputSchema.safeParse(input);
  check(parsedInput.success && input.event.sourceItems.length === 2 && input.items.length === 2 && input.sources.length === 2, "BLOCKED_CANONICAL_FIXTURE_INVALID");
  const builtInput = buildVerifierModelInput(input, inputCharacterLimit());
  const strictSchemaChars = JSON.stringify(toStrictProviderJsonSchema(verificationResultSchema)).length;
  const estimatedInputTokens = Math.ceil((verifierSystemInstructions.length + JSON.stringify(builtInput.input).length + strictSchemaChars) / 2) + 128;
  const rates = readCloudflareNeuronRates(process.env, CLOUDFLARE_LLAMA_VALIDATION_MODEL);
  const estimatedNeurons = estimateCloudflareNeurons({ inputTokens: estimatedInputTokens, outputTokens: modelConfig.maxOutputTokens, ...rates });

  requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  requiredEnv("SUPABASE_SECRET_KEY");
  const db = createSupabaseServerClient();
  const reader = new SupabaseAgentLogger(db);
  const requestDate = utcToday();
  await assertMigration24Capability(db, requestDate);
  const usage = await reader.getProviderDailyUsage(PROVIDER, requestDate);
  const baseline = createCloudflareAccountingBaseline(usage, new Date());
  assertCloudflareUtcPeriod(baseline.utcDate);
  const capacityCheck = checkCloudflareBaselineCapacity({
    baseline,
    dailyNeuronAllocation: capacity.dailyNeuronAllocation,
    estimatedNextRequestNeurons: estimatedNeurons,
    ...(capacity.dailyRequestLimit === undefined ? {} : { dailyRequestLimit: capacity.dailyRequestLimit }),
    softLimitRatio: capacity.softLimitRatio,
  });
  check(baseline.reservedEstimatedNeurons + estimatedNeurons <= DAILY_HARD_NEURON_ALLOCATION, "BLOCKED_HARD_CAPACITY_INSUFFICIENT");

  const articlesBefore = await exactCount(db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE");
  const eventAttemptsBefore = await exactCount(db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }), "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE");
  const agentRunsBefore = await exactCount(db.from("agent_runs").select("id", { count: "exact", head: true }), "BLOCKED_AGENT_RUN_COUNT_UNAVAILABLE");

  return {
    db,
    baseline,
    eventKey,
    input,
    modelConfig,
    capacity,
    rates,
    estimatedInputTokens,
    estimatedNeurons,
    projectedReservedNeurons: baseline.reservedEstimatedNeurons + estimatedNeurons,
    softAllocation: Math.floor(capacity.dailyNeuronAllocation! * capacity.softLimitRatio),
    projectedSoftRemainingNeurons: capacityCheck.softRemainingAfterReservation,
    articlesBefore,
    eventAttemptsBefore,
    agentRunsBefore,
    fixtureInputChars: JSON.stringify(builtInput.input).length,
    strictSchemaChars,
    sourceIds: [...new Set(input.sources.map((source) => source.sourceId))],
    productionModel: productionConfig.model,
  };
}

function preflightReport(context: Preflight) {
  return {
    status: "PRE_FLIGHT_READY_FOR_ONE_SHOT_VALIDATION",
    inferenceCalls: 0,
    migration24: "REUSED_REMOTE_AND_RPC_CAPABILITY_CONFIRMED",
    stage: STAGE,
    validationPurpose: PURPOSE,
    agentVersion: verifierAgentVersion,
    fixture: FIXTURE,
    fixtureOrigin: "createVerifierInputFixture('confirmed', 2), same helper used by verifier:unit",
    syntheticEventKey: true,
    provider: PROVIDER,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    productionProvider: "groq",
    productionVerifierModel: context.productionModel,
    productionRouterEnabled: freeProviderRouterEnabled(),
    paidFallbackEnabled: context.modelConfig.allowPaidFallback,
    structuredOutputMode: context.modelConfig.structuredOutputMode,
    maxOutputTokens: context.modelConfig.maxOutputTokens,
    providerTokenField: "max_tokens",
    maxRetries: context.modelConfig.maxRetries,
    maxCalls: MAX_CALLS,
    utcPeriod: context.baseline.utcDate,
    baselineReservations: context.baseline.reservations,
    baselineDispatchedRequests: context.baseline.dispatchedRequests,
    baselineReservedNeurons: context.baseline.reservedEstimatedNeurons,
    hardAllocationNeurons: context.capacity.dailyNeuronAllocation,
    softAllocationNeurons: context.softAllocation,
    estimatedReservationNeurons: context.estimatedNeurons,
    projectedReservedNeurons: context.projectedReservedNeurons,
    projectedSoftRemainingNeurons: context.projectedSoftRemainingNeurons,
    systemPromptChars: verifierSystemInstructions.length,
    fixtureInputChars: context.fixtureInputChars,
    strictSchemaChars: context.strictSchemaChars,
    estimatedInputTokens: context.estimatedInputTokens,
    maxOutputTokensUsedForReservation: context.modelConfig.maxOutputTokens,
    neuronRates: context.rates,
    sourceCount: context.sourceIds.length,
    validationMethod: "real VerifierAgent; strict Zod contract; sourceId references checked against fixture",
    productionArticlesBefore: context.articlesBefore,
    productionEventAttemptsBefore: context.eventAttemptsBefore,
    productionAgentRunsBefore: context.agentRunsBefore,
  };
}

class VerifierValidationLogger extends SupabaseAgentLogger {
  private readonly db: Db;
  private readonly context: Preflight;
  runId: string | null = null;

  constructor(db: Db, context: Preflight) {
    super(db);
    this.db = db;
    this.context = context;
  }

  override async startRun(metadata: AgentRunMetadata, startedAt: string): Promise<string | null> {
    check(metadata.provider === PROVIDER && metadata.agentName === STAGE, "BLOCKED_NON_VERIFIER_CLOUDFLARE_RUN");
    check(metadata.agentVersion === verifierAgentVersion && metadata.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_VERIFIER_IDENTITY_MISMATCH");
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

  override reserveRequest(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    _localLimit: number,
    requestDate: string,
  ): Promise<RequestReservation> {
    assertCloudflareUtcPeriod(this.context.baseline.utcDate);
    check(requestDate === this.context.baseline.utcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
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
    assertCloudflareUtcPeriod(this.context.baseline.utcDate);
    check(requestDate === this.context.baseline.utcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
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

function sourceReferencesValid(output: VerificationResult, sourceIds: ReadonlySet<string>): boolean {
  if (output.primarySourceId !== null && !sourceIds.has(output.primarySourceId)) return false;
  if (output.supportingSourceIds.some((id) => !sourceIds.has(id))) return false;
  const claims = [...output.verifiedFacts, ...output.uncertainClaims, ...output.contradictions];
  if (claims.some((claim) => claim.sourceIds.some((id) => !sourceIds.has(id)))) return false;
  return output.verifiedFacts.every((fact) => fact.sourceIds.length > 0);
}

function classifyFailure(error: unknown, diagnostics: ProviderDiagnostics): string {
  if (diagnostics.httpStatus === 429) return "PROVIDER_RATE_LIMIT";
  if (diagnostics.httpStatus === 401 || diagnostics.httpStatus === 403) return "BLOCKED_CLOUDFLARE_AUTH";
  if (diagnostics.httpStatus === 400 || diagnostics.httpStatus === 413) return "BLOCKED_CLOUDFLARE_VERIFIER_CONTRACT";
  if (diagnostics.httpStatus === 200 && diagnostics.finishReason === "length") return "BLOCKED_OUTPUT_BUDGET";
  if (diagnostics.httpStatus === 200 && diagnostics.failureKind === "LOCAL_JSON_PARSE_ERROR") return "BLOCKED_CLOUDFLARE_VERIFIER_CONTRACT";
  if (diagnostics.httpStatus === 200 && diagnostics.failureKind === "LOCAL_SCHEMA_VALIDATION_ERROR") return "BLOCKED_CLOUDFLARE_VERIFIER_CONTRACT";
  if (error instanceof AgentError && /^[A-Z0-9_:-]{3,120}$/.test(error.code)) return error.code;
  return "CANONICAL_PROVIDER_OR_RUNTIME_ERROR";
}

async function executeOneShot(context: Preflight): Promise<void> {
  process.stdout.write(`${JSON.stringify(preflightReport(context), null, 2)}\n`);
  const logger = new VerifierValidationLogger(context.db, context);
  let externalCalls = 0;
  const guardedFetch: typeof fetch = async (url, init) => {
    check(externalCalls < MAX_CALLS, "BLOCKED_MORE_THAN_ONE_CLOUDFLARE_REQUEST");
    assertCloudflareUtcPeriod(context.baseline.utcDate);
    check(String(url) === context.capacity.endpoint, "BLOCKED_NON_CLOUDFLARE_ENDPOINT");
    check(init?.method === "POST", "BLOCKED_NON_POST_PROVIDER_REQUEST");
    const body = object(JSON.parse(String(init.body ?? "{}")) as unknown);
    check(body.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_NON_ALLOWLISTED_MODEL");
    check(body.max_tokens === context.modelConfig.maxOutputTokens && !Object.hasOwn(body, "max_completion_tokens"), "BLOCKED_CLOUDFLARE_OUTPUT_TOKEN_FIELD");
    check(body.stream === false && !Object.hasOwn(body, "tools") && !Object.hasOwn(body, "tool_choice"), "BLOCKED_TOOLS_OR_STREAMING_ENABLED");
    check(responseFormatValid(body, context.modelConfig.structuredOutputMode), "BLOCKED_VERIFIER_STRUCTURED_OUTPUT_MODE");
    externalCalls += 1;
    dispatchedInferenceCalls = externalCalls;
    return fetch(url, { ...init, redirect: "error" });
  };
  const provider = createCloudflareWorkersAIValidationCandidateProvider(guardedFetch);
  check(provider instanceof CloudflareWorkersAIModelProvider && provider.providerId === PROVIDER, "BLOCKED_NON_CLOUDFLARE_PROVIDER");

  let result: Awaited<ReturnType<VerifierAgent["verify"]>> | null = null;
  let failure: unknown;
  try {
    result = await new VerifierAgent(provider, logger).verify(context.input, {
      modelConfig: context.modelConfig,
      requestBudget: new DailyRequestBudget(() => new Date()),
      dryRun: true,
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
  const zodPass = result !== null && verificationResultSchema.safeParse(result.output).success
    && diagnostics.validationResult === "valid" && diagnostics.contentJsonParseable === true;
  const output = result?.output;
  const sourceIds = new Set(context.sourceIds);
  const evidencePass = output !== undefined && sourceReferencesValid(output, sourceIds);
  const eventKeyPass = output?.eventKey === context.eventKey;
  const statusPass = output !== undefined && verificationStatusSchema.safeParse(output.status).success;
  const confidencePass = output !== undefined && Number.isInteger(output.confidenceScore) && output.confidenceScore >= 0 && output.confidenceScore <= 100;
  const factsShapePass = output !== undefined && output.verifiedFacts.every((fact) => typeof fact.claim === "string" && Array.isArray(fact.sourceIds));
  const deterministicChecksPass = zodPass && eventKeyPass && statusPass && confidencePass && factsShapePass && evidencePass;
  const attemptsPass = attempts === 1 && retries === 0 && externalCalls === 1;
  const noTruncation = finishReason !== "length";
  const canonicalPass = output !== undefined && statusPass && confidencePass;

  let delta = { reservations: 0, dispatchedRequests: 0, reservedEstimatedNeurons: 0 };
  let accountingPass = false;
  try {
    assertCloudflareUtcPeriod(context.baseline.utcDate);
    const after = await new SupabaseAgentLogger(context.db).getProviderDailyUsage(PROVIDER, context.baseline.utcDate);
    delta = cloudflareAccountingDelta(context.baseline, after);
    if (externalCalls === 1) {
      assertCloudflareOneRequestDelta(delta, context.estimatedNeurons);
      accountingPass = true;
    } else {
      assertCloudflareNoRequestDelta(delta);
      accountingPass = true;
    }
  } catch {
    accountingPass = false;
  }

  const articlesAfter = await exactCount(context.db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE_AFTER");
  const eventAttemptsAfter = await exactCount(context.db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }), "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE_AFTER");
  const agentRunsAfter = await exactCount(context.db.from("agent_runs").select("id", { count: "exact", head: true }), "BLOCKED_AGENT_RUN_COUNT_UNAVAILABLE_AFTER");
  const sideEffectsPass = articlesAfter === context.articlesBefore
    && eventAttemptsAfter === context.eventAttemptsBefore
    && agentRunsAfter === context.agentRunsBefore + (logger.runId ? 1 : 0);

  const runId = result?.runId ?? logger.runId;
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
  const preTelemetryPass = httpStatus === 200 && result !== null && attemptsPass && diagnostics.provider === PROVIDER
    && result.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL;
  let stageStatus = "NOT_VALIDATED";
  let validationLogPass = false;
  let secretsPersisted = false;

  if (runId) {
    const metadata: AgentRunMetadata = {
      agentName: STAGE,
      agentVersion: verifierAgentVersion,
      eventKey: context.eventKey,
      model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
      provider: PROVIDER,
      dryRun: true,
    };
    const successfulContract = httpStatus === 200 && noTruncation && zodPass && deterministicChecksPass
      && canonicalPass && attemptsPass && preTelemetryPass && accountingPass && sideEffectsPass;
    stageStatus = successfulContract ? "REAL_VALIDATED" : "NOT_VALIDATED";
    try {
      await logger.log(runId, metadata, {
        level: successfulContract ? "info" : "warn",
        step: "verifier_stage_validation_result",
        message: "Supervised Verifier stage validation completed",
        payload: {
          validationPurpose: PURPOSE,
          fixture: FIXTURE,
          syntheticIdentity: true,
          stageValidationStatus: stageStatus,
          agentVersion: verifierAgentVersion,
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
          verificationResultZod: zodPass,
          deterministicChecks: deterministicChecksPass,
          evidenceSourceReferences: evidencePass,
          canonicalStatus: output?.status ?? null,
          confidenceScore: output?.confidenceScore ?? null,
          verifiedFactsCount: output?.verifiedFacts.length ?? null,
          responseRepair: false,
          accountingDelta: delta,
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
        const summaryLog = logsResponse.data.find((entry) => entry.step === "verifier_stage_validation_result");
        const summaryPayload = object(object(summaryLog?.payload).details);
        validationLogPass = runResponse.data.provider === PROVIDER
          && runResponse.data.status === "succeeded"
          && runResponse.data.dry_run === true
          && config.validationPurpose === PURPOSE
          && config.fixture === FIXTURE
          && config.agentVersion === verifierAgentVersion
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
          && summaryPayload.verificationResultZod === zodPass
          && summaryPayload.evidenceSourceReferences === evidencePass
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
  const finalUsage = await new SupabaseAgentLogger(context.db).getProviderDailyUsage(PROVIDER, context.baseline.utcDate).catch(() => null);
  const finalDelta = finalUsage ? cloudflareAccountingDelta(context.baseline, finalUsage) : delta;
  const postReserved = finalUsage?.neuronsUsed ?? null;
  const finalReport = {
    status: ready ? "REAL_VALIDATED" : "NOT_VALIDATED",
    failureCode: ready ? "NONE" : classifyFailure(failure, diagnostics),
    migration24: "REUSED",
    newMigrationRequired: false,
    preflight: "PASS",
    utcPeriod: context.baseline.utcDate,
    baselineReservations: context.baseline.reservations,
    baselineDispatched: context.baseline.dispatchedRequests,
    baselineReservedNeurons: context.baseline.reservedEstimatedNeurons,
    stage: STAGE,
    verifierImplementation: "REAL",
    verifierVersion: verifierAgentVersion,
    fixture: FIXTURE,
    fixtureOrigin: "verifier:unit canonical helper; synthetic event identity",
    provider: PROVIDER,
    model: result?.model ?? CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    verifierMaxOutputTokens: context.modelConfig.maxOutputTokens,
    structuredOutputMode: context.modelConfig.structuredOutputMode,
    estimatedReservationNeurons: context.estimatedNeurons,
    projectedReservedNeurons: context.projectedReservedNeurons,
    hardAllocationNeurons: context.capacity.dailyNeuronAllocation,
    softAllocationNeurons: context.softAllocation,
    projectedSoftRemainingNeurons: context.projectedSoftRemainingNeurons,
    newCloudflareCalls: externalCalls,
    httpStatus: httpStatus ?? "UNKNOWN",
    finishReason: finishReason ?? "UNKNOWN",
    providerResponseJson: diagnostics.responseJsonParseable === true ? "PASS" : "FAIL",
    structuredContentJson: diagnostics.contentJsonParseable === true ? "PASS" : "FAIL",
    verificationResultZod: zodPass ? "PASS" : "FAIL",
    deterministicChecks: deterministicChecksPass ? "PASS" : "FAIL",
    evidenceSourceValidation: evidencePass ? "PASS" : "FAIL",
    canonicalStatus: output?.status ?? "UNKNOWN",
    canonicalStatusValid: statusPass,
    confidenceScore: output?.confidenceScore ?? "UNKNOWN",
    confidenceValidInteger0To100: confidencePass,
    verifiedFactsCount: output?.verifiedFacts.length ?? "UNKNOWN",
    downstreamPipelineInterpretation: output?.verifiedFacts.length === 0
      ? "SKIPPED_VERIFICATION_INSUFFICIENT"
      : "NOT_EXECUTED",
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
    postReservedNeurons: postReserved ?? "UNKNOWN",
    reservationToPostResponseEstimateRatio: postResponseEstimate && postResponseEstimate > 0
      ? Number((context.estimatedNeurons / postResponseEstimate).toFixed(2))
      : "UNKNOWN",
    accounting: accountingPass ? "PASS" : "FAIL",
    telemetry: validationLogPass && !secretsPersisted ? "PASS" : "FAIL",
    secretPersisted: secretsPersisted ? "YES" : "NO",
    productionEventAttemptsCreated: eventAttemptsAfter - context.eventAttemptsBefore,
    productionAgentRunsCreated: agentRunsAfter - context.agentRunsBefore,
    publishedArticlesCreated: articlesAfter - context.articlesBefore,
    groqCalls: 0,
    cerebrasCalls: 0,
    otherLlmStageCalls: 0,
    paidPathEnabled: false,
    productionRouterEnabled: false,
    dryRun: true,
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
    : "BLOCKED_VERIFIER_CLOUDFLARE_PREFLIGHT";
  process.stderr.write(`${JSON.stringify({
    status: dispatchedInferenceCalls === 0 ? "PREFLIGHT_BLOCKED" : "POST_DISPATCH_FAILURE",
    failureCode: dispatchedInferenceCalls === 0 ? code : "BLOCKED_VERIFIER_VALIDATION_POST_DISPATCH",
    inferenceCalls: dispatchedInferenceCalls,
  })}\n`);
  process.exitCode = 1;
});
