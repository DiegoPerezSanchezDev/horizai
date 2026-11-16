import { discoveryCandidateSchema, type DiscoveryCandidate } from "../contracts/index.ts";
import { candidateExternalId, canonicalizeUrl, stableHash } from "./canonical-url.ts";
import type { ParsedFeedItem, SourceRegistryEntry, CandidateRecord } from "./discovery-types.ts";

const countryRegions: Record<string, string> = {
  US: "US",
  GB: "UK",
  ES: "SPAIN",
  CN: "CHINA",
  IN: "INDIA",
  JP: "JAPAN",
  KR: "SOUTH-KOREA",
  FR: "EUROPE",
  DE: "EUROPE",
  IT: "EUROPE",
};

function cleanText(value: string | null, maxLength: number): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim() || null;
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function normalizeCandidate(
  source: SourceRegistryEntry,
  item: ParsedFeedItem,
  discoveredAt: Date
): { record: CandidateRecord } | { error: string } {
  if (!item.url) return { error: "missing item URL" };
  if (!item.title) return { error: "missing item title" };

  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeUrl(item.url);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid item URL" };
  }

  const title = cleanText(item.title, 500);
  const excerpt = cleanText(item.excerpt, 2_000);
  const candidate: DiscoveryCandidate = {
    schemaVersion: 1,
    externalId: candidateExternalId(source.id, canonicalUrl),
    sourceId: source.id,
    sourceName: source.name,
    url: canonicalUrl,
    titleOriginal: title ?? "",
    excerptOriginal: excerpt,
    language: source.language,
    publishedAt: item.publishedAt,
    discoveredAt: discoveredAt.toISOString(),
    possibleCountryCode: source.countryCode,
    possibleRegionCode: source.countryCode ? countryRegions[source.countryCode] ?? null : null,
  };
  const parsed = discoveryCandidateSchema.safeParse(candidate);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "candidate schema rejected item" };

  const contentHash = title ? stableHash(`${title}\n${excerpt ?? ""}`) : null;
  return { record: { candidate: parsed.data, canonicalUrl, contentHash } };
}
