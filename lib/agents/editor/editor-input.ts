import type { TranslationResult, VerificationResult } from "../contracts/index.ts";
import { editorInputSchema, editorModelInputSchema, type EditorInput, type EditorModelInput } from "./editor-types.ts";

export const editorTranslationInputKeys = [
  "translatedTitle",
  "translatedFacts",
  "translatedSourceMaterial",
  "preservedNames",
  "translationNotes",
] as const;

export type EditorTranslationInput = Pick<TranslationResult, (typeof editorTranslationInputKeys)[number]>;
export type EditorVerificationInput = EditorInput["verification"];

export type EditorInputProjection = {
  event: EditorInput["event"];
  verification: VerificationResult;
  translation: TranslationResult;
  sources: EditorInput["sources"];
};

export function toEditorTranslationInput(translation: TranslationResult): EditorTranslationInput {
  return {
    translatedTitle: translation.translatedTitle,
    translatedFacts: translation.translatedFacts,
    translatedSourceMaterial: translation.translatedSourceMaterial,
    preservedNames: translation.preservedNames,
    translationNotes: translation.translationNotes,
  };
}

export function toEditorVerificationInput(verification: VerificationResult): EditorVerificationInput {
  return {
    status: verification.status,
    confidenceScore: verification.confidenceScore,
    verifiedFacts: verification.verifiedFacts,
    uncertainClaims: verification.uncertainClaims,
    contradictions: verification.contradictions,
  };
}

export function buildEditorInput(projection: EditorInputProjection): EditorInput {
  return editorInputSchema.parse({
    schemaVersion: 1,
    event: projection.event,
    verification: toEditorVerificationInput(projection.verification),
    translation: toEditorTranslationInput(projection.translation),
    sources: projection.sources,
  });
}

export type BuiltEditorInput = {
  input: EditorModelInput;
  inputChars: number;
};

export function buildEditorModelInput(input: EditorInput): BuiltEditorInput {
  const validated = editorInputSchema.parse(input);
  const modelInput = editorModelInputSchema.parse({
    schemaVersion: 1,
    event: validated.event,
    verification: validated.verification,
    translation: validated.translation,
    sources: validated.sources,
  });
  return { input: modelInput, inputChars: JSON.stringify(modelInput).length };
}
