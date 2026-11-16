import type { HumanReviewArtifact } from "./human-review.ts";
import type { HumanReviewChecks, HumanReviewDecision } from "./human-review-repository.ts";
import type { HumanReviewOperatorReadRow, HumanReviewOperatorSummaryRow } from "./human-review-read-repository.ts";
import { assertHumanReviewDecisionAllowed } from "./human-review-policy.ts";

export function buildHumanReviewListEntry(row: HumanReviewOperatorSummaryRow, artifact: HumanReviewArtifact) {
  return {
    reviewId: row.id,
    eventId: "eventId" in row && typeof row.eventId === "string" ? row.eventId : row.event_key,
    event: row.event_key,
    attempt: row.attempt_id,
    action: row.action ?? null,
    status: row.status,
    headline: artifact.draft.headlineEs,
    sources: artifact.publicationPayload.sources.map((source) => ({ name: source.sourceName, url: source.url })),
    critic: { decision: artifact.reviewEvidence.critic.decision, findings: artifact.reviewEvidence.critic.issues, unsupportedClaims: artifact.reviewEvidence.critic.unsupportedClaims },
    createdAt: row.created_at,
    waitingSince: row.status === "WAITING_FOR_HUMAN_REVIEW" ? row.created_at : null,
    factualApproval: row.facts_acceptable,
    attributionApproval: row.attribution_acceptable,
    factualReviewState: row.facts_acceptable,
    attributionReviewState: row.attribution_acceptable,
    reviewerApproved: row.reviewer_approved ?? null,
    consumedAt: row.consumed_at ?? null,
    publishedArticleId: row.published_article_id ?? null,
    packageIntegrity: "PASS" as const,
    approvalTarget: {
      kind: row.approval_target_kind,
      revisionId: row.approval_target_revision_id,
      revisionSha256: row.approval_target_revision_sha256,
      approvedRevisionSha256: row.approved_revision_sha256,
    },
  };
}

export function buildHumanReviewInspection(row: HumanReviewOperatorReadRow, artifact: HumanReviewArtifact, currentCheckpoints: "PASS" | "STALE", humanRevision?: { corrected_draft: HumanReviewArtifact["draft"]; human_revision_proof: unknown }) {
  return {
    review: row,
    integrity: { package: "PASS" as const, currentCheckpoints },
    approvalTarget: {
      kind: row.approval_target_kind,
      revisionId: row.approval_target_revision_id,
      revisionSha256: row.approval_target_revision_sha256,
      approvedRevisionSha256: row.approved_revision_sha256,
      draft: humanRevision?.corrected_draft ?? artifact.draft,
      humanRevisionProof: humanRevision?.human_revision_proof ?? null,
    },
    modelDraft: artifact.draft,
    headline: (humanRevision?.corrected_draft ?? artifact.draft).headlineEs,
    summary: (humanRevision?.corrected_draft ?? artifact.draft).summaryEs,
    whyItMatters: (humanRevision?.corrected_draft ?? artifact.draft).whyItMattersEs,
    body: (humanRevision?.corrected_draft ?? artifact.draft).bodyEs,
    verifier: artifact.reviewEvidence.verifier,
    attribution: { status: artifact.reviewEvidence.attributionStatus, sourceLineage: artifact.sourceLineage },
    uncertainty: { status: artifact.reviewEvidence.uncertaintyStatus, claims: artifact.reviewEvidence.verifier.uncertainClaims },
    critic: artifact.reviewEvidence.critic,
    classification: artifact.reviewEvidence.classifier,
    ranking: artifact.reviewEvidence.ranking,
    regionGeo: artifact.reviewEvidence.geo,
    providerAccounting: artifact.reviewEvidence.providerAccounting,
    reviewManifest: artifact.reviewManifest,
    publicationPayload: artifact.publicationPayload,
  };
}

export function buildHumanReviewDecision(input: {
  reviewId: string;
  row: Pick<HumanReviewOperatorReadRow, "status">;
  decision: HumanReviewDecision;
  reviewerId: string;
  checks: HumanReviewChecks;
}) {
  assertHumanReviewDecisionAllowed({ currentStatus: input.row.status, decision: input.decision, reviewerId: input.reviewerId, checks: input.checks });
  return { reviewId: input.reviewId, decision: input.decision, reviewerId: input.reviewerId, checks: input.checks };
}
