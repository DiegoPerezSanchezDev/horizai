import { z } from "zod";

const nonnegativeCount = z.number().int().nonnegative();
const operatorStatusSchema = z.object({
  utcDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  asOfUtc: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  totalReviews: nonnegativeCount,
  waitingReviews: nonnegativeCount,
  holdReviews: nonnegativeCount,
  rejectedReviews: nonnegativeCount,
  approvedReviews: nonnegativeCount,
  approveReviews: nonnegativeCount,
  publishingReviews: nonnegativeCount,
  publishedReviews: nonnegativeCount,
  consumedReviews: nonnegativeCount,
  candidatesToday: nonnegativeCount,
  attemptsToday: nonnegativeCount,
  awaitingReview: nonnegativeCount,
  held: nonnegativeCount,
  rejected: nonnegativeCount,
  approved: nonnegativeCount,
  consumed: nonnegativeCount,
  publishedToday: nonnegativeCount,
  failedToday: nonnegativeCount,
  groqRequests: nonnegativeCount,
  groqTokens: nonnegativeCount,
  groqUnknownUsage: nonnegativeCount,
  activeWork: nonnegativeCount,
  stuckWork: nonnegativeCount,
}).strict();

export type HumanReviewOperatorStatus = z.infer<typeof operatorStatusSchema>;

export function parseHumanReviewOperatorStatus(value: unknown): HumanReviewOperatorStatus {
  const parsed = operatorStatusSchema.safeParse(value);
  if (!parsed.success) throw new Error("HUMAN_REVIEW_STATUS_QUERY_INVALID");
  return parsed.data;
}
