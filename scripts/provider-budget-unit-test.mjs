import assert from "node:assert/strict";
import { DailyRequestBudget, ProviderScopedDailyRequestBudget, resolveGroqDailyRequestHardCap } from "../lib/agents/runtime/request-budget.ts";
import { createPersistentPipelineQuota } from "../lib/agents/pipeline/pipeline-budget.ts";
import { readProviderCapacityConfig } from "../lib/agents/runtime/free-provider-router.ts";
import { InMemoryAgentLogger, SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";

assert.deepEqual(resolveGroqDailyRequestHardCap({}), { limit: 20, source: "SAFE_DEFAULT" });
assert.deepEqual(resolveGroqDailyRequestHardCap({ AGENT_DAILY_REQUEST_LIMIT: "20" }), { limit: 20, source: "LEGACY_GROQ_FALLBACK" });
assert.deepEqual(resolveGroqDailyRequestHardCap({ GROQ_DAILY_REQUEST_HARD_CAP: "18", AGENT_DAILY_REQUEST_LIMIT: "12" }), { limit: 18, source: "GROQ_DAILY_REQUEST_HARD_CAP" });
assert.deepEqual(resolveGroqDailyRequestHardCap({ GROQ_DAILY_REQUEST_HARD_CAP: "1000", AGENT_DAILY_REQUEST_LIMIT: "20" }), { limit: 1_000, source: "GROQ_DAILY_REQUEST_HARD_CAP" });
assert.throws(() => resolveGroqDailyRequestHardCap({ GROQ_DAILY_REQUEST_HARD_CAP: "1001" }), { code: "cost_guard_violation" });
assert.throws(() => resolveGroqDailyRequestHardCap({ AGENT_DAILY_REQUEST_LIMIT: "21" }), { code: "cost_guard_violation" });
assert.throws(() => resolveGroqDailyRequestHardCap({ AGENT_DAILY_REQUEST_LIMIT: "0" }), { code: "cost_guard_violation" });
assert.doesNotThrow(() => createPersistentPipelineQuota({ getRemainingRequests: async () => ({ requestDate: "2026-09-23", dailyLimit: 1_000, used: 0, remaining: 1_000 }) }, { dailyLimit: 1_000 }));
assert.throws(() => createPersistentPipelineQuota({ getRemainingRequests: async () => ({ requestDate: "2026-09-23", dailyLimit: 1_001, used: 0, remaining: 1_001 }) }, { dailyLimit: 1_001 }), /between 1 and 1000/);
const cloudflareConfig = readProviderCapacityConfig("cloudflare_workers_ai", {
  AGENT_DAILY_REQUEST_LIMIT: "1",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_AI_API_TOKEN: "offline-fixture-token",
  CLOUDFLARE_DAILY_NEURON_LIMIT: "10000",
});
assert.equal(cloudflareConfig.dailyRequestLimit, undefined, "the legacy Groq cap never becomes a Cloudflare request cap");
assert.equal(readProviderCapacityConfig("cloudflare_workers_ai", {
  CLOUDFLARE_FREE_DAILY_REQUEST_LIMIT: "2",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_AI_API_TOKEN: "offline-fixture-token",
  CLOUDFLARE_DAILY_NEURON_LIMIT: "10000",
}).dailyRequestLimit, 2, "Cloudflare request capacity is only present when explicitly configured");

let now = new Date("2026-09-23T23:59:00Z");
const budget = new ProviderScopedDailyRequestBudget(() => now);
const groq = await Promise.allSettled(Array.from({ length: 21 }, async () => budget.reserve("groq", 20)));
assert.equal(groq.filter((item) => item.status === "fulfilled").length, 20);
assert.equal(groq.filter((item) => item.status === "rejected").length, 1);
assert.equal(budget.snapshot("groq").requests, 20);
assert.equal(budget.snapshot("cerebras").requests, 0);
assert.equal(budget.reserve("cerebras", 20).dailyCount, 1);
assert.equal(budget.reserve("cerebras", 20).requestDate, "2026-09-23");
budget.release("cerebras", "2026-09-23");
assert.equal(budget.snapshot("cerebras").requests, 1);
assert.equal(budget.reserve("cloudflare_workers_ai", 2).dailyCount, 1, "Cloudflare's optional request counter is independent from Groq and Cerebras");
budget.markRateLimited("groq");
assert.throws(() => budget.reserve("groq", 20), { code: "FREE_TIER_LIMIT_REACHED" });
assert.equal(budget.reserve("cloudflare_workers_ai", 2).dailyCount, 2, "a Groq temporary block does not block Cloudflare");
budget.markRateLimited("cloudflare_workers_ai");
assert.throws(() => budget.reserve("cloudflare_workers_ai", 2), { code: "FREE_TIER_LIMIT_REACHED" });
now = new Date("2026-09-24T00:00:00Z");
assert.equal(budget.snapshot("groq").requests, 0);
assert.equal(budget.snapshot("cerebras").requests, 0);
assert.equal(budget.reserve("groq", 20).requestDate, "2026-09-24");
assert.equal(budget.reserve("cerebras", 20).dailyCount, 1);
assert.equal(budget.reserve("cloudflare_workers_ai", 2).dailyCount, 1, "daily rollover is provider-specific");
budget.release("groq", "2026-09-23");
assert.equal(budget.snapshot("groq").requests, 1);
const independentBudget = new ProviderScopedDailyRequestBudget(() => now);
assert.equal(independentBudget.reserve("groq", 20).dailyCount, 1);
assert.equal(independentBudget.reserve("cloudflare_workers_ai", 2).dailyCount, 1, "provider request counters do not share a global bucket");

const legacyBudget = new DailyRequestBudget(() => now);
assert.equal(legacyBudget.reserve(1, "groq").dailyCount, 1);
assert.equal(legacyBudget.reserve(1, "cloudflare_workers_ai").dailyCount, 1, "legacy injected budgets also keep per-provider counters");
assert.equal(legacyBudget.snapshot("groq").requests, 1);
assert.equal(legacyBudget.snapshot("cloudflare_workers_ai").requests, 1);

const persistedCalls = [];
const queryCalls = [];
const fakeClient = {
  async rpc(name, args) {
    persistedCalls.push({ name, args });
    const requestDate = args.p_request_date;
    if (name === "reserve_provider_agent_request") return { data: { allowed: true, dailyCount: 1, dailyLimit: 20, requestDate, reservationId: 11 }, error: null };
    return { data: { allowed: true, dailyCount: 1, dailyLimit: null, usedNeurons: 2_381, neuronLimit: 8_499, estimatedNeurons: 2_381, requestDate, reservationId: 12 }, error: null };
  },
  from(table) {
    assert.equal(table, "agent_logs");
    const query = {
      select(...args) { queryCalls.push(["select", ...args]); return this; },
      eq(...args) { queryCalls.push(["eq", ...args]); return this; },
      or(...args) { queryCalls.push(["or", ...args]); return this; },
      gte(...args) { queryCalls.push(["gte", ...args]); return this; },
      lt(...args) { queryCalls.push(["lt", ...args]); return this; },
      then(resolve, reject) { return Promise.resolve({ count: 3, error: null }).then(resolve, reject); },
    };
    return query;
  },
};
const persistedLogger = new SupabaseAgentLogger(fakeClient);
const utcDay = "2026-09-23";
assert.deepEqual(await persistedLogger.getRemainingRequests(20, utcDay), { requestDate: utcDay, dailyLimit: 20, used: 3, remaining: 17 });
assert.ok(queryCalls.some((call) => call[0] === "or" && call[1] === "provider.eq.groq,provider.is.null"), "Groq legacy quota read excludes explicitly labeled Cloudflare reservations");
const groqMetadata = { agentName: "verifier", agentVersion: "verifier-v1", eventKey: "event-groq", model: "openai/gpt-oss-20b", provider: "groq", dryRun: true };
const cfMetadata = { ...groqMetadata, agentName: "verifier", eventKey: "event-cf", model: "@cf/openai/gpt-oss-20b", provider: "cloudflare_workers_ai" };
await persistedLogger.reserveProviderRequest("run-groq", groqMetadata, 1, 20, utcDay, "groq");
await persistedLogger.reserveRequest("run-cf", cfMetadata, 1, 20, utcDay, { provider: "cloudflare_workers_ai", requestLimit: null, hardNeuronLimit: 10_000, neuronLimit: 8_499, estimatedNeurons: 2_381 });
assert.deepEqual(persistedCalls.map(({ name }) => name), ["reserve_provider_agent_request", "reserve_cloudflare_neuron_capacity"]);
assert.equal(persistedCalls[0].args.p_provider, "groq");
assert.equal(persistedCalls[1].args.p_request_limit, null);
assert.equal(persistedCalls[1].args.p_daily_neuron_allocation, 8_499, "Cloudflare reservation receives the strict-below-85% soft allocation");

const inMemoryLogger = new InMemoryAgentLogger();
const inMemoryGroq = await inMemoryLogger.reserveProviderRequest("run-groq", groqMetadata, 1, 20, utcDay, "groq");
const inMemoryCloudflare = await inMemoryLogger.reserveRequest("run-cf", cfMetadata, 1, 20, utcDay, { provider: "cloudflare_workers_ai", requestLimit: null, hardNeuronLimit: 10_000, neuronLimit: 8_499, estimatedNeurons: 2_381 });
assert.equal(inMemoryGroq.allowed, true);
assert.equal(inMemoryCloudflare.allowed, true, "Groq 20/day request cap does not enter Cloudflare Neuron capacity");
console.log("provider:budget:unit: OK (offline only)");
