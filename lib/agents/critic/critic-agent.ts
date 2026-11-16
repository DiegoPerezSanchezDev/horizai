import { criticResultSchema, type CriticResult } from "../contracts/index.ts";
import { createConfiguredModelProvider, type ModelProvider } from "../runtime/model-provider.ts";
import { runStructuredAgent } from "../runtime/agent-runner.ts";
import { buildAgentTelemetry } from "../runtime/telemetry.ts";
import type { AgentExecutionResult, AgentLogger, ModelConfig, ProviderDiagnostics } from "../runtime/runtime-types.ts";
import { FREE_TIER_MAX_OUTPUT_TOKENS, readGroqDailyRequestHardCap, readStructuredOutputMode, validateCostGuardConfig, type DailyRequestBudget, type ProviderScopedDailyRequestBudget } from "../runtime/request-budget.ts";
import { loadActiveReferenceRegistry, type ReferenceRegistry } from "../classifier/geo-registry.ts";
import { criticAgentVersion, criticRoutingVersion, criticSystemInstructions } from "./critic-prompt.ts";
import { buildCriticModelInput } from "./critic-input.ts";
import { resolveCriticGeneration } from "./critic-evidence-catalog.ts";
import { runCriticPrechecks } from "./critic-prechecks.ts";
import { criticCurrentGenerationSchema, criticInputSchema, type CriticGeneration, type CriticInput, type CriticModelInput, type CriticPrecheckResult, type CriticResolvedGeneration } from "./critic-types.ts";
import { routeCritic, validateCriticEvidenceRefs } from "./critic-router.ts";

function numberEnv(name: string, fallback: number, maximum?: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) throw new Error(`${name} must be a finite non-negative number`);
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
  const model = process.env.AGENT_MODEL_CRITIC?.trim();
  if (!model) throw new Error("Missing agent configuration: AGENT_MODEL_CRITIC");
  return model;
}

export function getCriticModelConfig(): ModelConfig {
  const reasoningEffort = reasoningEffortEnv("AGENT_REASONING_EFFORT_CRITIC");
  const includeReasoning = process.env.AGENT_INCLUDE_REASONING_CRITIC?.trim();
  const config: ModelConfig = {
    model: requiredModel(),
    timeoutMs: numberEnv("AGENT_TIMEOUT_MS", 30_000),
    maxRetries: integerEnv("AGENT_MAX_RETRIES", 2, 2),
    retryBackoffMs: numberEnv("AGENT_RETRY_BACKOFF_MS", 250),
    maxOutputTokens: integerEnv("AGENT_MAX_OUTPUT_TOKENS", FREE_TIER_MAX_OUTPUT_TOKENS, FREE_TIER_MAX_OUTPUT_TOKENS),
    dailyRequestLimit: readGroqDailyRequestHardCap(),
    failOnRateLimit: booleanEnv("AGENT_FAIL_ON_RATE_LIMIT", true),
    allowPaidFallback: booleanEnv("AGENT_ALLOW_PAID_FALLBACK", false),
    structuredOutputMode: readStructuredOutputMode(process.env.AGENT_STRUCTURED_OUTPUT_CRITIC ?? process.env.AGENT_STRUCTURED_OUTPUT_MODE, "json_object"),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(includeReasoning ? { includeReasoning: booleanEnv("AGENT_INCLUDE_REASONING_CRITIC", false) } : {}),
  };
  validateCostGuardConfig(config);
  return config;
}

export type CriticRunOptions = { dryRun?: boolean; modelConfig?: ModelConfig; requestBudget?: DailyRequestBudget | ProviderScopedDailyRequestBudget; registry?: ReferenceRegistry; pipelineRunId?: string; attemptId?: string };
export type CriticExecutionResult = AgentExecutionResult<CriticResult> & { prechecks: CriticPrecheckResult; routedStage: string | null; generation: CriticGeneration };

function sourceIdsForRefs(input: CriticInput, refs: string[]): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    const match = /^(verifiedFact|uncertainClaim|contradiction|translatedFact|source):(\d+)$/.exec(ref);
    if (!match) continue;
    const index = Number(match[2]);
    if (match[1] === "source") {
      const source = input.sources[index];
      if (source) ids.add(source.sourceId);
    } else if (match[1] === "translatedFact") {
      const fact = input.translation.translatedFacts[index];
      if (fact?.sourceItemId) {
        const source = input.sources.find((candidate) => candidate.sourceItemId === fact.sourceItemId);
        if (source) ids.add(source.sourceId);
      }
    } else {
      const kind = match[1] as "verifiedFact" | "uncertainClaim" | "contradiction";
      const claims = input.verification[kind === "verifiedFact" ? "verifiedFacts" : kind === "uncertainClaim" ? "uncertainClaims" : "contradictions"];
      claims[index]?.sourceIds.forEach((id) => ids.add(id));
    }
  }
  return [...ids];
}

function assembleCriticResult(input: CriticInput, prechecks: CriticPrecheckResult, generation: CriticResolvedGeneration): { output: CriticResult; routedStage: string | null; diagnostics: ProviderDiagnostics } {
  validateCriticEvidenceRefs(input, generation);
  const routing = routeCritic(input, prechecks.issues, generation);
  const issueFindings = generation.findings.filter((finding) => finding.kind === "issue");
  const unsupportedFindings = generation.findings.filter((finding) => finding.kind === "unsupported_claim");
  const derivedUnsupportedIssues = unsupportedFindings.map((finding) => ({
    code: `UNSUPPORTED_CLAIM_${finding.stage.toUpperCase()}`,
    field: finding.stage,
    severity: finding.severity,
    message: `Unsupported claim: ${finding.claim}. ${finding.reason}`,
  }));
  const findings = [...prechecks.issues.map((finding) => ({ ...finding, field: finding.stage })), ...issueFindings.map((finding) => ({ code: `${finding.stage}_${finding.dimension.toLowerCase()}`, field: finding.stage, severity: finding.severity, message: finding.message })), ...derivedUnsupportedIssues];
  const issues = findings.map((finding) => {
    return { code: finding.code, field: finding.field, severity: finding.severity, message: finding.message };
  });
  const unsupportedClaims = unsupportedFindings.map((claim) => ({ claim: claim.claim, reason: claim.reason, sourceIds: sourceIdsForRefs(input, claim.evidenceRefs) }));
  const output = criticResultSchema.parse({ schemaVersion: 1, eventKey: input.event.eventKey, decision: routing.decision, issues, unsupportedClaims, severity: routing.severity, notes: `${routing.reason} Routing version ${criticRoutingVersion}.` });
  const diagnostics: ProviderDiagnostics = {
    deterministicPrechecksPassed: prechecks.passed,
    semanticFindingsCount: generation.findings.length,
    findingsCount: generation.findings.length,
    issueFindingsCount: issueFindings.length,
    unsupportedClaimFindingsCount: unsupportedFindings.length,
    finalCriticResultValid: true,
    finalDecision: routing.decision,
    warningsCount: generation.findings.filter((finding) => finding.severity === "low" || finding.severity === "medium").length,
    errorsCount: findings.filter((finding) => finding.severity === "high").length,
    criticalCount: findings.filter((finding) => finding.severity === "critical").length,
    routedStage: routing.routedStage,
    finalStatus: routing.decision,
    routingVersion: criticRoutingVersion,
    evidenceRefsValidated: true,
  };
  return { output, routedStage: routing.routedStage, diagnostics };
}

export class CriticAgent {
  private readonly provider: ModelProvider;
  private readonly logger?: AgentLogger;
  constructor(provider: ModelProvider, logger?: AgentLogger) { this.provider = provider; this.logger = logger; }

  async critique(input: CriticInput, options: CriticRunOptions = {}): Promise<CriticExecutionResult> {
    const validatedInput = criticInputSchema.parse(input);
    const modelConfig = options.modelConfig ?? getCriticModelConfig();
    const registry = options.registry ?? await loadActiveReferenceRegistry();
    const prechecks = runCriticPrechecks(validatedInput, { registry });
    if (!prechecks.passed) {
      const assembled = assembleCriticResult(validatedInput, prechecks, { findings: [] });
      const startedAt = new Date().toISOString();
      const finishedAt = new Date().toISOString();
      const diagnostics = { ...assembled.diagnostics, structuredOutputMode: modelConfig.structuredOutputMode, reasoningEffort: modelConfig.reasoningEffort, includeReasoning: modelConfig.includeReasoning, validationResult: "valid" as const };
      const telemetry = buildAgentTelemetry({ status: "SUCCESS", model: modelConfig.model, agentVersion: criticAgentVersion, config: modelConfig, diagnostics, attempts: 0, latencyMs: 0, startedAt, finishedAt });
      let runId: string | null = null;
      try {
        runId = await this.logger?.startRun({ agentName: "critic", agentVersion: criticAgentVersion, eventKey: validatedInput.event.eventKey, ...(options.pipelineRunId ? { pipelineRunId: options.pipelineRunId } : {}), ...(options.attemptId ? { attemptId: options.attemptId } : {}), model: modelConfig.model, dryRun: options.dryRun ?? true }, startedAt) ?? null;
        if (runId) {
          await this.logger?.log(runId, { agentName: "critic", agentVersion: criticAgentVersion, eventKey: validatedInput.event.eventKey, model: modelConfig.model, dryRun: options.dryRun ?? true }, { level: "warn", step: "deterministic_precheck_failed", message: "Critic routed without a model call because an authoritative precheck failed", payload: { telemetry, issues: prechecks.issues, routedStage: assembled.routedStage } });
          await this.logger?.finishRun(runId, { agentName: "critic", agentVersion: criticAgentVersion, eventKey: validatedInput.event.eventKey, model: modelConfig.model, dryRun: options.dryRun ?? true }, "succeeded", finishedAt, { telemetry, deterministicPrechecksPassed: false, finalStatus: assembled.output.decision, routedStage: assembled.routedStage, routingVersion: criticRoutingVersion });
        }
      } catch {
        // A deterministic fail-closed decision remains valid if observability is unavailable.
      }
      return { output: assembled.output, runId, agentName: "critic", agentVersion: criticAgentVersion, model: modelConfig.model, providerRequestsUsed: 0, attempts: 0, latencyMs: 0, diagnostics, telemetry, prechecks, routedStage: assembled.routedStage, generation: { findings: [] } };
    }
    const builtInput = buildCriticModelInput(validatedInput);
    let generatedOutput: CriticGeneration = { findings: [] };
    const result = await runStructuredAgent<CriticModelInput, CriticGeneration, CriticResult>({
      agentName: "critic", agentVersion: criticAgentVersion, eventKey: validatedInput.event.eventKey, input: builtInput.input, systemInstructions: criticSystemInstructions, schemaName: "CriticGenerationV3", schema: criticCurrentGenerationSchema, modelConfig, provider: this.provider, logger: this.logger, dryRun: options.dryRun ?? true, requestBudget: options.requestBudget,
      pipelineRunId: options.pipelineRunId,
      attemptId: options.attemptId,
      requestMetrics: { systemPromptChars: criticSystemInstructions.length, inputChars: JSON.stringify(builtInput.input).length, schemaChars: 0, sourceCount: validatedInput.sources.length, originalContentChars: [validatedInput.editorial.bodyEs.length], sentContentChars: [builtInput.input.editorial.bodyEs.length], truncated: [builtInput.bodyTruncated] },
      generatedOutputDiagnostics: (value) => {
        const parsed = criticCurrentGenerationSchema.safeParse(value);
        const received = parsed.success ? parsed.data.findings.flatMap((finding) => finding.evidenceIndices) : [];
        const invalid = received.filter((index) => !builtInput.evidenceCatalog[index]);
        return { evidenceCatalogSize: builtInput.evidenceCatalog.length, evidenceIndicesReceived: received, evidenceIndicesValid: parsed.success && invalid.length === 0, inventedEvidenceIndicesCount: invalid.length };
      },
      finalizeOutput: (generation, providerDiagnostics) => {
        generatedOutput = generation;
        const resolved = resolveCriticGeneration(builtInput.evidenceCatalog, generation);
        const assembled = assembleCriticResult(validatedInput, prechecks, resolved.generation);
        return { output: assembled.output, diagnostics: { ...providerDiagnostics, ...assembled.diagnostics, semanticGenerationValid: true, evidenceIndicesReceived: resolved.evidenceIndicesReceived, evidenceIndicesValid: true, resolvedEvidenceRefsCount: resolved.resolvedEvidenceRefsCount } };
      },
    });
    const routedStage = result.diagnostics?.routedStage ?? null;
    return { ...result, prechecks, routedStage, generation: generatedOutput };
  }
}

export function createConfiguredCritic(logger?: AgentLogger): CriticAgent { return new CriticAgent(createConfiguredModelProvider(), logger); }
export { criticAgentVersion, criticRoutingVersion, criticSystemInstructions } from "./critic-prompt.ts";
export { criticInputSchema, criticModelInputSchema, criticGenerationSchema } from "./critic-types.ts";
export type { CriticInput, CriticModelInput, CriticGeneration } from "./critic-types.ts";
