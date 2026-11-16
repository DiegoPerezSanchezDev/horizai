import { randomUUID } from "node:crypto";
import type { Json } from "../../../../types/database.ts";
import { createProductionPipeline, type ProductionPipeline, type ProductionPipelineOptions } from "../create-production-pipeline.ts";
import type { PipelineRunResult } from "../pipeline-types.ts";
import { readGroqDailyRequestHardCap } from "../../runtime/request-budget.ts";
import { readProviderSoftLimitRatio, type FreeProviderCapacitySnapshot } from "../../runtime/free-provider-router.ts";
import { SupabaseAgentLogger } from "../../runtime/agent-logger.ts";
import { createSupabaseServerClient } from "../../../supabase/server-client.ts";
import { createScheduledRunPlan, schedulerResult } from "./scheduler-policy.ts";
import { DEFAULT_SCHEDULING_TIMEZONE, classifyScheduleSlot, utcRequestDate } from "./scheduler-slots.ts";
import { SupabaseSchedulerRepository, type PersistentSchedulerAcquireInput, type PersistentSchedulerAcquireResult } from "./scheduler-repository.ts";
import { readSchedulerProviderCapacitySnapshot } from "./provider-capacity-reader.ts";
import type { SchedulerEventAttempt, SchedulerQuotaSnapshot, SchedulerRunResult } from "./scheduler-types.ts";

const EXECUTION_MAX_EVENTS_PER_RUN = 1;

type SchedulerQuotaReader = (requestDateUtc: string) => Promise<{ provider?: "groq"; dailyLimit: number; admissionLimit?: number; used: number; remaining: number }>;
type SchedulerCapacityReader = (now: Date) => Promise<FreeProviderCapacitySnapshot>;
type PipelineFactory = (options: ProductionPipelineOptions) => ProductionPipeline;
type SchedulerRepository = Pick<SupabaseSchedulerRepository, "acquire" | "finish" | "finishExecution" | "release">;

export type SchedulerExecutionOptions = {
  mode: "preflight" | "execute";
  authorized?: boolean;
  testNamespace?: string;
  triggerId?: string;
  now?: Date;
  hours?: number;
  repository?: SchedulerRepository;
  readQuota?: SchedulerQuotaReader;
  readCapacity?: SchedulerCapacityReader;
  pipelineFactory?: PipelineFactory;
};

export type SchedulerExecutionResult = SchedulerRunResult & {
  pipelineInvoked: boolean;
  pipelineRunId: string | null;
  selectedEventKey: string | null;
  finalEventState: string | null;
  schedulerDecision: string;
  leaseReleased: boolean;
  durationMs: number;
  providerCapacityBefore?: FreeProviderCapacitySnapshot | null;
  providerCapacityAfter?: FreeProviderCapacitySnapshot | null;
};

function leaseOutcome(status: PersistentSchedulerAcquireResult["status"]): SchedulerRunResult["leaseOutcome"] {
  return status === "duplicate" ? "rejected" : status;
}

function defaultQuotaReader(): SchedulerQuotaReader {
  const supabase = createSupabaseServerClient();
  const logger = new SupabaseAgentLogger(supabase);
  const dailyLimit = readGroqDailyRequestHardCap();
  const admissionLimit = Math.max(0, Math.floor(dailyLimit * readProviderSoftLimitRatio()) - 1);
  return async (requestDateUtc) => {
    const usage = await logger.getRemainingRequests(dailyLimit, requestDateUtc);
    return { provider: "groq", dailyLimit, admissionLimit, used: usage.used, remaining: Math.max(0, admissionLimit - usage.used) };
  };
}

function defaultProviderCapacityReader(): SchedulerCapacityReader {
  const supabase = createSupabaseServerClient();
  const logger = new SupabaseAgentLogger(supabase);
  return (now) => readSchedulerProviderCapacitySnapshot(logger, now);
}

function eventAttempts(result: PipelineRunResult): SchedulerEventAttempt[] {
  return result.eventResults.map((event) => {
    const status = event.finalState === "READY_FOR_PUBLICATION_DRY_RUN" || event.finalState === "SUCCESS" ? "completed"
      : event.finalState === "SKIPPED" ? "skipped"
        : event.finalState.startsWith("BLOCKED") ? "blocked" : "failed";
    return { eventKey: event.eventKey, status, requestsUsed: event.requestsUsed, reason: event.stopReason };
  });
}

function isRateLimit(result: PipelineRunResult): boolean {
  return result.eventResults.some((event) => event.failure?.errorCode === "FREE_TIER_LIMIT_REACHED" || event.failure?.httpStatus === 429 || event.stopReason === "FREE_TIER_LIMIT_REACHED");
}

function compactStates(result: PipelineRunResult): Json {
  return result.eventResults.map((event) => ({ eventKey: event.eventKey, finalState: event.finalState, stopReason: event.stopReason }));
}

function resultForBlockedPlan(plan: ReturnType<typeof createScheduledRunPlan>, quota: SchedulerQuotaSnapshot, stopReason: SchedulerRunResult["stopReason"], leaseOutcome: SchedulerRunResult["leaseOutcome"], providerCapacityBefore: FreeProviderCapacitySnapshot | null = null): SchedulerExecutionResult {
  const base = schedulerResult({ plan, quotaAfter: quota, leaseOutcome, attempts: [], stopReason });
  return { ...base, pipelineInvoked: false, pipelineRunId: null, selectedEventKey: null, finalEventState: null, schedulerDecision: stopReason ?? "BLOCKED", leaseReleased: false, durationMs: 0, providerCapacityBefore };
}

function executionInput(input: { triggerId: string; ownerRunId: string; slot: "morning" | "afternoon" | "night"; now: Date; expiresAt: Date; requestDateUtc: string; schedulingTimezone: string; quota: SchedulerQuotaSnapshot }): PersistentSchedulerAcquireInput {
  return { triggerId: input.triggerId, ownerRunId: input.ownerRunId, invocationType: "manual", scheduleDateUtc: input.requestDateUtc, slot: input.slot, schedulingTimezone: input.schedulingTimezone, scheduledAt: input.now.toISOString(), requestDateUtc: input.requestDateUtc, now: input.now.toISOString(), expiresAt: input.expiresAt.toISOString(), quotaUsed: input.quota.used, quotaRemaining: input.quota.remaining, maxEventsPerRun: EXECUTION_MAX_EVENTS_PER_RUN, automaticRevision: false, dryRun: true, publish: false };
}

function acquired(status: PersistentSchedulerAcquireResult["status"]): boolean {
  return status === "acquired" || status === "expired";
}

/** Explicit execute boundary. It is test-namespace-only in 10C.2 and always dry-run/publish-false. */
export async function executeScheduledPipeline(options: SchedulerExecutionOptions): Promise<SchedulerExecutionResult> {
  if (options.mode !== "execute") throw new Error("SCHEDULER_EXECUTION_MODE_REQUIRED");
  if (options.authorized !== true) throw new Error("SCHEDULER_EXECUTION_NOT_AUTHORIZED");
  if (!options.testNamespace?.startsWith("test:")) throw new Error("SCHEDULER_EXECUTION_REQUIRES_TEST_NAMESPACE");
  const now = options.now ?? new Date();
  const schedulingTimezone = process.env.SCHEDULER_TIMEZONE?.trim() || DEFAULT_SCHEDULING_TIMEZONE;
  const requestDateUtc = utcRequestDate(now);
  const slot = classifyScheduleSlot(now, schedulingTimezone);
  const triggerId = options.triggerId ?? `${options.testNamespace}:${requestDateUtc}:${slot}:${randomUUID()}`;
  if (!triggerId.startsWith("test:")) throw new Error("SCHEDULER_EXECUTION_TRIGGER_MUST_BE_TEST_NAMESPACE");
  const ownerRunId = randomUUID();
  const readQuota = options.readQuota ?? defaultQuotaReader();
  const readCapacity = options.readCapacity ?? (options.readQuota ? null : defaultProviderCapacityReader());
  const repository = options.repository ?? new SupabaseSchedulerRepository();
  const providerCapacityBefore = readCapacity ? await readCapacity(now) : null;
  const quotaBeforeValue = await readQuota(requestDateUtc);
  const quotaBefore: SchedulerQuotaSnapshot = { provider: quotaBeforeValue.provider ?? "groq", requestDateUtc, limit: quotaBeforeValue.dailyLimit, admissionLimit: quotaBeforeValue.admissionLimit, used: quotaBeforeValue.used, remaining: quotaBeforeValue.remaining };
  const plan = createScheduledRunPlan({ runId: ownerRunId, triggerId, scheduledAt: now, quota: quotaBefore, policy: { schedulingTimezone, maxEventsPerRun: EXECUTION_MAX_EVENTS_PER_RUN, hours: options.hours ?? 48, leaseTtlMs: 60 * 60 * 1000 }, eligibleEventCount: 1 });
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
  const acquiredLease = await repository.acquire(executionInput({ triggerId, ownerRunId, slot, now, expiresAt, requestDateUtc, schedulingTimezone, quota: quotaBefore }));
  if (!acquired(acquiredLease.status)) {
    const reason = acquiredLease.status === "busy" ? "BLOCKED_RUN_ALREADY_ACTIVE" : "BLOCKED_DUPLICATE_TRIGGER";
    return resultForBlockedPlan(plan, quotaBefore, reason, leaseOutcome(acquiredLease.status), providerCapacityBefore);
  }
  const startedAt = Date.now();
  let leaseReleased = false;
  let terminalFinalizationAttempted = false;
  try {
    if (!plan.allowed) {
      const result = resultForBlockedPlan(plan, quotaBefore, plan.blockReason, leaseOutcome(acquiredLease.status), providerCapacityBefore);
      terminalFinalizationAttempted = true;
      await repository.finish({ triggerId, ownerRunId, runStatus: "blocked", finalDecision: "blocked", stopReason: plan.blockReason, quotaUsed: quotaBefore.used, quotaRemaining: quotaBefore.remaining, finishedAt: new Date().toISOString() });
      leaseReleased = await repository.release({ triggerId, ownerRunId, releasedAt: new Date().toISOString() });
      return { ...result, leaseReleased, durationMs: Date.now() - startedAt };
    }
    const pipelineFactory = options.pipelineFactory ?? createProductionPipeline;
    const pipeline = pipelineFactory({ runId: ownerRunId, config: { hours: options.hours ?? 48, limit: EXECUTION_MAX_EVENTS_PER_RUN, dryRun: true, publish: false, trigger: "scheduled", automaticRevision: false, maxRevisionAttempts: 1 } });
    await pipeline.preflight();
    const pipelineResult = await pipeline.orchestrator.run();
    const attempts = eventAttempts(pipelineResult);
    const rateLimit = isRateLimit(pipelineResult);
    const technicalFailure = attempts.some((event) => event.status === "failed");
    const hasBlocked = attempts.some((event) => event.status === "blocked");
    const stopReason = rateLimit ? "BLOCKED_PROVIDER_RATE_LIMIT" : technicalFailure ? "EVENT_FAILED_CLOSED" : attempts.find((event) => event.reason === "BLOCKED_REVISION_REQUIRED" || event.reason === "BLOCKED_REJECTED")?.reason as SchedulerRunResult["stopReason"] ?? null;
    const quotaAfterValue = await readQuota(requestDateUtc);
    const quotaAfter: SchedulerQuotaSnapshot = { requestDateUtc, limit: quotaAfterValue.dailyLimit, admissionLimit: quotaAfterValue.admissionLimit, used: quotaAfterValue.used, remaining: quotaAfterValue.remaining };
    const providerCapacityAfter = readCapacity ? await readCapacity(new Date()) : null;
    const blockedReason = attempts.find((event) => event.reason === "BLOCKED_REVISION_REQUIRED" || event.reason === "BLOCKED_REJECTED")?.reason ?? null;
    const schedulerDecision = rateLimit ? "BLOCKED_PROVIDER_RATE_LIMIT" : technicalFailure ? "FAILED" : blockedReason ?? "COMPLETED";
    const runStatus = rateLimit || technicalFailure ? "failed" : hasBlocked ? "blocked" : "succeeded";
    const finalDecision = rateLimit || technicalFailure || hasBlocked ? "blocked" : "allowed";
    const durationMs = Date.now() - startedAt;
    terminalFinalizationAttempted = true;
    const persisted = await repository.finishExecution({ triggerId, ownerRunId, runStatus, finalDecision, schedulerDecision, stopReason, pipelineRunId: pipelineResult.runId, eventAttempts: attempts.length, eventFinalStates: compactStates(pipelineResult), requestsUsed: pipelineResult.providerRequestsUsed, quotaUsed: quotaAfter.used, quotaRemaining: quotaAfter.remaining, durationMs, finishedAt: new Date().toISOString() });
    if (!persisted) throw new Error("SCHEDULER_EXECUTION_HISTORY_NOT_UPDATED");
    leaseReleased = await repository.release({ triggerId, ownerRunId, releasedAt: new Date().toISOString() });
    const base = schedulerResult({ plan, quotaAfter, leaseOutcome: leaseOutcome(acquiredLease.status), attempts, stopReason });
    return { ...base, pipelineInvoked: true, pipelineRunId: pipelineResult.runId, selectedEventKey: pipelineResult.eventResults[0]?.eventKey ?? null, finalEventState: pipelineResult.eventResults[0]?.finalState ?? null, schedulerDecision, leaseReleased, durationMs, providerCapacityBefore, providerCapacityAfter };
  } catch (error) {
    const quotaAfterValue = await readQuota(requestDateUtc).catch(() => quotaBeforeValue);
    const quotaAfter: SchedulerQuotaSnapshot = { requestDateUtc, limit: quotaAfterValue.dailyLimit, admissionLimit: quotaAfterValue.admissionLimit, used: quotaAfterValue.used, remaining: quotaAfterValue.remaining };
    if (!terminalFinalizationAttempted) {
      terminalFinalizationAttempted = true;
      await repository.finish({ triggerId, ownerRunId, runStatus: "failed", finalDecision: "failed", stopReason: "EVENT_FAILED_CLOSED", quotaUsed: quotaAfter.used, quotaRemaining: quotaAfter.remaining, finishedAt: new Date().toISOString() }).catch(() => undefined);
    }
    leaseReleased = await repository.release({ triggerId, ownerRunId, releasedAt: new Date().toISOString() }).catch(() => false);
    throw error;
  }
}

/** Explicit preflight boundary: it may exercise a test lease, but never constructs or runs the pipeline. */
export async function runSchedulerPreflightExecution(options: SchedulerExecutionOptions): Promise<SchedulerExecutionResult> {
  if (options.mode !== "preflight") throw new Error("SCHEDULER_PREFLIGHT_MODE_REQUIRED");
  if (options.authorized !== true) throw new Error("SCHEDULER_PREFLIGHT_NOT_AUTHORIZED");
  if (!options.testNamespace?.startsWith("test:")) throw new Error("SCHEDULER_PREFLIGHT_REQUIRES_TEST_NAMESPACE");
  const now = options.now ?? new Date();
  const schedulingTimezone = process.env.SCHEDULER_TIMEZONE?.trim() || DEFAULT_SCHEDULING_TIMEZONE;
  const requestDateUtc = utcRequestDate(now);
  const slot = classifyScheduleSlot(now, schedulingTimezone);
  const triggerId = options.triggerId ?? `${options.testNamespace}:${requestDateUtc}:${slot}:${randomUUID()}`;
  if (!triggerId.startsWith("test:")) throw new Error("SCHEDULER_PREFLIGHT_TRIGGER_MUST_BE_TEST_NAMESPACE");
  const ownerRunId = randomUUID();
  const readQuota = options.readQuota ?? defaultQuotaReader();
  const readCapacity = options.readCapacity ?? (options.readQuota ? null : defaultProviderCapacityReader());
  const repository = options.repository ?? new SupabaseSchedulerRepository();
  const providerCapacityBefore = readCapacity ? await readCapacity(now) : null;
  const quotaValue = await readQuota(requestDateUtc);
  const quota: SchedulerQuotaSnapshot = { provider: quotaValue.provider ?? "groq", requestDateUtc, limit: quotaValue.dailyLimit, admissionLimit: quotaValue.admissionLimit, used: quotaValue.used, remaining: quotaValue.remaining };
  const plan = createScheduledRunPlan({ runId: ownerRunId, triggerId, scheduledAt: now, quota, policy: { schedulingTimezone, maxEventsPerRun: EXECUTION_MAX_EVENTS_PER_RUN, hours: options.hours ?? 48, leaseTtlMs: 60 * 60 * 1000 }, eligibleEventCount: 1 });
  const acquiredLease = await repository.acquire(executionInput({ triggerId, ownerRunId, slot, now, expiresAt: new Date(now.getTime() + 60 * 60 * 1000), requestDateUtc, schedulingTimezone, quota }));
  if (!acquired(acquiredLease.status)) {
    const reason = acquiredLease.status === "busy" ? "BLOCKED_RUN_ALREADY_ACTIVE" : "BLOCKED_DUPLICATE_TRIGGER";
    return resultForBlockedPlan(plan, quota, reason, leaseOutcome(acquiredLease.status), providerCapacityBefore);
  }
  const blocked = plan.allowed ? null : plan.blockReason;
  const result = resultForBlockedPlan(plan, quota, blocked, leaseOutcome(acquiredLease.status), providerCapacityBefore);
  await repository.finish({ triggerId, ownerRunId, runStatus: blocked ? "blocked" : "succeeded", finalDecision: blocked ? "blocked" : "allowed", stopReason: blocked, quotaUsed: quota.used, quotaRemaining: quota.remaining, finishedAt: new Date().toISOString() });
  const leaseReleased = await repository.release({ triggerId, ownerRunId, releasedAt: new Date().toISOString() });
  return { ...result, schedulerDecision: blocked ?? "PREFLIGHT", leaseReleased, durationMs: 0 };
}

/** Mode dispatcher kept explicit so callers cannot infer execute from omitted options. */
export async function runSchedulerExecution(options: SchedulerExecutionOptions): Promise<SchedulerExecutionResult> {
  return options.mode === "preflight" ? runSchedulerPreflightExecution(options) : executeScheduledPipeline(options);
}
