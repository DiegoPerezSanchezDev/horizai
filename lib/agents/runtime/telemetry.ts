import { AgentError, AgentTimeoutError, FreeTierLimitReachedError, getProviderDiagnostics } from "./agent-errors.ts";
import { z } from "zod";
import type { AgentTelemetry, AgentTelemetryStatus, ModelConfig, ProviderDiagnostics } from "./runtime-types.ts";

const telemetryStatusSchema = z.enum([
  "SUCCESS",
  "PROVIDER_HTTP_ERROR",
  "LOCAL_JSON_PARSE_ERROR",
  "LOCAL_SCHEMA_VALIDATION_ERROR",
  "DETERMINISTIC_GROUNDING_REJECTION",
  "TIMEOUT",
  "FREE_TIER_LIMIT_REACHED",
  "PROVIDER_CAPACITY_EXHAUSTED",
  "RUNTIME_ERROR",
]);

export const agentTelemetrySchema = z.object({
  status: telemetryStatusSchema,
  provider: z.string().trim().min(1),
  providerUnit: z.enum(["requests", "tokens", "neurons"]).nullable().optional(),
  providerUnitUsageKnown: z.boolean().nullable().optional(),
  estimatedNeurons: z.number().int().nonnegative().nullable().optional(),
  actualProviderUnitUsage: z.number().int().nonnegative().nullable().optional(),
  providerRequestDispatched: z.boolean(),
  errorCategory: z.enum(["RATE_LIMIT", "AUTH_ERROR", "BAD_REQUEST", "SERVER_ERROR", "TIMEOUT", "NETWORK_ERROR", "INVALID_RESPONSE"]).nullable(),
  rateLimitHeaders: z.object({
    retryAfter: z.string().nullable(), limitRequests: z.string().nullable(), remainingRequests: z.string().nullable(),
    limitTokens: z.string().nullable(), remainingTokens: z.string().nullable(), resetRequests: z.string().nullable(), resetTokens: z.string().nullable(),
    retryAfterSeconds: z.number().nullable(), resetRequestsSeconds: z.number().nullable(), resetTokensSeconds: z.number().nullable(),
    limitRequestsDay: z.string().nullable().optional(), remainingRequestsDay: z.string().nullable().optional(), resetRequestsDay: z.string().nullable().optional(),
    limitTokensMinute: z.string().nullable().optional(), remainingTokensMinute: z.string().nullable().optional(), resetTokensMinute: z.string().nullable().optional(),
  }).nullable(),
  providerRateLimit: z.object({
    requestLimitDaily: z.number().int().nonnegative().nullable(),
    requestRemainingDaily: z.number().int().nonnegative().nullable(),
    requestReset: z.string().max(80).nullable(),
    requestResetSeconds: z.number().nonnegative().nullable(),
    tokenLimitMinute: z.number().int().nonnegative().nullable(),
    tokenRemainingMinute: z.number().int().nonnegative().nullable(),
    tokenReset: z.string().max(80).nullable(),
    tokenResetSeconds: z.number().nonnegative().nullable(),
    retryAfterSeconds: z.number().nonnegative().nullable(),
  }).strict().nullable().optional(),
  providerHttpStatus: z.number().int().positive().nullable(),
  model: z.string().trim().min(1),
  agentVersion: z.string().trim().min(1),
  structuredOutputMode: z.enum(["strict_schema", "best_effort_schema", "json_object"]).nullable(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullable(),
  includeReasoning: z.boolean().nullable(),
  finishReason: z.string().trim().min(1).nullable(),
  providerRequestsUsed: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  requestBytes: z.number().int().nonnegative().nullable(),
  responseBytes: z.number().int().nonnegative().nullable(),
  zodValid: z.boolean().nullable(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
}).strict();

export function telemetryStatusFromError(error: unknown, diagnostics?: ProviderDiagnostics): AgentTelemetryStatus {
  if (error instanceof AgentTimeoutError) return "TIMEOUT";
  if (error instanceof FreeTierLimitReachedError) return "FREE_TIER_LIMIT_REACHED";
  if (error instanceof AgentError && error.code === "PROVIDER_CAPACITY_EXHAUSTED") return "PROVIDER_CAPACITY_EXHAUSTED";
  if (diagnostics?.failureKind) return diagnostics.failureKind;
  const errorDiagnostics = getProviderDiagnostics(error);
  if (errorDiagnostics?.failureKind) return errorDiagnostics.failureKind;
  return "RUNTIME_ERROR";
}

function zodValidity(diagnostics: ProviderDiagnostics | undefined): boolean | null {
  if (diagnostics?.finalTranslationResultValid !== undefined) return diagnostics.finalTranslationResultValid;
  if (diagnostics?.validationResult === "valid") return true;
  if (diagnostics?.validationResult === "invalid") return false;
  return null;
}

export function buildAgentTelemetry(input: {
  status: AgentTelemetryStatus;
  model: string;
  agentVersion: string;
  config: ModelConfig;
  diagnostics?: ProviderDiagnostics;
  attempts: number;
  latencyMs: number;
  providerRequestsUsed?: number;
  startedAt: string;
  finishedAt: string;
}): AgentTelemetry {
  const usage = input.diagnostics?.usage;
  const metrics = input.diagnostics?.requestMetrics;
  return agentTelemetrySchema.parse({
    status: input.status,
    provider: input.diagnostics?.provider ?? "unknown",
    providerUnit: input.diagnostics?.providerUnit ?? null,
    providerUnitUsageKnown: input.diagnostics?.providerUnitUsageKnown ?? null,
    estimatedNeurons: input.diagnostics?.estimatedNeurons ?? null,
    actualProviderUnitUsage: input.diagnostics?.actualProviderUnitUsage ?? null,
    providerRequestDispatched: input.diagnostics?.providerRequestDispatched ?? (input.providerRequestsUsed ?? 0) > 0,
    errorCategory: input.diagnostics?.errorCategory ?? (input.status === "FREE_TIER_LIMIT_REACHED" ? "RATE_LIMIT" : input.status === "TIMEOUT" ? "TIMEOUT" : input.status === "LOCAL_JSON_PARSE_ERROR" || input.status === "LOCAL_SCHEMA_VALIDATION_ERROR" ? "INVALID_RESPONSE" : null),
    rateLimitHeaders: input.diagnostics?.rateLimitHeaders ?? null,
    providerRateLimit: input.diagnostics?.providerRateLimit ?? null,
    providerHttpStatus: input.diagnostics?.httpStatus ?? null,
    model: input.model,
    agentVersion: input.agentVersion,
    structuredOutputMode: input.diagnostics?.structuredOutputMode ?? input.config.structuredOutputMode,
    reasoningEffort: input.diagnostics?.reasoningEffort ?? input.config.reasoningEffort ?? null,
    includeReasoning: input.diagnostics?.includeReasoning ?? input.config.includeReasoning ?? null,
    finishReason: input.diagnostics?.finishReason ?? null,
    providerRequestsUsed: input.providerRequestsUsed ?? (input.attempts > 0 ? 1 : 0),
    attempts: input.attempts,
    retries: Math.max(0, input.attempts - 1),
    latencyMs: input.latencyMs,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    requestBytes: metrics?.bodyBytes ?? null,
    responseBytes: input.diagnostics?.responseBodyBytes ?? null,
    zodValid: zodValidity(input.diagnostics),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });
}
