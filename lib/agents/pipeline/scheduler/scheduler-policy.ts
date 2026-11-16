import { initialRequestsRequired, revisionRequestsRequired } from "../pipeline-budget.ts";
import { DEFAULT_SCHEDULING_TIMEZONE, classifyScheduleSlot, nextScheduleSlot, triggerIdentity } from "./scheduler-slots.ts";
import { canStartEvent, eventsAllowedByBudget, plannedEventLimit, remainingAfterEvent } from "./scheduler-budget.ts";
import type { ScheduledRunPlan, SchedulerEventCandidate, SchedulerEventEligibility, SchedulerEventAttempt, SchedulerPolicyConfig, SchedulerQuotaSnapshot, SchedulerRunResult, SchedulerStopReason } from "./scheduler-types.ts";

export const DEFAULT_SCHEDULER_POLICY: SchedulerPolicyConfig = {
  schedulingTimezone: DEFAULT_SCHEDULING_TIMEZONE,
  quotaResetTimezone: "UTC",
  maxEventsPerRun: 3,
  hours: 48,
  dryRun: true,
  publish: false,
  automaticRevision: false,
  maxRevisionAttempts: 1,
  leaseTtlMs: 60 * 60 * 1000,
};

function validateQuota(quota: SchedulerQuotaSnapshot): void {
  const admissionLimit = quota.admissionLimit ?? quota.limit;
  if ((quota.provider !== undefined && quota.provider !== "groq") || !/^\d{4}-\d{2}-\d{2}$/.test(quota.requestDateUtc) || !Number.isInteger(quota.limit) || quota.limit < 1 || !Number.isInteger(admissionLimit) || admissionLimit < 0 || admissionLimit > quota.limit || !Number.isInteger(quota.used) || quota.used < 0 || !Number.isInteger(quota.remaining) || quota.remaining !== Math.max(0, admissionLimit - quota.used)) throw new Error("SCHEDULER_INVALID_QUOTA_SNAPSHOT");
}

function validatePolicy(policy: SchedulerPolicyConfig): void {
  if (!policy.schedulingTimezone || policy.quotaResetTimezone !== "UTC" || !Number.isInteger(policy.maxEventsPerRun) || policy.maxEventsPerRun < 1 || !Number.isInteger(policy.hours) || policy.hours < 1 || !policy.dryRun || policy.publish || policy.automaticRevision || policy.maxRevisionAttempts !== 1 || !Number.isInteger(policy.leaseTtlMs) || policy.leaseTtlMs < 1) throw new Error("SCHEDULER_POLICY_MUST_BE_OFFLINE_SAFE");
}

export function createScheduledRunPlan(input: {
  runId: string;
  triggerId?: string;
  scheduledAt: Date;
  quota: SchedulerQuotaSnapshot;
  policy?: Partial<SchedulerPolicyConfig>;
  activeRun?: boolean;
  duplicateTrigger?: boolean;
  eligibleEventCount?: number;
}): ScheduledRunPlan {
  const policy = { ...DEFAULT_SCHEDULER_POLICY, ...input.policy };
  validatePolicy(policy);
  validateQuota(input.quota);
  if (!input.runId.trim() || Number.isNaN(input.scheduledAt.getTime())) throw new Error("SCHEDULER_INVALID_RUN_REQUEST");
  const slot = classifyScheduleSlot(input.scheduledAt, policy.schedulingTimezone);
  const requestDateUtc = input.quota.requestDateUtc;
  const triggerId = input.triggerId ?? triggerIdentity(requestDateUtc, slot);
  const budgetEvents = eventsAllowedByBudget(input.quota.remaining);
  const planned = Math.min(plannedEventLimit(input.quota.remaining, policy.maxEventsPerRun), input.eligibleEventCount ?? Number.MAX_SAFE_INTEGER);
  let blockReason: ScheduledRunPlan["blockReason"] = null;
  if (input.duplicateTrigger) blockReason = "BLOCKED_DUPLICATE_TRIGGER";
  else if (input.activeRun) blockReason = "BLOCKED_RUN_ALREADY_ACTIVE";
  else if (!canStartEvent(input.quota.remaining)) blockReason = "BLOCKED_INSUFFICIENT_DAILY_BUDGET";
  else if (planned === 0) blockReason = "NO_ELIGIBLE_EVENTS";
  return { triggerId, runId: input.runId, scheduledAt: input.scheduledAt.toISOString(), slot, timezone: policy.schedulingTimezone, requestDateUtc, quotaProvider: "groq", quotaLimit: input.quota.limit, quotaAdmissionLimit: input.quota.admissionLimit ?? input.quota.limit, quotaUsed: input.quota.used, quotaRemaining: input.quota.remaining, worstCasePerEvent: initialRequestsRequired(), maxEventsPerRun: policy.maxEventsPerRun, eventsAllowedByBudget: budgetEvents, plannedEventLimit: blockReason ? 0 : planned, automaticRevision: false, dryRun: true, publish: false, hours: policy.hours, allowed: blockReason === null, blockReason };
}

export function eventEligibility(candidate: SchedulerEventCandidate, currentRunId: string): SchedulerEventEligibility {
  if (candidate.status === "new") return { eligible: true, reason: "ELIGIBLE" };
  if (candidate.status === "success") return { eligible: false, reason: "EVENT_ALREADY_COMPLETED" };
  if (candidate.status === "published") return { eligible: false, reason: "EVENT_ALREADY_PUBLISHED" };
  if (candidate.status === "failed") return { eligible: candidate.retryAllowed === true && candidate.attemptedRunId !== currentRunId, reason: "EVENT_FAILED_NO_IMMEDIATE_RETRY" };
  if (candidate.status === "skipped_verification_insufficient") return { eligible: candidate.reconsiderationAllowed === true, reason: "SKIPPED_RECONSIDERATION_UNSUPPORTED" };
  if (candidate.status === "blocked_revision_required") return { eligible: false, reason: "REVISION_REQUIRED_NOT_NORMAL_EVENT" };
  return { eligible: false, reason: "REJECTED_NOT_NORMAL_EVENT" };
}

export function selectEligibleEvents(candidates: SchedulerEventCandidate[], currentRunId: string, limit: number): SchedulerEventCandidate[] {
  if (!Number.isInteger(limit) || limit < 0) throw new Error("SCHEDULER_INVALID_SELECTION_LIMIT");
  const uniqueCandidates = new Map<string, SchedulerEventCandidate>();
  for (const candidate of candidates) {
    const existing = uniqueCandidates.get(candidate.eventKey);
    if (!existing || (existing.status === "new" && candidate.status !== "new")) uniqueCandidates.set(candidate.eventKey, candidate);
  }
  return [...uniqueCandidates.values()].filter((candidate) => eventEligibility(candidate, currentRunId).eligible).sort((left, right) => {
    const leftDate = left.publishedAt ? Date.parse(left.publishedAt) : Number.MAX_SAFE_INTEGER;
    const rightDate = right.publishedAt ? Date.parse(right.publishedAt) : Number.MAX_SAFE_INTEGER;
    return leftDate - rightDate || left.eventKey.localeCompare(right.eventKey);
  }).slice(0, limit);
}

export function accountEventAndCheckNext(input: { remaining: number; requestsUsed: number; processed: number; maxEventsPerRun: number }): { remaining: number; canContinue: boolean; stopReason: SchedulerStopReason } {
  const remaining = remainingAfterEvent(input.remaining, input.requestsUsed);
  if (input.processed + 1 >= input.maxEventsPerRun) return { remaining, canContinue: false, stopReason: "MAX_EVENTS_PER_RUN" };
  if (!canStartEvent(remaining)) return { remaining, canContinue: false, stopReason: "BUDGET_EXHAUSTED" };
  return { remaining, canContinue: true, stopReason: null };
}

export function schedulerResult(input: { plan: ScheduledRunPlan; quotaAfter: SchedulerQuotaSnapshot; leaseOutcome: SchedulerRunResult["leaseOutcome"]; attempts: SchedulerEventAttempt[]; stopReason: SchedulerStopReason }): SchedulerRunResult {
  const completed = input.attempts.filter((attempt) => attempt.status === "completed").length;
  const skipped = input.attempts.filter((attempt) => attempt.status === "skipped").length;
  const blocked = input.attempts.filter((attempt) => attempt.status === "blocked").length;
  const failed = input.attempts.filter((attempt) => attempt.status === "failed").length;
  return { triggerId: input.plan.triggerId, scheduledAt: input.plan.scheduledAt, slot: input.plan.slot, runId: input.plan.runId, leaseOutcome: input.leaseOutcome, quotaBefore: { provider: input.plan.quotaProvider, requestDateUtc: input.plan.requestDateUtc, limit: input.plan.quotaLimit, admissionLimit: input.plan.quotaAdmissionLimit, used: input.plan.quotaUsed, remaining: input.plan.quotaRemaining }, quotaAfter: { ...input.quotaAfter, provider: input.plan.quotaProvider }, eventAttempts: input.attempts, completed, skipped, blocked, failed, requestsUsed: input.attempts.reduce((sum, attempt) => sum + attempt.requestsUsed, 0), stopReason: input.stopReason, nextEligibleSlot: nextScheduleSlot(input.plan.slot) };
}

export function revisionCost(stage: "verification" | "translation" | "editorial" | "classification" | "ranking"): number {
  const internalStage = ({ verification: "verifier", translation: "translator", editorial: "editor", classification: "classifier", ranking: "ranker" } as const)[stage];
  return revisionRequestsRequired(internalStage);
}
