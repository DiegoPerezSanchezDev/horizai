import type { ExtractionResult, ExtractionRunResult } from "./extraction-types.ts";

export type FreshnessReason = "FRESH" | "OUTSIDE_FRESHNESS_WINDOW" | "MISSING_FRESHNESS_TIMESTAMP" | "INVALID_PUBLISHED_AT" | "FUTURE_PUBLISHED_AT";

export type FreshnessDecision = {
  sourceItemId: string;
  rawItemId: string | null;
  publishedAt: string | null;
  discoveredAt: string | null;
  effectiveFreshnessAt: string | null;
  windowHours: number;
  cutoffAt: string;
  eligible: boolean;
  reason: FreshnessReason;
};

export type ExtractionFreshnessSummary = {
  referenceTime: string;
  windowHours: number;
  evaluated: number;
  fresh: number;
  stale: number;
  decisions: FreshnessDecision[];
};

function parseTimestamp(value: string | null): number | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return Date.parse(value);
}

export function resolveContentFreshnessTimestamp(input: { publishedAt: string | null; discoveredAt: string | null }, referenceTime: Date): { timestamp: string | null; reason: FreshnessReason } {
  if (input.publishedAt !== null && input.publishedAt.trim() !== "") {
    const publishedMs = parseTimestamp(input.publishedAt);
    if (publishedMs === null) return { timestamp: null, reason: "INVALID_PUBLISHED_AT" };
    if (publishedMs > referenceTime.getTime()) return { timestamp: new Date(publishedMs).toISOString(), reason: "FUTURE_PUBLISHED_AT" };
    return { timestamp: new Date(publishedMs).toISOString(), reason: "FRESH" };
  }
  const discoveredMs = parseTimestamp(input.discoveredAt);
  if (discoveredMs === null) return { timestamp: null, reason: "MISSING_FRESHNESS_TIMESTAMP" };
  if (discoveredMs > referenceTime.getTime()) return { timestamp: new Date(discoveredMs).toISOString(), reason: "FUTURE_PUBLISHED_AT" };
  return { timestamp: new Date(discoveredMs).toISOString(), reason: "FRESH" };
}

export function evaluateContentFreshness(input: { sourceItemId: string; rawItemId: string | null; publishedAt: string | null; discoveredAt: string | null }, referenceTime: Date, windowHours: number): FreshnessDecision {
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new Error("Freshness window must be positive");
  const cutoff = new Date(referenceTime.getTime() - windowHours * 60 * 60 * 1000);
  const resolved = resolveContentFreshnessTimestamp(input, referenceTime);
  const eligible = resolved.timestamp !== null && resolved.reason === "FRESH" && Date.parse(resolved.timestamp) >= cutoff.getTime() && Date.parse(resolved.timestamp) <= referenceTime.getTime();
  return { ...input, effectiveFreshnessAt: resolved.timestamp, windowHours, cutoffAt: cutoff.toISOString(), eligible, reason: eligible ? "FRESH" : resolved.reason === "FRESH" ? "OUTSIDE_FRESHNESS_WINDOW" : resolved.reason };
}

function decisionForResult(result: ExtractionResult, referenceTime: Date, windowHours: number): FreshnessDecision | null {
  if (!result.item) return null;
  return evaluateContentFreshness({ sourceItemId: result.candidate.externalId, rawItemId: result.rawItemId, publishedAt: result.item.publishedAt, discoveredAt: result.candidate.discoveredAt }, referenceTime, windowHours);
}

export function applyExtractionFreshness(result: ExtractionRunResult, referenceTime: Date, windowHours = result.hours): ExtractionRunResult {
  const decisions = result.results.map((item) => decisionForResult(item, referenceTime, windowHours)).filter((item): item is FreshnessDecision => item !== null);
  return { ...result, freshness: { referenceTime: referenceTime.toISOString(), windowHours, evaluated: decisions.length, fresh: decisions.filter((item) => item.eligible).length, stale: decisions.filter((item) => !item.eligible).length, decisions } };
}

export function freshExtractionResults(result: ExtractionRunResult): ExtractionResult[] {
  if (!result.freshness) return result.results.filter((item) => item.item !== null);
  const eligible = new Set(result.freshness.decisions.filter((item) => item.eligible).map((item) => item.sourceItemId));
  return result.results.filter((item) => item.item !== null && eligible.has(item.candidate.externalId));
}
