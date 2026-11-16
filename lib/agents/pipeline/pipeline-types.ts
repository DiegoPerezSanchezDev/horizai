import { z } from "zod";
import type { ClusterRunResult } from "../clustering/cluster-types.ts";
import type { DiscoveryRunResult } from "../discovery/discovery-types.ts";
import type { ExtractionRunResult } from "../extraction/extraction-types.ts";
import type { CriticResult, EditorialDraft, ClassificationResult, ClusteredEvent, ExtractedItem, PublicationPayload, RankingResult, TranslationResult, VerificationResult } from "../contracts/index.ts";
import type { AgentLogEntry, AgentLogger, AgentTelemetry } from "../runtime/runtime-types.ts";
import type { EventProviderAssignment } from "../runtime/free-provider-router.ts";
import type { ProviderId } from "../runtime/provider-cost-policy.ts";
import type { PublisherExecutionResult } from "../publisher/publisher-types.ts";
import type { VerifierSourceMetadata } from "../verifier/verifier-types.ts";
import type { PipelineEventAttemptRegistry } from "./event-attempt-repository.ts";
import type { CapacityResumeSnapshot } from "./provider-capacity-resume.ts";
import type { FactualRemediationAttemptGuard } from "./factual-remediation.ts";
import type { CriticInput } from "../critic/critic-types.ts";
import type { assessCandidateEvidence } from "../extraction/evidence-quality.ts";

/** Internal pipeline metadata keeps the raw-item identity needed by later checkpoints. */
export type PipelineSourceMetadata = VerifierSourceMetadata & { sourceItemId: string; rawItemId: string | null };

export const pipelineStageSchema = z.enum(["discovery", "extraction", "clustering", "verifier", "translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"]);
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

export const pipelineRunStateSchema = z.enum(["PENDING", "RUNNING", "SUCCESS", "SKIPPED", "FAILED", "BLOCKED"]);
export type PipelineRunState = z.infer<typeof pipelineRunStateSchema>;

export const pipelineStageStatusSchema = z.enum(["not_started", "running", "success", "skipped", "failed"]);
export type PipelineStageStatus = z.infer<typeof pipelineStageStatusSchema>;

export type PipelineConfig = {
  /** Opt-in lifecycle. SUPERVISED always stops after a passing Critic and records a private review. */
  mode?: "standard" | "supervised";
  dryRun: boolean;
  publish: boolean;
  hours: number;
  limit: number;
  trigger?: "manual" | "scheduled" | "retry";
  automaticRevision: boolean;
  maxRevisionAttempts: number;
};

export type PipelineRunContext = {
  schemaVersion: 1;
  runId: string;
  dryRun: boolean;
  startedAt: string;
  trigger: "manual" | "scheduled" | "retry";
  agentVersions: Record<string, string>;
};

export type PipelineStageState = {
  status: PipelineStageStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  requestCount: number;
  checkpointWritten: boolean;
  errorCode: string | null;
};

export type CheckpointVerification = {
  stage: PipelineStage;
  path: string | null;
  eventKey: string;
  written: boolean;
  readable: boolean;
  valid: boolean;
};

export type PipelineStageOutcome<T> = {
  output: T;
  eventKey: string;
  agentVersion: string;
  model: string;
  provider?: ProviderId;
  attempts: number;
  retries: number;
  providerRequestsUsed: number;
  latencyMs: number;
  telemetry?: AgentTelemetry;
  checkpoint?: () => Promise<CheckpointVerification>;
};

export type PipelineEventContext = {
  /** Attempt currently owning this event; persisted with each Critic proof. */
  eventAttemptId?: string;
  providerAssignment?: EventProviderAssignment;
  factualRemediationTarget?: {
    attemptId: string;
    pipelineRunId: string;
    resumeExecutionId?: string;
    articleId: string;
    articleSlug: string;
    continuation?: true;
  };
  criticInputOverride?: CriticInput;
  /** Runtime-restored settled usage and immutable checkpoints for post-Critic review construction. */
  providerAccounting?: Partial<Record<"verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic", AgentTelemetry>>;
  durableCheckpoints?: Partial<Record<PipelineStage, CheckpointVerification>>;
  event: ClusteredEvent;
  items: ExtractedItem[];
  sources: PipelineSourceMetadata[];
  verification?: VerificationResult;
  translation?: TranslationResult;
  editorial?: EditorialDraft;
  classification?: ClassificationResult;
  geo?: GeoStageOutput;
  ranking?: RankingResult;
  critic?: CriticResult;
};

export type GeoStageOutput = {
  eventKey: string;
  primaryRegionCode: string | null;
  countryCodes: string[];
  latitude: number | null;
  longitude: number | null;
  resolutionLevel: "global" | "region" | "country" | "unresolved";
  resolvedFrom: "country_registry" | "region_registry" | null;
  provenance: "classifier" | "reference_registry" | "unresolved";
};

export type PipelineStageInput = {
  run: PipelineRunContext;
  config: PipelineConfig;
};

export type PipelineStages = {
  discovery: (input: PipelineStageInput) => Promise<DiscoveryRunResult>;
  extraction: (input: PipelineStageInput & { discovery: DiscoveryRunResult }) => Promise<ExtractionRunResult>;
  clustering: (input: PipelineStageInput & { extraction: ExtractionRunResult }) => Promise<ClusterRunResult>;
  sourceMetadata: (event: ClusteredEvent, items: ExtractedItem[], rawItemIds?: ReadonlyMap<string, string | null>) => PipelineSourceMetadata[];
  verifier: (context: PipelineEventContext, run: PipelineRunContext) => Promise<PipelineStageOutcome<VerificationResult>>;
  translator: (context: PipelineEventContext, run: PipelineRunContext) => Promise<PipelineStageOutcome<TranslationResult>>;
  editor: (context: PipelineEventContext, run: PipelineRunContext) => Promise<PipelineStageOutcome<EditorialDraft>>;
  classifier: (context: PipelineEventContext, run: PipelineRunContext) => Promise<PipelineStageOutcome<ClassificationResult>>;
  geo: (context: PipelineEventContext, run: PipelineRunContext) => Promise<PipelineStageOutcome<GeoStageOutput>>;
  ranker: (context: PipelineEventContext, run: PipelineRunContext) => Promise<PipelineStageOutcome<RankingResult>>;
  critic: (context: PipelineEventContext, run: PipelineRunContext) => Promise<PipelineStageOutcome<CriticResult>>;
  publisher: (context: PipelineEventContext & { publicationPayload?: PublicationPayload }, run: PipelineRunContext, options: { dryRun: boolean }) => Promise<PipelineStageOutcome<PublisherExecutionResult>>;
};

export type StageTelemetrySummary = {
  agentVersion: string;
  model: string;
  attempts: number;
  retries: number;
  providerRequestsUsed: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  latencyMs: number;
  status: "success" | "failed" | "skipped";
};

export type PipelineEventResult = {
  attemptId?: string;
  evidenceQuality?: ReturnType<typeof assessCandidateEvidence>;
  eventKey: string;
  finalState: "SUCCESS" | "SKIPPED" | "FAILED" | "BLOCKED" | "BLOCKED_REVISION_REQUIRED" | "BLOCKED_REVISION_LIMIT" | "BLOCKED_REJECTED" | "BLOCKED_INSUFFICIENT_DAILY_BUDGET" | "DEFERRED_PROVIDER_CAPACITY" | "DEFERRED_WORKER_TIME_BUDGET" | "READY_FOR_PUBLICATION_DRY_RUN" | "WAITING_FOR_HUMAN_REVIEW";
  stopStage: PipelineStage | "human_review" | null;
  stopReason: string | null;
  criticDecision: CriticResult["decision"] | null;
  publicationOutcome: PublisherExecutionResult["summary"]["idempotencyOutcome"] | null;
  requestsUsed: number;
  checkpoints: Partial<Record<PipelineStage, CheckpointVerification>>;
  telemetry: Partial<Record<PipelineStage, StageTelemetrySummary>>;
  failure?: PipelineFailureSummary;
  persistenceFailure?: PipelineAttemptPersistenceFailure;
  revisionRequired: boolean;
  revisionStage: string | null;
  revision?: PipelineRevisionSummary;
  humanReviewId?: string;
  reviewPackageSha256?: string;
  capacityResumeSnapshotPath?: string;
  /** Internal handoff to the attempt RPC; stripped before the run result is returned. */
  capacityResumeSnapshot?: CapacityResumeSnapshot;
};

export type PipelineAttemptPersistenceFailure = {
  operation: "CAPACITY_DEFER" | "FINALIZE";
  errorCode: string;
  databaseCode: string | null;
  commitState: "NOT_COMMITTED" | "UNKNOWN";
};

export type PipelineRevisionSummary = {
  revisionRequired: boolean;
  revisionRequestedStage: string | null;
  revisionAttempt: number;
  maxRevisionAttempts: number;
  revisionRequestsRequired: number;
  revisionBudgetAllowed: boolean;
  revisionStarted: boolean;
  revisionCompleted: boolean;
  revisionFinalDecision: CriticResult["decision"] | null;
  checkpointsToInvalidate: PipelineStage[];
  preservedCheckpoints: PipelineStage[];
};

export type PipelineFailureSummary = {
  stage: PipelineStage;
  errorCode: string;
  errorMessage: string;
  providerRequestDispatched: boolean;
  providerRequestsUsed: number;
  attempts: number;
  retries: number;
  httpStatus: number | null;
  checkpointWritten: boolean;
  invalidPaths: string[];
  telemetry?: AgentTelemetry;
};

export type PipelineStageStats = {
  status: PipelineStageStatus;
  count: number;
  failures: number;
  skips: number;
  requests: number;
  totalLatencyMs: number;
};

export type PipelineExtractionSummary = {
  candidatesSelected: number;
  extractedItems: number;
  successfulResults: number;
  blockedResults: number;
  failedResults: number;
  errorCodeCounts: Record<string, number>;
  persisted: number;
  persistUpdated?: number;
  persistSkipped: number;
  persistErrors: number;
  extractionAttempts?: number;
  unexpectedResults?: number;
  extractionSucceeded?: number;
  extractionFailed?: number;
  extractionSkipped?: number;
  rawItemsTouched?: number;
  rawItemsInserted?: number;
  rawItemsUpdated?: number;
  rawItemsReused?: number;
  rawItemPersistenceErrors?: number;
  candidateOutcomes?: PipelineCandidateExtractionOutcome[];
};

export type PipelineDiscoverySummary = {
  discoveredCandidates: number;
  candidatesAfterDeduplication: number;
  duplicateUrls: number;
  duplicateContentHashes: number;
  invalidCandidates: number;
  undatedExcluded: number;
  rawItemsInserted: number;
  rawItemsUpdated: number;
  rawItemsReused: number;
  rawItemPersistenceErrors: number;
  rawItemsTouched: number;
};

export type PipelineCandidateExtractionOutcome = {
  candidateId: string;
  sourceId: string;
  rawItemId: string | null;
  discoveryRawItemMapping: "CREATED" | "UPDATED" | "REUSED" | "FAILED" | "NOT_REQUESTED" | "NOT_RECORDED";
  extractionRawItemMapping: "CREATED" | "UPDATED" | "REUSED" | "FAILED" | "NOT_REQUESTED" | "NOT_RECORDED";
  extractionAttempted: boolean;
  fetchOutcome: "SUCCEEDED" | "BLOCKED" | "FAILED" | "METADATA_FALLBACK" | "NOT_ATTEMPTED" | "UNKNOWN";
  extractionOutcome: "SUCCEEDED" | "FAILED" | "NOT_ATTEMPTED" | "UNRESOLVED";
  failureCode: string | null;
  parserOutcome: "SUCCEEDED" | "FAILED" | "NOT_REACHED" | "UNKNOWN";
  qualityGateOutcome: "ELIGIBLE" | "INSUFFICIENT" | "NOT_REACHED" | "UNKNOWN";
  terminalOutcome: "EXTRACTION_SUCCEEDED" | "FETCH_BLOCKED" | "FETCH_FAILED" | "EMPTY_BODY" | "PARSER_FAILED" | "PERSISTENCE_FAILED" | "NOT_ATTEMPTED" | "RUNTIME_ERROR_UNRESOLVED" | "OTHER_FAILURE";
};

export type PipelineRunResult = {
  runId: string;
  startedAt: string;
  completedAt: string;
  finalState: "SUCCESS" | "SUCCESS_WITH_FAILURES" | "BLOCKED_BUDGET" | "DEFERRED_PROVIDER_CAPACITY" | "DEFERRED_WORKER_TIME_BUDGET" | "FAILED";
  candidatesDiscovered: number;
  extractedItems: number;
  extractionSummary: PipelineExtractionSummary | null;
  discoverySummary?: PipelineDiscoverySummary | null;
  clusteredEvents: number;
  eventsAttempted: number;
  eventsPublished: number;
  eventsDryRunReady: number;
  eventsAwaitingHumanReview: number;
  eventsSkipped: number;
  eventsFailed: number;
  eventsBlocked: number;
  providerRequestsUsed: number;
  stageStats: Record<PipelineStage, PipelineStageStats>;
  eventResults: PipelineEventResult[];
  quotaBefore: number | null;
  quotaAfter: number | null;
};

export type PipelineQuota = {
  /** Persistent admission quota for the currently composed Groq-only pipeline. */
  provider?: "groq";
  remaining(): Promise<number>;
};

export type PipelinePersistence = {
  start(run: PipelineRunContext): Promise<string | null>;
  log(runId: string | null, entry: AgentLogEntry): Promise<void>;
  finish(runId: string | null, result: PipelineRunResult): Promise<void>;
};

export type PipelineOrchestratorOptions = {
  stages: PipelineStages;
  config?: Partial<PipelineConfig>;
  quota?: PipelineQuota;
  persistence?: PipelinePersistence;
  now?: () => Date;
  runId?: string;
  agentVersions?: Record<string, string>;
  attemptRegistry?: PipelineEventAttemptRegistry;
  factualRemediationAttemptGuard?: FactualRemediationAttemptGuard;
  humanReviewGateway?: import("../publisher/human-review.ts").HumanReviewGateway;
  capacityResumeSnapshotWriter?: (snapshot: Omit<import("./provider-capacity-resume.ts").CapacityResumeSnapshot, "checkpointSha256"> & { checkpointSha256?: Partial<Record<import("./provider-capacity-resume.ts").CapacityResumeCheckpointStage, string>> }) => Promise<{ path: string; sha256: string }>;
  /** Production worker budget gate called immediately before each semantic provider stage. */
  shouldStartSemanticStage?: (stage: Extract<PipelineStage, "verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic">) => boolean;
};

export type AgentLoggerPersistence = {
  logger: AgentLogger;
};
