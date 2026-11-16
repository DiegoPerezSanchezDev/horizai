import assert from "node:assert/strict";
import { buildCloudflareStageCapacityReport } from "../lib/agents/runtime/cloudflare-stage-capacity.ts";
import { CLOUDFLARE_GPT_OSS_20B_NEURON_RATES, DAILY_SOFT_LIMIT_RATIO, defaultOfflineCapacityConfig, getFreeProviderCapacitySnapshot, normalEventStages } from "../lib/agents/runtime/free-provider-router.ts";
import { resolveGroqDailyRequestHardCap } from "../lib/agents/runtime/request-budget.ts";

// Reuse the audited conservative stage fixture estimate entirely offline.
// Values are process-local fixtures only; this script makes no provider/DB calls.
const fixtureModels = {
  AGENT_MODEL_VERIFY: "openai/gpt-oss-20b",
  AGENT_MODEL_TRANSLATE: "openai/gpt-oss-20b",
  AGENT_MODEL_EDITOR: "openai/gpt-oss-20b",
  AGENT_MODEL_CLASSIFY: "openai/gpt-oss-20b",
  AGENT_MODEL_RANK: "openai/gpt-oss-20b",
  AGENT_MODEL_CRITIC: "openai/gpt-oss-20b",
  CLOUDFLARE_DAILY_NEURON_LIMIT: "10000",
  FREE_PROVIDER_SOFT_LIMIT_RATIO: String(DAILY_SOFT_LIMIT_RATIO),
  CLOUDFLARE_INPUT_NEURONS_PER_MILLION_TOKENS: String(CLOUDFLARE_GPT_OSS_20B_NEURON_RATES.inputNeuronsPerMillionTokens),
  CLOUDFLARE_OUTPUT_NEURONS_PER_MILLION_TOKENS: String(CLOUDFLARE_GPT_OSS_20B_NEURON_RATES.outputNeuronsPerMillionTokens),
  CLOUDFLARE_NEURON_SAFETY_MARGIN_BPS: String(CLOUDFLARE_GPT_OSS_20B_NEURON_RATES.safetyMarginBps),
  GROQ_DAILY_REQUEST_HARD_CAP: "20",
};
for (const [name, value] of Object.entries(fixtureModels)) process.env[name] = value;

const now = new Date("2026-09-25T12:00:00.000Z");
const dateUtc = now.toISOString().slice(0, 10);
const hardGroqRequests = resolveGroqDailyRequestHardCap(process.env).limit;
const softRatio = DAILY_SOFT_LIMIT_RATIO;
const softGroqRequests = Math.floor(hardGroqRequests * softRatio);
const cloudflareHardNeurons = 10_000;
const cloudflareSoftNeurons = Math.floor(cloudflareHardNeurons * softRatio);
const eventRequests = normalEventStages.length;
const capacityReport = buildCloudflareStageCapacityReport();
const conservativeEventNeurons = capacityReport.conservativeFullEventReservationEstimate;
const eventInputTokens = capacityReport.stages.reduce((sum, stage) => sum + stage.estimatedInputTokens, 0);
const eventOutputTokens = capacityReport.stages.reduce((sum, stage) => sum + stage.maxOutputTokens, 0);
const eventTokens = eventInputTokens + eventOutputTokens;
const configs = {
  groq: defaultOfflineCapacityConfig("groq", "openai/gpt-oss-20b", hardGroqRequests, null),
  cloudflare_workers_ai: defaultOfflineCapacityConfig("cloudflare_workers_ai", "@cf/openai/gpt-oss-20b", null, cloudflareHardNeurons),
};

function emptyUsage(provider) {
  return { provider, dateUtc, requestsReserved: 0, requestsDispatched: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenUsageKnown: false, unknownTokenRequests: 0, neuronsUsed: 0, neuronUsageKnown: true };
}

function simulate(candidateCount) {
  const usage = { groq: emptyUsage("groq"), cloudflare_workers_ai: emptyUsage("cloudflare_workers_ai") };
  const assignments = [];
  const blocked = [];
  for (let index = 0; index < candidateCount; index += 1) {
    const snapshot = getFreeProviderCapacitySnapshot({
      configs,
      usage,
      blocks: { groq: null, cloudflare_workers_ai: null },
      now,
      estimatedEventRequests: eventRequests,
      estimatedEventTokens: eventTokens,
      estimatedEventInputTokens: eventInputTokens,
      estimatedEventOutputTokens: eventOutputTokens,
      estimatedPeakRequestTokens: Math.max(...capacityReport.stages.map((stage) => stage.estimatedInputTokens + stage.maxOutputTokens)),
      estimatedEventNeurons: conservativeEventNeurons,
    });
    const provider = snapshot.groq.eligible ? "groq" : snapshot.cloudflare_workers_ai.eligible ? "cloudflare_workers_ai" : null;
    if (!provider) {
      blocked.push({ candidate: index + 1, groqReason: snapshot.groq.reason, cloudflareReason: snapshot.cloudflare_workers_ai.reason });
      continue;
    }
    const providerUsage = usage[provider];
    providerUsage.requestsReserved += eventRequests;
    providerUsage.requestsDispatched += eventRequests;
    providerUsage.totalTokens += eventTokens;
    providerUsage.inputTokens += eventInputTokens;
    providerUsage.outputTokens += eventOutputTokens;
    if (provider === "cloudflare_workers_ai") providerUsage.neuronsUsed += conservativeEventNeurons;
    assignments.push({ candidate: index + 1, provider, stageCount: eventRequests, estimatedNeurons: provider === "cloudflare_workers_ai" ? conservativeEventNeurons : null });
  }
  return {
    candidates: candidateCount,
    groqAssigned: assignments.filter((item) => item.provider === "groq").length,
    cloudflareAssigned: assignments.filter((item) => item.provider === "cloudflare_workers_ai").length,
    admitted: assignments.length,
    blocked: blocked.length,
    assignments,
    blockedDetails: blocked,
  };
}

const groqOnly = simulate(10);
assert.equal(groqOnly.groqAssigned, 2, "hard 20 with soft 17 admits two six-call paths");
assert.equal(Math.floor(softGroqRequests / eventRequests), 2);
const cloudflareOnlyCapacity = Math.floor(cloudflareSoftNeurons / conservativeEventNeurons);
assert.equal(cloudflareOnlyCapacity, 3, "8500 / conservative Neurons admits three full paths");
const scenarios = [10, 12, 15].map(simulate);
assert.deepEqual(scenarios.map(({ groqAssigned, cloudflareAssigned, blocked }) => [groqAssigned, cloudflareAssigned, blocked]), [[2, 3, 5], [2, 3, 7], [2, 3, 10]]);

console.log(JSON.stringify({
  label: "CONFIGURED_ARCHITECTURE_CAPACITY_ONLY",
  providerCalls: 0,
  supabaseRemoteCalls: 0,
  notProductionCapacity: true,
  notPublishedArticleCapacity: true,
  groq: { hardRequests: hardGroqRequests, softRatio, softThresholdRequests: softGroqRequests, requestsPerFullPath: eventRequests, fullPathsAdmitted: groqOnly.groqAssigned, tokenHardLimit: "NOT_CONFIGURED", tpm: "NOT_CONFIGURED", rpm: "NOT_CONFIGURED" },
  cloudflareWorkersAi: { hardNeurons: cloudflareHardNeurons, softNeurons: cloudflareSoftNeurons, conservativeFullPathNeurons: conservativeEventNeurons, fullPathsAdmitted: cloudflareOnlyCapacity },
  combinedCapacity: { groqFullPaths: groqOnly.groqAssigned, cloudflareFullPaths: cloudflareOnlyCapacity, fullPaths: groqOnly.groqAssigned + cloudflareOnlyCapacity },
  scenarios,
  productionRoutingEnabled: false,
}, null, 2));
