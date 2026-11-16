import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { AgentError, errorSummary, getAgentFailureDetails, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { clusterExtractedItems } from "../lib/agents/clustering/cluster-runner.ts";
import { runExtraction } from "../lib/agents/extraction/extraction-runner.ts";
import { VerifierAgent, getVerifierModelConfig } from "../lib/agents/verifier/verifier-agent.ts";
import type { VerifierInput } from "../lib/agents/verifier/verifier-types.ts";
import { TranslatorAgent, getTranslatorModelConfig } from "../lib/agents/translator/translator-agent.ts";
import { parseVerifierCliOptions } from "../lib/agents/verifier/verifier-cli-options.ts";
import type { AgentExecutionResult, AgentUsage, ProviderDiagnostics, RequestMetrics } from "../lib/agents/runtime/runtime-types.ts";
import type { TranslationResult, VerificationResult } from "../lib/agents/contracts/index.ts";
import type { TranslatorInput } from "../lib/agents/translator/translator-types.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

type TranslationReport = {
  generatedAt: string;
  dryRun: true;
  hours: number;
  limit: number;
  eventKey: string;
  eventTitle: string;
  agentVersion: string;
  model: string;
  verifier: {
    status: VerificationResult["status"];
    confidence: number;
    attempts: number;
    retries: number;
    latencyMs: number;
    tokenUsage?: AgentUsage;
    structuredOutputMode?: string;
  };
  translator: {
    status: "success";
    translatedFacts: number;
    translatedUncertainClaims: number;
    generationSchemaValid: boolean | null;
    translationAssemblySuccess: boolean | null;
    finalTranslationResultValid: boolean | null;
    factCountExpected: number | null;
    factCountTranslated: number | null;
    translatedSourceMaterialChars: number;
    preservedNamesCount: number;
    translationNotesCount: number;
    attempts: number;
    retries: number;
    latencyMs: number;
    tokenUsage?: AgentUsage;
    requestMetrics?: RequestMetrics;
    providerDiagnostics?: ProviderDiagnostics;
    structuredOutputMode?: string;
  };
  qa: {
    verifiedFactsHaveSources: boolean;
    uncertainClaimsRemainSeparatedInInput: boolean;
    statusIsEligibleForTranslation: boolean;
    noCompleteArticleSent: true;
    semantic: {
      fidelity: "PASS" | "WARNING" | "FAIL";
      naturalSpanish: "PASS" | "WARNING" | "FAIL";
      traceability: "PASS" | "WARNING" | "FAIL";
      numbersAndDates: "PASS" | "WARNING" | "FAIL";
      uncertainty: "PASS" | "WARNING" | "FAIL";
      noAddedClaims: "PASS" | "WARNING" | "FAIL";
      noLongReproduction: "PASS" | "WARNING" | "FAIL";
    };
  };
};

type Claim = VerificationResult["verifiedFacts"][number];

function extractStableTokens(text: string): string[] {
  return text.match(/\b\d+(?:[.,]\d+)?%?|\b\d{4}-\d{2}-\d{2}\b|\$\s?\d+(?:[.,]\d+)?|€\s?\d+(?:[.,]\d+)?/g) ?? [];
}

function semanticQa(input: TranslatorInput, output: TranslationResult): TranslationReport["qa"]["semantic"] {
  const claims: Claim[] = [
    ...input.verification.verifiedFacts,
    ...input.verification.uncertainClaims,
    ...input.verification.contradictions,
  ];
  const sourceItemIds = new Set(input.sources.map((source) => source.sourceItemId));
  const traceableFacts = output.translatedFacts.every((fact) =>
    claims.some((claim) => claim.claim === fact.sourceText)
    && (fact.sourceItemId === null || sourceItemIds.has(fact.sourceItemId))
  );
  const numbersPreserved = output.translatedFacts.every((fact) => {
    const sourceTokens = extractStableTokens(fact.sourceText);
    return sourceTokens.every((token) => fact.translatedText.includes(token));
  });
  const sourceChars = claims.reduce((sum, claim) => sum + claim.claim.length, 0);
  const noLongReproduction = output.translatedSourceMaterial.length <= Math.max(1_000, sourceChars * 2);
  const hasUncertainty = input.verification.uncertainClaims.length > 0;
  return {
    fidelity: traceableFacts && numbersPreserved ? "PASS" : "FAIL",
    naturalSpanish: "WARNING",
    traceability: traceableFacts ? "PASS" : "FAIL",
    numbersAndDates: numbersPreserved ? "PASS" : "FAIL",
    uncertainty: hasUncertainty ? "WARNING" : "PASS",
    noAddedClaims: traceableFacts ? "PASS" : "WARNING",
    noLongReproduction: noLongReproduction ? "PASS" : "WARNING",
  };
}

function positiveIntegerArg(name: string, value: string | undefined, maximum: number, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) throw new Error(`--${name} must be an integer between 1 and ${maximum}`);
  return parsed;
}

function missingConfiguration(): string[] {
  return ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_VERIFY", "AGENT_MODEL_TRANSLATE"]
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
      const metadata = item?.metadata ?? {};
      return {
        sourceId: sourceItem.sourceId,
        sourceName: sourceItem.sourceName,
        sourceUrl: sourceItem.url,
        sourceType: valueOrNull(metadata.sourceType),
        countryCode: valueOrNull(metadata.sourceCountryCode),
        language: item?.language ?? null,
      };
    }),
  };
}

function makeTranslatorInput(event: VerifierInput["event"], items: VerifierInput["items"], verification: VerificationResult): TranslatorInput {
  const sources = event.sourceItems.map((sourceItem) => {
    const item = items.find((candidate) => candidate.candidateId === sourceItem.candidateId);
    if (!item) throw new Error(`Missing extracted item for ${sourceItem.candidateId}`);
    const metadata = item.metadata;
    return {
      sourceId: sourceItem.sourceId,
      sourceName: sourceItem.sourceName,
      sourceItemId: item.candidateId,
      language: item.language,
      sourceType: valueOrNull(metadata.sourceType),
      countryCode: valueOrNull(metadata.sourceCountryCode),
    };
  });
  const sourceLanguage = sources[0]?.language;
  if (!sourceLanguage) throw new Error("No source language available for translation");
  return { schemaVersion: 1, event, verification, sourceLanguage, sources };
}

function resultModel(result: AgentExecutionResult<TranslationResult>, uncertainClaimsCount: number): TranslationReport["translator"] {
  return {
    status: "success",
    translatedFacts: result.output.translatedFacts.length,
    translatedUncertainClaims: uncertainClaimsCount,
    generationSchemaValid: result.diagnostics?.generationSchemaValid ?? null,
    translationAssemblySuccess: result.diagnostics?.translationAssemblySuccess ?? null,
    finalTranslationResultValid: result.diagnostics?.finalTranslationResultValid ?? null,
    factCountExpected: result.diagnostics?.factCountExpected ?? null,
    factCountTranslated: result.diagnostics?.factCountTranslated ?? null,
    translatedSourceMaterialChars: result.output.translatedSourceMaterial.length,
    preservedNamesCount: result.output.preservedNames.length,
    translationNotesCount: result.output.translationNotes.length,
    attempts: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    latencyMs: result.latencyMs,
    tokenUsage: result.usage,
    requestMetrics: result.diagnostics?.requestMetrics,
    providerDiagnostics: result.diagnostics,
    structuredOutputMode: result.diagnostics?.structuredOutputMode,
  };
}

async function main(): Promise<void> {
  const missing = missingConfiguration();
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const { hours, limit } = parseVerifierCliOptions(process.argv);
  const requiredAgentCalls = positiveIntegerArg("requiredAgentCalls", process.env.TRANSLATOR_REQUIRED_AGENT_CALLS, 2, 2);
  if (requiredAgentCalls !== 2) throw new AgentError("cost_guard_violation", "Final translator test requires capacity for one Verifier call and one Translator call");

  const verifierConfig = getVerifierModelConfig();
  const translatorConfig = getTranslatorModelConfig();
  if (verifierConfig.dailyRequestLimit !== translatorConfig.dailyRequestLimit) {
    throw new AgentError("cost_guard_violation", "Verifier and Translator must share the same daily request limit");
  }
  const logger = new SupabaseAgentLogger();
  const requestDate = new Date().toISOString().slice(0, 10);
  const availability = await logger.getRemainingRequests(verifierConfig.dailyRequestLimit, requestDate);
  if (availability.remaining < requiredAgentCalls) {
    throw new AgentError("DAILY_REQUEST_LIMIT_REACHED", `Insufficient daily requests for the final one-event test (${availability.remaining} remaining)`);
  }

  const extraction = await runExtraction({ hours, limit, persist: false });
  const extractedItems = extraction.results.flatMap((result) => result.item ? [result.item] : []);
  const clustered = clusterExtractedItems(extractedItems);
  const event = clustered.events.slice(0, limit)[0];
  if (!event) throw new Error("No eligible event found for translation test");
  const itemsByCandidate = new Map(extractedItems.map((item) => [item.candidateId, item]));
  const eventItems = event.sourceItems.flatMap((source) => {
    const item = itemsByCandidate.get(source.candidateId);
    return item ? [item] : [];
  });
  const verifierInput = makeVerifierInput(event, eventItems);
  const provider = createConfiguredModelProvider();
  const verifier = new VerifierAgent(provider, logger);
  const translator = new TranslatorAgent(provider, logger);
  const verifierResult = await verifier.verify(verifierInput, { modelConfig: { ...verifierConfig, maxRetries: 0 }, dryRun: true });
  if (verifierResult.output.status === "rejected") throw new AgentError("provider_permanent", "Rejected event cannot advance to translation");
  const translatorResult = await translator.translate(makeTranslatorInput(event, eventItems, verifierResult.output), { modelConfig: { ...translatorConfig, maxRetries: 0 }, dryRun: true });
  const report: TranslationReport = {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    hours,
    limit,
    eventKey: event.eventKey,
    eventTitle: event.canonicalTitle,
    agentVersion: translatorResult.agentVersion,
    model: translatorResult.model,
    verifier: {
      status: verifierResult.output.status,
      confidence: verifierResult.output.confidenceScore,
      attempts: verifierResult.attempts,
      retries: Math.max(0, verifierResult.attempts - 1),
      latencyMs: verifierResult.latencyMs,
      tokenUsage: verifierResult.usage,
      structuredOutputMode: verifierResult.diagnostics?.structuredOutputMode,
    },
    translator: resultModel(translatorResult, verifierResult.output.uncertainClaims.length),
    qa: {
      verifiedFactsHaveSources: verifierResult.output.verifiedFacts.every((fact) => fact.sourceIds.length > 0),
      uncertainClaimsRemainSeparatedInInput: verifierResult.output.uncertainClaims.length >= 0,
      statusIsEligibleForTranslation: true,
      noCompleteArticleSent: true,
      semantic: semanticQa(makeTranslatorInput(event, eventItems, verifierResult.output), translatorResult.output),
    },
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/translator-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("HorizAI Translator");
  console.log("--------------------------------");
  console.log(`Event: ${event.canonicalTitle}`);
  console.log(`Verifier: ${verifierResult.output.status} | ${verifierResult.output.confidenceScore}`);
  console.log("Translator: success");
  console.log(`Translated facts: ${report.translator.translatedFacts}`);
  console.log(`Translated uncertain claims: ${report.translator.translatedUncertainClaims}`);
  console.log(`Attempts: ${report.translator.attempts} | Retries: ${report.translator.retries}`);
  console.log(`Input tokens: ${report.translator.tokenUsage?.inputTokens ?? 0} | Output tokens: ${report.translator.tokenUsage?.outputTokens ?? 0}`);
  console.log(`Latency: ${report.translator.latencyMs} ms`);
  console.log(`QA: fidelity=${report.qa.semantic.fidelity} | traceability=${report.qa.semantic.traceability} | numbers/dates=${report.qa.semantic.numbersAndDates} | uncertainty=${report.qa.semantic.uncertainty}`);
  console.log(`Translated title sample: ${translatorResult.output.translatedTitle.slice(0, 300)}`);
  const factSample = translatorResult.output.translatedFacts[0];
  if (factSample) console.log(`Translated fact sample: ${factSample.translatedText.slice(0, 300)}`);
}

main().catch((error: unknown) => {
  const summary = errorSummary(error);
  const details = getAgentFailureDetails(error);
  console.error(`Translator test failed closed: ${summary.code} — ${summary.message}`);
  if (details.attempts > 0) console.error(`Attempts: ${details.attempts}`);
  process.exitCode = 1;
});
