import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { translationResultSchema } from "../lib/agents/contracts/index.ts";
import { errorSummary, getAgentFailureDetails, getProviderDiagnostics, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import type { AgentUsage, ProviderDiagnostics } from "../lib/agents/runtime/runtime-types.ts";
import { createConfiguredTranslator, getTranslatorModelConfig } from "../lib/agents/translator/translator-agent.ts";
import type { TranslatorInput } from "../lib/agents/translator/translator-types.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const sourceId = "11111111-1111-4111-8111-111111111111";
const sourceItemId = "fixture-single-source-item";
const eventKey = "fixture-single-source-translation";

function missingConfiguration(): string[] {
  return ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_TRANSLATE"]
    .filter((name) => !process.env[name]?.trim());
}

function fixtureInput(): TranslatorInput {
  return {
    schemaVersion: 1,
    event: {
      schemaVersion: 1,
      eventKey,
      canonicalTitle: "AI model announcement",
      sourceItems: [{
        candidateId: sourceItemId,
        sourceId,
        sourceName: "Fixture source",
        url: "https://example.com/ai-model-announcement",
        title: "AI model announcement",
        publishedAt: "2026-09-12T08:00:00Z",
      }],
      probableOccurredAt: "2026-09-12T08:00:00Z",
      probableCountryCode: "US",
      probableRegionCode: "US",
      clusterConfidence: 88,
    },
    verification: {
      schemaVersion: 1,
      eventKey,
      status: "single_source",
      confidenceScore: 90,
      primarySourceId: sourceId,
      supportingSourceIds: [],
      contradictions: [],
      verifiedFacts: [{
        claim: "The source reports that the model supports a 128K-token context window.",
        sourceIds: [sourceId],
      }],
      uncertainClaims: [],
      reason: "Fixture for isolated Translator provider validation.",
    },
    sourceLanguage: "en",
    sources: [{
      sourceId,
      sourceName: "Fixture source",
      sourceItemId,
      language: "en",
      sourceType: "technology_press",
      countryCode: "US",
    }],
  };
}

type ProviderReport = {
  generatedAt: string;
  dryRun: true;
  eventKey: string;
  model: string;
  structuredOutputMode: string;
  status: "success" | "failed";
  translationResultZodValid: boolean;
  allRequiredFieldsPresent: boolean;
  topLevelFields: string[];
  translatedFacts: number;
  translatedUncertainClaims: number;
  translatedSourceMaterial: number;
  preservedNames: number;
  translationNotes: number;
  generationSchemaValid: boolean;
  finalTranslationResultValid: boolean;
  translationAssemblySuccess: boolean;
  generationOutputBytes?: number;
  factCountExpected?: number;
  factCountTranslated?: number;
  attempts: number;
  retries: number;
  latencyMs: number;
  usage?: AgentUsage;
  diagnostics?: ProviderDiagnostics;
  error?: { code: string; message: string };
};

async function main(): Promise<void> {
  const missing = missingConfiguration();
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const config = getTranslatorModelConfig();
  if (config.structuredOutputMode !== "json_object") {
    throw new Error("Translator provider test requires AGENT_STRUCTURED_OUTPUT_TRANSLATE=json_object");
  }
  const logger = new SupabaseAgentLogger();
  const availability = await logger.getRemainingRequests(config.dailyRequestLimit, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 1) throw new Error(`Insufficient daily requests for isolated Translator test (${availability.remaining} remaining)`);

  const input = fixtureInput();
  const startedAt = Date.now();
  try {
    const result = await createConfiguredTranslator(logger).translate(input, { dryRun: true, modelConfig: { ...config, maxRetries: 0 } });
    const parsed = translationResultSchema.safeParse(result.output);
    const report: ProviderReport = {
      generatedAt: new Date().toISOString(),
      dryRun: true,
      eventKey,
      model: result.model,
      structuredOutputMode: result.diagnostics?.structuredOutputMode ?? config.structuredOutputMode,
      status: "success",
      translationResultZodValid: parsed.success,
      allRequiredFieldsPresent: result.diagnostics?.finalTranslationResultValid === true,
      topLevelFields: result.diagnostics?.responseTopLevelFields ?? [],
      translatedFacts: result.output.translatedFacts.length,
      translatedUncertainClaims: input.verification.uncertainClaims.length,
      translatedSourceMaterial: result.output.translatedSourceMaterial.length,
      preservedNames: result.output.preservedNames.length,
      translationNotes: result.output.translationNotes.length,
      generationSchemaValid: result.diagnostics?.generationSchemaValid === true,
      finalTranslationResultValid: result.diagnostics?.finalTranslationResultValid === true,
      translationAssemblySuccess: result.diagnostics?.translationAssemblySuccess === true,
      generationOutputBytes: result.diagnostics?.generationOutputBytes,
      factCountExpected: result.diagnostics?.factCountExpected,
      factCountTranslated: result.diagnostics?.factCountTranslated,
      attempts: result.attempts,
      retries: Math.max(0, result.attempts - 1),
      latencyMs: result.latencyMs,
      usage: result.usage,
      diagnostics: result.diagnostics,
    };
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/translator-provider-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log("HorizAI Translator provider test");
    console.log("--------------------------------");
    console.log(`Status: SUCCESS | HTTP ${result.diagnostics?.httpStatus ?? 200}`);
    console.log(`Mode: ${report.structuredOutputMode}`);
    console.log(`TranslationResult Zod valid: ${report.translationResultZodValid ? "YES" : "NO"}`);
    console.log(`Top-level fields: ${report.topLevelFields.join(", ")}`);
    console.log(`Translated facts: ${report.translatedFacts}`);
    console.log(`Attempts: ${report.attempts} | Retries: ${report.retries}`);
    console.log(`Input tokens: ${result.usage?.inputTokens ?? 0} | Output tokens: ${result.usage?.outputTokens ?? 0}`);
    console.log(`Latency: ${result.latencyMs} ms`);
  } catch (error) {
    const details = getAgentFailureDetails(error);
    const diagnostics = details.diagnostics ?? getProviderDiagnostics(error);
    const summary = errorSummary(error);
    const report: ProviderReport = {
      generatedAt: new Date().toISOString(),
      dryRun: true,
      eventKey,
      model: config.model,
      structuredOutputMode: config.structuredOutputMode,
      status: "failed",
      translationResultZodValid: false,
      allRequiredFieldsPresent: false,
      topLevelFields: diagnostics?.responseTopLevelFields ?? [],
      translatedFacts: 0,
      translatedUncertainClaims: 0,
      translatedSourceMaterial: 0,
      preservedNames: 0,
      translationNotes: 0,
      generationSchemaValid: diagnostics?.generationSchemaValid === true,
      finalTranslationResultValid: diagnostics?.finalTranslationResultValid === true,
      translationAssemblySuccess: diagnostics?.translationAssemblySuccess === true,
      generationOutputBytes: diagnostics?.generationOutputBytes,
      factCountExpected: diagnostics?.factCountExpected,
      factCountTranslated: diagnostics?.factCountTranslated,
      attempts: details.attempts,
      retries: Math.max(0, details.attempts - 1),
      latencyMs: details.latencyMs || Date.now() - startedAt,
      usage: diagnostics?.usage,
      diagnostics,
      error: { code: summary.code, message: summary.message },
    };
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/translator-provider-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
    throw error;
  }
}

main().catch((error: unknown) => {
  const summary = errorSummary(error);
  console.error(`Translator provider test failed closed: ${summary.code} — ${summary.message}`);
  process.exitCode = 1;
});
