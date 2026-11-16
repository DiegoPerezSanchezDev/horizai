import { z } from "zod";
import { classificationResultSchema, editorialDraftSchema, translationResultSchema, verificationResultSchema } from "../contracts/index.ts";

const score100Integer = z.number().int().min(0).max(100);
const identifier = z.string().trim().min(1).max(200);
const isoDateTime = z.iso.datetime({ offset: true });
const classificationContextSchema = z.object({
  primaryRegionCode: classificationResultSchema.shape.primaryRegionCode,
  countryCodes: classificationResultSchema.shape.countryCodes,
  categorySlugs: classificationResultSchema.shape.categorySlugs,
  companies: classificationResultSchema.shape.companies,
  models: classificationResultSchema.shape.models,
  people: classificationResultSchema.shape.people,
  technologies: classificationResultSchema.shape.technologies,
}).strict();

export const rankerInputSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.object({
    eventKey: identifier,
    canonicalTitle: z.string().trim().min(1).max(500),
    sourceCount: z.number().int().positive().max(100),
    occurredAt: isoDateTime.nullable(),
    latestPublishedAt: isoDateTime.nullable(),
  }).strict(),
  verification: verificationResultSchema.pick({ status: true, confidenceScore: true, verifiedFacts: true, uncertainClaims: true, contradictions: true }),
  translation: z.object({
    translatedTitle: translationResultSchema.shape.translatedTitle,
    translatedFacts: z.array(translationResultSchema.shape.translatedFacts.element.pick({ sourceText: true, translatedText: true })).max(100),
  }).strict(),
  editorial: editorialDraftSchema.pick({ headlineEs: true, summaryEs: true, whyItMattersEs: true, keyPoints: true }),
  classification: classificationContextSchema,
}).strict().superRefine((input, context) => {
  const facts = [...input.verification.verifiedFacts, ...input.verification.uncertainClaims, ...input.verification.contradictions];
  if (facts.some((fact) => fact.sourceIds.length === 0)) {
    context.addIssue({ code: "custom", path: ["verification"], message: "Ranking requires source-backed verification claims" });
  }
});

export type RankerInput = z.infer<typeof rankerInputSchema>;

export const rankerGenerationSchema = z.object({
  impact: score100Integer,
  novelty: score100Integer,
  economicImpact: score100Integer,
}).strict();

export type RankerGeneration = z.infer<typeof rankerGenerationSchema>;

export type RankerSemanticDimensions = Pick<RankerGeneration, "impact" | "novelty" | "economicImpact">;

export const activityHistorySignalSchema = z.object({
  periodStart: isoDateTime,
  periodEnd: isoDateTime,
  activityScore: score100Integer,
  eventCount: z.number().int().nonnegative(),
  articleCount: z.number().int().nonnegative(),
}).strict();

export type ActivityHistorySignal = z.infer<typeof activityHistorySignalSchema>;
