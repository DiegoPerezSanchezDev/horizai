import type { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createProductionPipeline, type ProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { buildPipelinePublicationPayload } from "../lib/agents/publisher/publication-payload.ts";

export type CapacityResumePipelineConstruction = {
  requestBudget: ProviderScopedDailyRequestBudget;
  pipelineRunId: string;
  onConstructionStep?: (step: string) => void;
};

/** Shared production composition path used by the guarded resume runner and its local probe. */
export function createCapacityResumeProductionPipeline(input: CapacityResumePipelineConstruction): {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  logger: SupabaseAgentLogger;
  pipeline: ProductionPipeline;
} {
  const step = <T>(name: string, action: () => T): T => {
    input.onConstructionStep?.(name);
    return action();
  };
  const supabase = step("resume.supabase-client", () => createSupabaseServerClient());
  const logger = step("resume.agent-logger", () => new SupabaseAgentLogger(supabase));
  const pipeline = step("resume.create-production-pipeline", () => createProductionPipeline({
    supabase,
    logger,
    requestBudget: input.requestBudget,
    runId: input.pipelineRunId,
    persistTraceability: true,
    publicationPayloadFactory: buildPipelinePublicationPayload,
    config: {
      mode: "supervised",
      dryRun: true,
      publish: false,
      hours: 24,
      limit: 1,
      trigger: "manual",
      automaticRevision: false,
      maxRevisionAttempts: 1,
    },
    onConstructionStep: input.onConstructionStep,
  }));
  return { supabase, logger, pipeline };
}
