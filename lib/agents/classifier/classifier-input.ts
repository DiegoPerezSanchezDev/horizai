import type { EditorialDraft, TranslationResult, VerificationResult } from "../contracts/index.ts";
import { classifierInputSchema, type ClassifierInput, type ClassifierModelInput } from "./classifier-types.ts";

export const classifierVerificationInputKeys = ["status", "confidenceScore", "verifiedFacts", "uncertainClaims", "contradictions"] as const;
export const classifierTranslationInputKeys = ["translatedTitle", "translatedFacts", "preservedNames"] as const;
export const classifierEditorialInputKeys = ["headlineEs", "summaryEs", "keyPoints"] as const;

export function toClassifierVerificationInput(verification: VerificationResult): ClassifierInput["verification"] {
  return {
    status: verification.status,
    confidenceScore: verification.confidenceScore,
    verifiedFacts: verification.verifiedFacts,
    uncertainClaims: verification.uncertainClaims,
    contradictions: verification.contradictions,
  };
}

type ClassifierTranslationProjection = Pick<TranslationResult, "translatedTitle" | "preservedNames"> & {
  translatedFacts: Array<Pick<TranslationResult["translatedFacts"][number], "sourceText" | "translatedText">>;
};

export function toClassifierTranslationInput(translation: ClassifierTranslationProjection): ClassifierInput["translation"] {
  return {
    translatedTitle: translation.translatedTitle,
    translatedFacts: translation.translatedFacts.map(({ sourceText, translatedText }) => ({ sourceText, translatedText })),
    preservedNames: translation.preservedNames,
  };
}

export function toClassifierEditorialInput(editorial: Pick<EditorialDraft, "headlineEs" | "summaryEs" | "keyPoints">): ClassifierInput["editorial"] {
  return {
    headlineEs: editorial.headlineEs,
    summaryEs: editorial.summaryEs,
    keyPoints: editorial.keyPoints,
  };
}

export function buildClassifierInput(input: {
  event: ClassifierInput["event"];
  verification: VerificationResult;
  translation: ClassifierTranslationProjection;
  editorial: Pick<EditorialDraft, "headlineEs" | "summaryEs" | "keyPoints">;
  sources: ClassifierInput["sources"];
}): ClassifierInput {
  return classifierInputSchema.parse({
    schemaVersion: 1,
    event: input.event,
    verification: toClassifierVerificationInput(input.verification),
    translation: toClassifierTranslationInput(input.translation),
    editorial: toClassifierEditorialInput(input.editorial),
    sources: input.sources,
  });
}

export function buildClassifierModelInput(input: ClassifierInput, reference: { regionCodes: string[]; categorySlugs: string[] }): { input: ClassifierModelInput; inputChars: number } {
  const modelInput: ClassifierModelInput = {
    schemaVersion: 1,
    event: input.event,
    verification: input.verification,
    translation: input.translation,
    editorial: input.editorial,
    sources: input.sources,
    allowedRegionCodes: [...reference.regionCodes],
    allowedCategorySlugs: [...reference.categorySlugs],
  };
  return { input: modelInput, inputChars: JSON.stringify(modelInput).length };
}
