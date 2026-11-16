import { z } from "zod";
import {
  classificationResultSchema,
  editorialDraftSchema,
  rankingResultSchema,
  translationResultSchema,
  verificationResultSchema,
} from "../contracts/index.ts";
import { sourceMetadataSchema } from "../translator/translator-types.ts";
import { criticEvidenceCatalogItemSchema } from "./critic-evidence-catalog.ts";

const identifier = z.string().trim().min(1).max(200);
const isoDateTime = z.iso.datetime({ offset: true });

export const criticStageSchema = z.enum(["verification", "translation", "editorial", "classification", "ranking"]);
export type CriticStage = z.infer<typeof criticStageSchema>;

export const criticDimensionSchema = z.enum([
  "FACTUAL_ACCURACY",
  "FACTUAL_PRECISION",
  "TRANSLATION_FIDELITY",
  "UNCERTAINTY_PRESERVED",
  "NO_ADDED_FACTS",
  "NO_HALLUCINATIONS",
  "HEADLINE_ACCURACY",
  "DEK_ACCURACY",
  "WHY_IT_MATTERS_SUPPORT",
  "COPYRIGHT_SCOPE",
  "CATEGORY_ACCURACY",
  "REGION_ACCURACY",
  "COUNTRY_ACCURACY",
  "ENTITY_ACCURACY",
  "RANKING_REASONABLENESS",
  "CREDIBILITY_CONSISTENCY",
  "SOURCE_TRACEABILITY",
]);
export type CriticDimension = z.infer<typeof criticDimensionSchema>;

export const criticFindingSeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type CriticFindingSeverity = z.infer<typeof criticFindingSeveritySchema>;

const evidenceRef = z.string().regex(
  /^(?:source|verifiedFact|uncertainClaim|contradiction|translatedFact):\d+$|^editor:(?:headline|dek|summary|whyItMatters|body|keyPoints)$|^classification:(?:region|countries|categories|companies|models|people|technologies)$|^ranking:(?:impact|novelty|reach|credibility|economicImpact|momentum|importanceScore|rankReason)$/, 
  "Evidence reference has an invalid syntax",
);

const criticIssueFindingV2Schema = z.object({
  kind: z.literal("issue"),
  dimension: criticDimensionSchema,
  stage: criticStageSchema,
  severity: criticFindingSeveritySchema,
  message: z.string().trim().min(1).max(1_000),
  evidenceRefs: z.array(evidenceRef).max(20).refine((values) => new Set(values).size === values.length, "Evidence references must be unique"),
}).strict();

const criticUnsupportedClaimFindingV2Schema = z.object({
  kind: z.literal("unsupported_claim"),
  claim: z.string().trim().min(1).max(1_500),
  reason: z.string().trim().min(1).max(1_000),
  stage: criticStageSchema,
  severity: criticFindingSeveritySchema,
  evidenceRefs: z.array(evidenceRef).max(20).refine((values) => new Set(values).size === values.length, "Evidence references must be unique"),
}).strict();

/** Historical v2 model output. It remains available for replay/audit only. */
export const criticGenerationV2Schema = z.object({
  findings: z.array(z.discriminatedUnion("kind", [criticIssueFindingV2Schema, criticUnsupportedClaimFindingV2Schema])).max(50),
}).strict();
export type CriticGenerationV2 = z.infer<typeof criticGenerationV2Schema>;

const evidenceIndices = z.array(z.number().int().nonnegative()).max(20).refine((values) => new Set(values).size === values.length, "Evidence indices must be unique");
const criticIssueFindingV3Schema = z.object({
  kind: z.literal("issue"),
  dimension: criticDimensionSchema,
  stage: criticStageSchema,
  severity: criticFindingSeveritySchema,
  message: z.string().trim().min(1).max(1_000),
  evidenceIndices,
}).strict();
const criticUnsupportedClaimFindingV3Schema = z.object({
  kind: z.literal("unsupported_claim"),
  claim: z.string().trim().min(1).max(1_500),
  reason: z.string().trim().min(1).max(1_000),
  stage: criticStageSchema,
  severity: criticFindingSeveritySchema,
  evidenceIndices,
}).strict();

export const criticGenerationV3Schema = z.object({
  findings: z.array(z.discriminatedUnion("kind", [criticIssueFindingV3Schema, criticUnsupportedClaimFindingV3Schema])).max(50),
}).strict();
/** Current model-facing generation contract. */
export const criticGenerationSchema = criticGenerationV3Schema;
export const criticCurrentGenerationSchema = criticGenerationV3Schema;
export type CriticGeneration = z.infer<typeof criticGenerationV3Schema>;
export type CriticResolvedFinding =
  | (z.infer<typeof criticIssueFindingV3Schema> & { evidenceRefs: string[] })
  | (z.infer<typeof criticUnsupportedClaimFindingV3Schema> & { evidenceRefs: string[] });
export type CriticResolvedGeneration = { findings: CriticResolvedFinding[] };

const eventSchema = z.object({
  eventKey: identifier,
  canonicalTitle: z.string().trim().min(1).max(500),
  sourceCount: z.number().int().positive().max(100),
  occurredAt: isoDateTime.nullable(),
  latestPublishedAt: isoDateTime.nullable(),
}).strict();

const translationInputSchema = z.object({
  schemaVersion: translationResultSchema.shape.schemaVersion,
  eventKey: translationResultSchema.shape.eventKey,
  sourceLanguage: translationResultSchema.shape.sourceLanguage,
  targetLanguage: translationResultSchema.shape.targetLanguage,
  translatedTitle: translationResultSchema.shape.translatedTitle,
  // An empty array is accepted only at this internal boundary so the
  // authoritative NO_VERIFIED_FACTS precheck can fail closed explicitly.
  translatedFacts: z.array(translationResultSchema.shape.translatedFacts.element).max(100),
  translatedSourceMaterial: translationResultSchema.shape.translatedSourceMaterial,
  preservedNames: translationResultSchema.shape.preservedNames,
  translationNotes: translationResultSchema.shape.translationNotes,
}).strict();

const geoResolutionSchema = z.object({
  latitude: z.number().finite().min(-90).max(90).nullable(),
  longitude: z.number().finite().min(-180).max(180).nullable(),
  resolutionLevel: z.enum(["global", "region", "country", "unresolved"]),
  resolvedFrom: z.enum(["country_registry", "region_registry"]).nullable(),
}).strict();

const criticSourceEvidenceSchema = z.object({
  sourceId: identifier,
  sourceItemId: identifier,
  canonicalUrl: z.url().refine((value) => /^https?:\/\//i.test(value), "URL must use http or https"),
  title: z.string().trim().min(1).max(500),
  contentExcerpt: z.string().trim().min(1).max(1_000),
  contentHash: z.string().trim().min(8).max(256),
  excerptTruncated: z.boolean(),
}).strict();

const criticSourceEvidenceListSchema = z.array(criticSourceEvidenceSchema).max(100).default([]);

const rankingCheckpointSchema = z.object({
  result: rankingResultSchema,
  formulaVersion: z.string().trim().min(1).max(50),
  momentumAvailable: z.boolean(),
  deterministicSignals: z.object({
    credibility: z.number().int().min(0).max(100),
    reach: z.number().int().min(0).max(100),
    momentum: z.number().int().min(0).max(100),
    sourceCount: z.number().int().positive().max(100),
    contradictionPenalty: z.number().int().nonnegative(),
    uncertaintyPenalty: z.number().int().nonnegative(),
    geographicReachSignal: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const criticInputSchema = z.object({
  schemaVersion: z.literal(1),
  event: eventSchema,
  verification: verificationResultSchema,
  translation: translationInputSchema,
  editorial: editorialDraftSchema,
  classification: classificationResultSchema,
  ranking: rankingCheckpointSchema,
  sources: z.array(sourceMetadataSchema).min(1).max(100),
  // Defaults preserve the ability to read legacy checkpoints. Critic prechecks
  // fail closed for a live run if its bounded source evidence is absent.
  sourceEvidence: criticSourceEvidenceListSchema,
  geo: geoResolutionSchema,
}).strict().superRefine((value, context) => {
  const excerptChars = value.sourceEvidence.reduce((total, evidence) => total + evidence.contentExcerpt.length, 0);
  if (excerptChars > 4_000) context.addIssue({ code: "custom", path: ["sourceEvidence"], message: "Critic source evidence exceeds the 4,000 character budget" });
});
export type CriticInput = z.infer<typeof criticInputSchema>;
export type CriticGeoResolution = z.infer<typeof geoResolutionSchema>;
export type CriticRankingCheckpoint = z.infer<typeof rankingCheckpointSchema>;

export const criticModelInputV3Schema = z.object({
  schemaVersion: z.literal(1),
  event: eventSchema.pick({ eventKey: true, canonicalTitle: true }),
  verification: verificationResultSchema.pick({ status: true, confidenceScore: true, verifiedFacts: true, uncertainClaims: true, contradictions: true }),
  translation: z.object({
    translatedTitle: translationResultSchema.shape.translatedTitle,
    translatedFacts: translationResultSchema.shape.translatedFacts,
    preservedNames: translationResultSchema.shape.preservedNames,
    translationNotes: translationResultSchema.shape.translationNotes,
  }).strict(),
  editorial: editorialDraftSchema.pick({ headlineEs: true, dekEs: true, summaryEs: true, whyItMattersEs: true, bodyEs: true, keyPoints: true }),
  classification: classificationResultSchema,
  ranking: rankingCheckpointSchema,
  sources: z.array(sourceMetadataSchema.pick({ sourceId: true, sourceName: true, sourceItemId: true, language: true, sourceType: true, countryCode: true })).min(1).max(100),
  sourceEvidence: z.array(criticSourceEvidenceSchema.pick({ sourceId: true, sourceItemId: true, canonicalUrl: true, title: true, contentExcerpt: true, excerptTruncated: true })).min(1).max(100),
  evidenceCatalog: z.array(criticEvidenceCatalogItemSchema).min(1).max(300),
}).strict().superRefine((value, context) => {
  const excerptChars = value.sourceEvidence.reduce((total, evidence) => total + evidence.contentExcerpt.length, 0);
  if (excerptChars > 4_000) context.addIssue({ code: "custom", path: ["sourceEvidence"], message: "Critic source evidence exceeds the 4,000 character budget" });
});
export type CriticModelInputV3 = z.infer<typeof criticModelInputV3Schema>;

const evidenceIndex = z.number().int().nonnegative();
const indexedClaim = z.object({ evidenceIndex, claim: z.string().trim().min(1).max(1_500), sourceIds: z.array(z.string().uuid()).max(100) }).strict();
const indexedTranslatedFact = z.object({ evidenceIndex, verifiedFactIndex: evidenceIndex, translatedText: z.string().trim().min(1).max(2_000), sourceItemId: identifier.nullable() }).strict();

/** Critic v4 sends each proposition once and uses indices only as evidence links. */
export const criticModelInputV4Schema = z.object({
  schemaVersion: z.literal(2),
  event: z.object({ eventKey: identifier, canonicalTitle: z.string().trim().min(1).max(500) }).strict(),
  verification: z.object({
    status: verificationResultSchema.shape.status,
    confidenceScore: verificationResultSchema.shape.confidenceScore,
    verifiedFacts: z.array(indexedClaim).max(100),
    uncertainClaims: z.array(indexedClaim).max(100),
    contradictions: z.array(indexedClaim).max(50),
  }).strict(),
  translation: z.object({
    translatedTitle: translationResultSchema.shape.translatedTitle,
    translatedFacts: z.array(indexedTranslatedFact).max(100),
    preservedNames: translationResultSchema.shape.preservedNames,
  }).strict(),
  editorial: z.object({
    headlineEs: editorialDraftSchema.shape.headlineEs,
    dekEs: editorialDraftSchema.shape.dekEs,
    summaryEs: editorialDraftSchema.shape.summaryEs,
    whyItMattersEs: editorialDraftSchema.shape.whyItMattersEs,
    bodyEs: editorialDraftSchema.shape.bodyEs,
    keyPoints: editorialDraftSchema.shape.keyPoints,
    evidenceIndices: z.object({ headline: evidenceIndex, dek: evidenceIndex, summary: evidenceIndex, whyItMatters: evidenceIndex, body: evidenceIndex, keyPoints: evidenceIndex }).strict(),
  }).strict(),
  classification: z.object({
    primaryRegionCode: classificationResultSchema.shape.primaryRegionCode,
    countryCodes: classificationResultSchema.shape.countryCodes,
    categorySlugs: classificationResultSchema.shape.categorySlugs,
    companies: classificationResultSchema.shape.companies,
    models: classificationResultSchema.shape.models,
    people: classificationResultSchema.shape.people,
    technologies: classificationResultSchema.shape.technologies,
    evidenceIndices: z.object({ region: evidenceIndex, countries: evidenceIndex, categories: evidenceIndex, companies: evidenceIndex, models: evidenceIndex, people: evidenceIndex, technologies: evidenceIndex }).partial().strict(),
  }).strict(),
  ranking: z.object({
    result: z.object({
      impact: rankingResultSchema.shape.impact,
      novelty: rankingResultSchema.shape.novelty,
      reach: rankingResultSchema.shape.reach,
      credibility: rankingResultSchema.shape.credibility,
      economicImpact: rankingResultSchema.shape.economicImpact,
      momentum: rankingResultSchema.shape.momentum,
      importanceScore: rankingResultSchema.shape.importanceScore,
      rankReason: rankingResultSchema.shape.rankReason,
    }).strict(),
    formulaVersion: z.string().trim().min(1).max(50),
    momentumAvailable: z.boolean(),
    deterministicSignals: z.object({
      contradictionPenalty: z.number().int().nonnegative(), uncertaintyPenalty: z.number().int().nonnegative(), geographicReachSignal: z.number().int().nonnegative(),
    }).strict(),
    evidenceIndices: z.object({ impact: evidenceIndex, novelty: evidenceIndex, reach: evidenceIndex, credibility: evidenceIndex, economicImpact: evidenceIndex, momentum: evidenceIndex, importanceScore: evidenceIndex, rankReason: evidenceIndex }).strict(),
  }).strict(),
  sources: z.array(z.object({
    evidenceIndex,
    sourceId: sourceMetadataSchema.shape.sourceId,
    sourceName: sourceMetadataSchema.shape.sourceName,
    sourceItemId: sourceMetadataSchema.shape.sourceItemId,
    canonicalUrl: z.url().refine((value) => /^https?:\/\//i.test(value)),
    title: z.string().trim().min(1).max(500),
    language: sourceMetadataSchema.shape.language,
  }).strict()).min(1).max(100),
  sourceEvidence: z.array(z.object({ evidenceIndex, contentExcerpt: z.string().trim().min(1).max(1_000), contentHash: z.string().trim().min(8).max(256), excerptTruncated: z.boolean() }).strict()).min(1).max(100),
  geo: z.object({ latitude: geoResolutionSchema.shape.latitude, longitude: geoResolutionSchema.shape.longitude, resolutionLevel: geoResolutionSchema.shape.resolutionLevel, resolvedFrom: geoResolutionSchema.shape.resolvedFrom }).strict(),
  evidenceCatalog: z.array(evidenceIndex).min(1).max(300),
}).strict().superRefine((value, context) => {
  const excerptChars = value.sourceEvidence.reduce((total, evidence) => total + evidence.contentExcerpt.length, 0);
  if (excerptChars > 4_000) context.addIssue({ code: "custom", path: ["sourceEvidence"], message: "Critic source evidence exceeds the 4,000 character budget" });
});
export const criticModelInputSchema = criticModelInputV4Schema;
export type CriticModelInput = z.infer<typeof criticModelInputV4Schema>;

export type CriticPrecheckIssue = {
  code: string;
  stage: CriticStage;
  severity: CriticFindingSeverity;
  message: string;
  evidenceRefs: string[];
};

export type CriticPrecheckResult = {
  passed: boolean;
  issues: CriticPrecheckIssue[];
};
