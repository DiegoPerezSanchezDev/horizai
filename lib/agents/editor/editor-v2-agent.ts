import type { EditorialDraft } from "../contracts/index.ts";
import { createConfiguredModelProvider, type ModelProvider } from "../runtime/model-provider.ts";
import { runStructuredAgent } from "../runtime/agent-runner.ts";
import type { AgentExecutionResult, AgentLogger, ModelConfig } from "../runtime/runtime-types.ts";
import { FREE_TIER_MAX_OUTPUT_TOKENS, readGroqDailyRequestHardCap, readStructuredOutputMode, validateCostGuardConfig, type DailyRequestBudget, type ProviderScopedDailyRequestBudget } from "../runtime/request-budget.ts";
import { buildEditorModelInput } from "./editor-input.ts";
import { assembleEditorDraft, editorGenerationSchema, type EditorGeneration } from "./editor-generation.ts";
import { editorV2AgentVersion, editorV2SystemInstructions } from "./editor-v2-prompt.ts";
import { editorInputSchema, type EditorInput } from "./editor-types.ts";
import { validateEditorialDraftOutput } from "./editor-output-guard.ts";

function numberEnv(name: string, fallback: number, maximum?: number): number { const raw = process.env[name]?.trim(); if (!raw) return fallback; const value = Number(raw); if (!Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) throw new Error(`${name} must be a finite non-negative number`); return value; }
function integerEnv(name: string, fallback: number, maximum: number): number { const value = numberEnv(name, fallback, maximum); if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
function booleanEnv(name: string, fallback: boolean): boolean { const raw = process.env[name]?.trim().toLowerCase(); if (!raw) return fallback; if (raw === "true") return true; if (raw === "false") return false; throw new Error(`${name} must be true or false`); }
function reasoningEffortEnv(name: string): "low" | "medium" | "high" | undefined { const raw = process.env[name]?.trim().toLowerCase(); if (!raw) return undefined; if (raw === "low" || raw === "medium" || raw === "high") return raw; throw new Error(`${name} must be low, medium, or high`); }
function requiredModel(): string { const model = process.env.AGENT_MODEL_EDITOR?.trim(); if (!model) throw new Error("Missing agent configuration: AGENT_MODEL_EDITOR"); return model; }

export function getEditorV2ModelConfig(): ModelConfig {
  const reasoningEffort = reasoningEffortEnv("AGENT_REASONING_EFFORT_EDITOR"); const includeReasoning = process.env.AGENT_INCLUDE_REASONING_EDITOR?.trim();
  const config: ModelConfig = { model: requiredModel(), timeoutMs: numberEnv("AGENT_TIMEOUT_MS", 30_000), maxRetries: integerEnv("AGENT_MAX_RETRIES", 2, 2), retryBackoffMs: numberEnv("AGENT_RETRY_BACKOFF_MS", 250), maxOutputTokens: integerEnv("AGENT_MAX_OUTPUT_TOKENS", FREE_TIER_MAX_OUTPUT_TOKENS, FREE_TIER_MAX_OUTPUT_TOKENS), dailyRequestLimit: readGroqDailyRequestHardCap(), failOnRateLimit: booleanEnv("AGENT_FAIL_ON_RATE_LIMIT", true), allowPaidFallback: booleanEnv("AGENT_ALLOW_PAID_FALLBACK", false), structuredOutputMode: readStructuredOutputMode(process.env.AGENT_STRUCTURED_OUTPUT_EDITOR ?? process.env.AGENT_STRUCTURED_OUTPUT_MODE, "json_object"), ...(reasoningEffort ? { reasoningEffort } : {}), ...(includeReasoning ? { includeReasoning: booleanEnv("AGENT_INCLUDE_REASONING_EDITOR", false) } : {}) };
  validateCostGuardConfig(config); return config;
}
export type EditorV2RunOptions = { dryRun?: boolean; modelConfig?: ModelConfig; requestBudget?: DailyRequestBudget | ProviderScopedDailyRequestBudget; pipelineRunId?: string };

export class EditorV2Agent {
  private readonly provider: ModelProvider; private readonly logger?: AgentLogger;
  constructor(provider: ModelProvider, logger?: AgentLogger) { this.provider = provider; this.logger = logger; }
  async edit(input: EditorInput, options: EditorV2RunOptions = {}): Promise<AgentExecutionResult<EditorialDraft>> {
    const validatedInput = editorInputSchema.parse(input); const modelConfig = options.modelConfig ?? getEditorV2ModelConfig(); const builtInput = buildEditorModelInput(validatedInput);
    return runStructuredAgent<typeof builtInput.input, EditorGeneration, EditorialDraft>({ agentName: "editor", agentVersion: editorV2AgentVersion, eventKey: validatedInput.event.eventKey, pipelineRunId: options.pipelineRunId, input: builtInput.input, systemInstructions: editorV2SystemInstructions, schemaName: "EditorGeneration", schema: editorGenerationSchema, modelConfig, provider: this.provider, logger: this.logger, dryRun: options.dryRun ?? true, requestBudget: options.requestBudget, requestMetrics: { systemPromptChars: editorV2SystemInstructions.length, inputChars: builtInput.inputChars, schemaChars: 0, sourceCount: builtInput.input.sources.length, originalContentChars: [builtInput.input.translation.translatedSourceMaterial.length], sentContentChars: [builtInput.input.translation.translatedSourceMaterial.length], truncated: [false] }, finalizeOutput: (generation, diagnostics) => {
      const assembled = assembleEditorDraft(validatedInput, generation, diagnostics);
      const preservedNameReport = validateEditorialDraftOutput(validatedInput, assembled.output, { grounding: true });
      return { output: assembled.output, diagnostics: { ...assembled.diagnostics, ...preservedNameReport } };
    } });
  }
}
export function createConfiguredEditorV2(logger?: AgentLogger): EditorV2Agent { return new EditorV2Agent(createConfiguredModelProvider(), logger); }
