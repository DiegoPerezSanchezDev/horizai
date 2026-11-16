import { assertFreeProviderRequest, CLOUDFLARE_LLAMA_VALIDATION_MODEL, CLOUDFLARE_WORKERS_AI_MODEL, freeProviderPolicy, isCloudflareModelFreeApproved, type FreeProviderId, type ProviderId } from "./provider-cost-policy.ts";
import { cloudflareAllRequiredStagesValidated, selectProviderForNewFullEvent, type CloudflareProductionApprovalGates } from "./cloudflare-stage-validation.ts";
import { normalEventStages, type NormalEventStage } from "./event-model-stages.ts";
import type { AgentTelemetry, RateLimitHeaders } from "./runtime-types.ts";
import type { GroqCapacityLimits } from "./runtime-types.ts";
import { MAX_GROQ_DAILY_REQUEST_HARD_LIMIT, resolveGroqDailyRequestHardCap } from "./request-budget.ts";
import { provisionalGroqEventTokens, readGroqDailyTokenHardLimit, readGroqEventTokenMarginPercent, readGroqRequestsPerMinuteHardLimit, readGroqTokensPerMinuteHardLimit } from "./groq-capacity-policy.ts";

export const DAILY_SOFT_LIMIT_RATIO = 0.85;
export const FREE_ROUTABLE_PROVIDERS = ["groq", "cloudflare_workers_ai"] as const satisfies readonly FreeProviderId[];
export type ProviderUsageUnit = "tokens" | "neurons";
export { normalEventStages } from "./event-model-stages.ts";
export type { NormalEventStage } from "./event-model-stages.ts";

export function freeProviderRouterEnabled(value = process.env.FREE_PROVIDER_ROUTER_ENABLED): boolean {
  if (value === undefined || value.trim() === "" || value.trim().toLowerCase() === "false") return false;
  if (value.trim().toLowerCase() === "true") return true;
  throw new Error("FREE_PROVIDER_ROUTER_ENABLED must be true or false");
}

export type ProviderCapacityConfig = {
  provider: FreeProviderId;
  model: string;
  endpoint: string;
  configured: boolean;
  dailyRequestLimit?: number;
  dailyTokenLimit: number | null;
  usageUnit?: ProviderUsageUnit;
  dailyNeuronAllocation?: number;
  inputNeuronsPerMillionTokens?: number;
  outputNeuronsPerMillionTokens?: number;
  neuronSafetyMarginBps?: number;
  minuteRequestLimit?: number;
  minuteTokenLimit?: number;
  softLimitRatio: number;
  requestCapSource?: "GROQ_DAILY_REQUEST_HARD_CAP" | "LEGACY_GROQ_FALLBACK" | "SAFE_DEFAULT" | "PROVIDER_ACCOUNT_LIMIT";
};

function positiveConfiguredInteger(value: string | undefined): number {
  const number = Number(value);
  return value?.trim() && Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/** No provider limit is inferred from public documentation. Missing account limits disable routing for that provider. */
export function readProviderCapacityConfig(provider: FreeProviderId, env: NodeJS.ProcessEnv = process.env): ProviderCapacityConfig {
  const prefix = provider === "groq" ? "GROQ" : "CLOUDFLARE";
  const configuredDailyRequestLimit = provider === "groq" ? positiveConfiguredInteger(env.GROQ_FREE_DAILY_REQUEST_LIMIT) : positiveConfiguredInteger(env[`${prefix}_FREE_DAILY_REQUEST_LIMIT`]);
  const configuredDailyTokenLimit = provider === "groq" ? readGroqDailyTokenHardLimit(env) ?? 0 : positiveConfiguredInteger(env[`${prefix}_FREE_DAILY_TOKEN_LIMIT`]);
  const minuteRequestLimit = (provider === "groq" ? readGroqRequestsPerMinuteHardLimit(env) ?? 0 : positiveConfiguredInteger(env[`${prefix}_FREE_MINUTE_REQUEST_LIMIT`])) || undefined;
  const minuteTokenLimit = (provider === "groq" ? readGroqTokensPerMinuteHardLimit(env) ?? 0 : positiveConfiguredInteger(env[`${prefix}_FREE_MINUTE_TOKEN_LIMIT`])) || undefined;
  const model = provider === "groq" ? env.AGENT_MODEL_VERIFY?.trim() ?? "" : env.CLOUDFLARE_MODEL?.trim() ?? "@cf/openai/gpt-oss-20b";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const endpoint = provider === "groq" ? `${(env.AGENT_API_URL ?? "").trim().replace(/\/$/, "")}/chat/completions` : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  const keyConfigured = !!(provider === "groq" ? env.AGENT_API_KEY?.trim() : env.CLOUDFLARE_AI_API_TOKEN?.trim());
  const softLimitRatio = readProviderSoftLimitRatio(env);
  if (provider === "groq") {
    const resolvedCap = resolveGroqDailyRequestHardCap(env);
    const canonicalRequestLimitConfigured = !!env.GROQ_DAILY_REQUEST_HARD_CAP?.trim();
    const dailyRequestLimit = !canonicalRequestLimitConfigured && configuredDailyRequestLimit > 0
      ? Math.min(resolvedCap.limit, configuredDailyRequestLimit)
      : resolvedCap.limit;
    const requestCapSource = !canonicalRequestLimitConfigured && configuredDailyRequestLimit > 0 && configuredDailyRequestLimit < resolvedCap.limit
      ? "PROVIDER_ACCOUNT_LIMIT"
      : resolvedCap.source;
    const completeLimitsConfigured = configuredDailyTokenLimit > 0 && minuteRequestLimit !== undefined && minuteTokenLimit !== undefined;
    return { provider, model, endpoint, configured: keyConfigured && !!model && completeLimitsConfigured, dailyRequestLimit, dailyTokenLimit: configuredDailyTokenLimit || null, usageUnit: "tokens", ...(minuteRequestLimit ? { minuteRequestLimit } : {}), ...(minuteTokenLimit ? { minuteTokenLimit } : {}), softLimitRatio, requestCapSource };
  }
  const dailyNeuronAllocation = positiveConfiguredInteger(env.CLOUDFLARE_DAILY_NEURON_LIMIT ?? env.CLOUDFLARE_FREE_DAILY_NEURON_ALLOCATION);
  const rates = isCloudflareModelFreeApproved(model)
    ? readCloudflareNeuronRates(env, model)
    : CLOUDFLARE_GPT_OSS_20B_NEURON_RATES;
  const inputNeuronsPerMillionTokens = rates.inputNeuronsPerMillionTokens;
  const outputNeuronsPerMillionTokens = rates.outputNeuronsPerMillionTokens;
  const neuronSafetyMarginBps = rates.safetyMarginBps;
  return { provider, model, endpoint, configured: keyConfigured && !!accountId && isCloudflareModelFreeApproved(model) && dailyNeuronAllocation > 0, ...(configuredDailyRequestLimit > 0 ? { dailyRequestLimit: configuredDailyRequestLimit } : {}), dailyTokenLimit: null, usageUnit: "neurons", dailyNeuronAllocation, inputNeuronsPerMillionTokens, outputNeuronsPerMillionTokens, neuronSafetyMarginBps, ...(minuteRequestLimit ? { minuteRequestLimit } : {}), softLimitRatio };
}

/** Builds the atomic Groq daily ledger limits and preserves the separate TPM value used by pacing. */
export function readGroqAtomicCapacityLimits(env: NodeJS.ProcessEnv = process.env): GroqCapacityLimits | null {
  const capacity = readProviderCapacityConfig("groq", env);
  if (capacity.dailyTokenLimit === null || capacity.minuteTokenLimit === undefined || capacity.minuteRequestLimit === undefined) return null;
  const requestHardLimit = capacity.dailyRequestLimit ?? MAX_GROQ_DAILY_REQUEST_HARD_LIMIT;
  const tokenHardLimit = capacity.dailyTokenLimit;
  return {
    requestHardLimit,
    requestSoftLimit: Math.floor(requestHardLimit * capacity.softLimitRatio),
    tokenHardLimit,
    tokenSoftLimit: Math.floor(tokenHardLimit * capacity.softLimitRatio),
    tokenMinuteHardLimit: capacity.minuteTokenLimit,
    requestMinuteHardLimit: capacity.minuteRequestLimit,
  };
}

export function readProviderSoftLimitRatio(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.FREE_PROVIDER_SOFT_LIMIT_RATIO?.trim();
  if (!raw) return DAILY_SOFT_LIMIT_RATIO;
  const ratio = Number(raw);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error("FREE_PROVIDER_SOFT_LIMIT_RATIO must be between 0 and 1");
  return ratio;
}

/** Model rates are centralized and configurable via env; values follow Cloudflare's current published catalog. */
export const CLOUDFLARE_GPT_OSS_20B_NEURON_RATES = {
  inputNeuronsPerMillionTokens: 18_182,
  outputNeuronsPerMillionTokens: 27_273,
  safetyMarginBps: 12_500,
} as const;

export const CLOUDFLARE_LLAMA_3_3_70B_NEURON_RATES = {
  inputNeuronsPerMillionTokens: 26_668,
  outputNeuronsPerMillionTokens: 204_805,
  safetyMarginBps: 12_500,
} as const;

export function readCloudflareNeuronRates(env: Partial<NodeJS.ProcessEnv> = process.env, model: string = CLOUDFLARE_WORKERS_AI_MODEL) {
  const defaults = model === CLOUDFLARE_WORKERS_AI_MODEL
    ? CLOUDFLARE_GPT_OSS_20B_NEURON_RATES
    : model === CLOUDFLARE_LLAMA_VALIDATION_MODEL
      ? CLOUDFLARE_LLAMA_3_3_70B_NEURON_RATES
      : null;
  if (!defaults) throw new Error("Cloudflare Neuron rates are not configured for this model");
  const inputOverride = model === CLOUDFLARE_LLAMA_VALIDATION_MODEL
    ? env.CLOUDFLARE_LLAMA_3_3_70B_INPUT_NEURONS_PER_MILLION_TOKENS
    : env.CLOUDFLARE_INPUT_NEURONS_PER_MILLION_TOKENS;
  const outputOverride = model === CLOUDFLARE_LLAMA_VALIDATION_MODEL
    ? env.CLOUDFLARE_LLAMA_3_3_70B_OUTPUT_NEURONS_PER_MILLION_TOKENS
    : env.CLOUDFLARE_OUTPUT_NEURONS_PER_MILLION_TOKENS;
  return {
    inputNeuronsPerMillionTokens: positiveConfiguredInteger(inputOverride) || defaults.inputNeuronsPerMillionTokens,
    outputNeuronsPerMillionTokens: positiveConfiguredInteger(outputOverride) || defaults.outputNeuronsPerMillionTokens,
    safetyMarginBps: positiveConfiguredInteger(env.CLOUDFLARE_NEURON_SAFETY_MARGIN_BPS) || defaults.safetyMarginBps,
  };
}

export type ProviderDailyUsage = {
  provider: ProviderId;
  dateUtc: string;
  requestsReserved: number;
  requestsDispatched: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenUsageKnown: boolean;
  unknownTokenRequests: number;
  neuronsUsed?: number;
  neuronUsageKnown?: boolean;
};

export type ProviderRateLimitState = {
  provider: ProviderId;
  observedAt: string;
  blockedUntil: string | null;
  requestsRemaining: number | null;
  tokensRemaining: number | null;
  requestResetAt: string | null;
  tokenResetAt: string | null;
};

export type EventTokenEstimateInput = {
  stages: readonly { stage: NormalEventStage; maxOutputTokens: number; conservativeInputTokens: number; historicalInputTokens?: number; knownInputChars?: number }[];
  charsPerTokenLowerBound: number;
  safetyMarginRatio: number;
};

export function estimateEventTokenRequirement(input: EventTokenEstimateInput): number {
  if (input.stages.length !== normalEventStages.length || new Set(input.stages.map((stage) => stage.stage)).size !== normalEventStages.length || input.stages.some((stage) => !normalEventStages.includes(stage.stage))) throw new Error("Complete six-stage token estimate required");
  if (!(input.charsPerTokenLowerBound > 0) || !(input.safetyMarginRatio >= 1)) throw new Error("Invalid token estimator safety configuration");
  const sum = input.stages.reduce((total, stage) => {
    if (!Number.isInteger(stage.maxOutputTokens) || stage.maxOutputTokens < 1 || !Number.isInteger(stage.conservativeInputTokens) || stage.conservativeInputTokens < 1) throw new Error("Invalid per-stage token estimate");
    const knownCharsEstimate = stage.knownInputChars === undefined ? 0 : Math.ceil(stage.knownInputChars / input.charsPerTokenLowerBound);
    const historical = stage.historicalInputTokens ?? 0;
    return total + Math.max(stage.conservativeInputTokens, historical, knownCharsEstimate) + stage.maxOutputTokens;
  }, 0);
  return Math.ceil(sum * input.safetyMarginRatio);
}

export function estimateCloudflareNeurons(input: { inputTokens: number; outputTokens: number; inputNeuronsPerMillionTokens: number; outputNeuronsPerMillionTokens: number; safetyMarginBps: number }): number {
  const values = [input.inputTokens, input.outputTokens, input.inputNeuronsPerMillionTokens, input.outputNeuronsPerMillionTokens, input.safetyMarginBps];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || input.inputNeuronsPerMillionTokens < 1 || input.outputNeuronsPerMillionTokens < 1 || input.safetyMarginBps < 10_000) throw new Error("Invalid neuron estimate configuration");
  const inputNeurons = Math.ceil(input.inputTokens * input.inputNeuronsPerMillionTokens / 1_000_000);
  const outputNeurons = Math.ceil(input.outputTokens * input.outputNeuronsPerMillionTokens / 1_000_000);
  return Math.ceil((inputNeurons + outputNeurons) * input.safetyMarginBps / 10_000);
}

function nonnegativeNumber(value: string | null | undefined): number | null {
  if (!value?.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function expiry(observedAt: string, seconds: number | null): string | null {
  return seconds === null ? null : new Date(Date.parse(observedAt) + seconds * 1000).toISOString();
}

function utcTomorrow(observedAt: string): string {
  const day = new Date(observedAt);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString();
}

/** Provider headers retain their own window semantics; no TPM value is treated as TPD. */
export function normalizeRateLimitState(provider: ProviderId, observedAt: string, headers: RateLimitHeaders | null, is429: boolean): ProviderRateLimitState | null {
  if (!is429 && !headers) return null;
  const requestResetAt = expiry(observedAt, provider === "cerebras" ? nonnegativeNumber(headers?.resetRequestsDay) : headers?.resetRequestsSeconds ?? null);
  const tokenResetAt = expiry(observedAt, provider === "cerebras" ? nonnegativeNumber(headers?.resetTokensMinute) : headers?.resetTokensSeconds ?? null);
  const retryAt = expiry(observedAt, headers?.retryAfterSeconds ?? null);
  const blockedUntil = is429
    ? [requestResetAt, tokenResetAt, retryAt].filter((value): value is string => value !== null).sort().at(-1) ?? utcTomorrow(observedAt)
    : null;
  return {
    provider, observedAt, blockedUntil, requestResetAt, tokenResetAt,
    requestsRemaining: nonnegativeNumber(provider === "cerebras" ? headers?.remainingRequestsDay : headers?.remainingRequests ?? headers?.remainingRequestsDay),
    tokensRemaining: nonnegativeNumber(provider === "cerebras" ? headers?.remainingTokensMinute : headers?.remainingTokens ?? headers?.remainingTokensMinute),
  };
}

export function rateLimitStateFromTelemetry(telemetry: AgentTelemetry): ProviderRateLimitState | null {
  if (telemetry.provider !== "groq" && telemetry.provider !== "cerebras" && telemetry.provider !== "cloudflare_workers_ai") return null;
  return normalizeRateLimitState(telemetry.provider, telemetry.finishedAt, telemetry.rateLimitHeaders, telemetry.providerHttpStatus === 429 || telemetry.errorCategory === "RATE_LIMIT");
}

export type CapacityDimensionSnapshot = {
  dimension: "requests" | "tokens" | "neurons";
  currentUsage: number | null;
  hardLimit: number | null;
  softLimit: number | null;
  projectedUsage: number | null;
  eligible: boolean | null;
  reason: string;
};

export type ProviderCapacity = {
  provider: FreeProviderId;
  /** Capacity-only admission for the supplied new-event projection. */
  eligible: boolean;
  /** Set by the router after independent activation gates are evaluated. */
  productionEligible: boolean;
  reason: string;
  requestUsageRatio: number | null;
  tokenUsageRatio: number | null;
  temporaryBlock: boolean;
  requestsRemainingHard: number | null;
  tokensRemainingHard: number | null;
  tokenUsageKnown: boolean;
  neuronUsageRatio: number | null;
  neuronsRemainingHard: number | null;
  neuronUsageKnown: boolean;
  dimensions: {
    requests: CapacityDimensionSnapshot | null;
    tokens: CapacityDimensionSnapshot | null;
    neurons: CapacityDimensionSnapshot | null;
  };
};

export function evaluateProviderCapacity(config: ProviderCapacityConfig, usage: ProviderDailyUsage, block: ProviderRateLimitState | null, now: Date, estimatedRequests: number, estimatedTokens: number | null, estimatedPeakRequestTokens: number | null = estimatedTokens, estimatedNeurons = 0): ProviderCapacity {
  const neuronUsageKnown = usage.neuronUsageKnown ?? false;
  const emptyDimensions: ProviderCapacity["dimensions"] = { requests: null, tokens: null, neurons: null };
  const base = { provider: config.provider, eligible: false, productionEligible: false, requestUsageRatio: null, tokenUsageRatio: null, neuronUsageRatio: null, temporaryBlock: false, requestsRemainingHard: config.dailyRequestLimit === undefined ? null : Math.max(0, config.dailyRequestLimit - usage.requestsReserved), tokensRemainingHard: config.dailyTokenLimit !== null && config.dailyTokenLimit !== undefined && usage.tokenUsageKnown ? Math.max(0, config.dailyTokenLimit - usage.totalTokens) : null, neuronsRemainingHard: config.dailyNeuronAllocation !== undefined && neuronUsageKnown ? Math.max(0, config.dailyNeuronAllocation - (usage.neuronsUsed ?? 0)) : null, tokenUsageKnown: usage.tokenUsageKnown && config.dailyTokenLimit !== null && config.dailyTokenLimit !== undefined, neuronUsageKnown, dimensions: emptyDimensions };
  if (!config.configured) return { ...base, reason: "UNAVAILABLE_CONFIGURATION" };
  try { assertFreeProviderRequest(config.provider, config.model, config.endpoint); } catch { return { ...base, reason: "PAID_PROVIDER_FORBIDDEN" }; }
  if ((config.dailyRequestLimit !== undefined && (!Number.isSafeInteger(config.dailyRequestLimit) || config.dailyRequestLimit < 1 || (config.usageUnit !== "neurons" && config.dailyRequestLimit > 1000))) || !(config.softLimitRatio > 0 && config.softLimitRatio < 1)) return { ...base, reason: "INVALID_CAPACITY_CONFIG" };
  if (!Number.isSafeInteger(estimatedRequests) || estimatedRequests < 1 || (estimatedTokens !== null && (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0)) || (estimatedPeakRequestTokens !== null && (!Number.isSafeInteger(estimatedPeakRequestTokens) || estimatedPeakRequestTokens < 0))) return { ...base, reason: "INVALID_EVENT_ESTIMATE" };
  if (config.usageUnit === "neurons" && (!Number.isSafeInteger(config.dailyNeuronAllocation) || (config.dailyNeuronAllocation ?? 0) < 1 || (estimatedNeurons !== 0 && (!Number.isSafeInteger(estimatedNeurons) || estimatedNeurons < 1)))) return { ...base, reason: "INVALID_CAPACITY_CONFIG" };
  if ((config.usageUnit ?? "tokens") === "tokens" && config.dailyTokenLimit !== null && config.dailyTokenLimit !== undefined && (!Number.isSafeInteger(config.dailyTokenLimit) || config.dailyTokenLimit < 1)) return { ...base, reason: "INVALID_CAPACITY_CONFIG" };
  if (usage.provider !== config.provider || usage.dateUtc !== now.toISOString().slice(0, 10)) return { ...base, reason: "STALE_USAGE" };
  const requestUsageRatio = config.dailyRequestLimit === undefined ? null : usage.requestsReserved / config.dailyRequestLimit;
  const tokenUsageRatio = (config.usageUnit ?? "tokens") === "tokens" && config.dailyTokenLimit != null && usage.tokenUsageKnown ? usage.totalTokens / config.dailyTokenLimit : null;
  const neuronUsageRatio = config.usageUnit === "neurons" && neuronUsageKnown ? (usage.neuronsUsed ?? 0) / (config.dailyNeuronAllocation ?? 1) : null;
  const temporaryBlock = block?.provider === config.provider && !!block.blockedUntil && Date.parse(block.blockedUntil) > now.getTime();
  const requestDimension: CapacityDimensionSnapshot | null = config.dailyRequestLimit === undefined ? null : {
    dimension: "requests", currentUsage: usage.requestsReserved, hardLimit: config.dailyRequestLimit,
    softLimit: Math.floor(config.dailyRequestLimit * config.softLimitRatio), projectedUsage: usage.requestsReserved + estimatedRequests,
    eligible: usage.requestsReserved + estimatedRequests <= config.dailyRequestLimit && usage.requestsReserved + estimatedRequests < Math.floor(config.dailyRequestLimit * config.softLimitRatio),
    reason: usage.requestsReserved + estimatedRequests > config.dailyRequestLimit ? config.provider === "groq" ? "GROQ_DAILY_REQUEST_HARD_LIMIT" : "HARD_CAPACITY_EXHAUSTED" : usage.requestsReserved + estimatedRequests >= Math.floor(config.dailyRequestLimit * config.softLimitRatio) ? config.provider === "groq" ? "GROQ_DAILY_REQUEST_SOFT_LIMIT" : "DAILY_REQUEST_SOFT_LIMIT" : "FREE_CAPACITY_AVAILABLE",
  };
  const tokenDimension: CapacityDimensionSnapshot | null = (config.usageUnit ?? "tokens") !== "tokens" ? null : config.dailyTokenLimit == null
    ? { dimension: "tokens", currentUsage: usage.tokenUsageKnown ? usage.totalTokens : null, hardLimit: null, softLimit: null, projectedUsage: null, eligible: null, reason: config.provider === "groq" ? "GROQ_DAILY_TOKEN_LIMIT_NOT_CONFIGURED" : "TOKEN_LIMIT_NOT_CONFIGURED" }
    : { dimension: "tokens", currentUsage: usage.tokenUsageKnown ? usage.totalTokens : null, hardLimit: config.dailyTokenLimit, softLimit: Math.floor(config.dailyTokenLimit * config.softLimitRatio), projectedUsage: usage.tokenUsageKnown && estimatedTokens !== null ? usage.totalTokens + estimatedTokens : null, eligible: usage.tokenUsageKnown && estimatedTokens !== null ? usage.totalTokens + estimatedTokens < Math.floor(config.dailyTokenLimit * config.softLimitRatio) && usage.totalTokens + estimatedTokens <= config.dailyTokenLimit : false, reason: !usage.tokenUsageKnown ? config.provider === "groq" ? "GROQ_DAILY_TOKEN_USAGE_UNKNOWN" : "UNKNOWN_TOKEN_USAGE" : estimatedTokens === null ? "EVENT_TOKEN_ESTIMATE_REQUIRED" : usage.totalTokens + estimatedTokens > config.dailyTokenLimit ? config.provider === "groq" ? "GROQ_DAILY_TOKEN_HARD_LIMIT" : "HARD_CAPACITY_EXHAUSTED" : usage.totalTokens + estimatedTokens >= Math.floor(config.dailyTokenLimit * config.softLimitRatio) ? config.provider === "groq" ? "GROQ_DAILY_TOKEN_SOFT_LIMIT" : "DAILY_TOKEN_SOFT_LIMIT" : "FREE_CAPACITY_AVAILABLE" };
  const neuronDimension: CapacityDimensionSnapshot | null = config.usageUnit !== "neurons" ? null : {
    dimension: "neurons", currentUsage: neuronUsageKnown ? usage.neuronsUsed ?? 0 : null, hardLimit: config.dailyNeuronAllocation ?? null,
    softLimit: config.dailyNeuronAllocation ? Math.floor(config.dailyNeuronAllocation * config.softLimitRatio) : null,
    projectedUsage: neuronUsageKnown && estimatedNeurons > 0 ? (usage.neuronsUsed ?? 0) + estimatedNeurons : null,
    eligible: !neuronUsageKnown ? false : estimatedNeurons < 1 ? null : (usage.neuronsUsed ?? 0) + estimatedNeurons <= (config.dailyNeuronAllocation ?? 0) && (usage.neuronsUsed ?? 0) + estimatedNeurons < Math.floor((config.dailyNeuronAllocation ?? 0) * config.softLimitRatio),
    reason: !neuronUsageKnown ? "UNKNOWN_NEURON_USAGE" : estimatedNeurons < 1 ? "EVENT_ESTIMATE_REQUIRED" : (usage.neuronsUsed ?? 0) + estimatedNeurons > (config.dailyNeuronAllocation ?? 0) ? "HARD_CAPACITY_EXHAUSTED" : (usage.neuronsUsed ?? 0) + estimatedNeurons >= Math.floor((config.dailyNeuronAllocation ?? 0) * config.softLimitRatio) ? "DAILY_NEURON_SOFT_LIMIT" : "FREE_CAPACITY_AVAILABLE",
  };
  const dimensions = { requests: requestDimension, tokens: tokenDimension, neurons: neuronDimension };
  const snapshot = { ...base, dimensions, requestUsageRatio, tokenUsageRatio, neuronUsageRatio, temporaryBlock };
  if (snapshot.temporaryBlock) return { ...snapshot, reason: config.provider === "groq" ? "GROQ_TEMPORARILY_BLOCKED" : "PROVIDER_TEMPORARILY_BLOCKED" };
  if (requestDimension?.eligible === false) return { ...snapshot, reason: requestDimension.reason };
  if (tokenDimension?.eligible === false) return { ...snapshot, reason: tokenDimension.reason };
  if (neuronDimension?.eligible === false) return { ...snapshot, reason: neuronDimension.reason };
  if (config.usageUnit === "neurons" && neuronDimension?.eligible === null) return { ...snapshot, reason: "EVENT_ESTIMATE_REQUIRED" };
  if (block?.requestsRemaining !== null && block?.requestsRemaining !== undefined && block.requestsRemaining < estimatedRequests && block.requestResetAt && Date.parse(block.requestResetAt) > now.getTime()) return { ...snapshot, reason: "PROVIDER_REQUEST_WINDOW" };
  if (block?.tokensRemaining !== null && block?.tokensRemaining !== undefined && estimatedPeakRequestTokens !== null && block.tokensRemaining < estimatedPeakRequestTokens && block.tokenResetAt && Date.parse(block.tokenResetAt) > now.getTime()) return { ...snapshot, reason: "PROVIDER_TOKEN_WINDOW" };
  return { ...snapshot, eligible: true, reason: "FREE_CAPACITY_AVAILABLE" };
}

export type ProviderRouteDecision = {
  selectedProvider: FreeProviderId | null;
  selectedModel: string | null;
  reason: string;
  groqCapacity: ProviderCapacity;
  cloudflareWorkersAiCapacity: ProviderCapacity;
  capacitySnapshot: FreeProviderCapacitySnapshot;
  estimatedEventRequests: number;
  estimatedEventTokens: number;
  estimatedGroqEventPlanningTokens: number;
  estimatedEventNeurons: number;
  providerSticky: true;
  freeOnly: true;
};

export type FreeProviderCapacitySnapshot = {
  evaluatedAt: string;
  groq: ProviderCapacity;
  cloudflare_workers_ai: ProviderCapacity;
};

export function getFreeProviderCapacitySnapshot(input: {
  configs: Record<FreeProviderId, ProviderCapacityConfig>;
  usage: Record<FreeProviderId, ProviderDailyUsage>;
  blocks: Record<FreeProviderId, ProviderRateLimitState | null>;
  now: Date;
  estimatedEventRequests?: number;
  estimatedEventTokens?: number;
  /** Groq full-event N=1 projection; never reused for per-stage reservations or Cloudflare Neurons. */
  estimatedGroqEventTokens?: number;
  estimatedEventInputTokens?: number;
  estimatedEventOutputTokens?: number;
  estimatedPeakRequestTokens?: number;
  estimatedEventNeurons?: number;
}): FreeProviderCapacitySnapshot {
  const requests = input.estimatedEventRequests ?? normalEventStages.length;
  const tokens = input.estimatedEventTokens ?? null;
  const groqTokens = input.estimatedGroqEventTokens ?? tokens;
  const peak = input.estimatedPeakRequestTokens ?? tokens;
  const cfConfig = input.configs.cloudflare_workers_ai;
  const defaultCfRates = isCloudflareModelFreeApproved(cfConfig.model)
    ? readCloudflareNeuronRates(process.env, cfConfig.model)
    : CLOUDFLARE_GPT_OSS_20B_NEURON_RATES;
  const estimatedEventNeurons = input.estimatedEventNeurons ?? 0;
  const rates = {
    inputNeuronsPerMillionTokens: cfConfig.inputNeuronsPerMillionTokens ?? defaultCfRates.inputNeuronsPerMillionTokens,
    outputNeuronsPerMillionTokens: cfConfig.outputNeuronsPerMillionTokens ?? defaultCfRates.outputNeuronsPerMillionTokens,
    safetyMarginBps: cfConfig.neuronSafetyMarginBps ?? defaultCfRates.safetyMarginBps,
  };
  const neurons = input.estimatedEventNeurons === undefined && input.estimatedEventTokens !== undefined
    ? estimateCloudflareNeurons({ inputTokens: input.estimatedEventInputTokens ?? input.estimatedEventTokens, outputTokens: input.estimatedEventOutputTokens ?? 0, ...rates })
    : estimatedEventNeurons;
  return {
    evaluatedAt: input.now.toISOString(),
    groq: evaluateProviderCapacity(input.configs.groq, input.usage.groq, input.blocks.groq, input.now, requests, groqTokens, peak),
    cloudflare_workers_ai: evaluateProviderCapacity(cfConfig, input.usage.cloudflare_workers_ai, input.blocks.cloudflare_workers_ai, input.now, requests, tokens, peak, neurons),
  };
}

export function routeFreeProviderEvent(input: { enabled: boolean; cloudflareAllRequiredStagesValidated?: boolean; cloudflareActivationGates?: CloudflareProductionApprovalGates; configs: Record<FreeProviderId, ProviderCapacityConfig>; usage: Record<FreeProviderId, ProviderDailyUsage>; blocks: Record<FreeProviderId, ProviderRateLimitState | null>; now: Date; estimatedEventRequests?: number; estimatedEventTokens: number; estimatedGroqEventTokens?: number; estimatedPeakRequestTokens?: number; estimatedEventInputTokens?: number; estimatedEventOutputTokens?: number; estimatedEventNeurons?: number }): ProviderRouteDecision {
  const requests = input.estimatedEventRequests ?? normalEventStages.length;
  if (!Number.isInteger(requests) || requests < 1 || requests > normalEventStages.length || !Number.isInteger(input.estimatedEventTokens) || input.estimatedEventTokens < 1) throw new Error("Invalid event capacity estimate");
  const defaultCfRates = isCloudflareModelFreeApproved(input.configs.cloudflare_workers_ai.model)
    ? readCloudflareNeuronRates(process.env, input.configs.cloudflare_workers_ai.model)
    : CLOUDFLARE_GPT_OSS_20B_NEURON_RATES;
  const estimatedEventNeurons = input.estimatedEventNeurons ?? estimateCloudflareNeurons({
    inputTokens: input.estimatedEventInputTokens ?? input.estimatedEventTokens,
    outputTokens: input.estimatedEventOutputTokens ?? 0,
    inputNeuronsPerMillionTokens: input.configs.cloudflare_workers_ai.inputNeuronsPerMillionTokens ?? defaultCfRates.inputNeuronsPerMillionTokens,
    outputNeuronsPerMillionTokens: input.configs.cloudflare_workers_ai.outputNeuronsPerMillionTokens ?? defaultCfRates.outputNeuronsPerMillionTokens,
    safetyMarginBps: input.configs.cloudflare_workers_ai.neuronSafetyMarginBps ?? defaultCfRates.safetyMarginBps,
  });
  const estimatedGroqEventTokens = input.estimatedGroqEventTokens ?? provisionalGroqEventTokens({ marginPercent: readGroqEventTokenMarginPercent() });
  const capacitySnapshot = getFreeProviderCapacitySnapshot({ ...input, estimatedEventRequests: requests, estimatedEventTokens: input.estimatedEventTokens, estimatedGroqEventTokens, estimatedPeakRequestTokens: input.estimatedPeakRequestTokens, estimatedEventNeurons });
  const groqCapacity = capacitySnapshot.groq;
  const cloudflareWorkersAiCapacity = capacitySnapshot.cloudflare_workers_ai;
  const selection = selectProviderForNewFullEvent({
    routerEnabled: input.enabled,
    groqCapacityAvailable: groqCapacity.eligible,
    cloudflareCapacityAvailable: cloudflareWorkersAiCapacity.eligible,
    cloudflareAllRequiredStagesValidated: input.cloudflareAllRequiredStagesValidated === true && cloudflareAllRequiredStagesValidated(),
    cloudflareActivationGates: input.cloudflareActivationGates,
  });
  groqCapacity.productionEligible = selection.provider === "groq";
  cloudflareWorkersAiCapacity.productionEligible = selection.provider === "cloudflare_workers_ai";
  const selectedProvider = selection.provider;
  const reason = selectedProvider === "cloudflare_workers_ai" ? `GROQ_${groqCapacity.reason}` : selection.reason;
  return { selectedProvider, selectedModel: selectedProvider ? input.configs[selectedProvider].model : null, reason, groqCapacity, cloudflareWorkersAiCapacity, capacitySnapshot, estimatedEventRequests: requests, estimatedEventTokens: input.estimatedEventTokens, estimatedGroqEventPlanningTokens: estimatedGroqEventTokens, estimatedEventNeurons, providerSticky: true, freeOnly: true };
}

export type EventProviderAssignment = { eventKey: string; provider: FreeProviderId; model: string };

export function assignEventProvider(eventKey: string, decision: ProviderRouteDecision): EventProviderAssignment {
  if (!decision.selectedProvider || !decision.selectedModel) throw new Error("BLOCKED_FREE_CAPACITY_EXHAUSTED");
  return Object.freeze({ eventKey, provider: decision.selectedProvider, model: decision.selectedModel });
}

export function assertEventStageAssignment(assignment: EventProviderAssignment, eventKey: string, provider: FreeProviderId, model: string): void {
  if (assignment.eventKey !== eventKey || assignment.provider !== provider || assignment.model !== model) throw new Error("EVENT_PROVIDER_ASSIGNMENT_MISMATCH");
}

export function defaultOfflineCapacityConfig(provider: FreeProviderId, model: string, dailyRequestLimit: number | null, dailyTokenLimit: number | null, configured = true): ProviderCapacityConfig {
  if (provider === "cloudflare_workers_ai") {
    const rates = isCloudflareModelFreeApproved(model) ? readCloudflareNeuronRates({}, model) : CLOUDFLARE_GPT_OSS_20B_NEURON_RATES;
    return { provider, model, endpoint: "https://api.cloudflare.com/client/v4/accounts/00000000000000000000000000000000/ai/v1/chat/completions", configured, ...(dailyRequestLimit === null ? {} : { dailyRequestLimit }), dailyTokenLimit: null, usageUnit: "neurons", dailyNeuronAllocation: dailyTokenLimit ?? undefined, inputNeuronsPerMillionTokens: rates.inputNeuronsPerMillionTokens, outputNeuronsPerMillionTokens: rates.outputNeuronsPerMillionTokens, neuronSafetyMarginBps: rates.safetyMarginBps, softLimitRatio: DAILY_SOFT_LIMIT_RATIO };
  }
  return { provider, model, endpoint: freeProviderPolicy[provider].endpoint, configured, ...(dailyRequestLimit === null ? {} : { dailyRequestLimit }), dailyTokenLimit, usageUnit: "tokens", softLimitRatio: DAILY_SOFT_LIMIT_RATIO };
}
