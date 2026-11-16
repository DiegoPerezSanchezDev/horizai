import type { ClusteredEvent, ExtractedItem } from "../contracts/index.ts";
import type { ExtractionRunResult } from "../extraction/extraction-types.ts";
import { freshExtractionResults } from "../extraction/freshness-policy.ts";

/** Read-only diagnostic adapter. ExtractionResult is a wrapper, not an ExtractedItem. */
export function selectionPreflightContexts(extraction: ExtractionRunResult, events: readonly ClusteredEvent[]): Array<{ event: ClusteredEvent; items: ExtractedItem[] }> {
  const items = freshExtractionResults(extraction).flatMap((result) => result.item ? [result.item] : []);
  return events.map((event) => {
    const candidateIds = new Set(event.sourceItems.map((source) => source.candidateId));
    const members = items.filter((item) => candidateIds.has(item.candidateId));
    if (members.length === 0) throw new Error("PREFLIGHT_EVENT_ITEM_LINEAGE_MISSING");
    return { event, items: members };
  }).sort((left, right) => {
    const first = (event: ClusteredEvent) => event.sourceItems.map((source) => source.publishedAt ? Date.parse(source.publishedAt) : Number.MAX_SAFE_INTEGER).sort((a, b) => a - b)[0] ?? Number.MAX_SAFE_INTEGER;
    return first(left.event) - first(right.event) || left.event.eventKey.localeCompare(right.event.eventKey);
  });
}
