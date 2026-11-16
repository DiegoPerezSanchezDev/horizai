import { z } from "zod";

const identity = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const proof = z.enum(["PASS", "FAIL", "UNKNOWN"]);

const score = z.number().finite();
const claimLine = z.object({ claim: z.string().min(1), sources: z.array(z.string().min(1)) }).strict();

/**
 * Real pipeline evidence shown to the operator (Ranker scores, Verifier facts/uncertainties, Critic notes).
 * Every value is copied from the verified review package; nothing is derived or invented here.
 */
export const editorialEvidenceSchema = z.object({
  ranking: z.object({
    importanceScore: score.nullable(),
    impact: score, novelty: score, reach: score, credibility: score, economicImpact: score, momentum: score,
    rankReason: z.string().min(1),
  }).strict(),
  verification: z.object({
    status: z.string().min(1),
    confidenceScore: score,
    reason: z.string().min(1),
    verifiedFacts: z.array(claimLine),
    uncertainClaims: z.array(claimLine),
    contradictions: z.array(claimLine),
  }).strict(),
  critic: z.object({
    decision: z.string().min(1),
    severity: z.string().min(1),
    notes: z.string().min(1),
    issues: z.array(z.object({ code: z.string().min(1), severity: z.string().min(1), message: z.string().min(1) }).strict()),
    unsupportedClaims: z.array(z.object({ claim: z.string().min(1), reason: z.string().min(1) }).strict()),
  }).strict(),
}).strict();
export type EditorialEvidence = z.infer<typeof editorialEvidenceSchema>;

export const editorialReviewSchema = z.object({
  reviewId: identity,
  attemptId: identity,
  reviewStatus: z.enum(["WAITING_FOR_HUMAN_REVIEW", "APPROVED", "HOLD", "REJECTED", "PUBLISHING", "PUBLISHED"]),
  consumed: z.boolean(),
  articleId: identity.nullable(),
  // Pipeline draft ids include the run id and event key, separated by a colon.
  draftId: z.string().min(1).max(256),
  humanRevisionId: identity.nullable(),
  approvalTarget: z.enum(["ORIGINAL", "HUMAN_REVISION"]),
  approvalTargetSha256: digest,
  sourceLineageSha256: digest,
  criticProofStatus: proof,
  m34Status: proof,
  sourceLineageStatus: proof,
  headline: z.string().min(1),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  country: z.string().nullable(),
  region: z.string().nullable(),
  category: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  rankerScore: z.number().finite().nullable(),
  /** Manifest package SHA-256: the "expected package" every decision and publication must quote. */
  packageSha256: digest.optional(),
  evidence: editorialEvidenceSchema.optional(),
  body: z.array(z.object({
    kind: z.enum(["paragraph", "heading"]),
    text: z.string().min(1),
  }).strict()).min(1),
  sources: z.array(z.object({
    publisher: z.string().min(1),
    title: z.string().min(1),
    url: z.string().url().refine((value) => ["https:", "http:"].includes(new URL(value).protocol)),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    classification: z.enum(["PRIMARY", "SECONDARY"]).nullable(),
  }).strict()),
  warnings: z.array(z.object({
    id: identity,
    severity: z.enum(["INFO", "WARNING", "BLOCKER"]),
    title: z.string().min(1),
    detail: z.string().min(1),
  }).strict()),
}).strict().superRefine((review, context) => {
  if ((review.approvalTarget === "HUMAN_REVISION") !== (review.humanRevisionId !== null)) {
    context.addIssue({ code: "custom", message: "Approval target and human revision must agree" });
  }
});

/** Allowlisted operator DTO. Never pass raw M32 rows or checkpoint packages to the UI. */
export type EditorialReview = z.infer<typeof editorialReviewSchema>;
const editorialDraftSnapshotSchema = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  whyItMatters: z.string().min(1),
  body: z.array(z.object({ kind: z.enum(["paragraph", "heading"]), text: z.string().min(1) }).strict()).min(1),
}).strict();

/** Detail-only representation needed to compare the original and corrected target. */
export const editorialReviewDetailSchema = z.object({
  review: editorialReviewSchema,
  originalDraft: editorialDraftSnapshotSchema,
  mode: z.enum(["FIXTURE", "LIVE_READ_ONLY"]),
}).strict();
export type EditorialReviewDetail = z.infer<typeof editorialReviewDetailSchema>;
export type EditorialWarning = EditorialReview["warnings"][number];
export type EditorialReviewSummary = Pick<EditorialReview,
  "reviewId" | "reviewStatus" | "headline" | "summary" | "whyItMatters" | "country" |
  "region" | "category" | "createdAt" | "rankerScore" | "humanRevisionId" | "warnings"
> & {
  sourceCount: number;
  primarySource: string | null;
  primarySourceCount: number;
  secondarySourceCount: number;
  unclassifiedSourceCount: number;
  latestSourcePublishedAt: string | null;
  selectionReason: string | null;
  packageSha256: string | null;
};

export function isWaitingReview(review: EditorialReview): boolean {
  return review.reviewStatus === "WAITING_FOR_HUMAN_REVIEW" && !review.consumed;
}

export function toReviewSummary(review: EditorialReview): EditorialReviewSummary {
  return {
    reviewId: review.reviewId, reviewStatus: review.reviewStatus,
    headline: review.headline, summary: review.summary, whyItMatters: review.whyItMatters,
    country: review.country, region: review.region, category: review.category,
    createdAt: review.createdAt, rankerScore: review.rankerScore,
    humanRevisionId: review.humanRevisionId, warnings: review.warnings,
    sourceCount: review.sources.length,
    primarySourceCount: review.sources.filter((source) => source.classification === "PRIMARY").length,
    secondarySourceCount: review.sources.filter((source) => source.classification === "SECONDARY").length,
    unclassifiedSourceCount: review.sources.filter((source) => source.classification === null).length,
    latestSourcePublishedAt: review.sources
      .map((source) => source.publishedAt)
      .filter((value): value is string => value !== null)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null,
    selectionReason: review.evidence?.ranking.rankReason ?? null,
    packageSha256: review.packageSha256 ?? null,
    primarySource: (review.sources.find((source) => source.classification === "PRIMARY") ?? review.sources[0])?.publisher ?? null,
  };
}

/** Future request contract only; there is deliberately no submit function or endpoint. */
export function getExpectedApproval(review: EditorialReview) {
  return {
    reviewId: review.reviewId,
    attemptId: review.attemptId,
    articleId: review.articleId,
    draftId: review.draftId,
    humanRevisionId: review.humanRevisionId,
    approvalTarget: review.approvalTarget,
    expectedReviewStatus: review.reviewStatus,
    expectedConsumed: review.consumed,
    expectedApprovalTargetSha256: review.approvalTargetSha256,
    expectedSourceLineageSha256: review.sourceLineageSha256,
  };
}

export type ExpectedEditorialApproval = ReturnType<typeof getExpectedApproval>;

export function formatEditorialDate(value: string): string {
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid",
  }).format(new Date(value));
}
