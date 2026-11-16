import { z } from "zod";
import { editorialDraftSchema, translationResultSchema, verificationResultSchema } from "../contracts/index.ts";

const countryCode = z.string().regex(/^[A-Z]{2}$/);
const regionCode = z.string().trim().regex(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/).max(40);
const entityName = z.string().trim().min(1).max(200);
const sourceSchema = z.object({
  sourceName: z.string().trim().min(1).max(200),
  sourceType: z.string().trim().min(1).max(100).nullable(),
  countryCode: countryCode.nullable(),
}).strict();
const eventSchema = z.object({ eventKey: z.string().trim().min(1).max(200), canonicalTitle: z.string().trim().min(1).max(500) }).strict();
const verificationSchema = verificationResultSchema.pick({ status: true, confidenceScore: true, verifiedFacts: true, uncertainClaims: true, contradictions: true });
const translationFactSchema = translationResultSchema.shape.translatedFacts.element.pick({ sourceText: true, translatedText: true });
const translationSchema = z.object({
  translatedTitle: translationResultSchema.shape.translatedTitle,
  translatedFacts: z.array(translationFactSchema).min(1).max(100),
  preservedNames: translationResultSchema.shape.preservedNames,
}).strict();
const editorialSchema = editorialDraftSchema.pick({ headlineEs: true, summaryEs: true, keyPoints: true });

export const classifierInputSchema = z.object({
  schemaVersion: z.literal(1),
  event: eventSchema,
  verification: verificationSchema,
  translation: translationSchema,
  editorial: editorialSchema,
  sources: z.array(sourceSchema).min(1).max(100),
}).strict().superRefine((input, context) => {
  const facts = [...input.verification.verifiedFacts, ...input.verification.uncertainClaims, ...input.verification.contradictions];
  if (facts.some((fact) => fact.sourceIds.length === 0)) {
    context.addIssue({ code: "custom", path: ["verification"], message: "Classification requires source-backed verification claims" });
  }
});

export type ClassifierInput = z.infer<typeof classifierInputSchema>;

export const classifierModelInputSchema = z.object({
  schemaVersion: z.literal(1),
  event: eventSchema,
  verification: verificationSchema,
  translation: translationSchema,
  editorial: editorialSchema,
  sources: z.array(sourceSchema).min(1).max(100),
  allowedRegionCodes: z.array(regionCode).min(1).max(100),
  allowedCategorySlugs: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
}).strict();

export type ClassifierModelInput = z.infer<typeof classifierModelInputSchema>;

const list = z.array(entityName).max(100);

/** Only semantic model decisions. Deterministic fields are deliberately absent. */
export const classifierGenerationSchema = z.object({
  primaryRegionCode: regionCode.nullable(),
  countryCodes: z.array(countryCode).max(20).refine((values) => new Set(values).size === values.length, "Country codes must be unique"),
  categorySlugs: z.array(z.string().trim().min(1).max(80)).max(3).refine((values) => new Set(values).size === values.length, "Category slugs must be unique"),
  companies: list,
  models: list,
  people: list,
  technologies: list,
}).strict();

export type ClassifierGeneration = z.infer<typeof classifierGenerationSchema>;
