import { verificationResultSchema, type VerificationResult } from "../contracts/index.ts";
import { createConfiguredModelProvider, type ModelProvider } from "../runtime/model-provider.ts";
import { runStructuredAgent } from "../runtime/agent-runner.ts";
import { AgentError } from "../runtime/agent-errors.ts";
import { maxGroqModelInputCharsForTpm } from "../runtime/groq-capacity-pacing.ts";
import { toStrictProviderJsonSchema } from "../runtime/strict-json-schema.ts";
import type { AgentExecutionResult, AgentLogger, ModelConfig } from "../runtime/runtime-types.ts";
import { FREE_TIER_MAX_OUTPUT_TOKENS, readGroqDailyRequestHardCap, readStructuredOutputMode, validateCostGuardConfig, type DailyRequestBudget, type ProviderScopedDailyRequestBudget } from "../runtime/request-budget.ts";
import { verifierAgentVersion, verifierSystemInstructions } from "./verifier-prompt.ts";
import { verifierInputSchema, type VerifierInput } from "./verifier-types.ts";
import { buildVerifierModelInput } from "./verifier-input-builder.ts";

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
  const model = process.env.AGENT_MODEL_VERIFY?.trim();
  if (!model) throw new Error("Missing agent configuration: AGENT_MODEL_VERIFY");
  return model;
}

export function getVerifierModelConfig(): ModelConfig {
  const temperature = process.env.AGENT_TEMPERATURE_VERIFY?.trim();
  const reasoningEffort = reasoningEffortEnv("AGENT_REASONING_EFFORT_VERIFY");
  const includeReasoning = process.env.AGENT_INCLUDE_REASONING_VERIFY?.trim();
  const config: ModelConfig = {
    model: requiredModel(),
    timeoutMs: numberEnv("AGENT_TIMEOUT_MS", 30_000),
    maxRetries: numberEnv("AGENT_MAX_RETRIES", 2, 2),
    retryBackoffMs: numberEnv("AGENT_RETRY_BACKOFF_MS", 250),
    maxOutputTokens: integerEnv("AGENT_MAX_OUTPUT_TOKENS", FREE_TIER_MAX_OUTPUT_TOKENS, FREE_TIER_MAX_OUTPUT_TOKENS),
    dailyRequestLimit: readGroqDailyRequestHardCap(),
    failOnRateLimit: booleanEnv("AGENT_FAIL_ON_RATE_LIMIT", true),
    allowPaidFallback: booleanEnv("AGENT_ALLOW_PAID_FALLBACK", false),
    structuredOutputMode: readStructuredOutputMode(process.env.AGENT_STRUCTURED_OUTPUT_VERIFY ?? process.env.AGENT_STRUCTURED_OUTPUT_MODE),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(includeReasoning ? { includeReasoning: booleanEnv("AGENT_INCLUDE_REASONING_VERIFY", false) } : {}),
    ...(temperature ? { temperature: numberEnv("AGENT_TEMPERATURE_VERIFY", 0, 2) } : {}),
  };
  validateCostGuardConfig(config);
  return config;
}

export type VerifierRunOptions = {
  dryRun?: boolean;
  modelConfig?: ModelConfig;
  requestBudget?: DailyRequestBudget | ProviderScopedDailyRequestBudget;
  pipelineRunId?: string;
  maxInputChars?: number;
};

export class VerifierAgent {
  private readonly provider: ModelProvider;
  private readonly logger?: AgentLogger;

  constructor(provider: ModelProvider, logger?: AgentLogger) {
    this.provider = provider;
    this.logger = logger;
  }

  async verify(input: VerifierInput, options: VerifierRunOptions = {}): Promise<AgentExecutionResult<VerificationResult>> {
    const validatedInput = verifierInputSchema.parse(input);
    const modelConfig = options.modelConfig ?? getVerifierModelConfig();
    const maxInputChars = options.maxInputChars ?? integerEnv("AGENT_MAX_INPUT_CHARS", 12_000, 12_000);
    let maxModelInputChars = Number.POSITIVE_INFINITY;
    if (this.provider.providerId === "groq") {
      const tokenLimitTpm = modelConfig.groqCapacity?.tokenMinuteHardLimit;
      if (!tokenLimitTpm) throw new AgentError("cost_guard_violation", "Groq Verifier input budget requires the configured hard TPM limit");
      const schemaChars = JSON.stringify(toStrictProviderJsonSchema(verificationResultSchema)).length;
      maxModelInputChars = maxGroqModelInputCharsForTpm({
        systemInstructionChars: verifierSystemInstructions.length,
        schemaChars,
        maxOutputTokens: modelConfig.maxOutputTokens,
        tokenLimitTpm,
      });
      if (maxModelInputChars < 1) throw new AgentError("cost_guard_violation", "Verifier instructions, schema, output reservation, and safety margin exceed the configured Groq TPM limit");
    }
    const builtInput = buildVerifierModelInput(validatedInput, maxInputChars, maxModelInputChars);
    return runStructuredAgent({
      agentName: "verifier",
      agentVersion: verifierAgentVersion,
      eventKey: validatedInput.event.eventKey,
      input: builtInput.input,
      systemInstructions: verifierSystemInstructions,
      schemaName: "VerificationResult",
      schema: verificationResultSchema,
      modelConfig,
      provider: this.provider,
      logger: this.logger,
      dryRun: options.dryRun ?? true,
      pipelineRunId: options.pipelineRunId,
      requestBudget: options.requestBudget,
      requestMetrics: {
        systemPromptChars: verifierSystemInstructions.length,
        inputChars: builtInput.metrics.inputChars,
        schemaChars: 0,
        sourceCount: builtInput.metrics.sourceCount,
        originalContentChars: builtInput.metrics.originalContentChars,
        sentContentChars: builtInput.metrics.sentContentChars,
        truncated: builtInput.metrics.truncated,
      },
    });
  }
}

export function createConfiguredVerifier(logger?: AgentLogger): VerifierAgent {
  return new VerifierAgent(createConfiguredModelProvider(), logger);
}

export { verifierAgentVersion, verifierSystemInstructions } from "./verifier-prompt.ts";
export { verifierInputSchema } from "./verifier-types.ts";
export type { VerifierInput } from "./verifier-types.ts";
