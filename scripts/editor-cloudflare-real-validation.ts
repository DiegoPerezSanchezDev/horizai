import { randomUUID } from "node:crypto";
import { AgentError, getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import {
  assertCloudflareOneRequestDelta,
  assertCloudflareNoRequestDelta,
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
  CLOUDFLARE_LLAMA_VALIDATION_MODEL,
  assertFreeProviderRequest,
  cloudflareModelPolicy,
  freeProviderPolicy,
} from "../lib/agents/runtime/provider-cost-policy.ts";
import { createCloudflareWorkersAIValidationCandidateProvider, CloudflareWorkersAIModelProvider } from "../lib/agents/runtime/cloudflare-workers-ai-provider.ts";
import { createSupervisedValidationEventKey, supervisedValidationFixtureAllowlist, validateSupervisedCloudflareStageValidation } from "../lib/agents/runtime/cloudflare-stage-validation.ts";
import type { AgentRunMetadata, ModelConfig, ProviderDiagnostics, RequestReservation } from "../lib/agents/runtime/runtime-types.ts";
import { toStrictProviderJsonSchema } from "../lib/agents/runtime/strict-json-schema.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { editorialDraftSchema } from "../lib/agents/contracts/index.ts";
import { analyzeEditorialNumericClaims } from "../lib/agents/editor/editor-numeric-provenance.ts";
import { analyzePreservedNames } from "../lib/agents/editor/editor-output-guard.ts";
import { buildEditorModelInput } from "../lib/agents/editor/editor-input.ts";
import { canonicalEditorInput } from "../lib/agents/editor/editor-fixtures.ts";
import { editorGenerationSchema } from "../lib/agents/editor/editor-generation.ts";
import { editorV2AgentVersion, editorV2SystemInstructions } from "../lib/agents/editor/editor-v2-prompt.ts";
import { EditorV2Agent, getEditorV2ModelConfig } from "../lib/agents/editor/editor-v2-agent.ts";
import type { Json } from "../types/database.ts";

const DAILY_HARD_NEURON_ALLOCATION = 10_000;
const EXPECTED_SOFT_LIMIT_RATIO = 0.85;
const MAX_PROVIDER_CALLS = 1;
const MAX_RETRIES = 0;
const VALIDATION_STAGE = "editor" as const;
const VALIDATION_FIXTURE = supervisedValidationFixtureAllowlist[VALIDATION_STAGE];
const VALIDATION_PURPOSE = "editor_stage_validation" as const;
const EXPECTED_PROVIDER = "cloudflare_workers_ai" as const;

type JsonObject = Record<string, unknown>;
type Db = ReturnType<typeof createSupabaseServerClient>;
type EditorInput = typeof canonicalEditorInput;

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`BLOCKED_MISSING_${name}`);
  return value;
}

async function exactCount(query: PromiseLike<{ count: number | null; error: { message: string } | null }>, code: string): Promise<number> {
  const response = await query;
  if (response.error || response.count === null) throw new Error(code);
  return response.count;
}

function fixtureForEvent(eventKey: string): EditorInput {
  const input = structuredClone(canonicalEditorInput);
  input.event.eventKey = eventKey;
  return input;
}

type Preflight = {
  db: Db;
  baseline: CloudflareAccountingBaseline;
  eventKey: string;
  input: EditorInput;
  modelConfig: ModelConfig;
  capacity: ReturnType<typeof readProviderCapacityConfig>;
  rates: ReturnType<typeof readCloudflareNeuronRates>;
  builtInput: ReturnType<typeof buildEditorModelInput>;
  strictSchemaChars: number;
  estimatedInputTokens: number;
  estimatedNeurons: number;
  projectedReservedNeurons: number;
  hardAllocation: number;
  softAllocation: number;
  projectedSoftRemainingNeurons: number;
  articlesBefore: number;
  attemptsBefore: number;
  sourceFixture: string;
};

async function preparePreflight(): Promise<Preflight> {
  const editorConfig = getEditorV2ModelConfig();
  check(process.env.AGENT_PROVIDER?.trim().toLowerCase() === "groq", "BLOCKED_PRODUCTION_PROVIDER_CHANGED");
  check((freeProviderPolicy.groq.approvedModels as readonly string[]).includes(editorConfig.model), "BLOCKED_PRODUCTION_EDITOR_MODEL_NOT_FREE_APPROVED");
  check(editorConfig.allowPaidFallback === false, "BLOCKED_PAID_FALLBACK_ENABLED");
  check(!freeProviderRouterEnabled(), "BLOCKED_PRODUCTION_ROUTER_MUST_REMAIN_DISABLED");
  check(editorV2AgentVersion === "editor-v2", "BLOCKED_UNEXPECTED_EDITOR_VERSION");

  const validation = validateSupervisedCloudflareStageValidation({
    stage: VALIDATION_STAGE,
    fixture: VALIDATION_FIXTURE,
    provider: EXPECTED_PROVIDER,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    agentVersion: editorV2AgentVersion,
    maxAttempts: MAX_PROVIDER_CALLS,
    maxRetries: MAX_RETRIES,
  });
  check(validation.validationPurpose === VALIDATION_PURPOSE && validation.agentVersion === editorV2AgentVersion, "BLOCKED_SUPERVISED_IDENTITY_MISMATCH");

  const accountId = checkEnv("CLOUDFLARE_ACCOUNT_ID");
  checkEnv("CLOUDFLARE_AI_API_TOKEN");
  const validationEnv = { ...process.env, CLOUDFLARE_MODEL: CLOUDFLARE_LLAMA_VALIDATION_MODEL };
  const capacity = readProviderCapacityConfig(EXPECTED_PROVIDER, validationEnv);
  check(capacity.configured && capacity.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_CLOUDFLARE_CONFIGURATION");
  check(capacity.dailyNeuronAllocation === DAILY_HARD_NEURON_ALLOCATION, "BLOCKED_CLOUDFLARE_HARD_ALLOCATION_MISMATCH");
  check(capacity.softLimitRatio === EXPECTED_SOFT_LIMIT_RATIO, "BLOCKED_CLOUDFLARE_SOFT_LIMIT_MISMATCH");
  check(cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].freeApproved
    && cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].structuredProductionApproved === "CANDIDATE"
    && !cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].productionRoutingEnabled,
  "BLOCKED_CLOUDFLARE_MODEL_NOT_VALIDATION_ONLY");
  check(!cloudflareModelPolicy[CLOUDFLARE_LLAMA_VALIDATION_MODEL].productionRoutingEnabled, "BLOCKED_AUTOMATIC_CLOUDFLARE_ROUTING_ENABLED");
  assertFreeProviderRequest(EXPECTED_PROVIDER, CLOUDFLARE_LLAMA_VALIDATION_MODEL, capacity.endpoint);
  check(capacity.endpoint === `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`, "BLOCKED_CLOUDFLARE_ENDPOINT_MISMATCH");

  const modelConfig: ModelConfig = {
    ...editorConfig,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    maxRetries: MAX_RETRIES,
    dailyRequestLimit: MAX_PROVIDER_CALLS,
  };
  check(modelConfig.maxRetries === 0 && modelConfig.dailyRequestLimit === 1, "BLOCKED_ONE_SHOT_RETRY_OR_REQUEST_GUARD");
  check(modelConfig.maxOutputTokens === editorConfig.maxOutputTokens, "BLOCKED_EDITOR_OUTPUT_BUDGET_CHANGED");

  const eventKey = createSupervisedValidationEventKey(VALIDATION_STAGE, randomUUID());
  const input = fixtureForEvent(eventKey);
  const builtInput = buildEditorModelInput(input);
  const schemaJson = JSON.stringify(toStrictProviderJsonSchema(editorGenerationSchema));
  const strictSchemaChars = schemaJson.length;
  const estimatedInputTokens = Math.ceil((editorV2SystemInstructions.length + JSON.stringify(builtInput.input).length + strictSchemaChars) / 2) + 128;
  const rates = readCloudflareNeuronRates(process.env, CLOUDFLARE_LLAMA_VALIDATION_MODEL);
  const estimatedNeurons = estimateCloudflareNeurons({
    inputTokens: estimatedInputTokens,
    outputTokens: modelConfig.maxOutputTokens,
    ...rates,
  });

  const db = createSupabaseServerClient();
  const reader = new SupabaseAgentLogger(db);
  const requestDate = utcToday();
  const usage = await reader.getProviderDailyUsage(EXPECTED_PROVIDER, requestDate);
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
  const attemptsBefore = await exactCount(db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }).eq("event_key", eventKey), "BLOCKED_SYNTHETIC_EVENT_ATTEMPT_COUNT_UNAVAILABLE");
  check(attemptsBefore === 0, "BLOCKED_SYNTHETIC_EVENT_ALREADY_HAS_PRODUCTION_ATTEMPT");

  return {
    db,
    baseline,
    eventKey,
    input,
    modelConfig,
    capacity,
    rates,
    builtInput,
    strictSchemaChars,
    estimatedInputTokens,
    estimatedNeurons,
    projectedReservedNeurons: baseline.reservedEstimatedNeurons + estimatedNeurons,
    hardAllocation: capacity.dailyNeuronAllocation,
    softAllocation: capacityCheck.softLimitNeurons,
    projectedSoftRemainingNeurons: capacityCheck.softRemainingAfterReservation,
    articlesBefore,
    attemptsBefore,
    sourceFixture: "canonicalEditorInput from editor:unit; synthetic event key only",
  };
}

function preflightReport(context: Preflight) {
  const builtJson = JSON.stringify(context.builtInput.input);
  return {
    status: "PRE_FLIGHT_READY_FOR_ONE_SHOT_VALIDATION",
    inferenceCalls: 0,
    provider: EXPECTED_PROVIDER,
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    editorVersion: editorV2AgentVersion,
    fixture: context.sourceFixture,
    syntheticEventKey: true,
    productionProvider: process.env.AGENT_PROVIDER?.trim().toLowerCase(),
    productionEditorModelIsFreeApproved: true,
    paidPathEnabled: context.modelConfig.allowPaidFallback,
    productionRouterEnabled: freeProviderRouterEnabled(),
    structuredOutputMode: context.modelConfig.structuredOutputMode,
    maxOutputTokens: context.modelConfig.maxOutputTokens,
    cloudflareRequestTokenField: "max_tokens",
    maxRetries: context.modelConfig.maxRetries,
    maxProviderCalls: MAX_PROVIDER_CALLS,
    utcPeriod: context.baseline.utcDate,
    baselineCapturedAt: context.baseline.capturedAt,
    baselineReservations: context.baseline.reservations,
    baselineDispatched: context.baseline.dispatchedRequests,
    baselineReservedNeurons: context.baseline.reservedEstimatedNeurons,
    baselineTokenUsageKnown: context.baseline.knownTokenUsage,
    hardAllocationNeurons: context.hardAllocation,
    softAllocationNeurons: context.softAllocation,
    estimatedReservationNeurons: context.estimatedNeurons,
    projectedReservedNeurons: context.projectedReservedNeurons,
    projectedSoftRemainingNeurons: context.projectedSoftRemainingNeurons,
    estimatedInputTokens: context.estimatedInputTokens,
    promptChars: editorV2SystemInstructions.length,
    inputJsonChars: builtJson.length,
    strictSchemaChars: context.strictSchemaChars,
    editorMaxOutputTokensUnmodified: true,
    neuronRates: context.rates,
    fixtureSourceCount: context.input.sources.length,
    fixtureFactsCount: context.input.verification.verifiedFacts.length,
    fixtureHasProtectedName: context.input.translation.preservedNames.length > 0,
    fixtureHasNumericProvenance: context.input.verification.verifiedFacts.some((fact) => /\d/.test(fact.claim)),
    productionArticlesBefore: context.articlesBefore,
    syntheticProductionAttemptsBefore: context.attemptsBefore,
  };
}

class EditorValidationLogger extends SupabaseAgentLogger {
  private readonly db: Db;
  private readonly context: Preflight;
  runId: string | null = null;

  constructor(db: Db, context: Preflight) {
    super(db);
    this.db = db;
    this.context = context;
  }

  override async startRun(metadata: AgentRunMetadata, startedAt: string): Promise<string | null> {
    check(metadata.provider === EXPECTED_PROVIDER, "BLOCKED_NON_CLOUDFLARE_RUN");
    check(metadata.agentName === VALIDATION_STAGE && metadata.agentVersion === editorV2AgentVersion, "BLOCKED_NON_EDITOR_RUN");
    check(metadata.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL && metadata.eventKey === this.context.eventKey, "BLOCKED_NON_ALLOWLISTED_EDITOR_RUN");
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
        validationPurpose: VALIDATION_PURPOSE,
        fixture: VALIDATION_FIXTURE,
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
    _localAttemptLimit: number,
    requestDate: string,
  ): Promise<RequestReservation> {
    assertCloudflareUtcPeriod(this.context.baseline.utcDate);
    check(requestDate === this.context.baseline.utcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
    return this.reserveCloudflareSupervisedStageValidationCapacity(
      runId,
      metadata,
      VALIDATION_STAGE,
      VALIDATION_FIXTURE,
      attempt,
      this.context.capacity.dailyRequestLimit ?? null,
      requestDate,
      this.context.hardAllocation,
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

async function executeOneShot(context: Preflight): Promise<void> {
  process.stdout.write(`${JSON.stringify(preflightReport(context), null, 2)}\n`);
  const logger = new EditorValidationLogger(context.db, context);
  let externalRequests = 0;
  const guardedFetch: typeof fetch = async (url, init) => {
    check(externalRequests < MAX_PROVIDER_CALLS, "BLOCKED_MORE_THAN_ONE_CLOUDFLARE_REQUEST");
    externalRequests += 1;
    assertCloudflareUtcPeriod(context.baseline.utcDate);
    check(String(url) === context.capacity.endpoint, "BLOCKED_NON_CLOUDFLARE_ENDPOINT");
    const body = object(JSON.parse(String(init?.body ?? "{}")) as unknown);
    check(body.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL, "BLOCKED_NON_ALLOWLISTED_MODEL");
    check(body.max_tokens === context.modelConfig.maxOutputTokens && !Object.hasOwn(body, "max_completion_tokens"), "BLOCKED_EDITOR_TOKEN_FIELD_OR_LIMIT");
    check(body.stream === false && !Object.hasOwn(body, "tools") && !Object.hasOwn(body, "tool_choice"), "BLOCKED_TOOLS_OR_STREAMING_ENABLED");
    check(responseFormatValid(body, context.modelConfig.structuredOutputMode), "BLOCKED_EDITOR_STRUCTURED_OUTPUT_MODE");
    return fetch(url, init);
  };
  const provider = createCloudflareWorkersAIValidationCandidateProvider(guardedFetch);
  check(provider instanceof CloudflareWorkersAIModelProvider && provider.providerId === EXPECTED_PROVIDER, "BLOCKED_NON_CLOUDFLARE_PROVIDER");

  let result: Awaited<ReturnType<EditorV2Agent["edit"]>> | null = null;
  let failure: unknown;
  try {
    result = await new EditorV2Agent(provider, logger).edit(context.input, {
      modelConfig: context.modelConfig,
      requestBudget: new DailyRequestBudget(() => new Date()),
      dryRun: true,
    });
  } catch (error) {
    failure = error;
  }

  const failureDetails = failure ? getAgentFailureDetails(failure) : null;
  const diagnosticSource = result?.diagnostics ?? failureDetails?.diagnostics ?? failureDetails?.telemetry;
  const diagnostics = object(diagnosticSource) as ProviderDiagnostics;
  const usage = result?.usage ?? diagnostics.usage ?? {};
  const attempts = result?.attempts ?? failureDetails?.attempts ?? 0;
  const retries = Math.max(0, attempts - 1);
  const httpStatus = typeof diagnostics.httpStatus === "number" ? diagnostics.httpStatus : null;
  const finishReason = typeof diagnostics.finishReason === "string" ? diagnostics.finishReason : null;
  const generationSchemaPass = diagnostics.generationSchemaValid === true;
  const parsedDraft = result ? editorialDraftSchema.safeParse(result.output) : null;
  const finalDraftPass = parsedDraft?.success === true;
  const numericReport = result && parsedDraft?.success ? analyzeEditorialNumericClaims(context.input, result.output) : null;
  const numericProvenancePass = result !== null && numericReport !== null && numericReport.rejectedNumericClaims.length === 0;
  const preservedReport = result && parsedDraft?.success ? analyzePreservedNames(context.input, result.output) : null;
  const preservedNamesPass = preservedReport !== null
    && preservedReport.preservedNamesObservedCount === context.input.translation.preservedNames.length
    && preservedReport.omittedPreservedNames.length === 0
    && preservedReport.mutatedPreservedNames.length === 0;
  const deterministicAssemblyPass = diagnostics.editorialAssemblySuccess === true;
  const generatedFields = ["headlineEs", "dekEs", "summaryEs", "whyItMattersEs", "bodyEs", "keyPoints"];
  const generatedFieldsObserved = Array.isArray(diagnostics.responseTopLevelFields) ? diagnostics.responseTopLevelFields : [];
  const allGenerationFieldsPresent = generatedFieldsObserved.length === generatedFields.length
    && generatedFields.every((field) => generatedFieldsObserved.includes(field));
  const providerJsonPass = diagnostics.responseJsonParseable === true && diagnostics.contentJsonParseable === true;
  const effectiveModelPass = result?.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL;
  const latencyMs = result?.latencyMs ?? failureDetails?.latencyMs ?? null;
  const requestBytes = typeof diagnostics.requestMetrics?.bodyBytes === "number" ? diagnostics.requestMetrics.bodyBytes : null;
  const responseBytes = typeof diagnostics.responseBodyBytes === "number" ? diagnostics.responseBodyBytes : null;
  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : null;
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : null;
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : null;
  const postResponseEstimateNeurons = inputTokens !== null && outputTokens !== null
    ? estimateCloudflareNeurons({ inputTokens, outputTokens, ...context.rates })
    : null;
  const actualNeurons = typeof diagnostics.actualProviderUnitUsage === "number" ? diagnostics.actualProviderUnitUsage : null;

  assertCloudflareUtcPeriod(context.baseline.utcDate);
  const finalUsage = await new SupabaseAgentLogger(context.db).getProviderDailyUsage(EXPECTED_PROVIDER, context.baseline.utcDate);
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
    try {
      assertCloudflareNoRequestDelta(accountingDelta);
      accountingPass = true;
    } catch {
      accountingPass = false;
    }
  }

  const articlesAfter = await exactCount(context.db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE_AFTER");
  const attemptsAfter = await exactCount(context.db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }).eq("event_key", context.eventKey), "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE_AFTER");
  const sideEffectsPass = articlesAfter === context.articlesBefore && attemptsAfter === context.attemptsBefore;
  const contractPass = httpStatus === 200
    && finishReason !== null && finishReason !== "length"
    && providerJsonPass && generationSchemaPass && allGenerationFieldsPresent
    && deterministicAssemblyPass && numericProvenancePass && preservedNamesPass
    && finalDraftPass && effectiveModelPass && attempts === 1 && retries === 0 && externalRequests === 1;

  const runId = result?.runId ?? logger.runId;
  let telemetryPass = false;
  let secretPersisted = false;
  if (runId) {
    const run = await context.db.from("agent_runs").select("id,status,provider,config,stats,finished_at").eq("id", runId).maybeSingle();
    const logs = await context.db.from("agent_logs").select("step,payload,provider,provider_unit,provider_unit_amount").eq("run_id", runId);
    if (!run.error && run.data && !logs.error && logs.data) {
      const serialized = JSON.stringify([run.data.config, run.data.stats, logs.data]);
      const secrets = ["AGENT_API_KEY", "CEREBRAS_API_KEY", "CLOUDFLARE_AI_API_TOKEN", "SUPABASE_SECRET_KEY"]
        .map((name) => process.env[name]?.trim())
        .filter((value): value is string => Boolean(value));
      secretPersisted = secrets.some((secret) => serialized.includes(secret));
      const stats = object(run.data.stats);
      const telemetry = object(stats.telemetry);
      const reservation = logs.data.find((entry) => entry.step === "provider_request_reserved");
      const reservationPayload = object(reservation?.payload);
      telemetryPass = run.data.provider === EXPECTED_PROVIDER
        && run.data.status === "succeeded"
        && object(run.data.config).validationPurpose === VALIDATION_PURPOSE
        && object(run.data.config).fixture === VALIDATION_FIXTURE
        && telemetry.provider === EXPECTED_PROVIDER
        && telemetry.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL
        && telemetry.providerHttpStatus === 200
        && telemetry.attempts === 1
        && telemetry.retries === 0
        && typeof telemetry.latencyMs === "number"
        && reservation?.provider === EXPECTED_PROVIDER
        && reservation?.provider_unit === "neurons"
        && reservation?.provider_unit_amount === context.estimatedNeurons
        && reservationPayload.providerRequestDispatched === true
        && logs.data.some((entry) => entry.step === "completed");
    }
  }

  const preliminaryStatus = contractPass && accountingPass && sideEffectsPass && telemetryPass && !secretPersisted
    ? "REAL_VALIDATED"
    : "NOT_VALIDATED";
  if (runId) {
    const metadata: AgentRunMetadata = {
      agentName: "editor",
      agentVersion: editorV2AgentVersion,
      eventKey: context.eventKey,
      model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
      provider: EXPECTED_PROVIDER,
      dryRun: true,
    };
    try {
      await logger.log(runId, metadata, {
        level: preliminaryStatus === "REAL_VALIDATED" ? "info" : "warn",
        step: "editor_stage_validation_result",
        message: "Supervised Editor stage validation completed",
        payload: {
          validationPurpose: VALIDATION_PURPOSE,
          fixture: VALIDATION_FIXTURE,
          syntheticIdentity: true,
          stageValidationStatus: preliminaryStatus,
          agentVersion: editorV2AgentVersion,
          provider: EXPECTED_PROVIDER,
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
          postResponseEstimateNeurons,
          actualNeurons: actualNeurons ?? "UNKNOWN",
          generationJsonAndZodPass: providerJsonPass && generationSchemaPass && allGenerationFieldsPresent,
          deterministicAssemblyPass,
          numericProvenancePass,
          numericClaimsChecked: numericReport?.detectedNumericClaims.length ?? null,
          numericClaimsMatched: numericReport?.matchedProvenance.length ?? null,
          preservedNamesPass,
          preservedNamesExpected: context.input.translation.preservedNames.length,
          preservedNamesObserved: preservedReport?.preservedNamesObservedCount ?? null,
          finalEditorialDraftPass: finalDraftPass,
          responseRepair: false,
          accountingDelta,
          failureCode: failure instanceof AgentError ? failure.code : null,
        } as unknown as Json,
        durationMs: latencyMs ?? undefined,
      });
    } catch {
      telemetryPass = false;
    }
  }

  if (externalRequests === 0 && logger.runId) {
    const cleaned = await logger.cleanupUndispatchedRun();
    if (!cleaned) telemetryPass = false;
  }

  const finalStatus = contractPass && accountingPass && sideEffectsPass && telemetryPass && !secretPersisted
    ? "REAL_VALIDATED"
    : "NOT_VALIDATED";
  const resultReport = {
    status: finalStatus,
    provider: EXPECTED_PROVIDER,
    model: result?.model ?? CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    editorVersion: editorV2AgentVersion,
    fixture: context.sourceFixture,
    dryRun: true,
    productionRouterEnabled: freeProviderRouterEnabled(),
    newCloudflareCalls: externalRequests,
    groqCalls: 0,
    cerebrasCalls: 0,
    otherStageCalls: 0,
    httpStatus: httpStatus ?? "UNKNOWN",
    finishReason: finishReason ?? "UNKNOWN",
    providerJsonParseable: diagnostics.responseJsonParseable === true,
    generationJsonParseable: diagnostics.contentJsonParseable === true,
    generationFieldsPresent: allGenerationFieldsPresent,
    generationZod: generationSchemaPass ? "PASS" : "FAIL",
    deterministicAssembly: deterministicAssemblyPass ? "PASS" : "FAIL",
    numericProvenance: numericProvenancePass ? "PASS" : "FAIL",
    numericClaimsChecked: numericReport?.detectedNumericClaims.length ?? "UNKNOWN",
    preservedNames: preservedNamesPass ? "PASS" : "FAIL",
    finalEditorialDraft: finalDraftPass ? "PASS" : "FAIL",
    effectiveModelMatches: effectiveModelPass,
    responseRepair: "NO",
    attempts,
    retries,
    inputTokens: inputTokens ?? "UNKNOWN",
    outputTokens: outputTokens ?? "UNKNOWN",
    totalTokens: totalTokens ?? "UNKNOWN",
    latencyMs: latencyMs ?? "UNKNOWN",
    requestBytes: requestBytes ?? "UNKNOWN",
    responseBytes: responseBytes ?? "UNKNOWN",
    estimatedReservationNeurons: context.estimatedNeurons,
    postResponseEstimateNeurons: postResponseEstimateNeurons ?? "UNKNOWN",
    actualNeurons: actualNeurons ?? "UNKNOWN",
    reservationDelta: accountingDelta.reservations,
    dispatchDelta: accountingDelta.dispatchedRequests,
    reservedNeuronDelta: accountingDelta.reservedEstimatedNeurons,
    accounting: accountingPass ? "PASS" : "FAIL",
    telemetry: telemetryPass && !secretPersisted ? "PASS" : "FAIL",
    productionEventAttemptsForSyntheticKey: attemptsAfter,
    articlesBefore: context.articlesBefore,
    articlesAfter,
    publishedArticlesCreated: 0,
    failureCode: failure instanceof AgentError ? failure.code : finalStatus === "REAL_VALIDATED" ? "NONE" : "BLOCKED_EDITOR_VALIDATION",
  };
  process.stdout.write(`${JSON.stringify(resultReport, null, 2)}\n`);

  if (finalStatus !== "REAL_VALIDATED") process.exitCode = 1;
}

function parseMode(args: string[]): "preflight" | "execute-one-shot" {
  if (args.length === 0) return "preflight";
  if (args.length === 1 && args[0] === "--preflight") return "preflight";
  if (args.length === 1 && args[0] === "--execute-one-shot") return "execute-one-shot";
  throw new Error("BLOCKED_INVALID_VALIDATION_MODE");
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const context = await preparePreflight();
  if (mode === "preflight") {
    process.stdout.write(`${JSON.stringify(preflightReport(context), null, 2)}\n`);
    return;
  }
  await executeOneShot(context);
}

main().catch((error: unknown) => {
  const details = error ? getAgentFailureDetails(error) : null;
  const diagnostics = object(details?.diagnostics ?? details?.telemetry);
  const code = error instanceof Error && /^[A-Z0-9_:-]{3,120}$/.test(error.message)
    ? error.message
    : typeof diagnostics.failureReasonCode === "string"
      ? diagnostics.failureReasonCode
      : typeof diagnostics.guardFailureType === "string"
        ? diagnostics.guardFailureType
        : "BLOCKED_EDITOR_PREFLIGHT_OR_EXECUTION";
  process.stderr.write(`${JSON.stringify({ status: "NOT_VALIDATED", failureCode: code, inferenceCallsMayHaveOccurred: true, noAutomaticRetry: true })}\n`);
  process.exitCode = 1;
});
