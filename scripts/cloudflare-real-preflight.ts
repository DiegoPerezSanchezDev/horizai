import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { CLOUDFLARE_LLAMA_3_3_70B_NEURON_RATES, freeProviderRouterEnabled, readCloudflareNeuronRates, readProviderCapacityConfig } from "../lib/agents/runtime/free-provider-router.ts";
import { assertFreeProviderRequest, CLOUDFLARE_LLAMA_VALIDATION_MODEL, cloudflareModelPolicy, freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { assertCloudflareUtcPeriod, checkCloudflareBaselineCapacity, createCloudflareAccountingBaseline } from "../lib/agents/runtime/provider-accounting-baseline.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { EXPECTED_DAILY_NEURON_LIMIT, MAX_OUTPUT_TOKENS, MAX_REQUESTS, MAX_RETRIES, estimateValidationFixtureInputTokens, estimateValidationFixtureNeurons } from "./cloudflare-validation-fixture.ts";

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

check(process.argv.length === 2, "PREFLIGHT_TAKES_NO_ARGUMENTS");

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.CLOUDFLARE_AI_API_TOKEN?.trim();
const allocation = Number(process.env.CLOUDFLARE_DAILY_NEURON_LIMIT);
const validationEnv = { ...process.env, CLOUDFLARE_MODEL: CLOUDFLARE_LLAMA_VALIDATION_MODEL };
const capacity = readProviderCapacityConfig("cloudflare_workers_ai", validationEnv);
const model = CLOUDFLARE_LLAMA_VALIDATION_MODEL;
const endpoint = capacity.endpoint;
const dailyDateUtc = new Date().toISOString().slice(0, 10);
const rates = readCloudflareNeuronRates(process.env, model);
const inputTokenEstimate = estimateValidationFixtureInputTokens();
const estimatedNeurons = estimateValidationFixtureNeurons(model);

check(accountId && token, "BLOCKED_CLOUDFLARE_CONFIGURATION");
check(Number.isSafeInteger(allocation) && allocation === EXPECTED_DAILY_NEURON_LIMIT, "BLOCKED_CLOUDFLARE_CONFIGURATION");
check(capacity.configured && capacity.dailyNeuronAllocation === allocation && capacity.model === model, "BLOCKED_CLOUDFLARE_CAPACITY");
check(capacity.softLimitRatio === 0.85, "BLOCKED_CLOUDFLARE_SOFT_LIMIT_MUST_BE_85_PERCENT");
check(!freeProviderRouterEnabled(), "BLOCKED_PRODUCTION_ROUTER_MUST_REMAIN_DISABLED");
check(freeProviderPolicy.cloudflare_workers_ai.costClass === "PERMANENT_FREE_APPROVED", "BLOCKED_FREE_ONLY_POLICY");
check(cloudflareModelPolicy[model].freeApproved && cloudflareModelPolicy[model].structuredProductionApproved === "CANDIDATE" && !cloudflareModelPolicy[model].productionRoutingEnabled, "BLOCKED_CLOUDFLARE_MODEL_POLICY");
check(rates.inputNeuronsPerMillionTokens === CLOUDFLARE_LLAMA_3_3_70B_NEURON_RATES.inputNeuronsPerMillionTokens
  && rates.outputNeuronsPerMillionTokens === CLOUDFLARE_LLAMA_3_3_70B_NEURON_RATES.outputNeuronsPerMillionTokens
  && rates.safetyMarginBps === CLOUDFLARE_LLAMA_3_3_70B_NEURON_RATES.safetyMarginBps, "BLOCKED_CLOUDFLARE_MODEL_RATES");
assertFreeProviderRequest("cloudflare_workers_ai", model, endpoint);

const logger = new SupabaseAgentLogger(createSupabaseServerClient());
const usage = await logger.getProviderDailyUsage("cloudflare_workers_ai", dailyDateUtc);
const capturedAt = new Date();
const baseline = createCloudflareAccountingBaseline(usage, capturedAt);
assertCloudflareUtcPeriod(baseline.utcDate);
const capacityCheck = checkCloudflareBaselineCapacity({
  baseline,
  dailyNeuronAllocation: allocation,
  estimatedNextRequestNeurons: estimatedNeurons,
  dailyRequestLimit: capacity.dailyRequestLimit,
  softLimitRatio: capacity.softLimitRatio,
});

console.log(JSON.stringify({
  status: "PRE_FLIGHT_READY_FOR_ONE_SHOT_VALIDATION",
  inferenceNetworkDisabled: true,
  cloudflareCredentialsPresent: true,
  dailyNeuronAllocation: allocation,
  currentFreeAllocationNeurons: allocation,
  effectiveCloudflareCapacityConfigured: capacity.configured,
  provider: "cloudflare_workers_ai",
  model,
  candidateStatus: cloudflareModelPolicy[model].structuredProductionApproved,
  inputNeuronsPerMillionTokens: rates.inputNeuronsPerMillionTokens,
  outputNeuronsPerMillionTokens: rates.outputNeuronsPerMillionTokens,
  safetyMarginBps: rates.safetyMarginBps,
  freeOnlyClassification: "PERMANENT_FREE_APPROVED",
  productionRouterEnabled: false,
  paidPathEnabled: false,
  maxRequests: MAX_REQUESTS,
  maxRetries: MAX_RETRIES,
  maxTokensRequested: MAX_OUTPUT_TOKENS,
  softLimitRatio: capacity.softLimitRatio,
  configuredDailyRequestLimit: capacity.dailyRequestLimit ?? "UNCONFIGURED_OPTIONAL",
  utcPeriod: baseline.utcDate,
  baselineReservations: baseline.reservations,
  baselineDispatchedRequests: baseline.dispatchedRequests,
  baselineEstimatedReservedNeurons: baseline.reservedEstimatedNeurons,
  baselineKnownTokenUsage: baseline.knownTokenUsage,
  baselineCapturedAt: baseline.capturedAt,
  historicalState: "ACCEPTED",
  baselineInputTokens: usage.inputTokens,
  baselineOutputTokens: usage.outputTokens,
  baselineTotalTokens: usage.totalTokens,
  historicalReservationsPreserved: true,
  estimatedInputTokens: inputTokenEstimate,
  newEstimatedNeuronsReservation: estimatedNeurons,
  projectedReservedNeurons: baseline.reservedEstimatedNeurons + estimatedNeurons,
  softUsableNeurons: capacityCheck.softLimitNeurons,
  currentSoftRemainingNeurons: capacityCheck.softRemainingNeurons,
  projectedSoftRemainingNeurons: capacityCheck.softRemainingAfterReservation,
  softCapacityRemainingAfterReservation: capacityCheck.softRemainingAfterReservation,
  preflightCloudflareInferenceCalls: 0,
}, null, 2));
