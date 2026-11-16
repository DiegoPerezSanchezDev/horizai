import { z } from "zod";
import { clusteredEventSchema, editorialDraftSchema, translationResultSchema, verificationResultSchema } from "../contracts/index.ts";

const httpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), "URL must use http or https");
const sourceSchema = z.object({
  sourceId: z.string().uuid(),
  sourceName: z.string().trim().min(1).max(200),
  canonicalUrl: httpUrl,
  sourceType: z.string().trim().min(1).max(100).nullable(),
}).strict();

const eventSchema = clusteredEventSchema.pick({ eventKey: true, canonicalTitle: true });
const verificationSchema = verificationResultSchema.pick({
  status: true,
  confidenceScore: true,
  verifiedFacts: true,
  uncertainClaims: true,
  contradictions: true,
});
const translationSchema = translationResultSchema.pick({
  translatedTitle: true,
  translatedFacts: true,
  translatedSourceMaterial: true,
  preservedNames: true,
  translationNotes: true,
});

export const editorInputSchema = z.object({
  schemaVersion: z.literal(1),
  event: eventSchema,
  verification: verificationSchema,
  translation: translationSchema,
  sources: z.array(sourceSchema).min(1).max(100),
}).strict().superRefine((input, context) => {
  if (input.verification.status === "rejected") {
    context.addIssue({ code: "custom", path: ["verification", "status"], message: "Rejected events cannot advance to editorial" });
  }
  if (input.verification.verifiedFacts.some((fact) => fact.sourceIds.some((id) => !input.sources.some((source) => source.sourceId === id)))) {
    context.addIssue({ code: "custom", path: ["verification", "verifiedFacts"], message: "Verified fact references a source outside the input" });
  }
  if (input.verification.uncertainClaims.some((claim) => claim.sourceIds.some((id) => !input.sources.some((source) => source.sourceId === id)))) {
    context.addIssue({ code: "custom", path: ["verification", "uncertainClaims"], message: "Uncertain claim references a source outside the input" });
  }
  if (input.verification.contradictions.some((claim) => claim.sourceIds.some((id) => !input.sources.some((source) => source.sourceId === id)))) {
    context.addIssue({ code: "custom", path: ["verification", "contradictions"], message: "Contradiction references a source outside the input" });
  }
});

export type EditorInput = z.infer<typeof editorInputSchema>;

export const editorModelInputSchema = editorInputSchema;
export type EditorModelInput = z.infer<typeof editorModelInputSchema>;

export type EditorialDraft = z.infer<typeof editorialDraftSchema>;
