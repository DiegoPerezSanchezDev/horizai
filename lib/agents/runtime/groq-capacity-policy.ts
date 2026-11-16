export const GROQ_OBSERVED_N1_FULL_PATH_TOKENS = 10_347;
export const GROQ_FULL_PATH_REQUESTS = 6;
export const GROQ_DEFAULT_EVENT_TOKEN_MARGIN_PERCENT = 25;
export const GROQ_INITIAL_MAX_CONCURRENT_EVENTS = 1;

export type GroqCapacitySensitivity = {
  marginPercent: 10 | 15 | 20 | 25;
  provisionalEventTokens: number;
  eventsWithinSoftTpd: number;
};

export type GroqDailyCapacityPlan = {
  provenance: "PROVISIONAL_N1_CAPACITY";
  observedFullPathTokens: number;
  eventRequests: number;
  softRatio: number;
  requestHardLimit: number;
  requestSoftLimit: number;
  tokenHardLimit: number;
  tokenSoftLimit: number;
  selectedMarginPercent: number;
  selectedEventTokens: number;
  requestPlanningEventCapacity: number;
  tokenPlanningEventCapacity: number;
  finalEventCapacity: number;
  sensitivities: GroqCapacitySensitivity[];
};

export type GroqEventAdmission = {
  eligible: boolean;
  reason:
    | "GROQ_CAPACITY_AVAILABLE"
    | "GROQ_DAILY_REQUEST_SOFT_LIMIT"
    | "GROQ_DAILY_REQUEST_HARD_LIMIT"
    | "GROQ_DAILY_TOKEN_SOFT_LIMIT"
    | "GROQ_DAILY_TOKEN_HARD_LIMIT"
    | "GROQ_DAILY_TOKEN_USAGE_UNKNOWN";
  projectedRequests: number;
  projectedTokens: number | null;
  requestSoftLimit: number;
  tokenSoftLimit: number;
};

export type GroqCandidateSimulation = {
  candidates: number;
  plannedRequests: number;
  plannedTokens: number;
  requestSoftLimit: number;
  tokenSoftLimit: number;
  requestsWithinSoftLimit: boolean;
  tokensWithinSoftLimit: boolean;
  admitted: number;
  blocked: number;
  blockedReason: GroqEventAdmission["reason"] | null;
  admittedRequests: number;
  admittedTokens: number;
  remainingSoftTokens: number;
};

function positiveInteger(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

export function readGroqEventTokenMarginPercent(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GROQ_EVENT_TOKEN_PLANNING_MARGIN_PERCENT;
  if (raw === undefined || raw.trim() === "") return GROQ_DEFAULT_EVENT_TOKEN_MARGIN_PERCENT;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw new Error("GROQ_EVENT_TOKEN_PLANNING_MARGIN_PERCENT must be an integer from 0 to 100");
  return value;
}

export function provisionalGroqEventTokens(input: {
  observedFullPathTokens?: number;
  marginPercent?: number;
} = {}): number {
  const observed = input.observedFullPathTokens ?? GROQ_OBSERVED_N1_FULL_PATH_TOKENS;
  const margin = input.marginPercent ?? GROQ_DEFAULT_EVENT_TOKEN_MARGIN_PERCENT;
  if (!Number.isSafeInteger(observed) || observed < 1 || !Number.isSafeInteger(margin) || margin < 0 || margin > 100) throw new Error("Invalid Groq full-event planning estimate");
  return Math.ceil(observed * (1 + margin / 100));
}

export function planGroqDailyCapacity(input: {
  requestHardLimit: number;
  tokenHardLimit: number;
  softRatio: number;
  observedFullPathTokens?: number;
  eventRequests?: number;
  selectedMarginPercent?: number;
}): GroqDailyCapacityPlan {
  const eventRequests = input.eventRequests ?? GROQ_FULL_PATH_REQUESTS;
  if (![input.requestHardLimit, input.tokenHardLimit, eventRequests].every(Number.isSafeInteger)
    || input.requestHardLimit < 1 || input.tokenHardLimit < 1 || eventRequests < 1
    || !Number.isFinite(input.softRatio) || input.softRatio <= 0 || input.softRatio >= 1) throw new Error("Invalid Groq daily capacity plan input");
  const observedFullPathTokens = input.observedFullPathTokens ?? GROQ_OBSERVED_N1_FULL_PATH_TOKENS;
  const selectedMarginPercent = input.selectedMarginPercent ?? GROQ_DEFAULT_EVENT_TOKEN_MARGIN_PERCENT;
  const requestSoftLimit = Math.floor(input.requestHardLimit * input.softRatio);
  const tokenSoftLimit = Math.floor(input.tokenHardLimit * input.softRatio);
  const selectedEventTokens = provisionalGroqEventTokens({ observedFullPathTokens, marginPercent: selectedMarginPercent });
  const requestPlanningEventCapacity = Math.floor(requestSoftLimit / eventRequests);
  const tokenPlanningEventCapacity = Math.floor(tokenSoftLimit / selectedEventTokens);
  const sensitivities = ([10, 15, 20, 25] as const).map((marginPercent) => {
    const provisionalEventTokens = provisionalGroqEventTokens({ observedFullPathTokens, marginPercent });
    return { marginPercent, provisionalEventTokens, eventsWithinSoftTpd: Math.floor(tokenSoftLimit / provisionalEventTokens) };
  });
  return {
    provenance: "PROVISIONAL_N1_CAPACITY",
    observedFullPathTokens,
    eventRequests,
    softRatio: input.softRatio,
    requestHardLimit: input.requestHardLimit,
    requestSoftLimit,
    tokenHardLimit: input.tokenHardLimit,
    tokenSoftLimit,
    selectedMarginPercent,
    selectedEventTokens,
    requestPlanningEventCapacity,
    tokenPlanningEventCapacity,
    finalEventCapacity: Math.min(requestPlanningEventCapacity, tokenPlanningEventCapacity),
    sensitivities,
  };
}

export function evaluateGroqNewEventAdmission(input: {
  currentRequests: number;
  currentTokens: number | null;
  tokenUsageKnown: boolean;
  requestHardLimit: number;
  tokenHardLimit: number;
  softRatio: number;
  eventRequests?: number;
  eventTokens?: number;
}): GroqEventAdmission {
  const eventRequests = input.eventRequests ?? GROQ_FULL_PATH_REQUESTS;
  const eventTokens = input.eventTokens ?? provisionalGroqEventTokens();
  if (![input.currentRequests, input.requestHardLimit, input.tokenHardLimit, eventRequests, eventTokens].every(Number.isSafeInteger)
    || input.currentRequests < 0 || input.requestHardLimit < 1 || input.tokenHardLimit < 1 || eventRequests < 1 || eventTokens < 1
    || (input.currentTokens !== null && (!Number.isSafeInteger(input.currentTokens) || input.currentTokens < 0))
    || !Number.isFinite(input.softRatio) || input.softRatio <= 0 || input.softRatio >= 1) throw new Error("Invalid Groq event admission input");
  const requestSoftLimit = Math.floor(input.requestHardLimit * input.softRatio);
  const tokenSoftLimit = Math.floor(input.tokenHardLimit * input.softRatio);
  const projectedRequests = input.currentRequests + eventRequests;
  const projectedTokens = input.tokenUsageKnown && input.currentTokens !== null ? input.currentTokens + eventTokens : null;
  let reason: GroqEventAdmission["reason"] = "GROQ_CAPACITY_AVAILABLE";
  if (projectedRequests > input.requestHardLimit) reason = "GROQ_DAILY_REQUEST_HARD_LIMIT";
  else if (projectedRequests >= requestSoftLimit) reason = "GROQ_DAILY_REQUEST_SOFT_LIMIT";
  else if (!input.tokenUsageKnown || projectedTokens === null) reason = "GROQ_DAILY_TOKEN_USAGE_UNKNOWN";
  else if (projectedTokens > input.tokenHardLimit) reason = "GROQ_DAILY_TOKEN_HARD_LIMIT";
  else if (projectedTokens >= tokenSoftLimit) reason = "GROQ_DAILY_TOKEN_SOFT_LIMIT";
  return { eligible: reason === "GROQ_CAPACITY_AVAILABLE", reason, projectedRequests, projectedTokens, requestSoftLimit, tokenSoftLimit };
}

export function simulateGroqCandidateDemand(input: {
  candidates: number;
  requestHardLimit: number;
  tokenHardLimit: number;
  softRatio: number;
  eventRequests?: number;
  eventTokens?: number;
}): GroqCandidateSimulation {
  if (!Number.isSafeInteger(input.candidates) || input.candidates < 0) throw new Error("Invalid Groq candidate simulation count");
  const eventRequests = input.eventRequests ?? GROQ_FULL_PATH_REQUESTS;
  const eventTokens = input.eventTokens ?? provisionalGroqEventTokens();
  const requestSoftLimit = Math.floor(input.requestHardLimit * input.softRatio);
  const tokenSoftLimit = Math.floor(input.tokenHardLimit * input.softRatio);
  let admitted = 0;
  let blockedReason: GroqCandidateSimulation["blockedReason"] = null;
  let currentRequests = 0;
  let currentTokens = 0;
  for (let index = 0; index < input.candidates; index += 1) {
    const decision = evaluateGroqNewEventAdmission({
      currentRequests,
      currentTokens,
      tokenUsageKnown: true,
      requestHardLimit: input.requestHardLimit,
      tokenHardLimit: input.tokenHardLimit,
      softRatio: input.softRatio,
      eventRequests,
      eventTokens,
    });
    if (!decision.eligible) { blockedReason ??= decision.reason; continue; }
    admitted += 1;
    currentRequests += eventRequests;
    currentTokens += eventTokens;
  }
  const plannedRequests = input.candidates * eventRequests;
  const plannedTokens = input.candidates * eventTokens;
  return {
    candidates: input.candidates,
    plannedRequests,
    plannedTokens,
    requestSoftLimit,
    tokenSoftLimit,
    requestsWithinSoftLimit: plannedRequests <= requestSoftLimit,
    tokensWithinSoftLimit: plannedTokens <= tokenSoftLimit,
    admitted,
    blocked: input.candidates - admitted,
    blockedReason,
    admittedRequests: currentRequests,
    admittedTokens: currentTokens,
    remainingSoftTokens: tokenSoftLimit - currentTokens,
  };
}

export function readGroqDailyTokenHardLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  return positiveInteger(env.GROQ_DAILY_TOKEN_HARD_CAP, "GROQ_DAILY_TOKEN_HARD_CAP")
    ?? positiveInteger(env.GROQ_FREE_DAILY_TOKEN_LIMIT, "GROQ_FREE_DAILY_TOKEN_LIMIT");
}

export function readGroqRequestsPerMinuteHardLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  return positiveInteger(env.GROQ_REQUESTS_PER_MINUTE_HARD_CAP, "GROQ_REQUESTS_PER_MINUTE_HARD_CAP")
    ?? positiveInteger(env.GROQ_FREE_MINUTE_REQUEST_LIMIT, "GROQ_FREE_MINUTE_REQUEST_LIMIT");
}

export function readGroqTokensPerMinuteHardLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  return positiveInteger(env.GROQ_TOKENS_PER_MINUTE_HARD_CAP, "GROQ_TOKENS_PER_MINUTE_HARD_CAP")
    ?? positiveInteger(env.GROQ_FREE_MINUTE_TOKEN_LIMIT, "GROQ_FREE_MINUTE_TOKEN_LIMIT");
}

export function readGroqMaxConcurrentEvents(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GROQ_MAX_CONCURRENT_EVENTS;
  if (raw === undefined || raw.trim() === "") return GROQ_INITIAL_MAX_CONCURRENT_EVENTS;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("GROQ_MAX_CONCURRENT_EVENTS must be a positive integer");
  return value;
}

export function groqSequentialConcurrencyApproved(maxConcurrentGroqEvents: number): boolean {
  return Number.isSafeInteger(maxConcurrentGroqEvents) && maxConcurrentGroqEvents >= 1 && maxConcurrentGroqEvents <= GROQ_INITIAL_MAX_CONCURRENT_EVENTS;
}

export function evaluateGroqSchedulerThroughputReadiness(input: { proposedReady: boolean; maxConcurrentGroqEvents: number }): {
  schedulerThroughputReady: boolean;
  reason: "READY" | "SCHEDULER_THROUGHPUT_NOT_READY" | "GROQ_RPM_CONCURRENCY_NOT_APPROVED";
} {
  if (!groqSequentialConcurrencyApproved(input.maxConcurrentGroqEvents)) return { schedulerThroughputReady: false, reason: "GROQ_RPM_CONCURRENCY_NOT_APPROVED" };
  if (!input.proposedReady) return { schedulerThroughputReady: false, reason: "SCHEDULER_THROUGHPUT_NOT_READY" };
  return { schedulerThroughputReady: true, reason: "READY" };
}
