import { runSchedulerPreflight } from "../lib/agents/pipeline/scheduler/scheduler-runner.ts";

async function main(): Promise<void> {
  const result = await runSchedulerPreflight();
  console.log(JSON.stringify({
    scheduler: "preflight",
    allowed: result.allowed,
    triggerIdNamespace: "test:scheduler-preflight",
    slot: result.slot,
    schedulingTimezone: result.schedulingTimezone,
    requestDateUtc: result.requestDateUtc,
    quota: `${result.quotaRemaining}/${result.quotaLimit} remaining`,
    maxEventsPerRun: result.maxEventsPerRun,
    automaticRevision: result.automaticRevision,
    dryRun: result.dryRun,
    publish: result.publish,
    leaseFirst: result.leaseFirst,
    overlapCheck: result.overlapCheck,
    wrongOwnerRelease: result.wrongOwnerRelease,
    duplicateAfterRelease: result.duplicateAfterRelease,
    pipelineExecuted: result.pipelineExecuted,
    articleWrites: result.articleWrites,
    cleanedUp: result.cleanedUp,
    groqCalls: 0,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Scheduler preflight failed");
  process.exitCode = 1;
});
