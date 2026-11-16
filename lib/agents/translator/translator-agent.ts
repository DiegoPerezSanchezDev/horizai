import type { TranslationResult } from "../contracts/index.ts";
import { createConfiguredModelProvider, type ModelProvider } from "../runtime/model-provider.ts";
import { runStructuredAgent } from "../runtime/agent-runner.ts";
import type { AgentExecutionResult, AgentLogger, ModelConfig } from "../runtime/runtime-types.ts";
import { AgentError } from "../runtime/agent-errors.ts";
import { FREE_TIER_MAX_OUTPUT_TOKENS, readGroqDailyRequestHardCap, readStructuredOutputMode, validateCostGuardConfig, type DailyRequestBudget, type ProviderScopedDailyRequestBudget } from "../runtime/request-budget.ts";
import { buildTranslatorModelInput } from "./translator-input.ts";
import { translatorAgentVersion, translatorSystemInstructions } from "./translator-prompt.ts";
import { translatorInputSchema, type TranslatorInput, type TranslatorModelInput } from "./translator-types.ts";
import { assembleTranslationResult, translatorGenerationSchema, type TranslatorGeneration } from "./translator-generation.ts";

function numberEnv(name: string, fallback: number, maximum?: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(`${name} must be a finite non-negative number${maximum === undefined ? "" : ` no greater than ${maximum}`}`);
  }
  return value;
}

function integerEnv(name: string, fallback: number, maximum: number): number {
  const value = numberEnv(name, fallback, maximum);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function reasoningEffortEnv(name: string): "low" | "medium" | "high" | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new Error(`${name} must be low, medium, or high`);
}

function requiredModel(): string {
  const model = process.env.AGENT_MODEL_TRANSLATE?.trim();
  if (!model) throw new Error("Missing agent configuration: AGENT_MODEL_TRANSLATE");
  return model;
}

export function getTranslatorModelConfig(): ModelConfig {
  const reasoningEffort = reasoningEffortEnv("AGENT_REASONING_EFFORT_TRANSLATE");
  const includeReasoning = process.env.AGENT_INCLUDE_REASONING_TRANSLATE?.trim();
  const config: ModelConfig = {
    model: requiredModel(),
    timeoutMs: numberEnv("AGENT_TIMEOUT_MS", 30_000),
    maxRetries: integerEnv("AGENT_MAX_RETRIES", 2, 2),
    retryBackoffMs: numberEnv("AGENT_RETRY_BACKOFF_MS", 250),
    maxOutputTokens: integerEnv("AGENT_MAX_OUTPUT_TOKENS", FREE_TIER_MAX_OUTPUT_TOKENS, FREE_TIER_MAX_OUTPUT_TOKENS),
    dailyRequestLimit: readGroqDailyRequestHardCap(),
    failOnRateLimit: booleanEnv("AGENT_FAIL_ON_RATE_LIMIT", true),
    allowPaidFallback: booleanEnv("AGENT_ALLOW_PAID_FALLBACK", false),
    structuredOutputMode: readStructuredOutputMode(process.env.AGENT_STRUCTURED_OUTPUT_TRANSLATE ?? process.env.AGENT_STRUCTURED_OUTPUT_MODE),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(includeReasoning ? { includeReasoning: booleanEnv("AGENT_INCLUDE_REASONING_TRANSLATE", false) } : {}),
  };
  validateCostGuardConfig(config);
  return config;
}

export type TranslatorRunOptions = {
  dryRun?: boolean;
  modelConfig?: ModelConfig;
  requestBudget?: DailyRequestBudget | ProviderScopedDailyRequestBudget;
  pipelineRunId?: string;
};

export class TranslatorAgent {
  private readonly provider: ModelProvider;
  private readonly logger?: AgentLogger;

  constructor(provider: ModelProvider, logger?: AgentLogger) {
    this.provider = provider;
    this.logger = logger;
  }

  async translate(input: TranslatorInput, options: TranslatorRunOptions = {}): Promise<AgentExecutionResult<TranslationResult>> {
    const validatedInput = translatorInputSchema.parse(input);
    if (validatedInput.verification.verifiedFacts.length < 1) {
      throw new AgentError("translator_precondition_failed", "Translator requires at least one verified fact before calling the provider");
    }
    const modelConfig = options.modelConfig ?? getTranslatorModelConfig();
    const builtInput = buildTranslatorModelInput(validatedInput);
    const expectedFactIndices = validatedInput.verification.verifiedFacts.map((_, index) => index);
    return runStructuredAgent<TranslatorModelInput, TranslatorGeneration, TranslationResult>({
      agentName: "translator",
      agentVersion: translatorAgentVersion,
      eventKey: validatedInput.event.eventKey,
      input: builtInput.input,
      systemInstructions: translatorSystemInstructions,
      schemaName: "TranslatorGeneration",
      schema: translatorGenerationSchema,
      modelConfig,
      provider: this.provider,
      logger: this.logger,
      dryRun: options.dryRun ?? true,
      pipelineRunId: options.pipelineRunId,
      requestBudget: options.requestBudget,
      requestMetrics: {
        systemPromptChars: translatorSystemInstructions.length,
        inputChars: builtInput.inputChars,
        schemaChars: 0,
        sourceCount: builtInput.input.sources.length,
        originalContentChars: [builtInput.inputChars],
        sentContentChars: [builtInput.inputChars],
        truncated: [false],
      },
      diagnosticsContext: { factCountExpected: expectedFactIndices.length, expectedFactIndices },
      generatedOutputDiagnostics: (value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
        const record = value as Record<string, unknown>;
        const factTranslations = Array.isArray(record.factTranslations) ? record.factTranslations : [];
        const receivedFactIndices = factTranslations.flatMap((item) => {
          if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
          const factIndex = (item as Record<string, unknown>).factIndex;
          return typeof factIndex === "number" && Number.isInteger(factIndex) ? [factIndex] : [];
        });
        return {
          factCountGenerated: factTranslations.length,
          factCountTranslated: factTranslations.length,
          receivedFactIndices,
          translatedSourceMaterialChars: typeof record.translatedSourceMaterial === "string" ? record.translatedSourceMaterial.length : 0,
        };
      },
      finalizeOutput: (generation, diagnostics) => assembleTranslationResult(validatedInput, generation, diagnostics),
    });
  }
}

export function createConfiguredTranslator(logger?: AgentLogger): TranslatorAgent {
  return new TranslatorAgent(createConfiguredModelProvider(), logger);
}

export { translatorAgentVersion, translatorSystemInstructions } from "./translator-prompt.ts";
export { translatorInputSchema, translatorModelInputSchema } from "./translator-types.ts";
export type { TranslatorInput, TranslatorModelInput } from "./translator-types.ts";
export { assembleTranslationResult, translatorGenerationSchema } from "./translator-generation.ts";
export type { TranslatorGeneration } from "./translator-generation.ts";
export { translatorCheckpointSchema } from "./translator-checkpoint.ts";
export type { TranslatorCheckpoint } from "./translator-checkpoint.ts";
