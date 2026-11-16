import { validateEditorialDraftOutput } from "../editor/editor-output-guard.ts";
import { calculateGuardedImportanceScore } from "../ranker/rank-score.ts";
import { type ReferenceRegistry } from "../classifier/geo-registry.ts";
import { resolveGeo } from "../classifier/geo-resolver.ts";
import { criticInputSchema, type CriticInput, type CriticPrecheckIssue, type CriticPrecheckResult } from "./critic-types.ts";

export type CriticPrecheckOptions = {
  registry?: ReferenceRegistry;
  expectedFormulaVersion?: string;
};

function issue(code: string, stage: CriticPrecheckIssue["stage"], severity: CriticPrecheckIssue["severity"], message: string, evidenceRefs: string[] = []): CriticPrecheckIssue {
  return { code, stage, severity, message, evidenceRefs };
}

function sourceIds(input: CriticInput): Set<string> {
  return new Set(input.sources.map((source) => source.sourceId));
}

function referencesExist(input: CriticInput): CriticPrecheckIssue[] {
  const ids = sourceIds(input);
  const problems: CriticPrecheckIssue[] = [];
  const checkClaims = (claims: Array<{ sourceIds: string[] }>, stage: CriticPrecheckIssue["stage"], label: string) => {
    claims.forEach((claim, index) => {
      if (claim.sourceIds.some((id) => !ids.has(id))) problems.push(issue("BROKEN_SOURCE_REFERENCE", stage, "critical", `${label}[${index}] references a source outside the checkpoint`, [`${label}:${index}`]));
    });
  };
  checkClaims(input.verification.verifiedFacts, "verification", "verifiedFact");
  checkClaims(input.verification.uncertainClaims, "verification", "uncertainClaim");
  checkClaims(input.verification.contradictions, "verification", "contradiction");
  return problems;
}

function checkSourceEvidence(input: CriticInput): CriticPrecheckIssue[] {
  const problems: CriticPrecheckIssue[] = [];
  if (input.sourceEvidence.length !== input.sources.length) {
    problems.push(issue("SOURCE_EVIDENCE_MISSING", "verification", "critical", "Critic requires one bounded source excerpt for every source item", ["source:0"]));
    return problems;
  }
  const seen = new Set<string>();
  input.sources.forEach((source) => {
    const matches = input.sourceEvidence.filter((item) => item.sourceItemId === source.sourceItemId);
    if (matches.length !== 1 || matches[0]?.sourceId !== source.sourceId || seen.has(source.sourceItemId)) {
      problems.push(issue("SOURCE_EVIDENCE_LINEAGE", "verification", "critical", "Source excerpt identity does not match the source item in the pipeline checkpoint", ["source:0"]));
    }
    seen.add(source.sourceItemId);
  });
  return problems;
}

function checkTranslationCoverage(input: CriticInput): CriticPrecheckIssue[] {
  const problems: CriticPrecheckIssue[] = [];
  if (input.translation.translatedFacts.length !== input.verification.verifiedFacts.length) {
    problems.push(issue("TRANSLATION_FACT_COVERAGE", "translation", "high", "Translation does not contain exactly one translated fact for every verified fact", ["verifiedFact:0"]));
  }
  input.verification.verifiedFacts.forEach((fact, index) => {
    const matches = input.translation.translatedFacts.filter((translated) => translated.sourceText === fact.claim);
    if (matches.length !== 1) problems.push(issue("TRANSLATION_FACT_MISMATCH", "translation", "high", `Verified fact ${index} is not covered exactly once by translated sourceText`, [`verifiedFact:${index}`]));
  });
  return problems;
}

function checkRegistry(input: CriticInput, registry?: ReferenceRegistry): CriticPrecheckIssue[] {
  if (!registry) return [];
  const problems: CriticPrecheckIssue[] = [];
  if (input.classification.primaryRegionCode !== null && !registry.regions.has(input.classification.primaryRegionCode)) problems.push(issue("UNKNOWN_REGION", "classification", "critical", "Classification region is outside the active registry", ["classification:region"]));
  for (const slug of input.classification.categorySlugs) if (!registry.categories.has(slug)) problems.push(issue("UNKNOWN_CATEGORY", "classification", "critical", `Classification category ${slug} is outside the active registry`, ["classification:categories"]));
  return problems;
}

function checkGeo(input: CriticInput, registry?: ReferenceRegistry): CriticPrecheckIssue[] {
  const problems: CriticPrecheckIssue[] = [];
  const expected = registry ? resolveGeo({ regionCode: input.classification.primaryRegionCode }, registry) : null;
  const coordinateMismatch = input.classification.latitude !== input.geo.latitude
    || input.classification.longitude !== input.geo.longitude
    || (expected !== null && (input.classification.latitude !== expected.latitude || input.classification.longitude !== expected.longitude));
  if (coordinateMismatch) problems.push(issue("GEO_PROVENANCE_MISMATCH", "classification", "critical", "Classification coordinates do not match the selected region registry entry", ["classification:region"]));
  if (input.classification.latitude !== null && input.geo.resolvedFrom === null) problems.push(issue("GEO_PROVENANCE_MISSING", "classification", "critical", "Coordinates exist without registry provenance", ["classification:region"]));
  if (input.classification.latitude === null && input.geo.resolutionLevel !== "unresolved") problems.push(issue("GEO_RESOLUTION_MISMATCH", "classification", "high", "Unresolved classification coordinates disagree with Geo Resolver metadata", ["classification:region"]));
  if (expected && (input.geo.resolutionLevel !== expected.resolutionLevel || input.geo.resolvedFrom !== expected.resolvedFrom)) problems.push(issue("GEO_RESOLUTION_MISMATCH", "classification", "high", "Geo Resolver metadata does not match the selected region registry entry", ["classification:region"]));
  return problems;
}

function checkRanking(input: CriticInput, expectedFormulaVersion: string): CriticPrecheckIssue[] {
  const problems: CriticPrecheckIssue[] = [];
  if (input.ranking.formulaVersion !== expectedFormulaVersion) problems.push(issue("RANKING_FORMULA_VERSION", "ranking", "critical", `Ranking formula must be ${expectedFormulaVersion}`, ["ranking:importanceScore"]));
  const recomputed = calculateGuardedImportanceScore(input.verification.status, {
    impact: input.ranking.result.impact,
    novelty: input.ranking.result.novelty,
    reach: input.ranking.result.reach,
    credibility: input.ranking.result.credibility,
    economicImpact: input.ranking.result.economicImpact,
    momentum: input.ranking.result.momentum,
  });
  if (input.ranking.result.importanceScore !== recomputed) problems.push(issue("RANKING_SCORE_MISMATCH", "ranking", "critical", "Importance score differs from deterministic ranking-v1 recomputation", ["ranking:importanceScore"]));
  if (input.ranking.deterministicSignals.reach !== input.ranking.result.reach || input.ranking.deterministicSignals.credibility !== input.ranking.result.credibility || input.ranking.deterministicSignals.momentum !== input.ranking.result.momentum) problems.push(issue("RANKING_SIGNAL_MISMATCH", "ranking", "high", "Ranking deterministic signals do not match the published RankingResult", ["ranking:reach"]));
  return problems;
}

function checkLineage(input: CriticInput): CriticPrecheckIssue[] {
  const problems: CriticPrecheckIssue[] = [];
  const keys = [input.event.eventKey, input.verification.eventKey, input.translation.eventKey, input.editorial.eventKey, input.classification.eventKey, input.ranking.result.eventKey];
  if (keys.some((key) => key !== input.event.eventKey)) problems.push(issue("EVENT_KEY_MISMATCH", "verification", "critical", "Pipeline stages do not share the checkpoint eventKey", []));
  if (input.event.sourceCount !== input.sources.length || input.ranking.deterministicSignals.sourceCount !== input.sources.length) problems.push(issue("SOURCE_COUNT_MISMATCH", "ranking", "high", "Checkpoint source count is inconsistent across stages", ["ranking:reach"]));
  return problems;
}

export function runCriticPrechecks(input: CriticInput, options: CriticPrecheckOptions = {}): CriticPrecheckResult {
  const parsed = criticInputSchema.safeParse(input);
  if (!parsed.success) {
    return { passed: false, issues: [issue("INVALID_PIPELINE_SCHEMA", "verification", "critical", "One or more upstream pipeline outputs do not satisfy their schemas")] };
  }
  const validated = parsed.data;
  const issues: CriticPrecheckIssue[] = [];
  if (validated.verification.status === "rejected") issues.push(issue("UPSTREAM_REJECTED", "verification", "critical", "The upstream Verifier explicitly rejected this event", ["verifiedFact:0"]));
  if (validated.verification.verifiedFacts.length === 0 && validated.verification.status !== "rejected") issues.push(issue("NO_VERIFIED_FACTS", "verification", "high", "A piece reached Critic without any verified facts", []));
  issues.push(...checkLineage(validated));
  issues.push(...checkSourceEvidence(validated));
  issues.push(...referencesExist(validated));
  issues.push(...checkTranslationCoverage(validated));
  try {
    validateEditorialDraftOutput({
      schemaVersion: 1,
      event: { eventKey: validated.event.eventKey, canonicalTitle: validated.event.canonicalTitle },
      verification: { status: validated.verification.status, confidenceScore: validated.verification.confidenceScore, verifiedFacts: validated.verification.verifiedFacts, uncertainClaims: validated.verification.uncertainClaims, contradictions: validated.verification.contradictions },
      translation: validated.translation,
      sources: validated.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: "https://example.invalid/source", sourceType: source.sourceType })),
    }, validated.editorial);
  } catch {
    issues.push(issue("EDITORIAL_GUARD_FAILURE", "editorial", "critical", "EditorialDraft fails its deterministic editorial guard", ["editor:body"]));
  }
  issues.push(...checkRegistry(validated, options.registry));
  issues.push(...checkGeo(validated, options.registry));
  issues.push(...checkRanking(validated, options.expectedFormulaVersion ?? "ranking-v1"));
  return { passed: issues.length === 0, issues };
}
