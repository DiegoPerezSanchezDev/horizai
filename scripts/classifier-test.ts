import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentError, errorSummary, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import type { VerifierInput } from "../lib/agents/verifier/verifier-types.ts";
import { VerifierAgent, getVerifierModelConfig } from "../lib/agents/verifier/verifier-agent.ts";
import type { TranslatorInput } from "../lib/agents/translator/translator-types.ts";
import { TranslatorAgent, getTranslatorModelConfig } from "../lib/agents/translator/translator-agent.ts";
import { buildTranslatorModelInput } from "../lib/agents/translator/translator-input.ts";
import { readSafeTranslatorCheckpoint, writeTranslatorCheckpointAtomic } from "../lib/agents/translator/translator-checkpoint.ts";
import type { EditorInput } from "../lib/agents/editor/editor-types.ts";
import { EditorAgent, getEditorModelConfig } from "../lib/agents/editor/editor-agent.ts";
import { clusterExtractedItems } from "../lib/agents/clustering/cluster-runner.ts";
import { runExtraction } from "../lib/agents/extraction/extraction-runner.ts";
import { parseVerifierCliOptions } from "../lib/agents/verifier/verifier-cli-options.ts";
import { ClassifierAgent, getClassifierModelConfig } from "../lib/agents/classifier/classifier-agent.ts";
import { loadActiveReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { writeEditorPipelineCheckpointAtomic, readSafeEditorPipelineCheckpoint } from "../lib/agents/classifier/classifier-checkpoint.ts";
import { writeClassifierPipelineCheckpointAtomic, readSafeClassifierPipelineCheckpoint } from "../lib/agents/classifier/classifier-pipeline-checkpoint.ts";
import { readSafeTranslatorEditorCheckpoint, writeTranslatorEditorCheckpointAtomic } from "../lib/agents/editor/translator-editor-checkpoint.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function required(names: string[]): void {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
}
function valueOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

function verifierInput(event: VerifierInput["event"], items: VerifierInput["items"]): VerifierInput {
  return { event, items, sources: event.sourceItems.map((source) => {
    const item = items.find((candidate) => candidate.candidateId === source.candidateId);
    return { sourceId: source.sourceId, sourceName: source.sourceName, sourceUrl: source.url, sourceType: valueOrNull(item?.metadata.sourceType), countryCode: valueOrNull(item?.metadata.sourceCountryCode), language: item?.language ?? null };
  }) };
}
function translatorInput(event: VerifierInput["event"], items: VerifierInput["items"], verification: VerifierInput["event"] extends never ? never : Parameters<TranslatorAgent["translate"]>[0]["verification"]): TranslatorInput {
  const sources = event.sourceItems.map((source) => {
    const item = items.find((candidate) => candidate.candidateId === source.candidateId);
    if (!item) throw new Error(`Missing extracted item for ${source.candidateId}`);
    return { sourceId: source.sourceId, sourceName: source.sourceName, sourceItemId: item.candidateId, language: item.language, sourceType: valueOrNull(item.metadata.sourceType), countryCode: valueOrNull(item.metadata.sourceCountryCode) };
  });
  if (!sources[0]?.language) throw new Error("No source language available");
  return { schemaVersion: 1, event, verification, sourceLanguage: sources[0].language, sources };
}
function editorInput(event: VerifierInput["event"], items: VerifierInput["items"], verification: TranslatorInput["verification"], translation: Awaited<ReturnType<TranslatorAgent["translate"]>>["output"]): EditorInput {
  return {
    schemaVersion: 1,
    event: { eventKey: event.eventKey, canonicalTitle: event.canonicalTitle },
    verification: { status: verification.status, confidenceScore: verification.confidenceScore, verifiedFacts: verification.verifiedFacts, uncertainClaims: verification.uncertainClaims, contradictions: verification.contradictions },
    translation: { translatedTitle: translation.translatedTitle, translatedFacts: translation.translatedFacts, translatedSourceMaterial: translation.translatedSourceMaterial, preservedNames: translation.preservedNames, translationNotes: translation.translationNotes },
    sources: event.sourceItems.map((source) => {
      const item = items.find((candidate) => candidate.candidateId === source.candidateId);
      if (!item) throw new Error(`Missing extracted item for ${source.candidateId}`);
      return { sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: item.canonicalUrl, sourceType: valueOrNull(item.metadata.sourceType) };
    }),
  };
}

async function main(): Promise<void> {
  required(["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_VERIFY", "AGENT_MODEL_TRANSLATE", "AGENT_MODEL_EDITOR", "AGENT_MODEL_CLASSIFY"]);
  const { hours, limit } = parseVerifierCliOptions(process.argv);
  const configs = [getVerifierModelConfig(), getTranslatorModelConfig(), getEditorModelConfig(), getClassifierModelConfig()].map((config) => ({ ...config, maxRetries: 0 }));
  const logger = new SupabaseAgentLogger();
  const availability = await logger.getRemainingRequests(configs[0].dailyRequestLimit, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 4) throw new AgentError("DAILY_REQUEST_LIMIT_REACHED", "Classifier pipeline requires four reserved requests");
  const extraction = await runExtraction({ hours, limit, persist: false });
  const items = extraction.results.flatMap((result) => result.item ? [result.item] : []);
  const clustered = clusterExtractedItems(items);
  const event = clustered.events.slice(0, limit)[0];
  if (!event) throw new Error("No eligible event found");
  const eventItems = event.sourceItems.flatMap((source) => items.filter((item) => item.candidateId === source.candidateId));
  const provider = createConfiguredModelProvider();
  const verifierResult = await new VerifierAgent(provider, logger).verify(verifierInput(event, eventItems), { modelConfig: configs[0], dryRun: true });
  if (verifierResult.output.status === "rejected") throw new AgentError("provider_permanent", "Rejected event cannot advance");
  const tInput = translatorInput(event, eventItems, verifierResult.output);
  const translatorModelInput = buildTranslatorModelInput(tInput);
  const verifierCheckpointPath = await writeTranslatorCheckpointAtomic({
    schemaVersion: 1,
    eventKey: event.eventKey,
    event,
    verification: verifierResult.output,
    sourceLanguage: tInput.sourceLanguage,
    sources: tInput.sources,
    translatorModelInput: translatorModelInput.input,
  });
  const verifierCheckpoint = await readSafeTranslatorCheckpoint(verifierCheckpointPath.path);
  if (
    verifierCheckpoint.eventKey !== event.eventKey
    || verifierCheckpoint.verification.eventKey !== verifierResult.output.eventKey
    || verifierCheckpoint.verification.verifiedFacts.length !== verifierResult.output.verifiedFacts.length
  ) {
    throw new AgentError("cost_guard_violation", "Verifier checkpoint mismatch before Translator");
  }
  console.log(`Verifier checkpoint: written and verified | ${verifierCheckpointPath.bytes} bytes | ${verifierCheckpoint.verification.verifiedFacts.length} verified fact(s)`);
  const translatorResult = await new TranslatorAgent(provider, logger).translate(tInput, { modelConfig: configs[1], dryRun: true });
  const translatorEditorCheckpointPath = await writeTranslatorEditorCheckpointAtomic({
    schemaVersion: 1,
    eventKey: event.eventKey,
    canonicalTitle: event.canonicalTitle,
    event,
    verification: verifierResult.output,
    translation: translatorResult.output,
    sources: event.sourceItems.map((source) => {
      const item = eventItems.find((candidate) => candidate.candidateId === source.candidateId);
      if (!item) throw new Error(`Missing extracted item for ${source.candidateId}`);
      return { sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: item.canonicalUrl, sourceType: valueOrNull(item.metadata.sourceType) };
    }),
  });
  const translatorEditorCheckpoint = await readSafeTranslatorEditorCheckpoint(translatorEditorCheckpointPath.path);
  if (translatorEditorCheckpoint.eventKey !== event.eventKey) throw new Error("Translator-to-editor checkpoint mismatch");
  const eInput = editorInput(event, eventItems, verifierResult.output, translatorResult.output);
  const editorResult = await new EditorAgent(provider, logger).edit(eInput, { modelConfig: configs[2], dryRun: true });
  await writeEditorPipelineCheckpointAtomic({ schemaVersion: 1, eventKey: event.eventKey, canonicalTitle: event.canonicalTitle, verification: verifierResult.output, translation: translatorResult.output, editorial: editorResult.output, sources: tInput.sources });
  const checkpoint = await readSafeEditorPipelineCheckpoint();
  if (checkpoint.eventKey !== event.eventKey) throw new Error("Editor checkpoint mismatch");
  const classifierInput = {
    schemaVersion: 1 as const,
    event: { eventKey: checkpoint.eventKey, canonicalTitle: event.canonicalTitle },
    verification: { status: checkpoint.verification.status, confidenceScore: checkpoint.verification.confidenceScore, verifiedFacts: checkpoint.verification.verifiedFacts, uncertainClaims: checkpoint.verification.uncertainClaims, contradictions: checkpoint.verification.contradictions },
    translation: { translatedTitle: checkpoint.translation.translatedTitle, translatedFacts: checkpoint.translation.translatedFacts.map(({ sourceText, translatedText }) => ({ sourceText, translatedText })), preservedNames: checkpoint.translation.preservedNames },
    editorial: { headlineEs: checkpoint.editorial.headlineEs, summaryEs: checkpoint.editorial.summaryEs, keyPoints: checkpoint.editorial.keyPoints },
    sources: checkpoint.sources.map(({ sourceName, sourceType, countryCode }) => ({ sourceName, sourceType, countryCode })),
  };
  const classifierResult = await new ClassifierAgent(provider, logger).classify(classifierInput, { modelConfig: configs[3], dryRun: true, registry: await loadActiveReferenceRegistry() });
  const publishedDates = event.sourceItems.flatMap((item) => item.publishedAt ? [Date.parse(item.publishedAt)] : []);
  const classifierCheckpointPath = await writeClassifierPipelineCheckpointAtomic({
    schemaVersion: 1,
    eventKey: event.eventKey,
    canonicalTitle: event.canonicalTitle,
    event: { eventKey: event.eventKey, canonicalTitle: event.canonicalTitle, sourceCount: event.sourceItems.length, occurredAt: event.probableOccurredAt, latestPublishedAt: publishedDates.length > 0 ? new Date(Math.max(...publishedDates)).toISOString() : null },
    verification: verifierResult.output,
    translation: { schemaVersion: translatorResult.output.schemaVersion, eventKey: translatorResult.output.eventKey, sourceLanguage: translatorResult.output.sourceLanguage, targetLanguage: translatorResult.output.targetLanguage, translatedTitle: translatorResult.output.translatedTitle, translatedFacts: translatorResult.output.translatedFacts, preservedNames: translatorResult.output.preservedNames, translationNotes: translatorResult.output.translationNotes },
    editorial: { schemaVersion: editorResult.output.schemaVersion, eventKey: editorResult.output.eventKey, headlineEs: editorResult.output.headlineEs, summaryEs: editorResult.output.summaryEs, whyItMattersEs: editorResult.output.whyItMattersEs, keyPoints: editorResult.output.keyPoints },
    classification: classifierResult.output,
    sources: tInput.sources,
    createdAt: new Date().toISOString(),
  });
  const classifierCheckpoint = await readSafeClassifierPipelineCheckpoint(classifierCheckpointPath.path);
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/classifier-report.json", `${JSON.stringify({ generatedAt: new Date().toISOString(), dryRun: true, eventKey: classifierResult.output.eventKey, classifier: { agentVersion: classifierResult.agentVersion, model: classifierResult.model, primaryRegionCode: classifierResult.output.primaryRegionCode, countryCodes: classifierResult.output.countryCodes, categorySlugs: classifierResult.output.categorySlugs, entities: { companies: classifierResult.output.companies, models: classifierResult.output.models, people: classifierResult.output.people, technologies: classifierResult.output.technologies }, geo: classifierResult.geo, telemetry: classifierResult.telemetry }, checkpoint: { path: classifierCheckpointPath.path, valid: classifierCheckpoint.eventKey === classifierResult.output.eventKey } }, null, 2)}\n`, "utf8");
  console.log(`Classifier pipeline success: ${classifierResult.output.primaryRegionCode ?? "unresolved"}`);
}

main().catch((error: unknown) => {
  const summary = errorSummary(error);
  if (summary.code === "translator_precondition_failed") {
    console.log("Classifier pipeline status: SKIPPED_VERIFICATION_INSUFFICIENT");
    process.exitCode = 2;
    return;
  }
  console.error(`Classifier pipeline failed closed: ${summary.code} — ${summary.message}`);
  process.exitCode = 1;
});
