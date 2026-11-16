import type { PipelineAttemptFinalState, PipelineEventAttempt, PipelineRetryClass } from "./event-attempt-policy.ts";

export const factualRemediationIncident = {
  eventId: "5138e509-f4c3-4020-9d13-6a6efac99a39",
  eventKey: "event-30f226d1b8ba5c9eb8af2b65c46db512",
  articleId: "756b0ee0-b5e6-4153-846f-278a12c9afe3",
  articleSlug: "openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad",
  rawItemId: "d3834944-72f6-4f59-9aca-3f66ae92dc33",
  rawContentLength: 1756,
  rawContentSha256: "4ce8abf4e1b0374453cda72073dbbf920586e61e4b650bcc674788368f249e1e",
  rawContentHash: "sha256:9f053bdbb6d53e5d59baf254201811874992bf7cad444b38431b8f364bfe5caa",
  sourceId: "e8dd0363-f51e-4381-9fb2-c02ee81f4d41",
  priorPipelineRunId: "63b81d9a-e46f-4434-9637-335d3f455e0b",
  startStage: "VERIFIER",
  pilotAttemptNumber: 5,
  eventAttemptNumber: 2,
} as const;

export const factualRemediationStages = [
  "verifier",
  "translator",
  "editor",
  "classifier",
  "geo",
  "ranker",
  "critic",
  "publisher",
] as const;

export type FactualRemediationLease = {
  attempt: PipelineEventAttempt;
  purpose: "FACTUAL_REMEDIATION";
  startStage: "VERIFIER";
  articleId: typeof factualRemediationIncident.articleId;
  articleSlug: typeof factualRemediationIncident.articleSlug;
  rawItemId: typeof factualRemediationIncident.rawItemId;
  priorAttemptId: string;
  pilotAttemptNumber: 5;
};

export type FactualRemediationAuthorization = {
  authorizedBy: string;
  authorizationReference: string;
  reason: string;
};

export type FactualRemediationAttemptGuard = {
  assertOwned(lease: FactualRemediationLease): Promise<void>;
};

export type FactualRemediationPlan = {
  eventId: typeof factualRemediationIncident.eventId;
  eventKey: typeof factualRemediationIncident.eventKey;
  articleId: typeof factualRemediationIncident.articleId;
  articleSlug: typeof factualRemediationIncident.articleSlug;
  rawItemId: typeof factualRemediationIncident.rawItemId;
  purpose: "FACTUAL_REMEDIATION";
  startStage: "VERIFIER";
  stages: typeof factualRemediationStages;
  reuseStoredExtraction: true;
  reuseOldCheckpointsFromStartStage: false;
  maxRetries: 0;
  maxGroqCalls: 6;
  pilotAttemptBefore: "4/5";
  pilotAttemptAfterClaim: "5/5";
};

export type FactualRemediationCommand =
  | { mode: "preflight" }
  | ({ mode: "execute" } & FactualRemediationAuthorization)
  | { mode: "help" };

const pilotAttemptBaseline = [
  { eventKey: "event-cbbf85234317a442f59ece63ef1b40c8", pipelineRunId: "ce894b55-5c50-44dc-87db-58bcbf09834b", attemptNumber: 1, finalState: "TECHNICAL_FAILURE" },
  { eventKey: "event-cbbf85234317a442f59ece63ef1b40c8", pipelineRunId: "8c96ffb9-4705-4aab-b396-7e4cc41b2939", attemptNumber: 2, finalState: "READY_FOR_PUBLICATION" },
  { eventKey: "event-f91a0e775887c720bb2bee5363ce6f26", pipelineRunId: "0327c9a0-1b2b-49a9-b814-351c6ff53b51", attemptNumber: 1, finalState: "READY_FOR_PUBLICATION" },
  { eventKey: factualRemediationIncident.eventKey, pipelineRunId: factualRemediationIncident.priorPipelineRunId, attemptNumber: 1, finalState: "READY_FOR_PUBLICATION" },
] as const;

export function parseFactualRemediationCommand(argv: readonly string[]): FactualRemediationCommand {
  if (argv.length === 1 && argv[0] === "--help") return { mode: "help" };
  const values = new Map<string, string>();
  let execute = false;
  for (const arg of argv) {
    if (arg === "--preflight-only") continue;
    if (arg === "--execute-factual-remediation") {
      if (execute) throw new Error("FACTUAL_REMEDIATION_DUPLICATE_EXECUTION_FLAG");
      execute = true;
      continue;
    }
    const match = /^(--authorized-by|--authorization-reference|--reason)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error("FACTUAL_REMEDIATION_ARGUMENT_INVALID");
    values.set(match[1], match[2]);
  }
  if (!execute) {
    if (values.size > 0) throw new Error("FACTUAL_REMEDIATION_AUTHORIZATION_REQUIRES_EXECUTION_FLAG");
    return { mode: "preflight" };
  }
  if (argv.includes("--preflight-only")) throw new Error("FACTUAL_REMEDIATION_MODE_CONFLICT");
  const authorization = {
    authorizedBy: values.get("--authorized-by") ?? "",
    authorizationReference: values.get("--authorization-reference") ?? "",
    reason: values.get("--reason") ?? "",
  };
  assertFactualRemediationAuthorization(authorization);
  return { mode: "execute", ...authorization };
}

export function assertPilotAttemptBaseline(attempts: readonly Pick<PipelineEventAttempt, "eventKey" | "pipelineRunId" | "attemptNumber" | "finalState">[]): void {
  for (const expected of pilotAttemptBaseline) {
    const rows = attempts.filter((attempt) => attempt.eventKey === expected.eventKey && attempt.pipelineRunId === expected.pipelineRunId);
    if (rows.length !== 1 || rows[0]?.attemptNumber !== expected.attemptNumber || rows[0]?.finalState !== expected.finalState) {
      throw new Error("FACTUAL_REMEDIATION_PILOT_BASELINE_CHANGED");
    }
  }
  const targetRows = attempts.filter((attempt) => attempt.eventKey === factualRemediationIncident.eventKey);
  if (targetRows.length !== 1 || targetRows[0]?.pipelineRunId !== factualRemediationIncident.priorPipelineRunId) throw new Error("FACTUAL_REMEDIATION_TARGET_ATTEMPT_HISTORY_CHANGED");
}

export function createFactualRemediationPlan(): FactualRemediationPlan {
  return {
    eventId: factualRemediationIncident.eventId,
    eventKey: factualRemediationIncident.eventKey,
    articleId: factualRemediationIncident.articleId,
    articleSlug: factualRemediationIncident.articleSlug,
    rawItemId: factualRemediationIncident.rawItemId,
    purpose: "FACTUAL_REMEDIATION",
    startStage: factualRemediationIncident.startStage,
    stages: factualRemediationStages,
    reuseStoredExtraction: true,
    reuseOldCheckpointsFromStartStage: false,
    maxRetries: 0,
    maxGroqCalls: 6,
    pilotAttemptBefore: "4/5",
    pilotAttemptAfterClaim: "5/5",
  };
}

export function assertFactualRemediationLease(value: FactualRemediationLease): void {
  if (!value || value.purpose !== "FACTUAL_REMEDIATION") throw new Error("FACTUAL_REMEDIATION_PURPOSE_REQUIRED");
  if (value.startStage !== "VERIFIER") throw new Error("FACTUAL_REMEDIATION_START_STAGE_FORBIDDEN");
  if (value.attempt.eventKey !== factualRemediationIncident.eventKey || value.attempt.attemptNumber !== factualRemediationIncident.eventAttemptNumber) throw new Error("FACTUAL_REMEDIATION_EVENT_ATTEMPT_MISMATCH");
  if (!value.attempt.pipelineRunId || value.attempt.completedAt !== null || value.attempt.finalState !== null) throw new Error("FACTUAL_REMEDIATION_ATTEMPT_NOT_ACTIVE");
  if (value.articleId !== factualRemediationIncident.articleId || value.articleSlug !== factualRemediationIncident.articleSlug || value.rawItemId !== factualRemediationIncident.rawItemId) throw new Error("FACTUAL_REMEDIATION_TARGET_MISMATCH");
  if (!value.priorAttemptId || value.priorAttemptId === value.attempt.id) throw new Error("FACTUAL_REMEDIATION_PRIOR_ATTEMPT_MISSING");
  if (value.pilotAttemptNumber !== factualRemediationIncident.pilotAttemptNumber || value.attempt.countsTowardRetryLimit) throw new Error("FACTUAL_REMEDIATION_PILOT_ACCOUNTING_MISMATCH");
}

export function assertFactualRemediationAuthorization(value: FactualRemediationAuthorization): void {
  if (typeof value.authorizedBy !== "string" || value.authorizedBy.trim().length < 2 || value.authorizedBy.trim().length > 120) throw new Error("FACTUAL_REMEDIATION_AUTHORIZED_BY_REQUIRED");
  if (typeof value.authorizationReference !== "string" || value.authorizationReference.trim().length < 5 || value.authorizationReference.trim().length > 500) throw new Error("FACTUAL_REMEDIATION_AUTHORIZATION_REFERENCE_REQUIRED");
  if (typeof value.reason !== "string" || value.reason.trim().length < 20 || value.reason.trim().length > 1000) throw new Error("FACTUAL_REMEDIATION_REASON_REQUIRED");
}

export function remediationFinalizationPolicy(outcome: {
  finalState: PipelineAttemptFinalState;
  stopStage: string | null;
  stopReason: string | null;
  retryClass: PipelineRetryClass;
  countsTowardRetryLimit: boolean;
  nextEligibleAt: string | null;
}): {
  finalState: PipelineAttemptFinalState;
  stopStage: string | null;
  stopReason: string | null;
  retryClass: "NONE";
  countsTowardRetryLimit: false;
  nextEligibleAt: null;
} {
  return { ...outcome, retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null };
}
