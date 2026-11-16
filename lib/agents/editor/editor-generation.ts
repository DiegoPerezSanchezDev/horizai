import { z } from "zod";
import { editorialDraftSchema, type EditorialDraft } from "../contracts/index.ts";
import { getProviderDiagnostics, StructuredOutputError } from "../runtime/agent-errors.ts";
import { parseStructuredOutput } from "../runtime/structured-output.ts";
import type { ProviderDiagnostics } from "../runtime/runtime-types.ts";
import type { EditorInput } from "./editor-types.ts";
import { slugifyEditorHeadline } from "./editor-slug.ts";

export const editorGenerationSchema = z.object({
  headlineEs: editorialDraftSchema.shape.headlineEs,
  dekEs: editorialDraftSchema.shape.dekEs,
  summaryEs: editorialDraftSchema.shape.summaryEs,
  whyItMattersEs: editorialDraftSchema.shape.whyItMattersEs,
  bodyEs: editorialDraftSchema.shape.bodyEs,
  keyPoints: editorialDraftSchema.shape.keyPoints,
}).strict();

export type EditorGeneration = z.infer<typeof editorGenerationSchema>;

export function assembleEditorDraft(input: EditorInput, generation: EditorGeneration, diagnostics?: ProviderDiagnostics): { output: EditorialDraft; diagnostics: ProviderDiagnostics } {
  const assemblyDiagnostics: ProviderDiagnostics = { ...diagnostics, generationSchemaValid: true, editorialAssemblySuccess: false, finalEditorialDraftValid: false };
  try {
    const output = parseStructuredOutput(editorialDraftSchema, {
      schemaVersion: 1,
      eventKey: input.event.eventKey,
      ...generation,
      suggestedSlug: slugifyEditorHeadline(generation.headlineEs),
    }, assemblyDiagnostics);
    return { output, diagnostics: { ...assemblyDiagnostics, editorialAssemblySuccess: true, finalEditorialDraftValid: true, validationResult: "valid", failureKind: "SUCCESS" } };
  } catch (error) {
    const details = getProviderDiagnostics(error);
    throw new StructuredOutputError(error instanceof StructuredOutputError ? error.issues : ["Editorial assembly failed"], { ...assemblyDiagnostics, ...details, editorialAssemblySuccess: false, finalEditorialDraftValid: false });
  }
}
