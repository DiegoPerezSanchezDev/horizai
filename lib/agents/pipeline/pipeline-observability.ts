import type { AgentLogEntry, AgentLogger, AgentRunMetadata } from "../runtime/runtime-types.ts";
import type { PipelinePersistence, PipelineRunContext } from "./pipeline-types.ts";

const metadata = (run: PipelineRunContext): AgentRunMetadata => ({ agentName: "pipeline-orchestrator", agentVersion: "pipeline-v1", eventKey: null, pipelineRunId: run.runId, model: "orchestrator", dryRun: run.dryRun });

export function createLoggerPipelinePersistence(logger: AgentLogger): PipelinePersistence {
  let parentRunId: string | null = null;
  let parentRun: PipelineRunContext | null = null;
  return {
    async start(run) {
      parentRun = run;
      parentRunId = await logger.startRun(metadata(run), run.startedAt);
      return parentRunId;
    },
    async log(runId, entry) {
      if (!parentRun) return;
      await logger.log(runId, metadata(parentRun), entry);
    },
    async finish(runId, result) {
      if (!parentRun) return;
      await logger.finishRun(runId, metadata(parentRun), result.finalState === "FAILED" || result.finalState === "BLOCKED_BUDGET" ? "failed" : "succeeded", result.completedAt, {
        candidatesDiscovered: result.candidatesDiscovered,
        discoverySummary: result.discoverySummary ?? null,
        extractedItems: result.extractedItems,
        extractionSummary: result.extractionSummary,
        clusteredEvents: result.clusteredEvents,
        eventsAttempted: result.eventsAttempted,
        eventsPublished: result.eventsPublished,
        eventsDryRunReady: result.eventsDryRunReady,
        eventsSkipped: result.eventsSkipped,
        eventsFailed: result.eventsFailed,
        eventsBlocked: result.eventsBlocked,
        providerRequestsUsed: result.providerRequestsUsed,
        quotaBefore: result.quotaBefore,
        quotaAfter: result.quotaAfter,
      });
    },
  };
}

export async function safePipelineLog(persistence: PipelinePersistence | undefined, runId: string | null, entry: AgentLogEntry): Promise<void> {
  try { await persistence?.log(runId, entry); } catch { /* Logging failure is surfaced by the run result only when persistence itself fails. */ }
}
