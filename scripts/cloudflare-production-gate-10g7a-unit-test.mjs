import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cloudflareAllRequiredStagesValidated, evaluateCloudflareFullEventEligibility, getCloudflareActivationGateState, normalEventStages, selectProviderForNewFullEvent } from "../lib/agents/runtime/cloudflare-stage-validation.ts";
import { assignEventProvider, assertEventStageAssignment, defaultOfflineCapacityConfig, routeFreeProviderEvent } from "../lib/agents/runtime/free-provider-router.ts";
import { FREE_TIER_DAILY_REQUEST_LIMIT, resolveGroqDailyRequestHardCap, validateCostGuardConfig } from "../lib/agents/runtime/request-budget.ts";
import { initialRequestsRequired } from "../lib/agents/pipeline/pipeline-budget.ts";
import { plannedEventLimit } from "../lib/agents/pipeline/scheduler/scheduler-budget.ts";
import { schedulerSlots } from "../lib/agents/pipeline/scheduler/scheduler-types.ts";

const readyGates = {
  semanticQualityGateValidated: true,
  capacityProductionReady: true,
  schedulerThroughputReady: true,
  freeOnlySafetyValidated: true,
  productionRoutingEnabled: true,
};

assert.deepEqual(normalEventStages, ["verifier", "translator", "editor", "classifier", "ranker", "critic"]);
assert.equal(cloudflareAllRequiredStagesValidated(), true, "technical 6/6 remains independent from all operational approvals");
assert.deepEqual(getCloudflareActivationGateState(), {
  technicalAllStagesValidated: true,
  semanticQualityGateValidated: false,
  capacityProductionReady: false,
  schedulerThroughputReady: false,
  freeOnlySafetyValidated: false,
  productionRoutingEnabled: false,
});

const blockedReasons = new Map([
  ["semanticQualityGateValidated", "SEMANTIC_QUALITY_NOT_VALIDATED"],
  ["capacityProductionReady", "CAPACITY_PRODUCTION_NOT_READY"],
  ["schedulerThroughputReady", "SCHEDULER_THROUGHPUT_NOT_READY"],
  ["freeOnlySafetyValidated", "FREE_ONLY_SAFETY_NOT_VALIDATED"],
  ["productionRoutingEnabled", "PRODUCTION_ROUTING_DISABLED"],
]);
for (const [gate, reason] of blockedReasons) {
  const activationGates = { ...readyGates, [gate]: false };
  assert.deepEqual(evaluateCloudflareFullEventEligibility({ routerEnabled: true, allRequiredStagesValidated: true, freeCapacityAvailable: true, activationGates }), { eligible: false, reason }, `${gate} must independently fail closed`);
  assert.deepEqual(selectProviderForNewFullEvent({ routerEnabled: true, groqCapacityAvailable: false, cloudflareCapacityAvailable: true, cloudflareAllRequiredStagesValidated: true, cloudflareActivationGates: activationGates }), { provider: null, reason: `CLOUDFLARE_${reason}` });
}
assert.deepEqual(selectProviderForNewFullEvent({ routerEnabled: true, groqCapacityAvailable: false, cloudflareCapacityAvailable: true, cloudflareAllRequiredStagesValidated: true, cloudflareActivationGates: readyGates }), { provider: "cloudflare_workers_ai", reason: "GROQ_CAPACITY_UNAVAILABLE" }, "all-true branch is policy simulation only");
assert.deepEqual(selectProviderForNewFullEvent({ routerEnabled: true, groqCapacityAvailable: true, cloudflareCapacityAvailable: true, cloudflareAllRequiredStagesValidated: true }), { provider: "groq", reason: "GROQ_PREFERRED" }, "Groq preference does not require Cloudflare approvals");

const now = new Date("2026-09-25T12:00:00.000Z");
const dateUtc = now.toISOString().slice(0, 10);
const emptyUsage = (provider) => ({ provider, dateUtc, requestsReserved: 0, requestsDispatched: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenUsageKnown: true, unknownTokenRequests: 0, neuronsUsed: 0, neuronUsageKnown: true });
const lockedConfigs = {
  groq: defaultOfflineCapacityConfig("groq", "openai/gpt-oss-20b", 20, 10_000),
  cloudflare_workers_ai: defaultOfflineCapacityConfig("cloudflare_workers_ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", null, 10_000),
};
const productionDisabled = routeFreeProviderEvent({ enabled: false, configs: lockedConfigs, usage: { groq: emptyUsage("groq"), cloudflare_workers_ai: emptyUsage("cloudflare_workers_ai") }, blocks: { groq: null, cloudflare_workers_ai: null }, now, estimatedEventTokens: 1_000, estimatedEventNeurons: 400 });
assert.equal(productionDisabled.selectedProvider, null);
assert.equal(productionDisabled.reason, "ROUTER_DISABLED");

const dailyRequestCap = FREE_TIER_DAILY_REQUEST_LIMIT;
const groqSoftRequestCap = Math.floor(dailyRequestCap * 0.85);
const requestsPerFullEvent = initialRequestsRequired();
const groqOnlyEventCapacity = Math.floor((groqSoftRequestCap - 1) / requestsPerFullEvent);
const cloudflareSoftNeurons = 8_500;
const cloudflareHardNeurons = 10_000;
const conservativeNeuronsPerEvent = 2_381;
const observedStyleNeuronsPerEvent = 405;
const cloudflareConservativeEventCapacity = Math.floor(cloudflareSoftNeurons / conservativeNeuronsPerEvent);
const cloudflareObservedStyleTheoreticalCapacity = Math.floor(cloudflareSoftNeurons / observedStyleNeuronsPerEvent);
assert.equal(requestsPerFullEvent, 6);
assert.equal(groqSoftRequestCap, 17);
assert.equal(groqOnlyEventCapacity, 2);
assert.equal(cloudflareConservativeEventCapacity, 3);
assert.equal(cloudflareObservedStyleTheoreticalCapacity, 20);
assert.equal(cloudflareHardNeurons, 10_000);

const scenarioResults = [10, 12, 15].map((targetCandidates) => ({
  targetCandidates,
  groqOnly: { admitted: Math.min(targetCandidates, groqOnlyEventCapacity), blocked: Math.max(0, targetCandidates - groqOnlyEventCapacity), requestsRequired: targetCandidates * requestsPerFullEvent },
  cloudflareOnlyConservative: { admitted: Math.min(targetCandidates, cloudflareConservativeEventCapacity), blocked: Math.max(0, targetCandidates - cloudflareConservativeEventCapacity), reservedNeurons: targetCandidates * conservativeNeuronsPerEvent, softCapExceededBy: Math.max(0, targetCandidates * conservativeNeuronsPerEvent - cloudflareSoftNeurons) },
  providerScopedCapacityOnly: { admitted: Math.min(targetCandidates, groqOnlyEventCapacity + cloudflareConservativeEventCapacity), groqEvents: Math.min(targetCandidates, groqOnlyEventCapacity), cloudflareEvents: Math.min(Math.max(0, targetCandidates - groqOnlyEventCapacity), cloudflareConservativeEventCapacity), blocked: Math.max(0, targetCandidates - groqOnlyEventCapacity - cloudflareConservativeEventCapacity) },
  currentProductionRouter: { admitted: 0, reason: "ROUTER_DISABLED" },
}));
assert.deepEqual(scenarioResults.map((row) => row.providerScopedCapacityOnly.admitted), [5, 5, 5]);
assert.deepEqual(scenarioResults.map((row) => row.currentProductionRouter.admitted), [0, 0, 0]);

let hypotheticalGroqCapacity = groqOnlyEventCapacity;
let hypotheticalCloudflareCapacity = cloudflareConservativeEventCapacity;
const stickyAssignments = [];
for (let index = 0; index < 10; index += 1) {
  const decision = selectProviderForNewFullEvent({
    routerEnabled: true,
    groqCapacityAvailable: hypotheticalGroqCapacity > 0,
    cloudflareCapacityAvailable: hypotheticalCloudflareCapacity > 0,
    cloudflareAllRequiredStagesValidated: true,
    cloudflareActivationGates: readyGates,
  });
  if (decision.provider === "groq") hypotheticalGroqCapacity -= 1;
  else if (decision.provider === "cloudflare_workers_ai") hypotheticalCloudflareCapacity -= 1;
  else break;
  const assignment = assignEventProvider(`offline-capacity-${index + 1}`, { selectedProvider: decision.provider, selectedModel: decision.provider === "groq" ? "openai/gpt-oss-20b" : "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
  assertEventStageAssignment(assignment, assignment.eventKey, assignment.provider, assignment.model);
  stickyAssignments.push({ provider: assignment.provider, stages: normalEventStages.length });
}
assert.deepEqual(stickyAssignments.slice(0, 5).map((row) => row.provider), ["groq", "groq", "cloudflare_workers_ai", "cloudflare_workers_ai", "cloudflare_workers_ai"]);
assert.equal(stickyAssignments.length, 5);

assert.equal(schedulerSlots.length, 3);
assert.equal(plannedEventLimit(groqSoftRequestCap, 3), 2);
assert.equal(schedulerSlots.length * 3, 9, "configured planner ceiling is three conceptual slots times three planned events");
const schedulerRunnerSource = readFileSync("lib/agents/pipeline/scheduler/scheduler-runner.ts", "utf8");
const schedulerExecutionSource = readFileSync("lib/agents/pipeline/scheduler/scheduler-execution.ts", "utf8");
const netlifyConfig = readFileSync("netlify.toml", "utf8");
assert.match(schedulerRunnerSource, /SCHEDULER_MAX_EVENTS_PER_RUN",\s*3/);
assert.match(schedulerExecutionSource, /EXECUTION_MAX_EVENTS_PER_RUN\s*=\s*1/);
assert.doesNotMatch(netlifyConfig, /^\s*schedule\s*=/m, "no scheduled Netlify function is active");

assert.equal(dailyRequestCap, 20, "the safe legacy/default request fixture remains 20 for this historical Cloudflare comparison");
assert.deepEqual(resolveGroqDailyRequestHardCap({ GROQ_DAILY_REQUEST_HARD_CAP: "1000", AGENT_DAILY_REQUEST_LIMIT: "20" }), { limit: 1_000, source: "GROQ_DAILY_REQUEST_HARD_CAP" });
assert.deepEqual(resolveGroqDailyRequestHardCap({ AGENT_DAILY_REQUEST_LIMIT: "20" }), { limit: 20, source: "LEGACY_GROQ_FALLBACK" });
assert.doesNotThrow(() => validateCostGuardConfig({ dailyRequestLimit: 1_000, maxOutputTokens: 1_200, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "json_object" }));
assert.throws(() => validateCostGuardConfig({ dailyRequestLimit: 1_001, maxOutputTokens: 1_200, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "json_object" }), (error) => error.code === "cost_guard_violation");
const agentRunnerSource = readFileSync("lib/agents/runtime/agent-runner.ts", "utf8");
const agentLoggerSource = readFileSync("lib/agents/runtime/agent-logger.ts", "utf8");
assert.match(agentRunnerSource, /reserveGroqCapacity!\(/, "AgentRunner reserves Groq request and tokens atomically");
assert.doesNotMatch(agentRunnerSource, /reserveProviderRequest\(/, "AgentRunner cannot fall back to the request-only Groq reservation");
assert.match(agentRunnerSource, /getProviderDailyUsage\("cloudflare_workers_ai"/);
assert.doesNotMatch(agentRunnerSource, /defaultDailyRequestBudget/, "normal AgentRunner does not use the former shared daily budget");
assert.match(agentLoggerSource, /rpc\("reserve_provider_agent_request"/);
assert.match(agentLoggerSource, /rpc\("reserve_groq_request_and_tokens_m35"/);
assert.match(agentLoggerSource, /rpc\("reserve_cloudflare_neuron_capacity"/);
assert.equal(cloudflareOnlySettlementDecision(8, 3, 10, null), "SETTLEMENT_NOT_REQUIRED_FOR_INITIAL_TARGET");
assert.equal(cloudflareOnlySettlementDecision(3, 3, 10, 20), "SETTLEMENT_REQUIRED_IN_HYPOTHETICAL_WITH_ACTUAL_USAGE");
assert.equal(cloudflareOnlySettlementDecision(3, 3, 10, null), "UNDETERMINED_ACTUAL_NEURON_USAGE_UNKNOWN");

function cloudflareOnlySettlementDecision(groqEvents, conservativeCloudflareEvents, target, settledCloudflareEvents) {
  if (groqEvents + conservativeCloudflareEvents >= target) return "SETTLEMENT_NOT_REQUIRED_FOR_INITIAL_TARGET";
  if (settledCloudflareEvents !== null && groqEvents + settledCloudflareEvents >= target) return "SETTLEMENT_REQUIRED_IN_HYPOTHETICAL_WITH_ACTUAL_USAGE";
  return "UNDETERMINED_ACTUAL_NEURON_USAGE_UNKNOWN";
}

console.log("cloudflare:production-gate:10g7a:unit: OK (offline simulation only; 0 provider inference)");
