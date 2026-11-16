import { supervisedEventAttemptLimit } from "../pipeline/supervised-limits.ts";
import type { HumanReviewChecks, HumanReviewDecision } from "./human-review-repository.ts";
import { canonicalJsonString } from "../pipeline/factual-remediation-continuation.ts";

export const dailyHumanReviewPublicationLimit = 2;
export const dailySupervisedCandidateLimit = supervisedEventAttemptLimit;

export type HumanReviewPublicationAuthorization = {
  action: "APPROVE";
  status: "APPROVED";
  eventKey: string;
  attemptId: string;
  pipelineRunId: string;
  draftId: string;
  draftSha256: string;
  packageSha256: string;
  checkpoints: unknown;
  sourceLineage: unknown;
  criticPass: true;
  usageSettled: true;
  factualReviewPassed: true;
  attributionReviewPassed: true;
  uncertaintyReviewPassed: true;
  headlineReviewPassed: true;
  summaryReviewPassed: true;
  noUnsupportedMaterialClaims: true;
  sourceChainPassed: true;
  approvalTargetKind: "ORIGINAL" | "HUMAN_REVISION";
  approvalTargetRevisionSha256: string | null;
  approvedRevisionSha256: string | null;
  lineageCurrent: true;
  manifestCurrent: true;
  approvalConsumed: false;
  publishedToday: number;
};

export function assertHumanReviewDecisionAllowed(input: {
  currentStatus: string;
  decision: HumanReviewDecision;
  reviewerId: string;
  checks: HumanReviewChecks;
}): void {
  if (!input.reviewerId.trim()) throw new Error("HUMAN_REVIEW_REVIEWER_REQUIRED");
  if (input.currentStatus !== "WAITING_FOR_HUMAN_REVIEW" && input.currentStatus !== "HOLD") throw new Error("HUMAN_REVIEW_DECISION_NOT_ALLOWED");
  if (input.decision === "APPROVE" && Object.values(input.checks).some((check) => check !== true)) {
    throw new Error("HUMAN_APPROVAL_REQUIRES_ALL_SEVEN_CHECKS_TO_PASS");
  }
}

export function assertHumanReviewPublishable(status: string): void {
  if (status !== "APPROVED") throw new Error(`HUMAN_REVIEW_NOT_APPROVED:${status}`);
}

export function assertDailyHumanReviewPublicationLimit(publishedToday: number, publicationsRequested: number): void {
  if (!Number.isSafeInteger(publishedToday) || publishedToday < 0 || !Number.isSafeInteger(publicationsRequested) || publicationsRequested < 1
    || publicationsRequested > dailyHumanReviewPublicationLimit || publishedToday + publicationsRequested > dailyHumanReviewPublicationLimit) {
    throw new Error("HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT_REACHED");
  }
}

export function assertSupervisedCandidateAdmission(admittedToday: number, candidatesRequested: number): void {
  if (!Number.isSafeInteger(admittedToday) || admittedToday < 0 || admittedToday > dailySupervisedCandidateLimit
    || !Number.isSafeInteger(candidatesRequested) || candidatesRequested < 1
    || admittedToday + candidatesRequested > dailySupervisedCandidateLimit) {
    throw new Error("SUPERVISED_DAILY_CANDIDATE_LIMIT_EXCEEDED");
  }
}

export function assertHumanReviewPublicationAuthorization(authorization: HumanReviewPublicationAuthorization): void {
  if (authorization.action !== "APPROVE" || authorization.status !== "APPROVED" || !authorization.criticPass
    || !authorization.usageSettled || !authorization.factualReviewPassed || !authorization.attributionReviewPassed
    || !authorization.uncertaintyReviewPassed || !authorization.headlineReviewPassed || !authorization.summaryReviewPassed
    || !authorization.noUnsupportedMaterialClaims || !authorization.sourceChainPassed
    || !authorization.lineageCurrent || !authorization.manifestCurrent || authorization.approvalConsumed) {
    throw new Error("HUMAN_APPROVAL_REQUIRED");
  }
  if (!authorization.eventKey.trim() || !authorization.attemptId.trim() || !authorization.pipelineRunId.trim()
    || !authorization.draftId.trim() || !/^[a-f0-9]{64}$/.test(authorization.draftSha256)
    || !/^[a-f0-9]{64}$/.test(authorization.packageSha256)) throw new Error("HUMAN_APPROVAL_REQUIRED");
  if ((authorization.approvalTargetKind === "ORIGINAL" && (authorization.approvalTargetRevisionSha256 !== null || authorization.approvedRevisionSha256 !== null))
    || (authorization.approvalTargetKind === "HUMAN_REVISION" && (!authorization.approvalTargetRevisionSha256
      || authorization.approvedRevisionSha256 !== authorization.approvalTargetRevisionSha256
      || !/^[a-f0-9]{64}$/.test(authorization.approvalTargetRevisionSha256)))) throw new Error("HUMAN_APPROVAL_REQUIRED");
  assertDailyHumanReviewPublicationLimit(authorization.publishedToday, 1);
}

export function assertHumanReviewPublicationTarget(target: {
  eventKey: string;
  attemptId: string;
  pipelineRunId: string;
  draftId: string;
  draftSha256: string;
  packageSha256: string;
  checkpoints: unknown;
  sourceLineage: unknown;
  approvalTargetRevisionSha256?: string | null;
  authorization: HumanReviewPublicationAuthorization;
}): void {
  assertHumanReviewPublicationAuthorization(target.authorization);
  if (target.authorization.eventKey !== target.eventKey || target.authorization.attemptId !== target.attemptId
    || target.authorization.pipelineRunId !== target.pipelineRunId || target.authorization.draftId !== target.draftId
    || target.authorization.draftSha256 !== target.draftSha256 || target.authorization.packageSha256 !== target.packageSha256
    || (target.approvalTargetRevisionSha256 ?? null) !== target.authorization.approvalTargetRevisionSha256
    || canonicalJsonString(target.authorization.checkpoints) !== canonicalJsonString(target.checkpoints)
    || canonicalJsonString(target.authorization.sourceLineage) !== canonicalJsonString(target.sourceLineage)) {
    throw new Error("HUMAN_APPROVAL_REQUIRED");
  }
}

export function assertSupervisedCandidateLimit(candidateLimit: number): void {
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > dailySupervisedCandidateLimit) {
    throw new Error("SUPERVISED_DAILY_CANDIDATE_LIMIT_EXCEEDED");
  }
}
