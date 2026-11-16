import { z } from "zod";
import { AgentError, AgentTimeoutError, errorSummary, FreeTierLimitReachedError, getProviderDiagnostics, isRetryableAgentError, PaidProviderForbiddenError, setAgentFailureDetails, StructuredOutputError } from "./agent-errors.ts";
import { normalizeGroqProviderRateLimit, type ModelProvider } from "./model-provider.ts";
import { parseStructuredOutput } from "./structured-output.ts";
import { withRetries } from "./retry.ts";
import { DailyRequestBudget, DailyRequestLimitReachedError, defaultProviderScopedDailyRequestBudget, ProviderScopedDailyRequestBudget, readOptionalCloudflareDailyRequestLimit, validateCostGuardConfig, type DailyRequestBudgetReservation } from "./request-budget.ts";
import { assertFreeProviderRequest, freeProviderPolicy, type ProviderId } from "./provider-cost-policy.ts";
import { estimateCloudflareNeurons, readCloudflareNeuronRates, readProviderSoftLimitRatio } from "./free-provider-router.ts";
import { toStrictProviderJsonSchema } from "./strict-json-schema.ts";
import { GEMINI_PROVIDER_ID } from "./gemini-policy.ts";
import { isGeminiAccountedProvider } from "./gemini-provider.ts";
import { decideGroqProviderHeaderAdmission, estimateGroqStageTokenRequirement } from "./groq-capacity-pacing.ts";
import { normalEventStages } from "./event-model-stages.ts";
import { buildAgentTelemetry, telemetryStatusFromError } from "./telemetry.ts";
import type { AgentExecutionResult, AgentLogger, AgentRunMetadata, FinalizeStructuredOutput, GroqCapacityReservation, ModelConfig, ProviderDiagnostics, RequestMetrics, RequestReservation } from "./runtime-types.ts";

type RunStructuredAgentOptions<TInput, TGenerated, TOutput = TGenerated> = {
  agentName: string;
  agentVersion: string;
  eventKey?: string | null;
  pipelineRunId?: string;
  attemptId?: string;
  input: TInput;
  systemInstructions: string;
  schemaName: string;
  schema: z.ZodType<TGenerated>;
  modelConfig: ModelConfig;
  provider: ModelProvider;
  logger?: AgentLogger;
  dryRun?: boolean;
  requestBudget?: DailyRequestBudget | ProviderScopedDailyRequestBudget;
  requestMetrics?: RequestMetrics;
  diagnosticsContext?: Partial<ProviderDiagnostics>;
  generatedOutputDiagnostics?: (value: unknown) => Partial<ProviderDiagnostics>;
  finalizeOutput?: FinalizeStructuredOutput<TGenerated, TOutput>;
};

async function callWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AgentTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Max time to wait for the rolling Groq minute window before giving up and deferring. Env override is for tests. */
function groqLocalTpmPacingMaxWaitMs(): number {
  const raw = process.env.GROQ_TPM_PACING_MAX_WAIT_MS;
  if (raw === undefined) return 70_000;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 90_000 ? value : 70_000;
}

async function safeLog(logger: AgentLogger | undefined, runId: string | null, metadata: AgentRunMetadata, entry: Parameters<AgentLogger["log"]>[2]): Promise<void> {
  try {
    await logger?.log(runId, metadata, entry);
  } catch {
    // Observability must never turn a valid model result into a different result.
  }
}

export async function runStructuredAgent<TInput, TGenerated, TOutput = TGenerated>(options: RunStructuredAgentOptions<TInput, TGenerated, TOutput>): Promise<AgentExecutionResult<TOutput>> {
  validateCostGuardConfig(options.modelConfig);
  const rawProvider = options.provider.providerId;
  if (rawProvider !== "groq" && rawProvider !== "cloudflare_workers_ai" && rawProvider !== "mock" && rawProvider !== GEMINI_PROVIDER_ID) throw new PaidProviderForbiddenError();
  // Gemini is accounted by its own local ledger inside the provider (see gemini-capacity.ts); it never touches the
  // Groq/Cloudflare reservation RPCs or the process-wide request budget, and it is only reachable through an activated GeminiModelProvider.
  const geminiProvider = rawProvider === GEMINI_PROVIDER_ID ? options.provider : null;
  if (geminiProvider && !isGeminiAccountedProvider(geminiProvider)) throw new PaidProviderForbiddenError();
  const providerId: ProviderId | "mock" = rawProvider === GEMINI_PROVIDER_ID ? "mock" : rawProvider;
  const metadataProvider: string = rawProvider;
  if (providerId === "groq") {
    const limits = options.modelConfig.groqCapacity;
    if (!limits) throw new AgentError("cost_guard_violation", "Groq atomic request/token capacity limits are required before dispatch");
    if (![limits.requestHardLimit, limits.requestSoftLimit, limits.tokenHardLimit, limits.tokenSoftLimit].every((value) => Number.isSafeInteger(value) && value > 0)
      || limits.requestSoftLimit > limits.requestHardLimit || limits.tokenSoftLimit > limits.tokenHardLimit
      || limits.requestHardLimit > options.modelConfig.dailyRequestLimit) {
      throw new AgentError("cost_guard_violation", "Invalid Groq atomic request/token capacity limits");
    }
    if (!options.logger?.reserveGroqCapacity || !options.logger.releaseGroqCapacityPreDispatch || !options.logger.settleGroqTokenUsage) {
      throw new AgentError("cost_guard_violation", "Groq atomic reservation, release, and settlement methods are required");
    }
    if (normalEventStages.includes(options.agentName as (typeof normalEventStages)[number]) && (!Number.isSafeInteger(limits.tokenMinuteHardLimit) || limits.tokenMinuteHardLimit! < 1)) {
      throw new AgentError("cost_guard_violation", "Groq TPM hard limit is required for six-stage event pacing");
    }
  }
  if (geminiProvider && isGeminiAccountedProvider(geminiProvider)) geminiProvider.assertRequestApproved(options.modelConfig.model);
  if (providerId !== "mock") {
    const endpoint = providerId === "groq"
      ? freeProviderPolicy.groq.endpoint
      : `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? ""}/ai/v1/chat/completions`;
    assertFreeProviderRequest(providerId, options.modelConfig.model, endpoint);
  }
  const requestBudget = options.requestBudget ?? defaultProviderScopedDailyRequestBudget;
  const reserveLocalRequest = (limit: number) => requestBudget instanceof ProviderScopedDailyRequestBudget
    ? requestBudget.reserve(providerId, limit)
    : requestBudget.reserve(limit, providerId);
  const releaseLocalRequest = (requestDate: string) => requestBudget instanceof ProviderScopedDailyRequestBudget
    ? requestBudget.release(providerId, requestDate)
    : requestBudget.release(requestDate, providerId);
  const markLocalRateLimit = () => { if (!geminiProvider) requestBudget.markRateLimited(providerId); };
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const metadata: AgentRunMetadata = {
    agentName: options.agentName,
    agentVersion: options.agentVersion,
    eventKey: options.eventKey ?? null,
    ...(options.pipelineRunId ? { pipelineRunId: options.pipelineRunId } : {}),
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
    model: options.modelConfig.model,
    provider: metadataProvider,
    dryRun: options.dryRun ?? true,
  };
  let runId: string | null = null;
  try {
    if (!options.logger) throw new AgentError("cost_guard_violation", "Persistent request logger is required before calling the model");
    runId = await options.logger.startRun(metadata, startedAtIso);
    if (!runId) throw new AgentError("cost_guard_violation", "Could not establish an agent_run for request accounting");
  } catch (error) {
    const failure = error instanceof AgentError ? error : new AgentError("cost_guard_violation", "Could not establish persistent request accounting", error);
    setAgentFailureDetails(failure, { attempts: 0, latencyMs: Date.now() - startedAt });
    throw failure;
  }
  let attempts = 0;
  let providerRequestsUsed = 0;
  let latestGroqPacingSnapshot: import("./runtime-types.ts").ProviderRateLimitSnapshot | null = null;
  let diagnostics: ProviderDiagnostics | undefined = options.diagnosticsContext;
  let retrySystemInstructions = options.systemInstructions;
  const bestEffortRetry = (error: unknown): boolean => {
    if (options.modelConfig.structuredOutputMode !== "best_effort_schema" && options.modelConfig.structuredOutputMode !== "json_object") return false;
    const errorDiagnostics = getProviderDiagnostics(error);
    return errorDiagnostics?.failureKind === "LOCAL_JSON_PARSE_ERROR" || errorDiagnostics?.failureKind === "LOCAL_SCHEMA_VALIDATION_ERROR";
  };
  try {
    const result = await withRetries(
      async (attempt) => {
        attempts = attempt;
        const cloudflareRequestLimit = providerId === "cloudflare_workers_ai" ? readOptionalCloudflareDailyRequestLimit() : null;
        const usesLocalRequestBudget = !geminiProvider && (providerId !== "cloudflare_workers_ai" || cloudflareRequestLimit !== null);
        const requestDate = requestBudget.currentDateUtc();
        let localReservation: DailyRequestBudgetReservation | null = null;
        let providerRequestDispatched = false;
        let reservation: RequestReservation | GroqCapacityReservation;
        let capacity: import("./runtime-types.ts").ProviderCapacityReservationContext | undefined;
        if (providerId === "cloudflare_workers_ai") {
          const allocationRaw = process.env.CLOUDFLARE_DAILY_NEURON_LIMIT?.trim() || process.env.CLOUDFLARE_FREE_DAILY_NEURON_ALLOCATION?.trim();
          const hardNeuronLimit = Number(allocationRaw);
          if (!allocationRaw || !Number.isSafeInteger(hardNeuronLimit) || hardNeuronLimit < 1) throw new AgentError("cost_guard_violation", "CLOUDFLARE_DAILY_NEURON_LIMIT must be configured as a positive integer");
          const softRatio = readProviderSoftLimitRatio();
          const softNeuronLimit = Math.floor(hardNeuronLimit * softRatio);
          if (softNeuronLimit < 1) throw new AgentError("cost_guard_violation", "Cloudflare soft Neuron limit must be positive");
          if (!options.logger!.getProviderDailyUsage) throw new AgentError("cost_guard_violation", "Provider-scoped Cloudflare Neuron usage reader is required");
          const currentUsage = await options.logger!.getProviderDailyUsage("cloudflare_workers_ai", requestDate);
          if (!currentUsage.neuronUsageKnown || currentUsage.neuronsUsed === undefined) throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "Cloudflare Neuron usage is unknown; refusing dispatch");
          const rates = readCloudflareNeuronRates(process.env, options.modelConfig.model);
          const schemaChars = JSON.stringify(toStrictProviderJsonSchema(options.schema)).length;
          const estimatedInputTokens = Math.ceil((options.systemInstructions.length + JSON.stringify(options.input).length + schemaChars) / 2) + 128;
          const estimatedNeurons = estimateCloudflareNeurons({ inputTokens: estimatedInputTokens, outputTokens: options.modelConfig.maxOutputTokens, ...rates });
          const projectedNeurons = currentUsage.neuronsUsed + estimatedNeurons;
          const allowed = projectedNeurons < softNeuronLimit && projectedNeurons <= hardNeuronLimit;
          await safeLog(options.logger, runId, metadata, {
            level: allowed ? "info" : "warn",
            step: "provider_capacity_decision",
            message: "Provider-scoped Neuron capacity evaluated before dispatch",
            payload: { provider: providerId, dimension: "neurons", currentUsage: currentUsage.neuronsUsed, hardLimit: hardNeuronLimit, softLimit: softNeuronLimit, projectedUsage: projectedNeurons, eligible: allowed, reason: allowed ? "FREE_NEURON_CAPACITY_AVAILABLE" : projectedNeurons > hardNeuronLimit ? "HARD_NEURON_CAPACITY_EXHAUSTED" : "DAILY_NEURON_SOFT_LIMIT" },
          });
          if (!allowed) throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "Cloudflare Neuron soft capacity exhausted; refusing dispatch");
          capacity = { provider: "cloudflare_workers_ai", requestLimit: cloudflareRequestLimit, hardNeuronLimit, neuronLimit: softNeuronLimit - 1, estimatedNeurons };
        }
        if (providerId !== "mock" && options.logger!.getProviderRateLimitState) {
          const block = await options.logger!.getProviderRateLimitState(providerId);
          if (block?.blockedUntil && Date.parse(block.blockedUntil) > Date.now()) {
            if (providerId === "groq") await safeLog(options.logger, runId, metadata, {
              level: "warn", step: "groq_tpm_pacing_decision", message: "Groq is temporarily blocked by provider rate-limit state",
              payload: { provider: "groq", reason: "GROQ_TEMPORARILY_BLOCKED", blockedUntil: block.blockedUntil },
            });
            throw new FreeTierLimitReachedError({ provider: providerId, providerRequestDispatched: false });
          }
        }
        let groqStageEstimate: number | null = null;
        if (providerId === "groq") {
          const limits = options.modelConfig.groqCapacity!;
          const estimate = estimateGroqStageTokenRequirement({
            systemInstructionChars: options.systemInstructions.length,
            modelInputChars: JSON.stringify(options.input).length,
            schemaChars: JSON.stringify(toStrictProviderJsonSchema(options.schema)).length,
            maxOutputTokens: options.modelConfig.maxOutputTokens,
          });
          groqStageEstimate = estimate.estimatedStageTokenRequirement;
          const intrinsicDecision = decideGroqProviderHeaderAdmission({
            estimatedStageTokenRequirement: groqStageEstimate,
            tokenLimitTpm: limits.tokenMinuteHardLimit!,
          });
          if (intrinsicDecision.decision === "INTRINSICALLY_TOO_LARGE") {
            await safeLog(options.logger, runId, metadata, {
              level: "error", step: "groq_tpm_pacing_decision", message: "Groq request exceeds the configured single-request hard TPM bound",
              payload: { provider: "groq", stage: options.agentName, reason: "GROQ_REQUEST_INTRINSICALLY_TOO_LARGE", estimatedStageTokenRequirement: groqStageEstimate, requiredTokens: intrinsicDecision.requiredTokens, tokenLimitTpm: intrinsicDecision.hardLimitTokens, providerRequestDispatched: false },
            });
            throw new AgentError(options.agentName === "verifier" ? "VERIFIER_INPUT_TOO_LARGE" : "cost_guard_violation", "Groq request exceeds the static single-request TPM capacity");
          }
        }
        if (usesLocalRequestBudget) localReservation = reserveLocalRequest(providerId === "cloudflare_workers_ai" ? cloudflareRequestLimit! : options.modelConfig.dailyRequestLimit);
        try {
          if (providerId === "groq") {
            const limits = options.modelConfig.groqCapacity!;
            const estimate = groqStageEstimate === null ? estimateGroqStageTokenRequirement({
              systemInstructionChars: options.systemInstructions.length,
              modelInputChars: JSON.stringify(options.input).length,
              schemaChars: JSON.stringify(toStrictProviderJsonSchema(options.schema)).length,
              maxOutputTokens: options.modelConfig.maxOutputTokens,
            }) : { estimatedStageTokenRequirement: groqStageEstimate, estimator: "existing_chars_per_2_plus_128_overhead" };
            await safeLog(options.logger, runId, metadata, {
              level: "info", step: "provider_capacity_decision",
              message: "Groq request and token capacity will be reserved atomically",
              payload: { provider: providerId, estimatedTokens: estimate.estimatedStageTokenRequirement, estimator: estimate.estimator, ...limits },
            });
            reservation = await options.logger!.reserveGroqCapacity!(runId, metadata, attempt, requestDate, limits, estimate.estimatedStageTokenRequirement);
            // The per-minute window is a rolling 60 s and self-heals. A denial for that reason happens before any
            // provider dispatch, so waiting and asking again is pacing, not a provider retry. Daily limits and
            // unknown usage are never waited out.
            const pacingDeadline = Date.now() + groqLocalTpmPacingMaxWaitMs();
            while (!reservation.allowed && reservation.reason === "GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED" && Date.now() < pacingDeadline) {
              await safeLog(options.logger, runId, metadata, {
                level: "info", step: "groq_tpm_pacing_decision", message: "Waiting for the rolling Groq minute window before dispatch",
                payload: { provider: "groq", stage: options.agentName, reason: "GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED", minuteTokenUsageBefore: (reservation as GroqCapacityReservation).minuteTokenUsageBefore, estimatedTokens: estimate.estimatedStageTokenRequirement, providerRequestDispatched: false },
              });
              await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, Math.max(250, pacingDeadline - Date.now()))));
              reservation = await options.logger!.reserveGroqCapacity!(runId, metadata, attempt, requestDate, limits, estimate.estimatedStageTokenRequirement);
            }
          } else if (geminiProvider) {
            // The provider reserves RPM/RPD/TPM/TPD itself right before dispatch and fails closed; there is no durable
            // Gemini ledger yet, so this marker only keeps the attempt bookkeeping uniform. No logger RPC is called.
            reservation = { allowed: true, dailyCount: 0, dailyLimit: null, requestDate, reservationId: attempt };
          } else {
            reservation = await options.logger!.reserveRequest(runId, metadata, attempt, options.modelConfig.dailyRequestLimit, requestDate, capacity);
          }
        } catch (error) {
          if (localReservation) releaseLocalRequest(requestDate);
          throw new AgentError("cost_guard_violation", "Could not determine persisted daily request usage", error);
        }
        if (!reservation.allowed) {
          if (localReservation) releaseLocalRequest(requestDate);
          if (providerId === "cloudflare_workers_ai") throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "Cloudflare provider-scoped capacity reservation was denied");
          if (providerId === "groq") {
            const reason = reservation.reason ?? "GROQ_CAPACITY_UNAVAILABLE";
            if (reason.includes("UNKNOWN")) throw new AgentError("cost_guard_violation", `Groq durable capacity state is unknown: ${reason}`);
            throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", `Groq request/token capacity reservation denied: ${reason}`);
          }
          throw new DailyRequestLimitReachedError(reservation.dailyLimit ?? options.modelConfig.dailyRequestLimit);
        }
        if (reservation.reservationId === undefined) throw new AgentError("cost_guard_violation", "Persistent request reservation did not return an auditable reservation ID");
        const reservationId = reservation.reservationId;
        if (providerId === "groq") {
          const limits = options.modelConfig.groqCapacity!;
          const groqReservation = reservation as GroqCapacityReservation;
          const releasePreDispatchReservation = async (): Promise<void> => {
            try {
              const released = await options.logger!.releaseGroqCapacityPreDispatch!(runId, reservationId, requestDate);
              if (!released) throw new Error("Groq pre-dispatch reservation was not released");
              if (localReservation) {
                releaseLocalRequest(requestDate);
                localReservation = null;
              }
            } catch (error) {
              await safeLog(options.logger, runId, metadata, {
                level: "error", step: "reservation_release_failed", message: "Groq header admission could not release its pre-dispatch reservation",
                payload: { attempt, requestDate, reservationId, error: errorSummary(error).message },
              });
              throw new AgentError("cost_guard_violation", "Could not release Groq reservation after header admission stopped", error);
            }
          };

          let providerSnapshot = latestGroqPacingSnapshot;
          try {
            if (!providerSnapshot) providerSnapshot = await options.logger!.getLatestProviderRateLimitSnapshot?.("groq") ?? null;
          } catch (error) {
            await releasePreDispatchReservation();
            throw new AgentError("cost_guard_violation", "Could not read persisted Groq provider-header state", error);
          }
          const admitByHeaders = () => decideGroqProviderHeaderAdmission({
            estimatedStageTokenRequirement: groqStageEstimate!,
            tokenLimitTpm: limits.tokenMinuteHardLimit!,
            providerSnapshot,
            now: new Date(),
          });
          let headerAdmission = admitByHeaders();
          // Fresh provider headers describe a per-minute window that resets by itself (tokenResetSeconds). When the
          // remaining wait fits the pacing budget we keep the pre-dispatch reservation, wait for that reset and
          // re-evaluate once the snapshot goes stale. Nothing has been dispatched, so this is pacing, not a retry.
          const headerPacingDeadline = Date.now() + groqLocalTpmPacingMaxWaitMs();
          while (headerAdmission.decision === "DEFER_TEMPORARY_CAPACITY" && Date.now() < headerPacingDeadline) {
            const observedAtMs = providerSnapshot ? Date.parse(providerSnapshot.observedAt) : Number.NaN;
            const resetSeconds = providerSnapshot?.telemetry.tokenResetSeconds;
            const untilResetMs = Number.isFinite(observedAtMs) && typeof resetSeconds === "number" && Number.isFinite(resetSeconds)
              ? Math.max(0, resetSeconds * 1_000 - (Date.now() - observedAtMs)) + 750
              : 5_000;
            const waitMs = Math.min(Math.max(untilResetMs, 500), 20_000);
            if (Date.now() + waitMs > headerPacingDeadline) break;
            await safeLog(options.logger, runId, metadata, {
              level: "info", step: "groq_tpm_pacing_decision", message: "Waiting for the provider-reported Groq minute window to reset before dispatch",
              payload: { provider: "groq", stage: options.agentName, reason: "GROQ_TPM_FRESH_HEADER_CAPACITY_EXHAUSTED", waitMs, requiredTokens: headerAdmission.requiredTokens, remainingTokens: headerAdmission.remainingTokens, providerRequestDispatched: false },
            });
            await new Promise((resolve) => setTimeout(resolve, waitMs));
            headerAdmission = admitByHeaders();
          }
          if (headerAdmission.decision === "INTRINSICALLY_TOO_LARGE") {
            await releasePreDispatchReservation();
            throw new AgentError(options.agentName === "verifier" ? "VERIFIER_INPUT_TOO_LARGE" : "cost_guard_violation", "Groq request exceeds the static single-request TPM capacity");
          }
          if (headerAdmission.decision === "DEFER_TEMPORARY_CAPACITY") {
            await safeLog(options.logger, runId, metadata, {
              level: "warn", step: "groq_tpm_pacing_decision", message: "Fresh Groq headers prove insufficient TPM headroom after local accounting passed",
              payload: {
                provider: "groq", stage: options.agentName, reason: "GROQ_TPM_FRESH_HEADER_CAPACITY_EXHAUSTED",
                externalState: headerAdmission.externalState, requiredTokens: headerAdmission.requiredTokens,
                remainingTokens: headerAdmission.remainingTokens, observedAt: providerSnapshot?.observedAt ?? null,
                localWindowState: groqReservation.minuteTokenUsageBefore === 0 ? "LOCAL_WINDOW_KNOWN_ZERO" : "LOCAL_WINDOW_KNOWN_USAGE",
                localWindowTokens: groqReservation.minuteTokenUsageBefore, providerRequestDispatched: false,
              },
            });
            await releasePreDispatchReservation();
            throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "Fresh Groq TPM headers prove temporary capacity is insufficient");
          }
          await safeLog(options.logger, runId, metadata, {
            level: "info", step: "groq_tpm_pacing_decision", message: "Durable local Groq accounting passed and provider-header state does not prove insufficient capacity",
            payload: {
              provider: "groq", stage: options.agentName, reason: "GROQ_SHARED_ADMISSION_ALLOWED",
              externalState: headerAdmission.externalState, observedAt: providerSnapshot?.observedAt ?? null,
              localWindowState: groqReservation.minuteTokenUsageBefore === 0 ? "LOCAL_WINDOW_KNOWN_ZERO" : "LOCAL_WINDOW_KNOWN_USAGE",
              localWindowTokens: groqReservation.minuteTokenUsageBefore,
              estimatedStageTokenRequirement: groqStageEstimate, requiredTokens: headerAdmission.requiredTokens,
              providerRequestDispatched: false,
            },
          });
        }
        await safeLog(options.logger, runId, metadata, {
          level: "info",
          step: "provider_attempt",
          message: "Starting structured model attempt",
          payload: { attempt, dailyCount: reservation.dailyCount, dailyLimit: reservation.dailyLimit },
        });
        let response;
        try {
          response = await callWithTimeout(
            async (signal) => options.provider.generateStructured({
              systemInstructions: retrySystemInstructions,
              input: options.input,
              schema: options.schema,
              schemaName: options.schemaName,
            config: options.modelConfig,
            requestMetrics: options.requestMetrics,
              onRequestDispatched: async () => {
                const marked = geminiProvider ? true : await options.logger!.markRequestDispatched(runId, reservationId!, requestDate);
                if (!marked) throw new AgentError("cost_guard_violation", "Could not persist provider dispatch marker");
                if (!providerRequestDispatched) {
                  providerRequestDispatched = true;
                  providerRequestsUsed += 1;
                }
              },
              signal,
            }),
            options.modelConfig.timeoutMs
        );
        diagnostics = { ...options.diagnosticsContext, ...response.diagnostics, provider: response.provider ?? options.provider.providerId ?? "unknown", providerRequestDispatched };
        if (providerId === "groq" && providerRequestDispatched) {
          latestGroqPacingSnapshot = {
            observedAt: new Date().toISOString(),
            telemetry: diagnostics.providerRateLimit ?? normalizeGroqProviderRateLimit(diagnostics.rateLimitHeaders),
          };
        }
        } catch (error) {
          if (error instanceof FreeTierLimitReachedError) markLocalRateLimit();
          const providerErrorDiagnostics = getProviderDiagnostics(error);
          if (providerId === "groq" && providerRequestDispatched) {
            latestGroqPacingSnapshot = {
              observedAt: new Date().toISOString(),
              telemetry: providerErrorDiagnostics?.providerRateLimit ?? normalizeGroqProviderRateLimit(providerErrorDiagnostics?.rateLimitHeaders),
            };
          }
          diagnostics = { ...diagnostics, ...(providerErrorDiagnostics ?? {}), provider: options.provider.providerId ?? "unknown", providerRequestDispatched };
          if (!providerRequestDispatched) {
            try {
              if (geminiProvider) { /* the provider released its own local lease before throwing */ }
              else if (providerId === "groq") await options.logger!.releaseGroqCapacityPreDispatch!(runId, reservationId, requestDate);
              else await options.logger!.releaseRequest(runId, reservationId, requestDate);
              if (localReservation) releaseLocalRequest(requestDate);
            } catch (releaseError) {
              await safeLog(options.logger, runId, metadata, { level: "error", step: "reservation_release_failed", message: "Pre-dispatch reservation cleanup failed", payload: { attempt, requestDate, reservationId, error: errorSummary(releaseError).message } });
            }
          }
          throw error;
        }
        if (providerId === "groq") {
          const inputTokens = response.usage?.inputTokens;
          const outputTokens = response.usage?.outputTokens;
          const actualTokens = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : null;
          const trustworthyUsage = inputTokens !== undefined && outputTokens !== undefined
            && Number.isSafeInteger(inputTokens) && inputTokens >= 0
            && Number.isSafeInteger(outputTokens) && outputTokens >= 0
            && actualTokens !== null && Number.isSafeInteger(actualTokens) && actualTokens > 0
            && (response.usage?.totalTokens === undefined || response.usage.totalTokens === actualTokens);
          if (trustworthyUsage) {
            try {
              const settlement = await options.logger!.settleGroqTokenUsage!(runId, reservationId, requestDate, inputTokens, outputTokens);
              diagnostics = { ...diagnostics, providerUnit: "tokens", providerUnitUsageKnown: true, actualProviderUnitUsage: actualTokens };
              await safeLog(options.logger, runId, metadata, {
                level: "info", step: "groq_token_settlement", message: "Groq token reservation reconciled to provider usage",
                payload: { reservationId, requestDate, ...settlement },
              });
            } catch (error) {
              throw new AgentError("cost_guard_violation", "Could not settle dispatched Groq token usage; the reservation remains fail-closed", error);
            }
          } else {
            diagnostics = { ...diagnostics, providerUnit: "tokens", providerUnitUsageKnown: false };
            await safeLog(options.logger, runId, metadata, {
              level: "warn", step: "groq_token_usage_unknown", message: "Groq dispatched request has no trustworthy usage; estimated token reservation retained",
              payload: { reservationId, requestDate, estimatedTokens: (reservation as GroqCapacityReservation).reservedTokens },
            });
          }
        }
        let output: TGenerated;
        try {
          diagnostics = { ...diagnostics, ...options.generatedOutputDiagnostics?.(response.output) };
          output = parseStructuredOutput(options.schema, response.output, diagnostics);
        } catch (error) {
          if (error instanceof StructuredOutputError) throw error;
          throw error;
        }
        diagnostics = {
          ...diagnostics,
          providerRequestDispatched,
          validationResult: "valid",
          failureKind: "SUCCESS",
          structuredOutputMode: diagnostics?.structuredOutputMode ?? options.modelConfig.structuredOutputMode,
          ...(options.modelConfig.reasoningEffort === undefined && diagnostics?.reasoningEffort === undefined ? {} : { reasoningEffort: diagnostics?.reasoningEffort ?? options.modelConfig.reasoningEffort }),
          ...(options.modelConfig.includeReasoning === undefined && diagnostics?.includeReasoning === undefined ? {} : { includeReasoning: diagnostics?.includeReasoning ?? options.modelConfig.includeReasoning }),
        };
        return { response, output };
      },
      {
        // Structured-output modes only narrow which failures are retryable; they
        // must never override an explicit execution/agent retry budget.
        maxRetries: options.modelConfig.maxRetries,
        backoffMs: options.modelConfig.retryBackoffMs,
        shouldRetry: options.modelConfig.structuredOutputMode === "best_effort_schema" || options.modelConfig.structuredOutputMode === "json_object"
          ? (error) => isRetryableAgentError(error) && (bestEffortRetry(error) || error instanceof AgentTimeoutError || error instanceof AgentError && error.code === "provider_transient")
          : undefined,
        onRetry: async (attempt, error) => {
          const summary = errorSummary(error);
          if ((options.modelConfig.structuredOutputMode === "best_effort_schema" || options.modelConfig.structuredOutputMode === "json_object") && bestEffortRetry(error)) {
            const errorDiagnostics = getProviderDiagnostics(error);
            const missingFields = errorDiagnostics?.responseMissingTopLevelFields ?? [];
            const invalidFields = errorDiagnostics?.zodIssues?.map((issue) => {
              const expected = issue.expected ? `expected ${issue.expected}` : issue.options ? `expected one of ${issue.options.join(", ")}` : "expected a valid value";
              return `${issue.path.length === 0 ? "output" : issue.path.map((part, index) => typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`).join("")}: ${expected}`;
            }) ?? [];
            const feedback = [
              missingFields.length > 0 ? `Missing required fields: ${missingFields.join(", ")}` : "",
              invalidFields.length > 0 ? `Invalid fields: ${invalidFields.join("; ")}` : "",
              missingFields.length === 0 && invalidFields.length === 0 ? "The previous JSON response did not satisfy the required output contract." : "",
            ].filter(Boolean).join(" ");
            retrySystemInstructions = `${options.systemInstructions}\n\nStructural retry feedback (do not add explanation): ${feedback} Return every required field as one JSON object.`;
          }
      await safeLog(options.logger, runId, metadata, {
            level: "warn",
            step: "retry",
            message: "Retrying structured model attempt",
            payload: { attempt, errorCode: summary.code, errorMessage: summary.message },
          });
        },
      }
    );
    const finalized = options.finalizeOutput
      ? options.finalizeOutput(result.value.output, diagnostics)
      : { output: result.value.output as unknown as TOutput };
    diagnostics = finalized.diagnostics ?? diagnostics;
    const finishedAt = Date.now();
    const finishedAtIso = new Date(finishedAt).toISOString();
    const usage = result.value.response.usage;
    diagnostics = { ...diagnostics, usage };
    const telemetry = buildAgentTelemetry({
      status: "SUCCESS",
      model: result.value.response.model,
      agentVersion: metadata.agentVersion,
      config: options.modelConfig,
      diagnostics,
      attempts: result.attempts,
      providerRequestsUsed,
      latencyMs: finishedAt - startedAt,
      startedAt: startedAtIso,
      finishedAt: finishedAtIso,
    });
    await safeLog(options.logger, runId, metadata, {
      level: "info",
      step: "completed",
      message: "Structured model output validated",
      payload: {
        telemetry,
        attempts: result.attempts,
        usage,
        requestMetrics: diagnostics?.requestMetrics,
        generationSchemaValid: diagnostics?.generationSchemaValid,
        finalTranslationResultValid: diagnostics?.finalTranslationResultValid,
        translationAssemblySuccess: diagnostics?.translationAssemblySuccess,
        editorialAssemblySuccess: diagnostics?.editorialAssemblySuccess,
        finalEditorialDraftValid: diagnostics?.finalEditorialDraftValid,
        semanticGenerationValid: diagnostics?.semanticGenerationValid,
        deterministicSignalsCalculated: diagnostics?.deterministicSignalsCalculated,
        finalRankingValid: diagnostics?.finalRankingValid,
        importanceScore: diagnostics?.importanceScore,
        sourceCount: diagnostics?.sourceCount,
        verificationStatus: diagnostics?.verificationStatus,
        momentumAvailable: diagnostics?.momentumAvailable,
        formulaVersion: diagnostics?.formulaVersion,
        dimensionScores: diagnostics?.dimensionScores,
        deterministicPrechecksPassed: diagnostics?.deterministicPrechecksPassed,
        semanticFindingsCount: diagnostics?.semanticFindingsCount,
        findingsCount: diagnostics?.findingsCount,
        issueFindingsCount: diagnostics?.issueFindingsCount,
        unsupportedClaimFindingsCount: diagnostics?.unsupportedClaimFindingsCount,
        finalCriticResultValid: diagnostics?.finalCriticResultValid,
        finalDecision: diagnostics?.finalDecision,
        warningsCount: diagnostics?.warningsCount,
        errorsCount: diagnostics?.errorsCount,
        criticalCount: diagnostics?.criticalCount,
        routedStage: diagnostics?.routedStage,
        finalStatus: diagnostics?.finalStatus,
        routingVersion: diagnostics?.routingVersion,
        evidenceRefsValidated: diagnostics?.evidenceRefsValidated,
        evidenceCatalogSize: diagnostics?.evidenceCatalogSize,
        evidenceIndicesReceived: diagnostics?.evidenceIndicesReceived,
        evidenceIndicesValid: diagnostics?.evidenceIndicesValid,
        resolvedEvidenceRefsCount: diagnostics?.resolvedEvidenceRefsCount,
        inventedEvidenceIndicesCount: diagnostics?.inventedEvidenceIndicesCount,
        generationOutputBytes: diagnostics?.generationOutputBytes,
        factCountExpected: diagnostics?.factCountExpected,
        factCountTranslated: diagnostics?.factCountTranslated,
        factCountGenerated: diagnostics?.factCountGenerated,
        expectedFactIndices: diagnostics?.expectedFactIndices,
        receivedFactIndices: diagnostics?.receivedFactIndices,
        translatedSourceMaterialChars: diagnostics?.translatedSourceMaterialChars,
      },
      durationMs: finishedAt - startedAt,
    });
    try {
      const durableTelemetry = options.agentName === "critic"
        ? {
          ...telemetry,
          ...(typeof diagnostics?.finalCriticResultValid === "boolean" ? { finalCriticResultValid: diagnostics.finalCriticResultValid } : {}),
          ...(typeof diagnostics?.deterministicPrechecksPassed === "boolean" ? { deterministicPrechecksPassed: diagnostics.deterministicPrechecksPassed } : {}),
          ...(typeof diagnostics?.finalDecision === "string" ? { finalDecision: diagnostics.finalDecision } : {}),
        }
        : telemetry;
      await options.logger?.finishRun(runId, metadata, "succeeded", new Date(finishedAt).toISOString(), {
        telemetry: durableTelemetry,
        attempts: result.attempts,
        usage,
        generationSchemaValid: diagnostics?.generationSchemaValid,
        finalTranslationResultValid: diagnostics?.finalTranslationResultValid,
        translationAssemblySuccess: diagnostics?.translationAssemblySuccess,
        editorialAssemblySuccess: diagnostics?.editorialAssemblySuccess,
        finalEditorialDraftValid: diagnostics?.finalEditorialDraftValid,
        semanticGenerationValid: diagnostics?.semanticGenerationValid,
        deterministicSignalsCalculated: diagnostics?.deterministicSignalsCalculated,
        finalRankingValid: diagnostics?.finalRankingValid,
        importanceScore: diagnostics?.importanceScore,
        sourceCount: diagnostics?.sourceCount,
        verificationStatus: diagnostics?.verificationStatus,
        momentumAvailable: diagnostics?.momentumAvailable,
        formulaVersion: diagnostics?.formulaVersion,
        dimensionScores: diagnostics?.dimensionScores,
        deterministicPrechecksPassed: diagnostics?.deterministicPrechecksPassed,
        semanticFindingsCount: diagnostics?.semanticFindingsCount,
        findingsCount: diagnostics?.findingsCount,
        issueFindingsCount: diagnostics?.issueFindingsCount,
        unsupportedClaimFindingsCount: diagnostics?.unsupportedClaimFindingsCount,
        finalCriticResultValid: diagnostics?.finalCriticResultValid,
        finalDecision: diagnostics?.finalDecision,
        warningsCount: diagnostics?.warningsCount,
        errorsCount: diagnostics?.errorsCount,
        criticalCount: diagnostics?.criticalCount,
        routedStage: diagnostics?.routedStage,
        finalStatus: diagnostics?.finalStatus,
        routingVersion: diagnostics?.routingVersion,
        evidenceRefsValidated: diagnostics?.evidenceRefsValidated,
        evidenceCatalogSize: diagnostics?.evidenceCatalogSize,
        evidenceIndicesReceived: diagnostics?.evidenceIndicesReceived,
        evidenceIndicesValid: diagnostics?.evidenceIndicesValid,
        resolvedEvidenceRefsCount: diagnostics?.resolvedEvidenceRefsCount,
        inventedEvidenceIndicesCount: diagnostics?.inventedEvidenceIndicesCount,
        generationOutputBytes: diagnostics?.generationOutputBytes,
        factCountExpected: diagnostics?.factCountExpected,
        factCountTranslated: diagnostics?.factCountTranslated,
        factCountGenerated: diagnostics?.factCountGenerated,
        expectedFactIndices: diagnostics?.expectedFactIndices,
        receivedFactIndices: diagnostics?.receivedFactIndices,
        translatedSourceMaterialChars: diagnostics?.translatedSourceMaterialChars,
      });
    } catch {
      // The result itself remains valid if telemetry finalization is unavailable.
    }
    return {
      output: finalized.output,
      runId,
      agentName: options.agentName,
      agentVersion: options.agentVersion,
      model: result.value.response.model,
      providerRequestsUsed,
      attempts: result.attempts,
      latencyMs: finishedAt - startedAt,
      usage,
      diagnostics,
      telemetry,
    };
  } catch (error) {
    const finishedAt = Date.now();
    const finishedAtIso = new Date(finishedAt).toISOString();
    diagnostics = { ...diagnostics, ...getProviderDiagnostics(error) };
    diagnostics = { ...diagnostics, provider: diagnostics?.provider ?? options.provider.providerId ?? "unknown", providerRequestDispatched: diagnostics?.providerRequestDispatched ?? false, ...(error instanceof AgentTimeoutError ? { errorCategory: "TIMEOUT" as const } : {}) };
    const summary = errorSummary(error);
    const telemetry = buildAgentTelemetry({
      status: telemetryStatusFromError(error, diagnostics),
      model: metadata.model,
      agentVersion: metadata.agentVersion,
      config: options.modelConfig,
      diagnostics,
      attempts,
      providerRequestsUsed,
      latencyMs: finishedAt - startedAt,
      startedAt: startedAtIso,
      finishedAt: finishedAtIso,
    });
    setAgentFailureDetails(error, { attempts, providerRequestsUsed, latencyMs: finishedAt - startedAt, diagnostics, telemetry });
    await safeLog(options.logger, runId, metadata, {
      level: "error",
      step: "failed",
      message: "Structured model execution failed",
      payload: { telemetry, attempts, errorCode: summary.code, errorMessage: summary.message, diagnostics },
      durationMs: finishedAt - startedAt,
    });
    try {
      await options.logger?.finishRun(runId, metadata, "failed", finishedAtIso, {
        telemetry,
        attempts,
        factCountExpected: diagnostics?.factCountExpected,
        factCountGenerated: diagnostics?.factCountGenerated,
        expectedFactIndices: diagnostics?.expectedFactIndices,
        receivedFactIndices: diagnostics?.receivedFactIndices,
        translatedSourceMaterialChars: diagnostics?.translatedSourceMaterialChars,
        invalidPaths: diagnostics?.invalidPaths,
      }, summary.message);
    } catch {
      // Preserve the original agent error.
    }
    throw error;
  }
}
