import assert from "node:assert/strict";
import { accountEventAndCheckNext, createScheduledRunPlan, schedulerResult } from "../lib/agents/pipeline/index.ts";

const plan = createScheduledRunPlan({
  runId: "simulation-run",
  scheduledAt: new Date("2026-09-21T10:00:00Z"),
  quota: { requestDateUtc: "2026-09-21", limit: 20, used: 0, remaining: 20 },
  eligibleEventCount: 10,
});
assert.equal(plan.allowed, true);

let remaining = plan.quotaRemaining;
const attempts = [];
let stopReason = null;
for (const event of [
  { eventKey: "event-a", status: "skipped", requestsUsed: 1, reason: "SKIPPED_VERIFICATION_INSUFFICIENT" },
  { eventKey: "event-b", status: "completed", requestsUsed: 6, reason: null },
  { eventKey: "event-c", status: "completed", requestsUsed: 6, reason: null },
]) {
  attempts.push(event);
  const next = accountEventAndCheckNext({ remaining, requestsUsed: event.requestsUsed, processed: attempts.length - 1, maxEventsPerRun: plan.maxEventsPerRun });
  remaining = next.remaining;
  stopReason = next.stopReason;
  if (!next.canContinue) break;
}

const result = schedulerResult({
  plan,
  quotaAfter: { requestDateUtc: "2026-09-21", limit: 20, used: 13, remaining },
  leaseOutcome: "released",
  attempts,
  stopReason,
});
assert.equal(result.requestsUsed, 13);
assert.equal(result.quotaAfter.remaining, 7);
assert.equal(result.completed, 2);
assert.equal(result.skipped, 1);
assert.equal(result.stopReason, "MAX_EVENTS_PER_RUN");

console.log(JSON.stringify({
  simulation: "pipeline:scheduler",
  eventsAttempted: attempts.length,
  requestsUsed: result.requestsUsed,
  remaining: result.quotaAfter.remaining,
  stopReason: result.stopReason,
  dryRun: plan.dryRun,
  publish: plan.publish,
  automaticRevision: plan.automaticRevision,
}, null, 2));
