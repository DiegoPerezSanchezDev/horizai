import { rankingResultSchema, type RankingResult } from "../contracts/index.ts";
import { createConfiguredModelProvider, type ModelProvider } from "../runtime/model-provider.ts";
import { runStructuredAgent } from "../runtime/agent-runner.ts";
import type { AgentExecutionResult, AgentLogger, ModelConfig } from "../runtime/runtime-types.ts";
import { FREE_TIER_MAX_OUTPUT_TOKENS, readGroqDailyRequestHardCap, readStructuredOutputMode, validateCostGuardConfig, type DailyRequestBudget, type ProviderScopedDailyRequestBudget } from "../runtime/request-budget.ts";
import { assembleRankingResult } from "./rank-score.ts";
import { rankerAgentVersion, rankerFormulaVersion, rankerSystemInstructions } from "./ranker-prompt.ts";
import { rankerGenerationSchema, rankerInputSchema, type ActivityHistorySignal, type RankerGeneration, type RankerInput } from "./ranker-types.ts";
import { type RankSignals } from "./rank-signals.ts";

function numberEnv(name: string, fallback: number, maximum?: number): number { const raw = process.env[name]?.trim(); if (!raw) return fallback; const value = Number(raw); if (!Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) throw new Error(`${name} must be a finite non-negative number`); return value; }
function integerEnv(name: string, fallback: number, maximum: number): number { const value = numberEnv(name, fallback, maximum); if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`); return value; }
function booleanEnv(name: string, fallback: boolean): boolean { const raw = process.env[name]?.trim().toLowerCase(); if (!raw) return fallback; if (raw === "true") return true; if (raw === "false") return false; throw new Error(`${name} must be true or false`); }
function reasoningEffortEnv(name: string): "low" | "medium" | "high" | undefined { const raw = process.env[name]?.trim().toLowerCase(); if (!raw) return undefined; if (raw === "low" || raw === "medium" || raw === "high") return raw; throw new Error(`${name} must be low, medium, or high`); }
function requiredModel(): string { const model = process.env.AGENT_MODEL_RANK?.trim(); if (!model) throw new Error("Missing agent configuration: AGENT_MODEL_RANK"); return model; }

export function getRankerModelConfig(): ModelConfig {
  const reasoningEffort = reasoningEffortEnv("AGENT_REASONING_EFFORT_RANK"); const includeReasoning = process.env.AGENT_INCLUDE_REASONING_RANK?.trim();
  const config: ModelConfig = { model: requiredModel(), timeoutMs: numberEnv("AGENT_TIMEOUT_MS", 30_000), maxRetries: integerEnv("AGENT_MAX_RETRIES", 2, 2), retryBackoffMs: numberEnv("AGENT_RETRY_BACKOFF_MS", 250), maxOutputTokens: integerEnv("AGENT_MAX_OUTPUT_TOKENS", FREE_TIER_MAX_OUTPUT_TOKENS, FREE_TIER_MAX_OUTPUT_TOKENS), dailyRequestLimit: readGroqDailyRequestHardCap(), failOnRateLimit: booleanEnv("AGENT_FAIL_ON_RATE_LIMIT", true), allowPaidFallback: booleanEnv("AGENT_ALLOW_PAID_FALLBACK", false), structuredOutputMode: readStructuredOutputMode(process.env.AGENT_STRUCTURED_OUTPUT_RANK ?? process.env.AGENT_STRUCTURED_OUTPUT_MODE, "json_object"), ...(reasoningEffort ? { reasoningEffort } : {}), ...(includeReasoning ? { includeReasoning: booleanEnv("AGENT_INCLUDE_REASONING_RANK", false) } : {}) };
  validateCostGuardConfig(config); return config;
}

export type RankerRunOptions = { dryRun?: boolean; modelConfig?: ModelConfig; requestBudget?: DailyRequestBudget | ProviderScopedDailyRequestBudget; now?: Date; activityHistory?: ActivityHistorySignal[]; pipelineRunId?: string };
export type RankerExecutionResult = AgentExecutionResult<RankingResult> & { signals: RankSignals; formulaVersion: string };

export class RankerAgent {
  private readonly provider: ModelProvider; private readonly logger?: AgentLogger;
  constructor(provider: ModelProvider, logger?: AgentLogger) { this.provider = provider; this.logger = logger; }
  async rank(input: RankerInput, options: RankerRunOptions = {}): Promise<RankerExecutionResult> {
    const validatedInput = rankerInputSchema.parse(input); const modelConfig = options.modelConfig ?? getRankerModelConfig(); let signals: RankSignals | null = null;
    const result = await runStructuredAgent<RankerInput, RankerGeneration, RankingResult>({
      agentName: "ranker", agentVersion: rankerAgentVersion, eventKey: validatedInput.event.eventKey, pipelineRunId: options.pipelineRunId, input: validatedInput, systemInstructions: rankerSystemInstructions, schemaName: "RankerGeneration", schema: rankerGenerationSchema, modelConfig, provider: this.provider, logger: this.logger, dryRun: options.dryRun ?? true, requestBudget: options.requestBudget,
      requestMetrics: { systemPromptChars: rankerSystemInstructions.length, inputChars: JSON.stringify(validatedInput).length, schemaChars: 0, sourceCount: validatedInput.event.sourceCount, originalContentChars: [], sentContentChars: [], truncated: [] },
      finalizeOutput: (generation, providerDiagnostics) => { const assembled = assembleRankingResult(validatedInput, generation, { now: options.now, activityHistory: options.activityHistory }); signals = assembled.signals; return { output: assembled.output, diagnostics: { ...providerDiagnostics, semanticGenerationValid: true, deterministicSignalsCalculated: true, finalRankingValid: rankingResultSchema.safeParse(assembled.output).success, importanceScore: assembled.output.importanceScore ?? undefined, sourceCount: assembled.signals.sourceCount, verificationStatus: validatedInput.verification.status, momentumAvailable: assembled.signals.momentumAvailable, formulaVersion: rankerFormulaVersion, dimensionScores: { impact: assembled.output.impact, novelty: assembled.output.novelty, reach: assembled.output.reach, credibility: assembled.output.credibility, economicImpact: assembled.output.economicImpact, momentum: assembled.output.momentum } } }; },
    });
    if (!signals) throw new Error("Ranker signals were not assembled");
    return { ...result, signals, formulaVersion: rankerFormulaVersion };
  }
}

export function createConfiguredRanker(logger?: AgentLogger): RankerAgent { return new RankerAgent(createConfiguredModelProvider(), logger); }
export { rankerAgentVersion, rankerFormulaVersion, rankerSystemInstructions } from "./ranker-prompt.ts";
export { rankerInputSchema, rankerGenerationSchema, activityHistorySignalSchema } from "./ranker-types.ts";
export type { RankerInput, RankerGeneration, ActivityHistorySignal } from "./ranker-types.ts";
