import { randomUUID } from "node:crypto";
import { SupabaseAgentLogger } from "../../runtime/agent-logger.ts";
import { readGroqDailyRequestHardCap } from "../../runtime/request-budget.ts";
import { readProviderSoftLimitRatio, type FreeProviderCapacitySnapshot } from "../../runtime/free-provider-router.ts";
import { createSupabaseServerClient } from "../../../supabase/server-client.ts";
import { createScheduledRunPlan } from "./scheduler-policy.ts";
import { DEFAULT_SCHEDULING_TIMEZONE, classifyScheduleSlot, triggerIdentity, utcRequestDate } from "./scheduler-slots.ts";
import { SupabaseSchedulerRepository } from "./scheduler-repository.ts";
import { readSchedulerProviderCapacitySnapshot } from "./provider-capacity-reader.ts";

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function schedulerConfig() {
  return {
    schedulingTimezone: process.env.SCHEDULER_TIMEZONE?.trim() || DEFAULT_SCHEDULING_TIMEZONE,
    maxEventsPerRun: integerEnv("SCHEDULER_MAX_EVENTS_PER_RUN", 3, 1, 100),
    leaseTtlMs: integerEnv("SCHEDULER_LEASE_TTL_MS", 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
    dailyLimit: readGroqDailyRequestHardCap(),
    admissionLimit: Math.max(0, Math.floor(readGroqDailyRequestHardCap() * readProviderSoftLimitRatio()) - 1),
  } as const;
}

export type SchedulerPreflightResult = {
  allowed: boolean;
  triggerId: string;
  slot: "morning" | "afternoon" | "night";
  schedulingTimezone: string;
  requestDateUtc: string;
  quotaRemaining: number;
  quotaLimit: number;
  quotaAdmissionLimit: number;
  quotaProvider: "groq";
  providerCapacitySnapshot: FreeProviderCapacitySnapshot;
  maxEventsPerRun: number;
  automaticRevision: false;
  dryRun: true;
  publish: false;
  leaseFirst: "acquired" | "expired" | "busy" | "duplicate";
  overlapCheck: "blocked" | "not_run";
  duplicateAfterRelease: "duplicate" | "not_run";
  wrongOwnerRelease: false | "not_run";
  pipelineExecuted: false;
  articleWrites: 0;
  cleanedUp: boolean;
};

/** Server-only preflight using a test namespace; it never reserves model budget or calls the pipeline. */
export async function runSchedulerPreflight(now = new Date()): Promise<SchedulerPreflightResult> {
  const config = schedulerConfig();
  const supabase = createSupabaseServerClient();
  const logger = new SupabaseAgentLogger(supabase);
  const repository = new SupabaseSchedulerRepository(supabase);
  const requestDateUtc = utcRequestDate(now);
  const slot = classifyScheduleSlot(now, config.schedulingTimezone);
  const namespace = `test:scheduler-preflight:${randomUUID()}`;
  const triggerId = `${namespace}:${requestDateUtc}:${slot}`;
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const availability = await logger.getRemainingRequests(config.dailyLimit, requestDateUtc);
  const quotaRemaining = Math.max(0, config.admissionLimit - availability.used);
  const providerCapacitySnapshot = await readSchedulerProviderCapacitySnapshot(logger, now);
  const expiresAt = new Date(now.getTime() + config.leaseTtlMs).toISOString();
  const plan = createScheduledRunPlan({
    runId: ownerA,
    triggerId,
    scheduledAt: now,
    quota: { provider: "groq", requestDateUtc, limit: availability.dailyLimit, admissionLimit: config.admissionLimit, used: availability.used, remaining: quotaRemaining },
    policy: { schedulingTimezone: config.schedulingTimezone, maxEventsPerRun: config.maxEventsPerRun, leaseTtlMs: config.leaseTtlMs },
    eligibleEventCount: 1,
  });
  const acquireInput = {
    triggerId,
    ownerRunId: ownerA,
    invocationType: "preflight" as const,
    scheduleDateUtc: requestDateUtc,
    slot,
    schedulingTimezone: config.schedulingTimezone,
    scheduledAt: now.toISOString(),
    requestDateUtc,
    now: now.toISOString(),
    expiresAt,
    quotaUsed: availability.used,
    quotaRemaining,
    maxEventsPerRun: config.maxEventsPerRun,
    automaticRevision: false as const,
    dryRun: true as const,
    publish: false as const,
  };
  let cleanedUp = false;
  try {
    const first = await repository.acquire(acquireInput);
    const overlap = first.status === "acquired" || first.status === "expired"
      ? await repository.acquire({ ...acquireInput, ownerRunId: ownerB })
      : null;
    const overlapCheck = overlap?.status === "busy" ? "blocked" : "not_run";
    const wrongOwnerRelease = first.status === "acquired" || first.status === "expired"
      ? (await repository.release({ triggerId, ownerRunId: ownerB, releasedAt: now.toISOString() }) ? "not_run" : false)
      : "not_run";
    const ownerReleased = first.status === "acquired" || first.status === "expired"
      ? await repository.release({ triggerId, ownerRunId: ownerA, releasedAt: now.toISOString() })
      : false;
    const duplicateAfterRelease = ownerReleased
      ? (await repository.acquire({ ...acquireInput, ownerRunId: ownerB })).status
      : "not_run";
    await repository.deleteTestTrigger(namespace);
    cleanedUp = true;
    return {
      allowed: plan.allowed,
      triggerId,
      slot,
      schedulingTimezone: config.schedulingTimezone,
      requestDateUtc,
      quotaRemaining,
      quotaLimit: availability.dailyLimit,
      quotaAdmissionLimit: config.admissionLimit,
      quotaProvider: "groq",
      providerCapacitySnapshot,
      maxEventsPerRun: config.maxEventsPerRun,
      automaticRevision: false,
      dryRun: true,
      publish: false,
      leaseFirst: first.status,
      overlapCheck,
      duplicateAfterRelease: duplicateAfterRelease === "duplicate" ? "duplicate" : "not_run",
      wrongOwnerRelease,
      pipelineExecuted: false,
      articleWrites: 0,
      cleanedUp,
    };
  } catch (error) {
    if (!cleanedUp) await repository.deleteTestTrigger(namespace).catch(() => undefined);
    throw error;
  }
}

/** The future Netlify trigger calls this boundary; in 10C.1 it is deliberately preflight-only. */
export async function runSchedulerTrigger(now = new Date()): Promise<SchedulerPreflightResult> {
  return runSchedulerPreflight(now);
}

export function schedulerTriggerIdentity(now = new Date(), timezone = DEFAULT_SCHEDULING_TIMEZONE): string {
  return triggerIdentity(utcRequestDate(now), classifyScheduleSlot(now, timezone));
}
