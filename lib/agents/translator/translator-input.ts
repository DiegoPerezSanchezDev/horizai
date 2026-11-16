import { translatorModelInputSchema, type TranslatorInput, type TranslatorModelInput } from "./translator-types.ts";

export function buildTranslatorModelInput(input: TranslatorInput): { input: TranslatorModelInput; inputChars: number } {
  const modelInput = translatorModelInputSchema.parse({
    schemaVersion: 1,
    eventKey: input.event.eventKey,
    canonicalTitle: input.event.canonicalTitle,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: "es",
    sources: input.sources.map(({ sourceId, sourceName, sourceItemId, language }) => ({ sourceId, sourceName, sourceItemId, language })),
    verifiedFacts: input.verification.verifiedFacts,
    uncertainClaims: input.verification.uncertainClaims,
    contradictions: input.verification.contradictions,
  });
  return { input: modelInput, inputChars: JSON.stringify(modelInput).length };
}
