export const clusteringConfig = {
  maxTimeGapHours: 72,
  mergeThreshold: 0.72,
  needsReviewThreshold: 0.62,
  weights: {
    title: 0.42,
    description: 0.18,
    relevantTokens: 0.18,
    temporal: 0.12,
    entityEvidence: 0.1,
  },
} as const;

export type ClusteringConfig = typeof clusteringConfig;
