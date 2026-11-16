import { z } from "zod";
import { CloudflareWorkersAIModelProvider, createCloudflareWorkersAIValidationCandidateProvider } from "../lib/agents/runtime/cloudflare-workers-ai-provider.ts";
import { AgentError, getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { freeProviderRouterEnabled, readProviderCapacityConfig } from "../lib/agents/runtime/free-provider-router.ts";
import { assertCloudflareNoRequestDelta, assertCloudflareOneRequestDelta, assertCloudflareUtcPeriod, checkCloudflareBaselineCapacity, cloudflareAccountingDelta, createCloudflareAccountingBaseline, type CloudflareAccountingBaseline } from "../lib/agents/runtime/provider-accounting-baseline.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { assertFreeProviderRequest, CLOUDFLARE_LLAMA_VALIDATION_MODEL, CLOUDFLARE_WORKERS_AI_MODEL, cloudflareModelPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import type { AgentExecutionResult, AgentRunMetadata, ModelConfig, ProviderDiagnostics, RequestReservation } from "../lib/agents/runtime/runtime-types.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import {
  EXPECTED_DAILY_NEURON_LIMIT,
  MAX_OUTPUT_TOKENS,
  MAX_REQUESTS,
  MAX_RETRIES,
  SYSTEM_INSTRUCTIONS,
  SYNTHETIC_INPUT,
  ValidationSchema,
  estimateValidationFixtureNeurons,
} from "./cloudflare-validation-fixture.ts";

const phaseArgs = process.argv.slice(2);
if (phaseArgs.length !== 1 || phaseArgs[0] !== "--execute-one-shot") {
  console.error("BLOCKED: use the explicit one-shot command; this script never treats a preflight flag as permission to infer.");
  process.exit(1);
}

class CloudflareValidationLogger extends SupabaseAgentLogger {
  runId: string | null = null;
  private readonly db: ReturnType<typeof createSupabaseServerClient>;
  private readonly allocation: number;
  private readonly estimatedNeurons: number;
  private readonly configuredRequestLimit: number | null;
  private readonly accountingBaseline: CloudflareAccountingBaseline;

  constructor(allocation: number, estimatedNeurons: number, configuredRequestLimit: number | null, accountingBaseline: CloudflareAccountingBaseline) {
    const db = createSupabaseServerClient();
    super(db);
    this.db = db;
    this.allocation = allocation;
    this.estimatedNeurons = estimatedNeurons;
    this.configuredRequestLimit = configuredRequestLimit;
    this.accountingBaseline = accountingBaseline;
  }

  override async startRun(metadata: AgentRunMetadata, startedAt: string): Promise<string | null> {
    this.runId = await super.startRun(metadata, startedAt);
    return this.runId;
  }

  override reserveRequest(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    _dailyLimit: number,
    requestDate: string,
  ): Promise<RequestReservation> {
    assertCloudflareUtcPeriod(this.accountingBaseline.utcDate);
    check(requestDate === this.accountingBaseline.utcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
    return this.reserveCloudflareNeuronCapacity(
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
    assertCloudflareUtcPeriod(this.accountingBaseline.utcDate);
    check(requestDate === this.accountingBaseline.utcDate, "BLOCKED_CLOUDFLARE_UTC_PERIOD_MISMATCH");
    return super.markRequestDispatched(runId, reservationId, requestDate);
  }

  async cleanupUndispatchedRun(): Promise<boolean> {
    if (!this.runId) return true;
    const logs = await this.db.from("agent_logs").delete().eq("run_id", this.runId);
    const run = await this.db.from("agent_runs").delete().eq("id", this.runId);
    return !logs.error && !run.error;
  }
}

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function safeTelemetry(telemetry: ReturnType<typeof getAgentFailureDetails>["telemetry"] | undefined) {
  return {
    provider: telemetry?.provider ?? "cloudflare_workers_ai",
    model: telemetry?.model ?? CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    attempts: telemetry?.attempts ?? 0,
    retries: telemetry?.retries ?? 0,
    httpStatus: telemetry?.providerHttpStatus ?? "UNKNOWN",
    providerRequestDispatched: telemetry?.providerRequestDispatched ?? false,
    inputTokens: telemetry?.inputTokens ?? "UNKNOWN",
    outputTokens: telemetry?.outputTokens ?? "UNKNOWN",
    totalTokens: telemetry?.totalTokens ?? "UNKNOWN",
    finishReason: telemetry?.finishReason ?? "UNKNOWN",
    latencyMs: telemetry?.latencyMs ?? "UNKNOWN",
    requestBytes: telemetry?.requestBytes ?? "UNKNOWN",
    responseBytes: telemetry?.responseBytes ?? "UNKNOWN",
    structuredValidation: telemetry?.zodValid === true ? "PASS" : telemetry?.zodValid === false ? "FAIL" : "UNKNOWN",
    estimatedNeurons: telemetry?.estimatedNeurons ?? "UNKNOWN",
    actualNeurons: telemetry?.actualProviderUnitUsage ?? "UNKNOWN",
  };
}

function safeZodDiagnostic(diagnostics: ProviderDiagnostics | undefined) {
  const issues = diagnostics?.zodIssues ?? [];
  const missingFields = [...new Set([
    ...(diagnostics?.responseMissingTopLevelFields ?? []),
    ...issues.filter((issue) => issue.receivedType === "undefined").map((issue) => issue.path.join(".")),
  ])];
  const unexpectedFields = [...new Set(issues.flatMap((issue) => issue.unexpectedKeys ?? []))];
  return {
    failingPaths: diagnostics?.invalidPaths ?? issues.map((issue) => issue.path.map(String).join(".")),
    missingFields,
    unexpectedFields,
    issues: issues.map((issue) => ({
      path: issue.path,
      category: issue.unexpectedKeys?.length ? "additionalProperties"
        : issue.options?.length ? "enum_or_const_mismatch"
        : issue.receivedType === "undefined" ? "missing_field"
        : issue.code,
      expectedType: issue.expected ?? "UNKNOWN",
      receivedType: issue.receivedType ?? "UNKNOWN",
      expectedValues: issue.options ?? [],
      additionalProperties: issue.unexpectedKeys ?? [],
    })),
  };
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.CLOUDFLARE_AI_API_TOKEN?.trim();
const allocation = Number(process.env.CLOUDFLARE_DAILY_NEURON_LIMIT);
const model = CLOUDFLARE_LLAMA_VALIDATION_MODEL;
const validationEnv = { ...process.env, CLOUDFLARE_MODEL: model };
const capacity = readProviderCapacityConfig("cloudflare_workers_ai", validationEnv);
const dailyDateUtc = new Date().toISOString().slice(0, 10);
const config: ModelConfig = {
  model,
  timeoutMs: 30_000,
  maxRetries: MAX_RETRIES,
  retryBackoffMs: 0,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  dailyRequestLimit: MAX_REQUESTS,
  failOnRateLimit: true,
  allowPaidFallback: false,
  structuredOutputMode: "strict_schema",
};

check(accountId && token, "BLOCKED_CLOUDFLARE_CONFIGURATION");
check(Number.isSafeInteger(allocation) && allocation === EXPECTED_DAILY_NEURON_LIMIT, "BLOCKED_CLOUDFLARE_CONFIGURATION");
check(capacity.configured && capacity.dailyNeuronAllocation === allocation, "BLOCKED_CLOUDFLARE_CONFIGURATION");
check(capacity.model === model, "BLOCKED_CLOUDFLARE_MODEL");
check(!freeProviderRouterEnabled(), "BLOCKED_PRODUCTION_ROUTER_MUST_REMAIN_DISABLED");
check(cloudflareModelPolicy[model].freeApproved && cloudflareModelPolicy[model].structuredProductionApproved === "CANDIDATE" && !cloudflareModelPolicy[model].productionRoutingEnabled, "BLOCKED_CLOUDFLARE_VALIDATION_ONLY_POLICY");
check(cloudflareModelPolicy[CLOUDFLARE_WORKERS_AI_MODEL].structuredProductionApproved === false, "BLOCKED_GPT_OSS_MUST_REMAIN_UNAPPROVED");
check(config.maxRetries === 0 && config.dailyRequestLimit === MAX_REQUESTS, "BLOCKED_ONE_SHOT_GUARD");
assertFreeProviderRequest("cloudflare_workers_ai", model, capacity.endpoint);

const estimatedNeurons = estimateValidationFixtureNeurons(model);
const accountingReader = new SupabaseAgentLogger(createSupabaseServerClient());
const initialUsage = await accountingReader.getProviderDailyUsage("cloudflare_workers_ai", dailyDateUtc);
const accountingBaseline = createCloudflareAccountingBaseline(initialUsage, new Date());
assertCloudflareUtcPeriod(accountingBaseline.utcDate);
const capacityCheck = checkCloudflareBaselineCapacity({
  baseline: accountingBaseline,
  dailyNeuronAllocation: allocation,
  estimatedNextRequestNeurons: estimatedNeurons,
  dailyRequestLimit: capacity.dailyRequestLimit,
  softLimitRatio: capacity.softLimitRatio,
});
const logger = new CloudflareValidationLogger(allocation, estimatedNeurons, capacity.dailyRequestLimit ?? null, accountingBaseline);

let httpRequests = 0;
const guardedFetch: typeof fetch = async (input, init) => {
  assertCloudflareUtcPeriod(accountingBaseline.utcDate);
  check(String(input) === capacity.endpoint, "BLOCKED_NON_CLOUDFLARE_ENDPOINT");
  const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const responseFormat = body.response_format as { type?: unknown; json_schema?: { strict?: unknown } } | undefined;
  check(body.model === model, "BLOCKED_NON_ALLOWLISTED_MODEL");
  check(body.stream === false, "BLOCKED_STREAMING_REQUEST");
  check(body.max_tokens === MAX_OUTPUT_TOKENS && !("max_completion_tokens" in body), "BLOCKED_WRONG_OUTPUT_TOKEN_FIELD");
  check(responseFormat?.type === "json_schema" && responseFormat.json_schema?.strict === true, "BLOCKED_NON_STRICT_STRUCTURED_OUTPUT");
  check(!("tools" in body), "BLOCKED_MODEL_TOOLS");
  httpRequests += 1;
  check(httpRequests <= MAX_REQUESTS, "BLOCKED_MORE_THAN_ONE_CLOUDFLARE_REQUEST");
  return fetch(input, init);
};

const provider = createCloudflareWorkersAIValidationCandidateProvider(guardedFetch);
check(provider instanceof CloudflareWorkersAIModelProvider && provider.providerId === "cloudflare_workers_ai", "BLOCKED_NON_CLOUDFLARE_PROVIDER");

let result: AgentExecutionResult<z.infer<typeof ValidationSchema>> | null = null;
let runFailure: unknown;
try {
  result = await runStructuredAgent({
  agentName: "cloudflare-real-validation-fixture",
  agentVersion: "10g3-validation-v1",
  eventKey: "synthetic-cloudflare-structured-output-check",
  input: SYNTHETIC_INPUT,
  systemInstructions: SYSTEM_INSTRUCTIONS,
  schemaName: "CloudflareValidationFixtureV1",
  schema: ValidationSchema,
  modelConfig: config,
  provider,
  logger,
  dryRun: true,
  requestBudget: new DailyRequestBudget(),
  finalizeOutput: (output, diagnostics) => {
    if (diagnostics?.finishReason === "length") {
      throw new AgentError("invalid_structured_output", "Provider output reached the configured output-token limit", undefined, {
        ...diagnostics,
        provider: "cloudflare_workers_ai",
        httpStatus: 200,
        validationResult: "invalid",
        failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR",
      });
    }
    if (output.schemaVersion !== 1 || output.status !== "ok" || output.provider !== "cloudflare_workers_ai" || output.facts.length !== 1 || output.facts[0].id !== "fictional-fixture" || output.facts[0].evidence.source !== "synthetic_fixture" || !output.facts[0].evidence.verified) {
      throw new Error("SYNTHETIC_FIXTURE_GUARD_FAILED");
    }
    return { output };
  },
});
} catch (error) {
  runFailure = error;
}

if (runFailure) {
  const failure = getAgentFailureDetails(runFailure);
  const telemetry = failure.telemetry;
  const phaseWasDispatched = httpRequests > 0 || telemetry?.providerRequestDispatched === true;
  const undispatchedFixtureCleaned = phaseWasDispatched ? false : await logger.cleanupUndispatchedRun();
  const utcPeriodUnchanged = new Date().toISOString().slice(0, 10) === accountingBaseline.utcDate;
  const finalUsage = utcPeriodUnchanged ? await logger.getProviderDailyUsage("cloudflare_workers_ai", accountingBaseline.utcDate).catch(() => null) : null;
  const phaseDelta = finalUsage ? (() => { try { return cloudflareAccountingDelta(accountingBaseline, finalUsage); } catch { return null; } })() : null;
  let accountingDeltaValidation: "PASS" | "FAIL" | "UNKNOWN" = "UNKNOWN";
  if (phaseDelta) {
    try {
      if (httpRequests > 0 || telemetry?.providerRequestDispatched === true) assertCloudflareOneRequestDelta(phaseDelta, estimatedNeurons);
      else assertCloudflareNoRequestDelta(phaseDelta);
      accountingDeltaValidation = "PASS";
    } catch {
      accountingDeltaValidation = "FAIL";
    }
  }
  const requestStatus = telemetry?.providerHttpStatus ?? "UNKNOWN";
  const blockedReason = requestStatus === 200 && telemetry?.finishReason === "length" ? "BLOCKED_OUTPUT_BUDGET"
    : requestStatus === 400 ? "BLOCKED_STRUCTURED_OUTPUT_COMPATIBILITY"
    : requestStatus === 401 || requestStatus === 403 ? "BLOCKED_CLOUDFLARE_AUTH"
    : requestStatus === 429 ? "PROVIDER_RATE_LIMIT"
    : requestStatus === 200 && telemetry?.zodValid === false ? "BLOCKED_CLOUDFLARE_STRICT_STRUCTURED_OUTPUT"
    : requestStatus === 200 && failure.diagnostics?.contentJsonParseable === false ? "BLOCKED_CLOUDFLARE_STRICT_STRUCTURED_OUTPUT"
    : telemetry?.status ?? (runFailure instanceof AgentError ? runFailure.code : "RUNTIME_ERROR");
  console.error(JSON.stringify({
    status: "FAILURE",
    blockedReason,
    provider: "cloudflare_workers_ai",
    model,
    maxTokensRequested: MAX_OUTPUT_TOKENS,
    attempts: telemetry?.attempts ?? failure.attempts,
    retries: telemetry?.retries ?? 0,
    httpStatus: requestStatus,
    providerRequestDispatched: telemetry?.providerRequestDispatched ?? false,
    inputTokens: telemetry?.inputTokens ?? "UNKNOWN",
    outputTokens: telemetry?.outputTokens ?? "UNKNOWN",
    totalTokens: telemetry?.totalTokens ?? "UNKNOWN",
    finishReason: telemetry?.finishReason ?? "UNKNOWN",
    directJsonParse: failure.diagnostics?.contentJsonParseable === true ? "PASS" : failure.diagnostics?.contentJsonParseable === false ? "FAIL" : "UNKNOWN",
    latencyMs: telemetry?.latencyMs ?? failure.latencyMs,
    requestBytes: telemetry?.requestBytes ?? "UNKNOWN",
    responseBytes: telemetry?.responseBytes ?? "UNKNOWN",
    structuredValidation: telemetry?.zodValid === true ? "PASS" : telemetry?.zodValid === false ? "FAIL" : "UNKNOWN",
    zodFailureCategory: telemetry?.zodValid === false ? "LOCAL_SCHEMA_VALIDATION_ERROR" : "NONE",
    zodDiagnostic: telemetry?.zodValid === false ? safeZodDiagnostic(failure.diagnostics) : "NONE",
    countsTowardRetryLimit: requestStatus === 429 ? false : "NOT_APPLICABLE",
    providerRequests: httpRequests,
    reservationPersisted: (phaseDelta?.reservations ?? 0) > 0,
    undispatchedFixtureCleaned,
    dispatchedRunRetainedForAudit: phaseWasDispatched,
    estimatedNeurons: telemetry?.estimatedNeurons ?? "UNKNOWN",
    baselineReservedNeurons: accountingBaseline.reservedEstimatedNeurons,
    estimatedNewReservation: estimatedNeurons,
    projectedReservedNeurons: accountingBaseline.reservedEstimatedNeurons + estimatedNeurons,
    projectedSoftRemaining: capacityCheck.softRemainingAfterReservation,
    reservedEstimatedNeurons: finalUsage?.neuronsUsed ?? "UNKNOWN",
    actualNeurons: telemetry?.actualProviderUnitUsage ?? "UNKNOWN",
    utcPeriod: accountingBaseline.utcDate,
    utcPeriodUnchanged,
    accountingBaseline: {
      reservations: accountingBaseline.reservations,
      dispatchedRequests: accountingBaseline.dispatchedRequests,
      reservedEstimatedNeurons: accountingBaseline.reservedEstimatedNeurons,
      capturedAt: accountingBaseline.capturedAt,
    },
    accountingDelta: phaseDelta ?? "UNKNOWN",
    accountingDeltaValidation,
    cloudflareRequestsBefore: accountingBaseline.dispatchedRequests,
    cloudflareRequestsAfter: finalUsage?.requestsDispatched ?? "UNKNOWN",
    cloudflareRequestsThisPhase: phaseDelta?.dispatchedRequests ?? "UNKNOWN",
    inputTokensBefore: initialUsage.inputTokens,
    outputTokensBefore: initialUsage.outputTokens,
    totalTokensBefore: initialUsage.totalTokens,
    postResponseEstimatedNeurons: telemetry?.estimatedNeurons ?? "UNKNOWN",
    errorCode: runFailure instanceof AgentError ? runFailure.code : "RUNTIME_ERROR",
    secretValuesLogged: false,
  }, null, 2));
  process.exitCode = 1;
} else {
check(result, "CLOUDFLARE_RESULT_MISSING");

  check(httpRequests === 1, "CLOUDFLARE_REQUEST_COUNT_NOT_EXACTLY_ONE");
  check(result.providerRequestsUsed === 1 && result.attempts === 1, "CLOUDFLARE_ATTEMPT_GUARD_FAILED");
  check(result.telemetry?.provider === "cloudflare_workers_ai" && result.telemetry.model === model, "CLOUDFLARE_IDENTITY_MISMATCH");
  check(result.telemetry?.zodValid === true && result.diagnostics?.validationResult === "valid", "CLOUDFLARE_STRICT_ZOD_VALIDATION_FAILED");
  check(result.diagnostics?.contentJsonParseable === true, "CLOUDFLARE_DIRECT_JSON_PARSE_FAILED");

  assertCloudflareUtcPeriod(accountingBaseline.utcDate);
  const finalUsage = await logger.getProviderDailyUsage("cloudflare_workers_ai", accountingBaseline.utcDate);
  const phaseDelta = cloudflareAccountingDelta(accountingBaseline, finalUsage);
  assertCloudflareOneRequestDelta(phaseDelta, estimatedNeurons);
  check(result.runId, "CLOUDFLARE_RUN_ID_MISSING");

  console.log(JSON.stringify({
  status: "SUCCESS",
  ...safeTelemetry(result.telemetry),
  model,
  maxTokensRequested: MAX_OUTPUT_TOKENS,
  directJsonParse: "PASS",
  outputContentPresent: true,
  strictZodResult: "PASS",
  zodFailureCategory: "NONE",
  structuredOutputRequested: true,
  schemaVersion: result.output.schemaVersion,
  resultStatus: result.output.status,
  factCount: result.output.facts.length,
  reservationPersisted: true,
  responseRepair: "NO",
  accountingBaseline: {
    utcDate: accountingBaseline.utcDate,
    reservations: accountingBaseline.reservations,
    dispatchedRequests: accountingBaseline.dispatchedRequests,
    reservedEstimatedNeurons: accountingBaseline.reservedEstimatedNeurons,
    knownTokenUsage: accountingBaseline.knownTokenUsage,
    capturedAt: accountingBaseline.capturedAt,
  },
  accountingDelta: phaseDelta,
  accounting: "PASS",
  baselineReservedNeurons: accountingBaseline.reservedEstimatedNeurons,
  estimatedNewReservation: estimatedNeurons,
  projectedReservedNeurons: accountingBaseline.reservedEstimatedNeurons + estimatedNeurons,
  projectedSoftRemaining: capacityCheck.softRemainingAfterReservation,
  cloudflareRequestsBefore: accountingBaseline.dispatchedRequests,
  cloudflareRequestsAfter: finalUsage.requestsDispatched,
  cloudflareRequestsThisPhase: phaseDelta.dispatchedRequests,
  phaseReservationDelta: phaseDelta.reservations,
  phaseDispatchDelta: phaseDelta.dispatchedRequests,
  phaseReservedNeuronsDelta: phaseDelta.reservedEstimatedNeurons,
  postReservations: finalUsage.requestsReserved,
  postDispatched: finalUsage.requestsDispatched,
  dailyRequestsDispatched: finalUsage.requestsDispatched,
  reservedEstimatedNeurons: finalUsage.neuronsUsed,
  actualNeurons: "UNKNOWN",
  tokenUsage: finalUsage.tokenUsageKnown ? "KNOWN" : "UNKNOWN",
  allocationNeurons: allocation,
  softUsableNeurons: capacityCheck.softLimitNeurons,
  postResponseEstimatedNeurons: result.telemetry?.estimatedNeurons ?? "UNKNOWN",
  hardAllocationNeurons: allocation,
  softAllocationNeurons: capacityCheck.softLimitNeurons,
  softRemainingNeurons: Math.max(0, capacityCheck.softLimitNeurons - (finalUsage.neuronsUsed ?? 0)),
  utcPeriod: accountingBaseline.utcDate,
  fullEventCapacity: "INSUFFICIENT_SAMPLE",
  productionRouterEnabled: false,
  pipelineStages: 0,
  publisherRuns: 0,
  providerRequests: httpRequests,
  }, null, 2));
}
