import {
  planGroqDailyCapacity,
  simulateGroqCandidateDemand,
} from "../lib/agents/runtime/groq-capacity-policy.ts";

const plan = planGroqDailyCapacity({
  requestHardLimit: 1_000,
  tokenHardLimit: 200_000,
  softRatio: 0.85,
});
const groqOnly = [10, 12, 15].map((candidates) => simulateGroqCandidateDemand({
  candidates,
  requestHardLimit: plan.requestHardLimit,
  tokenHardLimit: plan.tokenHardLimit,
  softRatio: plan.softRatio,
  eventRequests: plan.eventRequests,
  eventTokens: plan.selectedEventTokens,
}));
const futureMixed = [10, 12, 15].map((candidates) => {
  const groq = Math.min(candidates, plan.finalEventCapacity);
  const remaining = candidates - groq;
  const cloudflare = Math.min(remaining, 3);
  return { candidates, groq, cloudflare, blocked: remaining - cloudflare };
});
console.log(JSON.stringify({
  generatedOn: "2026-09-27",
  simulationOnly: true,
  plan,
  groqOnly,
  futureMixed: {
    label: "FUTURE_CAPACITY_IF_CLOUDFLARE_QUALITY_APPROVED",
    cloudflareConservativePaths: 3,
    scenarios: futureMixed,
  },
}, null, 2));
