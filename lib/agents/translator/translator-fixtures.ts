import type { TranslationResult } from "../contracts/index.ts";
import type { TranslatorGeneration } from "./translator-generation.ts";

/** Small, provider-independent reference output for TranslationResult. */
export const canonicalTranslationResultFixture: TranslationResult = {
  schemaVersion: 1,
  eventKey: "fixture-event",
  sourceLanguage: "en",
  targetLanguage: "es",
  translatedTitle: "Anuncio de modelo de IA",
  translatedFacts: [{
    sourceText: "The model supports a 128K-token context window.",
    translatedText: "El modelo admite una ventana de contexto de 128K tokens.",
    sourceItemId: "fixture-item",
  }],
  translatedSourceMaterial: "El modelo admite una ventana de contexto de 128K tokens.",
  preservedNames: ["FixtureModel"],
  translationNotes: [],
};

export const translatorOutputShapeExample = JSON.stringify(canonicalTranslationResultFixture);

/** Small provider-facing fixture; deterministic TranslationResult fields are absent. */
export const canonicalTranslatorGenerationFixture: TranslatorGeneration = {
  translatedTitle: "Anuncio de modelo de IA",
  factTranslations: [{
    factIndex: 0,
    translatedText: "El modelo admite una ventana de contexto de 128K tokens.",
  }],
  translatedSourceMaterial: "El modelo admite una ventana de contexto de 128K tokens.",
  preservedNames: ["FixtureModel"],
  translationNotes: [],
};

export const translatorGenerationShapeExample = JSON.stringify(canonicalTranslatorGenerationFixture);
