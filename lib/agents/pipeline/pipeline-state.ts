import type { PipelineStage, PipelineStageState } from "./pipeline-types.ts";

export const pipelineStages: readonly PipelineStage[] = ["discovery", "extraction", "clustering", "verifier", "translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"];

export function createStageStates(): Record<PipelineStage, PipelineStageState> {
  return Object.fromEntries(pipelineStages.map((stage) => [stage, {
    status: "not_started",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    requestCount: 0,
    checkpointWritten: false,
    errorCode: null,
  }])) as Record<PipelineStage, PipelineStageState>;
}

export function setStageRunning(states: Record<PipelineStage, PipelineStageState>, stage: PipelineStage, startedAt: string): void {
  states[stage] = { ...states[stage], status: "running", startedAt, completedAt: null, durationMs: null, errorCode: null };
}

export function setStageFinished(states: Record<PipelineStage, PipelineStageState>, stage: PipelineStage, status: "success" | "skipped" | "failed", finishedAt: string, durationMs: number, details: { requestCount?: number; checkpointWritten?: boolean; errorCode?: string | null } = {}): void {
  states[stage] = { ...states[stage], status, completedAt: finishedAt, durationMs, requestCount: details.requestCount ?? states[stage].requestCount, checkpointWritten: details.checkpointWritten ?? states[stage].checkpointWritten, errorCode: details.errorCode ?? null };
}
