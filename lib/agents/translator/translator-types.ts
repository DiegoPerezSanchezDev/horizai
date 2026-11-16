import { z } from "zod";
import { clusteredEventSchema, verificationResultSchema } from "../contracts/index.ts";

const identifier = z.string().trim().min(1).max(200);
const uuid = z.string().uuid();
const languageCode = z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/);
const countryCode = z.string().regex(/^[A-Z]{2}$/);
const claimSchema = z.object({
  claim: z.string().trim().min(1).max(1_500),
  sourceIds: z.array(uuid).max(100),
}).strict();

export const sourceMetadataSchema = z.object({
  sourceId: uuid,
  sourceName: z.string().trim().min(1).max(200),
  sourceItemId: identifier,
  language: languageCode,
  sourceType: z.string().trim().min(1).max(100).nullable(),
  countryCode: countryCode.nullable(),
}).strict();

export const translatorInputSchema = z.object({
  schemaVersion: z.literal(1),
  event: clusteredEventSchema,
  verification: verificationResultSchema,
  sourceLanguage: languageCode,
  sources: z.array(sourceMetadataSchema).min(1).max(100),
}).strict().refine((input) => input.verification.status !== "rejected", {
  message: "Rejected events cannot advance to translation",
  path: ["verification", "status"],
});

export type TranslatorInput = z.infer<typeof translatorInputSchema>;

export const translatorModelInputSchema = z.object({
  schemaVersion: z.literal(1),
  eventKey: identifier,
  canonicalTitle: z.string().trim().min(1).max(500),
  sourceLanguage: languageCode,
  targetLanguage: z.literal("es"),
  sources: z.array(sourceMetadataSchema.pick({ sourceId: true, sourceName: true, sourceItemId: true, language: true })).min(1).max(100),
  verifiedFacts: z.array(claimSchema).max(100),
  uncertainClaims: z.array(claimSchema).max(100),
  contradictions: z.array(claimSchema).max(50),
}).strict();

export type TranslatorModelInput = z.infer<typeof translatorModelInputSchema>;
