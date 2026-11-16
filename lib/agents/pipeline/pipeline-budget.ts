import type { PipelineQuota, PipelineStage } from "./pipeline-types.ts";
import type { AgentLogger } from "../runtime/runtime-types.ts";
import { MAX_GROQ_DAILY_REQUEST_HARD_LIMIT, readGroqDailyRequestHardCap } from "../runtime/request-budget.ts";
import { readProviderSoftLimitRatio } from "../runtime/free-provider-router.ts";

export const providerPipelineStages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
export type ProviderPipelineStage = (typeof providerPipelineStages)[number];

export function remainingRequestsRequired(stage: PipelineStage): number {
  const index = providerPipelineStages.indexOf(stage as ProviderPipelineStage);
  return index < 0 ? 0 : providerPipelineStages.length - index;
}

export function initialRequestsRequired(): number {
  return remainingRequestsRequired("verifier");
}

/** Worst-case provider requests for one automatic revision, including the final Critic. */
export function revisionRequestsRequired(stage: ProviderPipelineStage): number {
  return remainingRequestsRequired(stage);
}

export function createStaticPipelineQuota(value: number): PipelineQuota {
  if (!Number.isInteger(value) || value < 0) throw new Error("Static pipeline quota must be a non-negative integer");
  return { async remaining() { return value; } };
}

function utcDate(clock: () => Date): string {
  return clock().toISOString().slice(0, 10);
}

/** Reads the same persistent reservation ledger used by AgentRunner. It never reserves. */
export function createPersistentPipelineQuota(logger: AgentLogger, options: { dailyLimit?: number; clock?: () => Date } = {}): PipelineQuota {
  const hardLimit = options.dailyLimit ?? readGroqDailyRequestHardCap();
  const softThreshold = Math.floor(hardLimit * readProviderSoftLimitRatio());
  const admissionLimit = Math.max(0, softThreshold - 1);
  const clock = options.clock ?? (() => new Date());
  if (!Number.isInteger(hardLimit) || hardLimit < 1 || hardLimit > MAX_GROQ_DAILY_REQUEST_HARD_LIMIT || admissionLimit < 0) throw new Error("Groq pipeline request limit must be between 1 and 1000");
  return { provider: "groq", async remaining() {
    const usage = await logger.getRemainingRequests(hardLimit, utcDate(clock));
    return Math.max(0, admissionLimit - usage.used);
  } };
}
