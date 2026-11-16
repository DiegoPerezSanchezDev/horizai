import type { AgentExecutionResult, AgentTelemetry, ProviderDiagnostics } from "./runtime-types.ts";

export type AgentErrorCode =
  | "missing_configuration"
  | "timeout"
  | "invalid_structured_output"
  | "EDITOR_GROUNDING_REJECTED"
  | "provider_transient"
  | "provider_permanent"
  | "FREE_TIER_LIMIT_REACHED"
  | "DAILY_REQUEST_LIMIT_REACHED"
  | "PROVIDER_CAPACITY_EXHAUSTED"
  | "translator_precondition_failed"
  | "checkpoint_failed"
  | "cost_guard_violation"
  | "FACTUAL_REMEDIATION_CRITIC_USAGE_UNKNOWN"
  | "GROQ_TPM_STATE_UNKNOWN"
  | "GROQ_TEMPORARILY_BLOCKED"
  | "VERIFIER_INPUT_TOO_LARGE"
  | "PAID_PROVIDER_FORBIDDEN";

export type AgentFailureDetails = {
  attempts: number;
  latencyMs: number;
  providerRequestsUsed?: number;
  diagnostics?: ProviderDiagnostics;
  telemetry?: AgentTelemetry;
};

const failureDetails = new WeakMap<object, AgentFailureDetails>();

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly causeValue: unknown;
  readonly diagnostics?: ProviderDiagnostics;

  constructor(code: AgentErrorCode, message: string, causeValue?: unknown, diagnostics?: ProviderDiagnostics) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.causeValue = causeValue;
    this.diagnostics = diagnostics;
  }
}

export class MissingAgentConfigurationError extends AgentError {
  readonly missingVariables: string[];

  constructor(missingVariables: string[]) {
    super("missing_configuration", `Missing agent configuration: ${missingVariables.join(", ")}`);
    this.name = "MissingAgentConfigurationError";
    this.missingVariables = missingVariables;
  }
}

export class AgentTimeoutError extends AgentError {
  constructor(timeoutMs: number) {
    super("timeout", `Agent call timed out after ${timeoutMs} ms`);
    this.name = "AgentTimeoutError";
  }
}

export class StructuredOutputError extends AgentError {
  readonly issues: string[];

  constructor(issues: string[], diagnostics?: ProviderDiagnostics) {
    super("invalid_structured_output", "Provider output did not match the requested schema", undefined, {
      ...diagnostics,
      validationResult: "invalid",
      failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR",
    });
    this.name = "StructuredOutputError";
    this.issues = issues;
  }
}

export class TransientProviderError extends AgentError {
  readonly diagnostics?: ProviderDiagnostics;

  constructor(message: string, causeValue?: unknown, diagnostics?: ProviderDiagnostics) {
    super("provider_transient", message, causeValue);
    this.name = "TransientProviderError";
    this.diagnostics = diagnostics;
  }
}

export class PermanentProviderError extends AgentError {
  readonly diagnostics?: ProviderDiagnostics;

  constructor(message: string, causeValue?: unknown, diagnostics?: ProviderDiagnostics) {
    super("provider_permanent", message, causeValue);
    this.name = "PermanentProviderError";
    this.diagnostics = diagnostics;
  }
}

export class FreeTierLimitReachedError extends AgentError {
  readonly diagnostics?: ProviderDiagnostics;

  constructor(diagnostics?: ProviderDiagnostics) {
    super("FREE_TIER_LIMIT_REACHED", "Free-tier provider rate limit reached");
    this.name = "FreeTierLimitReachedError";
    this.diagnostics = diagnostics;
  }
}

export class PaidProviderForbiddenError extends AgentError {
  constructor() {
    super("PAID_PROVIDER_FORBIDDEN", "Provider, endpoint, or model is not approved for free-only use");
    this.name = "PaidProviderForbiddenError";
  }
}

export function isRetryableAgentError(error: unknown): boolean {
  return error instanceof AgentError && ["timeout", "invalid_structured_output", "provider_transient"].includes(error.code);
}

export function errorSummary(error: unknown): { code: string; message: string } {
  if (error instanceof AgentError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "unknown", message: error.message };
  return { code: "unknown", message: "Unknown agent error" };
}

export function setAgentFailureDetails(error: unknown, details: AgentFailureDetails): void {
  if (typeof error === "object" && error !== null) failureDetails.set(error, details);
}

export function getProviderDiagnostics(error: unknown): ProviderDiagnostics | undefined {
  if (error instanceof AgentError && error.diagnostics) return error.diagnostics;
  if (error instanceof PermanentProviderError || error instanceof FreeTierLimitReachedError || error instanceof TransientProviderError) return error.diagnostics;
  return undefined;
}

export function getAgentFailureDetails(error: unknown): AgentFailureDetails {
  if (typeof error === "object" && error !== null) return failureDetails.get(error) ?? { attempts: 0, latencyMs: 0 };
  return { attempts: 0, latencyMs: 0 };
}

/**
 * Carries post-provider execution evidence across deterministic agent guards.
 * A guard may run after runStructuredAgent has already returned successfully;
 * without this enrichment the pipeline would lose the request telemetry.
 */
export function attachAgentExecutionDetails<T>(error: unknown, result: AgentExecutionResult<T>): void {
  const guardDiagnostics = getProviderDiagnostics(error);
  setAgentFailureDetails(error, {
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    providerRequestsUsed: result.providerRequestsUsed,
    diagnostics: { ...result.diagnostics, ...guardDiagnostics, providerRequestDispatched: result.providerRequestsUsed > 0 },
    telemetry: result.telemetry,
  });
}
