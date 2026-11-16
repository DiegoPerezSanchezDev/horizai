import { randomUUID } from "node:crypto";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { FREE_TIER_DAILY_REQUEST_LIMIT } from "../lib/agents/runtime/request-budget.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseSchedulerRepository, type PersistentSchedulerAcquireInput } from "../lib/agents/pipeline/scheduler/scheduler-repository.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function input(prefix: string, ownerRunId: string, now: Date, expiresAt: Date, slot: "morning" | "afternoon" | "night" = "morning"): PersistentSchedulerAcquireInput {
  const date = now.toISOString().slice(0, 10);
  return {
    triggerId: `${prefix}:${slot}`,
    ownerRunId,
    invocationType: "preflight",
    scheduleDateUtc: date,
    slot,
    schedulingTimezone: "Europe/Madrid",
    scheduledAt: now.toISOString(),
    requestDateUtc: date,
    now: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    quotaUsed: 0,
    quotaRemaining: FREE_TIER_DAILY_REQUEST_LIMIT,
    maxEventsPerRun: 3,
    automaticRevision: false,
    dryRun: true,
    publish: false,
  };
}

async function main(): Promise<void> {
  const supabase = createSupabaseServerClient();
  const repository = new SupabaseSchedulerRepository(supabase);
  const logger = new SupabaseAgentLogger(supabase);
  const now = new Date("2026-09-21T10:00:00.000Z");
  const later = new Date("2026-09-21T10:01:00.000Z");
  const expiredNow = new Date("2026-09-21T10:02:00.000Z");
  const prefix = `test:10c1:${randomUUID()}`;
  const beforeQuota = await logger.getRemainingRequests(FREE_TIER_DAILY_REQUEST_LIMIT, now.toISOString().slice(0, 10));
  const beforeArticles = await supabase.from("articles").select("id", { count: "exact", head: true });
  assert(!beforeArticles.error && beforeArticles.count !== null, "unable to read article count");
  try {
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const activeInput = input(`${prefix}:active`, ownerA, now, later);
    const first = await repository.acquire(activeInput);
    assert(first.status === "acquired", "worker A must acquire");
    const second = await repository.acquire({ ...activeInput, ownerRunId: ownerB });
    assert(second.status === "busy", "worker B must be blocked while lease is active");
    assert((await repository.release({ triggerId: activeInput.triggerId, ownerRunId: ownerB, releasedAt: later.toISOString() })) === false, "wrong owner release must fail");
    assert((await repository.release({ triggerId: activeInput.triggerId, ownerRunId: ownerA, releasedAt: later.toISOString() })) === true, "owner A release must succeed");

    const duplicate = await repository.acquire({ ...activeInput, ownerRunId: ownerB });
    assert(duplicate.status === "duplicate", "completed/released trigger must remain duplicate");

    const expiryInput = input(`${prefix}:expiry`, ownerA, now, later);
    assert((await repository.acquire(expiryInput)).status === "acquired", "expiry fixture initial acquire must succeed");
    const recovered = await repository.acquire({ ...expiryInput, ownerRunId: ownerB, now: expiredNow.toISOString(), expiresAt: new Date(expiredNow.getTime() + 60_000).toISOString() });
    assert(recovered.status === "expired", "expired lease must be recoverable");
    assert((await repository.release({ triggerId: expiryInput.triggerId, ownerRunId: ownerB, releasedAt: expiredNow.toISOString() })) === true, "recovered owner must release");

    const concurrentPrefix = `${prefix}:concurrent`;
    const concurrentA = input(concurrentPrefix, ownerA, now, later);
    const concurrentB = { ...concurrentA, ownerRunId: ownerB };
    const concurrent = await Promise.all([repository.acquire(concurrentA), repository.acquire(concurrentB)]);
    assert(concurrent.filter((result) => result.status === "acquired").length === 1, "exactly one concurrent acquire must succeed");
    assert(concurrent.filter((result) => result.status === "busy").length === 1, "exactly one concurrent acquire must be busy");
    const concurrentOwner = concurrent.find((result) => result.status === "acquired")?.ownerRunId;
    assert(typeof concurrentOwner === "string", "concurrent owner must be present");
    assert((await repository.finish({ triggerId: concurrentA.triggerId, ownerRunId: concurrentOwner, runStatus: "failed", finalDecision: "failed", stopReason: "TEST_LOCAL_FAILURE", quotaUsed: 0, quotaRemaining: FREE_TIER_DAILY_REQUEST_LIMIT, finishedAt: later.toISOString() })) === true, "failed run must be recorded");
    assert((await repository.release({ triggerId: concurrentA.triggerId, ownerRunId: concurrentOwner, releasedAt: later.toISOString() })) === true, "failed run lease must release");

    const afterQuota = await logger.getRemainingRequests(FREE_TIER_DAILY_REQUEST_LIMIT, now.toISOString().slice(0, 10));
    const afterArticles = await supabase.from("articles").select("id", { count: "exact", head: true });
    assert(!afterArticles.error && afterArticles.count === beforeArticles.count, "integration must not create articles");
    assert(afterQuota.used === beforeQuota.used && afterQuota.remaining === beforeQuota.remaining, "integration must not consume model budget");
    console.log(JSON.stringify({ integration: "pipeline:scheduler", workerA: "acquired", workerB: "blocked", wrongOwnerRelease: "blocked", ownerRelease: "passed", duplicate: "blocked", expiry: "passed", concurrentAcquisitions: "exactly_one_allowed", failureRelease: "passed", pipelineExecutions: 0, articleWrites: 0, groqCalls: 0, quotaBefore: `${beforeQuota.remaining}/${beforeQuota.dailyLimit} remaining`, quotaAfter: `${afterQuota.remaining}/${afterQuota.dailyLimit} remaining` }, null, 2));
  } finally {
    await repository.deleteTestTrigger(prefix);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Scheduler integration failed");
  process.exitCode = 1;
});
