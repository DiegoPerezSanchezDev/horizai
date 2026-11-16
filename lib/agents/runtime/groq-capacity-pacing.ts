import { normalizeGroqProviderRateLimit, parseDurationSeconds } from "./model-provider.ts";
import type { ProviderRateLimitSnapshot, ProviderRateLimitTelemetry, RateLimitHeaders } from "./runtime-types.ts";

export const GROQ_TPM_SAFETY_MARGIN = 128;
export const GROQ_RESET_SAFETY_MARGIN_MS = 250;
export const GROQ_CAPACITY_ESTIMATOR_CHARS_PER_TOKEN = 2;
export const GROQ_CAPACITY_ESTIMATOR_INPUT_OVERHEAD = 128;
export const GROQ_TPD_SOFT_RATIO = 0.85;
export const MAX_GROQ_HEADER_DRIVEN_PACING_WAIT_MS = 60_000;
export const MAX_GROQ_RATE_LIMIT_HEADER_AGE_MS = 15_000;

export type GroqFirstStageCapacityDecision =
  | { decision: "ALLOW_LOCAL_RESERVATION"; evidence: "FRESH_HEADER_SUFFICIENT" | "NO_FRESH_HEADER" | "FRESH_HEADER_REMAINING_UNKNOWN" }
  | { decision: "DEFER_TEMPORARY_CAPACITY"; evidence: "FRESH_HEADER_INSUFFICIENT"; requiredTokens: number; remainingTokens: number }
  | { decision: "INTRINSICALLY_TOO_LARGE"; evidence: "STATIC_LIMIT"; requiredTokens: number; hardLimitTokens: number };

export type GroqProviderHeaderAdmissionDecision =
  | {
      decision: "ALLOW_LOCAL_RESERVATION";
      externalState: "HEADER_ABSENT" | "HEADER_STALE" | "EXTERNAL_REMAINING_UNKNOWN" | "EXTERNAL_REMAINING_KNOWN_SUFFICIENT";
      requiredTokens: number;
    }
  | {
      decision: "DEFER_TEMPORARY_CAPACITY";
      externalState: "EXTERNAL_REMAINING_KNOWN_INSUFFICIENT";
      requiredTokens: number;
      remainingTokens: number;
    }
  | {
      decision: "INTRINSICALLY_TOO_LARGE";
      externalState: "NOT_CHECKED";
      requiredTokens: number;
      hardLimitTokens: number;
    };

/**
 * Applies the same external-header rule to every Groq request. Durable local
 * accounting remains the atomic reservation's responsibility. Missing or
 * stale provider state is explicitly unknown and never blocks bootstrap.
 */
export function decideGroqProviderHeaderAdmission(input: {
  estimatedStageTokenRequirement: number;
  tokenLimitTpm: number;
  providerSnapshot?: ProviderRateLimitSnapshot | null;
  now?: Date;
  safetyMarginTokens?: number;
  maxHeaderAgeMs?: number;
}): GroqProviderHeaderAdmissionDecision {
  const margin = input.safetyMarginTokens ?? GROQ_TPM_SAFETY_MARGIN;
  if (![input.estimatedStageTokenRequirement, input.tokenLimitTpm, margin].every((value) => Number.isSafeInteger(value) && value >= 0)
    || input.estimatedStageTokenRequirement < 1 || input.tokenLimitTpm < 1) throw new Error("Invalid Groq provider-header admission input");
  const requiredTokens = input.estimatedStageTokenRequirement + margin;
  if (!Number.isSafeInteger(requiredTokens)) throw new Error("Invalid Groq provider-header requirement");
  if (requiredTokens > input.tokenLimitTpm) {
    return { decision: "INTRINSICALLY_TOO_LARGE", externalState: "NOT_CHECKED", requiredTokens, hardLimitTokens: input.tokenLimitTpm };
  }

  const snapshot = input.providerSnapshot;
  if (!snapshot) return { decision: "ALLOW_LOCAL_RESERVATION", externalState: "HEADER_ABSENT", requiredTokens };
  const observedAt = Date.parse(snapshot.observedAt);
  const now = (input.now ?? new Date()).getTime();
  const maxAge = input.maxHeaderAgeMs ?? MAX_GROQ_RATE_LIMIT_HEADER_AGE_MS;
  const ageMs = now - observedAt;
  const resetSeconds = snapshot.telemetry.tokenResetSeconds;
  const resetElapsed = Number.isFinite(resetSeconds) && resetSeconds !== null && resetSeconds >= 0 && ageMs >= resetSeconds * 1_000;
  if (!Number.isFinite(observedAt) || observedAt > now + 1_000 || ageMs > maxAge || resetElapsed) {
    return { decision: "ALLOW_LOCAL_RESERVATION", externalState: "HEADER_STALE", requiredTokens };
  }

  const remainingTokens = snapshot.telemetry.tokenRemainingMinute;
  if (!Number.isSafeInteger(remainingTokens) || remainingTokens === null || remainingTokens < 0) {
    return { decision: "ALLOW_LOCAL_RESERVATION", externalState: "EXTERNAL_REMAINING_UNKNOWN", requiredTokens };
  }
  if (remainingTokens < requiredTokens) {
    return { decision: "DEFER_TEMPORARY_CAPACITY", externalState: "EXTERNAL_REMAINING_KNOWN_INSUFFICIENT", requiredTokens, remainingTokens };
  }
  return { decision: "ALLOW_LOCAL_RESERVATION", externalState: "EXTERNAL_REMAINING_KNOWN_SUFFICIENT", requiredTokens };
}

/**
 * First-stage capacity is informed by a fresh persisted provider header when
 * one exists. Missing or stale external state is not treated as exhausted;
 * the atomic local reservation remains authoritative for known local usage.
 */
export function decideGroqFirstStageCapacity(input: {
  estimatedStageTokenRequirement: number;
  tokenLimitTpm: number;
  providerSnapshot?: ProviderRateLimitSnapshot | null;
  now?: Date;
  safetyMarginTokens?: number;
  maxHeaderAgeMs?: number;
}): GroqFirstStageCapacityDecision {
  const admission = decideGroqProviderHeaderAdmission(input);
  if (admission.decision === "INTRINSICALLY_TOO_LARGE") {
    return { decision: admission.decision, evidence: "STATIC_LIMIT", requiredTokens: admission.requiredTokens, hardLimitTokens: admission.hardLimitTokens };
  }
  if (admission.decision === "DEFER_TEMPORARY_CAPACITY") {
    return { decision: admission.decision, evidence: "FRESH_HEADER_INSUFFICIENT", requiredTokens: admission.requiredTokens, remainingTokens: admission.remainingTokens };
  }
  return {
    decision: admission.decision,
    evidence: admission.externalState === "EXTERNAL_REMAINING_KNOWN_SUFFICIENT" ? "FRESH_HEADER_SUFFICIENT"
      : admission.externalState === "EXTERNAL_REMAINING_UNKNOWN" ? "FRESH_HEADER_REMAINING_UNKNOWN" : "NO_FRESH_HEADER",
  };
}

export function separateGroqLimitProvenance<TManual extends Record<string, unknown>, TProvider extends Record<string, unknown>>(input: {
  manualConfirmation: TManual;
  providerReported: TProvider;
}): {
  humanConfirmedPlan: { provenance: "USER_MANUAL_CONFIRMATION" } & TManual;
  providerReportedLimits: { provenance: "PROVIDER_REPORTED_HEADERS" } & TProvider;
} {
  return {
    humanConfirmedPlan: { ...input.manualConfirmation, provenance: "USER_MANUAL_CONFIRMATION" },
    providerReportedLimits: { ...input.providerReported, provenance: "PROVIDER_REPORTED_HEADERS" },
  };
}

export type GroqProbeExecutionMode = "PREFLIGHT_ONLY" | "EXECUTE_ONE_PATH";

export function resolveGroqProbeExecutionMode(args: readonly string[]): GroqProbeExecutionMode {
  if (args.length === 0) return "PREFLIGHT_ONLY";
  if (args.length === 1 && args[0] === "--execute-one-path") return "EXECUTE_ONE_PATH";
  throw new Error("Unsupported probe arguments; only --execute-one-path is accepted");
}

export type GroqStageTokenEstimate = {
  promptInputChars: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  estimatedStageTokenRequirement: number;
  estimator: "existing_chars_per_2_plus_128_overhead";
};

export function estimateGroqStageTokenRequirement(input: {
  systemInstructionChars: number;
  modelInputChars: number;
  schemaChars: number;
  maxOutputTokens: number;
}): GroqStageTokenEstimate {
  const values = [input.systemInstructionChars, input.modelInputChars, input.schemaChars];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
    || !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
    throw new Error("Invalid stage token estimate input");
  }
  const promptInputChars = values.reduce((sum, value) => sum + value, 0);
  const estimatedInputTokens = Math.ceil(promptInputChars / GROQ_CAPACITY_ESTIMATOR_CHARS_PER_TOKEN) + GROQ_CAPACITY_ESTIMATOR_INPUT_OVERHEAD;
  return {
    promptInputChars,
    estimatedInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    estimatedStageTokenRequirement: estimatedInputTokens + input.maxOutputTokens,
    estimator: "existing_chars_per_2_plus_128_overhead",
  };
}

/**
 * Returns the largest JSON input (in JavaScript characters) that fits under the
 * hard per-minute contract after reserving the configured completion budget,
 * estimator overhead, and the existing TPM safety margin.
 */
export function maxGroqModelInputCharsForTpm(input: {
  systemInstructionChars: number;
  schemaChars: number;
  maxOutputTokens: number;
  tokenLimitTpm: number;
  safetyMarginTokens?: number;
}): number {
  const values = [input.systemInstructionChars, input.schemaChars, input.maxOutputTokens, input.tokenLimitTpm];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
    || input.maxOutputTokens < 1 || input.tokenLimitTpm < 1
    || (input.safetyMarginTokens !== undefined && (!Number.isSafeInteger(input.safetyMarginTokens) || input.safetyMarginTokens < 0))) {
    throw new Error("Invalid Groq model-input budget input");
  }
  const safetyMarginTokens = input.safetyMarginTokens ?? GROQ_TPM_SAFETY_MARGIN;
  const availableInputTokens = input.tokenLimitTpm - input.maxOutputTokens - safetyMarginTokens - GROQ_CAPACITY_ESTIMATOR_INPUT_OVERHEAD;
  if (availableInputTokens < 1) return 0;
  const promptCharBudget = availableInputTokens * GROQ_CAPACITY_ESTIMATOR_CHARS_PER_TOKEN;
  return Math.max(0, promptCharBudget - input.systemInstructionChars - input.schemaChars);
}

export type GroqPacingDecision =
  | { decision: "IMMEDIATE"; waitDurationMs: 0; reason: "FIRST_STAGE" | "TOKEN_HEADROOM_SUFFICIENT" | "EXTERNAL_REMAINING_UNKNOWN" }
  | { decision: "WAIT_FOR_TOKEN_RESET"; waitDurationMs: number; reason: "TOKEN_HEADROOM_INSUFFICIENT"; resetSeconds: number }
  | { decision: "BLOCKED_SINGLE_STAGE_TPM_SAFETY"; waitDurationMs: 0; reason: "STAGE_ESTIMATE_EXCEEDS_TPM" }
  | { decision: "BLOCKED_TPM_RESET_UNKNOWN"; waitDurationMs: 0; reason: "TPM_RESET_UNKNOWN" };

export function decideGroqTpmPacing(input: {
  isFirstStage: boolean;
  providerHeaders: ProviderRateLimitTelemetry | null;
  estimatedStageTokenRequirement: number;
  tokenLimitTpm: number;
  safetyMarginTokens?: number;
  resetSafetyMarginMs?: number;
}): GroqPacingDecision {
  const safetyMarginTokens = input.safetyMarginTokens ?? GROQ_TPM_SAFETY_MARGIN;
  const resetSafetyMarginMs = input.resetSafetyMarginMs ?? GROQ_RESET_SAFETY_MARGIN_MS;
  if (![input.estimatedStageTokenRequirement, input.tokenLimitTpm, safetyMarginTokens, resetSafetyMarginMs]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    || input.estimatedStageTokenRequirement < 1 || input.tokenLimitTpm < 1) {
    throw new Error("Invalid Groq TPM pacing input");
  }
  if (input.estimatedStageTokenRequirement + safetyMarginTokens > input.tokenLimitTpm) {
    return { decision: "BLOCKED_SINGLE_STAGE_TPM_SAFETY", waitDurationMs: 0, reason: "STAGE_ESTIMATE_EXCEEDS_TPM" };
  }
  if (input.isFirstStage) return { decision: "IMMEDIATE", waitDurationMs: 0, reason: "FIRST_STAGE" };
  const remaining = input.providerHeaders?.tokenRemainingMinute ?? null;
  if (remaining === null || !Number.isSafeInteger(remaining) || remaining < 0) {
    return { decision: "IMMEDIATE", waitDurationMs: 0, reason: "EXTERNAL_REMAINING_UNKNOWN" };
  }
  if (remaining >= input.estimatedStageTokenRequirement + safetyMarginTokens) {
    return { decision: "IMMEDIATE", waitDurationMs: 0, reason: "TOKEN_HEADROOM_SUFFICIENT" };
  }
  const resetSeconds = input.providerHeaders?.tokenResetSeconds ?? null;
  if (resetSeconds === null || !Number.isFinite(resetSeconds) || resetSeconds < 0) {
    return { decision: "BLOCKED_TPM_RESET_UNKNOWN", waitDurationMs: 0, reason: "TPM_RESET_UNKNOWN" };
  }
  const waitDurationMs = Math.ceil(resetSeconds * 1_000 + resetSafetyMarginMs);
  if (!Number.isSafeInteger(waitDurationMs) || waitDurationMs < 0) {
    return { decision: "BLOCKED_TPM_RESET_UNKNOWN", waitDurationMs: 0, reason: "TPM_RESET_UNKNOWN" };
  }
  return { decision: "WAIT_FOR_TOKEN_RESET", waitDurationMs, reason: "TOKEN_HEADROOM_INSUFFICIENT", resetSeconds };
}

export function normalizeGroqHeadersForPacing(headers: RateLimitHeaders | null | undefined): ProviderRateLimitTelemetry | null {
  return headers ? normalizeGroqProviderRateLimit(headers) : null;
}

/** The artifact stores only the explicitly allowlisted Groq rate-limit headers. */
export function captureAllowlistedGroqHeaders(headers: RateLimitHeaders | null | undefined): Record<string, string | null> {
  return {
    "x-ratelimit-limit-requests": headers?.limitRequests ?? null,
    "x-ratelimit-remaining-requests": headers?.remainingRequests ?? null,
    "x-ratelimit-reset-requests": headers?.resetRequests ?? null,
    "x-ratelimit-limit-tokens": headers?.limitTokens ?? null,
    "x-ratelimit-remaining-tokens": headers?.remainingTokens ?? null,
    "x-ratelimit-reset-tokens": headers?.resetTokens ?? null,
    "retry-after": headers?.retryAfter ?? null,
  };
}

export type Groq429Classification = "TPM_LIMIT" | "RPM_LIMIT" | "RPD_LIMIT" | "OTHER" | "UNKNOWN";

export function classifyGroq429Evidence(input: {
  headers: RateLimitHeaders | null | undefined;
  providerMessage?: string | null;
  providerCode?: string | null;
}): Groq429Classification {
  const message = `${input.providerCode ?? ""} ${input.providerMessage ?? ""}`.toLowerCase();
  if (/\b(tpm|tokens? per minute)\b/.test(message) || input.headers?.remainingTokens === "0" || input.headers?.remainingTokensMinute === "0") return "TPM_LIMIT";
  if (/\b(rpm|requests? per minute)\b/.test(message)) return "RPM_LIMIT";
  if (/\b(rpd|requests? per day|daily request limit)\b/.test(message) || input.headers?.remainingRequests === "0" || input.headers?.remainingRequestsDay === "0") return "RPD_LIMIT";
  if (/\b(account suspended|billing disabled|model unavailable|invalid api key)\b/.test(message)) return "OTHER";
  return "UNKNOWN";
}

export type RollingUsagePoint = { timestampUtc: string; amount: number };

export function maximumRolling60SecondAmount(points: readonly RollingUsagePoint[]): number {
  const normalized = points.map((point) => ({ time: Date.parse(point.timestampUtc), amount: point.amount }));
  if (normalized.some((point) => !Number.isFinite(point.time) || !Number.isSafeInteger(point.amount) || point.amount < 0)) {
    throw new Error("Invalid rolling usage point");
  }
  normalized.sort((a, b) => a.time - b.time);
  let maximum = 0;
  for (let start = 0; start < normalized.length; start += 1) {
    let sum = 0;
    for (let end = start; end < normalized.length && normalized[end].time - normalized[start].time < 60_000; end += 1) sum += normalized[end].amount;
    maximum = Math.max(maximum, sum);
  }
  return maximum;
}

export type TpdScenario = {
  paths: 10 | 12 | 15;
  tokenDemand: number;
  percentageOfHardTpd: number;
  fitsHardTpd: boolean;
  fitsSoft85PercentTpd: boolean;
  softThresholdTokens: number;
};

export function calculateTpdScenarios(fullPathTotalTokens: number, hardTpd: number): TpdScenario[] {
  if (!Number.isSafeInteger(fullPathTotalTokens) || fullPathTotalTokens < 0 || !Number.isSafeInteger(hardTpd) || hardTpd < 1) {
    throw new Error("Invalid TPD scenario input");
  }
  const softThresholdTokens = Math.floor(hardTpd * GROQ_TPD_SOFT_RATIO);
  return ([10, 12, 15] as const).map((paths) => {
    const tokenDemand = fullPathTotalTokens * paths;
    return {
      paths,
      tokenDemand,
      percentageOfHardTpd: tokenDemand / hardTpd * 100,
      fitsHardTpd: tokenDemand <= hardTpd,
      fitsSoft85PercentTpd: tokenDemand <= softThresholdTokens,
      softThresholdTokens,
    };
  });
}

export function classifyUnpacedPath(input: { fullPath: boolean; unpacedTokenSum: number | null; tpmLimit: number }):
  "UNPACED_CLEARLY_OVER_TPM" | "UNPACED_BELOW_TPM_BUT_NOT_CERTIFIED" | "PARTIAL_PATH_INSUFFICIENT_DATA" {
  if (!input.fullPath || input.unpacedTokenSum === null) return "PARTIAL_PATH_INSUFFICIENT_DATA";
  return input.unpacedTokenSum > input.tpmLimit ? "UNPACED_CLEARLY_OVER_TPM" : "UNPACED_BELOW_TPM_BUT_NOT_CERTIFIED";
}

export function classifyGroqPacing(input: {
  fullPath: boolean;
  waitCount: number;
  unpacedClassification: ReturnType<typeof classifyUnpacedPath>;
  maximumObserved60sTokens: number;
  tpmLimit: number;
}): "PACING_REQUIRED" | "PACING_RECOMMENDED" | "IMMEDIATE_PATH_PLAUSIBLY_SAFE_BUT_NOT_CERTIFIED" | "PARTIAL_PATH_INSUFFICIENT_DATA" {
  if (!input.fullPath) return "PARTIAL_PATH_INSUFFICIENT_DATA";
  if (input.waitCount > 0) return "PACING_REQUIRED";
  if (input.unpacedClassification === "UNPACED_CLEARLY_OVER_TPM" || input.maximumObserved60sTokens > input.tpmLimit) return "PACING_RECOMMENDED";
  return "IMMEDIATE_PATH_PLAUSIBLY_SAFE_BUT_NOT_CERTIFIED";
}

export function assertGroqStageIdentity(input: { provider: string | undefined; model: string; expectedModel: string }): void {
  if (input.provider !== "groq" || input.model !== input.expectedModel) throw new Error("GROQ_STAGE_IDENTITY_MISMATCH");
}

export function hasExplicitGroqRequestIdentity(input: {
  runProvider: unknown;
  configProvider: unknown;
  configModel: unknown;
  telemetryProvider: unknown;
  telemetryModel: unknown;
  providerRequestsUsed: unknown;
  reservationCount: number;
  reservationProvider: unknown;
  reservationModel: unknown;
  reservationDispatched: unknown;
  expectedModel: string;
}): boolean {
  return input.runProvider === "groq"
    && input.configProvider === "groq"
    && input.configModel === input.expectedModel
    && input.telemetryProvider === "groq"
    && input.telemetryModel === input.expectedModel
    && input.providerRequestsUsed === 1
    && input.reservationCount === 1
    && input.reservationProvider === "groq"
    && input.reservationModel === input.expectedModel
    && input.reservationDispatched === true;
}

export { parseDurationSeconds };
