import assert from "node:assert/strict";
import { handler } from "../netlify/functions/scheduler-trigger.ts";
import { acquireSchedulerRunLease, createScheduledRunPlan, releaseSchedulerRunLease, schedulerTriggerIdentity } from "../lib/agents/pipeline/index.ts";

const plan = createScheduledRunPlan({
  runId: "11111111-1111-4111-8111-111111111111",
  scheduledAt: new Date("2026-09-21T10:00:00Z"),
  quota: { requestDateUtc: "2026-09-21", limit: 20, used: 0, remaining: 20 },
  eligibleEventCount: 1,
});
assert.equal(plan.allowed, true);
assert.equal(plan.dryRun, true);
assert.equal(plan.publish, false);
assert.equal(plan.automaticRevision, false);
assert.match(schedulerTriggerIdentity(new Date("2026-09-21T10:00:00Z")), /^scheduled:2026-09-21:/);

let owner = null;
const mockLease = {
  async acquire(input) {
    owner = input.ownerRunId;
    return { status: "acquired", lease: { ownerRunId: owner, acquiredAt: input.now.toISOString(), expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString() } };
  },
  async release(input) {
    return input.ownerRunId === owner
      ? { status: "released", lease: { ownerRunId: owner, acquiredAt: "2026-09-21T10:00:00.000Z", expiresAt: "2026-09-21T11:00:00.000Z" } }
      : { status: "rejected", lease: null };
  },
};
assert.equal((await acquireSchedulerRunLease(mockLease, { ownerRunId: "22222222-2222-4222-8222-222222222222", now: new Date("2026-09-21T10:00:00Z"), ttlMs: 3600000 })).status, "acquired");
assert.equal((await releaseSchedulerRunLease(mockLease, { ownerRunId: "22222222-2222-4222-8222-222222222222" })).status, "released");

delete process.env.SCHEDULER_TRIGGER_SECRET;
assert.equal((await handler({ httpMethod: "POST", headers: {} })).statusCode, 401);
assert.equal((await handler({ httpMethod: "GET", headers: {} })).statusCode, 405);

console.log("pipeline:scheduler:wiring:unit: OK (Netlify entrypoint guard, offline-safe composition, policy reuse, lease abstraction, no network)");
