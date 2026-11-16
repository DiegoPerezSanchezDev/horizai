import assert from "node:assert/strict";
import {
  evaluateGroqNewEventAdmission,
  groqSequentialConcurrencyApproved,
  planGroqDailyCapacity,
  provisionalGroqEventTokens,
  readGroqEventTokenMarginPercent,
  simulateGroqCandidateDemand,
} from "../lib/agents/runtime/groq-capacity-policy.ts";
import { readGroqAtomicCapacityLimits, readProviderCapacityConfig } from "../lib/agents/runtime/free-provider-router.ts";
import { resolveGroqDailyRequestHardCap } from "../lib/agents/runtime/request-budget.ts";

const confirmedGroqEnv = {
  GROQ_DAILY_REQUEST_HARD_CAP: "1000",
  GROQ_DAILY_TOKEN_HARD_CAP: "200000",
  GROQ_REQUESTS_PER_MINUTE_HARD_CAP: "30",
  GROQ_TOKENS_PER_MINUTE_HARD_CAP: "8000",
  GROQ_FREE_DAILY_REQUEST_LIMIT: "20",
  AGENT_DAILY_REQUEST_LIMIT: "20",
  AGENT_MODEL_VERIFY: "openai/gpt-oss-20b",
  AGENT_API_URL: "https://api.groq.com/openai/v1",
  AGENT_API_KEY: "offline-fixture-only",
};
assert.deepEqual(resolveGroqDailyRequestHardCap(confirmedGroqEnv), { limit: 1_000, source: "GROQ_DAILY_REQUEST_HARD_CAP" });
const groqConfig = readProviderCapacityConfig("groq", confirmedGroqEnv);
assert.equal(groqConfig.dailyRequestLimit, 1_000, "canonical RPD overrides both legacy 20 values");
assert.equal(groqConfig.dailyTokenLimit, 200_000);
assert.equal(groqConfig.minuteRequestLimit, 30);
assert.equal(groqConfig.minuteTokenLimit, 8_000);
assert.equal(groqConfig.configured, true);
assert.deepEqual(readGroqAtomicCapacityLimits(confirmedGroqEnv), {
  requestHardLimit: 1_000, requestSoftLimit: 850, tokenHardLimit: 200_000, tokenSoftLimit: 170_000,
  tokenMinuteHardLimit: 8_000, requestMinuteHardLimit: 30,
});
assert.equal(readProviderCapacityConfig("groq", { AGENT_DAILY_REQUEST_LIMIT: "20" }).dailyRequestLimit, 20);

const cloudflareConfig = readProviderCapacityConfig("cloudflare_workers_ai", {
  ...confirmedGroqEnv,
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_AI_API_TOKEN: "offline-fixture-only",
  CLOUDFLARE_DAILY_NEURON_LIMIT: "10000",
  CLOUDFLARE_MODEL: "@cf/openai/gpt-oss-20b",
});
assert.equal(cloudflareConfig.dailyRequestLimit, undefined, "Cloudflare ignores the canonical and legacy Groq request caps");
assert.equal(cloudflareConfig.dailyNeuronAllocation, 10_000, "Cloudflare Neuron capacity is unchanged");
assert.equal(cloudflareConfig.softLimitRatio, 0.85);

const plan = planGroqDailyCapacity({ requestHardLimit: 1_000, tokenHardLimit: 200_000, softRatio: 0.85 });
assert.equal(plan.requestSoftLimit, 850);
assert.equal(plan.tokenSoftLimit, 170_000);
assert.deepEqual(plan.sensitivities, [
  { marginPercent: 10, provisionalEventTokens: 11_382, eventsWithinSoftTpd: 14 },
  { marginPercent: 15, provisionalEventTokens: 11_900, eventsWithinSoftTpd: 14 },
  { marginPercent: 20, provisionalEventTokens: 12_417, eventsWithinSoftTpd: 13 },
  { marginPercent: 25, provisionalEventTokens: 12_934, eventsWithinSoftTpd: 13 },
]);
assert.equal(provisionalGroqEventTokens({ observedFullPathTokens: 10_347, marginPercent: 25 }), 12_934);
assert.equal(readGroqEventTokenMarginPercent({ GROQ_EVENT_TOKEN_PLANNING_MARGIN_PERCENT: "20" }), 20);
assert.equal(plan.requestPlanningEventCapacity, 141);
assert.equal(plan.tokenPlanningEventCapacity, 13);
assert.equal(plan.finalEventCapacity, 13);

for (const candidates of [10, 12, 15]) {
  const scenario = simulateGroqCandidateDemand({ candidates, requestHardLimit: 1_000, tokenHardLimit: 200_000, softRatio: 0.85, eventRequests: 6, eventTokens: 12_934 });
  assert.equal(scenario.admitted, candidates === 15 ? 13 : candidates);
  assert.equal(scenario.blocked, candidates === 15 ? 2 : 0);
  assert.equal(scenario.requestsWithinSoftLimit, true);
  assert.equal(scenario.tokensWithinSoftLimit, candidates <= 13);
  if (candidates === 15) {
    assert.equal(scenario.plannedRequests, 90);
    assert.equal(scenario.plannedTokens, 194_010);
    assert.equal(scenario.admittedRequests, 78);
    assert.equal(scenario.admittedTokens, 168_142);
    assert.equal(scenario.remainingSoftTokens, 1_858);
    assert.equal(scenario.blockedReason, "GROQ_DAILY_TOKEN_SOFT_LIMIT");
  }
}
const unknownUsage = evaluateGroqNewEventAdmission({
  currentRequests: 0, currentTokens: null, tokenUsageKnown: false,
  requestHardLimit: 1_000, tokenHardLimit: 200_000, softRatio: 0.85,
});
assert.equal(unknownUsage.eligible, false);
assert.equal(unknownUsage.reason, "GROQ_DAILY_TOKEN_USAGE_UNKNOWN");
assert.equal(evaluateGroqNewEventAdmission({
  currentRequests: 844, currentTokens: 0, tokenUsageKnown: true,
  requestHardLimit: 1_000, tokenHardLimit: 200_000, softRatio: 0.85,
}).reason, "GROQ_DAILY_REQUEST_SOFT_LIMIT");
assert.equal(groqSequentialConcurrencyApproved(1), true);
assert.equal(groqSequentialConcurrencyApproved(2), false);
assert.equal(groqSequentialConcurrencyApproved(0), false);

console.log("Groq capacity policy/configuration checks passed (offline only)");
