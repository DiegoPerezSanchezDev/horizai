import type { ClusteredEvent, ExtractedItem } from "../contracts/index.ts";
import type { ClusteringConfig } from "./clustering-config.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/database.ts";

export type ComparableItem = {
  item: ExtractedItem;
  titleNormalized: string;
  descriptionNormalized: string;
  titleTokens: Set<string>;
  descriptionTokens: Set<string>;
  relevantTokens: Set<string>;
  entityTokens: Set<string>;
  modelSignatures: Set<string>;
  numberTokens: Set<string>;
  sourceId: string;
  sourceName: string;
  sourceCountryCode: string | null;
  sourceRegionCode: string | null;
  publishedAtMs: number | null;
  officialSource: boolean;
};

export type PairDecision = "merge" | "needs_review" | "separate";

export type PairScore = {
  leftCandidateId: string;
  rightCandidateId: string;
  score: number;
  decision: PairDecision;
  reasons: string[];
  metrics: {
    titleSimilarity: number;
    descriptionSimilarity: number;
    relevantTokenSimilarity: number;
    temporalSimilarity: number;
    entityEvidence: number;
    timeGapHours: number | null;
  };
};

export type EventCluster = {
  items: ComparableItem[];
  pairScores: PairScore[];
  needsReview: boolean;
  ambiguousPairs: PairScore[];
};

export type ClusterReport = {
  generatedAt: string;
  config: ClusteringConfig;
  extractedItems: number;
  duplicatesRemoved: number;
  pairScores: PairScore[];
  ambiguousPairs: PairScore[];
  clusters: Array<{
    eventKey: string;
    canonicalTitle: string;
    clusterConfidence: number;
    needsReview: boolean;
    members: Array<{
      candidateId: string;
      sourceId: string;
      sourceName: string;
      url: string;
      title: string;
      publishedAt: string | null;
    }>;
    pairScores: PairScore[];
    reasons: string[];
  }>;
};

export type ClusterRunResult = {
  extractedItems: number;
  duplicatesRemoved: number;
  events: ClusteredEvent[];
  multiSourceEvents: number;
  singleSourceEvents: number;
  largestCluster: number;
  needsReview: number;
  possibleFalseMerges: string[];
  report: ClusterReport;
  persistedEvents: number;
  persistedEventSources: number;
  persistSkipped: number;
  persistErrors: number;
};

export type ClusterRunOptions = {
  hours: number;
  limit: number;
  persist: boolean;
  now?: Date;
  timeoutMs?: number;
  concurrency?: number;
  config?: ClusteringConfig;
  supabase?: SupabaseClient<Database>;
};
