/** Single source of truth: the homepage de-duplicates the latest list against this many featured stories. */
export const FEATURED_STORIES_LIMIT = 5;
export const DAILY_BRIEFING_WINDOW_HOURS = 72;

export function getDailyBriefingStories<T extends { publishedAt: string }>(
  stories: readonly T[],
  asOf: number,
): T[] {
  const cutoff = asOf - DAILY_BRIEFING_WINDOW_HOURS * 60 * 60 * 1000;

  return stories
    .filter((story) => {
      const publishedAt = Date.parse(story.publishedAt);
      return Number.isFinite(publishedAt) && publishedAt >= cutoff && publishedAt <= asOf;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, FEATURED_STORIES_LIMIT);
}

export interface FeaturedStoriesGridConfig {
  count: number;
  leadHasImage: boolean;
  tailRemainder: number;
}

export function getFeaturedStoriesGridConfig(
  stories: readonly { imageUrl?: string | null }[],
): FeaturedStoriesGridConfig {
  const count = stories.length;

  return {
    count,
    leadHasImage: Boolean(stories[0]?.imageUrl),
    // The first two stories get the 7/5 editorial split; later rows use thirds.
    // Expand the final row when it would otherwise leave a visibly empty slot.
    tailRemainder: count >= 4 ? (count - 2) % 3 : 0,
  };
}
