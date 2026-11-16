import { AgentError, FreeTierLimitReachedError } from "./agent-errors.ts";
import type { StructuredOutputMode } from "./runtime-types.ts";
import type { ProviderId } from "./provider-cost-policy.ts";

export const FREE_TIER_DAILY_REQUEST_LIMIT = 20;
export const MAX_GROQ_DAILY_REQUEST_HARD_LIMIT = 1_000;
export const FREE_TIER_MAX_OUTPUT_TOKENS = 1_200;

export type GroqRequestCapSource = "GROQ_DAILY_REQUEST_HARD_CAP" | "LEGACY_GROQ_FALLBACK" | "SAFE_DEFAULT";

export function resolveGroqDailyRequestHardCap(env: NodeJS.ProcessEnv = process.env): { limit: number; source: GroqRequestCapSource } {
  const canonical = env.GROQ_DAILY_REQUEST_HARD_CAP?.trim();
  const legacy = env.AGENT_DAILY_REQUEST_LIMIT?.trim();
  const source: GroqRequestCapSource = canonical ? "GROQ_DAILY_REQUEST_HARD_CAP" : legacy ? "LEGACY_GROQ_FALLBACK" : "SAFE_DEFAULT";
  if (!canonical && !legacy) return { limit: FREE_TIER_DAILY_REQUEST_LIMIT, source };
  const limit = Number(canonical || legacy);
  const maximum = canonical ? MAX_GROQ_DAILY_REQUEST_HARD_LIMIT : FREE_TIER_DAILY_REQUEST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new AgentError("cost_guard_violation", `${source} must be an integer between 1 and ${maximum}`);
  }
  return { limit, source };
}

export function readGroqDailyRequestHardCap(env: NodeJS.ProcessEnv = process.env): number {
  return resolveGroqDailyRequestHardCap(env).limit;
}

export function readOptionalCloudflareDailyRequestLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.CLOUDFLARE_FREE_DAILY_REQUEST_LIMIT?.trim();
  if (!raw) return null;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new AgentError("cost_guard_violation", "CLOUDFLARE_FREE_DAILY_REQUEST_LIMIT must be an integer between 1 and 1000");
  }
  return limit;
}

export function readStructuredOutputMode(value: string | undefined, fallback: StructuredOutputMode = "strict_schema"): StructuredOutputMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "strict_schema" || normalized === "strict") return "strict_schema";
  if (normalized === "best_effort_schema" || normalized === "best_effort") return "best_effort_schema";
  if (normalized === "json_object") return "json_object";
  throw new AgentError("cost_guard_violation", "Structured output mode must be strict_schema, best_effort_schema, or json_object");
}

export class DailyRequestLimitReachedError extends AgentError {
  readonly limit: number;

  constructor(limit: number) {
    super("DAILY_REQUEST_LIMIT_REACHED", `Internal daily model request limit reached (${limit})`);
    this.name = "DailyRequestLimitReachedError";
    this.limit = limit;
  }
}

export type RequestBudgetClock = () => Date;

export type DailyRequestBudgetReservation = {
  dailyCount: number;
  requestDate: string;
};

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class DailyRequestBudget {
  private readonly clock: RequestBudgetClock;
  private readonly counts = new Map<string, number>();
  private readonly blocked = new Set<string>();

  constructor(clock: RequestBudgetClock = () => new Date()) {
    this.clock = clock;
  }

  currentDateUtc(): string { return utcDay(this.clock()); }

  reserve(limit: number, provider: ProviderId | "mock" = "groq"): DailyRequestBudgetReservation {
    const currentDay = utcDay(this.clock());
    const key = `${provider}:${currentDay}`;
    if (!Number.isInteger(limit) || limit < 1) throw new AgentError("cost_guard_violation", "Invalid provider hard request cap");
    if (this.blocked.has(key)) throw new FreeTierLimitReachedError();
    const count = this.counts.get(key) ?? 0;
    if (count >= limit) throw new DailyRequestLimitReachedError(limit);
    this.counts.set(key, count + 1);
    return { dailyCount: count + 1, requestDate: currentDay };
  }

  markRateLimited(provider: ProviderId | "mock" = "groq"): void {
    this.blocked.add(`${provider}:${utcDay(this.clock())}`);
  }

  release(requestDate: string, provider: ProviderId | "mock" = "groq"): void {
    const currentDay = utcDay(this.clock());
    const key = `${provider}:${requestDate}`;
    const count = this.counts.get(key) ?? 0;
    if (requestDate === currentDay && count > 0) this.counts.set(key, count - 1);
  }

  snapshot(provider: ProviderId | "mock" = "groq"): { day: string; requests: number } {
    const day = utcDay(this.clock());
    return { day, requests: this.counts.get(`${provider}:${day}`) ?? 0 };
  }
}

/** Process-local guard for future routed runs; the persistent RPC remains authoritative. */
export class ProviderScopedDailyRequestBudget {
  private readonly clock: RequestBudgetClock;
  private readonly maxRequestsPerInstance: number | null;
  private readonly counts = new Map<string, number>();
  private readonly blocked = new Set<string>();

  constructor(clock: RequestBudgetClock = () => new Date(), maxRequestsPerInstance: number | null = null) {
    if (maxRequestsPerInstance !== null && (!Number.isSafeInteger(maxRequestsPerInstance) || maxRequestsPerInstance < 1)) throw new AgentError("cost_guard_violation", "Invalid run-scoped provider request cap");
    this.clock = clock;
    this.maxRequestsPerInstance = maxRequestsPerInstance;
  }

  currentDateUtc(): string { return utcDay(this.clock()); }

  private key(provider: ProviderId | "mock"): string { return `${provider}:${utcDay(this.clock())}`; }

  /** Read-only view of the instance cap, across providers and UTC days. */
  executionSnapshot(): { cap: number | null; requests: number; remaining: number | null } {
    const requests = [...this.counts.values()].reduce((sum, count) => sum + count, 0);
    return { cap: this.maxRequestsPerInstance, requests, remaining: this.maxRequestsPerInstance === null ? null : Math.max(0, this.maxRequestsPerInstance - requests) };
  }

  reserve(provider: ProviderId | "mock", limit: number): DailyRequestBudgetReservation {
    if (!Number.isInteger(limit) || limit < 1) throw new AgentError("cost_guard_violation", "Invalid provider hard request cap");
    const totalRequests = [...this.counts.values()].reduce((sum, count) => sum + count, 0);
    if (this.maxRequestsPerInstance !== null && totalRequests >= this.maxRequestsPerInstance) throw new DailyRequestLimitReachedError(this.maxRequestsPerInstance);
    const key = this.key(provider);
    if (this.blocked.has(key)) throw new FreeTierLimitReachedError();
    const count = this.counts.get(key) ?? 0;
    if (count >= limit) throw new DailyRequestLimitReachedError(limit);
    this.counts.set(key, count + 1);
    return { dailyCount: count + 1, requestDate: key.slice(key.indexOf(":") + 1) };
  }

  release(provider: ProviderId | "mock", requestDate: string): void {
    const key = this.key(provider);
    if (!key.endsWith(`:${requestDate}`)) return;
    const count = this.counts.get(key) ?? 0;
    if (count > 0) this.counts.set(key, count - 1);
  }

  markRateLimited(provider: ProviderId | "mock"): void { this.blocked.add(this.key(provider)); }
  snapshot(provider: ProviderId | "mock"): { day: string; requests: number } {
    const key = this.key(provider);
    return { day: key.slice(key.indexOf(":") + 1), requests: this.counts.get(key) ?? 0 };
  }
}

export const defaultProviderScopedDailyRequestBudget = new ProviderScopedDailyRequestBudget();

export function validateCostGuardConfig(config: {
  dailyRequestLimit: number;
  maxOutputTokens: number;
  failOnRateLimit: boolean;
  allowPaidFallback: boolean;
  structuredOutputMode: StructuredOutputMode;
}): void {
  if (!Number.isInteger(config.dailyRequestLimit) || config.dailyRequestLimit < 1 || config.dailyRequestLimit > MAX_GROQ_DAILY_REQUEST_HARD_LIMIT) {
    throw new AgentError("cost_guard_violation", `Daily request limit must be between 1 and ${MAX_GROQ_DAILY_REQUEST_HARD_LIMIT}`);
  }
  if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1 || config.maxOutputTokens > FREE_TIER_MAX_OUTPUT_TOKENS) {
    throw new AgentError("cost_guard_violation", `Max output tokens must be between 1 and ${FREE_TIER_MAX_OUTPUT_TOKENS}`);
  }
  if (!config.failOnRateLimit) throw new AgentError("cost_guard_violation", "AGENT_FAIL_ON_RATE_LIMIT must remain true");
  if (config.allowPaidFallback) throw new AgentError("cost_guard_violation", "AGENT_ALLOW_PAID_FALLBACK must remain false");
  if (!["strict_schema", "best_effort_schema", "json_object"].includes(config.structuredOutputMode)) {
    throw new AgentError("cost_guard_violation", "Structured output mode must be strict_schema, best_effort_schema, or json_object");
  }
}
