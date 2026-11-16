import type { ExtractedItem } from "../contracts/index.ts";

const sourceIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

export function fixtureItem(
  index: number,
  sourceName: string,
  title: string,
  publishedAt: string,
  description = "OpenAI GPT-5 event context and technical details."
): ExtractedItem {
  return {
    schemaVersion: 1,
    candidateId: `fixture-candidate-${index}`,
    url: `https://example.com/story-${index}`,
    canonicalUrl: `https://example.com/story-${index}`,
    title,
    description,
    author: null,
    publishedAt,
    language: sourceName.includes("EL PAÍS") ? "es" : "en",
    content: `${title}. ${description} This is fixture source material for deterministic clustering.`,
    contentHash: `sha256:${String(index).padStart(64, "0")}`,
    metadata: {
      sourceId: sourceIds[index % sourceIds.length],
      sourceName,
      sourceCountryCode: sourceName.includes("European") ? "BE" : "US",
      sourceRegionCode: sourceName.includes("European") ? "EUROPE" : "US",
      extractionQuality: "full",
    },
    extractionQuality: "full",
  };
}

export const clusteringFixtures = {
  sameEventDifferentTitles: [
    fixtureItem(1, "OpenAI News", "OpenAI launches GPT-5", "2026-09-12T08:00:00Z"),
    fixtureItem(2, "TechCrunch AI", "OpenAI releases its GPT-5 model", "2026-09-12T09:00:00Z"),
  ],
  sameCompanyDifferentEvents: [
    fixtureItem(3, "OpenAI News", "OpenAI launches GPT-5", "2026-09-12T08:00:00Z"),
    fixtureItem(4, "TechCrunch AI", "OpenAI raises a new robotics investment round", "2026-09-12T09:30:00Z", "OpenAI investment and valuation news."),
  ],
  differentModelVersions: [
    fixtureItem(5, "OpenAI News", "OpenAI releases GPT-4.5", "2026-09-12T08:00:00Z", "OpenAI GPT-4.5 model version details."),
    fixtureItem(6, "TechCrunch AI", "OpenAI releases GPT-5", "2026-09-12T08:30:00Z", "OpenAI GPT-5 model version details."),
  ],
  launchVsFunding: [
    fixtureItem(7, "OpenAI News", "OpenAI launches GPT-5", "2026-09-12T08:00:00Z"),
    fixtureItem(8, "TechCrunch AI", "OpenAI funding round values company at $200B", "2026-09-12T08:20:00Z", "OpenAI funding and company valuation."),
  ],
  multilingual: [
    fixtureItem(9, "OpenAI News", "OpenAI launches GPT-5", "2026-09-12T08:00:00Z"),
    fixtureItem(10, "EL PAÍS Tecnología", "OpenAI presenta GPT-5", "2026-09-12T09:00:00Z"),
  ],
  distantDates: [
    fixtureItem(11, "OpenAI News", "OpenAI launches GPT-5", "2026-09-12T08:00:00Z"),
    fixtureItem(12, "TechCrunch AI", "OpenAI launches GPT-5", "2026-09-20T08:00:00Z"),
  ],
  exactDuplicates: [
    fixtureItem(13, "OpenAI News", "OpenAI launches GPT-5", "2026-09-12T08:00:00Z"),
    { ...fixtureItem(13, "TechCrunch AI", "OpenAI launches GPT-5", "2026-09-12T08:00:00Z"), candidateId: "fixture-duplicate", url: "https://example.com/story-13", canonicalUrl: "https://example.com/story-13" },
  ],
  ambiguous: [
    fixtureItem(14, "OpenAI News", "OpenAI details a new model safety research", "2026-09-12T08:00:00Z", "OpenAI model research and safety context."),
    fixtureItem(15, "TechCrunch AI", "OpenAI discusses new model training research", "2026-09-12T11:00:00Z", "OpenAI model research and training context."),
  ],
  threeSources: [
    fixtureItem(16, "OpenAI News", "OpenAI announces GPT-5 availability", "2026-09-12T08:00:00Z"),
    fixtureItem(17, "TechCrunch AI", "OpenAI launches GPT-5 for developers", "2026-09-12T08:30:00Z"),
    fixtureItem(18, "The Verge AI", "OpenAI unveils GPT-5 model", "2026-09-12T09:00:00Z"),
  ],
  singleSource: [fixtureItem(19, "OpenAI News", "OpenAI opens a new research office", "2026-09-12T08:00:00Z", "OpenAI office expansion news.")],
};
