import { stableHash } from "../discovery/canonical-url.ts";
import type { ComparableItem } from "./cluster-types.ts";

function eventDay(items: ComparableItem[]): string {
  const timestamps = items.map((item) => item.publishedAtMs).filter((value): value is number => value !== null).sort((a, b) => a - b);
  return timestamps.length === 0 ? "unknown" : new Date(timestamps[Math.floor(timestamps.length / 2)]).toISOString().slice(0, 10);
}

export function chooseCanonicalTitle(items: ComparableItem[]): string {
  const sorted = [...items].sort((left, right) => {
    if (left.officialSource !== right.officialSource) return left.officialSource ? -1 : 1;
    if (left.relevantTokens.size !== right.relevantTokens.size) return right.relevantTokens.size - left.relevantTokens.size;
    return left.item.title.localeCompare(right.item.title);
  });
  return sorted[0]?.item.title ?? "Untitled event";
}

export function buildEventKey(items: ComparableItem[], canonicalTitle: string): string {
  const country = [...new Set(items.map((item) => item.sourceCountryCode).filter(Boolean))].sort().join(",") || "global";
  const signature = `${canonicalTitle.toLocaleLowerCase()}|${eventDay(items)}|${country}`;
  return `event-${stableHash(signature).slice(0, 32)}`;
}
