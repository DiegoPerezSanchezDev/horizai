import type { RankerInput } from "./ranker-types.ts";
import type { ActivityHistorySignal } from "./ranker-types.ts";

export type RankSignals = {
  credibility: number;
  reach: number;
  momentum: number;
  sourceCount: number;
  contradictionPenalty: number;
  uncertaintyPenalty: number;
  geographicReachSignal: number;
  momentumAvailable: boolean;
};

export type RankSignalOptions = {
  now?: Date;
  activityHistory?: ActivityHistorySignal[];
};

const verificationBase: Record<RankerInput["verification"]["status"], number> = {
  confirmed: 88,
  developing: 68,
  single_source: 48,
  rumor: 22,
  rejected: 0,
};

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sourceCorroboration(sourceCount: number): number {
  return Math.min(100, sourceCount * 35);
}

function calculateCredibility(input: RankerInput): { score: number; contradictionPenalty: number; uncertaintyPenalty: number } {
  if (input.verification.status === "rejected") return { score: 0, contradictionPenalty: 0, uncertaintyPenalty: 0 };
  const contradictionPenalty = Math.min(30, input.verification.contradictions.length * 10);
  const uncertaintyPenalty = Math.min(15, input.verification.uncertainClaims.length * 3);
  const score = verificationBase[input.verification.status] * 0.45
    + input.verification.confidenceScore * 0.35
    + sourceCorroboration(input.event.sourceCount) * 0.20
    - contradictionPenalty
    - uncertaintyPenalty;
  return { score: clampScore(score), contradictionPenalty, uncertaintyPenalty };
}

function calculateReach(input: RankerInput): { score: number; geographicReachSignal: number } {
  const countrySignal = Math.min(70, input.classification.countryCodes.length * 20);
  const regionSignal = input.classification.primaryRegionCode && input.classification.primaryRegionCode !== "GLOBAL" ? 10 : 0;
  const entityCount = input.classification.companies.length + input.classification.models.length + input.classification.people.length + input.classification.technologies.length;
  const entitySignal = Math.min(15, entityCount * 2);
  return { score: clampScore(countrySignal + regionSignal + entitySignal), geographicReachSignal: countrySignal + regionSignal };
}

function recencyScore(periodEnd: string, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - Date.parse(periodEnd)) / 3_600_000);
  if (ageHours <= 24) return 100;
  if (ageHours >= 24 * 30) return 0;
  return clampScore(100 - ((ageHours - 24) / (24 * 29)) * 100);
}

function calculateMomentum(options: RankSignalOptions): { score: number; available: boolean } {
  const history = options.activityHistory ?? [];
  if (history.length === 0) return { score: 50, available: false };
  const now = options.now ?? new Date();
  const latest = history[history.length - 1];
  const frequency = Math.min(100, latest.eventCount * 10 + latest.articleCount * 5);
  const score = latest.activityScore * 0.5 + frequency * 0.25 + recencyScore(latest.periodEnd, now) * 0.25;
  return { score: clampScore(score), available: true };
}

export function calculateRankSignals(input: RankerInput, options: RankSignalOptions = {}): RankSignals {
  const credibility = calculateCredibility(input);
  const reach = calculateReach(input);
  const momentum = calculateMomentum(options);
  return {
    credibility: credibility.score,
    reach: reach.score,
    momentum: momentum.score,
    sourceCount: input.event.sourceCount,
    contradictionPenalty: credibility.contradictionPenalty,
    uncertaintyPenalty: credibility.uncertaintyPenalty,
    geographicReachSignal: reach.geographicReachSignal,
    momentumAvailable: momentum.available,
  };
}
