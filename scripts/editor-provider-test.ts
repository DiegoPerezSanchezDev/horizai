import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { editorialDraftSchema } from "../lib/agents/contracts/index.ts";
import { errorSummary, getAgentFailureDetails, getProviderDiagnostics, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import type { AgentUsage, ProviderDiagnostics } from "../lib/agents/runtime/runtime-types.ts";
import { createConfiguredEditor, getEditorModelConfig } from "../lib/agents/editor/editor-agent.ts";
import { canonicalEditorInput } from "../lib/agents/editor/editor-fixtures.ts";
import { buildEditorSafeSnapshot, type EditorSafeSnapshot } from "../lib/agents/editor/editor-qa.ts";
import { slugifyEditorHeadline } from "../lib/agents/editor/editor-slug.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function missingConfiguration(): string[] {
  return ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_EDITOR"]
    .filter((name) => !process.env[name]?.trim());
}

type ProviderReport = {
  generatedAt: string;
  dryRun: true;
  eventKey: string;
  model: string;
  editorVersion: string;
  structuredOutputMode: string;
  status: "success" | "failed";
  editorialDraftZodValid: boolean;
  allRequiredFieldsPresent: boolean;
  editorialGuardPassed: boolean;
  generationSchemaValid: boolean;
  editorialAssemblySuccess: boolean;
  finalEditorialDraftValid: boolean;
  finishReason: string | null;
  deterministicAssembly: { eventKeyPreserved: boolean; schemaVersionDeterministic: boolean; suggestedSlugDeterministic: boolean; suggestedSlugGeneratedByLlm: false };
  topLevelFields: string[];
  attempts: number;
  retries: number;
  latencyMs: number;
  usage?: AgentUsage;
  diagnostics?: ProviderDiagnostics;
  snapshot?: EditorSafeSnapshot;
  error?: { code: string; message: string };
};

async function writeReport(report: ProviderReport): Promise<void> {
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/editor-provider-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const missing = missingConfiguration();
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const config = getEditorModelConfig();
  const logger = new SupabaseAgentLogger();
  const availability = await logger.getRemainingRequests(config.dailyRequestLimit, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 1) throw new Error(`Insufficient daily requests for isolated Editor test (${availability.remaining} remaining)`);

  const result = await createConfiguredEditor(logger).edit(canonicalEditorInput, {
    dryRun: true,
    modelConfig: { ...config, maxRetries: 0 },
  });
  const parsed = editorialDraftSchema.safeParse(result.output);
  const snapshot = buildEditorSafeSnapshot(canonicalEditorInput, result.output);
  const qaPassed = Object.values(snapshot.qa).every((check) => check.status !== "FAIL");
  const report: ProviderReport = {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    eventKey: canonicalEditorInput.event.eventKey,
    model: result.model,
    editorVersion: result.agentVersion,
    structuredOutputMode: result.diagnostics?.structuredOutputMode ?? config.structuredOutputMode,
    status: qaPassed ? "success" : "failed",
    editorialDraftZodValid: parsed.success,
    allRequiredFieldsPresent: result.diagnostics?.responseMissingTopLevelFields?.length === 0,
    editorialGuardPassed: true,
    generationSchemaValid: result.diagnostics?.generationSchemaValid === true,
    editorialAssemblySuccess: result.diagnostics?.editorialAssemblySuccess === true,
    finalEditorialDraftValid: result.diagnostics?.finalEditorialDraftValid === true,
    finishReason: result.diagnostics?.finishReason ?? null,
    deterministicAssembly: { eventKeyPreserved: result.output.eventKey === canonicalEditorInput.event.eventKey, schemaVersionDeterministic: result.output.schemaVersion === 1, suggestedSlugDeterministic: result.output.suggestedSlug === slugifyEditorHeadline(result.output.headlineEs), suggestedSlugGeneratedByLlm: false },
    topLevelFields: result.diagnostics?.responseTopLevelFields ?? [],
    attempts: result.attempts,
    retries: Math.max(0, result.attempts - 1),
    latencyMs: result.latencyMs,
    usage: result.usage,
    diagnostics: result.diagnostics,
    snapshot,
    ...(!qaPassed ? { error: { code: "editorial_qa_failed", message: "One or more deterministic editorial QA checks failed" } } : {}),
  };
  await writeReport(report);
  console.log(`HorizAI Editor provider test: ${qaPassed ? "SUCCESS" : "QA FAILED"}`);
  console.log(`Attempts: ${report.attempts} | Retries: ${report.retries}`);
  if (!qaPassed) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  const summary = errorSummary(error);
  const details = getAgentFailureDetails(error);
  const diagnostics = details.diagnostics ?? getProviderDiagnostics(error);
  await writeReport({
    generatedAt: new Date().toISOString(),
    dryRun: true,
    eventKey: canonicalEditorInput.event.eventKey,
    model: process.env.AGENT_MODEL_EDITOR?.trim() ?? "unconfigured",
    editorVersion: "editor-v2",
    structuredOutputMode: process.env.AGENT_STRUCTURED_OUTPUT_EDITOR?.trim() ?? "json_object",
    status: "failed",
    editorialDraftZodValid: false,
    allRequiredFieldsPresent: false,
    editorialGuardPassed: false,
    generationSchemaValid: false,
    editorialAssemblySuccess: false,
    finalEditorialDraftValid: false,
    finishReason: diagnostics?.finishReason ?? null,
    deterministicAssembly: { eventKeyPreserved: false, schemaVersionDeterministic: false, suggestedSlugDeterministic: false, suggestedSlugGeneratedByLlm: false },
    topLevelFields: diagnostics?.responseTopLevelFields ?? [],
    attempts: details.attempts,
    retries: Math.max(0, details.attempts - 1),
    latencyMs: details.latencyMs,
    usage: diagnostics?.usage,
    diagnostics,
    error: { code: summary.code, message: summary.message },
  });
  console.error(`Editor provider test failed closed: ${summary.code} — ${summary.message}`);
  process.exitCode = 1;
});
