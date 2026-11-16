import fs from "node:fs";
import path from "node:path";
import { AgentError } from "./agent-errors.ts";

/**
 * Local, provider-specific capacity accounting for the Gemini free tier.
 *
 * The official per-model limits are shown only in the AI Studio dashboard (login required), so none are assumed:
 * the defaults below are deliberately tiny and every one can be overridden from the environment. Counting is local
 * (process memory, optionally mirrored to a JSON ledger file). It is NOT the durable Supabase ledger and it does
 * not see usage made outside this process; that is the reason the defaults stay far below any published figure.
 * Gemini rate limits are per project and RPD resets at midnight Pacific time
 * (https://ai.google.dev/gemini-api/docs/rate-limits), so days are keyed by America/Los_Angeles.
 */
export type GeminiLimits = { rpm: number; rpd: number; tpm: number; tpd: number };

export const GEMINI_DEFAULT_LIMITS: Readonly<GeminiLimits> = Object.freeze({ rpm: 2, rpd: 20, tpm: 6_000, tpd: 40_000 });
export const GEMINI_LIMIT_CEILINGS: Readonly<GeminiLimits> = Object.freeze({ rpm: 1_000, rpd: 10_000, tpm: 1_000_000, tpd: 10_000_000 });
export const GEMINI_MAX_PACING_WAIT_MS = 90_000;

export function readGeminiLimits(env: NodeJS.ProcessEnv = process.env): GeminiLimits {
  const limits: GeminiLimits = { ...GEMINI_DEFAULT_LIMITS };
  for (const key of ["rpm", "rpd", "tpm", "tpd"] as const) {
    const name = `GEMINI_LIMIT_${key.toUpperCase()}`;
    const raw = env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > GEMINI_LIMIT_CEILINGS[key]) {
      throw new AgentError("cost_guard_violation", `${name} must be an integer between 1 and ${GEMINI_LIMIT_CEILINGS[key]}`);
    }
    limits[key] = value;
  }
  if (limits.tpm > limits.tpd) throw new AgentError("cost_guard_violation", "GEMINI_LIMIT_TPM cannot exceed GEMINI_LIMIT_TPD");
  if (limits.rpm > limits.rpd) throw new AgentError("cost_guard_violation", "GEMINI_LIMIT_RPM cannot exceed GEMINI_LIMIT_RPD");
  return limits;
}

export function readGeminiPacingMaxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GEMINI_PACING_MAX_WAIT_MS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value > GEMINI_MAX_PACING_WAIT_MS) {
    throw new AgentError("cost_guard_violation", `GEMINI_PACING_MAX_WAIT_MS must be an integer between 0 and ${GEMINI_MAX_PACING_WAIT_MS}`);
  }
  return value;
}

export type GeminiLimitKind = "RPM" | "RPD" | "TPM" | "TPD" | "RATE_LIMITED_429" | "REQUEST_TOO_LARGE" | "LEDGER_UNAVAILABLE";

/** Local denial before dispatch. Maps to PROVIDER_CAPACITY_EXHAUSTED, which the pipeline treats as "defer", never as "retry elsewhere". */
export class GeminiLocalLimitError extends AgentError {
  readonly limitKind: GeminiLimitKind;
  readonly retryAfterMs: number | null;

  constructor(limitKind: GeminiLimitKind, message: string, retryAfterMs: number | null) {
    super("PROVIDER_CAPACITY_EXHAUSTED", message, undefined, { provider: "gemini_free", providerRequestDispatched: false });
    this.name = "GeminiLocalLimitError";
    this.limitKind = limitKind;
    this.retryAfterMs = retryAfterMs;
  }

  /** Only the rolling minute windows self-heal fast enough to be worth waiting for inside a run. */
  get isMinuteWindow(): boolean { return this.limitKind === "RPM" || this.limitKind === "TPM"; }
}

type MinuteEvent = { id: number; at: number; tokens: number };
export type GeminiUsageState = {
  version: 1;
  dayKey: string;
  dayRequests: number;
  dayTokens: number;
  blockedUntil: number | null;
  minute: MinuteEvent[];
  nextId: number;
};

export interface GeminiUsageStore {
  load(): GeminiUsageState | null;
  save(state: GeminiUsageState): void;
}

export class InMemoryGeminiUsageStore implements GeminiUsageStore {
  private state: GeminiUsageState | null = null;
  load(): GeminiUsageState | null { return this.state ? structuredClone(this.state) : null; }
  save(state: GeminiUsageState): void { this.state = structuredClone(state); }
}

/** Single-process JSON mirror. Cross-process races are out of scope; an unreadable file fails closed. */
export class FileGeminiUsageStore implements GeminiUsageStore {
  private readonly file: string;
  constructor(file: string) { this.file = path.resolve(file); }

  load(): GeminiUsageState | null {
    if (!fs.existsSync(this.file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    const state = parsed as Partial<GeminiUsageState> | null;
    if (!state || state.version !== 1 || typeof state.dayKey !== "string" || !Number.isSafeInteger(state.dayRequests) || !Number.isSafeInteger(state.dayTokens)
      || !Array.isArray(state.minute) || !Number.isSafeInteger(state.nextId) || (state.blockedUntil !== null && !Number.isFinite(state.blockedUntil))) {
      throw new Error("Invalid Gemini usage ledger");
    }
    return state as GeminiUsageState;
  }

  save(state: GeminiUsageState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), "utf8");
    fs.renameSync(temp, this.file);
  }
}

const pacificDayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
export function pacificDayKey(ms: number): string { return pacificDayFormat.format(new Date(ms)); }

/** First instant of the next Pacific day (the provider's RPD reset). */
export function nextPacificMidnightMs(ms: number): number {
  const current = pacificDayKey(ms);
  let low = ms;
  let high = ms + 26 * 3_600_000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (pacificDayKey(mid) === current) low = mid; else high = mid;
  }
  return high;
}

export type GeminiLease = {
  readonly id: number;
  readonly estimatedTokens: number;
  markDispatched(): void;
  /** Pre-dispatch only. A dispatched lease keeps counting (the provider may have counted it too). */
  release(): void;
  /** Replaces the estimate with provider-reported tokens; a larger real figure is recorded as is. */
  settle(actualTokens: number): void;
};

export type GeminiCapacitySnapshot = {
  dayKey: string; dayRequests: number; dayTokens: number; minuteRequests: number; minuteTokens: number;
  blockedUntil: string | null; limits: GeminiLimits;
};

export type GeminiRateLimitHint = { retryAfterMs: number | null; scope: "minute" | "day" | "unknown" };

export class GeminiLimitAccountant {
  readonly limits: GeminiLimits;
  private readonly now: () => number;
  private readonly store: GeminiUsageStore;
  private state: GeminiUsageState | null = null;
  private loadFailure: string | null = null;
  private dispatched = new Set<number>();

  constructor(limits: GeminiLimits = { ...GEMINI_DEFAULT_LIMITS }, options: { now?: () => number; store?: GeminiUsageStore } = {}) {
    for (const key of ["rpm", "rpd", "tpm", "tpd"] as const) {
      if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new AgentError("cost_guard_violation", `Invalid Gemini ${key.toUpperCase()} limit`);
    }
    this.limits = Object.freeze({ ...limits });
    this.now = options.now ?? Date.now;
    this.store = options.store ?? new InMemoryGeminiUsageStore();
    try {
      this.state = this.store.load();
    } catch {
      this.loadFailure = "Gemini usage ledger is unreadable";
    }
    if (!this.state && !this.loadFailure) this.state = this.fresh(this.now());
  }

  private fresh(at: number): GeminiUsageState {
    return { version: 1, dayKey: pacificDayKey(at), dayRequests: 0, dayTokens: 0, blockedUntil: null, minute: [], nextId: 1 };
  }

  private current(): GeminiUsageState {
    if (this.loadFailure || !this.state) throw new GeminiLocalLimitError("LEDGER_UNAVAILABLE", `${this.loadFailure ?? "Gemini usage ledger is unavailable"}; refusing dispatch`, null);
    const at = this.now();
    const day = pacificDayKey(at);
    if (this.state.dayKey !== day) {
      this.state.dayKey = day;
      this.state.dayRequests = 0;
      this.state.dayTokens = 0;
      if (this.state.blockedUntil !== null && this.state.blockedUntil <= at) this.state.blockedUntil = null;
    }
    this.state.minute = this.state.minute.filter((event) => event.at > at - 60_000);
    return this.state;
  }

  private persist(state: GeminiUsageState): void {
    try {
      this.store.save(state);
    } catch {
      this.loadFailure = "Gemini usage ledger could not be written";
    }
  }

  snapshot(): GeminiCapacitySnapshot {
    const state = this.current();
    return {
      dayKey: state.dayKey, dayRequests: state.dayRequests, dayTokens: state.dayTokens,
      minuteRequests: state.minute.length, minuteTokens: state.minute.reduce((sum, event) => sum + event.tokens, 0),
      blockedUntil: state.blockedUntil !== null && state.blockedUntil > this.now() ? new Date(state.blockedUntil).toISOString() : null,
      limits: this.limits,
    };
  }

  /** Whole-event admission: only dimensions that cannot self-heal inside the event (blocks, daily limits). */
  admitEvent(input: { requests: number; tokens: number; largestRequestTokens: number }): void {
    const state = this.current();
    const at = this.now();
    if (state.blockedUntil !== null && state.blockedUntil > at) throw new GeminiLocalLimitError("RATE_LIMITED_429", "Gemini is blocked after a provider 429", state.blockedUntil - at);
    if (input.largestRequestTokens > this.limits.tpm) throw new GeminiLocalLimitError("REQUEST_TOO_LARGE", "A single event request exceeds the local TPM limit", null);
    const untilReset = nextPacificMidnightMs(at) - at;
    if (state.dayRequests + input.requests > this.limits.rpd) throw new GeminiLocalLimitError("RPD", "Not enough local Gemini RPD left to finish the event", untilReset);
    if (state.dayTokens + input.tokens > this.limits.tpd) throw new GeminiLocalLimitError("TPD", "Not enough local Gemini TPD left to finish the event", untilReset);
  }

  reserve(estimatedTokens: number): GeminiLease {
    if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 1) throw new AgentError("cost_guard_violation", "Invalid Gemini token estimate");
    const state = this.current();
    const at = this.now();
    if (state.blockedUntil !== null && state.blockedUntil > at) throw new GeminiLocalLimitError("RATE_LIMITED_429", "Gemini is blocked after a provider 429", state.blockedUntil - at);
    if (estimatedTokens > this.limits.tpm) throw new GeminiLocalLimitError("REQUEST_TOO_LARGE", "Gemini request exceeds the local TPM limit on its own", null);
    const untilReset = nextPacificMidnightMs(at) - at;
    if (state.dayRequests + 1 > this.limits.rpd) throw new GeminiLocalLimitError("RPD", "Local Gemini RPD limit reached", untilReset);
    if (state.dayTokens + estimatedTokens > this.limits.tpd) throw new GeminiLocalLimitError("TPD", "Local Gemini TPD limit reached", untilReset);
    if (state.minute.length + 1 > this.limits.rpm) {
      const oldest = state.minute[0];
      throw new GeminiLocalLimitError("RPM", "Local Gemini RPM limit reached", oldest.at + 60_000 - at);
    }
    const minuteTokens = state.minute.reduce((sum, event) => sum + event.tokens, 0);
    if (minuteTokens + estimatedTokens > this.limits.tpm) {
      let freed = 0;
      let waitUntil = at;
      for (const event of state.minute) {
        freed += event.tokens;
        waitUntil = event.at + 60_000;
        if (minuteTokens - freed + estimatedTokens <= this.limits.tpm) break;
      }
      throw new GeminiLocalLimitError("TPM", "Local Gemini TPM limit reached", Math.max(0, waitUntil - at));
    }
    const id = state.nextId++;
    state.dayRequests += 1;
    state.dayTokens += estimatedTokens;
    const event: MinuteEvent = { id, at, tokens: estimatedTokens };
    state.minute.push(event);
    this.persist(state);
    return {
      id,
      estimatedTokens,
      markDispatched: () => { this.dispatched.add(id); },
      release: () => {
        if (this.dispatched.has(id) || !this.state) return;
        const live = this.state;
        const index = live.minute.findIndex((entry) => entry.id === id);
        if (index >= 0) live.minute.splice(index, 1);
        live.dayRequests = Math.max(0, live.dayRequests - 1);
        live.dayTokens = Math.max(0, live.dayTokens - estimatedTokens);
        this.persist(live);
      },
      settle: (actualTokens) => {
        if (!Number.isSafeInteger(actualTokens) || actualTokens < 0 || !this.state) return;
        const live = this.state;
        const entry = live.minute.find((candidate) => candidate.id === id);
        live.dayTokens = Math.max(0, live.dayTokens - estimatedTokens + actualTokens);
        if (entry) entry.tokens = actualTokens;
        this.persist(live);
      },
    };
  }

  /**
   * Fail closed after a provider 429. Quota scope is read from the response when present; anything not provably a
   * per-minute window blocks until the next Pacific midnight, because a daily quota cannot be told apart from a minute one otherwise.
   */
  recordRateLimited(hint: GeminiRateLimitHint): void {
    const state = this.current();
    const at = this.now();
    const minuteBlock = hint.scope === "minute" ? Math.max(60_000, hint.retryAfterMs ?? 0) : null;
    const until = minuteBlock !== null ? at + minuteBlock : Math.max(nextPacificMidnightMs(at), at + (hint.retryAfterMs ?? 0));
    state.blockedUntil = Math.max(state.blockedUntil ?? 0, until);
    this.persist(state);
  }
}

/** Reads the 429 body (`error.details`: QuotaFailure/RetryInfo) without trusting its shape. */
export function parseGeminiRateLimitHint(body: unknown, retryAfterHeaderSeconds: number | null): GeminiRateLimitHint {
  let retryAfterMs = retryAfterHeaderSeconds !== null && retryAfterHeaderSeconds >= 0 ? Math.ceil(retryAfterHeaderSeconds * 1_000) : null;
  let scope: GeminiRateLimitHint["scope"] = "unknown";
  const details = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "object" && (body as { error: { details?: unknown } }).error !== null
    ? (body as { error: { details?: unknown } }).error.details
    : undefined;
  if (Array.isArray(details)) {
    const quotaIds: string[] = [];
    for (const detail of details) {
      if (typeof detail !== "object" || detail === null) continue;
      const record = detail as { retryDelay?: unknown; violations?: unknown };
      if (typeof record.retryDelay === "string") {
        const seconds = /^(\d+(?:\.\d+)?)s$/.exec(record.retryDelay.trim());
        if (seconds) retryAfterMs = Math.max(retryAfterMs ?? 0, Math.ceil(Number(seconds[1]) * 1_000));
      }
      if (Array.isArray(record.violations)) {
        for (const violation of record.violations) {
          const quotaId = typeof violation === "object" && violation !== null ? (violation as { quotaId?: unknown }).quotaId : undefined;
          if (typeof quotaId === "string") quotaIds.push(quotaId.toLowerCase());
        }
      }
    }
    if (quotaIds.length > 0) {
      if (quotaIds.some((id) => id.includes("perday") || id.includes("daily"))) scope = "day";
      else if (quotaIds.every((id) => id.includes("minute"))) scope = "minute";
    }
  }
  return { retryAfterMs, scope };
}
