import nextEnv from "@next/env";
import { errorSummary, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createConfiguredEditor, getEditorModelConfig } from "../lib/agents/editor/editor-agent.ts";
import { readSafeTranslatorEditorCheckpoint } from "../lib/agents/editor/translator-editor-checkpoint.ts";
import { writeEditorPipelineCheckpointAtomic, readSafeEditorPipelineCheckpoint } from "../lib/agents/classifier/classifier-checkpoint.ts";
import type { EditorInput } from "../lib/agents/editor/editor-types.ts";

nextEnv.loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const missing = ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_EDITOR"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const checkpoint = await readSafeTranslatorEditorCheckpoint();
  const input: EditorInput = {
    schemaVersion: 1,
    event: { eventKey: checkpoint.eventKey, canonicalTitle: checkpoint.canonicalTitle },
    verification: { status: checkpoint.verification.status, confidenceScore: checkpoint.verification.confidenceScore, verifiedFacts: checkpoint.verification.verifiedFacts, uncertainClaims: checkpoint.verification.uncertainClaims, contradictions: checkpoint.verification.contradictions },
    translation: { translatedTitle: checkpoint.translation.translatedTitle, translatedFacts: checkpoint.translation.translatedFacts, translatedSourceMaterial: checkpoint.translation.translatedSourceMaterial, preservedNames: checkpoint.translation.preservedNames, translationNotes: checkpoint.translation.translationNotes },
    sources: checkpoint.sources,
  };
  const logger = new SupabaseAgentLogger();
  const result = await createConfiguredEditor(logger).edit(input, { dryRun: true, modelConfig: { ...getEditorModelConfig(), maxRetries: 0 } });
  const classifierSources = checkpoint.sources.map((source) => {
    const sourceItem = checkpoint.event.sourceItems.find((item) => item.sourceId === source.sourceId);
    const translatedFact = checkpoint.translation.translatedFacts.find((fact) => fact.sourceItemId === sourceItem?.candidateId);
    const sourceItemId = sourceItem?.candidateId ?? translatedFact?.sourceItemId;
    if (!sourceItemId) throw new Error(`Missing source item metadata for ${source.sourceId}`);
    return {
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      sourceItemId,
      language: checkpoint.translation.sourceLanguage,
      sourceType: source.sourceType,
      countryCode: checkpoint.event.probableCountryCode,
    };
  });
  const editorCheckpointPath = await writeEditorPipelineCheckpointAtomic({
    schemaVersion: 1,
    eventKey: checkpoint.eventKey,
    canonicalTitle: checkpoint.canonicalTitle,
    verification: checkpoint.verification,
    translation: checkpoint.translation,
    editorial: result.output,
    sources: classifierSources,
  });
  const editorCheckpoint = await readSafeEditorPipelineCheckpoint(editorCheckpointPath.path);
  if (editorCheckpoint.eventKey !== checkpoint.eventKey || editorCheckpoint.editorial.eventKey !== checkpoint.eventKey) {
    throw new Error("Editor pipeline checkpoint mismatch");
  }
  const telemetry = result.telemetry;
  const diagnostics = result.diagnostics;
  console.log(JSON.stringify({
    status: "SUCCESS",
    httpStatus: telemetry?.providerHttpStatus ?? diagnostics?.httpStatus ?? null,
    editorGenerationZodValid: diagnostics?.generationSchemaValid ?? null,
    editorialAssemblySuccess: diagnostics?.editorialAssemblySuccess ?? null,
    editorialDraftZodValid: diagnostics?.finalEditorialDraftValid ?? telemetry?.zodValid ?? null,
    editorialGuard: "PASS",
    numericGuard: "PASS",
    preservedNameGuard: "PASS",
    preservedNamesCount: diagnostics?.preservedNamesCount ?? null,
    preservedNamesObservedCount: diagnostics?.preservedNamesObservedCount ?? null,
    omittedPreservedNames: diagnostics?.omittedPreservedNames ?? [],
    mutatedPreservedNames: diagnostics?.mutatedPreservedNames ?? [],
    suggestedSlugDeterministic: true,
    suggestedSlugGeneratedByLlm: false,
    finishReason: telemetry?.finishReason ?? diagnostics?.finishReason ?? null,
    attempts: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    usage: telemetry ? { inputTokens: telemetry.inputTokens, outputTokens: telemetry.outputTokens, totalTokens: telemetry.totalTokens } : null,
    latencyMs: result.latencyMs,
    checkpoint: { path: editorCheckpointPath.path, valid: true },
  }, null, 2));
  console.log(JSON.stringify({
    headlineEs: result.output.headlineEs,
    dekEs: result.output.dekEs,
    whyItMattersEs: result.output.whyItMattersEs,
    keyPoints: result.output.keyPoints,
    bodyPreview: result.output.bodyEs.slice(0, 500),
  }, null, 2));
}

main().catch((error: unknown) => { const summary = errorSummary(error); console.error(`Editor replay failed closed: ${summary.code} — ${summary.message}`); process.exitCode = 1; });
