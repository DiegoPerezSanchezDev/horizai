import type { VerifierInput } from "./verifier-types.ts";

export const verifierFixtureSourceIds = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
] as const;

/** Shared canonical fixture used by offline tests and supervised capacity planning. */
export function createVerifierInputFixture(label = "confirmed", sourceCount = 2): VerifierInput {
  const selectedIds = verifierFixtureSourceIds.slice(0, sourceCount);
  const items = selectedIds.map((sourceId, index) => ({
    schemaVersion: 1 as const,
    candidateId: `candidate-${index + 1}`,
    url: `https://example.com/article-${index + 1}`,
    canonicalUrl: `https://example.com/article-${index + 1}`,
    title: "AI model announcement",
    description: "A source describes a recent announcement.",
    author: null,
    publishedAt: "2026-09-12T08:00:00Z",
    language: "en",
    content: "The source reports an announcement with a specific, checkable fact.",
    contentHash: `hash-${index + 1}-12345678`,
    metadata: { sourceId, sourceName: `Source ${index + 1}` },
  }));

  return {
    event: {
      schemaVersion: 1,
      eventKey: `event-${label}`,
      canonicalTitle: "AI model announcement",
      sourceItems: items.map((item, index) => ({
        candidateId: item.candidateId,
        sourceId: selectedIds[index],
        sourceName: `Source ${index + 1}`,
        url: item.url,
        title: item.title,
        publishedAt: item.publishedAt,
      })),
      probableOccurredAt: "2026-09-12T08:00:00Z",
      probableCountryCode: "US",
      probableRegionCode: "US",
      clusterConfidence: 80,
    },
    items,
    sources: items.map((item, index) => ({
      sourceId: selectedIds[index],
      sourceName: `Source ${index + 1}`,
      sourceUrl: item.url,
      countryCode: "US",
      language: "en",
    })),
  };
}

/** Synthetic attribution chain for regression coverage; it is not sourced from a real article. */
export function createSecondaryAttributionVerifierInputFixture(): VerifierInput {
  const input = createVerifierInputFixture("secondary-attribution", 1);
  input.event.canonicalTitle = "Project X launch report";
  input.event.sourceItems[0].title = "Source A reports Outlet B statement";
  input.items[0].title = "Source A reports Outlet B statement";
  input.items[0].content = "Source A reports that Outlet B reportedly says Project X will launch in October. Source A provides no independent confirmation of the launch date.";
  return input;
}
