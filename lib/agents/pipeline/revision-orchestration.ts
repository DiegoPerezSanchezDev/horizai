import { join } from "node:path";
import type { CriticResult } from "../contracts/index.ts";
import { revisionRequestsRequired, type ProviderPipelineStage } from "./pipeline-budget.ts";

export const MAX_REVISION_ATTEMPTS_PER_EVENT = 1 as const;
export const revisionStages = ["verifier", "translator", "editor", "classifier", "geo", "ranker", "critic"] as const;
export type RevisionStage = (typeof revisionStages)[number];
export const revisionCheckpointStages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
export type RevisionCheckpointStage = (typeof revisionCheckpointStages)[number];
export type RevisionRequestStage = Exclude<ProviderPipelineStage, "critic">;

const precedence: readonly RevisionRequestStage[] = ["verifier", "translator", "editor", "classifier", "ranker"];

const stagePlan: Record<RevisionRequestStage, readonly RevisionStage[]> = {
  verifier: ["verifier", "translator", "editor", "classifier", "geo", "ranker", "critic"],
  translator: ["translator", "editor", "classifier", "geo", "ranker", "critic"],
  editor: ["editor", "classifier", "geo", "ranker", "critic"],
  classifier: ["classifier", "geo", "ranker", "critic"],
  ranker: ["ranker", "critic"],
};

const checkpointPlan: Record<RevisionRequestStage, readonly RevisionCheckpointStage[]> = {
  verifier: ["verifier", "translator", "editor", "classifier", "ranker", "critic"],
  translator: ["translator", "editor", "classifier", "ranker", "critic"],
  editor: ["editor", "classifier", "ranker", "critic"],
  classifier: ["classifier", "ranker", "critic"],
  ranker: ["ranker", "critic"],
};

export type RevisionBlockReason = "BLOCKED_REVISION_LIMIT" | "BLOCKED_INSUFFICIENT_DAILY_BUDGET" | "INVALID_REVISION_STAGE" | null;

export type RevisionPlan = {
  requestedStage: RevisionRequestStage | null;
  stagesToRerun: RevisionStage[];
  checkpointsToInvalidate: RevisionCheckpointStage[];
  preservedCheckpoints: RevisionCheckpointStage[];
  requestsRequiredWorstCase: number;
  revisionAttempt: number;
  maxRevisionAttempts: number;
  allowed: boolean;
  blockReason: RevisionBlockReason;
};

function requestedStage(decision: CriticResult["decision"]): RevisionRequestStage | null {
  if (!decision.startsWith("revise_")) return null;
  const suffix = decision.slice("revise_".length);
  const value = ({ verification: "verifier", translation: "translator", editorial: "editor", classification: "classifier", ranking: "ranker" } as const)[suffix as "verification" | "translation" | "editorial" | "classification" | "ranking"];
  if (!value) return null;
  return precedence.includes(value) ? value : null;
}

export function earliestRevisionStage(decisions: readonly CriticResult["decision"][]): RevisionRequestStage | null {
  const candidates = decisions.map(requestedStage).filter((stage): stage is RevisionRequestStage => stage !== null);
  return precedence.find((stage) => candidates.includes(stage)) ?? null;
}

export function createRevisionPlan(options: {
  decision: CriticResult["decision"] | readonly CriticResult["decision"][];
  revisionAttempt: number;
  remainingRequests: number;
  maxRevisionAttempts?: number;
}): RevisionPlan {
  const decisions = Array.isArray(options.decision) ? options.decision : [options.decision];
  const stage = earliestRevisionStage(decisions);
  const maxRevisionAttempts = options.maxRevisionAttempts ?? MAX_REVISION_ATTEMPTS_PER_EVENT;
  if (!Number.isInteger(options.revisionAttempt) || options.revisionAttempt < 0) throw new Error("revisionAttempt must be a non-negative integer");
  if (!Number.isInteger(maxRevisionAttempts) || maxRevisionAttempts < 1) throw new Error("maxRevisionAttempts must be a positive integer");
  if (!stage) return { requestedStage: null, stagesToRerun: [], checkpointsToInvalidate: [], preservedCheckpoints: [...revisionCheckpointStages], requestsRequiredWorstCase: 0, revisionAttempt: options.revisionAttempt, maxRevisionAttempts, allowed: false, blockReason: null };
  const stagesToRerun = [...stagePlan[stage]];
  const checkpointsToInvalidate = [...checkpointPlan[stage]];
  const preservedCheckpoints = revisionCheckpointStages.filter((checkpoint) => !checkpointsToInvalidate.includes(checkpoint));
  const requestsRequiredWorstCase = revisionRequestsRequired(stage);
  if (options.revisionAttempt >= maxRevisionAttempts) return { requestedStage: stage, stagesToRerun, checkpointsToInvalidate, preservedCheckpoints, requestsRequiredWorstCase, revisionAttempt: options.revisionAttempt, maxRevisionAttempts, allowed: false, blockReason: "BLOCKED_REVISION_LIMIT" };
  if (options.remainingRequests < requestsRequiredWorstCase) return { requestedStage: stage, stagesToRerun, checkpointsToInvalidate, preservedCheckpoints, requestsRequiredWorstCase, revisionAttempt: options.revisionAttempt, maxRevisionAttempts, allowed: false, blockReason: "BLOCKED_INSUFFICIENT_DAILY_BUDGET" };
  return { requestedStage: stage, stagesToRerun, checkpointsToInvalidate, preservedCheckpoints, requestsRequiredWorstCase, revisionAttempt: options.revisionAttempt, maxRevisionAttempts, allowed: true, blockReason: null };
}

export type RevisionLineage = {
  revisionId: string;
  originalRunId: string;
  eventKey: string;
  revisionAttempt: number;
  requestedStage: RevisionRequestStage;
  triggeringCriticCheckpoint: string;
  preservedCheckpoints: string[];
  newlyGeneratedCheckpoints: string[];
  resultingCriticDecision: CriticResult["decision"] | null;
};

export function revisionCheckpointPath(root: string, runId: string, eventKey: string, revisionAttempt: number, stage: RevisionCheckpointStage): string {
  if (!Number.isInteger(revisionAttempt) || revisionAttempt < 0) throw new Error("revisionAttempt must be a non-negative integer");
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return join(root, safe(runId), safe(eventKey), `revision-${revisionAttempt}`, `${stage}.json`);
}

export type RevisionCheckpointIdentity = { eventKey: string; revisionId: string; revisionAttempt: number; stage: RevisionCheckpointStage };

export function assertRevisionCheckpointLineage(expected: Pick<RevisionCheckpointIdentity, "eventKey" | "revisionId" | "revisionAttempt">, actual: RevisionCheckpointIdentity): void {
  if (expected.eventKey !== actual.eventKey || expected.revisionId !== actual.revisionId || expected.revisionAttempt !== actual.revisionAttempt) throw new Error("REVISION_LINEAGE_MISMATCH");
}

export function assertPublisherLatestRevision(expectedAttempt: number, checkpoints: readonly RevisionCheckpointIdentity[]): void {
  const required = new Set<RevisionCheckpointStage>(revisionCheckpointStages);
  for (const checkpoint of checkpoints) {
    if (required.has(checkpoint.stage) && checkpoint.revisionAttempt !== expectedAttempt) throw new Error("STALE_REVISION_CHECKPOINT");
  }
  if (checkpoints.filter((checkpoint) => required.has(checkpoint.stage)).length !== required.size) throw new Error("INCOMPLETE_REVISION_CHECKPOINT_SET");
}

export type RevisionExecutionState = {
  eventKey: string;
  originalRunId: string;
  revisionId: string | null;
  revisionAttempt: number;
  status: "ORIGINAL" | "PLANNED" | "RUNNING" | "COMPLETED" | "BLOCKED" | "FAILED";
  requestedStage: RevisionRequestStage | null;
  resultingCriticDecision: CriticResult["decision"] | null;
};

export function createOriginalRevisionState(eventKey: string, originalRunId: string): RevisionExecutionState {
  return { eventKey, originalRunId, revisionId: null, revisionAttempt: 0, status: "ORIGINAL", requestedStage: null, resultingCriticDecision: null };
}

export function startRevision(state: RevisionExecutionState, plan: RevisionPlan, revisionId: string): RevisionExecutionState {
  if (!plan.allowed || !plan.requestedStage) throw new Error(plan.blockReason ?? "REVISION_NOT_ALLOWED");
  if (state.revisionAttempt !== plan.revisionAttempt) throw new Error("REVISION_STATE_MISMATCH");
  return { ...state, revisionId, revisionAttempt: state.revisionAttempt + 1, status: "RUNNING", requestedStage: plan.requestedStage, resultingCriticDecision: null };
}

export function completeRevision(state: RevisionExecutionState, decision: CriticResult["decision"]): RevisionExecutionState {
  if (state.status !== "RUNNING") throw new Error("REVISION_NOT_RUNNING");
  return { ...state, status: "COMPLETED", resultingCriticDecision: decision };
}

export type RevisionFinalState = "READY_FOR_PUBLICATION_DRY_RUN" | "BLOCKED_REVISION_REQUIRED" | "BLOCKED_REVISION_LIMIT" | "BLOCKED_REJECTED" | "BLOCKED_INSUFFICIENT_DAILY_BUDGET" | "FAILED" | "SKIPPED";

export function revisionFinalState(decision: CriticResult["decision"], plan: RevisionPlan): RevisionFinalState {
  if (decision === "pass") return "READY_FOR_PUBLICATION_DRY_RUN";
  if (decision === "reject") return "BLOCKED_REJECTED";
  if (plan.blockReason === "BLOCKED_REVISION_LIMIT") return "BLOCKED_REVISION_LIMIT";
  if (plan.blockReason === "BLOCKED_INSUFFICIENT_DAILY_BUDGET") return "BLOCKED_INSUFFICIENT_DAILY_BUDGET";
  return "BLOCKED_REVISION_REQUIRED";
}
