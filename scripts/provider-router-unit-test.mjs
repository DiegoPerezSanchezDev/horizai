import assert from "node:assert/strict";
import { assertEventStageAssignment, assignEventProvider, defaultOfflineCapacityConfig, estimateCloudflareNeurons, estimateEventTokenRequirement, freeProviderRouterEnabled, getFreeProviderCapacitySnapshot, normalizeRateLimitState, normalEventStages, readProviderCapacityConfig, routeFreeProviderEvent } from "../lib/agents/runtime/free-provider-router.ts";
import { assertFreeProviderRequest, freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";

const now = new Date("2026-09-23T12:00:00Z");
const dateUtc = now.toISOString().slice(0, 10);
const configs = {
  groq: defaultOfflineCapacityConfig("groq", "openai/gpt-oss-20b", 20, 10_000),
  cloudflare_workers_ai: defaultOfflineCapacityConfig("cloudflare_workers_ai", "@cf/openai/gpt-oss-20b", null, 10_000),
};
const usage = (provider, { requests = 0, tokens = 0, neurons = 0, tokenKnown = true, neuronKnown = true } = {}) => ({ provider, dateUtc, requestsReserved: requests, requestsDispatched: requests, inputTokens: tokens, outputTokens: 0, totalTokens: tokens, tokenUsageKnown: tokenKnown, unknownTokenRequests: tokenKnown ? 0 : 1, neuronsUsed: neurons, neuronUsageKnown: neuronKnown });
const route = (groq = usage("groq"), cf = usage("cloudflare_workers_ai"), blocks = { groq: null, cloudflare_workers_ai: null }, options = {}) => routeFreeProviderEvent({ enabled: true, configs, usage: { groq, cloudflare_workers_ai: cf }, blocks, now, estimatedEventTokens: 1_000, estimatedGroqEventTokens: 1_000, estimatedEventNeurons: 1_000, ...options });

assert.equal(freeProviderRouterEnabled(""), false);
assert.equal(freeProviderRouterEnabled("true"), true);
assert.throws(() => freeProviderRouterEnabled("maybe"));
const previousFlag = process.env.FREE_PROVIDER_ROUTER_ENABLED;
try {
  process.env.FREE_PROVIDER_ROUTER_ENABLED = "true";
  const { createProductionPipeline } = await import("../lib/agents/pipeline/create-production-pipeline.ts");
  assert.throws(() => createProductionPipeline(), /FREE_PROVIDER_ROUTER_NOT_ACTIVATED_IN_PRODUCTION/);
} finally {
  if (previousFlag === undefined) delete process.env.FREE_PROVIDER_ROUTER_ENABLED;
  else process.env.FREE_PROVIDER_ROUTER_ENABLED = previousFlag;
}

assert.equal(readProviderCapacityConfig("cloudflare_workers_ai", {}).configured, false);
const cfConfigured = readProviderCapacityConfig("cloudflare_workers_ai", {
  CLOUDFLARE_ACCOUNT_ID: "1234567890abcdef1234567890abcdef", CLOUDFLARE_AI_API_TOKEN: "offline",
  CLOUDFLARE_DAILY_NEURON_LIMIT: "10000",
});
assert.equal(cfConfigured.configured, true);
assert.equal(cfConfigured.usageUnit, "neurons");
assert.equal(cfConfigured.dailyNeuronAllocation, 10_000);
assert.equal(cfConfigured.dailyRequestLimit, undefined, "Cloudflare does not require an unverified request/day limit");
assert.equal(cfConfigured.model, "@cf/openai/gpt-oss-20b");
const cfWithoutRequestCap = route(usage("groq", { requests: 17 }), usage("cloudflare_workers_ai"), undefined, { configs: { ...configs, cloudflare_workers_ai: cfConfigured } });
assert.equal(cfWithoutRequestCap.selectedProvider, null, "Cloudflare must remain unavailable to automatic production routing");
assert.equal(cfWithoutRequestCap.cloudflareWorkersAiCapacity.eligible, true, "capacity availability remains independent from production approval");
assert.equal(cfWithoutRequestCap.cloudflareWorkersAiCapacity.productionEligible, false);
assert.equal(cfWithoutRequestCap.cloudflareWorkersAiCapacity.reason, "FREE_CAPACITY_AVAILABLE");
assert.equal(cfWithoutRequestCap.cloudflareWorkersAiCapacity.requestUsageRatio, null);
assert.equal(cfWithoutRequestCap.cloudflareWorkersAiCapacity.requestsRemainingHard, null);
const legacyCfConfig = readProviderCapacityConfig("cloudflare_workers_ai", {
  CLOUDFLARE_ACCOUNT_ID: "1234567890abcdef1234567890abcdef", CLOUDFLARE_AI_API_TOKEN: "offline",
  CLOUDFLARE_FREE_DAILY_NEURON_ALLOCATION: "10000",
});
assert.equal(legacyCfConfig.dailyNeuronAllocation, 10_000, "legacy allocation variable remains backwards compatible");
assert.throws(() => assertFreeProviderRequest("cerebras", "gpt-oss-120b", freeProviderPolicy.cerebras.endpoint), { code: "PAID_PROVIDER_FORBIDDEN" });

assert.equal(route().selectedProvider, "groq", "Groq is the primary provider");
assert.equal(route(usage("groq", { requests: 17 })).groqCapacity.requestUsageRatio, 0.85);
assert.equal(route(usage("groq", { requests: 17 })).selectedProvider, null);
assert.equal(route(usage("groq", { tokens: 8_500 })).selectedProvider, null);
assert.equal(route(usage("groq", { requests: 11 })).selectedProvider, null, "Cloudflare is not an automatic fallback while structured output remains unapproved");
assert.equal(route(usage("groq", { tokens: 7_600 })).groqCapacity.reason, "GROQ_DAILY_TOKEN_SOFT_LIMIT");
const groqTokenSoftBlocked = route(usage("groq", { tokens: 8_600 }));
assert.equal(groqTokenSoftBlocked.groqCapacity.reason, "GROQ_DAILY_TOKEN_SOFT_LIMIT");
assert.equal(groqTokenSoftBlocked.selectedProvider, null);
assert.equal(groqTokenSoftBlocked.reason, "CLOUDFLARE_REQUIRED_STAGES_NOT_VALIDATED", "capacity pressure cannot bypass Cloudflare activation gates");
assert.equal(route(usage("groq", { requests: 17 }), usage("cloudflare_workers_ai", { requests: 48 })).selectedProvider, null, "a synthetic request count does not invent a Cloudflare daily request cap");

const cloudflareSoft = route(usage("groq", { requests: 17 }), usage("cloudflare_workers_ai", { neurons: 7_500 }));
assert.equal(cloudflareSoft.cloudflareWorkersAiCapacity.neuronUsageRatio, 0.75);
assert.equal(cloudflareSoft.cloudflareWorkersAiCapacity.reason, "DAILY_NEURON_SOFT_LIMIT");
assert.equal(cloudflareSoft.cloudflareWorkersAiCapacity.eligible, false);
const cloudflareHard = route(usage("groq", { requests: 17 }), usage("cloudflare_workers_ai", { neurons: 9_500 }), undefined, { estimatedEventNeurons: 600 });
assert.equal(cloudflareHard.cloudflareWorkersAiCapacity.reason, "HARD_CAPACITY_EXHAUSTED");
assert.equal(cloudflareHard.selectedProvider, null, "hard free neuron allocation cannot be exceeded");
assert.equal(route(usage("groq", { requests: 17 }), usage("cloudflare_workers_ai", { neuronKnown: false })).cloudflareWorkersAiCapacity.reason, "UNKNOWN_NEURON_USAGE", "unknown Cloudflare usage fails closed");

const groqHardCloudflareAvailable = route(usage("groq", { requests: 20 }), usage("cloudflare_workers_ai"));
assert.equal(groqHardCloudflareAvailable.groqCapacity.reason, "GROQ_DAILY_REQUEST_HARD_LIMIT");
assert.equal(groqHardCloudflareAvailable.cloudflareWorkersAiCapacity.eligible, true, "Groq at 20/20 does not consume Cloudflare Neuron capacity");
assert.equal(groqHardCloudflareAvailable.selectedProvider, null, "available Cloudflare capacity still cannot bypass production gates");
const cloudflareHardGroqAvailable = route(usage("groq", { requests: 10 }), usage("cloudflare_workers_ai", { neurons: 9_500 }), undefined, { estimatedEventNeurons: 1_000 });
assert.equal(cloudflareHardGroqAvailable.cloudflareWorkersAiCapacity.eligible, false);
assert.equal(cloudflareHardGroqAvailable.groqCapacity.eligible, true, "exhausted Cloudflare Neurons do not block Groq request capacity");
const projectedGroqSoft = route(usage("groq", { requests: 12 }), usage("cloudflare_workers_ai"), undefined, { estimatedEventRequests: 6 });
assert.equal(projectedGroqSoft.groqCapacity.dimensions.requests.projectedUsage, 18);
assert.equal(projectedGroqSoft.groqCapacity.reason, "GROQ_DAILY_REQUEST_SOFT_LIMIT", "NEW full-event projection crossing 85% is rejected");

const n1PlanningConfigs = {
  groq: defaultOfflineCapacityConfig("groq", "openai/gpt-oss-20b", 1_000, 200_000),
  cloudflare_workers_ai: configs.cloudflare_workers_ai,
};
const n1PlanningDecision = route(usage("groq"), usage("cloudflare_workers_ai"), undefined, {
  configs: n1PlanningConfigs,
  estimatedGroqEventTokens: undefined,
});
assert.equal(n1PlanningDecision.estimatedGroqEventPlanningTokens, 12_934);
assert.equal(n1PlanningDecision.groqCapacity.dimensions.tokens.projectedUsage, 12_934, "new Groq events project N=1 plus 25%, not summed stage maxima");

const snapshotAtIndependentCapacities = getFreeProviderCapacitySnapshot({ configs, usage: { groq: usage("groq", { requests: 20 }), cloudflare_workers_ai: usage("cloudflare_workers_ai") }, blocks: { groq: null, cloudflare_workers_ai: null }, now, estimatedEventRequests: 6, estimatedEventTokens: 1_000, estimatedEventNeurons: 2_381 });
assert.equal(snapshotAtIndependentCapacities.groq.dimensions.requests.hardLimit, 20);
assert.equal(snapshotAtIndependentCapacities.groq.eligible, false);
assert.equal(snapshotAtIndependentCapacities.cloudflare_workers_ai.dimensions.neurons.hardLimit, 10_000);
assert.equal(snapshotAtIndependentCapacities.cloudflare_workers_ai.eligible, true, "capacity snapshot carries independent dimensions");

const groqBlock = normalizeRateLimitState("groq", now.toISOString(), { retryAfter: "15", retryAfterSeconds: 15, resetRequests: null, resetRequestsSeconds: null, resetTokens: "45s", resetTokensSeconds: 45, limitRequests: null, remainingRequests: null, limitTokens: null, remainingTokens: "0", limitRequestsDay: null, remainingRequestsDay: null, resetRequestsDay: null, limitTokensMinute: null, remainingTokensMinute: null, resetTokensMinute: null }, true);
assert.equal(groqBlock.blockedUntil, "2026-09-23T12:00:45.000Z");
const groqTemporarilyBlocked = route(usage("groq"), usage("cloudflare_workers_ai"), { groq: groqBlock, cloudflare_workers_ai: null });
assert.equal(groqTemporarilyBlocked.selectedProvider, null, "a Groq 429 never routes automatically to an unapproved provider");
assert.equal(groqTemporarilyBlocked.groqCapacity.temporaryBlock, true);
assert.equal(groqTemporarilyBlocked.groqCapacity.reason, "GROQ_TEMPORARILY_BLOCKED");
assert.equal(groqTemporarilyBlocked.cloudflareWorkersAiCapacity.eligible, true, "Groq temporary block does not contaminate Cloudflare capacity");
const noHeaders = normalizeRateLimitState("cloudflare_workers_ai", now.toISOString(), null, true);
assert.equal(noHeaders.blockedUntil, "2026-09-24T00:00:00.000Z");
const newEventAfterCf429 = route(usage("groq"), usage("cloudflare_workers_ai"), { groq: null, cloudflare_workers_ai: noHeaders });
assert.equal(newEventAfterCf429.selectedProvider, "groq", "only a new event may reconsider the primary provider");
assert.equal(newEventAfterCf429.cloudflareWorkersAiCapacity.temporaryBlock, true);
assert.equal(newEventAfterCf429.groqCapacity.eligible, true, "Cloudflare temporary block does not contaminate Groq capacity");
assert.equal(route(usage("groq"), usage("cloudflare_workers_ai"), undefined, { now: new Date("2026-09-23T12:01:00Z") }).selectedProvider, "groq");

const unknownTokens = route(usage("groq", { tokenKnown: false }));
assert.equal(unknownTokens.selectedProvider, null, "unknown Groq usage and unapproved Cloudflare structured output both fail closed");
assert.equal(route(usage("groq", { requests: 17 }), usage("cloudflare_workers_ai"), undefined, { configs: { ...configs, cloudflare_workers_ai: { ...configs.cloudflare_workers_ai, configured: false } } }).selectedProvider, null);
assert.equal(route(usage("groq"), usage("cloudflare_workers_ai"), undefined, { configs: { ...configs, cloudflare_workers_ai: { ...configs.cloudflare_workers_ai, model: "@cf/openai/gpt-oss-120b" } } }).cloudflareWorkersAiCapacity.reason, "PAID_PROVIDER_FORBIDDEN");
assert.equal(route(undefined, undefined, undefined, { enabled: false }).reason, "ROUTER_DISABLED");

const sticky = assignEventProvider("event-sticky", route());
assert.equal(sticky.provider, "groq");
assertEventStageAssignment(sticky, "event-sticky", "groq", "openai/gpt-oss-20b");
assert.throws(() => assertEventStageAssignment(sticky, "event-sticky", "cloudflare_workers_ai", "@cf/openai/gpt-oss-20b"));
assert.throws(() => assignEventProvider("sticky-cloudflare", route(usage("groq", { requests: 17 }))), /BLOCKED_FREE_CAPACITY_EXHAUSTED/);

const estimated = estimateEventTokenRequirement({ stages: normalEventStages.map((stage) => ({ stage, maxOutputTokens: 1200, conservativeInputTokens: 800, historicalInputTokens: stage === "editor" ? 1100 : undefined, knownInputChars: stage === "critic" ? 2400 : undefined })), charsPerTokenLowerBound: 2, safetyMarginRatio: 1.2 });
assert.equal(estimated, Math.ceil((4 * 2000 + 2300 + 2400) * 1.2));
assert.equal(estimateCloudflareNeurons({ inputTokens: 1_000_000, outputTokens: 1_000_000, inputNeuronsPerMillionTokens: 18_182, outputNeuronsPerMillionTokens: 27_273, safetyMarginBps: 12_500 }), 56_819);
console.log("provider:router:unit: OK (offline only)");
