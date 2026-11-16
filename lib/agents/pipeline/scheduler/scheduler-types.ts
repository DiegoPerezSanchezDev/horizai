import type { ProviderPipelineStage } from "../pipeline-budget.ts";

export const schedulerSlots = ["morning", "afternoon", "night"] as const;
export type SchedulerSlot = (typeof schedulerSlots)[number];

export type SchedulerStopReason =
  | "BLOCKED_INSUFFICIENT_DAILY_BUDGET"
  | "BLOCKED_RUN_ALREADY_ACTIVE"
  | "BLOCKED_DUPLICATE_TRIGGER"
  | "BLOCKED_PROVIDER_RATE_LIMIT"
  | "BLOCKED_REVISION_REQUIRED"
  | "BLOCKED_REJECTED"
  | "NO_ELIGIBLE_EVENTS"
  | "MAX_EVENTS_PER_RUN"
  | "BUDGET_EXHAUSTED"
  | "EVENT_FAILED_CLOSED"
  | null;

export type SchedulerBlockReason = Exclude<SchedulerStopReason, null>;

export type SchedulerPolicyConfig = {
  schedulingTimezone: string;
  quotaResetTimezone: "UTC";
  maxEventsPerRun: number;
  hours: number;
  dryRun: true;
  publish: false;
  automaticRevision: false;
  maxRevisionAttempts: 1;
  leaseTtlMs: number;
};

export type SchedulerQuotaSnapshot = {
  /** The scheduler admission ledger is Groq-only until provider routing is activated. */
  provider?: "groq";
  requestDateUtc: string;
  /** Groq request hard cap, never combined with Cloudflare Neurons. */
  limit: number;
  /** Groq new-event soft admission ceiling; defaults to limit for legacy fixtures. */
  admissionLimit?: number;
  used: number;
  remaining: number;
};

export type ScheduledRunPlan = {
  triggerId: string;
  runId: string;
  scheduledAt: string;
  slot: SchedulerSlot;
  timezone: string;
  requestDateUtc: string;
  quotaProvider: "groq";
  quotaLimit: number;
  quotaAdmissionLimit: number;
  quotaUsed: number;
  quotaRemaining: number;
  worstCasePerEvent: number;
  maxEventsPerRun: number;
  eventsAllowedByBudget: number;
  plannedEventLimit: number;
  automaticRevision: false;
  dryRun: true;
  publish: false;
  hours: number;
  allowed: boolean;
  blockReason: SchedulerBlockReason | null;
};

export type SchedulerEventStatus =
  | "new"
  | "success"
  | "published"
  | "failed"
  | "skipped_verification_insufficient"
  | "blocked_revision_required"
  | "blocked_rejected";

export type SchedulerEventCandidate = {
  eventKey: string;
  publishedAt: string | null;
  status: SchedulerEventStatus;
  attemptedRunId?: string | null;
  reconsiderationAllowed?: boolean;
  retryAllowed?: boolean;
};

export type SchedulerEligibilityReason =
  | "ELIGIBLE"
  | "EVENT_ALREADY_COMPLETED"
  | "EVENT_ALREADY_PUBLISHED"
  | "EVENT_FAILED_NO_IMMEDIATE_RETRY"
  | "SKIPPED_RECONSIDERATION_UNSUPPORTED"
  | "REVISION_REQUIRED_NOT_NORMAL_EVENT"
  | "REJECTED_NOT_NORMAL_EVENT";

export type SchedulerEventEligibility = {
  eligible: boolean;
  reason: SchedulerEligibilityReason;
};

export type SchedulerLease = {
  ownerRunId: string;
  acquiredAt: string;
  expiresAt: string;
};

export type SchedulerLeaseAcquireResult =
  | { status: "acquired"; lease: SchedulerLease }
  | { status: "expired"; lease: SchedulerLease }
  | { status: "busy"; lease: SchedulerLease };

export type SchedulerLeaseReleaseResult =
  | { status: "released"; lease: SchedulerLease }
  | { status: "rejected"; lease: SchedulerLease | null };

export type SchedulerLeaseRepository = {
  acquire(input: { ownerRunId: string; now: Date; ttlMs: number }): Promise<SchedulerLeaseAcquireResult>;
  release(input: { ownerRunId: string }): Promise<SchedulerLeaseReleaseResult>;
};

export type SchedulerLeaseOutcome = "acquired" | "expired" | "busy" | "released" | "rejected";

export type SchedulerEventAttempt = {
  eventKey: string;
  status: "completed" | "skipped" | "blocked" | "failed";
  requestsUsed: number;
  reason: string | null;
};

export type SchedulerRunResult = {
  triggerId: string;
  scheduledAt: string;
  slot: SchedulerSlot;
  runId: string;
  leaseOutcome: SchedulerLeaseOutcome;
  quotaBefore: SchedulerQuotaSnapshot;
  quotaAfter: SchedulerQuotaSnapshot;
  eventAttempts: SchedulerEventAttempt[];
  completed: number;
  skipped: number;
  blocked: number;
  failed: number;
  requestsUsed: number;
  stopReason: SchedulerStopReason;
  nextEligibleSlot: SchedulerSlot | null;
  pipelineInvoked?: boolean;
  pipelineRunId?: string | null;
  selectedEventKey?: string | null;
  finalEventState?: string | null;
  schedulerDecision?: string;
  leaseReleased?: boolean;
  durationMs?: number;
};

export const schedulerObservationSteps = [
  "SCHEDULER_TRIGGER_RECEIVED",
  "SCHEDULER_LEASE_ACQUIRED",
  "SCHEDULER_BLOCKED_ACTIVE_RUN",
  "SCHEDULER_BUDGET_CHECK",
  "SCHEDULED_RUN_STARTED",
  "EVENT_ATTEMPT_STARTED",
  "EVENT_ATTEMPT_COMPLETED",
  "SCHEDULED_RUN_STOPPED",
  "SCHEDULER_LEASE_RELEASED",
] as const;

export type SchedulerObservationStep = (typeof schedulerObservationSteps)[number];

export type SchedulerRevisionAwareness = {
  automaticRevision: false;
  knownRevisionStages: ProviderPipelineStage[];
};
