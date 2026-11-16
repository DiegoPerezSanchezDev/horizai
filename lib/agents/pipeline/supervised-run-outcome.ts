import type { PipelineRunResult } from "./pipeline-types.ts";
import { isSafelyRejectedSupervisedAttempt } from "./supervised-throughput-policy.ts";

export type SupervisedSchedulerOutcome = {
  runStatus: "succeeded" | "failed" | "blocked";
  finalDecision: "allowed" | "blocked" | "failed";
  schedulerDecision: "COMPLETED" | "NO_ELIGIBLE_EXTRACTED_ITEMS" | "WAITING_FOR_HUMAN_REVIEW" | "CANDIDATE_REJECTED" | "CANDIDATE_NOT_VERIFIED" | "STOPPED_CAPACITY" | "BLOCKED_BUDGET" | "TECHNICAL_FAILURE";
  stopReason: string | null;
};

const nonEditorialExtractionCodes = new Set(["blocked", "timeout", "http_error", "content_type", "redirect_limit", "empty_content"]);
const nonTechnicalTerminalOutcomes = new Set(["FETCH_BLOCKED", "FETCH_FAILED", "EMPTY_BODY"]);

function extractionOutcomeIsFullyAccountedAndNonEditorial(result: PipelineRunResult): boolean {
  const summary = result.extractionSummary;
  if (!summary || summary.extractedItems !== 0 || summary.persistErrors > 0 || (summary.rawItemPersistenceErrors ?? 0) > 0 || summary.successfulResults > 0) return false;
  if (summary.extractionAttempts !== summary.candidatesSelected || summary.extractionSkipped !== 0) return false;
  if ((summary.unexpectedResults ?? 0) > 0) return false;
  if (summary.extractionFailed !== summary.candidatesSelected || summary.extractionSucceeded !== 0) return false;
  const candidateOutcomes = summary.candidateOutcomes;
  if (!candidateOutcomes || candidateOutcomes.length !== summary.candidatesSelected) return false;
  if (new Set(candidateOutcomes.map((candidate) => candidate.candidateId)).size !== summary.candidatesSelected) return false;
  if (candidateOutcomes.some((candidate) => !candidate.extractionAttempted
    || !nonTechnicalTerminalOutcomes.has(candidate.terminalOutcome)
    || candidate.parserOutcome === "FAILED"
    || candidate.discoveryRawItemMapping === "NOT_RECORDED"
    || candidate.extractionRawItemMapping === "NOT_RECORDED"
    || candidate.discoveryRawItemMapping === "FAILED"
    || candidate.extractionRawItemMapping === "FAILED")) return false;
  if (summary.blockedResults + summary.failedResults !== summary.candidatesSelected) return false;
  const errorCodeEntries = Object.entries(summary.errorCodeCounts);
  if (errorCodeEntries.reduce((sum, [, count]) => sum + count, 0) !== summary.blockedResults + summary.failedResults) return false;
  return errorCodeEntries.every(([code, count]) => count > 0 && nonEditorialExtractionCodes.has(code));
}

/** `final_decision` is the scheduler admission result; scheduler_decision is the pipeline outcome. */
export function supervisedSchedulerOutcome(result: PipelineRunResult): SupervisedSchedulerOutcome {
  if (result.eventsAwaitingHumanReview > 0) return {
    runStatus: "succeeded", finalDecision: "allowed", schedulerDecision: "WAITING_FOR_HUMAN_REVIEW", stopReason: "WAITING_FOR_HUMAN_REVIEW",
  };
  const capacityStop = result.eventResults.find((event) => event.finalState === "DEFERRED_PROVIDER_CAPACITY");
  if (capacityStop || result.finalState === "DEFERRED_PROVIDER_CAPACITY") return {
    runStatus: "blocked", finalDecision: "blocked", schedulerDecision: "STOPPED_CAPACITY", stopReason: "PROVIDER_CAPACITY_EXHAUSTED",
  };
  if (result.finalState === "BLOCKED_BUDGET") return {
    runStatus: "blocked", finalDecision: "blocked", schedulerDecision: "BLOCKED_BUDGET", stopReason: "BLOCKED_INSUFFICIENT_DAILY_BUDGET",
  };
  if (result.eventResults.length > 0 && result.eventResults.every(isSafelyRejectedSupervisedAttempt)) return {
    runStatus: "succeeded", finalDecision: "allowed", schedulerDecision: "COMPLETED", stopReason: "ALL_CANDIDATES_SAFELY_REJECTED",
  };
  if (result.eventsFailed > 0 || (result.eventsBlocked > 0 && result.eventResults.some((event) => !isSafelyRejectedSupervisedAttempt(event))) || result.finalState === "FAILED" || result.finalState === "SUCCESS_WITH_FAILURES") return {
    runStatus: "failed", finalDecision: "failed", schedulerDecision: "TECHNICAL_FAILURE",
    stopReason: result.eventResults.find((event) => event.finalState === "FAILED" || event.finalState === "BLOCKED" || event.finalState === "BLOCKED_INSUFFICIENT_DAILY_BUDGET")?.stopReason
      ?? result.eventResults.find((event) => !isSafelyRejectedSupervisedAttempt(event) && (event.finalState === "BLOCKED_REVISION_REQUIRED" || event.finalState === "BLOCKED_REVISION_LIMIT"))?.stopReason
      ?? "SUPERVISED_PIPELINE_FAILED",
  };
  const notVerified = result.eventResults.find((event) => event.finalState === "SKIPPED");
  if (notVerified && result.eventsAttempted === result.eventsSkipped) return {
    runStatus: "succeeded", finalDecision: "allowed", schedulerDecision: "CANDIDATE_NOT_VERIFIED", stopReason: notVerified.stopReason,
  };
  if (result.candidatesDiscovered > 0 && result.extractedItems === 0 && result.eventsAttempted === 0) return {
    runStatus: extractionOutcomeIsFullyAccountedAndNonEditorial(result) ? "succeeded" : "failed",
    finalDecision: extractionOutcomeIsFullyAccountedAndNonEditorial(result) ? "allowed" : "failed",
    schedulerDecision: extractionOutcomeIsFullyAccountedAndNonEditorial(result) ? "NO_ELIGIBLE_EXTRACTED_ITEMS" : "TECHNICAL_FAILURE",
    stopReason: extractionOutcomeIsFullyAccountedAndNonEditorial(result) ? "NO_ELIGIBLE_EXTRACTED_ITEMS" : "EXTRACTION_OUTCOME_UNRESOLVED",
  };
  return { runStatus: "succeeded", finalDecision: "allowed", schedulerDecision: "COMPLETED", stopReason: null };
}
