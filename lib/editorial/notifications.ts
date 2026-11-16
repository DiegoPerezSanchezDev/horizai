import type { EditorialReview } from "./review.ts";

export interface EditorialNotification {
  notificationId: string;
  reviewId: string;
  headline: string;
  shortReason: string;
  createdAt: string;
  status: "PREPARED" | "DELIVERED" | "READ" | "DISMISSED";
  targetPath: string;
  dedupeKey: string;
}

/** Supplied by a future durable store. Reserved keys also suppress concurrent delivery. */
export interface EditorialNotificationState {
  deliveredDedupeKeys: readonly string[];
  reservedDedupeKeys: readonly string[];
}

export type NotificationIneligibilityReason = "REVIEW_MISSING" | "NOT_WAITING" | "CONSUMED" |
  "CRITIC_PROOF_REQUIRED" | "M34_REQUIRED" | "SOURCE_LINEAGE_REQUIRED" | "INVALID_TARGET" |
  "ALREADY_NOTIFIED" | "QUALITY_THRESHOLD_NOT_MET";

function validTarget(review: EditorialReview): boolean {
  return /^[a-f0-9]{64}$/.test(review.approvalTargetSha256) &&
    /^[a-f0-9]{64}$/.test(review.sourceLineageSha256) &&
    (review.approvalTarget === "HUMAN_REVISION" ? !!review.humanRevisionId : review.humanRevisionId === null && !!review.draftId);
}

export function editorialNotificationDedupeKey(review: EditorialReview): string {
  // Versioned tuple encoding prevents delimiter collisions. No headline/time/poller identity.
  return JSON.stringify(["editorial-v1", review.reviewId, review.approvalTarget,
    review.humanRevisionId ?? review.draftId, review.approvalTargetSha256, review.sourceLineageSha256]);
}

export function getEditorialNotificationEligibility(
  review: EditorialReview | null,
  state: EditorialNotificationState,
  options: { minimumEditorialQuality?: number } = {},
): { eligible: boolean; reasons: NotificationIneligibilityReason[]; dedupeKey: string | null } {
  if (!review) return { eligible: false, reasons: ["REVIEW_MISSING"], dedupeKey: null };
  const reasons: NotificationIneligibilityReason[] = [];
  if (review.reviewStatus !== "WAITING_FOR_HUMAN_REVIEW") reasons.push("NOT_WAITING");
  if (review.consumed !== false) reasons.push("CONSUMED");
  if (review.criticProofStatus !== "PASS") reasons.push("CRITIC_PROOF_REQUIRED");
  if (review.m34Status !== "PASS") reasons.push("M34_REQUIRED");
  if (review.sourceLineageStatus !== "PASS") reasons.push("SOURCE_LINEAGE_REQUIRED");
  if (!validTarget(review)) reasons.push("INVALID_TARGET");
  const dedupeKey = editorialNotificationDedupeKey(review);
  if (state.deliveredDedupeKeys.includes(dedupeKey) || state.reservedDedupeKeys.includes(dedupeKey)) reasons.push("ALREADY_NOTIFIED");
  const minimum = options.minimumEditorialQuality;
  if (minimum !== undefined && (!Number.isFinite(minimum) || review.rankerScore === null || review.rankerScore < minimum)) reasons.push("QUALITY_THRESHOLD_NOT_MET");
  return { eligible: reasons.length === 0, reasons, dedupeKey };
}

/** Minimum future payload: no article body, proofs, raw lineage or credentials. No delivery. */
export function prepareEditorialNotification(review: EditorialReview, createdAt: string, state: EditorialNotificationState): EditorialNotification | null {
  if (!getEditorialNotificationEligibility(review, state).eligible || !Number.isFinite(Date.parse(createdAt))) return null;
  const dedupeKey = editorialNotificationDedupeKey(review);
  return {
    notificationId: dedupeKey, reviewId: review.reviewId, headline: review.headline,
    shortReason: "Critic y verificación factual superados", createdAt, status: "PREPARED",
    targetPath: `/editorial/reviews/${encodeURIComponent(review.reviewId)}`, dedupeKey,
  };
}

export const EDITORIAL_NOTIFICATION_TITLE = "Noticia lista para revisar";
