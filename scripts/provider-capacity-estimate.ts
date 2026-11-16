import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { estimateCloudflareNeurons } from "../lib/agents/runtime/free-provider-router.ts";

const stages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
const minimumSample = 20;
const fixture = { inputTokens: 12_000, outputTokens: 3_000 };
const neuronRates = { inputNeuronsPerMillionTokens: 18_182, outputNeuronsPerMillionTokens: 27_273, safetyMarginBps: 12_500 };

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? null;
}

const { data, error } = await createSupabaseServerClient()
  .from("agent_runs")
  .select("provider,started_at,finished_at,status,config,stats")
  .eq("provider", "groq")
  .not("finished_at", "is", null)
  .order("finished_at", { ascending: true })
  .limit(1_000);
if (error || !data) throw new Error("Unable to read persisted provider telemetry");

type RunRow = (typeof data)[number];
const eligible = data.filter((row: RunRow) => {
  const config = row.config as Record<string, unknown>;
  const stats = row.stats as Record<string, unknown>;
  const telemetry = stats.telemetry as Record<string, unknown> | undefined;
  return row.status === "succeeded"
    && telemetry?.status === "SUCCESS"
    && config.model === "openai/gpt-oss-20b"
    && telemetry.model === "openai/gpt-oss-20b"
    && telemetry.providerRequestsUsed === 1
    && Number.isSafeInteger(telemetry.inputTokens)
    && Number.isSafeInteger(telemetry.outputTokens)
    && stages.includes(config.agentName as (typeof stages)[number])
    && typeof config.eventKey === "string";
});

const byEvent = new Map<string, RunRow[]>();
for (const row of eligible) {
  const config = row.config as Record<string, unknown>;
  const eventKey = config.eventKey as string;
  const rows = byEvent.get(eventKey) ?? [];
  rows.push(row);
  byEvent.set(eventKey, rows);
}

const completeEvents: Array<{ inputTokens: number; outputTokens: number }> = [];
for (const candidateRows of byEvent.values()) {
  const latestByStage = new Map<string, RunRow>();
  for (const row of candidateRows) {
    const config = row.config as Record<string, unknown>;
    const name = config.agentName as string;
    const existing = latestByStage.get(name);
    if (!existing || Date.parse(row.finished_at ?? row.started_at) > Date.parse(existing.finished_at ?? existing.started_at)) latestByStage.set(name, row);
  }
  if (!stages.every((stage) => latestByStage.has(stage))) continue;
  const rows = [...latestByStage.values()];
  if (Math.max(...rows.map((row) => Date.parse(row.finished_at ?? row.started_at))) - Math.min(...rows.map((row) => Date.parse(row.started_at))) > 2 * 60 * 60 * 1_000) continue;
  completeEvents.push(rows.reduce((totals, row) => {
    const telemetry = (row.stats as Record<string, Record<string, unknown>>).telemetry;
    return { inputTokens: totals.inputTokens + Number(telemetry.inputTokens), outputTokens: totals.outputTokens + Number(telemetry.outputTokens) };
  }, { inputTokens: 0, outputTokens: 0 }));
}

const sufficient = completeEvents.length >= minimumSample;
const inputValues = completeEvents.map((event) => event.inputTokens);
const outputValues = completeEvents.map((event) => event.outputTokens);
const estimateBase = sufficient
  ? { inputTokens: percentile(inputValues, 0.9)!, outputTokens: percentile(outputValues, 0.9)! }
  : fixture;
const estimatedNeurons = estimateCloudflareNeurons({ ...estimateBase, ...neuronRates });
const configuredAllocation = Number(process.env.CLOUDFLARE_DAILY_NEURON_LIMIT ?? process.env.CLOUDFLARE_FREE_DAILY_NEURON_ALLOCATION ?? "");
const effectiveAllocation = Number.isSafeInteger(configuredAllocation) && configuredAllocation > 0 ? configuredAllocation : null;
const theoreticalCloudflareFreeAllocation = 10_000; // Current Cloudflare public Free-plan allocation; replace with account-specific env in operation.
const perDayFullEventsAtSoftLimit = (allocation: number) => Math.max(0, Math.floor((Math.ceil(allocation * 0.85) - 1) / estimatedNeurons));

console.log(JSON.stringify({
  status: "ESTIMATED_CAPACITY_ONLY",
  providerCalls: 0,
  source: "read-only persisted Groq agent_runs telemetry",
  successfulGroqStageRows: eligible.length,
  completeSixStageEvents: completeEvents.length,
  historicalSample: sufficient ? "SUFFICIENT_SAMPLE" : "INSUFFICIENT_SAMPLE",
  historicalInputTokens: sufficient ? { median: percentile(inputValues, 0.5), p75: percentile(inputValues, 0.75), p90: percentile(inputValues, 0.9) } : null,
  historicalOutputTokens: sufficient ? { median: percentile(outputValues, 0.5), p75: percentile(outputValues, 0.75), p90: percentile(outputValues, 0.9) } : null,
  estimatorInputTokens: estimateBase.inputTokens,
  estimatorOutputTokens: estimateBase.outputTokens,
  fixtureUsed: !sufficient,
  estimatedFullEventNeurons: estimatedNeurons,
  configuredDailyAllocation: effectiveAllocation,
  theoreticalPublicFreeAllocation: theoreticalCloudflareFreeAllocation,
  theoreticalFullEventsAt85Percent: perDayFullEventsAtSoftLimit(theoreticalCloudflareFreeAllocation),
  configuredFullEventsAt85Percent: effectiveAllocation === null ? null : perDayFullEventsAtSoftLimit(effectiveAllocation),
  targetTenPerDayNeuronEstimate: estimatedNeurons * 10,
  targetSupportedTheoreticallyByPublishedAllocation: estimatedNeurons * 10 < theoreticalCloudflareFreeAllocation * 0.85,
  guarantee: false,
}, null, 2));
