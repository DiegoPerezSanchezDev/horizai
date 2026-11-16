import { publicationPayloadSchema, type PublicationPayload, type TranslationResult, type VerificationResult } from "../contracts/index.ts";
import { editorInputSchema, type EditorInput } from "../editor/editor-types.ts";
import { classifierInputSchema, type ClassifierInput } from "../classifier/classifier-types.ts";
import { rankerInputSchema, type RankerInput } from "../ranker/ranker-types.ts";
import { criticInputSchema, type CriticInput } from "../critic/critic-types.ts";
import type { PublisherInput } from "../publisher/publisher-types.ts";

export function validateEditorInputBoundary(input: EditorInput): EditorInput {
  return editorInputSchema.parse(input);
}

export function validateClassifierInputBoundary(input: ClassifierInput): ClassifierInput {
  return classifierInputSchema.parse(input);
}

export function validateRankerInputBoundary(input: RankerInput): RankerInput {
  return rankerInputSchema.parse(input);
}

export function validateCriticInputBoundary(input: CriticInput): CriticInput {
  return criticInputSchema.parse(input);
}

export function buildPublisherInputBoundary(input: PublisherInput): PublisherInput {
  return {
    payload: publicationPayloadSchema.parse(input.payload),
    lineage: {
      eventKey: input.lineage.eventKey,
      verificationEventKey: input.lineage.verificationEventKey,
      translationEventKey: input.lineage.translationEventKey,
      editorialEventKey: input.lineage.editorialEventKey,
      classificationEventKey: input.lineage.classificationEventKey,
      rankingEventKey: input.lineage.rankingEventKey,
      criticEventKey: input.lineage.criticEventKey,
    },
    validationContext: input.validationContext ? {
      translation: input.validationContext.translation,
      editorSources: input.validationContext.editorSources.map((source) => ({
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        canonicalUrl: source.canonicalUrl,
        sourceType: source.sourceType,
      })),
    } : undefined,
  };
}

export type EditorBoundaryTranslation = EditorInput["translation"];
export type ClassifierBoundaryVerification = ClassifierInput["verification"];
export type BoundarySourceTranslation = TranslationResult;
export type BoundarySourceVerification = VerificationResult;
export type BoundaryPublicationPayload = PublicationPayload;
