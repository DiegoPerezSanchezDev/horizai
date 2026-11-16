import type { ComparableItem, PairScore } from "./cluster-types.ts";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function calculateClusterConfidence(items: ComparableItem[], pairScores: PairScore[]): number {
  if (items.length === 1) return 45;
  const averagePairScore = pairScores.length === 0 ? 0 : pairScores.reduce((sum, pair) => sum + pair.score, 0) / pairScores.length;
  const distinctSources = new Set(items.map((item) => item.sourceId)).size;
  const sourceDiversity = Math.min(1, (distinctSources - 1) / 3);
  const officialEvidence = items.some((item) => item.officialSource) ? 1 : 0;
  const confidence = averagePairScore * 70 + sourceDiversity * 20 + officialEvidence * 10;
  return Math.round(clamp(confidence) * 100) / 100;
}
