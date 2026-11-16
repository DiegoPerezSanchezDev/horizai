import "server-only";
import { requireEditorialDevelopmentAccess } from "./access.ts";
import { isWaitingReview, toReviewSummary, type EditorialReview, type EditorialReviewSummary } from "./review.ts";

export interface EditorialDataAdapter {
  listWaitingReviews(scenario?: "pending" | "empty"): Promise<EditorialReviewSummary[]>;
  getReviewForOperator(id: string): Promise<EditorialReview | null>;
}

async function readDevelopmentFixtures(): Promise<EditorialReview[]> {
  // Guard at the data boundary as well as the layout; layouts alone do not protect pages.
  await requireEditorialDevelopmentAccess();
  const { editorialFixtures } = await import("./fixtures.ts");
  return editorialFixtures;
}

// No live mode, Supabase imports, credentials or mutation capability in UI-06.
export const editorialData: EditorialDataAdapter = {
  async listWaitingReviews(scenario = "pending") {
    const reviews = await readDevelopmentFixtures();
    return (scenario === "empty" ? [] : reviews).filter(isWaitingReview).map(toReviewSummary);
  },
  async getReviewForOperator(id) {
    return (await readDevelopmentFixtures()).find((review) => review.reviewId === id) ?? null;
  },
};
