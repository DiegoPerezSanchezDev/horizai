import type { ClassificationResult, EditorialDraft, ExtractedItem, TranslationResult, VerificationResult } from "../contracts/index.ts";
import type { CriticInput, CriticModelInput, CriticModelInputV3, CriticRankingCheckpoint } from "./critic-types.ts";
import { criticInputSchema, criticModelInputSchema, criticModelInputV3Schema } from "./critic-types.ts";
import { buildCriticEvidenceCatalog, modelEvidenceCatalog, type CriticEvidenceCatalogEntry } from "./critic-evidence-catalog.ts";

export function buildCriticInput(input: {
  event: CriticInput["event"];
  verification: VerificationResult;
  translation: TranslationResult;
  editorial: EditorialDraft;
  classification: ClassificationResult;
  ranking: CriticRankingCheckpoint;
  sources: CriticInput["sources"];
  sourceEvidence?: CriticInput["sourceEvidence"];
  geo: CriticInput["geo"];
}): CriticInput {
  return criticInputSchema.parse({
    schemaVersion: 1,
    event: input.event,
    verification: {
      schemaVersion: input.verification.schemaVersion,
      eventKey: input.verification.eventKey,
      status: input.verification.status,
      confidenceScore: input.verification.confidenceScore,
      primarySourceId: input.verification.primarySourceId,
      supportingSourceIds: input.verification.supportingSourceIds,
      contradictions: input.verification.contradictions,
      uncertainClaims: input.verification.uncertainClaims,
      reason: input.verification.reason,
      verifiedFacts: input.verification.verifiedFacts,
    },
    translation: {
      schemaVersion: input.translation.schemaVersion,
      eventKey: input.translation.eventKey,
      sourceLanguage: input.translation.sourceLanguage,
      targetLanguage: input.translation.targetLanguage,
      translatedTitle: input.translation.translatedTitle,
      translatedFacts: input.translation.translatedFacts,
      translatedSourceMaterial: input.translation.translatedSourceMaterial,
      preservedNames: input.translation.preservedNames,
      translationNotes: input.translation.translationNotes,
    },
    editorial: {
      schemaVersion: input.editorial.schemaVersion,
      eventKey: input.editorial.eventKey,
      headlineEs: input.editorial.headlineEs,
      dekEs: input.editorial.dekEs,
      summaryEs: input.editorial.summaryEs,
      whyItMattersEs: input.editorial.whyItMattersEs,
      bodyEs: input.editorial.bodyEs,
      keyPoints: input.editorial.keyPoints,
      suggestedSlug: input.editorial.suggestedSlug,
    },
    classification: {
      schemaVersion: input.classification.schemaVersion,
      eventKey: input.classification.eventKey,
      primaryRegionCode: input.classification.primaryRegionCode,
      countryCodes: input.classification.countryCodes,
      categorySlugs: input.classification.categorySlugs,
      companies: input.classification.companies,
      models: input.classification.models,
      people: input.classification.people,
      technologies: input.classification.technologies,
      latitude: input.classification.latitude,
      longitude: input.classification.longitude,
    },
    ranking: {
      result: input.ranking.result,
      formulaVersion: input.ranking.formulaVersion,
      momentumAvailable: input.ranking.momentumAvailable,
      deterministicSignals: {
        credibility: input.ranking.deterministicSignals.credibility,
        reach: input.ranking.deterministicSignals.reach,
        momentum: input.ranking.deterministicSignals.momentum,
        sourceCount: input.ranking.deterministicSignals.sourceCount,
        contradictionPenalty: input.ranking.deterministicSignals.contradictionPenalty,
        uncertaintyPenalty: input.ranking.deterministicSignals.uncertaintyPenalty,
        geographicReachSignal: input.ranking.deterministicSignals.geographicReachSignal,
      },
    },
    sources: input.sources,
    sourceEvidence: input.sourceEvidence ?? [],
    geo: input.geo,
  });
}

/** Build a bounded lead excerpt for every clustered source item. */
export function buildCriticSourceEvidence(
  sources: ReadonlyArray<{ sourceId: string; sourceUrl: string; sourceItemId?: string }>,
  items: ReadonlyArray<ExtractedItem>,
): CriticInput["sourceEvidence"] {
  const perSourceLimit = Math.max(1, Math.min(1_000, Math.floor(4_000 / Math.max(1, sources.length))));
  return sources.map((source) => {
    const matches = items.filter((candidate) => candidate.canonicalUrl === source.sourceUrl && (!source.sourceItemId || candidate.candidateId === source.sourceItemId));
    if (matches.length !== 1) throw new Error("CRITIC_SOURCE_EVIDENCE_LINEAGE_MISMATCH");
    const item = matches[0];
    const metadataSourceId = item.metadata.sourceId;
    if (typeof metadataSourceId === "string" && metadataSourceId !== source.sourceId) throw new Error("CRITIC_SOURCE_EVIDENCE_SOURCE_ID_MISMATCH");
    return {
      sourceId: source.sourceId,
      sourceItemId: source.sourceItemId ?? item.candidateId,
      canonicalUrl: item.canonicalUrl,
      title: item.title,
      contentExcerpt: item.content.slice(0, perSourceLimit),
      contentHash: item.contentHash,
      excerptTruncated: item.content.length > perSourceLimit,
    };
  });
}

const MAX_BODY_CHARS = 20_000;

/** Exact v3 serializer kept for historical estimate reproduction and replay. */
export function buildCriticModelInputV3(input: CriticInput): { input: CriticModelInputV3; bodyTruncated: boolean; evidenceCatalog: CriticEvidenceCatalogEntry[] } {
  const bodyTruncated = input.editorial.bodyEs.length > MAX_BODY_CHARS;
  const evidenceCatalog = buildCriticEvidenceCatalog(input);
  const modelInput = criticModelInputV3Schema.parse({
    schemaVersion: 1,
    event: { eventKey: input.event.eventKey, canonicalTitle: input.event.canonicalTitle },
    verification: {
      status: input.verification.status,
      confidenceScore: input.verification.confidenceScore,
      verifiedFacts: input.verification.verifiedFacts,
      uncertainClaims: input.verification.uncertainClaims,
      contradictions: input.verification.contradictions,
    },
    translation: {
      translatedTitle: input.translation.translatedTitle,
      translatedFacts: input.translation.translatedFacts,
      preservedNames: input.translation.preservedNames,
      translationNotes: input.translation.translationNotes,
    },
    editorial: {
      headlineEs: input.editorial.headlineEs,
      dekEs: input.editorial.dekEs,
      summaryEs: input.editorial.summaryEs,
      whyItMattersEs: input.editorial.whyItMattersEs,
      bodyEs: input.editorial.bodyEs.slice(0, MAX_BODY_CHARS),
      keyPoints: input.editorial.keyPoints,
    },
    classification: input.classification,
    ranking: input.ranking,
    sources: input.sources,
    sourceEvidence: input.sourceEvidence.map(({ sourceId, sourceItemId, canonicalUrl, title, contentExcerpt, excerptTruncated }) => ({ sourceId, sourceItemId, canonicalUrl, title, contentExcerpt, excerptTruncated })),
    evidenceCatalog: modelEvidenceCatalog(evidenceCatalog),
  });
  return { input: modelInput, bodyTruncated, evidenceCatalog };
}

function evidenceIndex(catalog: CriticEvidenceCatalogEntry[], canonicalRef: string): number {
  const entry = catalog.find((item) => item.canonicalRef === canonicalRef);
  if (!entry) throw new Error(`Critic evidence projection is missing ${canonicalRef}`);
  return entry.evidenceIndex;
}

function optionalEvidenceIndices(catalog: CriticEvidenceCatalogEntry[], refs: Record<string, string>): Record<string, number> {
  return Object.fromEntries(Object.entries(refs).flatMap(([field, ref]) => {
    const entry = catalog.find((item) => item.canonicalRef === ref);
    return entry ? [[field, entry.evidenceIndex]] : [];
  }));
}

/** Critic v4 carries each proposition once; the catalog is a compact index map. */
export function buildCriticModelInput(input: CriticInput): { input: CriticModelInput; bodyTruncated: boolean; evidenceCatalog: CriticEvidenceCatalogEntry[] } {
  const bodyTruncated = input.editorial.bodyEs.length > MAX_BODY_CHARS;
  const evidenceCatalog = buildCriticEvidenceCatalog(input);
  const sourceEvidence = input.sourceEvidence.map((evidence) => ({
    evidenceIndex: evidenceIndex(evidenceCatalog, `source:${input.sources.findIndex((source) => source.sourceItemId === evidence.sourceItemId)}`),
    contentExcerpt: evidence.contentExcerpt,
    contentHash: evidence.contentHash,
    excerptTruncated: evidence.excerptTruncated,
  }));
  const modelInput = criticModelInputSchema.parse({
    schemaVersion: 2,
    event: { eventKey: input.event.eventKey, canonicalTitle: input.event.canonicalTitle },
    verification: {
      status: input.verification.status,
      confidenceScore: input.verification.confidenceScore,
      verifiedFacts: input.verification.verifiedFacts.map((fact, index) => ({ ...fact, evidenceIndex: evidenceIndex(evidenceCatalog, `verifiedFact:${index}`) })),
      uncertainClaims: input.verification.uncertainClaims.map((claim, index) => ({ ...claim, evidenceIndex: evidenceIndex(evidenceCatalog, `uncertainClaim:${index}`) })),
      contradictions: input.verification.contradictions.map((claim, index) => ({ ...claim, evidenceIndex: evidenceIndex(evidenceCatalog, `contradiction:${index}`) })),
    },
    translation: {
      translatedTitle: input.translation.translatedTitle,
      translatedFacts: input.translation.translatedFacts.map((fact, index) => {
        const verifiedFactIndex = input.verification.verifiedFacts.findIndex((verified) => verified.claim === fact.sourceText);
        if (verifiedFactIndex < 0) throw new Error("CRITIC_TRANSLATION_SOURCE_FACT_NOT_VERIFIED");
        return { evidenceIndex: evidenceIndex(evidenceCatalog, `translatedFact:${index}`), verifiedFactIndex: evidenceIndex(evidenceCatalog, `verifiedFact:${verifiedFactIndex}`), translatedText: fact.translatedText, sourceItemId: fact.sourceItemId };
      }),
      preservedNames: input.translation.preservedNames,
    },
    editorial: {
      headlineEs: input.editorial.headlineEs,
      dekEs: input.editorial.dekEs,
      summaryEs: input.editorial.summaryEs,
      whyItMattersEs: input.editorial.whyItMattersEs,
      bodyEs: input.editorial.bodyEs.slice(0, MAX_BODY_CHARS),
      keyPoints: input.editorial.keyPoints,
      evidenceIndices: {
        headline: evidenceIndex(evidenceCatalog, "editor:headline"),
        dek: evidenceIndex(evidenceCatalog, "editor:dek"),
        summary: evidenceIndex(evidenceCatalog, "editor:summary"),
        whyItMatters: evidenceIndex(evidenceCatalog, "editor:whyItMatters"),
        body: evidenceIndex(evidenceCatalog, "editor:body"),
        keyPoints: evidenceIndex(evidenceCatalog, "editor:keyPoints"),
      },
    },
    classification: {
      primaryRegionCode: input.classification.primaryRegionCode,
      countryCodes: input.classification.countryCodes,
      categorySlugs: input.classification.categorySlugs,
      companies: input.classification.companies,
      models: input.classification.models,
      people: input.classification.people,
      technologies: input.classification.technologies,
      evidenceIndices: optionalEvidenceIndices(evidenceCatalog, {
        region: "classification:region", countries: "classification:countries", categories: "classification:categories",
        companies: "classification:companies", models: "classification:models", people: "classification:people", technologies: "classification:technologies",
      }),
    },
    ranking: {
      result: {
        impact: input.ranking.result.impact,
        novelty: input.ranking.result.novelty,
        reach: input.ranking.result.reach,
        credibility: input.ranking.result.credibility,
        economicImpact: input.ranking.result.economicImpact,
        momentum: input.ranking.result.momentum,
        importanceScore: input.ranking.result.importanceScore,
        rankReason: input.ranking.result.rankReason,
      },
      formulaVersion: input.ranking.formulaVersion,
      momentumAvailable: input.ranking.momentumAvailable,
      deterministicSignals: {
        contradictionPenalty: input.ranking.deterministicSignals.contradictionPenalty,
        uncertaintyPenalty: input.ranking.deterministicSignals.uncertaintyPenalty,
        geographicReachSignal: input.ranking.deterministicSignals.geographicReachSignal,
      },
      evidenceIndices: {
        impact: evidenceIndex(evidenceCatalog, "ranking:impact"),
        novelty: evidenceIndex(evidenceCatalog, "ranking:novelty"),
        reach: evidenceIndex(evidenceCatalog, "ranking:reach"),
        credibility: evidenceIndex(evidenceCatalog, "ranking:credibility"),
        economicImpact: evidenceIndex(evidenceCatalog, "ranking:economicImpact"),
        momentum: evidenceIndex(evidenceCatalog, "ranking:momentum"),
        importanceScore: evidenceIndex(evidenceCatalog, "ranking:importanceScore"),
        rankReason: evidenceIndex(evidenceCatalog, "ranking:rankReason"),
      },
    },
    sources: input.sources.map((source, index) => {
      const evidence = input.sourceEvidence.find((candidate) => candidate.sourceItemId === source.sourceItemId);
      if (!evidence) throw new Error("CRITIC_SOURCE_EVIDENCE_LINEAGE_MISMATCH");
      return { evidenceIndex: evidenceIndex(evidenceCatalog, `source:${index}`), sourceId: source.sourceId, sourceName: source.sourceName, sourceItemId: source.sourceItemId, canonicalUrl: evidence.canonicalUrl, title: evidence.title, language: source.language };
    }),
    sourceEvidence,
    geo: input.geo,
    evidenceCatalog: evidenceCatalog.map(({ evidenceIndex: index }) => index),
  });
  return { input: modelInput, bodyTruncated, evidenceCatalog };
}
