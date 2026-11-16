import { z } from "zod";

const schemaVersion = z.literal(1);
const uuid = z.string().uuid();
const identifier = z.string().trim().min(1).max(200);
const languageCode = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const regionCode = z.string().trim().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/).max(40);
const isoDateTime = z.iso.datetime({ offset: true });
const httpUrl = z
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "URL must use http or https");
const score100 = z.number().finite().min(0).max(100);
const verificationConfidenceScore = z.number().int().min(0).max(100);

const unique = <T>(values: T[]) => new Set(values).size === values.length;

const stringList = (maxItems: number, maxLength: number) =>
  z
    .array(z.string().trim().min(1).max(maxLength))
    .max(maxItems)
    .refine(unique, "List values must be unique");

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

const metadataSchema = z.record(z.string(), jsonValueSchema);
export const extractionQualitySchema = z.enum(["full", "partial", "metadata_only", "failed"]);
export type ExtractionQuality = z.infer<typeof extractionQualitySchema>;

const claimSchema = z
  .object({
    claim: z.string().trim().min(1).max(1_500),
    sourceIds: z.array(uuid).max(100).refine(unique, "Source IDs must be unique"),
  })
  .strict();

export const discoveryCandidateSchema = z
  .object({
    schemaVersion,
    externalId: identifier,
    sourceId: uuid,
    sourceName: z.string().trim().min(1).max(200),
    url: httpUrl,
    titleOriginal: z.string().trim().min(1).max(500),
    excerptOriginal: z.string().trim().max(2_000).nullable(),
    language: languageCode,
    publishedAt: isoDateTime.nullable(),
    discoveredAt: isoDateTime,
    possibleCountryCode: countryCode.nullable(),
    possibleRegionCode: regionCode.nullable(),
  })
  .strict();

export type DiscoveryCandidate = z.infer<typeof discoveryCandidateSchema>;

export const extractedItemSchema = z
  .object({
    schemaVersion,
    candidateId: identifier,
    url: httpUrl,
    canonicalUrl: httpUrl,
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(3_000).nullable(),
    author: z.string().trim().max(300).nullable(),
    publishedAt: isoDateTime.nullable(),
    language: languageCode,
    content: z.string().trim().min(1).max(500_000),
    contentHash: z.string().trim().min(8).max(256),
    metadata: metadataSchema,
    extractionQuality: extractionQualitySchema.optional(),
  })
  .strict();

export type ExtractedItem = z.infer<typeof extractedItemSchema>;

const clusteredSourceItemSchema = z
  .object({
    candidateId: identifier,
    sourceId: uuid,
    sourceName: z.string().trim().min(1).max(200),
    url: httpUrl,
    title: z.string().trim().min(1).max(500),
    publishedAt: isoDateTime.nullable(),
  })
  .strict();

export const clusteredEventSchema = z
  .object({
    schemaVersion,
    eventKey: identifier,
    canonicalTitle: z.string().trim().min(1).max(500),
    sourceItems: z.array(clusteredSourceItemSchema).min(1).max(100),
    probableOccurredAt: isoDateTime.nullable(),
    probableCountryCode: countryCode.nullable(),
    probableRegionCode: regionCode.nullable(),
    clusterConfidence: score100,
  })
  .strict();

export type ClusteredEvent = z.infer<typeof clusteredEventSchema>;

export const verificationStatusSchema = z.enum([
  "confirmed",
  "developing",
  "single_source",
  "rumor",
  "rejected",
]);

export const verificationResultSchema = z
  .object({
    schemaVersion,
    eventKey: identifier,
    status: verificationStatusSchema,
    confidenceScore: verificationConfidenceScore,
    primarySourceId: uuid.nullable(),
    supportingSourceIds: z.array(uuid).max(100).refine(unique, "Source IDs must be unique"),
    contradictions: z.array(claimSchema).max(50),
    uncertainClaims: z.array(claimSchema).max(100),
    reason: z.string().trim().min(1).max(2_000),
    verifiedFacts: z.array(claimSchema).max(100),
  })
  .strict();

export type VerificationResult = z.infer<typeof verificationResultSchema>;

const translatedFactSchema = z
  .object({
    sourceText: z.string().trim().min(1).max(2_000),
    translatedText: z.string().trim().min(1).max(2_000),
    sourceItemId: identifier.nullable(),
  })
  .strict();

export const translationResultSchema = z
  .object({
    schemaVersion,
    eventKey: identifier,
    sourceLanguage: languageCode,
    targetLanguage: z.literal("es"),
    translatedTitle: z.string().trim().min(1).max(500),
    translatedFacts: z.array(translatedFactSchema).min(1).max(100),
    translatedSourceMaterial: z.string().trim().min(1).max(120_000),
    preservedNames: stringList(100, 200),
    translationNotes: stringList(30, 500),
  })
  .strict();

export type TranslationResult = z.infer<typeof translationResultSchema>;

const editorialText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !/[!?]{2,}/.test(value), "Avoid repeated exclamation or question marks");

export const editorialDraftSchema = z
  .object({
    schemaVersion,
    eventKey: identifier,
    headlineEs: editorialText(10, 160),
    dekEs: editorialText(10, 360),
    summaryEs: editorialText(30, 800),
    whyItMattersEs: editorialText(30, 1_200),
    bodyEs: editorialText(100, 50_000),
    keyPoints: z.array(editorialText(10, 280)).min(1).max(8),
    suggestedSlug: z
      .string()
      .trim()
      .min(3)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  })
  .strict();

export type EditorialDraft = z.infer<typeof editorialDraftSchema>;

const normalizedEntityName = z.string().trim().min(1).max(200);
const coordinate = z.number().finite();

export const classificationResultSchema = z
  .object({
    schemaVersion,
    eventKey: identifier,
    primaryRegionCode: regionCode.nullable(),
    countryCodes: z.array(countryCode).max(100).refine(unique, "Country codes must be unique"),
    categorySlugs: stringList(30, 80),
    companies: z.array(normalizedEntityName).max(100),
    models: z.array(normalizedEntityName).max(100),
    people: z.array(normalizedEntityName).max(100),
    technologies: z.array(normalizedEntityName).max(100),
    latitude: coordinate.min(-90).max(90).nullable(),
    longitude: coordinate.min(-180).max(180).nullable(),
  })
  .strict()
  .refine(
    (value) => (value.latitude === null) === (value.longitude === null),
    "Latitude and longitude must both be null or both be provided"
  );

export type ClassificationResult = z.infer<typeof classificationResultSchema>;

export const rankingResultSchema = z
  .object({
    schemaVersion,
    eventKey: identifier,
    impact: score100,
    novelty: score100,
    reach: score100,
    credibility: score100,
    economicImpact: score100,
    momentum: score100,
    importanceScore: score100.nullable().optional(),
    rankReason: z.string().trim().min(1).max(1_200),
  })
  .strict();

export type RankingResult = z.infer<typeof rankingResultSchema>;

export type RankingDimensions = Pick<
  RankingResult,
  "impact" | "novelty" | "reach" | "credibility" | "economicImpact" | "momentum"
>;

/** Deterministic fallback for when an agent returns only the six dimensions. */
export function calculateImportanceScore(input: RankingDimensions): number {
  const weightedScore =
    input.impact * 0.25 +
    input.novelty * 0.15 +
    input.reach * 0.2 +
    input.credibility * 0.2 +
    input.economicImpact * 0.1 +
    input.momentum * 0.1;

  return Math.round(weightedScore * 100) / 100;
}

export const criticDecisionSchema = z.enum([
  "pass",
  "revise_verification",
  "revise_translation",
  "revise_editorial",
  "revise_classification",
  "revise_ranking",
  "reject",
]);

export const criticSeveritySchema = z.enum(["low", "medium", "high", "critical"]);

const criticIssueSchema = z
  .object({
    code: z.string().trim().min(1).max(80),
    field: identifier.nullable(),
    severity: criticSeveritySchema,
    message: z.string().trim().min(1).max(1_000),
  })
  .strict();

const unsupportedClaimSchema = z
  .object({
    claim: z.string().trim().min(1).max(1_500),
    reason: z.string().trim().min(1).max(1_000),
    sourceIds: z.array(uuid).max(100).refine(unique, "Source IDs must be unique"),
  })
  .strict();

export const criticResultSchema = z
  .object({
    schemaVersion,
    eventKey: identifier,
    decision: criticDecisionSchema,
    issues: z.array(criticIssueSchema).max(50),
    unsupportedClaims: z.array(unsupportedClaimSchema).max(50),
    severity: criticSeveritySchema,
    notes: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type CriticResult = z.infer<typeof criticResultSchema>;

const publicationSourceSchema = z
  .object({
    sourceId: uuid,
    /** Required by the atomic materializer only when the event is new. */
    rawItemId: uuid.optional(),
    sourceName: z.string().trim().min(1).max(200),
    url: httpUrl,
    isPrimary: z.boolean(),
    publishedAt: isoDateTime.nullable(),
  })
  .strict();

const publicationCategorySchema = z
  .object({
    categorySlug: z.string().trim().min(1).max(80),
    isPrimary: z.boolean(),
    confidenceScore: score100,
  })
  .strict();

const publicationEntitySchema = z
  .object({
    entityType: z.enum(["person", "organization", "model", "product", "location", "other"]),
    canonicalName: normalizedEntityName,
    countryCode: countryCode.nullable(),
    role: z.enum(["subject", "mentioned", "source", "other"]),
    confidenceScore: score100,
  })
  .strict();

const publicationEventSchema = z
  .object({
    canonicalTitle: z.string().trim().min(1).max(500),
    probableOccurredAt: isoDateTime.nullable(),
    probableCountryCode: countryCode.nullable(),
    probableRegionCode: regionCode.nullable(),
  })
  .strict();

const publicationArticleSchema = z
  .object({
    slug: editorialDraftSchema.shape.suggestedSlug,
    headlineEs: editorialDraftSchema.shape.headlineEs,
    dekEs: editorialDraftSchema.shape.dekEs,
    summaryEs: editorialDraftSchema.shape.summaryEs,
    whyItMattersEs: editorialDraftSchema.shape.whyItMattersEs,
    bodyEs: editorialDraftSchema.shape.bodyEs,
    keyPoints: editorialDraftSchema.shape.keyPoints,
  })
  .strict();

const publicationRegionSchema = z
  .object({
    code: regionCode.nullable(),
    latitude: coordinate.min(-90).max(90).nullable(),
    longitude: coordinate.min(-180).max(180).nullable(),
  })
  .strict()
  .refine(
    (value) => (value.latitude === null) === (value.longitude === null),
    "Latitude and longitude must both be null or both be provided"
  );

const publicationScoresSchema = z
  .object({
    impact: score100,
    novelty: score100,
    reach: score100,
    credibility: score100,
    economicImpact: score100,
    momentum: score100,
    importanceScore: score100,
  })
  .strict();

export const publicationPayloadSchema = z
  .object({
    schemaVersion,
    eventKey: identifier,
    event: publicationEventSchema,
    article: publicationArticleSchema,
    sources: z.array(publicationSourceSchema).min(1).max(100),
    categories: z.array(publicationCategorySchema).max(30),
    entities: z.array(publicationEntitySchema).max(100),
    region: publicationRegionSchema,
    scores: publicationScoresSchema,
    verification: verificationResultSchema,
    critic: criticResultSchema,
  })
  .strict();

export type PublicationPayload = z.infer<typeof publicationPayloadSchema>;

export const pipelineRunContextSchema = z
  .object({
    schemaVersion,
    runId: uuid,
    dryRun: z.boolean(),
    startedAt: isoDateTime,
    trigger: z.enum(["manual", "scheduled", "retry"]),
    agentVersions: z
      .record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(100))
      .refine((value) => Object.keys(value).length <= 50, "Too many agent versions"),
  })
  .strict();

export type PipelineRunContext = z.infer<typeof pipelineRunContextSchema>;

const nonNegativeCount = z.number().int().min(0).max(1_000_000_000);

export const pipelineStatsSchema = z
  .object({
    schemaVersion,
    candidatesDiscovered: nonNegativeCount,
    itemsExtracted: nonNegativeCount,
    eventsClustered: nonNegativeCount,
    eventsVerified: nonNegativeCount,
    eventsRejected: nonNegativeCount,
    articlesTranslated: nonNegativeCount,
    articlesEdited: nonNegativeCount,
    articlesClassified: nonNegativeCount,
    articlesRanked: nonNegativeCount,
    criticPassed: nonNegativeCount,
    criticRejected: nonNegativeCount,
    published: nonNegativeCount,
    failed: nonNegativeCount,
  })
  .strict();

export type PipelineStats = z.infer<typeof pipelineStatsSchema>;

export const contractSchemas = {
  DiscoveryCandidate: discoveryCandidateSchema,
  ExtractedItem: extractedItemSchema,
  ClusteredEvent: clusteredEventSchema,
  VerificationResult: verificationResultSchema,
  TranslationResult: translationResultSchema,
  EditorialDraft: editorialDraftSchema,
  ClassificationResult: classificationResultSchema,
  RankingResult: rankingResultSchema,
  CriticResult: criticResultSchema,
  PublicationPayload: publicationPayloadSchema,
  PipelineRunContext: pipelineRunContextSchema,
  PipelineStats: pipelineStatsSchema,
} as const;
