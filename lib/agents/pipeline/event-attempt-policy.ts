import { extractionEvidenceInsufficient } from "../extraction/evidence-quality.ts";

export const pipelineAttemptFinalStates = [
  "READY_FOR_PUBLICATION",
  "WAITING_FOR_HUMAN_REVIEW",
  "REVISION_REQUIRED",
  "REJECTED",
  "VERIFICATION_INSUFFICIENT",
  "TECHNICAL_FAILURE",
  "PROVIDER_RATE_LIMIT",
  "CANCELLED",
  "ABORTED",
] as const;
export type PipelineAttemptFinalState = (typeof pipelineAttemptFinalStates)[number];

export const pipelineRetryClasses = ["NONE", "TECHNICAL_FAILURE", "PROVIDER_RATE_LIMIT", "REVISION_REQUIRED", "REJECTED", "VERIFICATION_INSUFFICIENT", "CANCELLED"] as const;
export type PipelineRetryClass = (typeof pipelineRetryClasses)[number];

export type PipelineEventAttempt = {
  id: string;
  eventKey: string;
  pipelineRunId: string;
  attemptNumber: number;
  startedAt: string;
  completedAt: string | null;
  finalState: PipelineAttemptFinalState | null;
  stopStage: string | null;
  stopReason: string | null;
  retryClass: PipelineRetryClass;
  countsTowardRetryLimit: boolean;
  nextEligibleAt: string | null;
  createdAt: string;
  capacityResumeSnapshot?: import("../../../types/database.ts").Json | null;
};

export type Eligibility =
  | { eligible: true; reason: "NEVER_ATTEMPTED" | "STALE_ACTIVE" | "STALE_ATTEMPT_RECOVERY" | "RATE_LIMIT_RETRY_ELIGIBLE" }
  | { eligible: false; reason: "ACTIVE" | "RESUME_REQUIRED" | "COOLDOWN" | "QUARANTINED" | "PERMANENT_OUTCOME" | "ALREADY_REGISTERED" };

export function nextUtcPeriodStart(now: Date): string {
  const next = new Date(now);
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function isStale(attempt: PipelineEventAttempt, now: Date, staleAfterMs: number): boolean {
  return attempt.completedAt === null && Date.parse(attempt.startedAt) + staleAfterMs <= now.getTime();
}

function isRetryableStaleAttemptRecovery(attempt: PipelineEventAttempt): boolean {
  return attempt.finalState === "ABORTED"
    && attempt.stopStage === "attempt_registry"
    && attempt.stopReason === "STALE_ATTEMPT_RECOVERED"
    && attempt.retryClass === "TECHNICAL_FAILURE"
    && !attempt.countsTowardRetryLimit
    && typeof attempt.nextEligibleAt === "string"
    && Number.isFinite(Date.parse(attempt.nextEligibleAt));
}

export function evaluateNormalEligibility(attempts: readonly PipelineEventAttempt[], now = new Date(), staleAfterMs = 60 * 60 * 1000): Eligibility {
  const pendingCapacityResume = attempts.find((attempt) => attempt.completedAt === null
    && attempt.finalState === null
    && attempt.stopStage !== null
    && (attempt.stopReason === "PROVIDER_CAPACITY_EXHAUSTED" || attempt.stopReason === "WORKER_TIME_BUDGET_EXHAUSTED" || attempt.stopReason?.startsWith("CAPACITY_RESUME_CLAIMED:") === true));
  if (pendingCapacityResume) {
    return pendingCapacityResume.stopReason === "PROVIDER_CAPACITY_EXHAUSTED" || pendingCapacityResume.stopReason === "WORKER_TIME_BUDGET_EXHAUSTED"
      ? { eligible: false, reason: "RESUME_REQUIRED" }
      : { eligible: false, reason: "ACTIVE" };
  }
  if (attempts.some((attempt) => attempt.completedAt === null && !isStale(attempt, now, staleAfterMs))) return { eligible: false, reason: "ACTIVE" };
  const completed = attempts.filter((attempt) => attempt.completedAt !== null);
  const aborted = completed.filter((attempt) => attempt.finalState === "ABORTED");
  if (aborted.some((attempt) => !isRetryableStaleAttemptRecovery(attempt))) return { eligible: false, reason: "PERMANENT_OUTCOME" };
  if (aborted.some((attempt) => Date.parse(attempt.nextEligibleAt!) > now.getTime())) return { eligible: false, reason: "COOLDOWN" };
  if (completed.some((attempt) => ["READY_FOR_PUBLICATION", "WAITING_FOR_HUMAN_REVIEW", "REVISION_REQUIRED", "REJECTED", "VERIFICATION_INSUFFICIENT"].includes(attempt.finalState ?? ""))) return { eligible: false, reason: "PERMANENT_OUTCOME" };
  const technical = completed.filter((attempt) => attempt.finalState === "TECHNICAL_FAILURE" && attempt.countsTowardRetryLimit);
  if (technical.length >= 2) return { eligible: false, reason: "QUARANTINED" };
  const latestTechnical = technical.at(-1);
  if (latestTechnical?.nextEligibleAt && Date.parse(latestTechnical.nextEligibleAt) > now.getTime()) return { eligible: false, reason: "COOLDOWN" };
  if (completed.some((attempt) => attempt.finalState === "PROVIDER_RATE_LIMIT")) return { eligible: true, reason: "RATE_LIMIT_RETRY_ELIGIBLE" };
  if (attempts.some((attempt) => isStale(attempt, now, staleAfterMs))) return { eligible: true, reason: "STALE_ACTIVE" };
  if (aborted.some(isRetryableStaleAttemptRecovery)) return { eligible: true, reason: "STALE_ATTEMPT_RECOVERY" };
  return { eligible: true, reason: "NEVER_ATTEMPTED" };
}

export function attemptOutcomeFromPipelineResult(result: { finalState: string; stopStage: string | null; stopReason: string | null; failure?: { errorCode: string; httpStatus?: number | null; telemetry?: { status?: string; providerHttpStatus?: number | null; errorCategory?: string | null } } }, startedAt: Date): { finalState: PipelineAttemptFinalState; stopStage: string | null; stopReason: string | null; retryClass: PipelineRetryClass; countsTowardRetryLimit: boolean; nextEligibleAt: string | null } {
  if (result.finalState === "READY_FOR_PUBLICATION_DRY_RUN" || result.finalState === "SUCCESS") return { finalState: "READY_FOR_PUBLICATION", stopStage: null, stopReason: null, retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null };
  if (result.finalState === "WAITING_FOR_HUMAN_REVIEW") return { finalState: "WAITING_FOR_HUMAN_REVIEW", stopStage: "human_review", stopReason: "HUMAN_REVIEW_PENDING", retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null };
  if (result.finalState === "BLOCKED_REVISION_REQUIRED") return { finalState: "REVISION_REQUIRED", stopStage: result.stopStage, stopReason: result.stopReason, retryClass: "REVISION_REQUIRED", countsTowardRetryLimit: false, nextEligibleAt: null };
  if (result.finalState === "BLOCKED_REJECTED" || result.stopReason === "VERIFICATION_REJECTED" || result.stopReason === "EDITOR_GROUNDING_REJECTED" || result.stopReason === extractionEvidenceInsufficient) return { finalState: "REJECTED", stopStage: result.stopStage, stopReason: result.stopReason, retryClass: "REJECTED", countsTowardRetryLimit: false, nextEligibleAt: null };
  if (result.stopReason === "SKIPPED_VERIFICATION_INSUFFICIENT") return { finalState: "VERIFICATION_INSUFFICIENT", stopStage: result.stopStage, stopReason: result.stopReason, retryClass: "VERIFICATION_INSUFFICIENT", countsTowardRetryLimit: false, nextEligibleAt: null };
  const providerRateLimit = result.failure?.httpStatus === 429
    || result.failure?.telemetry?.errorCategory === "RATE_LIMIT"
    || result.failure?.telemetry?.providerHttpStatus === 429
    || result.failure?.telemetry?.status === "FREE_TIER_LIMIT_REACHED"
    || result.failure?.errorCode === "FREE_TIER_LIMIT_REACHED"
    || result.stopReason === "FREE_TIER_LIMIT_REACHED"
    || result.failure?.errorCode === "PROVIDER_RATE_LIMIT";
  if (providerRateLimit) return { finalState: "PROVIDER_RATE_LIMIT", stopStage: result.stopStage, stopReason: "PROVIDER_RATE_LIMIT", retryClass: "PROVIDER_RATE_LIMIT", countsTowardRetryLimit: false, nextEligibleAt: null };
  return { finalState: "TECHNICAL_FAILURE", stopStage: result.stopStage, stopReason: result.stopReason, retryClass: "TECHNICAL_FAILURE", countsTowardRetryLimit: true, nextEligibleAt: nextUtcPeriodStart(startedAt) };
}
