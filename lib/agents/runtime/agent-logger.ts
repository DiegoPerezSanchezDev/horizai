import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database, Json } from "../../../types/database.ts";
import { createSupabaseServerClient } from "../../supabase/server-client.ts";
import type { AgentLogEntry, AgentLogger, AgentRunMetadata, DailyRequestAvailability, GroqCapacityLimits, GroqCapacityReservation, GroqTokenSettlementResult, ProviderCapacityReservationContext, ProviderRateLimitSnapshot, ProviderRateLimitTelemetry, RequestReservation } from "./runtime-types.ts";
import { CLOUDFLARE_LLAMA_VALIDATION_MODEL, CLOUDFLARE_WORKERS_AI_MODEL, type ProviderId } from "./provider-cost-policy.ts";
import { assertFreeProviderRequest, freeProviderPolicy } from "./provider-cost-policy.ts";
import { normalizeRateLimitState, rateLimitStateFromTelemetry, type ProviderDailyUsage, type ProviderRateLimitState } from "./free-provider-router.ts";
import { agentTelemetrySchema } from "./telemetry.ts";
import { normalizeGroqProviderRateLimit } from "./model-provider.ts";
import { createSupervisedValidationEventKey, normalEventStages, supervisedValidationAgentVersionAllowlist, validateSupervisedCloudflareStageValidation, type NormalEventStage } from "./cloudflare-stage-validation.ts";
import { authorizeQualityBenchmarkCall, QUALITY_BENCHMARK_MODEL, QUALITY_BENCHMARK_PROVIDER, QUALITY_BENCHMARK_PURPOSE, qualityBenchmarkAccountingEventKey, qualityBenchmarkCases, type QualityBenchmarkCaseId } from "./cloudflare-quality-benchmark.ts";

type AgentSupabase = SupabaseClient<Database>;

function objectJson(values: Record<string, Json | undefined>): Json {
  const result: Record<string, Json> = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined) result[key] = value;
  return result;
}

function errorText(errorMessage: string | undefined): string | null {
  return errorMessage ? errorMessage.slice(0, 2_000) : null;
}

function record(value: Json | undefined): Record<string, Json | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function nonnegativeInteger(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function supervisedCloudflareValidationPurpose(metadata: AgentRunMetadata): `${NormalEventStage}_stage_validation` | undefined {
  if (metadata.provider !== "cloudflare_workers_ai" || metadata.model !== CLOUDFLARE_LLAMA_VALIDATION_MODEL || !metadata.eventKey) return undefined;
  for (const stage of normalEventStages) {
    if (metadata.agentName !== stage || metadata.agentVersion !== supervisedValidationAgentVersionAllowlist[stage]) continue;
    const prefix = `supervised-validation:${stage}_stage_validation:`;
    if (!metadata.eventKey.startsWith(prefix)) continue;
    try {
      if (createSupervisedValidationEventKey(stage, metadata.eventKey.slice(prefix.length)) === metadata.eventKey) return `${stage}_stage_validation`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function utcBounds(dateUtc: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateUtc) || new Date(`${dateUtc}T00:00:00.000Z`).toISOString().slice(0, 10) !== dateUtc) throw new Error("Invalid UTC date");
  const start = `${dateUtc}T00:00:00.000Z`;
  return { start, end: new Date(Date.parse(start) + 86_400_000).toISOString() };
}

const requestReservationSchema = z.object({
  allowed: z.boolean(),
  dailyCount: z.number().int().nonnegative(),
  dailyLimit: z.number().int().positive(),
  requestDate: z.string().date(),
  reservationId: z.number().int().positive().optional(),
});
const cloudflareReservationSchema = z.object({
  allowed: z.boolean(),
  dailyCount: z.number().int().nonnegative(),
  dailyLimit: z.number().int().positive().nullable(),
  usedNeurons: z.number().int().nonnegative(),
  neuronLimit: z.number().int().positive(),
  estimatedNeurons: z.number().int().positive(),
  requestDate: z.string().date(),
  reservationId: z.number().int().positive().optional(),
}).strict();
const groqCapacityReasonSchema = z.enum([
  "GROQ_DAILY_REQUEST_HARD_LIMIT",
  "GROQ_DAILY_REQUEST_SOFT_LIMIT",
  "GROQ_DAILY_TOKEN_HARD_LIMIT",
  "GROQ_DAILY_TOKEN_SOFT_LIMIT",
  "GROQ_DAILY_TOKEN_USAGE_UNKNOWN",
  "GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED",
  "GROQ_TPM_LOCAL_USAGE_UNKNOWN",
]);
const groqCapacityReservationSchema = z.object({
  allowed: z.boolean(),
  admitted: z.boolean(),
  reason: groqCapacityReasonSchema.nullable(),
  dailyCount: z.number().int().nonnegative(),
  dailyLimit: z.number().int().positive(),
  requestDate: z.string().date(),
  quotaPeriodUtc: z.string().date(),
  reservationId: z.number().int().positive().optional(),
  requestUsageBefore: z.number().int().nonnegative(),
  requestUsageAfter: z.number().int().nonnegative(),
  tokenUsageBefore: z.number().int().nonnegative(),
  tokenUsageAfter: z.number().int().nonnegative(),
  reservedTokens: z.number().int().positive(),
  requestHardLimit: z.number().int().positive(),
  requestSoftLimit: z.number().int().positive(),
  tokenHardLimit: z.number().int().positive(),
  tokenSoftLimit: z.number().int().positive(),
  minuteTokenUsageBefore: z.number().int().nonnegative(),
  minuteTokenUsageAfter: z.number().int().nonnegative(),
  minuteTokenHardLimit: z.number().int().positive(),
  safetyMarginTokens: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.allowed !== value.admitted) context.addIssue({ code: "custom", message: "allowed/admitted mismatch" });
  if (value.requestDate !== value.quotaPeriodUtc) context.addIssue({ code: "custom", message: "request UTC period mismatch" });
  if (value.requestSoftLimit > value.requestHardLimit || value.tokenSoftLimit > value.tokenHardLimit) context.addIssue({ code: "custom", message: "soft limit exceeds hard limit" });
  if (value.allowed && value.reservationId === undefined) context.addIssue({ code: "custom", message: "admitted reservation has no identity" });
  if (value.allowed && (value.requestUsageAfter !== value.requestUsageBefore + 1 || value.tokenUsageAfter !== value.tokenUsageBefore + value.reservedTokens)) context.addIssue({ code: "custom", message: "reservation deltas are inconsistent" });
  if (!value.allowed && (value.requestUsageAfter !== value.requestUsageBefore || value.tokenUsageAfter !== value.tokenUsageBefore || value.reservationId !== undefined)) context.addIssue({ code: "custom", message: "denied reservation changed the ledger" });
  if (value.allowed && value.minuteTokenUsageAfter !== value.minuteTokenUsageBefore + value.reservedTokens) context.addIssue({ code: "custom", message: "minute reservation deltas are inconsistent" });
  if (!value.allowed && value.minuteTokenUsageAfter !== value.minuteTokenUsageBefore) context.addIssue({ code: "custom", message: "denied minute reservation changed the ledger" });
});
const groqTokenSettlementSchema = z.object({
  settled: z.literal(true),
  changed: z.boolean(),
  actualTokens: z.number().int().positive(),
  reservedTokensBefore: z.number().int().positive(),
  accountedTokens: z.number().int().positive(),
  deltaTokens: z.number().int(),
}).strict();

type InMemoryReservation = {
  runId: string;
  dispatched: boolean;
  provider: string;
  neurons: number | null;
  tokens: number | null;
  tokenHardLimit: number | null;
  tokenSoftLimit: number | null;
  tokenUsageState: "reserved_estimate" | "settled" | null;
  actualInputTokens: number | null;
  actualOutputTokens: number | null;
  createdAtUtc: string;
};

export class SupabaseAgentLogger implements AgentLogger {
  private readonly supabase: AgentSupabase;
  private readonly qualityBenchmarkAuthorization?: {
    benchmarkCaseId: QualityBenchmarkCaseId;
    stage: NormalEventStage;
    inputSha256: string;
  };

  constructor(
    supabase: AgentSupabase = createSupabaseServerClient(),
    qualityBenchmarkAuthorization?: { benchmarkCaseId: QualityBenchmarkCaseId; stage: NormalEventStage; inputSha256: string },
  ) {
    this.supabase = supabase;
    this.qualityBenchmarkAuthorization = qualityBenchmarkAuthorization;
  }

  private qualityBenchmarkMetadata(metadata: AgentRunMetadata, attempt = 1): AgentRunMetadata {
    const authorization = this.qualityBenchmarkAuthorization;
    if (!authorization) return metadata;
    const benchmarkCase = qualityBenchmarkCases[authorization.benchmarkCaseId];
    if (metadata.eventKey !== benchmarkCase.historicalEventKey || metadata.dryRun !== true) {
      throw new Error("Cloudflare quality benchmark input identity or dry-run mismatch");
    }
    const accountingEventKey = qualityBenchmarkAccountingEventKey(authorization.benchmarkCaseId, authorization.stage);
    authorizeQualityBenchmarkCall({
      benchmarkCaseId: authorization.benchmarkCaseId,
      stage: authorization.stage,
      agentVersion: metadata.agentVersion,
      eventKey: accountingEventKey,
      purpose: QUALITY_BENCHMARK_PURPOSE,
      provider: metadata.provider ?? "",
      model: metadata.model,
      attempt,
      maxRetries: 0,
      inputSha256: authorization.inputSha256,
    });
    if (metadata.agentName !== authorization.stage) throw new Error("Cloudflare quality benchmark stage/agent mismatch");
    return { ...metadata, eventKey: accountingEventKey };
  }

  async startRun(metadata: AgentRunMetadata, startedAt: string): Promise<string | null> {
    metadata = this.qualityBenchmarkMetadata(metadata);
    const validationPurpose = supervisedCloudflareValidationPurpose(metadata);
    const { data, error } = await this.supabase
      .from("agent_runs")
      .insert({
        run_type: "other",
        started_at: startedAt,
        status: "running",
        provider: metadata.provider === "groq" || metadata.provider === "cerebras" || metadata.provider === "cloudflare_workers_ai" ? metadata.provider : null,
        dry_run: metadata.dryRun,
        stats: {},
        config: {
          agentName: metadata.agentName,
          agentVersion: metadata.agentVersion,
          eventKey: metadata.eventKey,
          ...(metadata.pipelineRunId ? { pipelineRunId: metadata.pipelineRunId } : {}),
          ...(metadata.attemptId ? { attemptId: metadata.attemptId } : {}),
          model: metadata.model,
          provider: metadata.provider,
          dryRun: metadata.dryRun,
          ...(validationPurpose ? { validationPurpose } : {}),
          ...(this.qualityBenchmarkAuthorization ? {
            validationPurpose: QUALITY_BENCHMARK_PURPOSE,
            benchmarkCaseId: this.qualityBenchmarkAuthorization.benchmarkCaseId,
            stage: this.qualityBenchmarkAuthorization.stage,
            inputSha256: this.qualityBenchmarkAuthorization.inputSha256,
          } : {}),
        },
      })
      .select("id")
      .single();
    if (error) throw new Error(`create agent_run: ${error.message}`);
    return data.id;
  }

  async reserveRequest(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    dailyLimit: number,
    requestDate: string,
    capacity?: ProviderCapacityReservationContext
  ): Promise<RequestReservation> {
    if (this.qualityBenchmarkAuthorization) {
      const benchmarkMetadata = this.qualityBenchmarkMetadata(metadata, attempt);
      if (!capacity || capacity.provider !== QUALITY_BENCHMARK_PROVIDER) throw new Error("Cloudflare quality benchmark Neuron reservation context is required");
      return this.reserveCloudflareQualityBenchmarkCapacity(
        runId,
        benchmarkMetadata,
        this.qualityBenchmarkAuthorization.benchmarkCaseId,
        this.qualityBenchmarkAuthorization.stage,
        attempt,
        capacity.requestLimit,
        requestDate,
        capacity.hardNeuronLimit,
        capacity.estimatedNeurons,
      );
    }
    if (metadata.provider === "groq") return this.reserveProviderRequest(runId, metadata, attempt, dailyLimit, requestDate, "groq");
    if (metadata.provider === "cloudflare_workers_ai") {
      if (!capacity || capacity.provider !== "cloudflare_workers_ai") throw new Error("Cloudflare Neuron reservation context is required");
      return this.reserveCloudflareNeuronCapacity(runId, metadata, attempt, capacity.requestLimit, requestDate, capacity.neuronLimit, capacity.estimatedNeurons);
    }
    throw new Error("Provider-scoped capacity reservation is required");
  }

  async reserveCloudflareQualityBenchmarkCapacity(
    runId: string | null,
    metadata: AgentRunMetadata,
    benchmarkCaseId: QualityBenchmarkCaseId,
    stage: NormalEventStage,
    attempt: number,
    requestLimit: number | null,
    requestDate: string,
    dailyNeuronAllocation: number,
    estimatedNeurons: number,
  ): Promise<RequestReservation> {
    if (!runId || metadata.provider !== QUALITY_BENCHMARK_PROVIDER || !metadata.eventKey) throw new Error("Cloudflare quality benchmark run identity is required");
    const authorization = this.qualityBenchmarkAuthorization;
    if (!authorization || authorization.benchmarkCaseId !== benchmarkCaseId || authorization.stage !== stage) throw new Error("Cloudflare quality benchmark logger binding mismatch");
    const validated = authorizeQualityBenchmarkCall({
      benchmarkCaseId,
      stage,
      agentVersion: metadata.agentVersion,
      eventKey: metadata.eventKey,
      purpose: QUALITY_BENCHMARK_PURPOSE,
      provider: metadata.provider,
      model: metadata.model,
      attempt,
      maxRetries: 0,
      inputSha256: authorization.inputSha256,
    });
    if (metadata.agentName !== validated.stage || metadata.dryRun !== true || metadata.model !== QUALITY_BENCHMARK_MODEL) throw new Error("Cloudflare quality benchmark agent identity mismatch");
    const { data, error } = await this.supabase.rpc("reserve_cloudflare_quality_benchmark_capacity", {
      p_run_id: runId,
      p_stage: validated.stage,
      p_benchmark_case_id: validated.benchmarkCaseId,
      p_agent_name: metadata.agentName,
      p_agent_version: metadata.agentVersion,
      p_event_key: metadata.eventKey,
      p_attempt: attempt,
      p_validation_purpose: QUALITY_BENCHMARK_PURPOSE,
      p_provider: QUALITY_BENCHMARK_PROVIDER,
      p_model: QUALITY_BENCHMARK_MODEL,
      p_request_date: requestDate,
      p_request_limit: requestLimit,
      p_daily_neuron_allocation: dailyNeuronAllocation,
      p_estimated_neurons: estimatedNeurons,
    });
    if (error) throw new Error("Unable to reserve supervised Cloudflare quality benchmark capacity");
    const result = cloudflareReservationSchema.parse(data);
    if (result.allowed && result.reservationId === undefined) throw new Error("Cloudflare quality benchmark RPC returned no auditable reservation id");
    return result;
  }

  async reserveProviderRequest(runId: string | null, metadata: AgentRunMetadata, attempt: number, dailyLimit: number, requestDate: string, provider: ProviderId): Promise<RequestReservation> {
    if (!runId) throw new Error("Persistent provider reservation requires an agent_run");
    if (provider === "cerebras") {
      if (metadata.model !== "gpt-oss-120b") throw new Error("Historical Cerebras accounting identity mismatch");
    } else {
      assertFreeProviderRequest(provider, metadata.model, freeProviderPolicy[provider].endpoint);
    }
    if (metadata.provider !== provider) throw new Error("Provider reservation/run mismatch");
    const { data, error } = await this.supabase.rpc("reserve_provider_agent_request", {
      p_run_id: runId, p_agent_name: metadata.agentName, p_agent_version: metadata.agentVersion,
      p_event_key: metadata.eventKey, p_attempt: attempt, p_model: metadata.model,
      p_request_date: requestDate, p_limit: dailyLimit, p_provider: provider,
    });
    if (error) throw new Error("Unable to reserve provider-scoped request");
    return requestReservationSchema.parse(data);
  }

  async reserveGroqCapacity(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    requestDate: string,
    limits: GroqCapacityLimits,
    estimatedTokens: number
  ): Promise<GroqCapacityReservation> {
    if (!runId) throw new Error("Persistent Groq capacity reservation requires an agent_run");
    if (metadata.provider !== "groq" || metadata.model !== "openai/gpt-oss-20b") throw new Error("Groq capacity reservation identity mismatch");
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1) throw new Error("Invalid Groq capacity reservation input");
    utcBounds(requestDate);
    if (![limits.requestHardLimit, limits.requestSoftLimit, limits.tokenHardLimit, limits.tokenSoftLimit, limits.tokenMinuteHardLimit].every((value) => Number.isSafeInteger(value) && value! > 0)
      || limits.requestSoftLimit > limits.requestHardLimit || limits.tokenSoftLimit > limits.tokenHardLimit) throw new Error("Invalid Groq capacity limits");
    const { data, error } = await this.supabase.rpc("reserve_groq_request_and_tokens_m35", {
      p_run_id: runId,
      p_agent_name: metadata.agentName,
      p_agent_version: metadata.agentVersion,
      p_event_key: metadata.eventKey,
      p_attempt: attempt,
      p_model: metadata.model,
      p_request_date: requestDate,
      p_request_hard_limit: limits.requestHardLimit,
      p_request_soft_limit: limits.requestSoftLimit,
      p_token_hard_limit: limits.tokenHardLimit,
      p_token_soft_limit: limits.tokenSoftLimit,
      p_token_minute_hard_limit: limits.tokenMinuteHardLimit!,
      p_safety_margin_tokens: 128,
      p_estimated_tokens: estimatedTokens,
    });
    if (error) throw new Error("Unable to reserve atomic Groq request and token capacity");
    return groqCapacityReservationSchema.parse(data);
  }

  async reserveCloudflareNeuronCapacity(runId: string | null, metadata: AgentRunMetadata, attempt: number, requestLimit: number | null, requestDate: string, dailyNeuronAllocation: number, estimatedNeurons: number): Promise<RequestReservation> {
    if (!runId) throw new Error("Persistent Cloudflare capacity reservation requires an agent_run");
    const isExistingModel = metadata.model === CLOUDFLARE_WORKERS_AI_MODEL;
    const isOneShotCandidate = metadata.model === CLOUDFLARE_LLAMA_VALIDATION_MODEL
      && metadata.agentName === "cloudflare-real-validation-fixture"
      && metadata.agentVersion === "10g3-validation-v1"
      && metadata.eventKey === "synthetic-cloudflare-structured-output-check"
      && attempt === 1;
    if (metadata.provider !== "cloudflare_workers_ai" || (!isExistingModel && !isOneShotCandidate)) throw new Error("Cloudflare provider/model mismatch");
    const { data, error } = await this.supabase.rpc("reserve_cloudflare_neuron_capacity", {
      p_run_id: runId, p_agent_name: metadata.agentName, p_agent_version: metadata.agentVersion,
      p_event_key: metadata.eventKey, p_attempt: attempt, p_model: metadata.model,
      p_request_date: requestDate, p_request_limit: requestLimit,
      p_daily_neuron_allocation: dailyNeuronAllocation, p_estimated_neurons: estimatedNeurons,
    });
    if (error) throw new Error("Unable to reserve Cloudflare neuron capacity");
    const result = cloudflareReservationSchema.parse(data);
    if (result.allowed && result.reservationId === undefined) throw new Error("Cloudflare capacity RPC returned no auditable reservation id");
    return result;
  }

  async reserveCloudflareSupervisedCriticValidationCapacity(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    requestLimit: number | null,
    requestDate: string,
    dailyNeuronAllocation: number,
    estimatedNeurons: number,
  ): Promise<RequestReservation> {
    const validationPurpose = supervisedCloudflareValidationPurpose(metadata);
    if (!runId || validationPurpose !== "critic_stage_validation" || attempt !== 1 || !metadata.eventKey) {
      throw new Error("Cloudflare supervised validation identity mismatch");
    }
    const { data, error } = await this.supabase.rpc("reserve_cloudflare_supervised_critic_validation_capacity", {
      p_run_id: runId,
      p_agent_name: metadata.agentName,
      p_agent_version: metadata.agentVersion,
      p_event_key: metadata.eventKey,
      p_attempt: attempt,
      p_validation_purpose: validationPurpose,
      p_model: metadata.model,
      p_request_date: requestDate,
      p_request_limit: requestLimit,
      p_daily_neuron_allocation: dailyNeuronAllocation,
      p_estimated_neurons: estimatedNeurons,
    });
    if (error) throw new Error("Unable to reserve supervised Cloudflare Critic capacity");
    const result = cloudflareReservationSchema.parse(data);
    if (result.allowed && result.reservationId === undefined) throw new Error("Cloudflare validation RPC returned no auditable reservation id");
    return result;
  }

  async reserveCloudflareSupervisedStageValidationCapacity(
    runId: string | null,
    metadata: AgentRunMetadata,
    stage: NormalEventStage,
    fixture: string,
    attempt: number,
    requestLimit: number | null,
    requestDate: string,
    dailyNeuronAllocation: number,
    estimatedNeurons: number,
  ): Promise<RequestReservation> {
    if (!runId || !metadata.eventKey) throw new Error("Cloudflare supervised stage validation identity mismatch");
    const validation = validateSupervisedCloudflareStageValidation({
      stage,
      fixture,
      provider: metadata.provider ?? "",
      model: metadata.model,
      agentVersion: metadata.agentVersion,
      eventKey: metadata.eventKey,
      maxAttempts: attempt,
      maxRetries: 0,
    });
    if (metadata.agentName !== validation.stage || metadata.agentVersion !== validation.agentVersion) {
      throw new Error("Cloudflare supervised stage validation identity mismatch");
    }
    const { data, error } = await this.supabase.rpc("reserve_cloudflare_supervised_stage_validation_capacity", {
      p_run_id: runId,
      p_stage: validation.stage,
      p_agent_name: metadata.agentName,
      p_agent_version: metadata.agentVersion,
      p_event_key: metadata.eventKey,
      p_fixture: validation.fixture,
      p_attempt: attempt,
      p_validation_purpose: validation.validationPurpose,
      p_provider: validation.provider,
      p_model: validation.model,
      p_request_date: requestDate,
      p_request_limit: requestLimit,
      p_daily_neuron_allocation: dailyNeuronAllocation,
      p_estimated_neurons: estimatedNeurons,
    });
    if (error) throw new Error("Unable to reserve supervised Cloudflare stage capacity");
    const result = cloudflareReservationSchema.parse(data);
    if (result.allowed && result.reservationId === undefined) throw new Error("Cloudflare stage validation RPC returned no auditable reservation id");
    return result;
  }

  async getProviderDailyUsage(provider: ProviderId, dateUtc: string): Promise<ProviderDailyUsage> {
    const { start, end } = utcBounds(dateUtc);
    const response = await this.supabase.from("agent_logs").select("id,run_id,payload,provider,provider_unit,provider_unit_amount,created_at", { count: "exact" })
      .eq("step", "provider_request_reserved").gte("created_at", start).lt("created_at", end).range(0, 999);
    if (response.error || !response.data || response.count === null || response.count > response.data.length) throw new Error("Unable to read complete provider request ledger");
    const reservations = response.data.filter((row) => row.provider === provider || (provider === "groq" && row.provider === null)
      || (provider === "cloudflare_workers_ai" && record(row.payload).provider === provider));
    if (provider === "cloudflare_workers_ai") {
      const attemptKeys = new Set<string>();
      for (const row of reservations) {
        const payload = record(row.payload);
        const attempt = nonnegativeInteger(payload.attempt);
        if (row.provider !== provider || payload.provider !== provider || payload.requestDate !== dateUtc
          || typeof payload.providerRequestDispatched !== "boolean" || attempt === null || attempt < 1) {
          throw new Error("Inconsistent Cloudflare provider reservation ledger");
        }
        const attemptKey = `${row.run_id}:${attempt}`;
        if (attemptKeys.has(attemptKey)) throw new Error("Duplicate Cloudflare provider reservation identity");
        attemptKeys.add(attemptKey);
        if (payload.providerRequestDispatched) {
          if (typeof payload.dispatchedAt !== "string" || !Number.isFinite(Date.parse(payload.dispatchedAt))) {
            throw new Error("Cloudflare dispatched reservation has no valid dispatch timestamp");
          }
        } else if (payload.dispatchedAt !== undefined) {
          throw new Error("Undispatched Cloudflare reservation has a dispatch timestamp");
        }
      }
    }
    const dispatched = reservations.filter((row) => record(row.payload).providerRequestDispatched === true);
    const ids = [...new Set(reservations.map((row) => row.run_id))];
    const runs = ids.length ? await this.supabase.from("agent_runs").select("id,provider,stats").in("id", ids) : { data: [], error: null };
    if (runs.error || !runs.data || runs.data.length !== ids.length) throw new Error("Unable to read complete provider run telemetry");
    const byId = new Map(runs.data.map((row) => [row.id, row]));
    if (provider === "cloudflare_workers_ai" && reservations.some((row) => byId.get(row.run_id)?.provider !== provider)) {
      throw new Error("Cloudflare reservation has no provider-matched run");
    }
    const perRun = new Map<string, number>();
    for (const row of reservations) perRun.set(row.run_id, (perRun.get(row.run_id) ?? 0) + 1);
    let inputTokens = 0, outputTokens = 0, totalTokens = 0, unknownTokenRequests = 0;
    for (const row of reservations) {
      if (provider === "groq" && row.provider_unit === "tokens") {
        const amount = row.provider_unit_amount;
        const payload = record(row.payload);
        const state = payload.tokenUsageState;
        if (!Number.isSafeInteger(amount) || (amount ?? 0) < 1 || (state !== "reserved_estimate" && state !== "settled")) {
          unknownTokenRequests += 1;
          continue;
        }
        totalTokens += amount!;
        if (state === "settled") {
          const settledInput = nonnegativeInteger(payload.actualInputTokens);
          const settledOutput = nonnegativeInteger(payload.actualOutputTokens);
          const settledTotal = nonnegativeInteger(payload.actualTokens);
          if (settledInput === null || settledOutput === null || settledTotal !== amount || settledInput + settledOutput !== amount) {
            unknownTokenRequests += 1;
            continue;
          }
          inputTokens += settledInput;
          outputTokens += settledOutput;
        }
        // reserved_estimate is fully accounted for capacity even though the
        // provider's eventual actual token usage is not yet known.
        continue;
      }
      const run = byId.get(row.run_id);
      const telemetry = record(record(run?.stats ?? {}).telemetry ?? {});
      const known = record(row.payload).providerRequestDispatched === true
        && perRun.get(row.run_id) === 1 && (run?.provider === provider || (provider === "groq" && run?.provider === null))
        && (telemetry.provider === provider || (provider === "groq" && run?.provider === "groq" && telemetry.provider === undefined))
        && telemetry.providerRequestsUsed === 1;
      if (!known) { unknownTokenRequests += 1; continue; }
      const input = nonnegativeInteger(telemetry.inputTokens);
      const output = nonnegativeInteger(telemetry.outputTokens);
      const total = nonnegativeInteger(telemetry.totalTokens);
      if (input === null || output === null || total === null || input + output > total) { unknownTokenRequests += 1; continue; }
      inputTokens += input; outputTokens += output; totalTokens += total;
    }
    const neuronRows = reservations.filter((row) => row.provider_unit === "neurons");
    const neuronsUsed = neuronRows.reduce((sum, row) => sum + (row.provider_unit_amount ?? 0), 0);
    const neuronUsageKnown = provider !== "cloudflare_workers_ai" || neuronRows.length === reservations.length && neuronRows.every((row) => Number.isSafeInteger(row.provider_unit_amount) && (row.provider_unit_amount ?? 0) > 0);
    return { provider, dateUtc, requestsReserved: reservations.length, requestsDispatched: dispatched.length, inputTokens, outputTokens, totalTokens, tokenUsageKnown: unknownTokenRequests === 0, unknownTokenRequests, neuronsUsed, neuronUsageKnown };
  }

  async getProviderRateLimitState(provider: ProviderId): Promise<ProviderRateLimitState | null> {
    const response = await this.supabase.from("agent_runs").select("stats,provider,finished_at").eq("provider", provider).not("finished_at", "is", null).order("finished_at", { ascending: false }).limit(100);
    if (response.error || !response.data) throw new Error("Unable to read provider rate-limit state");
    for (const row of response.data) {
      const telemetry = record(record(row.stats).telemetry ?? {});
      if (telemetry.provider !== undefined && telemetry.provider !== provider) continue;
      if (telemetry.providerHttpStatus === 200) return null;
      if (telemetry.providerHttpStatus !== 429 && telemetry.errorCategory !== "RATE_LIMIT") continue;
      if (telemetry.provider === undefined) {
        const headers = agentTelemetrySchema.shape.rateLimitHeaders.safeParse(telemetry.rateLimitHeaders ?? null);
        return normalizeRateLimitState(provider, row.finished_at ?? new Date().toISOString(), headers.success ? headers.data : null, true);
      }
      const valid = agentTelemetrySchema.safeParse(telemetry);
      if (!valid.success) throw new Error("Invalid persisted provider rate-limit telemetry");
      const parsed = rateLimitStateFromTelemetry(valid.data);
      if (parsed) return parsed;
    }
    return null;
  }

  async getLatestProviderRateLimitTelemetry(provider: ProviderId, eventKey: string): Promise<ProviderRateLimitTelemetry | null> {
    const response = await this.supabase.from("agent_runs").select("stats,provider,finished_at")
      .eq("provider", provider).contains("config", { eventKey }).not("finished_at", "is", null)
      .order("finished_at", { ascending: false }).limit(1);
    if (response.error || !response.data) throw new Error("Unable to read event-scoped provider rate-limit telemetry");
    const row = response.data[0];
    if (!row) return null;
    const telemetryRecord = record(record(row.stats).telemetry);
    const parsed = agentTelemetrySchema.safeParse(telemetryRecord);
    if (!parsed.success) throw new Error("Invalid persisted event-scoped provider telemetry");
    if (parsed.data.provider !== provider) return null;
    return parsed.data.providerRateLimit ?? (provider === "groq" ? normalizeGroqProviderRateLimit(parsed.data.rateLimitHeaders) : null);
  }

  async getLatestProviderRateLimitSnapshot(provider: ProviderId): Promise<ProviderRateLimitSnapshot | null> {
    if (provider !== "groq") return null;
    const response = await this.supabase.from("agent_runs").select("stats,provider,finished_at")
      .eq("provider", provider).not("finished_at", "is", null).order("finished_at", { ascending: false }).limit(100);
    if (response.error || !response.data) throw new Error("Unable to read global provider rate-limit telemetry");
    for (const row of response.data) {
      const parsed = agentTelemetrySchema.safeParse(record(record(row.stats).telemetry));
      if (!parsed.success || parsed.data.provider !== provider || parsed.data.providerRequestsUsed < 1) continue;
      const telemetry = parsed.data.providerRateLimit ?? normalizeGroqProviderRateLimit(parsed.data.rateLimitHeaders);
      if (typeof row.finished_at !== "string" || !Number.isFinite(Date.parse(row.finished_at))) continue;
      return { observedAt: row.finished_at, telemetry };
    }
    return null;
  }

  async releaseRequest(runId: string | null, reservationId: number, requestDate: string): Promise<boolean> {
    if (!runId) throw new Error("Persistent reservation release requires an agent_run");
    const { data, error } = await this.supabase.rpc("release_agent_request", { p_reservation_id: reservationId, p_run_id: runId, p_request_date: requestDate });
    if (error) throw new Error("Unable to release pre-dispatch request reservation");
    return data === true;
  }

  async releaseGroqCapacityPreDispatch(runId: string | null, reservationId: number, requestDate: string): Promise<boolean> {
    return this.releaseRequest(runId, reservationId, requestDate);
  }

  async markRequestDispatched(runId: string | null, reservationId: number, requestDate: string): Promise<boolean> {
    if (!runId) throw new Error("Persistent dispatch marker requires an agent_run");
    const { data, error } = await this.supabase.rpc("mark_agent_request_dispatched", { p_reservation_id: reservationId, p_run_id: runId, p_request_date: requestDate });
    if (error) throw new Error("Unable to mark provider request dispatch");
    return data === true;
  }

  async settleGroqTokenUsage(
    runId: string | null,
    reservationId: number,
    requestDate: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<GroqTokenSettlementResult> {
    if (!runId) throw new Error("Persistent Groq token settlement requires an agent_run");
    if (![reservationId, inputTokens, outputTokens].every(Number.isSafeInteger) || reservationId < 1 || inputTokens < 0 || outputTokens < 0 || inputTokens + outputTokens < 1) {
      throw new Error("Invalid Groq token settlement input");
    }
    utcBounds(requestDate);
    const { data, error } = await this.supabase.rpc("settle_groq_token_usage", {
      p_reservation_id: reservationId,
      p_run_id: runId,
      p_request_date: requestDate,
      p_actual_input_tokens: inputTokens,
      p_actual_output_tokens: outputTokens,
    });
    if (error) {
      if (error.message.includes("provider_token_settlement_conflict")) throw new Error("provider_token_settlement_conflict");
      throw new Error("Unable to settle Groq token usage");
    }
    return groqTokenSettlementSchema.parse(data);
  }

  async getRemainingRequests(dailyLimit: number, requestDate: string): Promise<DailyRequestAvailability> {
    const start = `${requestDate}T00:00:00.000Z`;
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    const { count, error } = await this.supabase
      .from("agent_logs")
      .select("id", { count: "exact", head: true })
      .eq("step", "provider_request_reserved")
      .or("provider.eq.groq,provider.is.null")
      .gte("created_at", start)
      .lt("created_at", end);
    if (error || count === null) throw new Error("Unable to determine persisted daily request usage");
    return { requestDate, dailyLimit, used: count, remaining: Math.max(0, dailyLimit - count) };
  }

  async log(runId: string | null, metadata: AgentRunMetadata, entry: AgentLogEntry): Promise<void> {
    if (!runId) return;
    metadata = this.qualityBenchmarkMetadata(metadata);
    const validationPurpose = supervisedCloudflareValidationPurpose(metadata);
    const payload = objectJson({
      runId,
      agentVersion: metadata.agentVersion,
      eventKey: metadata.eventKey,
      model: metadata.model,
      provider: metadata.provider,
      validationPurpose: this.qualityBenchmarkAuthorization ? QUALITY_BENCHMARK_PURPOSE : validationPurpose,
      benchmarkCaseId: this.qualityBenchmarkAuthorization?.benchmarkCaseId,
      inputSha256: this.qualityBenchmarkAuthorization?.inputSha256,
      attempt: typeof entry.payload === "object" && entry.payload !== null && !Array.isArray(entry.payload)
        ? (entry.payload as Record<string, Json>).attempt
        : undefined,
      details: entry.payload,
    });
    const { error } = await this.supabase.from("agent_logs").insert({
      run_id: runId,
      agent_name: metadata.agentName,
      step: entry.step,
      level: entry.level,
      message: entry.message,
      payload,
      provider: metadata.provider === "groq" || metadata.provider === "cerebras" || metadata.provider === "cloudflare_workers_ai" ? metadata.provider : null,
      duration_ms: entry.durationMs ?? null,
    });
    if (error) throw new Error(`create agent_log: ${error.message}`);
  }

  async finishRun(
    runId: string | null,
    _metadata: AgentRunMetadata,
    status: "succeeded" | "failed",
    finishedAt: string,
    stats: Json = {},
    errorMessage?: string
  ): Promise<void> {
    if (!runId) return;
    const { error } = await this.supabase
      .from("agent_runs")
      .update({ status, finished_at: finishedAt, stats, error_message: errorText(errorMessage) })
      .eq("id", runId);
    if (error) throw new Error(`finish agent_run: ${error.message}`);
  }
}

export class InMemoryAgentLogger implements AgentLogger {
  readonly runs: Array<{ id: string; metadata: AgentRunMetadata; status: string; startedAt?: string; finishedAt?: string; stats?: Json }> = [];
  readonly entries: Array<{ runId: string | null; metadata: AgentRunMetadata; entry: AgentLogEntry }> = [];
  private readonly reservations = new Map<string, Map<number, InMemoryReservation>>();
  private readonly rateLimitBlocks = new Map<string, string>();
  private nextId = 1;

  async startRun(metadata: AgentRunMetadata, startedAt?: string): Promise<string> {
    const id = `mock-run-${this.nextId++}`;
    this.runs.push({ id, metadata, status: "running", startedAt });
    return id;
  }

  async reserveRequest(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    dailyLimit: number,
    requestDate: string,
    capacity?: ProviderCapacityReservationContext
  ): Promise<RequestReservation> {
    if (!runId) throw new Error("Persistent request reservation requires an agent_run");
    const provider = metadata.provider ?? "mock";
    if (provider === "cloudflare_workers_ai" && (!capacity || capacity.provider !== provider)) throw new Error("Cloudflare Neuron reservation context is required");
    const dayReservations = this.reservations.get(requestDate) ?? new Map<number, InMemoryReservation>();
    this.reservations.set(requestDate, dayReservations);
    const providerReservations = [...dayReservations.values()].filter((row) => row.provider === provider);
    const applicableRequestLimit = provider === "cloudflare_workers_ai" ? capacity?.requestLimit ?? null : dailyLimit;
    const count = providerReservations.length;
    const usedNeurons = providerReservations.reduce((sum, row) => sum + (row.neurons ?? 0), 0);
    const estimatedNeurons = capacity?.estimatedNeurons ?? null;
    if ((applicableRequestLimit !== null && count >= applicableRequestLimit)
      || (capacity && usedNeurons + capacity.estimatedNeurons > capacity.neuronLimit)) {
      return { allowed: false, dailyCount: count, dailyLimit: applicableRequestLimit, requestDate };
    }
    const next = count + 1;
    const reservationId = this.nextId++;
    dayReservations.set(reservationId, { runId, dispatched: false, provider, neurons: estimatedNeurons, tokens: null, tokenHardLimit: null, tokenSoftLimit: null, tokenUsageState: null, actualInputTokens: null, actualOutputTokens: null, createdAtUtc: new Date().toISOString() });
    this.entries.push({
      runId,
      metadata,
      entry: {
        level: "info",
        step: "provider_request_reserved",
        message: "Provider request reserved",
        payload: { attempt, requestDate, reservationId, provider, ...(estimatedNeurons === null ? {} : { estimatedNeurons }) },
      },
    });
    return { allowed: true, dailyCount: next, dailyLimit: applicableRequestLimit, requestDate, reservationId };
  }

  async reserveProviderRequest(runId: string | null, metadata: AgentRunMetadata, attempt: number, dailyLimit: number, requestDate: string, provider: "groq"): Promise<RequestReservation> {
    if (metadata.provider !== provider) throw new Error("Provider reservation/run mismatch");
    return this.reserveRequest(runId, metadata, attempt, dailyLimit, requestDate);
  }

  async reserveGroqCapacity(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    requestDate: string,
    limits: GroqCapacityLimits,
    estimatedTokens: number
  ): Promise<GroqCapacityReservation> {
    if (!runId || !this.runs.some((run) => run.id === runId && run.metadata.provider === "groq")) throw new Error("Provider-matched Groq run is required");
    if (metadata.provider !== "groq" || metadata.model !== "openai/gpt-oss-20b") throw new Error("Groq capacity reservation identity mismatch");
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1) throw new Error("Invalid Groq capacity reservation input");
    if (![limits.requestHardLimit, limits.requestSoftLimit, limits.tokenHardLimit, limits.tokenSoftLimit, limits.tokenMinuteHardLimit].every((value) => Number.isSafeInteger(value) && value! > 0)
      || limits.requestSoftLimit > limits.requestHardLimit || limits.tokenSoftLimit > limits.tokenHardLimit) throw new Error("Invalid Groq capacity limits");

    const dayReservations = this.reservations.get(requestDate) ?? new Map<number, InMemoryReservation>();
    const rows = [...dayReservations.values()].filter((row) => row.provider === "groq");
    const requestUsageBefore = rows.length;
    const tokenUsageBefore = rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
    const now = Date.now();
    const rollingRows = rows.filter((row) => now - Date.parse(row.createdAtUtc) < 60_000);
    const minuteTokenUsageBefore = rollingRows.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
    const minuteUsageUnknown = rollingRows.some((row) => row.tokens === null);
    const safetyMarginTokens = 128;
    let reason: GroqCapacityReservation["reason"] = null;
    if (rows.some((row) => row.tokens === null)) reason = "GROQ_DAILY_TOKEN_USAGE_UNKNOWN";
    else if (minuteUsageUnknown) reason = "GROQ_TPM_LOCAL_USAGE_UNKNOWN";
    else if (minuteTokenUsageBefore + estimatedTokens + safetyMarginTokens > limits.tokenMinuteHardLimit!) reason = "GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED";
    else if (requestUsageBefore + 1 > limits.requestHardLimit) reason = "GROQ_DAILY_REQUEST_HARD_LIMIT";
    else if (requestUsageBefore + 1 > limits.requestSoftLimit) reason = "GROQ_DAILY_REQUEST_SOFT_LIMIT";
    else if (tokenUsageBefore + estimatedTokens > limits.tokenHardLimit) reason = "GROQ_DAILY_TOKEN_HARD_LIMIT";
    else if (tokenUsageBefore + estimatedTokens > limits.tokenSoftLimit) reason = "GROQ_DAILY_TOKEN_SOFT_LIMIT";

    const admitted = reason === null;
    const reservationId = admitted ? this.nextId++ : undefined;
    if (admitted && reservationId !== undefined) {
      dayReservations.set(reservationId, {
        runId, dispatched: false, provider: "groq", neurons: null, tokens: estimatedTokens,
        tokenHardLimit: limits.tokenHardLimit, tokenSoftLimit: limits.tokenSoftLimit,
        tokenUsageState: "reserved_estimate", actualInputTokens: null, actualOutputTokens: null,
        createdAtUtc: new Date(now).toISOString(),
      });
      this.reservations.set(requestDate, dayReservations);
      this.entries.push({ runId, metadata, entry: {
        level: "info", step: "provider_request_reserved", message: "Groq request and token capacity reserved",
        payload: { attempt, requestDate, reservationId, provider: "groq", estimatedTokens, tokenUsageState: "reserved_estimate" },
      } });
    }
    return groqCapacityReservationSchema.parse({
      allowed: admitted, admitted, reason,
      dailyCount: requestUsageBefore + (admitted ? 1 : 0), dailyLimit: limits.requestHardLimit,
      requestDate, quotaPeriodUtc: requestDate, ...(reservationId === undefined ? {} : { reservationId }),
      requestUsageBefore, requestUsageAfter: requestUsageBefore + (admitted ? 1 : 0),
      tokenUsageBefore, tokenUsageAfter: tokenUsageBefore + (admitted ? estimatedTokens : 0),
      reservedTokens: estimatedTokens,
      requestHardLimit: limits.requestHardLimit,
      requestSoftLimit: limits.requestSoftLimit,
      tokenHardLimit: limits.tokenHardLimit,
      tokenSoftLimit: limits.tokenSoftLimit,
      minuteTokenUsageBefore,
      minuteTokenUsageAfter: minuteTokenUsageBefore + (admitted ? estimatedTokens : 0),
      minuteTokenHardLimit: limits.tokenMinuteHardLimit!,
      safetyMarginTokens,
    });
  }

  async releaseRequest(runId: string | null, reservationId: number, requestDate: string): Promise<boolean> {
    const dayReservations = this.reservations.get(requestDate);
    const reservation = dayReservations?.get(reservationId);
    if (!runId || !reservation || reservation.runId !== runId || reservation.dispatched) return false;
    dayReservations?.delete(reservationId);
    return true;
  }

  async releaseGroqCapacityPreDispatch(runId: string | null, reservationId: number, requestDate: string): Promise<boolean> {
    return this.releaseRequest(runId, reservationId, requestDate);
  }

  async markRequestDispatched(runId: string | null, reservationId: number, requestDate: string): Promise<boolean> {
    const reservation = this.reservations.get(requestDate)?.get(reservationId);
    if (!runId || !reservation || reservation.runId !== runId || reservation.dispatched) return false;
    reservation.dispatched = true;
    return true;
  }

  async settleGroqTokenUsage(
    runId: string | null,
    reservationId: number,
    requestDate: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<GroqTokenSettlementResult> {
    const reservation = this.reservations.get(requestDate)?.get(reservationId);
    if (!runId || !reservation || reservation.runId !== runId || reservation.provider !== "groq" || reservation.tokens === null) throw new Error("Owned Groq token reservation not found");
    if (!reservation.dispatched) throw new Error("Groq token settlement requires a dispatched request");
    if (![inputTokens, outputTokens].every(Number.isSafeInteger) || inputTokens < 0 || outputTokens < 0 || inputTokens + outputTokens < 1) throw new Error("Invalid Groq token usage");
    const actualTokens = inputTokens + outputTokens;
    if (reservation.tokenUsageState === "settled") {
      if (reservation.tokens !== actualTokens) throw new Error("provider_token_settlement_conflict");
      return groqTokenSettlementSchema.parse({
        settled: true, changed: false, actualTokens, reservedTokensBefore: reservation.tokens,
        accountedTokens: reservation.tokens, deltaTokens: 0,
      });
    }
    if (reservation.tokenUsageState !== "reserved_estimate") throw new Error("Groq token reservation state is not settleable");
    const reservedTokensBefore = reservation.tokens;
    reservation.tokens = actualTokens;
    reservation.tokenUsageState = "settled";
    reservation.actualInputTokens = inputTokens;
    reservation.actualOutputTokens = outputTokens;
    return groqTokenSettlementSchema.parse({
      settled: true, changed: true, actualTokens, reservedTokensBefore,
      accountedTokens: actualTokens, deltaTokens: actualTokens - reservedTokensBefore,
    });
  }

  getGroqTokenReservationSnapshot(requestDate: string, reservationId: number): {
    runId: string; dispatched: boolean; accountedTokens: number; tokenUsageState: InMemoryReservation["tokenUsageState"];
  } | null {
    const row = this.reservations.get(requestDate)?.get(reservationId);
    if (!row || row.provider !== "groq" || row.tokens === null) return null;
    return { runId: row.runId, dispatched: row.dispatched, accountedTokens: row.tokens, tokenUsageState: row.tokenUsageState };
  }

  async getRemainingRequests(dailyLimit: number, requestDate: string): Promise<DailyRequestAvailability> {
    const used = [...(this.reservations.get(requestDate)?.values() ?? [])].filter((row) => row.provider === "groq").length;
    return { requestDate, dailyLimit, used, remaining: Math.max(0, dailyLimit - used) };
  }

  async getProviderDailyUsage(provider: ProviderId, dateUtc: string) {
    const rows = [...(this.reservations.get(dateUtc)?.values() ?? [])].filter((row) => row.provider === provider);
    const neuronsUsed = rows.reduce((sum, row) => sum + (row.neurons ?? 0), 0);
    const inputTokens = provider === "groq" ? rows.reduce((sum, row) => sum + (row.actualInputTokens ?? 0), 0) : 0;
    const outputTokens = provider === "groq" ? rows.reduce((sum, row) => sum + (row.actualOutputTokens ?? 0), 0) : 0;
    const totalTokens = provider === "groq" ? rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0) : 0;
    const unknownTokenRequests = rows.filter((row) => provider === "groq" ? row.tokens === null : true).length;
    return { provider, dateUtc, requestsReserved: rows.length, requestsDispatched: rows.filter((row) => row.dispatched).length, inputTokens, outputTokens, totalTokens, tokenUsageKnown: provider === "groq" ? unknownTokenRequests === 0 : false, unknownTokenRequests, neuronsUsed, neuronUsageKnown: provider !== "cloudflare_workers_ai" || rows.every((row) => row.neurons !== null) };
  }

  async getProviderRateLimitState(provider: ProviderId): Promise<{ blockedUntil: string | null } | null> {
    const blockedUntil = this.rateLimitBlocks.get(provider);
    return blockedUntil ? { blockedUntil } : null;
  }

  async getLatestProviderRateLimitTelemetry(provider: ProviderId, eventKey: string): Promise<ProviderRateLimitTelemetry | null> {
    const latest = this.runs
      .filter((run) => run.metadata.provider === provider && run.metadata.eventKey === eventKey && !!run.finishedAt)
      .sort((left, right) => Date.parse(right.finishedAt ?? "") - Date.parse(left.finishedAt ?? ""))[0];
    if (!latest) return null;
    const parsed = agentTelemetrySchema.safeParse(record(record(latest.stats).telemetry));
    if (!parsed.success || parsed.data.provider !== provider) return null;
    return parsed.data.providerRateLimit ?? (provider === "groq" ? normalizeGroqProviderRateLimit(parsed.data.rateLimitHeaders) : null);
  }

  async getLatestProviderRateLimitSnapshot(provider: ProviderId): Promise<ProviderRateLimitSnapshot | null> {
    if (provider !== "groq") return null;
    const latest = this.runs
      .filter((run) => run.metadata.provider === provider && !!run.finishedAt)
      .sort((left, right) => Date.parse(right.finishedAt ?? "") - Date.parse(left.finishedAt ?? ""))
      .find((run) => {
        const parsed = agentTelemetrySchema.safeParse(record(record(run.stats).telemetry));
        return parsed.success && parsed.data.provider === provider && parsed.data.providerRequestsUsed > 0;
      });
    if (!latest?.finishedAt) return null;
    const parsed = agentTelemetrySchema.safeParse(record(record(latest.stats).telemetry));
    if (!parsed.success || parsed.data.provider !== provider) return null;
    const telemetry = parsed.data.providerRateLimit ?? normalizeGroqProviderRateLimit(parsed.data.rateLimitHeaders);
    return { observedAt: latest.finishedAt, telemetry };
  }

  markProviderRateLimited(provider: "groq" | "cloudflare_workers_ai", blockedUntil: string): void {
    this.rateLimitBlocks.set(provider, blockedUntil);
  }

  async log(runId: string | null, metadata: AgentRunMetadata, entry: AgentLogEntry): Promise<void> {
    this.entries.push({ runId, metadata, entry });
  }

  async finishRun(runId: string | null, _metadata: AgentRunMetadata, status: "succeeded" | "failed", finishedAt?: string, stats?: Json): Promise<void> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (run) {
      run.status = status;
      run.finishedAt = finishedAt;
      run.stats = stats;
    }
  }
}
