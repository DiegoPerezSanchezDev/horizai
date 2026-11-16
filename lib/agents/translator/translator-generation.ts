import { z } from "zod";
import { StructuredOutputError, getProviderDiagnostics } from "../runtime/agent-errors.ts";
import { parseStructuredOutput } from "../runtime/structured-output.ts";
import type { ProviderDiagnostics } from "../runtime/runtime-types.ts";
import { translationResultSchema, type TranslationResult } from "../contracts/index.ts";
import type { TranslatorInput } from "./translator-types.ts";

const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);

const factTranslationSchema = z.object({
  factIndex: z.number().int().nonnegative().max(99),
  translatedText: nonEmptyText(2_000),
}).strict();

/**
 * Provider-owned output. Deterministic identifiers and source text are
 * deliberately excluded and are restored from the validated TranslatorInput.
 */
export const translatorGenerationSchema = z.object({
  translatedTitle: nonEmptyText(500),
  factTranslations: z.array(factTranslationSchema).min(1).max(100).refine(
    (items) => new Set(items.map((item) => item.factIndex)).size === items.length,
    "factIndex values must be unique"
  ),
  translatedSourceMaterial: nonEmptyText(120_000),
  preservedNames: z.array(nonEmptyText(200)).max(100).refine(
    (items) => new Set(items).size === items.length,
    "preservedNames values must be unique"
  ),
  translationNotes: z.array(nonEmptyText(500)).max(30).refine(
    (items) => new Set(items).size === items.length,
    "translationNotes values must be unique"
  ),
}).strict();

export type TranslatorGeneration = z.infer<typeof translatorGenerationSchema>;

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assemblyError(message: string, diagnostics: ProviderDiagnostics): never {
  throw new StructuredOutputError([message], {
    ...diagnostics,
    generationSchemaValid: true,
    finalTranslationResultValid: false,
    translationAssemblySuccess: false,
  });
}

function sourceItemIdForClaim(input: TranslatorInput, sourceIds: string[]): string | null {
  for (const sourceId of sourceIds) {
    const source = input.sources.find((candidate) => candidate.sourceId === sourceId);
    if (source) return source.sourceItemId;
  }
  return null;
}

/**
 * Rebuilds the public TranslationResult from trusted input plus the minimal
 * provider generation. No provider output can change the source claim or IDs.
 */
export function assembleTranslationResult(
  input: TranslatorInput,
  generation: TranslatorGeneration,
  providerDiagnostics?: ProviderDiagnostics
): { output: TranslationResult; diagnostics: ProviderDiagnostics } {
  const expectedFacts = input.verification.verifiedFacts;
  const diagnostics: ProviderDiagnostics = {
    ...providerDiagnostics,
    generationSchemaValid: true,
    finalTranslationResultValid: false,
    translationAssemblySuccess: false,
    generationOutputBytes: byteLength(JSON.stringify(generation)),
    factCountExpected: input.verification.verifiedFacts.length,
    factCountTranslated: generation.factTranslations.length,
    factCountGenerated: generation.factTranslations.length,
    expectedFactIndices: expectedFacts.map((_, index) => index),
    receivedFactIndices: generation.factTranslations.map((translation) => translation.factIndex),
    translatedSourceMaterialChars: generation.translatedSourceMaterial.length,
  };
  if (generation.factTranslations.length !== expectedFacts.length) {
    assemblyError("Translator generation must cover every verified fact exactly once", diagnostics);
  }

  const translatedFacts = generation.factTranslations
    .slice()
    .sort((left, right) => left.factIndex - right.factIndex)
    .map((translation, position) => {
      if (translation.factIndex !== position || !expectedFacts[translation.factIndex]) {
        assemblyError("Translator generation contains an invalid or missing factIndex", diagnostics);
      }
      const fact = expectedFacts[translation.factIndex];
      return {
        sourceText: fact.claim,
        translatedText: translation.translatedText,
        sourceItemId: sourceItemIdForClaim(input, fact.sourceIds),
      };
    });

  const candidate = {
    schemaVersion: 1 as const,
    eventKey: input.event.eventKey,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: "es" as const,
    translatedTitle: generation.translatedTitle,
    translatedFacts,
    translatedSourceMaterial: generation.translatedSourceMaterial,
    preservedNames: generation.preservedNames,
    translationNotes: generation.translationNotes,
  };
  try {
    const output = parseStructuredOutput(translationResultSchema, candidate, diagnostics);
    return {
      output,
      diagnostics: {
        ...diagnostics,
        finalTranslationResultValid: true,
        translationAssemblySuccess: true,
      },
    };
  } catch (error) {
    const finalDiagnostics = getProviderDiagnostics(error) ?? diagnostics;
    throw new StructuredOutputError(["Deterministic TranslationResult assembly failed"], {
      ...finalDiagnostics,
      generationSchemaValid: true,
      finalTranslationResultValid: false,
      translationAssemblySuccess: false,
    });
  }
}
