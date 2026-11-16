import { errorSummary } from "../lib/agents/runtime/agent-errors.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createConfiguredClassifier, getClassifierModelConfig } from "../lib/agents/classifier/classifier-agent.ts";
import { readSafeEditorPipelineCheckpoint } from "../lib/agents/classifier/classifier-checkpoint.ts";
import { readSafeClassifierPipelineCheckpoint, writeClassifierPipelineCheckpointAtomic } from "../lib/agents/classifier/classifier-pipeline-checkpoint.ts";
import { loadActiveReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";

async function main(): Promise<void> {
  const checkpoint = await readSafeEditorPipelineCheckpoint();
  const input = {
    schemaVersion: 1 as const,
    event: { eventKey: checkpoint.eventKey, canonicalTitle: checkpoint.canonicalTitle },
    verification: { status: checkpoint.verification.status, confidenceScore: checkpoint.verification.confidenceScore, verifiedFacts: checkpoint.verification.verifiedFacts, uncertainClaims: checkpoint.verification.uncertainClaims, contradictions: checkpoint.verification.contradictions },
    translation: { translatedTitle: checkpoint.translation.translatedTitle, translatedFacts: checkpoint.translation.translatedFacts.map(({ sourceText, translatedText }) => ({ sourceText, translatedText })), preservedNames: checkpoint.translation.preservedNames },
    editorial: { headlineEs: checkpoint.editorial.headlineEs, summaryEs: checkpoint.editorial.summaryEs, keyPoints: checkpoint.editorial.keyPoints },
    sources: checkpoint.sources.map(({ sourceName, sourceType, countryCode }) => ({ sourceName, sourceType, countryCode })),
  };
  const result = await createConfiguredClassifier(new SupabaseAgentLogger()).classify(input, { dryRun: true, modelConfig: { ...getClassifierModelConfig(), maxRetries: 0 }, registry: await loadActiveReferenceRegistry() });
  const classifierCheckpointPath = await writeClassifierPipelineCheckpointAtomic({
    schemaVersion: 1,
    eventKey: checkpoint.eventKey,
    canonicalTitle: checkpoint.canonicalTitle,
    event: { eventKey: checkpoint.eventKey, canonicalTitle: checkpoint.canonicalTitle, sourceCount: checkpoint.sources.length, occurredAt: null, latestPublishedAt: null },
    verification: checkpoint.verification,
    translation: { schemaVersion: checkpoint.translation.schemaVersion, eventKey: checkpoint.translation.eventKey, sourceLanguage: checkpoint.translation.sourceLanguage, targetLanguage: checkpoint.translation.targetLanguage, translatedTitle: checkpoint.translation.translatedTitle, translatedFacts: checkpoint.translation.translatedFacts, preservedNames: checkpoint.translation.preservedNames, translationNotes: checkpoint.translation.translationNotes },
    editorial: { schemaVersion: checkpoint.editorial.schemaVersion, eventKey: checkpoint.editorial.eventKey, headlineEs: checkpoint.editorial.headlineEs, summaryEs: checkpoint.editorial.summaryEs, whyItMattersEs: checkpoint.editorial.whyItMattersEs, keyPoints: checkpoint.editorial.keyPoints },
    classification: result.output,
    sources: checkpoint.sources,
    createdAt: new Date().toISOString(),
  });
  const classifierCheckpoint = await readSafeClassifierPipelineCheckpoint(classifierCheckpointPath.path);
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/classifier-report.json", `${JSON.stringify({ status: "success", eventKey: result.output.eventKey, agentVersion: result.agentVersion, model: result.model, primaryRegionCode: result.output.primaryRegionCode, countryCodes: result.output.countryCodes, categorySlugs: result.output.categorySlugs, entities: { companies: result.output.companies, models: result.output.models, people: result.output.people, technologies: result.output.technologies }, geo: result.geo, telemetry: result.telemetry, attempts: result.attempts, retries: Math.max(0, result.attempts - 1), checkpoint: { path: classifierCheckpointPath.path, valid: classifierCheckpoint.eventKey === result.output.eventKey } }, null, 2)}\n`, "utf8");
  console.log(`Classifier replay succeeded: ${result.output.primaryRegionCode ?? "unresolved"} | attempts=${result.attempts} | checkpoint=${classifierCheckpointPath.path}`);
}

main().catch((error: unknown) => {
  const summary = errorSummary(error);
  console.error(`Classifier replay failed closed: ${summary.code} — ${summary.message}`);
  process.exitCode = 1;
});
