import { AgentError, errorSummary } from "../runtime/agent-errors.ts";
import type { CheckpointVerification, PipelineStage } from "./pipeline-types.ts";

export const checkpointStages: readonly PipelineStage[] = ["verifier", "translator", "editor", "classifier", "ranker", "critic"];

export async function writeAndVerifyCheckpoint(stage: PipelineStage, eventKey: string, writer: (() => Promise<CheckpointVerification>) | undefined): Promise<CheckpointVerification> {
  if (!writer) throw new AgentError("checkpoint_failed", `Missing mandatory ${stage} checkpoint`);
  let checkpoint: CheckpointVerification;
  try {
    checkpoint = await writer();
  } catch (error) {
    throw new AgentError("checkpoint_failed", `Unable to write or read ${stage} checkpoint`, error);
  }
  if (checkpoint.stage !== stage || checkpoint.eventKey !== eventKey || !checkpoint.written || !checkpoint.readable || !checkpoint.valid) {
    throw new AgentError("checkpoint_failed", `${stage} checkpoint failed lineage or validation checks`);
  }
  return checkpoint;
}

export function sanitizedPipelineError(error: unknown): string {
  const summary = errorSummary(error);
  return summary.code || "PIPELINE_STAGE_FAILED";
}
