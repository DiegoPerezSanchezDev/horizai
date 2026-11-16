import { randomUUID } from "node:crypto";
import { executeScheduledPipeline } from "../lib/agents/pipeline/scheduler/scheduler-execution.ts";

if (!process.argv.includes("--confirm-test")) {
  console.error("Refusing scheduler execute: pass --confirm-test for the isolated test namespace");
  process.exitCode = 1;
} else if (!process.env.SCHEDULER_TRIGGER_SECRET?.trim()) {
  console.error("Refusing scheduler execute: SCHEDULER_TRIGGER_SECRET is not configured");
  process.exitCode = 1;
} else {
  executeScheduledPipeline({
    mode: "execute",
    authorized: true,
    testNamespace: `test:scheduler-execute:${randomUUID()}`,
    hours: 48,
  }).then((result) => {
    console.log(JSON.stringify({
      schedulerTrigger: "PASS",
      triggerId: result.triggerId,
      slot: result.slot,
      lease: result.leaseOutcome,
      pipelineInvoked: result.pipelineInvoked,
      pipelineRunId: result.pipelineRunId,
      selectedEventKey: result.selectedEventKey,
      finalEventState: result.finalEventState,
      schedulerDecision: result.schedulerDecision,
      requestsUsed: result.requestsUsed,
      quotaBefore: `${result.quotaBefore.remaining}/${result.quotaBefore.limit} remaining`,
      quotaAfter: `${result.quotaAfter.remaining}/${result.quotaAfter.limit} remaining`,
      leaseReleased: result.leaseReleased,
      durationMs: result.durationMs,
      publisherWrites: 0,
      automaticRevision: false,
      publish: false,
      groqCalls: result.requestsUsed,
    }, null, 2));
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Scheduler execution failed");
    process.exitCode = 1;
  });
}
