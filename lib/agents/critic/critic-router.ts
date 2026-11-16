import type { CriticResult } from "../contracts/index.ts";
import { criticRoutingVersion } from "./critic-prompt.ts";
import { criticGenerationV3Schema, criticStageSchema, type CriticGeneration, type CriticInput, type CriticPrecheckIssue, type CriticResolvedGeneration } from "./critic-types.ts";

const stageOrder = ["verification", "translation", "editorial", "classification", "ranking"] as const;
const stageDecision: Record<(typeof stageOrder)[number], CriticResult["decision"]> = {
  verification: "revise_verification",
  translation: "revise_translation",
  editorial: "revise_editorial",
  classification: "revise_classification",
  ranking: "revise_ranking",
};

const severityWeight: Record<CriticPrecheckIssue["severity"], number> = { low: 0, medium: 0, high: 2, critical: 3 };

function highestSeverity(issues: Array<{ severity: CriticPrecheckIssue["severity"] }>): CriticPrecheckIssue["severity"] {
  return issues.reduce<CriticPrecheckIssue["severity"]>((highest, current) => severityWeight[current.severity] > severityWeight[highest] ? current.severity : highest, "low");
}

function earliestBlockingStage(issues: Array<{ stage: CriticPrecheckIssue["stage"]; severity: CriticPrecheckIssue["severity"] }>): CriticPrecheckIssue["stage"] | null {
  const blocking = issues.filter((item) => severityWeight[item.severity] > 0);
  return stageOrder.find((stage) => blocking.some((item) => item.stage === stage)) ?? null;
}

export type CriticRouting = {
  decision: CriticResult["decision"];
  routedStage: CriticPrecheckIssue["stage"] | null;
  severity: CriticResult["severity"];
  reason: string;
};

export function validateCriticEvidenceRefs(input: CriticInput, generation: CriticResolvedGeneration): void {
  const valid = new Set<string>();
  input.sources.forEach((_, index) => valid.add(`source:${index}`));
  input.verification.verifiedFacts.forEach((_, index) => valid.add(`verifiedFact:${index}`));
  input.verification.uncertainClaims.forEach((_, index) => valid.add(`uncertainClaim:${index}`));
  input.verification.contradictions.forEach((_, index) => valid.add(`contradiction:${index}`));
  input.translation.translatedFacts.forEach((_, index) => valid.add(`translatedFact:${index}`));
  ["headline", "dek", "summary", "whyItMatters", "body", "keyPoints"].forEach((field) => valid.add(`editor:${field}`));
  ["region", "countries", "categories", "companies", "models", "people", "technologies"].forEach((field) => valid.add(`classification:${field}`));
  ["impact", "novelty", "reach", "credibility", "economicImpact", "momentum", "importanceScore", "rankReason"].forEach((field) => valid.add(`ranking:${field}`));
  const refs = generation.findings.flatMap((finding) => finding.evidenceRefs);
  const unknown = refs.filter((ref) => !valid.has(ref));
  if (unknown.length > 0) throw new Error(`Critic evidence references are not present in the input: ${[...new Set(unknown)].join(", ")}`);
}

export function routeCritic(input: CriticInput, precheckIssues: CriticPrecheckIssue[], generation: CriticResolvedGeneration | CriticGeneration): CriticRouting {
  const allIssues = [...precheckIssues, ...generation.findings];
  const hardReject = input.verification.status === "rejected" || precheckIssues.some((item) => item.code === "UPSTREAM_REJECTED");
  if (hardReject) return { decision: "reject", routedStage: "verification", severity: highestSeverity(allIssues), reason: "Deterministic routing rejected the event because VerificationResult is explicitly rejected." };
  const routedStage = earliestBlockingStage(allIssues);
  if (routedStage) return { decision: stageDecision[routedStage], routedStage, severity: highestSeverity(allIssues), reason: `Deterministic routing selected the earliest blocking stage: ${routedStage}.` };
  return { decision: "pass", routedStage: null, severity: highestSeverity(allIssues), reason: "No blocking deterministic or semantic finding was reported." };
}

export function assertValidCriticGeneration(value: unknown): CriticGeneration {
  return criticGenerationV3Schema.parse(value);
}

export { criticStageSchema, criticRoutingVersion };
