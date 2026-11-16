import { z } from "zod";
import type { CriticGeneration, CriticInput, CriticResolvedGeneration } from "./critic-types.ts";

export const criticEvidenceTypeSchema = z.enum([
  "source",
  "verified_fact",
  "uncertain_claim",
  "contradiction",
  "translated_fact",
  "editorial",
  "classification",
  "ranking",
]);
export type CriticEvidenceType = z.infer<typeof criticEvidenceTypeSchema>;

export const criticEvidenceCatalogItemSchema = z.object({
  evidenceIndex: z.number().int().nonnegative(),
  evidenceType: criticEvidenceTypeSchema,
  stage: z.enum(["verification", "translation", "editorial", "classification", "ranking"]),
  preview: z.string().trim().min(1).max(300),
}).strict();
export type CriticEvidenceCatalogItem = z.infer<typeof criticEvidenceCatalogItemSchema>;

export type CriticEvidenceCatalogEntry = CriticEvidenceCatalogItem & { canonicalRef: string };

function preview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function append(entries: CriticEvidenceCatalogEntry[], canonicalRef: string, evidenceType: CriticEvidenceType, stage: CriticEvidenceCatalogItem["stage"], value: string): void {
  const item = { evidenceIndex: entries.length, canonicalRef, evidenceType, stage, preview: preview(value) };
  if (item.preview) entries.push(item);
}

export function buildCriticEvidenceCatalog(input: CriticInput): CriticEvidenceCatalogEntry[] {
  const entries: CriticEvidenceCatalogEntry[] = [];
  input.sources.forEach((source, index) => {
    const evidence = input.sourceEvidence.find((item) => item.sourceItemId === source.sourceItemId);
    append(entries, `source:${index}`, "source", "verification", `${source.sourceName} · ${evidence?.title ?? "title unavailable"} · ${evidence?.contentExcerpt ?? "source excerpt unavailable"}`);
  });
  input.verification.verifiedFacts.forEach((fact, index) => append(entries, `verifiedFact:${index}`, "verified_fact", "verification", fact.claim));
  input.verification.uncertainClaims.forEach((claim, index) => append(entries, `uncertainClaim:${index}`, "uncertain_claim", "verification", claim.claim));
  input.verification.contradictions.forEach((contradiction, index) => append(entries, `contradiction:${index}`, "contradiction", "verification", contradiction.claim));
  input.translation.translatedFacts.forEach((fact, index) => append(entries, `translatedFact:${index}`, "translated_fact", "translation", `${fact.sourceText} → ${fact.translatedText}`));
  append(entries, "editor:headline", "editorial", "editorial", input.editorial.headlineEs);
  append(entries, "editor:dek", "editorial", "editorial", input.editorial.dekEs);
  append(entries, "editor:summary", "editorial", "editorial", input.editorial.summaryEs);
  append(entries, "editor:whyItMatters", "editorial", "editorial", input.editorial.whyItMattersEs);
  append(entries, "editor:body", "editorial", "editorial", input.editorial.bodyEs);
  append(entries, "editor:keyPoints", "editorial", "editorial", input.editorial.keyPoints.join(" | "));
  for (const [field, value] of [
    ["region", input.classification.primaryRegionCode],
    ["countries", input.classification.countryCodes.join(", ")],
    ["categories", input.classification.categorySlugs.join(", ")],
    ["companies", input.classification.companies.join(", ")],
    ["models", input.classification.models.join(", ")],
    ["people", input.classification.people.join(", ")],
    ["technologies", input.classification.technologies.join(", ")],
  ] as const) {
    if (value) append(entries, `classification:${field}`, "classification", "classification", value);
  }
  for (const field of ["impact", "novelty", "reach", "credibility", "economicImpact", "momentum", "importanceScore", "rankReason"] as const) {
    const value = input.ranking.result[field];
    append(entries, `ranking:${field}`, "ranking", "ranking", String(value));
  }
  return entries;
}

export function modelEvidenceCatalog(catalog: CriticEvidenceCatalogEntry[]): CriticEvidenceCatalogItem[] {
  return catalog.map((entry) => {
    const item = { ...entry };
    delete (item as Partial<CriticEvidenceCatalogEntry>).canonicalRef;
    return item as CriticEvidenceCatalogItem;
  });
}

export function resolveCriticEvidenceRefs(catalog: CriticEvidenceCatalogEntry[], evidenceIndices: number[]): string[] {
  const refs: string[] = [];
  for (const index of evidenceIndices) {
    const entry = catalog[index];
    if (!entry) throw new Error(`Critic evidence index is outside the catalog: ${index}`);
    refs.push(entry.canonicalRef);
  }
  return refs;
}

export function resolveCriticGeneration(catalog: CriticEvidenceCatalogEntry[], generation: CriticGeneration): { generation: CriticResolvedGeneration; evidenceIndicesReceived: number[]; resolvedEvidenceRefsCount: number } {
  const evidenceIndicesReceived = generation.findings.flatMap((finding) => finding.evidenceIndices);
  const resolvedFindings = generation.findings.map((finding) => ({ ...finding, evidenceRefs: resolveCriticEvidenceRefs(catalog, finding.evidenceIndices) }));
  return { generation: { findings: resolvedFindings }, evidenceIndicesReceived, resolvedEvidenceRefsCount: resolvedFindings.reduce((total, finding) => total + finding.evidenceRefs.length, 0) };
}
