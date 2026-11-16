import { editorInputSchema, type EditorInput } from "../editor/editor-types.ts";
import { validateEditorialDraftOutput } from "../editor/editor-output-guard.ts";
import { PublisherError } from "./publisher-errors.ts";
import type { PublisherInput } from "./publisher-types.ts";
import { assertPublisherLatestRevision } from "../pipeline/revision-orchestration.ts";

export function assertPublisherLineage(input: PublisherInput): void {
  const values = [
    input.lineage.eventKey,
    input.lineage.verificationEventKey,
    input.lineage.translationEventKey,
    input.lineage.editorialEventKey,
    input.lineage.classificationEventKey,
    input.lineage.rankingEventKey,
    input.lineage.criticEventKey,
    input.payload.eventKey,
    input.payload.verification.eventKey,
    input.payload.critic.eventKey,
  ];
  if (values.some((value) => value !== input.payload.eventKey)) throw new PublisherError("publication_lineage_mismatch", "Publication stages do not share the same eventKey");
  if (input.revisionLineage) {
    if (input.revisionLineage.eventKey !== input.payload.eventKey) throw new PublisherError("publication_lineage_mismatch", "Publisher revision lineage does not match the payload eventKey");
    try {
      assertPublisherLatestRevision(input.revisionLineage.revisionAttempt, Object.entries(input.revisionLineage.checkpointRevisionAttempts).map(([stage, revisionAttempt]) => ({ eventKey: input.payload.eventKey, revisionId: input.revisionLineage!.revisionId, revisionAttempt, stage: stage as "verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic" })));
    } catch (error) {
      throw new PublisherError("publication_lineage_mismatch", error instanceof Error ? error.message : "Publisher revision lineage is stale");
    }
  }
}

export function validatePublisherInputs(input: PublisherInput): void {
  assertPublisherLineage(input);
  if (input.payload.critic.decision !== "pass") throw new PublisherError("publication_not_approved", "Only CriticResult.decision=pass can be published");
  if (!input.validationContext) throw new PublisherError("publication_missing_validation_context", "Publisher requires the validated TranslationResult and source metadata");
  const editorInput: EditorInput = editorInputSchema.parse({
    schemaVersion: 1,
    event: { eventKey: input.payload.eventKey, canonicalTitle: input.payload.event.canonicalTitle },
    verification: {
      status: input.payload.verification.status,
      confidenceScore: input.payload.verification.confidenceScore,
      verifiedFacts: input.payload.verification.verifiedFacts,
      uncertainClaims: input.payload.verification.uncertainClaims,
      contradictions: input.payload.verification.contradictions,
    },
    translation: {
      translatedTitle: input.validationContext.translation.translatedTitle,
      translatedFacts: input.validationContext.translation.translatedFacts,
      translatedSourceMaterial: input.validationContext.translation.translatedSourceMaterial,
      preservedNames: input.validationContext.translation.preservedNames,
      translationNotes: input.validationContext.translation.translationNotes,
    },
    sources: input.validationContext.editorSources,
  });
  validateEditorialDraftOutput(editorInput, {
    schemaVersion: 1,
    eventKey: input.payload.eventKey,
    headlineEs: input.payload.article.headlineEs,
    dekEs: input.payload.article.dekEs,
    summaryEs: input.payload.article.summaryEs,
    whyItMattersEs: input.payload.article.whyItMattersEs,
    bodyEs: input.payload.article.bodyEs,
    keyPoints: input.payload.article.keyPoints,
    suggestedSlug: input.payload.article.slug,
  });
}
