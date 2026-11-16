import type { Json } from "../../../../types/database.ts";
import type { PipelineRunResult } from "../pipeline-types.ts";
import { supervisedSchedulerOutcome, type SupervisedSchedulerOutcome } from "../supervised-run-outcome.ts";
import { isSafelyRejectedSupervisedAttempt } from "../supervised-throughput-policy.ts";

export const persistedSchedulerDecisionValues = [
  "PREFLIGHT",
  "COMPLETED",
  "BLOCKED_DUPLICATE_TRIGGER",
  "BLOCKED_RUN_ALREADY_ACTIVE",
  "BLOCKED_INSUFFICIENT_DAILY_BUDGET",
  "BLOCKED_PROVIDER_RATE_LIMIT",
  "BLOCKED_REVISION_REQUIRED",
  "BLOCKED_REJECTED",
  "FAILED",
] as const;

export type PersistedSchedulerDecision = (typeof persistedSchedulerDecisionValues)[number];

const persistedDecisionSet = new Set<string>(persistedSchedulerDecisionValues);

/** Converts descriptive pipeline outcomes to the compact enum enforced by migration 12. */
export function persistedSchedulerTerminal(input: { schedulerDecision: string; stopReason: string | null }): { schedulerDecision: PersistedSchedulerDecision; stopReason: string | null } {
  const { schedulerDecision, stopReason } = input;
  if (persistedDecisionSet.has(schedulerDecision)) return { schedulerDecision: schedulerDecision as PersistedSchedulerDecision, stopReason };

  const mapped: Record<string, { decision: PersistedSchedulerDecision; defaultReason?: string }> = {
    NO_ELIGIBLE_EXTRACTED_ITEMS: { decision: "COMPLETED" },
    WAITING_FOR_HUMAN_REVIEW: { decision: "COMPLETED" },
    CANDIDATE_NOT_VERIFIED: { decision: "COMPLETED" },
    CANDIDATE_REJECTED: { decision: "BLOCKED_REJECTED" },
    CANDIDATE_SAFELY_REJECTED: { decision: "BLOCKED_REJECTED" },
    CRITIC_BLOCKED: { decision: "BLOCKED_REJECTED" },
    STOPPED_CAPACITY: { decision: "BLOCKED_PROVIDER_RATE_LIMIT", defaultReason: "PROVIDER_CAPACITY_EXHAUSTED" },
    DEFERRED_PROVIDER_CAPACITY: { decision: "BLOCKED_PROVIDER_RATE_LIMIT", defaultReason: "PROVIDER_CAPACITY_EXHAUSTED" },
    BLOCKED_BUDGET: { decision: "BLOCKED_INSUFFICIENT_DAILY_BUDGET", defaultReason: "BLOCKED_INSUFFICIENT_DAILY_BUDGET" },
    TECHNICAL_FAILURE: { decision: "FAILED", defaultReason: "SUPERVISED_PIPELINE_FAILED" },
  };
  const mapping = mapped[schedulerDecision];
  if (!mapping) return { schedulerDecision: "FAILED", stopReason: stopReason ?? "UNSUPPORTED_SCHEDULER_TERMINAL_OUTCOME" };
  return { schedulerDecision: mapping.decision, stopReason: stopReason ?? mapping.defaultReason ?? schedulerDecision };
}

export type SchedulerExecutionFinishInput = {
  triggerId: string;
  ownerRunId: string;
  runStatus: "succeeded" | "failed" | "blocked";
  finalDecision: "allowed" | "blocked" | "failed";
  schedulerDecision: string;
  stopReason: string | null;
  pipelineRunId: string | null;
  eventAttempts: number;
  eventFinalStates: Json;
  requestsUsed: number;
  quotaUsed: number;
  quotaRemaining: number;
  durationMs: number;
  finishedAt: string;
};

export function summarizeSupervisedExecution(result: PipelineRunResult, outcome: SupervisedSchedulerOutcome): {
  attemptsStarted: number;
  attemptsRejectedSafely: number;
  attemptsTechnicalFailure: number;
  attemptsDeferred: number;
  reviewsCreated: number;
  providerRequests: number;
  finalOutcome: string;
  eventFinalStates: Json;
} {
  const attempts = result.eventResults.filter((event) => Boolean(event.attemptId));
  const eventFinalStates = attempts.map((event, index) => {
    const dispatched = Object.values(event.telemetry ?? {}).filter((stage) => stage.providerRequestsUsed > 0);
    const failureTelemetry = event.failure?.telemetry && event.failure.telemetry.providerRequestsUsed > 0 ? [event.failure.telemetry] : [];
    const accountingEntries = [...dispatched, ...failureTelemetry];
    const accountedRequests = accountingEntries.reduce((sum, stage) => sum + stage.providerRequestsUsed, 0);
    const tokenUsageKnown = accountedRequests === event.requestsUsed
      && accountingEntries.every((stage) => Number.isSafeInteger(stage.inputTokens) && Number.isSafeInteger(stage.outputTokens) && Number.isSafeInteger(stage.totalTokens));
    const inputTokens = tokenUsageKnown ? accountingEntries.reduce((sum, stage) => sum + (stage.inputTokens ?? 0), 0) : null;
    const outputTokens = tokenUsageKnown ? accountingEntries.reduce((sum, stage) => sum + (stage.outputTokens ?? 0), 0) : null;
    const totalTokens = tokenUsageKnown ? accountingEntries.reduce((sum, stage) => sum + (stage.totalTokens ?? 0), 0) : null;
    const terminalClass = isSafelyRejectedSupervisedAttempt(event) ? "SAFE_REJECTION"
      : event.finalState === "WAITING_FOR_HUMAN_REVIEW" ? "WAITING_FOR_HUMAN_REVIEW"
      : event.finalState === "DEFERRED_PROVIDER_CAPACITY" ? "DEFERRED_PROVIDER_CAPACITY"
      : event.finalState === "FAILED" || event.finalState === "BLOCKED" || event.finalState === "BLOCKED_INSUFFICIENT_DAILY_BUDGET" || event.finalState === "BLOCKED_REVISION_REQUIRED" || event.finalState === "BLOCKED_REVISION_LIMIT" ? "TECHNICAL_FAILURE"
      : "OTHER_TERMINAL";
    return {
      attemptSequence: index + 1,
      attemptId: event.attemptId ?? null,
      eventKey: event.eventKey,
      finalState: event.finalState,
      stopStage: event.stopStage,
      stopReason: event.stopReason,
      ...(event.persistenceFailure ? { persistenceFailure: event.persistenceFailure } : {}),
      terminalClass,
      providerRequests: event.requestsUsed,
      inputTokens,
      outputTokens,
      totalTokens,
      tokenUsageKnown,
      reviewCreated: event.finalState === "WAITING_FOR_HUMAN_REVIEW",
    };
  });
  return {
    attemptsStarted: attempts.length,
    attemptsRejectedSafely: eventFinalStates.filter((event) => event.terminalClass === "SAFE_REJECTION").length,
    attemptsTechnicalFailure: eventFinalStates.filter((event) => event.terminalClass === "TECHNICAL_FAILURE").length,
    attemptsDeferred: eventFinalStates.filter((event) => event.terminalClass === "DEFERRED_PROVIDER_CAPACITY").length,
    reviewsCreated: eventFinalStates.filter((event) => event.reviewCreated).length,
    providerRequests: result.providerRequestsUsed,
    finalOutcome: outcome.schedulerDecision,
    eventFinalStates: eventFinalStates as unknown as Json,
  };
}

function safeExecutionFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const match = /^(EVENT_ATTEMPT_[A-Z_]+)(?::([A-Z0-9]+))?$/.exec(message);
  return match ? `${match[1]}${match[2] ? `:${match[2]}` : ""}` : "SUPERVISED_EXECUTION_FAILED";
}

function unknownExecutionCounters(stopReason: string): Json {
  return [{
    terminalClass: "COUNTERS_UNKNOWN",
    finalState: "FAILED",
    stopReason,
    attemptId: null,
    eventKey: null,
    attemptsStarted: null,
    providerRequests: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    tokenUsageKnown: false,
    unknownCounters: ["attemptsStarted", "providerRequests", "inputTokens", "outputTokens", "totalTokens"],
  }];
}

/** Runs one supervised pipeline callback and calls the terminal finalizer exactly once. */
export async function runAndFinalizeSupervisedExecution(input: {
  triggerId: string;
  ownerRunId: string;
  startedAt: Date;
  pipelineRunId: () => string | null;
  execute: () => Promise<PipelineRunResult>;
  quotaUsed: () => number;
  quotaRemaining: () => number;
  finishExecution: (finish: SchedulerExecutionFinishInput) => Promise<boolean>;
  now?: () => Date;
}): Promise<{ result: PipelineRunResult; outcome: SupervisedSchedulerOutcome }> {
  const now = input.now ?? (() => new Date());
  let result: PipelineRunResult | null = null;
  let executionError: unknown;
  try {
    result = await input.execute();
  } catch (error) {
    executionError = error;
  }

  const outcome: SupervisedSchedulerOutcome = result
    ? supervisedSchedulerOutcome(result)
    : { runStatus: "failed", finalDecision: "failed", schedulerDecision: "TECHNICAL_FAILURE", stopReason: safeExecutionFailureReason(executionError) };
  const finishedAt = now();
  const telemetry = result ? summarizeSupervisedExecution(result, outcome) : null;
  let persisted = false;
  let finalizationError: unknown;
  try {
    persisted = await input.finishExecution({
      triggerId: input.triggerId,
      ownerRunId: input.ownerRunId,
      runStatus: outcome.runStatus,
      finalDecision: outcome.finalDecision,
      schedulerDecision: outcome.schedulerDecision,
      stopReason: outcome.stopReason,
      pipelineRunId: result?.runId ?? input.pipelineRunId(),
      eventAttempts: telemetry?.attemptsStarted ?? 0,
      eventFinalStates: telemetry?.eventFinalStates ?? unknownExecutionCounters(outcome.stopReason ?? "SUPERVISED_EXECUTION_FAILED"),
      requestsUsed: telemetry?.providerRequests ?? 0,
      quotaUsed: result?.providerRequestsUsed ?? input.quotaUsed(),
      quotaRemaining: Math.max(0, result?.quotaAfter ?? input.quotaRemaining()),
      durationMs: result ? Math.max(0, Date.parse(result.completedAt) - Date.parse(result.startedAt)) : Math.max(0, finishedAt.getTime() - input.startedAt.getTime()),
      finishedAt: finishedAt.toISOString(),
    });
    if (!persisted) finalizationError = new Error("SUPERVISED_DAILY_RUN_FINALIZE_NOT_OWNED");
  } catch (error) {
    finalizationError = error;
  }

  if (finalizationError) {
    if (executionError) throw new AggregateError([executionError, finalizationError], "SUPERVISED_EXECUTION_AND_FINALIZATION_FAILED");
    throw finalizationError;
  }
  if (executionError) throw executionError;
  if (!result) throw new Error("SUPERVISED_PIPELINE_RESULT_MISSING");
  return { result, outcome };
}
