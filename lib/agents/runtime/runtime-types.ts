import type { Json } from "../../../types/database.ts";
import type { z } from "zod";
import type { ProviderId } from "./provider-cost-policy.ts";

export type AgentUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type RuntimeFailureKind =
  | "PROVIDER_HTTP_ERROR"
  | "LOCAL_JSON_PARSE_ERROR"
  | "LOCAL_SCHEMA_VALIDATION_ERROR"
  | "DETERMINISTIC_GROUNDING_REJECTION"
  | "SUCCESS";

export type AgentTelemetryStatus = RuntimeFailureKind | "TIMEOUT" | "FREE_TIER_LIMIT_REACHED" | "PROVIDER_CAPACITY_EXHAUSTED" | "RUNTIME_ERROR";
export type ProviderErrorCategory = "RATE_LIMIT" | "AUTH_ERROR" | "BAD_REQUEST" | "SERVER_ERROR" | "TIMEOUT" | "NETWORK_ERROR" | "INVALID_RESPONSE";

export type StructuredOutputMode = "strict_schema" | "best_effort_schema" | "json_object";
export type ReasoningEffort = "low" | "medium" | "high";

export type ZodIssueSummary = {
  path: Array<string | number>;
  code: string;
  expected?: string;
  receivedType?: string;
  options?: string[];
  unexpectedKeys?: string[];
  message: string;
};

export type RequestMetrics = {
  bodyBytes?: number;
  maxOutputTokensRequested?: number;
  systemPromptChars: number;
  inputChars: number;
  schemaChars: number;
  sourceCount: number;
  originalContentChars: number[];
  sentContentChars: number[];
  truncated: boolean[];
};

export type RateLimitHeaders = {
  retryAfter: string | null;
  limitRequests: string | null;
  remainingRequests: string | null;
  limitTokens: string | null;
  remainingTokens: string | null;
  resetRequests: string | null;
  resetTokens: string | null;
  retryAfterSeconds: number | null;
  resetRequestsSeconds: number | null;
  resetTokensSeconds: number | null;
  limitRequestsDay?: string | null;
  remainingRequestsDay?: string | null;
  resetRequestsDay?: string | null;
  limitTokensMinute?: string | null;
  remainingTokensMinute?: string | null;
  resetTokensMinute?: string | null;
};

/** Normalized Groq headers. RPD/TPM are explicit; this type does not imply RPM or TPD. */
export type ProviderRateLimitTelemetry = {
  requestLimitDaily: number | null;
  requestRemainingDaily: number | null;
  requestReset: string | null;
  requestResetSeconds: number | null;
  tokenLimitMinute: number | null;
  tokenRemainingMinute: number | null;
  tokenReset: string | null;
  tokenResetSeconds: number | null;
  retryAfterSeconds: number | null;
};

/** Latest dispatched provider response headers plus the timestamp used by shared freshness checks. */
export type ProviderRateLimitSnapshot = {
  observedAt: string;
  telemetry: ProviderRateLimitTelemetry;
};

export type ProviderDiagnostics = {
  provider?: string;
  providerUnit?: "requests" | "tokens" | "neurons" | null;
  providerUnitUsageKnown?: boolean;
  estimatedNeurons?: number | null;
  actualProviderUnitUsage?: number | null;
  errorCategory?: ProviderErrorCategory;
  httpStatus?: number;
  providerMessage?: string | null;
  providerType?: string | null;
  providerCode?: string | null;
  rateLimitHeaders?: RateLimitHeaders;
  providerRateLimit?: ProviderRateLimitTelemetry | null;
  requestMetrics?: RequestMetrics;
  usage?: AgentUsage;
  finishReason?: string | null;
  responseBodyBytes?: number;
  responseBodyChars?: number;
  responseJsonParseable?: boolean;
  contentJsonParseable?: boolean;
  responseTopLevelFields?: string[];
  responseMissingTopLevelFields?: string[];
  validationResult?: "not_run" | "valid" | "invalid";
  failureKind?: RuntimeFailureKind;
  structuredOutputMode?: StructuredOutputMode;
  reasoningEffort?: ReasoningEffort;
  includeReasoning?: boolean;
  providerRequestDispatched?: boolean;
  zodIssueCount?: number;
  zodIssues?: ZodIssueSummary[];
  invalidPaths?: string[];
  failedGenerationPresent?: boolean;
  failedGenerationType?: string | null;
  failedGenerationChars?: number | null;
  failedGenerationJsonParseable?: boolean | null;
  failedGenerationTopLevelFields?: string[];
  failedGenerationReason?: "max_completion_tokens_reached" | "schema_mismatch" | "missing_required_fields" | "no_choices" | "malformed_json" | null;
  failedGenerationMissingRequiredFields?: string[];
  generationSchemaValid?: boolean;
  finalTranslationResultValid?: boolean;
  translationAssemblySuccess?: boolean;
  editorialAssemblySuccess?: boolean;
  finalEditorialDraftValid?: boolean;
  generationOutputBytes?: number;
  factCountExpected?: number;
  factCountTranslated?: number;
  factCountGenerated?: number;
  expectedFactIndices?: number[];
  receivedFactIndices?: number[];
  translatedSourceMaterialChars?: number;
  semanticGenerationValid?: boolean;
  deterministicSignalsCalculated?: boolean;
  finalRankingValid?: boolean;
  importanceScore?: number;
  sourceCount?: number;
  verificationStatus?: string;
  momentumAvailable?: boolean;
  formulaVersion?: string;
  deterministicPrechecksPassed?: boolean;
  semanticFindingsCount?: number;
  findingsCount?: number;
  issueFindingsCount?: number;
  unsupportedClaimFindingsCount?: number;
  finalCriticResultValid?: boolean;
  finalDecision?: string;
  warningsCount?: number;
  errorsCount?: number;
  criticalCount?: number;
  routedStage?: string | null;
  finalStatus?: string;
  routingVersion?: string;
  evidenceRefsValidated?: boolean;
  evidenceCatalogSize?: number;
  evidenceIndicesReceived?: number[];
  evidenceIndicesValid?: boolean;
  resolvedEvidenceRefsCount?: number;
  inventedEvidenceIndicesCount?: number;
  dimensionScores?: {
    impact: number;
    novelty: number;
    reach: number;
    credibility: number;
    economicImpact: number;
    momentum: number;
  };
  guardFailureType?: "NUMERIC_UNSUPPORTED_TOKEN" | "PRESERVED_NAME_MUTATED" | "EDITORIAL_UNGROUNDED_CONTENT";
  preservedNamesCount?: number;
  preservedNamesObservedCount?: number;
  omittedPreservedNames?: string[];
  mutatedPreservedNames?: string[];
  rejectedNumericClaims?: Array<{
    normalizedValue: string;
    observedForm: string;
    sourceStage: "draft" | "event" | "translation" | "verification";
    sourceField: string;
  }>;
  allowedNumericClaimCount?: number;
  rejectedNumericClaimCount?: number;
  matchedNumericProvenance?: Array<{
    outputObservedForm: string;
    outputCanonicalValue: string;
    inputObservedForm: string;
    inputCanonicalValue: string;
    claimType: string;
    sourceStage: string;
    sourceField: string;
    matchReason: string;
  }>;
  failureReasonCode?: string;
  rejectedToken?: string;
  normalizedToken?: string;
  tokenType?: string;
  draftField?: string;
  draftContext?: string;
  closestExactNormalizedMatches?: Array<{ normalizedValue: string; sourceStage: string; sourceField: string }>;
  provenanceSourcesChecked?: string[];
};

export type AgentTelemetry = {
  status: AgentTelemetryStatus;
  provider: string;
  providerUnit?: "requests" | "tokens" | "neurons" | null;
  providerUnitUsageKnown?: boolean | null;
  estimatedNeurons?: number | null;
  actualProviderUnitUsage?: number | null;
  providerRequestDispatched: boolean;
  errorCategory: ProviderErrorCategory | null;
  rateLimitHeaders: RateLimitHeaders | null;
  providerRateLimit?: ProviderRateLimitTelemetry | null;
  providerHttpStatus: number | null;
  model: string;
  agentVersion: string;
  structuredOutputMode: StructuredOutputMode | null;
  reasoningEffort: ReasoningEffort | null;
  includeReasoning: boolean | null;
  finishReason: string | null;
  providerRequestsUsed: number;
  attempts: number;
  retries: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  requestBytes: number | null;
  responseBytes: number | null;
  zodValid: boolean | null;
  startedAt: string;
  finishedAt: string;
};

export type ModelConfig = {
  model: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  temperature?: number;
  maxOutputTokens: number;
  dailyRequestLimit: number;
  failOnRateLimit: boolean;
  allowPaidFallback: boolean;
  /** Supervised mode may wait only on provider-reported TPM reset headers and within the runtime's fixed wait bound. */
  allowProviderPacingWait?: boolean;
  structuredOutputMode: StructuredOutputMode;
  reasoningEffort?: ReasoningEffort;
  includeReasoning?: boolean;
  /** Injected by the provider capacity policy; intentionally absent until its limits are configured. */
  groqCapacity?: GroqCapacityLimits;
};

export type GroqCapacityLimits = {
  requestHardLimit: number;
  requestSoftLimit: number;
  tokenHardLimit: number;
  tokenSoftLimit: number;
  /** Provider TPM is a live pacing ceiling, not a daily reservation limit. */
  tokenMinuteHardLimit?: number;
  /** Confirmed RPM is recorded for policy/readiness; the initial mode is sequential. */
  requestMinuteHardLimit?: number;
};

export type AgentRunMetadata = {
  agentName: string;
  agentVersion: string;
  eventKey: string | null;
  pipelineRunId?: string;
  attemptId?: string;
  model: string;
  provider?: string;
  dryRun: boolean;
};

export type GenerateStructuredRequest<T> = {
  systemInstructions: string;
  input: T;
  schema: z.ZodType<unknown>;
  schemaName: string;
  config: ModelConfig;
  requestMetrics?: RequestMetrics;
  signal?: AbortSignal;
  onRequestDispatched?: () => void | Promise<void>;
};

export type ModelProviderResponse<T> = {
  output: T;
  model: string;
  provider?: string;
  usage?: AgentUsage;
  diagnostics?: ProviderDiagnostics;
};

export type AgentExecutionResult<T> = {
  output: T;
  runId: string | null;
  agentName: string;
  agentVersion: string;
  model: string;
  providerRequestsUsed: number;
  attempts: number;
  latencyMs: number;
  usage?: AgentUsage;
  diagnostics?: ProviderDiagnostics;
  telemetry?: AgentTelemetry;
};

export type FinalizeStructuredOutput<TGenerated, TOutput> = (
  generatedOutput: TGenerated,
  diagnostics?: ProviderDiagnostics
) => { output: TOutput; diagnostics?: ProviderDiagnostics };

export type AgentLogLevel = "debug" | "info" | "warn" | "error";

export type AgentLogEntry = {
  level: AgentLogLevel;
  step: string;
  message: string;
  payload?: Json;
  durationMs?: number;
};

export type RequestReservation = {
  allowed: boolean;
  dailyCount: number;
  dailyLimit: number | null;
  requestDate: string;
  reservationId?: number;
  reason?: string | null;
};

export type GroqCapacityReservation = RequestReservation & {
  admitted: boolean;
  quotaPeriodUtc: string;
  requestUsageBefore: number;
  requestUsageAfter: number;
  tokenUsageBefore: number;
  tokenUsageAfter: number;
  reservedTokens: number;
  requestHardLimit: number;
  requestSoftLimit: number;
  tokenHardLimit: number;
  tokenSoftLimit: number;
  minuteTokenUsageBefore: number;
  minuteTokenUsageAfter: number;
  minuteTokenHardLimit: number;
  safetyMarginTokens: number;
};

export type GroqTokenSettlementResult = {
  settled: true;
  changed: boolean;
  actualTokens: number;
  reservedTokensBefore: number;
  accountedTokens: number;
  deltaTokens: number;
};

export type ProviderCapacityReservationContext = {
  provider: "cloudflare_workers_ai";
  requestLimit: number | null;
  hardNeuronLimit: number;
  neuronLimit: number;
  estimatedNeurons: number;
};

export type DailyRequestAvailability = {
  requestDate: string;
  dailyLimit: number;
  used: number;
  remaining: number;
};

export interface AgentLogger {
  startRun(metadata: AgentRunMetadata, startedAt: string): Promise<string | null>;
  reserveRequest(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    dailyLimit: number,
    requestDate: string,
    capacity?: ProviderCapacityReservationContext
  ): Promise<RequestReservation>;
  reserveProviderRequest?(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    dailyLimit: number,
    requestDate: string,
    provider: "groq"
  ): Promise<RequestReservation>;
  reserveGroqCapacity?(
    runId: string | null,
    metadata: AgentRunMetadata,
    attempt: number,
    requestDate: string,
    limits: GroqCapacityLimits,
    estimatedTokens: number
  ): Promise<GroqCapacityReservation>;
  releaseRequest(runId: string | null, reservationId: number, requestDate: string): Promise<boolean>;
  releaseGroqCapacityPreDispatch?(runId: string | null, reservationId: number, requestDate: string): Promise<boolean>;
  markRequestDispatched(runId: string | null, reservationId: number, requestDate: string): Promise<boolean>;
  settleGroqTokenUsage?(
    runId: string | null,
    reservationId: number,
    requestDate: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<GroqTokenSettlementResult>;
  getRemainingRequests(dailyLimit: number, requestDate: string): Promise<DailyRequestAvailability>;
  getProviderDailyUsage?(provider: ProviderId, dateUtc: string): Promise<{
    provider: ProviderId;
    dateUtc: string;
    requestsReserved: number;
    requestsDispatched: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    tokenUsageKnown: boolean;
    unknownTokenRequests: number;
    neuronsUsed?: number;
    neuronUsageKnown?: boolean;
  }>;
  getProviderRateLimitState?(provider: ProviderId): Promise<{ blockedUntil: string | null } | null>;
  getLatestProviderRateLimitTelemetry?(provider: ProviderId, eventKey: string): Promise<ProviderRateLimitTelemetry | null>;
  getLatestProviderRateLimitSnapshot?(provider: ProviderId): Promise<ProviderRateLimitSnapshot | null>;
  log(runId: string | null, metadata: AgentRunMetadata, entry: AgentLogEntry): Promise<void>;
  finishRun(
    runId: string | null,
    metadata: AgentRunMetadata,
    status: "succeeded" | "failed",
    finishedAt: string,
    stats?: Json,
    errorMessage?: string
  ): Promise<void>;
}
