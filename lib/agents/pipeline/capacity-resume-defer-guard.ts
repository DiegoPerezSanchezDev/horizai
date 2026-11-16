import {
  capacityResumePreviousStages,
  capacityResumeStages,
  parseCapacityResumeSnapshot,
  type CapacityResumeStage,
} from "./provider-capacity-resume.ts";

export type CapacityResumeDeferGuardInput = {
  attemptId: string;
  eventKey: string;
  pipelineRunId: string;
  claimedStage: string;
  resumeStage: string;
  snapshot: unknown;
  previousGeneration: number;
  providerRequestDispatched: boolean;
  providerRequestsUsed: number;
  countsTowardRetryLimit: boolean;
};

/** Validates the application-side M35 defer contract without weakening its RPC checks. */
export function assertCapacityResumeDeferGuard(input: CapacityResumeDeferGuardInput): asserts input is CapacityResumeDeferGuardInput & {
  claimedStage: CapacityResumeStage;
  resumeStage: CapacityResumeStage;
} {
  if (!capacityResumeStages.includes(input.claimedStage as CapacityResumeStage)
    || !capacityResumeStages.includes(input.resumeStage as CapacityResumeStage)) {
    throw new Error("CAPACITY_DEFER_STAGE_UNSUPPORTED");
  }
  const claimedStage = input.claimedStage as CapacityResumeStage;
  const resumeStage = input.resumeStage as CapacityResumeStage;
  const claimedIndex = capacityResumeStages.indexOf(claimedStage);
  const resumeIndex = capacityResumeStages.indexOf(resumeStage);
  if (resumeIndex < claimedIndex) throw new Error("CAPACITY_DEFER_STAGE_REGRESSION");

  const snapshot = parseCapacityResumeSnapshot(input.snapshot);
  if (snapshot.attemptId !== input.attemptId || snapshot.eventKey !== input.eventKey
    || snapshot.pipelineRunId !== input.pipelineRunId || snapshot.resumeStage !== resumeStage) {
    throw new Error("CAPACITY_DEFER_SNAPSHOT_LINEAGE_OR_STAGE_MISMATCH");
  }
  if (!Number.isSafeInteger(input.previousGeneration) || input.previousGeneration < 0 || input.previousGeneration >= 1000
    || snapshot.resumeGeneration !== input.previousGeneration + 1) {
    throw new Error("CAPACITY_DEFER_GENERATION_INVALID");
  }
  if (input.providerRequestDispatched || input.providerRequestsUsed !== 0) {
    throw new Error("CAPACITY_DEFER_PENDING_STAGE_ALREADY_DISPATCHED");
  }
  if (input.countsTowardRetryLimit) throw new Error("CAPACITY_DEFER_COUNTS_TOWARD_RETRY_LIMIT");

  const expectedPrior = capacityResumePreviousStages[resumeStage];
  const actualPrior = Object.keys(snapshot.checkpoints);
  if (actualPrior.length !== expectedPrior.length || expectedPrior.some((stage) => !actualPrior.includes(stage))) {
    throw new Error("CAPACITY_DEFER_CHECKPOINT_STAGE_MISMATCH");
  }
}
