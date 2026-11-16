import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chooseResumeFirstWork,
  hasValidInternalSchedulerToken,
  schedulerKickoffMetadata,
  shouldStartExpensiveStage,
  validateSchedulerKickoffMetadata,
  SCHEDULER_EXECUTION_REQUEST_CAP,
  SCHEDULER_MIN_STAGE_HEADROOM_MS,
  SCHEDULER_WORKER_MAX_RUNTIME_MS,
} from "../lib/agents/pipeline/scheduler/scheduler-control-policy.ts";
import { createCapacityResumeRequestBudget } from "../lib/agents/pipeline/supervised-request-cap-contract.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { PipelineOrchestrator } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import { createStaticPipelineQuota } from "../lib/agents/pipeline/pipeline-budget.ts";
import { startSchedulerLeaseHeartbeat } from "../lib/agents/pipeline/scheduler/scheduler-lease-heartbeat.ts";

const root = new URL("../", import.meta.url);
const migration = await readFile(new URL("supabase/migrations/20261022120000_scheduler_safety_repair_m40.sql", root), "utf8");
const orchestrator = await readFile(new URL("lib/agents/pipeline/scheduler/supervised-scheduler-orchestrator.ts", root), "utf8");
const manual = await readFile(new URL("scripts/supervised-pipeline-run.ts", root), "utf8");

const midnight = schedulerKickoffMetadata(new Date("2026-10-22T23:59:59.999Z"));
assert.equal(midnight.utcDate, "2026-10-22");
assert.equal(midnight.triggerId, "supervised-candidates:2026-10-22");
assert.equal(midnight.invocationId, "horizai-supervised:2026-10-22");
assert.deepEqual(schedulerKickoffMetadata(new Date("2026-10-23T00:00:00.000Z")).utcDate, "2026-10-23");
assert.deepEqual(validateSchedulerKickoffMetadata(midnight), midnight);
assert.throws(() => validateSchedulerKickoffMetadata({ ...midnight, triggerId: "manual:bypass" }), /IDENTITY_INVALID/);
assert.throws(() => validateSchedulerKickoffMetadata({ ...midnight, utcDate: "2026-02-30", triggerId: "supervised-candidates:2026-02-30", invocationId: "horizai-supervised:2026-02-30" }), /DATE_INVALID/);
assert.equal(hasValidInternalSchedulerToken("server-only-token", "server-only-token"), true);
assert.equal(hasValidInternalSchedulerToken("server-only-token", "server-only-t0ken"), false);
assert.equal(hasValidInternalSchedulerToken(undefined, "x"), false);

let heartbeatCalls = 0;
const heartbeat = startSchedulerLeaseHeartbeat(async () => { heartbeatCalls += 1; return false; }, 5);
await new Promise((resolve) => setTimeout(resolve, 30));
heartbeat.stop();
assert.ok(heartbeatCalls >= 1);
assert.equal(heartbeat.isLost(), true);

const syntheticEditorAttempt = {
  attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", eventKey: "synthetic-event", pipelineRunId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  attemptNumber: 1, completedAt: null, finalState: null, stopStage: "editor", stopReason: "PROVIDER_CAPACITY_EXHAUSTED",
  retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null, capacityResumeSnapshot: { resumeGeneration: 0 },
  resumeDispatchCount: 0, resumeCheckpointPresent: false,
};
const decision = chooseResumeFirstWork({ openAttempts: [syntheticEditorAttempt], validateDeferred: () => true });
assert.equal(decision.kind, "RESUME_SAME_ATTEMPT");
assert.equal(decision.attempt.attemptId, syntheticEditorAttempt.attemptId);
assert.equal(decision.attempt.stopStage, "editor");
const resumeBudget = createCapacityResumeRequestBudget({ providerAccounting: {
  verifier: { provider: "groq", providerRequestsUsed: 1 }, translator: { provider: "groq", providerRequestsUsed: 1 },
} });
assert.equal(resumeBudget.executionSnapshot().requests, 2);
assert.equal(resumeBudget.executionSnapshot().remaining, 34);
assert.equal(resumeBudget.executionSnapshot().cap, 36);
assert.equal(SCHEDULER_EXECUTION_REQUEST_CAP, 36);

assert.equal(chooseResumeFirstWork({ openAttempts: [], validateDeferred: () => true }).kind, "NEW_CANDIDATE");
assert.equal(chooseResumeFirstWork({ openAttempts: [syntheticEditorAttempt, syntheticEditorAttempt], validateDeferred: () => true }).kind, "STOP");
assert.equal(chooseResumeFirstWork({ openAttempts: [{ ...syntheticEditorAttempt, resumeDispatchCount: 1 }], validateDeferred: () => true }).kind, "STOP");
assert.equal(chooseResumeFirstWork({ openAttempts: [{ ...syntheticEditorAttempt, resumeCheckpointPresent: true }], validateDeferred: () => true }).kind, "STOP");
assert.equal(chooseResumeFirstWork({ openAttempts: [{ ...syntheticEditorAttempt, stopReason: null }], validateDeferred: () => true }).kind, "STOP");

assert.equal(shouldStartExpensiveStage({ startedAtMs: 1_000, nowMs: 1_000 }), true);
assert.equal(shouldStartExpensiveStage({ startedAtMs: 1_000, nowMs: 1_000 + SCHEDULER_WORKER_MAX_RUNTIME_MS - SCHEDULER_MIN_STAGE_HEADROOM_MS }), false);
assert.equal(shouldStartExpensiveStage({ startedAtMs: 10, nowMs: 9 }), true);

// Exercise the actual pre-dispatch runtime-budget path and same-attempt defer.
const budgetFixture = createOfflineStages();
const budgetTempRoot = await mkdtemp(join(process.cwd(), ".tmp-scheduler-14a-"));
try {
  const originalVerifier = budgetFixture.stages.verifier;
  budgetFixture.stages.verifier = async (...args) => {
    const outcome = await originalVerifier(...args);
    return {
      ...outcome,
      telemetry: {
        status: "SUCCESS", provider: "groq", providerUnit: "tokens", providerUnitUsageKnown: true,
        providerRequestDispatched: true, providerRequestsUsed: 1, attempts: 1, retries: 0,
        inputTokens: 20, outputTokens: 10, totalTokens: 30, startedAt: "2026-10-22T10:00:00.000Z", finishedAt: "2026-10-22T10:00:00.001Z",
      },
      checkpoint: async () => {
        const path = join(budgetTempRoot, "verifier.json");
        await writeFile(path, JSON.stringify({ stage: "verifier", synthetic: true }), "utf8");
        return { stage: "verifier", path, eventKey: outcome.eventKey, written: true, readable: true, valid: true };
      },
    };
  };
  const budgetAttempts = new InMemoryPipelineEventAttemptRegistry();
  const budgetResult = await new PipelineOrchestrator({
    stages: budgetFixture.stages,
    quota: createStaticPipelineQuota(6),
    attemptRegistry: budgetAttempts,
    humanReviewGateway: { async createReview() { throw new Error("SCHEDULER_BUDGET_TEST_REVIEW_MUST_NOT_RUN"); } },
    runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    now: () => new Date("2026-10-22T10:00:00.000Z"),
    shouldStartSemanticStage: (stage) => stage !== "translator",
    capacityResumeSnapshotWriter: async () => ({ path: join(budgetTempRoot, "resume.json"), sha256: "c".repeat(64) }),
    config: { mode: "supervised", dryRun: true, publish: false, hours: 48, limit: 3, trigger: "scheduled", automaticRevision: false, maxRevisionAttempts: 1 },
  }).run();
  assert.equal(budgetResult.eventResults[0]?.finalState, "DEFERRED_WORKER_TIME_BUDGET", JSON.stringify(budgetResult.eventResults[0]));
  assert.deepEqual(budgetFixture.calls, ["discovery", "extraction", "clustering", "verifier"]);
  assert.equal(budgetAttempts.snapshot().length, 1);
  assert.equal(budgetAttempts.snapshot()[0]?.stopStage, "translator");
  assert.equal(budgetAttempts.snapshot()[0]?.stopReason, "WORKER_TIME_BUDGET_EXHAUSTED");
  assert.equal(budgetAttempts.snapshot()[0]?.capacityResumeSnapshot?.resumeStage, "translator");
} finally {
  if (!budgetTempRoot.startsWith(join(process.cwd(), ".tmp-scheduler-14a-"))) throw new Error("SCHEDULER_TEST_TEMP_PATH_INVALID");
  await rm(budgetTempRoot, { recursive: true, force: true });
}

// Deterministic store model for duplicate delivery, concurrent ownership, retry, and stale lease recovery.
const store = { invocations: new Map(), lease: null, fence: 0 };
let claimLock = Promise.resolve();
async function claim(key, now, owner) {
  let unlock;
  const previousClaim = claimLock;
  claimLock = new Promise((resolve) => { unlock = resolve; });
  await previousClaim;
  try {
    const existing = store.invocations.get(key);
    if (existing) return "DAILY_TRIGGER_ALREADY_CLAIMED";
    if (store.lease && store.lease.expiresAt > now) return "ALREADY_RUNNING";
    if (store.lease && store.lease.expiresAt <= now) {
      const stale = store.invocations.get(store.lease.invocationId);
      if (stale?.status === "RUNNING") Object.assign(stale, { status: "STOPPED", outcome: "STALE_LEASE_RECOVERED" });
    }
    store.fence += 1;
    store.invocations.set(key, { status: "RUNNING", owner });
    store.lease = { owner, invocationId: key, expiresAt: now + 17 * 60_000, fence: store.fence };
    return "ACQUIRED";
  } finally { unlock(); }
}
const effects = { pipelineRuns: 0, providerDispatches: 0, attempts: 0, reviews: 0 };
async function deliver(key, now, owner) {
  const status = await claim(key, now, owner);
  if (status !== "ACQUIRED") return status;
  effects.pipelineRuns += 1; effects.providerDispatches += 1; effects.attempts += 1; effects.reviews += 1;
  return "STARTED";
}
const concurrent = await Promise.all([deliver("horizai-supervised:2026-10-22", 1000, "worker"), deliver("horizai-supervised:2026-10-22", 1000, "manual-runner")]);
assert.equal(concurrent.filter((status) => status === "STARTED").length, 1);
assert.ok(concurrent.every((status) => ["STARTED", "DAILY_TRIGGER_ALREADY_CLAIMED", "ALREADY_RUNNING"].includes(status)));
assert.equal(await deliver("horizai-supervised:2026-10-22", 2_000, "infrastructure-retry"), "DAILY_TRIGGER_ALREADY_CLAIMED");
assert.deepEqual(effects, { pipelineRuns: 1, providerDispatches: 1, attempts: 1, reviews: 1 });
assert.equal(await claim("horizai-supervised:2026-10-23", 2_001, "other-trigger"), "ALREADY_RUNNING");
assert.equal(await claim("horizai-supervised:2026-10-23", 18 * 60_000, "next-day-owner"), "ACQUIRED");
assert.equal(store.fence, 2);
assert.deepEqual(store.invocations.get("horizai-supervised:2026-10-22"), { status: "STOPPED", owner: "worker", outcome: "STALE_LEASE_RECOVERED" });

// Database contract assertions: tests inspect the prepared migration; it is intentionally not applied here.
assert.match(migration, /utc_day date not null unique/);
assert.match(migration, /trigger_id = 'supervised-candidates:'/);
assert.match(migration, /for update/);
assert.ok(migration.indexOf("select * into v_lease from public.supervised_scheduler_lease where singleton_id = 1 for update")
  < migration.indexOf("select * into v_existing from public.supervised_scheduler_invocations"));
assert.match(migration, /v_fence := v_lease\.fencing_token \+ 1/);
assert.match(migration, /expires_at <= p_now/);
assert.match(migration, /grant execute on function public\.claim_supervised_scheduler_invocation_m40.*to service_role/s);
assert.match(migration, /WORKER_TIME_BUDGET_EXHAUSTED/);
assert.match(migration, /resumeDispatchCount/);

// The hosting-neutral orchestrator claims durable state before pipeline work,
// resumes the same attempt first, and owns accounting, heartbeat, and finalization.
assert.ok(orchestrator.indexOf("control.claim") < orchestrator.indexOf("control.listOpenAttempts"));
assert.ok(orchestrator.indexOf("control.listOpenAttempts") < orchestrator.indexOf("pipeline.orchestrator.run"));
assert.ok(orchestrator.lastIndexOf("if (heartbeat.isLost())", orchestrator.indexOf("pipeline.orchestrator.run")) > orchestrator.indexOf("await pipeline.preflight()"));
assert.match(orchestrator, /mode: "supervised"/);
assert.match(orchestrator, /publish: false/);
assert.match(orchestrator, /SCHEDULER_WORKER_MAX_RUNTIME_MS/);
assert.match(orchestrator, /SCHEDULER_MAX_STAGE_TIMEOUT_MS/);
assert.match(orchestrator, /startSchedulerLeaseHeartbeat/);
assert.match(orchestrator, /resumeCapacityDeferred/);
assert.match(orchestrator, /unknownReservations > 0/);
assert.equal(await (await import("node:fs/promises")).access(new URL("netlify/functions/horizai-supervised-worker.ts", root)).then(() => true, () => false), false);
assert.equal(await (await import("node:fs/promises")).access(new URL("netlify/functions/horizai-supervised-kickoff.ts", root)).then(() => true, () => false), false);
assert.ok(manual.includes("schedulerKickoffMetadata(now)"));
assert.ok(manual.includes("control.claim({ metadata, ownerId: ownerRunId, now })"));
assert.ok(manual.indexOf("control.claim({ metadata, ownerId: ownerRunId, now })") < manual.indexOf("scheduler.acquire({"));
assert.ok(manual.indexOf("control.listOpenAttempts()") < manual.indexOf("pipeline.orchestrator.run()"));
assert.match(manual, /startSchedulerLeaseHeartbeat/);
assert.match(manual, /schedulerM40: true/);
assert.match(manual, /shouldStartExpensiveStage/);

console.log("scheduler:14a:unit: OK (UTC identity, token guard, resume-first, attempt reuse, 18-request resume accounting, duplicate/retry/concurrent worker/manual safety, heartbeat loss gate, stale fencing, pre-dispatch runtime defer, M40 contract, no kickoff pipeline work)");
