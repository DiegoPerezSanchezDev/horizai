import type { HumanReviewArtifact } from "../agents/publisher/human-review.ts";
import type {
  HumanReviewOperatorSummaryRow,
  SupabaseHumanReviewReadRepository,
} from "../agents/publisher/human-review-read-repository.ts";
import { EditorialLiveDataError, isM32Waiting, mapM32Review, toInboxSummary } from "./live-mapping.ts";
import { toReviewSummary, type EditorialReview, type EditorialReviewDetail } from "./review.ts";

type ReadRepository = Pick<SupabaseHumanReviewReadRepository, "status" | "list" | "inspect">;
export type LiveDependencies = {
  repository: ReadRepository;
  readArtifact: (row: HumanReviewOperatorSummaryRow) => Promise<HumanReviewArtifact>;
  readRevision: (reviewId: string) => Promise<unknown>;
};

async function mapBounded<T, U>(items: readonly T[], concurrency: number, map: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      output[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

export async function listWaitingEditorialReviewsWith(dependencies: LiveDependencies): Promise<{
  waitingCount: number;
  publishedToday: number;
  returned: number;
  limit: number;
  reviews: NonNullable<ReturnType<typeof toInboxSummary>>[];
}> {
  try {
    const [overview, list] = await Promise.all([dependencies.repository.status(), dependencies.repository.list(500)]);
    const waiting = list.reviews.filter(isM32Waiting);
    const reviews = await mapBounded(waiting, 8, async (row) => {
      const artifact = await dependencies.readArtifact(row);
      const revision = row.approval_target_kind === "HUMAN_REVISION" ? await dependencies.readRevision(row.id) : undefined;
      const mapped = mapM32Review(row, artifact, revision);
      const summary = toInboxSummary(mapped.review);
      if (!summary) throw new EditorialLiveDataError("REVIEW_INVALID");
      return summary;
    });
    if (overview.waitingReviews > reviews.length && list.returned < list.limit) throw new EditorialLiveDataError("REVIEW_INVALID");
    return { waitingCount: Math.max(overview.waitingReviews, reviews.length), publishedToday: overview.publishedToday,
      returned: list.returned, limit: list.limit, reviews };
  } catch {
    throw new EditorialLiveDataError("M32_UNAVAILABLE");
  }
}

export async function getEditorialReviewDetailWith(
  reviewId: string,
  dependencies: LiveDependencies,
): Promise<EditorialReviewDetail> {
  try {
    const inspection = await dependencies.repository.inspect(reviewId);
    if (!inspection.found || !inspection.review) throw new EditorialLiveDataError("REVIEW_NOT_FOUND");
    const row = inspection.review;
    const artifact = await dependencies.readArtifact(row);
    const revision = row.approval_target_kind === "HUMAN_REVISION" ? await dependencies.readRevision(row.id) : undefined;
    return mapM32Review(row, artifact, revision, row.source_lineage).detail;
  } catch (error) {
    if (error instanceof EditorialLiveDataError && error.code === "REVIEW_NOT_FOUND") throw error;
    throw new EditorialLiveDataError("M32_UNAVAILABLE");
  }
}

/** Statuses the operator can still act on after the first look: re-decide a HOLD, publish an APPROVED review. */
const actionableQueueStatuses = ["HOLD", "APPROVED"] as const;

/**
 * Secondary queues (HOLD / APPROVED, not yet consumed). Unlike the pending inbox, one unreadable package does not
 * hide the others: it is reported as `unavailable` (id, status and date only, no content) so the operator still sees it exists.
 */
export async function listActionableQueuesWith(dependencies: LiveDependencies): Promise<{
  publishedToday: number;
  reviews: ReturnType<typeof toReviewSummary>[];
  unavailable: { reviewId: string; status: string; createdAt: string }[];
}> {
  try {
    const list = await dependencies.repository.list(500);
    const rows = list.reviews.filter((row) => row.consumed_at === null && (actionableQueueStatuses as readonly string[]).includes(row.status));
    const reviews: ReturnType<typeof toReviewSummary>[] = [];
    const unavailable: { reviewId: string; status: string; createdAt: string }[] = [];
    await mapBounded(rows, 8, async (row) => {
      try {
        const artifact = await dependencies.readArtifact(row);
        const revision = row.approval_target_kind === "HUMAN_REVISION" ? await dependencies.readRevision(row.id) : undefined;
        reviews.push(toReviewSummary(mapM32Review(row, artifact, revision).review));
      } catch {
        unavailable.push({ reviewId: row.id, status: row.status, createdAt: row.created_at });
      }
    });
    const byDate = (left: { createdAt: string }, right: { createdAt: string }) => Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return { publishedToday: list.publishedToday, reviews: reviews.sort(byDate), unavailable: unavailable.sort(byDate) };
  } catch {
    throw new EditorialLiveDataError("M32_UNAVAILABLE");
  }
}

/** Full DTOs of every pending review, for the editorial digest (notification). Fails closed like the inbox. */
export async function loadWaitingEditorialReviewsWith(dependencies: LiveDependencies): Promise<{
  publishedToday: number;
  reviews: EditorialReview[];
}> {
  try {
    const list = await dependencies.repository.list(500);
    const waiting = list.reviews.filter(isM32Waiting);
    const reviews = await mapBounded(waiting, 8, async (row) => {
      const artifact = await dependencies.readArtifact(row);
      const revision = row.approval_target_kind === "HUMAN_REVISION" ? await dependencies.readRevision(row.id) : undefined;
      return mapM32Review(row, artifact, revision).review;
    });
    return { publishedToday: list.publishedToday, reviews };
  } catch {
    throw new EditorialLiveDataError("M32_UNAVAILABLE");
  }
}
