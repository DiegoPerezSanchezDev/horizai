import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { errorSummary, getAgentFailureDetails, getProviderDiagnostics, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import type { AgentUsage, ProviderDiagnostics } from "../lib/agents/runtime/runtime-types.ts";
import { createConfiguredVerifier, getVerifierModelConfig } from "../lib/agents/verifier/verifier-agent.ts";
import type { VerifierInput } from "../lib/agents/verifier/verifier-types.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const sourceId = "11111111-1111-4111-8111-111111111111";
const candidateId = "fixture-verifier-item";
const eventKey = "fixture-verifier-single-source";

function missingConfiguration(): string[] {
  return ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_VERIFY"]
    .filter((name) => !process.env[name]?.trim());
}

function fixtureInput(): VerifierInput {
  return {
    event: {
      schemaVersion: 1,
      eventKey,
      canonicalTitle: "AI model context-window announcement",
      sourceItems: [{
        candidateId,
        sourceId,
        sourceName: "Fixture technology source",
        url: "https://example.com/ai-context-window",
        title: "AI model context-window announcement",
        publishedAt: "2026-09-12T08:00:00Z",
      }],
      probableOccurredAt: "2026-09-12T08:00:00Z",
      probableCountryCode: "US",
      probableRegionCode: "US",
      clusterConfidence: 88,
    },
    items: [{
      schemaVersion: 1,
      candidateId,
      url: "https://example.com/ai-context-window",
      canonicalUrl: "https://example.com/ai-context-window",
      title: "AI model context-window announcement",
      description: "A short source description.",
      author: null,
      publishedAt: "2026-09-12T08:00:00Z",
      language: "en",
      content: "The source reports that the model supports a 128K-token context window.",
      contentHash: "fixture-hash-12345678",
      metadata: { sourceType: "technology_press", sourceCountryCode: "US" },
    }],
    sources: [{
      sourceId,
      sourceName: "Fixture technology source",
      sourceUrl: "https://example.com/ai-context-window",
      sourceType: "technology_press",
      countryCode: "US",
      language: "en",
    }],
  };
}

type ProviderReport = {
  generatedAt: string;
  dryRun: true;
  eventKey: string;
  model: string;
  structuredOutputMode: string;
  reasoningEffort: string | null;
  includeReasoning: boolean | null;
  status: "success" | "failed";
  verificationResultZodValid: boolean;
  allRequiredFieldsPresent: boolean;
  topLevelFields: string[];
  verificationStatus?: string;
  confidenceScore?: number;
  verifiedFacts: number;
  uncertainClaims: number;
  contradictions: number;
  reasonChars: number;
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
  const config = getVerifierModelConfig();
  if (config.structuredOutputMode !== "best_effort_schema") throw new Error("Verifier provider test requires AGENT_STRUCTURED_OUTPUT_VERIFY=best_effort_schema");
  if (config.reasoningEffort !== "low" || config.includeReasoning !== false) throw new Error("Verifier provider test requires low reasoning effort and include_reasoning=false");
  const logger = new SupabaseAgentLogger();
  const availability = await logger.getRemainingRequests(config.dailyRequestLimit, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 1) throw new Error(`Insufficient daily requests for isolated Verifier test (${availability.remaining} remaining)`);

  const startedAt = Date.now();
  try {
    const result = await createConfiguredVerifier(logger).verify(fixtureInput(), { dryRun: true, modelConfig: { ...config, maxRetries: 0 } });
    const report: ProviderReport = {
      generatedAt: new Date().toISOString(),
      dryRun: true,
      eventKey,
      model: result.model,
      structuredOutputMode: result.diagnostics?.structuredOutputMode ?? config.structuredOutputMode,
      reasoningEffort: result.diagnostics?.reasoningEffort ?? config.reasoningEffort ?? null,
      includeReasoning: result.diagnostics?.includeReasoning ?? config.includeReasoning ?? null,
      status: "success",
      verificationResultZodValid: true,
      allRequiredFieldsPresent: result.diagnostics?.responseMissingTopLevelFields?.length === 0,
      topLevelFields: result.diagnostics?.responseTopLevelFields ?? [],
      verificationStatus: result.output.status,
      confidenceScore: result.output.confidenceScore,
      verifiedFacts: result.output.verifiedFacts.length,
      uncertainClaims: result.output.uncertainClaims.length,
      contradictions: result.output.contradictions.length,
      reasonChars: result.output.reason.length,
      attempts: result.attempts,
      retries: Math.max(0, result.attempts - 1),
      latencyMs: result.latencyMs,
      usage: result.usage,
      diagnostics: result.diagnostics,
    };
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/verifier-provider-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log("HorizAI Verifier provider test");
    console.log("--------------------------------");
    console.log(`Status: SUCCESS | HTTP ${result.diagnostics?.httpStatus ?? 200}`);
    console.log(`Mode: ${report.structuredOutputMode} | Reasoning: ${report.reasoningEffort} | Include reasoning: ${report.includeReasoning}`);
    console.log(`VerificationResult Zod valid: YES | All required fields present: ${report.allRequiredFieldsPresent ? "YES" : "NO"}`);
    console.log(`Verification status: ${report.verificationStatus} | Confidence: ${report.confidenceScore}`);
    console.log(`Verified facts: ${report.verifiedFacts} | Uncertain: ${report.uncertainClaims} | Contradictions: ${report.contradictions}`);
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
      reasoningEffort: config.reasoningEffort ?? null,
      includeReasoning: config.includeReasoning ?? null,
      status: "failed",
      verificationResultZodValid: false,
      allRequiredFieldsPresent: false,
      topLevelFields: diagnostics?.responseTopLevelFields ?? [],
      verifiedFacts: 0,
      uncertainClaims: 0,
      contradictions: 0,
      reasonChars: 0,
      attempts: details.attempts,
      retries: Math.max(0, details.attempts - 1),
      latencyMs: details.latencyMs || Date.now() - startedAt,
      usage: diagnostics?.usage,
      diagnostics,
      error: { code: summary.code, message: summary.message },
    };
    await mkdir("artifacts", { recursive: true });
    await writeFile("artifacts/verifier-provider-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
    throw error;
  }
}

main().catch((error: unknown) => {
  const summary = errorSummary(error);
  console.error(`Verifier provider test failed closed: ${summary.code} — ${summary.message}`);
  process.exitCode = 1;
});
