import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createCapacityResumeRequestBudget, inspectSupervisedRequestCapContract } from "../lib/agents/pipeline/supervised-request-cap-contract.ts";
import { SUPERVISED_PROVIDER_REQUEST_LIMIT } from "../lib/agents/pipeline/supervised-throughput-policy.ts";
import { applyProductionModePolicy } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { ProviderScopedDailyRequestBudget, resolveGroqDailyRequestHardCap } from "../lib/agents/runtime/request-budget.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { readGroqAtomicCapacityLimits } from "../lib/agents/runtime/free-provider-router.ts";
import { readGroqMaxConcurrentEvents } from "../lib/agents/runtime/groq-capacity-policy.ts";

// No request in this suite can reach any remote endpoint, including providers.
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("OFFLINE_TEST_NETWORK_FORBIDDEN"); };
const fixtureSnapshot = (used) => ({ providerAccounting: Object.fromEntries(Array.from({ length: used }, (_, i) => [String(i), { provider: "groq", providerRequestsUsed: 1 }])) });
const clock = () => new Date("2026-10-20T12:00:00Z");
const env = { GROQ_DAILY_REQUEST_HARD_CAP: "1000", GROQ_FREE_DAILY_TOKEN_LIMIT: "200000", GROQ_FREE_MINUTE_REQUEST_LIMIT: "30", GROQ_FREE_MINUTE_TOKEN_LIMIT: "8000" };
const providerLimits = readGroqAtomicCapacityLimits(env);
assert.ok(providerLimits);
assert.equal(resolveGroqDailyRequestHardCap(env).limit, 1000);
assert.equal(providerLimits.requestSoftLimit, 850);
const inspect = (requestBudget, remaining = 844) => inspectSupervisedRequestCapContract({
  providerRpdHardLimit: providerLimits.requestHardLimit,
  providerRpdSoftLimit: providerLimits.requestSoftLimit,
  providerRpdRemaining: remaining, requestBudget,
});
try {
  const fresh = new ProviderScopedDailyRequestBudget(clock, SUPERVISED_PROVIDER_REQUEST_LIMIT);
  const resumed = createCapacityResumeRequestBudget(fixtureSnapshot(5), clock);
  assert.deepEqual(fresh.executionSnapshot(), { cap: 36, requests: 0, remaining: 36 });
  assert.deepEqual(resumed.executionSnapshot(), { cap: 36, requests: 5, remaining: 31 });
  const contract = inspect(resumed);
  assert.equal(contract.outcome, "READY", "RPD 1000 and execution cap 36 coexist");
  assert.notEqual(contract.providerRpdHardLimit, contract.supervisedExecutionRequestCap);
  assert.equal(contract.cumulativeAttemptRequests, 5);
  assert.equal(contract.remainingExecutionRequests, 31);
  assert.equal(inspect(resumed, 0).outcome, "PROVIDER_RPD_CAPACITY_EXHAUSTED");
  assert.equal(resumed.executionSnapshot().remaining, 31, "provider exhaustion does not consume execution budget");

  for (let i = 0; i < 31; i += 1) resumed.reserve("groq", 1000);
  assert.deepEqual(resumed.executionSnapshot(), { cap: 36, requests: 36, remaining: 0 });
  assert.equal(inspect(resumed).outcome, "SUPERVISED_EXECUTION_REQUEST_CAP_EXHAUSTED");
  assert.throws(() => resumed.reserve("groq", 1000), { code: "DAILY_REQUEST_LIMIT_REACHED", limit: 36 });
  assert.equal(resumed.executionSnapshot().requests, 36, "37th reservation is never admitted");
  assert.throws(() => createCapacityResumeRequestBudget(fixtureSnapshot(37), clock), { code: "DAILY_REQUEST_LIMIT_REACHED" });
  assert.throws(() => createCapacityResumeRequestBudget({ providerAccounting: { verifier: { provider: "groq", providerRequestsUsed: -1 } } }), /ACCOUNTING_INVALID/);
  assert.throws(() => inspect(new ProviderScopedDailyRequestBudget(clock, 1000)), /SUPERVISED_EXECUTION_REQUEST_CAP_MISMATCH/);

  // UTC rollover does not reset the per-execution cap or cumulative usage.
  let day = clock();
  const acrossDays = createCapacityResumeRequestBudget(fixtureSnapshot(5), () => day);
  day = new Date("2026-10-21T12:00:00Z");
  assert.equal(acrossDays.executionSnapshot().requests, 5);
  assert.equal(acrossDays.executionSnapshot().remaining, 31);

  const childScript = `
    import { createCapacityResumeRequestBudget } from './lib/agents/pipeline/supervised-request-cap-contract.ts';
    globalThis.fetch = async () => { throw new Error('OFFLINE_CHILD_NETWORK_FORBIDDEN'); };
    let text = ''; for await (const chunk of process.stdin) text += chunk;
    const budget = createCapacityResumeRequestBudget(JSON.parse(text));
    console.log(JSON.stringify(budget.executionSnapshot()));
  `;
  const child = execFileSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "--input-type=module", "-e", childScript], {
    input: JSON.stringify(fixtureSnapshot(5)), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  assert.deepEqual(JSON.parse(child), { cap: 36, requests: 5, remaining: 31 }, "fresh process restores usage from serialized accounting");

  const modelConfig = {
    model: "openai/gpt-oss-20b", timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 0,
    maxOutputTokens: 64, dailyRequestLimit: 1000, failOnRateLimit: true,
    allowPaidFallback: false, allowProviderPacingWait: false,
    structuredOutputMode: "json_object", groqCapacity: providerLimits,
  };
  const execute = async (budget, denyProvider = false) => {
    const logger = new InMemoryAgentLogger();
    let dispatches = 0;
    let providerReservations = 0;
    const reserve = logger.reserveGroqCapacity.bind(logger);
    logger.reserveGroqCapacity = async (...args) => {
      providerReservations += 1;
      return denyProvider ? { allowed: false, reason: "GROQ_DAILY_REQUEST_SOFT_LIMIT_REACHED" } : reserve(...args);
    };
    const provider = { providerId: "groq", async generateStructured(request) {
      dispatches += 1; await request.onRequestDispatched();
      return { output: { ok: true }, model: modelConfig.model, provider: "groq", usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } };
    } };
    let errorCode = null;
    try {
      await runStructuredAgent({ agentName: "critic", agentVersion: "synthetic-cap-contract", eventKey: "synthetic-cap-contract",
        input: { fixture: true }, systemInstructions: "Return the fixture.", schemaName: "CapContract",
        schema: z.object({ ok: z.literal(true) }).strict(), modelConfig, provider, logger, dryRun: true, requestBudget: budget });
    } catch (error) { errorCode = error.code; }
    return { dispatches, providerReservations, errorCode };
  };
  const continuation = createCapacityResumeRequestBudget(fixtureSnapshot(5));
  assert.deepEqual(await execute(continuation), { dispatches: 1, providerReservations: 1, errorCode: null });
  assert.equal(continuation.executionSnapshot().remaining, 30, "same-process continuation retains prior requests");
  assert.deepEqual(await execute(createCapacityResumeRequestBudget(fixtureSnapshot(36))), {
    dispatches: 0, providerReservations: 0, errorCode: "DAILY_REQUEST_LIMIT_REACHED",
  }, "execution exhaustion stops before a provider reservation or dispatch despite RPD 1000");
  const providerDenied = createCapacityResumeRequestBudget(fixtureSnapshot(5));
  assert.deepEqual(await execute(providerDenied, true), { dispatches: 0, providerReservations: 1, errorCode: "PROVIDER_CAPACITY_EXHAUSTED" });
  assert.equal(providerDenied.executionSnapshot().requests, 5, "denied provider reservation releases the local reservation");

  const policy = applyProductionModePolicy(Object.fromEntries(["verifier", "translator", "editor", "classifier", "ranker", "critic"].map((stage) => [stage, { ...modelConfig, maxRetries: 9, allowPaidFallback: true }])), "supervised");
  assert.ok(Object.values(policy).every((c) => c.maxRetries === 0 && c.allowPaidFallback === false && c.allowProviderPacingWait === false && c.dailyRequestLimit === 1000));
  assert.equal(readGroqMaxConcurrentEvents({}), 1);
  const normal = readFileSync(new URL("./supervised-pipeline-run.ts", import.meta.url), "utf8");
  assert.match(normal, /new ProviderScopedDailyRequestBudget\(\(\) => new Date\(\), SUPERVISED_PROVIDER_REQUEST_LIMIT\)/);
  const runner = readFileSync(new URL("./supervised-cycle-12f12e-critic-resume.mjs", import.meta.url), "utf8");
  assert.match(runner, /const budget = createCapacityResumeRequestBudget\(budgetSnapshot\)/);
  assert.equal(runner.includes('assert.equal(production.dailyRequestLimit, 18'), false);
  assert.match(runner, /providerRpdHardLimit: production.dailyRequestLimit/);
  assert.match(runner, /requestCapPreflightMode \|\| process.argv/);
} finally { globalThis.fetch = originalFetch; }
console.log(JSON.stringify({ status: "PASS", providerRpdHardLimit: 1000, providerRpdSoftLimit: 850, supervisedExecutionRequestCap: 36,
  cumulativeAttemptRequests: 5, remainingExecutionRequests: 31, cases: 14, normalVsResume: "PASS", freshProcessContinuity: "PASS",
  nineteenthRequestBlocked: true, independentProviderQuota: "PASS", retries: 0, fallback: 0, concurrency: 1, remoteRequests: 0, remoteWrites: 0, providerCalls: 0 }));
