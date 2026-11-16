import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSupabaseServerClient } from "../../../supabase/server-client.ts";
import { createProductionPipeline } from "../create-production-pipeline.ts";
import { createCapacityResumeRequestBudget } from "../supervised-request-cap-contract.ts";
import { SupabasePipelineEventAttemptRepository } from "../event-attempt-repository.ts";
import { parseCapacityResumeSnapshot, assessCapacityResume } from "../provider-capacity-resume.ts";
import { ProviderScopedDailyRequestBudget } from "../../runtime/request-budget.ts";
import { SupabaseAgentLogger } from "../../runtime/agent-logger.ts";
import {
  chooseResumeFirstWork,
  safeWorkerOutcomeCode,
  schedulerKickoffMetadata,
  shouldStartExpensiveStage,
  SCHEDULER_EXECUTION_REQUEST_CAP,
  SCHEDULER_MAX_STAGE_TIMEOUT_MS,
  SCHEDULER_MIN_STAGE_HEADROOM_MS,
  SCHEDULER_WORKER_MAX_RUNTIME_MS,
  validateSchedulerKickoffMetadata,
} from "./scheduler-control-policy.ts";
import { SupabaseSchedulerControlRepository } from "./scheduler-control-repository.ts";
import { startSchedulerLeaseHeartbeat } from "./scheduler-lease-heartbeat.ts";
import type { OpenSupervisedAttempt, SchedulerKickoffMetadata } from "./scheduler-control-policy.ts";

export type SchedulerExecutionSource = "github_actions" | "netlify" | "manual_cli";

export type SupervisedSchedulerInvocationResult = {
  statusCode: number;
  ok: boolean;
  outcome: string;
  executionSource: SchedulerExecutionSource;
};

function result(statusCode: number, ok: boolean, outcome: string, executionSource: SchedulerExecutionSource): SupervisedSchedulerInvocationResult {
  return { statusCode, ok, outcome, executionSource };
}

function resumeDecision(attempts: OpenSupervisedAttempt[]) {
  return chooseResumeFirstWork({
    openAttempts: attempts,
    validateDeferred: (attempt) => attempt.resumeDispatchCount === 0 && attempt.resumeCheckpointPresent === false,
  });
}

async function assessDeferred(attempt: OpenSupervisedAttempt, logger: SupabaseAgentLogger) {
  const snapshot = parseCapacityResumeSnapshot(attempt.capacityResumeSnapshot);
  if (snapshot.attemptId !== attempt.attemptId || snapshot.pipelineRunId !== attempt.pipelineRunId || snapshot.eventKey !== attempt.eventKey
    || snapshot.resumeStage !== attempt.stopStage) throw new Error("SCHEDULER_DEFERRED_ATTEMPT_IDENTITY_INVALID");

  // Resume reads the durable database snapshot and never trusts runner-local files.
  const durableCheckpointHashes = snapshot.checkpointSha256;
  const dates = new Set(Object.values(snapshot.providerAccounting).map((item) => {
    if (!item || !Number.isFinite(Date.parse(item.startedAt))) throw new Error("SCHEDULER_PROVIDER_ACCOUNTING_DATE_INVALID");
    return new Date(item.startedAt).toISOString().slice(0, 10);
  }));
  let unknownReservations = 0;
  for (const date of dates) unknownReservations += (await logger.getProviderDailyUsage("groq", date)).unknownTokenRequests;

  const assessment = assessCapacityResume(snapshot, {
    attempt: {
      attemptId: attempt.attemptId, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, startedAt: attempt.startedAt,
      completedAt: attempt.completedAt, finalState: attempt.finalState, stopStage: attempt.stopStage, stopReason: attempt.stopReason,
      countsTowardRetryLimit: attempt.countsTowardRetryLimit,
    },
    currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items,
    currentCheckpointSha256: durableCheckpointHashes, nextStageDispatchCount: attempt.resumeDispatchCount,
    nextStageCheckpointPresent: attempt.resumeCheckpointPresent === false,
    unresolvedProviderUsage: unknownReservations > 0,
    activeOwner: false,
    terminalEditorialRejection: snapshot.verification?.status === "rejected",
  });
  if (!assessment.valid) throw new Error("SCHEDULER_DEFERRED_ATTEMPT_INVALID");
  return { snapshot, assessment, unknownReservations };
}

function resultOutcome(resultValue: { eventResults: Array<{ finalState: string; stopStage: string | null; attemptId?: string }>; finalState: string }, requestBudget: ProviderScopedDailyRequestBudget) {
  const event = resultValue.eventResults[0];
  const usage = requestBudget.executionSnapshot();
  return {
    status: event?.finalState === "WAITING_FOR_HUMAN_REVIEW" ? "STOPPED" as const
      : event?.finalState?.startsWith("DEFERRED_") ? "STOPPED" as const
        : event?.finalState?.startsWith("BLOCKED") || event?.finalState === "FAILED" ? "STOPPED" as const : "COMPLETED" as const,
    outcomeCode: safeWorkerOutcomeCode(event?.finalState ?? resultValue.finalState),
    attemptId: event?.attemptId ?? null,
    currentStage: event?.stopStage ?? null,
    requestsUsed: usage.requests,
    requestsRemaining: usage.remaining,
  };
}

/**
 * Hosting-neutral scheduler core. Netlify and GitHub Actions are thin invocation
 * adapters; durable claim, resume-first policy, accounting, bounded execution,
 * terminal persistence, and lease release live here.
 */
export async function runSupervisedScheduledInvocation(input: {
  metadata: unknown;
  executionSource: SchedulerExecutionSource;
  now?: Date;
}): Promise<SupervisedSchedulerInvocationResult> {
  let metadata: SchedulerKickoffMetadata;
  try {
    metadata = validateSchedulerKickoffMetadata(input.metadata);
    const current = schedulerKickoffMetadata(input.now ?? new Date());
    if (metadata.utcDate !== current.utcDate) throw new Error("SCHEDULER_KICKOFF_DATE_STALE");
  } catch (error) {
    return result(400, false, safeWorkerOutcomeCode(error instanceof Error ? error.message : null), input.executionSource);
  }

  const startedAt = Date.now();
  const ownerId = randomUUID();
  const control = new SupabaseSchedulerControlRepository();
  let claim;
  try { claim = await control.claim({ metadata, ownerId, now: new Date() }); }
  catch { return result(503, false, "SCHEDULER_CONTROL_UNAVAILABLE", input.executionSource); }
  if (claim.status !== "ACQUIRED") return result(200, true, claim.status, input.executionSource);

  const heartbeat = startSchedulerLeaseHeartbeat(() => control.heartbeat({
    invocationId: metadata.invocationId, ownerId: claim.ownerId, fencingToken: claim.fencingToken,
  }));
  let workMode: "RESUME_SAME_ATTEMPT" | "NEW_CANDIDATE" | null = null;
  let attemptId: string | null = null;
  let currentStage: string | null = null;
  let resumeGeneration: number | null = null;
  let requestsUsed = 0;
  let requestsRemaining: number | null = SCHEDULER_EXECUTION_REQUEST_CAP;
  let outcomeCode = "TECHNICAL_FAILURE";
  let status: "COMPLETED" | "STOPPED" | "FAILED" = "FAILED";
  try {
    const supabase = createSupabaseServerClient();
    const logger = new SupabaseAgentLogger(supabase);
    const decision = resumeDecision(await control.listOpenAttempts());
    if (heartbeat.isLost()) {
      outcomeCode = "SCHEDULER_LEASE_LOST";
      status = "STOPPED";
    } else if (decision.kind === "STOP") {
      outcomeCode = decision.reason;
      status = "STOPPED";
    } else {
      let snapshot;
      let resumeEvidence;
      if (decision.kind === "RESUME_SAME_ATTEMPT") {
        workMode = "RESUME_SAME_ATTEMPT";
        const inspected = await assessDeferred(decision.attempt, logger);
        snapshot = inspected.snapshot;
        resumeEvidence = {
          attempt: {
            attemptId: decision.attempt.attemptId, eventKey: decision.attempt.eventKey, pipelineRunId: decision.attempt.pipelineRunId,
            startedAt: decision.attempt.startedAt, completedAt: decision.attempt.completedAt, finalState: decision.attempt.finalState,
            stopStage: decision.attempt.stopStage, stopReason: decision.attempt.stopReason, countsTowardRetryLimit: decision.attempt.countsTowardRetryLimit,
          },
          currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items,
          currentCheckpointSha256: snapshot.checkpointSha256, nextStageDispatchCount: decision.attempt.resumeDispatchCount,
          nextStageCheckpointPresent: decision.attempt.resumeCheckpointPresent === false,
          unresolvedProviderUsage: inspected.unknownReservations > 0,
          activeOwner: false,
          terminalEditorialRejection: snapshot.verification?.status === "rejected",
        };
        attemptId = decision.attempt.attemptId;
        currentStage = snapshot.resumeStage;
        resumeGeneration = snapshot.resumeGeneration;
      } else {
        workMode = "NEW_CANDIDATE";
      }

      const requestBudget = snapshot
        ? createCapacityResumeRequestBudget(snapshot)
        : new ProviderScopedDailyRequestBudget(() => new Date(), SCHEDULER_EXECUTION_REQUEST_CAP);
      const workerConfig = {
        mode: "supervised" as const, hours: 48, limit: 3, dryRun: true, publish: false,
        trigger: "scheduled" as const, automaticRevision: false, maxRevisionAttempts: 1,
      };
      const localRoot = join(tmpdir(), "horizai-scheduler", metadata.utcDate);
      const pipeline = createProductionPipeline({
        supabase, logger, requestBudget, runId: claim.ownerId,
        attemptRegistry: new SupabasePipelineEventAttemptRepository(supabase, { schedulerM40: true }),
        config: workerConfig,
        checkpointRoot: join(localRoot, "checkpoints"), humanReviewArtifactRoot: join(localRoot, "human-review"),
        shouldStartSemanticStage: () => !heartbeat.isLost()
          && Date.now() - startedAt + SCHEDULER_MIN_STAGE_HEADROOM_MS < SCHEDULER_WORKER_MAX_RUNTIME_MS,
      });
      if (Object.values(pipeline.configs).some((agent) => agent.timeoutMs > SCHEDULER_MAX_STAGE_TIMEOUT_MS)) {
        throw new Error("SCHEDULER_AGENT_TIMEOUT_EXCEEDS_WORKER_CONTRACT");
      }
      await pipeline.preflight();

      if (heartbeat.isLost()) {
        status = "STOPPED";
        outcomeCode = "SCHEDULER_LEASE_LOST";
        requestsUsed = requestBudget.executionSnapshot().requests;
        requestsRemaining = requestBudget.executionSnapshot().remaining;
      } else if (snapshot && resumeEvidence) {
        const pipelineResult = await pipeline.orchestrator.resumeCapacityDeferred({ snapshot, evidence: resumeEvidence });
        const usage = requestBudget.executionSnapshot();
        requestsUsed = usage.requests;
        requestsRemaining = usage.remaining;
        outcomeCode = safeWorkerOutcomeCode(pipelineResult.finalState);
        status = pipelineResult.finalState === "WAITING_FOR_HUMAN_REVIEW" || pipelineResult.finalState.startsWith("DEFERRED_") || pipelineResult.finalState.startsWith("BLOCKED") || pipelineResult.finalState === "FAILED" ? "STOPPED" : "COMPLETED";
        attemptId = pipelineResult.attemptId ?? attemptId;
        currentStage = pipelineResult.stopStage ?? (pipelineResult.finalState === "WAITING_FOR_HUMAN_REVIEW" ? "human_review" : currentStage);
        resumeGeneration = snapshot.resumeGeneration + (pipelineResult.finalState.startsWith("DEFERRED_") ? 1 : 0);
      } else if (shouldStartExpensiveStage({ startedAtMs: startedAt, nowMs: Date.now() })) {
        const pipelineResult = await pipeline.orchestrator.run();
        const summary = resultOutcome(pipelineResult, requestBudget);
        status = summary.status;
        outcomeCode = summary.outcomeCode;
        attemptId = summary.attemptId;
        currentStage = summary.currentStage;
        requestsUsed = summary.requestsUsed;
        requestsRemaining = summary.requestsRemaining;
      } else {
        status = "STOPPED";
        outcomeCode = "WORKER_TIME_BUDGET_EXHAUSTED";
        requestsUsed = requestBudget.executionSnapshot().requests;
        requestsRemaining = requestBudget.executionSnapshot().remaining;
      }
    }
  } catch (error) {
    outcomeCode = safeWorkerOutcomeCode(error instanceof Error ? error.message : null);
    status = "FAILED";
  }

  heartbeat.stop();
  try {
    const finalized = await control.finish({
      invocationId: metadata.invocationId, ownerId: claim.ownerId, fencingToken: claim.fencingToken,
      status, outcomeCode, workMode, attemptId, currentStage, resumeGeneration, requestsUsed, requestsRemaining,
      durationMs: Date.now() - startedAt,
    });
    return finalized
      ? result(200, true, outcomeCode, input.executionSource)
      : result(503, false, "SCHEDULER_FINALIZATION_UNCONFIRMED", input.executionSource);
  } catch {
    // A redelivery cannot replay work: the UTC invocation was durably claimed first.
    return result(503, false, "SCHEDULER_FINALIZATION_UNCONFIRMED", input.executionSource);
  }
}
