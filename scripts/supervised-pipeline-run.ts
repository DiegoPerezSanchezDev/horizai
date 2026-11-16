import { randomUUID } from "node:crypto";
import { buildPipelinePublicationPayload } from "../lib/agents/publisher/publication-payload.ts";
import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { SupabaseSchedulerRepository } from "../lib/agents/pipeline/scheduler/scheduler-repository.ts";
import { SupabaseSchedulerControlRepository } from "../lib/agents/pipeline/scheduler/scheduler-control-repository.ts";
import { chooseResumeFirstWork, safeWorkerOutcomeCode, schedulerKickoffMetadata, shouldStartExpensiveStage, SCHEDULER_EXECUTION_REQUEST_CAP, SCHEDULER_MAX_STAGE_TIMEOUT_MS, SCHEDULER_MIN_STAGE_HEADROOM_MS, SCHEDULER_WORKER_LEASE_TTL_SECONDS } from "../lib/agents/pipeline/scheduler/scheduler-control-policy.ts";
import { startSchedulerLeaseHeartbeat } from "../lib/agents/pipeline/scheduler/scheduler-lease-heartbeat.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { assertSupervisedCandidateAdmission, dailySupervisedCandidateLimit } from "../lib/agents/publisher/human-review-policy.ts";
import { canonicalSupervisedRunCommand, parseSupervisedRunArgs } from "../lib/agents/pipeline/supervised-run-cli.ts";
import { runAndFinalizeSupervisedExecution } from "../lib/agents/pipeline/scheduler/scheduler-terminal-contract.ts";
import { SUPERVISED_EVENT_ATTEMPT_LIMIT, SUPERVISED_PROVIDER_REQUEST_LIMIT } from "../lib/agents/pipeline/supervised-throughput-policy.ts";
import { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";

function utcDate(date: Date): string { return date.toISOString().slice(0, 10); }

async function main(): Promise<void> {
  if (parseSupervisedRunArgs(process.argv.slice(2)) === "help") {
    console.log(canonicalSupervisedRunCommand);
    return;
  }
  const supabase = createSupabaseServerClient();
  const scheduler = new SupabaseSchedulerRepository(supabase);
  const control = new SupabaseSchedulerControlRepository(supabase);
  const now = new Date();
  const requestDateUtc = utcDate(now);
  const metadata = schedulerKickoffMetadata(now);
  const runCandidateLimit = SUPERVISED_EVENT_ATTEMPT_LIMIT;
  assertSupervisedCandidateAdmission(0, runCandidateLimit);
  const ownerRunId = randomUUID();
  const openBeforeClaim = await control.listOpenAttempts();
  if (openBeforeClaim.length > 0) throw new Error("SUPERVISED_OPEN_ATTEMPT_REQUIRES_SCHEDULER_RESUME_WORKER");
  const claim = await control.claim({ metadata, ownerId: ownerRunId, now });
  if (claim.status !== "ACQUIRED") throw new Error(`SUPERVISED_GLOBAL_LEASE:${claim.status}`);

  const heartbeat = startSchedulerLeaseHeartbeat(() => control.heartbeat({
    invocationId: metadata.invocationId, ownerId: claim.ownerId, fencingToken: claim.fencingToken,
  }));
  const triggerId = metadata.triggerId;
  let legacyLeaseAcquired = false;
  let controlStatus: "COMPLETED" | "STOPPED" | "FAILED" = "FAILED";
  let outcomeCode = "TECHNICAL_FAILURE";
  let workMode: "NEW_CANDIDATE" | null = null;
  let attemptId: string | null = null;
  let currentStage: string | null = null;
  let requestsUsed = 0;
  let requestsRemaining: number | null = SCHEDULER_EXECUTION_REQUEST_CAP;
  let requestBudget: ProviderScopedDailyRequestBudget | undefined;

  try {
    const lease = await scheduler.acquire({
      triggerId,
      ownerRunId,
      invocationType: "manual",
      scheduleDateUtc: requestDateUtc,
      slot: "morning",
      schedulingTimezone: "UTC",
      scheduledAt: now.toISOString(),
      requestDateUtc,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + SCHEDULER_WORKER_LEASE_TTL_SECONDS * 1000).toISOString(),
      quotaUsed: 0,
      quotaRemaining: 0,
      maxEventsPerRun: runCandidateLimit,
      automaticRevision: false,
      dryRun: true,
      publish: false,
    });
    if (!(lease.status === "acquired" || lease.status === "expired") || lease.ownerRunId !== ownerRunId) {
      controlStatus = "STOPPED";
      outcomeCode = `DAILY_TRIGGER_${lease.status.toUpperCase()}`;
      throw new Error(`SUPERVISED_DAILY_CANDIDATE_LIMIT:${lease.status}`);
    }
    legacyLeaseAcquired = true;
    const openAfterClaim = await control.listOpenAttempts();
    const decision = chooseResumeFirstWork({ openAttempts: openAfterClaim, validateDeferred: () => true });
    if (heartbeat.isLost()) throw new Error("SCHEDULER_LEASE_LOST");
    if (decision.kind !== "NEW_CANDIDATE") {
      controlStatus = "STOPPED";
      outcomeCode = decision.kind === "STOP" ? decision.reason : "DEFERRED_ATTEMPT_REQUIRES_RESUME";
      throw new Error("SUPERVISED_OPEN_ATTEMPT_REQUIRES_SCHEDULER_RESUME_WORKER");
    }
    const pipelineRunId = randomUUID();
    let pipelineRunStarted = false;
    let preflight: Awaited<ReturnType<ReturnType<typeof createProductionPipeline>["preflight"]>> | undefined;
    const finalizedExecution = await runAndFinalizeSupervisedExecution({
      triggerId,
      ownerRunId,
      startedAt: now,
      pipelineRunId: () => pipelineRunStarted ? pipelineRunId : null,
      quotaUsed: () => 0,
      quotaRemaining: () => preflight?.quotaRemaining ?? 0,
      finishExecution: (input) => scheduler.finishExecution(input),
      execute: async () => {
        requestBudget = new ProviderScopedDailyRequestBudget(() => new Date(), SUPERVISED_PROVIDER_REQUEST_LIMIT);
        const pipeline = createProductionPipeline({
          supabase,
          requestBudget,
          runId: pipelineRunId,
          attemptRegistry: new SupabasePipelineEventAttemptRepository(supabase, { schedulerM40: true }),
          shouldStartSemanticStage: () => !heartbeat.isLost()
            && shouldStartExpensiveStage({ startedAtMs: now.getTime(), nowMs: Date.now(), minHeadroomMs: SCHEDULER_MIN_STAGE_HEADROOM_MS }),
          persistTraceability: true,
          publicationPayloadFactory: buildPipelinePublicationPayload,
          config: {
            mode: "supervised",
            hours: 24,
            limit: runCandidateLimit,
            dryRun: true,
            publish: false,
            trigger: "manual",
            automaticRevision: false,
            maxRevisionAttempts: 1,
          },
        });
        if (Object.values(pipeline.configs).some((agent) => agent.timeoutMs > SCHEDULER_MAX_STAGE_TIMEOUT_MS)) throw new Error("SCHEDULER_AGENT_TIMEOUT_EXCEEDS_WORKER_CONTRACT");
        preflight = await pipeline.preflight();
        if (heartbeat.isLost()) throw new Error("SCHEDULER_LEASE_LOST");
        if (preflight.provider.toLowerCase() !== "groq") throw new Error("SUPERVISED_REQUIRES_GROQ_PRIMARY_PROVIDER");
        if (preflight.maxRetries && Object.values(preflight.maxRetries).some((retries) => retries !== 0)) throw new Error("SUPERVISED_REQUIRES_ZERO_PROVIDER_RETRIES");
        if (preflight.allowPaidFallback) throw new Error("SUPERVISED_REQUIRES_NO_PAID_FALLBACK");
        if (preflight.allowProviderPacingWait) throw new Error("SUPERVISED_REQUIRES_CAPACITY_DEFER_WITHOUT_IN_RUN_WAIT");
        pipelineRunStarted = true;
        workMode = "NEW_CANDIDATE";
        return pipeline.orchestrator.run();
      },
    });
    const { result, outcome: schedulerOutcome } = finalizedExecution;
    if (!preflight) throw new Error("SUPERVISED_PREFLIGHT_RESULT_MISSING");
    const verifiedPreflight = preflight;
    const usage = requestBudget?.executionSnapshot();
    requestsUsed = usage?.requests ?? result.providerRequestsUsed;
    requestsRemaining = usage?.remaining ?? Math.max(0, SCHEDULER_EXECUTION_REQUEST_CAP - requestsUsed);
    controlStatus = schedulerOutcome.runStatus === "succeeded" ? "COMPLETED" : schedulerOutcome.runStatus === "blocked" ? "STOPPED" : "FAILED";
    outcomeCode = safeWorkerOutcomeCode(schedulerOutcome.stopReason ?? schedulerOutcome.schedulerDecision);
    const terminalEvent = result.eventResults.find((event) => Boolean(event.attemptId));
    attemptId = terminalEvent?.attemptId ?? null;
    currentStage = terminalEvent?.stopStage ?? (terminalEvent?.finalState === "WAITING_FOR_HUMAN_REVIEW" ? "human_review" : null);
    console.log(JSON.stringify({
      mode: "supervised",
      scheduler: "manual invocation; recurring schedule disabled",
      candidatesAdmittedToday: result.eventsAttempted,
      candidateLimitPerUtcDay: dailySupervisedCandidateLimit,
      candidateLimitThisRun: runCandidateLimit,
      eventsAttempted: result.eventsAttempted,
      eventsAwaitingHumanReview: result.eventsAwaitingHumanReview,
      eventsPublished: result.eventsPublished,
      providerRequestsUsed: result.providerRequestsUsed,
      schedulerDecision: schedulerOutcome.schedulerDecision,
      schedulerRunStatus: schedulerOutcome.runStatus,
      schedulerFinalDecision: schedulerOutcome.finalDecision,
      automaticRevision: false,
      maxRetries: verifiedPreflight.maxRetries,
      allowPaidFallback: verifiedPreflight.allowPaidFallback,
      allowProviderPacingWait: verifiedPreflight.allowProviderPacingWait,
      result,
  }, null, 2));
  } catch (error) {
    if (controlStatus === "FAILED") {
      controlStatus = heartbeat.isLost() ? "STOPPED" : "FAILED";
      outcomeCode = safeWorkerOutcomeCode(heartbeat.isLost() ? "SCHEDULER_LEASE_LOST" : error instanceof Error ? error.message : null);
    }
    const usage = requestBudget?.executionSnapshot();
    requestsUsed = usage?.requests ?? requestsUsed;
    requestsRemaining = usage?.remaining ?? requestsRemaining;
    throw error;
  } finally {
    heartbeat.stop();
    if (legacyLeaseAcquired) await scheduler.release({ triggerId, ownerRunId, releasedAt: new Date().toISOString() }).catch(() => false);
    const finalized = await control.finish({ invocationId: metadata.invocationId, ownerId: claim.ownerId, fencingToken: claim.fencingToken,
      status: controlStatus, outcomeCode, workMode, attemptId, currentStage, resumeGeneration: null, requestsUsed,
      requestsRemaining, durationMs: Date.now() - now.getTime() });
    if (!finalized) throw new Error("SCHEDULER_CONTROL_FINALIZATION_UNCONFIRMED");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "SUPERVISED_PIPELINE_FAILED";
  console.error(message);
  process.exitCode = 1;
});
