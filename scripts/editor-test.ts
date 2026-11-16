import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentError, errorSummary, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { clusterExtractedItems } from "../lib/agents/clustering/cluster-runner.ts";
import { runExtraction } from "../lib/agents/extraction/extraction-runner.ts";
import { EditorAgent, getEditorModelConfig } from "../lib/agents/editor/editor-agent.ts";
import type { EditorInput } from "../lib/agents/editor/editor-types.ts";
import { VerifierAgent, getVerifierModelConfig } from "../lib/agents/verifier/verifier-agent.ts";
import type { VerifierInput } from "../lib/agents/verifier/verifier-types.ts";
import { TranslatorAgent, getTranslatorModelConfig } from "../lib/agents/translator/translator-agent.ts";
import type { TranslatorInput } from "../lib/agents/translator/translator-types.ts";
import { buildTranslatorModelInput } from "../lib/agents/translator/translator-input.ts";
import { readSafeTranslatorCheckpoint, writeTranslatorCheckpointAtomic } from "../lib/agents/translator/translator-checkpoint.ts";
import { parseVerifierCliOptions } from "../lib/agents/verifier/verifier-cli-options.ts";
import { buildEditorReport } from "../lib/agents/editor/editor-report.ts";
import { readSafeTranslatorEditorCheckpoint, writeTranslatorEditorCheckpointAtomic } from "../lib/agents/editor/translator-editor-checkpoint.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function missingConfiguration(): string[] {
  return ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_VERIFY", "AGENT_MODEL_TRANSLATE", "AGENT_MODEL_EDITOR"]
    .filter((name) => !process.env[name]?.trim());
}

function valueOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function makeVerifierInput(event: VerifierInput["event"], items: VerifierInput["items"]): VerifierInput {
  return {
    event,
    items,
    sources: event.sourceItems.map((sourceItem) => {
      const item = items.find((candidate) => candidate.candidateId === sourceItem.candidateId);
      return {
        sourceId: sourceItem.sourceId,
        sourceName: sourceItem.sourceName,
        sourceUrl: sourceItem.url,
        sourceType: valueOrNull(item?.metadata.sourceType),
        countryCode: valueOrNull(item?.metadata.sourceCountryCode),
        language: item?.language ?? null,
      };
    }),
  };
}

function makeTranslatorInput(event: VerifierInput["event"], items: VerifierInput["items"], verification: VerifierInput["event"] extends never ? never : Parameters<TranslatorAgent["translate"]>[0]["verification"]): TranslatorInput {
  const sources = event.sourceItems.map((sourceItem) => {
    const item = items.find((candidate) => candidate.candidateId === sourceItem.candidateId);
    if (!item) throw new Error(`Missing extracted item for ${sourceItem.candidateId}`);
    return {
      sourceId: sourceItem.sourceId,
      sourceName: sourceItem.sourceName,
      sourceItemId: item.candidateId,
      language: item.language,
      sourceType: valueOrNull(item.metadata.sourceType),
      countryCode: valueOrNull(item.metadata.sourceCountryCode),
    };
  });
  const sourceLanguage = sources[0]?.language;
  if (!sourceLanguage) throw new Error("No source language available for translation");
  return { schemaVersion: 1, event, verification, sourceLanguage, sources };
}

function makeEditorInput(event: VerifierInput["event"], items: VerifierInput["items"], verification: TranslatorInput["verification"], translation: Awaited<ReturnType<TranslatorAgent["translate"]>>["output"]): EditorInput {
  return {
    schemaVersion: 1 as const,
    event: { eventKey: event.eventKey, canonicalTitle: event.canonicalTitle },
    verification: {
      status: verification.status,
      confidenceScore: verification.confidenceScore,
      verifiedFacts: verification.verifiedFacts,
      uncertainClaims: verification.uncertainClaims,
      contradictions: verification.contradictions,
    },
    translation: {
      translatedTitle: translation.translatedTitle,
      translatedFacts: translation.translatedFacts,
      translatedSourceMaterial: translation.translatedSourceMaterial,
      preservedNames: translation.preservedNames,
      translationNotes: translation.translationNotes,
    },
    sources: event.sourceItems.map((sourceItem) => {
      const item = items.find((candidate) => candidate.candidateId === sourceItem.candidateId);
      if (!item) throw new Error(`Missing extracted item for ${sourceItem.candidateId}`);
      return {
        sourceId: sourceItem.sourceId,
        sourceName: sourceItem.sourceName,
        canonicalUrl: item.canonicalUrl,
        sourceType: valueOrNull(item.metadata.sourceType),
      };
    }),
  };
}

async function main(): Promise<void> {
  const missing = missingConfiguration();
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const { hours, limit } = parseVerifierCliOptions(process.argv);
  const verifierConfig = { ...getVerifierModelConfig(), maxRetries: 0 };
  const translatorConfig = { ...getTranslatorModelConfig(), maxRetries: 0 };
  const editorConfig = { ...getEditorModelConfig(), maxRetries: 0 };
  if (![verifierConfig.dailyRequestLimit, translatorConfig.dailyRequestLimit, editorConfig.dailyRequestLimit].every((limitValue) => limitValue === verifierConfig.dailyRequestLimit)) {
    throw new AgentError("cost_guard_violation", "All editor pipeline agents must share the same daily request limit");
  }
  const logger = new SupabaseAgentLogger();
  const availability = await logger.getRemainingRequests(verifierConfig.dailyRequestLimit, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 3) throw new AgentError("DAILY_REQUEST_LIMIT_REACHED", `Insufficient daily requests for editor pipeline (${availability.remaining} remaining)`);

  const extraction = await runExtraction({ hours, limit, persist: false });
  const items = extraction.results.flatMap((result) => result.item ? [result.item] : []);
  const clustering = clusterExtractedItems(items);
  const event = clustering.events.slice(0, limit)[0];
  if (!event) throw new Error("No eligible event found for editor test");
  const eventItems = event.sourceItems.flatMap((source) => items.filter((item) => item.candidateId === source.candidateId));
  const provider = createConfiguredModelProvider();
  const verifierResult = await new VerifierAgent(provider, logger).verify(makeVerifierInput(event, eventItems), { modelConfig: verifierConfig, dryRun: true });
  if (verifierResult.output.status === "rejected") throw new AgentError("provider_permanent", "Rejected event cannot advance to translation");
  const translatorInput = makeTranslatorInput(event, eventItems, verifierResult.output);
  const translatorModelInput = buildTranslatorModelInput(translatorInput);
  const checkpoint = {
    schemaVersion: 1 as const,
    eventKey: event.eventKey,
    event,
    verification: verifierResult.output,
    sourceLanguage: translatorInput.sourceLanguage,
    sources: translatorInput.sources,
    translatorModelInput: translatorModelInput.input,
  };
  const checkpointWrite = await writeTranslatorCheckpointAtomic(checkpoint);
  const checkpointRead = await readSafeTranslatorCheckpoint(checkpointWrite.path);
  if (
    checkpointRead.eventKey !== event.eventKey
    || checkpointRead.verification.eventKey !== verifierResult.output.eventKey
    || checkpointRead.verification.verifiedFacts.length !== verifierResult.output.verifiedFacts.length
  ) {
    throw new AgentError("cost_guard_violation", "Translator checkpoint verification mismatch");
  }
  console.log(`Checkpoint: written and verified | ${checkpointWrite.bytes} bytes | ${checkpointRead.verification.verifiedFacts.length} verified fact(s)`);
  const translatorResult = await new TranslatorAgent(provider, logger).translate(translatorInput, { modelConfig: translatorConfig, dryRun: true });
  const translatorEditorCheckpoint = {
    schemaVersion: 1 as const,
    eventKey: event.eventKey,
    canonicalTitle: event.canonicalTitle,
    event,
    verification: verifierResult.output,
    translation: translatorResult.output,
    sources: event.sourceItems.map((sourceItem) => {
      const item = eventItems.find((candidate) => candidate.candidateId === sourceItem.candidateId);
      if (!item) throw new Error(`Missing extracted item for ${sourceItem.candidateId}`);
      return { sourceId: sourceItem.sourceId, sourceName: sourceItem.sourceName, canonicalUrl: item.canonicalUrl, sourceType: valueOrNull(item.metadata.sourceType) };
    }),
  };
  const translatorEditorCheckpointPath = await writeTranslatorEditorCheckpointAtomic(translatorEditorCheckpoint);
  const translatorEditorCheckpointRead = await readSafeTranslatorEditorCheckpoint(translatorEditorCheckpointPath.path);
  if (translatorEditorCheckpointRead.eventKey !== event.eventKey) throw new AgentError("cost_guard_violation", "Translator-to-editor checkpoint mismatch");
  const editorInput = makeEditorInput(event, eventItems, verifierResult.output, translatorResult.output);
  const editorStartedAt = new Date().toISOString();
  const editorResult = await new EditorAgent(provider, logger).edit(editorInput, { modelConfig: editorConfig, dryRun: true });
  const editorFinishedAt = new Date().toISOString();
  await mkdir("artifacts", { recursive: true });
  const editorReport = buildEditorReport({
    editorInput,
    draft: editorResult.output,
    result: editorResult,
    verifierStatus: verifierResult.output.status,
    verifierConfidence: verifierResult.output.confidenceScore,
    translatedFactCount: translatorResult.output.translatedFacts.length,
    dryRun: true,
    hours,
    limit,
    startedAt: editorStartedAt,
    finishedAt: editorFinishedAt,
  });
  await writeFile("artifacts/editor-report.json", `${JSON.stringify(editorReport, null, 2)}\n`, "utf8");
  console.log("HorizAI Editor");
  console.log("--------------------------------");
  console.log(`Event: ${event.canonicalTitle}`);
  console.log(`Verifier: ${verifierResult.output.status} | ${verifierResult.output.confidenceScore}`);
  console.log(`Translator: ${translatorResult.output.translatedTitle}`);
  console.log(`Editor: success | ${editorResult.attempts} attempt(s) | ${editorResult.latencyMs} ms`);
  console.log(`Headline sample: ${editorResult.output.headlineEs.slice(0, 200)}`);
}

main().catch((error: unknown) => {
  const summary = errorSummary(error);
  console.error(`Editor test failed closed: ${summary.code} — ${summary.message}`);
  process.exitCode = 1;
});
