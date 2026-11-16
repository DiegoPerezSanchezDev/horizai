import { supervisedProviderRequestLimit } from "../supervised-limits.ts";
import { timingSafeEqual } from "node:crypto";

export const SCHEDULER_WORKER_MAX_RUNTIME_MS = 13 * 60 * 1000;
export const SCHEDULER_WORKER_LEASE_TTL_SECONDS = 17 * 60;
export const SCHEDULER_MAX_STAGE_TIMEOUT_MS = 60 * 1000;
export const SCHEDULER_MIN_STAGE_HEADROOM_MS = 3 * 60 * 1000;
export const SCHEDULER_EXECUTION_REQUEST_CAP = supervisedProviderRequestLimit;

export type SchedulerKickoffMetadata = {
  utcDate: string;
  triggerId: string;
  invocationId: string;
};

export function schedulerKickoffMetadata(now = new Date()): SchedulerKickoffMetadata {
  if (Number.isNaN(now.getTime())) throw new Error("SCHEDULER_INVALID_KICKOFF_TIME");
  const utcDate = now.toISOString().slice(0, 10);
  return { utcDate, triggerId: `supervised-candidates:${utcDate}`, invocationId: `horizai-supervised:${utcDate}` };
}

export function validateSchedulerKickoffMetadata(value: unknown): SchedulerKickoffMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("SCHEDULER_KICKOFF_METADATA_INVALID");
  const item = value as Record<string, unknown>;
  if (typeof item.utcDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.utcDate)) throw new Error("SCHEDULER_KICKOFF_DATE_INVALID");
  const canonicalDate = new Date(`${item.utcDate}T00:00:00.000Z`);
  const canonical = schedulerKickoffMetadata(canonicalDate);
  if (canonical.utcDate !== item.utcDate) throw new Error("SCHEDULER_KICKOFF_DATE_INVALID");
  if (item.triggerId !== canonical.triggerId || item.invocationId !== canonical.invocationId) throw new Error("SCHEDULER_KICKOFF_IDENTITY_INVALID");
  return canonical;
}

export function hasValidInternalSchedulerToken(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

export type OpenSupervisedAttempt = {
  attemptId: string;
  eventKey: string;
  pipelineRunId: string;
  attemptNumber: number;
  startedAt: string;
  completedAt: string | null;
  finalState: string | null;
  stopStage: string | null;
  stopReason: string | null;
  retryClass: string | null;
  countsTowardRetryLimit: boolean;
  nextEligibleAt: string | null;
  capacityResumeSnapshot: unknown | null;
  resumeDispatchCount: number;
  resumeCheckpointPresent: boolean | null;
};

export type ResumeFirstDecision =
  | { kind: "NEW_CANDIDATE" }
  | { kind: "RESUME_SAME_ATTEMPT"; attempt: OpenSupervisedAttempt }
  | { kind: "STOP"; reason: "MULTIPLE_OPEN_ATTEMPTS" | "ACTIVE_ATTEMPT_AMBIGUOUS" | "DEFERRED_ATTEMPT_INVALID" };

function isResumeEligibleShape(attempt: OpenSupervisedAttempt): boolean {
  return attempt.completedAt === null
    && attempt.finalState === null
    && typeof attempt.stopStage === "string"
    && ["verifier", "translator", "editor", "classifier", "ranker", "critic"].includes(attempt.stopStage)
    && ["PROVIDER_CAPACITY_EXHAUSTED", "WORKER_TIME_BUDGET_EXHAUSTED"].includes(attempt.stopReason ?? "")
    && attempt.retryClass === "NONE"
    && attempt.countsTowardRetryLimit === false
    && attempt.nextEligibleAt === null
    && attempt.capacityResumeSnapshot !== null
    && attempt.resumeDispatchCount === 0
    && attempt.resumeCheckpointPresent === false;
}

/** Any open attempt blocks discovery. Only one validated pre-dispatch defer can be resumed. */
export function chooseResumeFirstWork(input: {
  openAttempts: readonly OpenSupervisedAttempt[];
  validateDeferred: (attempt: OpenSupervisedAttempt) => boolean;
}): ResumeFirstDecision {
  if (input.openAttempts.length === 0) return { kind: "NEW_CANDIDATE" };
  if (input.openAttempts.length > 1) return { kind: "STOP", reason: "MULTIPLE_OPEN_ATTEMPTS" };
  const [attempt] = input.openAttempts;
  if (!attempt) return { kind: "STOP", reason: "ACTIVE_ATTEMPT_AMBIGUOUS" };
  if (!isResumeEligibleShape(attempt)) return { kind: "STOP", reason: "ACTIVE_ATTEMPT_AMBIGUOUS" };
  if (!input.validateDeferred(attempt)) return { kind: "STOP", reason: "DEFERRED_ATTEMPT_INVALID" };
  return { kind: "RESUME_SAME_ATTEMPT", attempt };
}

export function shouldStartExpensiveStage(input: { startedAtMs: number; nowMs: number; workerBudgetMs?: number; minHeadroomMs?: number }): boolean {
  const budget = input.workerBudgetMs ?? SCHEDULER_WORKER_MAX_RUNTIME_MS;
  const headroom = input.minHeadroomMs ?? SCHEDULER_MIN_STAGE_HEADROOM_MS;
  if (![input.startedAtMs, input.nowMs, budget, headroom].every(Number.isFinite) || budget <= 0 || headroom < 0) return false;
  return input.nowMs - input.startedAtMs + headroom < budget;
}

export function safeWorkerOutcomeCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(value)) return "TECHNICAL_FAILURE";
  return value;
}
