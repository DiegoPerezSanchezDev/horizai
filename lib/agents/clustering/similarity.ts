import { clusteringConfig, type ClusteringConfig } from "./clustering-config.ts";
import type { ComparableItem, PairScore } from "./cluster-types.ts";

const launchTerms = new Set(["launch", "launches", "launched", "release", "releases", "released", "unveil", "unveils", "unveiled", "lanza", "lanzan", "presenta", "presentan"]);
const fundingTerms = new Set(["funding", "funded", "financing", "finance", "investment", "investor", "valuation", "funding", "financiacion", "financiacion", "financiación", "inversion", "inversión", "valoracion", "valoración"]);

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function hasTopic(item: ComparableItem, terms: Set<string>): boolean {
  return [...item.titleTokens, ...item.descriptionTokens].some((token) => terms.has(token));
}

function temporalSimilarity(left: ComparableItem, right: ComparableItem, config: ClusteringConfig): { score: number; gapHours: number | null } {
  if (left.publishedAtMs === null || right.publishedAtMs === null) return { score: 0.5, gapHours: null };
  const gapHours = Math.abs(left.publishedAtMs - right.publishedAtMs) / 3_600_000;
  if (gapHours > config.maxTimeGapHours) return { score: 0, gapHours };
  return { score: 1 - gapHours / config.maxTimeGapHours, gapHours };
}

function modelConflict(left: ComparableItem, right: ComparableItem): boolean {
  const leftFamilies = new Set([...left.modelSignatures].map((value) => value.split("-")[0]));
  const rightFamilies = new Set([...right.modelSignatures].map((value) => value.split("-")[0]));
  for (const family of leftFamilies) {
    if (!rightFamilies.has(family)) continue;
    const leftVersions = [...left.modelSignatures].filter((value) => value.startsWith(`${family}-`));
    const rightVersions = [...right.modelSignatures].filter((value) => value.startsWith(`${family}-`));
    if (leftVersions.length > 0 && rightVersions.length > 0 && !leftVersions.some((value) => rightVersions.includes(value))) return true;
  }
  return false;
}

export function scoreCandidatePair(left: ComparableItem, right: ComparableItem, config: ClusteringConfig = clusteringConfig): PairScore {
  const titleSimilarity = jaccard(left.titleTokens, right.titleTokens);
  const descriptionSimilarity = jaccard(left.descriptionTokens, right.descriptionTokens);
  const relevantTokenSimilarity = jaccard(left.relevantTokens, right.relevantTokens);
  const entityEvidence = jaccard(left.entityTokens, right.entityTokens);
  const temporal = temporalSimilarity(left, right, config);
  const reasons: string[] = [];
  let score =
    titleSimilarity * config.weights.title +
    descriptionSimilarity * config.weights.description +
    relevantTokenSimilarity * config.weights.relevantTokens +
    temporal.score * config.weights.temporal +
    entityEvidence * config.weights.entityEvidence;

  if (titleSimilarity >= 0.5) reasons.push("títulos comparten tokens relevantes");
  if (descriptionSimilarity >= 0.25) reasons.push("descripciones comparten contexto");
  if (entityEvidence > 0) reasons.push("coinciden entidades evidentes");
  if (temporal.gapHours !== null && temporal.gapHours <= 24) reasons.push("publicación temporalmente cercana");
  if (temporal.gapHours !== null && temporal.gapHours > config.maxTimeGapHours) reasons.push("fechas demasiado separadas");

  const conflictingTopics = (hasTopic(left, launchTerms) && hasTopic(right, fundingTerms)) || (hasTopic(left, fundingTerms) && hasTopic(right, launchTerms));
  if (conflictingTopics) {
    score -= 0.35;
    reasons.push("conflicto lanzamiento frente a financiación");
  }
  if (modelConflict(left, right)) {
    score -= 0.35;
    reasons.push("versiones de modelo incompatibles");
  }
  if (left.numberTokens.size > 0 && right.numberTokens.size > 0 && jaccard(left.numberTokens, right.numberTokens) === 0) {
    score -= 0.15;
    reasons.push("cifras principales no coinciden");
  }
  if (entityEvidence > 0 && titleSimilarity < 0.25 && relevantTokenSimilarity < 0.2) {
    score -= 0.2;
    reasons.push("solo coincide una entidad conocida");
  }

  score = Math.max(0, Math.min(1, score));
  const decision = score >= config.mergeThreshold && !conflictingTopics && !modelConflict(left, right) && temporal.score > 0
    ? "merge"
    : score >= config.needsReviewThreshold ? "needs_review" : "separate";
  if (decision === "needs_review") reasons.push("puntuación cercana al umbral; requiere revisión");
  if (reasons.length === 0) reasons.push("evidencia insuficiente para fusionar");
  return {
    leftCandidateId: left.item.candidateId,
    rightCandidateId: right.item.candidateId,
    score: Math.round(score * 1000) / 1000,
    decision,
    reasons,
    metrics: {
      titleSimilarity: Math.round(titleSimilarity * 1000) / 1000,
      descriptionSimilarity: Math.round(descriptionSimilarity * 1000) / 1000,
      relevantTokenSimilarity: Math.round(relevantTokenSimilarity * 1000) / 1000,
      temporalSimilarity: Math.round(temporal.score * 1000) / 1000,
      entityEvidence: Math.round(entityEvidence * 1000) / 1000,
      timeGapHours: temporal.gapHours === null ? null : Math.round(temporal.gapHours * 10) / 10,
    },
  };
}
