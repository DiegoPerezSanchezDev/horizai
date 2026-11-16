import { calculateImportanceScore, rankingResultSchema, type RankingDimensions, type RankingResult } from "../contracts/index.ts";
import type { RankerGeneration, RankerInput } from "./ranker-types.ts";
import { calculateRankSignals, type RankSignalOptions, type RankSignals } from "./rank-signals.ts";
import { rankerFormulaVersion } from "./ranker-prompt.ts";

export type AssembledRanking = { output: RankingResult; signals: RankSignals };

function deterministicReason(input: RankerInput, generation: RankerGeneration, signals: RankSignals): string {
  const momentumText = signals.momentumAvailable ? `${signals.momentum}/100 con histórico disponible` : "50/100 neutral por falta de histórico productivo";
  return `Impacto semántico ${generation.impact}/100; novedad ${generation.novelty}/100; alcance determinista ${signals.reach}/100; credibilidad ${signals.credibility}/100 a partir de ${signals.sourceCount} fuente(s) y estado ${input.verification.status}; impacto económico ${generation.economicImpact}/100; momentum ${momentumText}. Fórmula ${rankerFormulaVersion}.`;
}

function guardImportanceScoreForStatus(status: RankerInput["verification"]["status"], score: number): number {
  if (status === "rejected") return Math.min(score, 15);
  if (status === "rumor") return Math.min(score, 45);
  return score;
}

export function guardImportanceScore(input: RankerInput, score: number): number {
  return guardImportanceScoreForStatus(input.verification.status, score);
}

export function calculateGuardedImportanceScore(status: RankerInput["verification"]["status"], dimensions: RankingDimensions): number {
  return guardImportanceScoreForStatus(status, calculateImportanceScore(dimensions));
}

export function assembleRankingResult(input: RankerInput, generation: RankerGeneration, options: RankSignalOptions = {}): AssembledRanking {
  const signals = calculateRankSignals(input, options);
  const dimensions: RankingDimensions = {
    impact: generation.impact,
    novelty: generation.novelty,
    reach: signals.reach,
    credibility: signals.credibility,
    economicImpact: generation.economicImpact,
    momentum: signals.momentum,
  };
  const importanceScore = guardImportanceScore(input, calculateImportanceScore(dimensions));
  const output = rankingResultSchema.parse({
    schemaVersion: 1,
    eventKey: input.event.eventKey,
    ...dimensions,
    importanceScore,
    rankReason: deterministicReason(input, generation, signals),
  });
  return { output, signals };
}
