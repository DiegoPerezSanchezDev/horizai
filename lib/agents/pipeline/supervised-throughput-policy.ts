import { supervisedEventAttemptLimit, supervisedExtractionCandidateLimit, supervisedProviderRequestLimit } from "./supervised-limits.ts";
import { extractionEvidenceInsufficient } from "../extraction/evidence-quality.ts";
import type { PipelineEventResult } from "./pipeline-types.ts";

export const SUPERVISED_EXTRACTION_CANDIDATE_LIMIT = supervisedExtractionCandidateLimit;
export const SUPERVISED_EVENT_ATTEMPT_LIMIT = supervisedEventAttemptLimit;
export const SUPERVISED_PROVIDER_REQUEST_LIMIT = supervisedProviderRequestLimit;

export function isSafelyRejectedSupervisedAttempt(result: Pick<PipelineEventResult, "finalState" | "stopStage" | "stopReason" | "criticDecision">): boolean {
  if (result.finalState === "SKIPPED" && result.stopStage === "extraction" && result.stopReason === extractionEvidenceInsufficient) return true;
  if (result.finalState === "SKIPPED" && result.stopStage === "verifier"
    && (result.stopReason === "VERIFICATION_REJECTED" || result.stopReason === "SKIPPED_VERIFICATION_INSUFFICIENT")) return true;
  if (result.finalState === "BLOCKED_REJECTED" && result.stopStage === "verifier" && result.stopReason === "VERIFIER_INPUT_TOO_LARGE") return true;
  if (result.finalState === "BLOCKED_REJECTED" && result.stopStage === "editor" && result.stopReason === "EDITOR_GROUNDING_REJECTED") return true;
  if (result.finalState === "BLOCKED_REVISION_REQUIRED" && result.stopStage === "critic"
    && result.stopReason === "BLOCKED_REVISION_REQUIRED" && result.criticDecision === "revise_editorial") return true;
  return result.finalState === "BLOCKED_REJECTED" && result.stopStage === "critic" && result.stopReason === "BLOCKED_REJECTED";
}

export function assertSupervisedEventLineageIsIndependent(events: readonly { eventKey: string; sourceItems: readonly { candidateId: string }[] }[]): void {
  const eventKeys = new Set<string>();
  const candidateOwners = new Map<string, string>();
  for (const event of events) {
    if (!event.eventKey || eventKeys.has(event.eventKey)) throw new Error("SUPERVISED_EVENT_LINEAGE_AMBIGUOUS");
    eventKeys.add(event.eventKey);
    for (const source of event.sourceItems) {
      const owner = candidateOwners.get(source.candidateId);
      if (!source.candidateId || owner !== undefined) throw new Error("SUPERVISED_EVENT_LINEAGE_AMBIGUOUS");
      candidateOwners.set(source.candidateId, event.eventKey);
    }
  }
}
