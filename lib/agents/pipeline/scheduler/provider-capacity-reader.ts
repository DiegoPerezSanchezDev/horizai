import { SupabaseAgentLogger } from "../../runtime/agent-logger.ts";
import { getFreeProviderCapacitySnapshot, readProviderCapacityConfig, type FreeProviderCapacitySnapshot } from "../../runtime/free-provider-router.ts";
import { buildCloudflareStageCapacityReport } from "../../runtime/cloudflare-stage-capacity.ts";
import { normalEventStages } from "../../runtime/event-model-stages.ts";
import { provisionalGroqEventTokens, readGroqEventTokenMarginPercent } from "../../runtime/groq-capacity-policy.ts";

/** Reads and projects provider capacity independently; it never activates routing. */
export async function readSchedulerProviderCapacitySnapshot(logger: SupabaseAgentLogger, now: Date): Promise<FreeProviderCapacitySnapshot> {
  const dateUtc = now.toISOString().slice(0, 10);
  const [groqUsage, cloudflareUsage, groqBlock, cloudflareBlock] = await Promise.all([
    logger.getProviderDailyUsage("groq", dateUtc),
    logger.getProviderDailyUsage("cloudflare_workers_ai", dateUtc),
    logger.getProviderRateLimitState("groq"),
    logger.getProviderRateLimitState("cloudflare_workers_ai"),
  ]);
  let estimate: { inputTokens: number; outputTokens: number; neurons: number; peakRequestTokens: number } | null = null;
  try {
    const report = buildCloudflareStageCapacityReport();
    estimate = {
      inputTokens: report.stages.reduce((sum, stage) => sum + stage.estimatedInputTokens, 0),
      outputTokens: report.stages.reduce((sum, stage) => sum + stage.maxOutputTokens, 0),
      neurons: report.conservativeFullEventReservationEstimate,
      peakRequestTokens: Math.max(...report.stages.map((stage) => stage.estimatedInputTokens + stage.maxOutputTokens)),
    };
  } catch {
    // Keep candidate/model/Neuron estimates unknown if the required inputs are absent.
  }
  return getFreeProviderCapacitySnapshot({
    configs: { groq: readProviderCapacityConfig("groq"), cloudflare_workers_ai: readProviderCapacityConfig("cloudflare_workers_ai") },
    usage: { groq: groqUsage, cloudflare_workers_ai: cloudflareUsage },
    blocks: { groq: groqBlock, cloudflare_workers_ai: cloudflareBlock },
    now,
    estimatedEventRequests: normalEventStages.length,
    estimatedGroqEventTokens: provisionalGroqEventTokens({ marginPercent: readGroqEventTokenMarginPercent() }),
    ...(estimate ? {
      estimatedEventInputTokens: estimate.inputTokens,
      estimatedEventOutputTokens: estimate.outputTokens,
      estimatedEventTokens: estimate.inputTokens + estimate.outputTokens,
      estimatedPeakRequestTokens: estimate.peakRequestTokens,
      estimatedEventNeurons: estimate.neurons,
    } : {}),
  });
}
