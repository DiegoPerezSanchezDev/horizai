import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CloudflareWorkersAIModelProvider } from "../lib/agents/runtime/cloudflare-workers-ai-provider.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { freeProviderRouterEnabled, readProviderCapacityConfig } from "../lib/agents/runtime/free-provider-router.ts";
import { ProviderScopedDailyRequestBudget, readOptionalCloudflareDailyRequestLimit } from "../lib/agents/runtime/request-budget.ts";
import { assertFreeProviderRequest, cloudflareModelPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { VerifierAgent, getVerifierModelConfig } from "../lib/agents/verifier/verifier-agent.ts";
import { TranslatorAgent, getTranslatorModelConfig } from "../lib/agents/translator/translator-agent.ts";
import { EditorAgent, getEditorModelConfig } from "../lib/agents/editor/index.ts";
import { ClassifierAgent, getClassifierModelConfig } from "../lib/agents/classifier/classifier-agent.ts";
import { RankerAgent, getRankerModelConfig } from "../lib/agents/ranker/ranker-agent.ts";
import { CriticAgent, getCriticModelConfig } from "../lib/agents/critic/critic-agent.ts";
import { getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import {
  assertQualityBenchmarkCallCeiling,
  invokeExactlyOneQualityBenchmarkStage,
  parseQualityBenchmarkCliArgs,
  plannedQualityBenchmarkCalls,
  qualityBenchmarkAccountingEventKey,
  qualityBenchmarkCases,
  QUALITY_BENCHMARK_CASE_IDS,
  QUALITY_BENCHMARK_MODEL,
  QUALITY_BENCHMARK_PURPOSE,
  QUALITY_BENCHMARK_PROVIDER,
  type NormalEventStage,
  type QualityBenchmarkPlannedCall,
  qualityBenchmarkFailureDispatchCount,
} from "../lib/agents/runtime/cloudflare-quality-benchmark.ts";
import {
  caseProvenanceManifest,
  prepareStoredBenchmarkStage,
  qualityBenchmarkRegistrySnapshot,
  reconstructArsVerifierInputWithReadOnlyDb,
  type PreparedBenchmarkStage,
} from "./cloudflare-quality-benchmark-fixtures.ts";

const PLAN_PATH = process.env.HORIZAI_CLOUDFLARE_QUALITY_BENCHMARK_PLAN_PATH?.trim()
  || "artifacts/cloudflare-quality-benchmark-plan-10g7b1.json";
const RESULT_PATH = "artifacts/cloudflare-quality-benchmark-10g7b3.json";
const CAPTURED_NEURON_HARD_LIMIT = 10_000;

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`BLOCKED_MISSING_${name}`);
  return value;
}

export function buildQualityBenchmarkPlanArtifact() {
  assertQualityBenchmarkCallCeiling(plannedQualityBenchmarkCalls);
  const ars = caseProvenanceManifest(QUALITY_BENCHMARK_CASE_IDS.arsProblem);
  const mit = caseProvenanceManifest(QUALITY_BENCHMARK_CASE_IDS.mitControl);
  const callPlan = plannedQualityBenchmarkCalls.map((call) => {
    const prepared = call.stage === "verifier" && call.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem
      ? null
      : prepareStoredBenchmarkStage(call.benchmarkCaseId, call.stage);
    return {
      ...call,
      accountingEventKey: qualityBenchmarkAccountingEventKey(call.benchmarkCaseId, call.stage),
      inputSha256: prepared?.inputSha256 ?? null,
      readiness: prepared?.readiness ?? "INPUT_CAN_BE_DETERMINISTICALLY_RECONSTRUCTED",
      historicalInputComparability: prepared?.historicalInputComparability ?? "NOT_PROVEN",
      hashStatus: prepared?.hashStatus ?? "REQUIRES_EXACT_RAW_ITEM_READ",
      independentHistoricalInput: true,
      cloudflareOutput: "NOT_RUN",
      humanReview: "REQUIRED_AFTER_EXECUTION",
      historicalProviderProvenance: qualityBenchmarkCases[call.benchmarkCaseId].historicalProviderProvenance,
      historicalOutput: (call.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem ? ars : mit).availableHistoricalOutputs[call.stage],
      deterministicChecks: (call.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem ? ars : mit).availableStageInputs[call.stage].deterministicDiagnostics,
      humanQuestions: [
        "Does the output preserve supported facts and uncertainty?",
        "For Critic, does it identify the known unsupported assertion without inventing evidence?",
        "Could input projection or missing source lineage explain a difference?",
      ],
      humanDecision: "PENDING_NO_WINNER",
    };
  });
  const manifest = {
    phase: "10G.7b.1",
    status: "PREPARE_ONLY",
    createdAt: new Date().toISOString(),
    benchmarkPurpose: QUALITY_BENCHMARK_PURPOSE,
    benchmarkCases: [ars, mit],
    plannedCalls: callPlan,
    skippedCalls: [
      { benchmarkCaseId: QUALITY_BENCHMARK_CASE_IDS.mitControl, stage: "verifier", reason: "No rawItemId or extracted item is linked to the stored MIT checkpoint; do not reconstruct a source input." },
      { benchmarkCaseId: QUALITY_BENCHMARK_CASE_IDS.mitControl, stage: "translator", reason: "Input is available but outside the requested future call set; no call added beyond the named stage plan." },
      { benchmarkCaseId: QUALITY_BENCHMARK_CASE_IDS.mitControl, stage: "editor", reason: "Input is available but outside the requested future call set; no call added beyond the named stage plan." },
      { benchmarkCaseId: QUALITY_BENCHMARK_CASE_IDS.mitControl, stage: "classifier", reason: "Input is available, but the historic registry ordering/snapshot was not persisted and this stage is outside the requested future call set." },
      { benchmarkCaseId: QUALITY_BENCHMARK_CASE_IDS.mitControl, stage: "ranker", reason: "Input is available but outside the requested future call set; no call added beyond the named stage plan." },
      { benchmarkCaseId: QUALITY_BENCHMARK_CASE_IDS.mitControl, stage: "critic", reason: "The historical checkpoint has no linked rawItemId or sourceEvidence; omit this current-contract Critic call rather than fabricate evidence." },
    ],
    migration: {
      requirement: "MIGRATION_REQUIRED",
      filename: "supabase/migrations/20260927000026_cloudflare_quality_benchmark_authorization.sql",
      prepared: true,
      applied: false,
      newTableRequired: false,
      existingSyntheticAuthorizationChanged: false,
    },
    security: {
      purpose: QUALITY_BENCHMARK_PURPOSE,
      provider: QUALITY_BENCHMARK_PROVIDER,
      model: QUALITY_BENCHMARK_MODEL,
      serviceRoleOnly: true,
      anonDenied: true,
      authenticatedDenied: true,
      fixedCaseStagePairingsOnly: true,
      inputHashIsAuthorization: false,
      runType: "other",
      dryRun: true,
      pipelineAttempts: false,
      publication: false,
      scheduler: false,
      publisher: false,
      retries: 0,
      perCaseStageAttempts: 1,
    },
    providerCallBudget: {
      maximum: 8,
      planned: callPlan.length,
      maximumProviderAttemptsPerPlannedCall: 1,
      plannedInferenceCallsExecuted: 0,
      remoteDatabaseReadsDuringPlan: 0,
      remoteDatabaseWritesDuringPlan: 0,
      groqCalls: 0,
      cloudflareCalls: 0,
      cerebrasCalls: 0,
    },
    limitations: {
      realMultiSourceQualityEvidence: "MISSING",
      verifierCorroborationAndCrossSourceConsistency: "NOT_CERTIFIED_SINGLE_SOURCE_CASES_ONLY",
      semanticQualityGateValidated: false,
      humanQualityDecisionRequired: true,
      productionRoutingEnabled: false,
    },
    gates: {
      technicalAllStagesValidated: true,
      semanticQualityGateValidated: false,
      qualityBenchmarkCompleted: false,
      humanQualityDecisionRequired: true,
      capacityArchitectureProviderScoped: true,
      groqCapacityPolicyDefined: true,
      groqPacingPolicyDefined: true,
      capacityProductionReady: false,
      schedulerThroughputReady: false,
      productionRoutingEnabled: false,
    },
  };
  return manifest;
}

function writePlanArtifact(manifest: ReturnType<typeof buildQualityBenchmarkPlanArtifact>): void {
  const target = resolve(process.cwd(), PLAN_PATH);
  mkdirSync(resolve(process.cwd(), "artifacts"), { recursive: true });
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function readApprovedPlan(): ReturnType<typeof buildQualityBenchmarkPlanArtifact> {
  const path = resolve(process.cwd(), PLAN_PATH);
  let saved: unknown;
  try { saved = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new Error("BLOCKED_QUALITY_BENCHMARK_PLAN_ARTIFACT_MISSING_OR_INVALID"); }
  const current = buildQualityBenchmarkPlanArtifact();
  const currentCalls = current.plannedCalls.map((call) => ({ id: call.accountingEventKey, inputSha256: call.inputSha256 }));
  const savedCalls = (saved as { plannedCalls?: Array<{ accountingEventKey?: string; inputSha256?: string | null }> }).plannedCalls;
  if (!Array.isArray(savedCalls) || JSON.stringify(savedCalls.map((call) => ({ id: call.accountingEventKey, inputSha256: call.inputSha256 }))) !== JSON.stringify(currentCalls)) {
    throw new Error("BLOCKED_QUALITY_BENCHMARK_PLAN_INPUT_HASHES_CHANGED");
  }
  return current;
}

async function allExecutionInputs(): Promise<Map<string, PreparedBenchmarkStage>> {
  const result = new Map<string, PreparedBenchmarkStage>();
  let arsReconstruction: Awaited<ReturnType<typeof reconstructArsVerifierInputWithReadOnlyDb>> | null = null;
  for (const call of plannedQualityBenchmarkCalls) {
    if (call.stage === "verifier" && call.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem) {
      const rebuilt = await reconstructArsVerifierInputWithReadOnlyDb();
      arsReconstruction = rebuilt;
      const definition = qualityBenchmarkCases[call.benchmarkCaseId];
      result.set(`${call.benchmarkCaseId}/${call.stage}`, {
        benchmarkCaseId: call.benchmarkCaseId,
        stage: call.stage,
        readiness: "INPUT_CAN_BE_DETERMINISTICALLY_RECONSTRUCTED",
        input: rebuilt.input,
        modelInput: rebuilt.modelInput,
        inputSha256: rebuilt.inputSha256,
        hashStatus: "READY",
        historicalInputComparability: "RECONSTRUCTED_FROM_CHECKPOINT",
        checkpointPaths: [definition.checkpoints.verifier, definition.snapshotPath],
        historicalOutput: null,
        deterministicDiagnostics: {
          exactRawItemIdAndContentHashMatched: true,
          sourceContentSha256: rebuilt.sourceContentSha256,
          sourceProvenance: rebuilt.sourceProvenance,
          maxInputChars: 12_000,
        },
        blocker: null,
      });
      continue;
    }
    if (call.stage === "critic" && call.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem) {
      check(arsReconstruction !== null, "BLOCKED_ARS_CRITIC_SOURCE_EVIDENCE_REQUIRES_EXACT_RAW_ITEM_READ");
      result.set(
        `${call.benchmarkCaseId}/${call.stage}`,
        prepareStoredBenchmarkStage(call.benchmarkCaseId, call.stage, { sourceEvidence: arsReconstruction.criticSourceEvidence }),
      );
      continue;
    }
    result.set(`${call.benchmarkCaseId}/${call.stage}`, prepareStoredBenchmarkStage(call.benchmarkCaseId, call.stage));
  }
  for (const call of plannedQualityBenchmarkCalls) {
    const prepared = result.get(`${call.benchmarkCaseId}/${call.stage}`);
    check(prepared?.input && prepared.modelInput && prepared.inputSha256, `BLOCKED_QUALITY_BENCHMARK_INPUT_MISSING:${call.benchmarkCaseId}:${call.stage}`);
  }
  return result;
}

function verifyExecutionEnvironment(): void {
  check(!freeProviderRouterEnabled(), "BLOCKED_PRODUCTION_ROUTER_MUST_REMAIN_DISABLED");
  check(cloudflareModelPolicy[QUALITY_BENCHMARK_MODEL].productionRoutingEnabled === false, "BLOCKED_CLOUDFLARE_PRODUCTION_ROUTING_ENABLED");
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requiredEnv("CLOUDFLARE_AI_API_TOKEN");
  check(/^[a-f0-9]{32}$/i.test(accountId) && token.length > 0, "BLOCKED_CLOUDFLARE_CONFIGURATION");
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  requiredEnv("SUPABASE_SECRET_KEY");
  const env = { ...process.env, CLOUDFLARE_MODEL: QUALITY_BENCHMARK_MODEL };
  const capacity = readProviderCapacityConfig(QUALITY_BENCHMARK_PROVIDER, env);
  check(capacity.configured && capacity.model === QUALITY_BENCHMARK_MODEL, "BLOCKED_CLOUDFLARE_CAPACITY_CONFIGURATION");
  check(capacity.dailyNeuronAllocation === CAPTURED_NEURON_HARD_LIMIT, "BLOCKED_CLOUDFLARE_HARD_ALLOCATION");
  check(Math.floor(capacity.dailyNeuronAllocation * capacity.softLimitRatio) === 8_500, "BLOCKED_CLOUDFLARE_SOFT_ALLOCATION");
  const dailyCallLimit = readOptionalCloudflareDailyRequestLimit(env);
  check(dailyCallLimit === null || dailyCallLimit >= plannedQualityBenchmarkCalls.length, "BLOCKED_CLOUDFLARE_DAILY_REQUEST_LIMIT_BELOW_PLAN");
  assertFreeProviderRequest(QUALITY_BENCHMARK_PROVIDER, QUALITY_BENCHMARK_MODEL, capacity.endpoint);
}

function stageModelConfig(stage: NormalEventStage) {
  const base = stage === "verifier" ? getVerifierModelConfig()
    : stage === "translator" ? getTranslatorModelConfig()
      : stage === "editor" ? getEditorModelConfig()
        : stage === "classifier" ? getClassifierModelConfig()
          : stage === "ranker" ? getRankerModelConfig()
            : getCriticModelConfig();
  return { ...base, model: QUALITY_BENCHMARK_MODEL, maxRetries: 0, retryBackoffMs: 0, dailyRequestLimit: 8, allowPaidFallback: false, failOnRateLimit: true };
}

type StageResult = { output: unknown; attempts: number; providerRequestsUsed: number; latencyMs: number; diagnostics?: Record<string, unknown>; telemetry?: Record<string, unknown> };

async function runOneRealAgent(call: QualityBenchmarkPlannedCall, prepared: PreparedBenchmarkStage, budget: ProviderScopedDailyRequestBudget, provider: CloudflareWorkersAIModelProvider): Promise<StageResult> {
  const authorization = { benchmarkCaseId: call.benchmarkCaseId, stage: call.stage, inputSha256: prepared.inputSha256! };
  const logger = new SupabaseAgentLogger(createSupabaseServerClient(), authorization);
  const modelConfig = stageModelConfig(call.stage);
  const options = { dryRun: true, modelConfig, requestBudget: budget };
  const input = prepared.input;
  if (call.stage === "verifier") {
    return new VerifierAgent(provider, logger).verify(input as Parameters<VerifierAgent["verify"]>[0], { ...options, maxInputChars: 12_000 });
  }
  if (call.stage === "translator") return new TranslatorAgent(provider, logger).translate(input as Parameters<TranslatorAgent["translate"]>[0], options);
  if (call.stage === "editor") return new EditorAgent(provider, logger).edit(input as Parameters<InstanceType<typeof EditorAgent>["edit"]>[0], options);
  if (call.stage === "classifier") return new ClassifierAgent(provider, logger).classify(input as Parameters<ClassifierAgent["classify"]>[0], { ...options, registry: qualityBenchmarkRegistrySnapshot });
  if (call.stage === "ranker") {
    const referenceTime = prepared.deterministicDiagnostics.referenceTime;
    check(typeof referenceTime === "string" && Number.isFinite(Date.parse(referenceTime)), "BLOCKED_RANKER_REFERENCE_TIME_MISSING");
    return new RankerAgent(provider, logger).rank(input as Parameters<RankerAgent["rank"]>[0], { ...options, now: new Date(referenceTime) });
  }
  return new CriticAgent(provider, logger).critique(input as Parameters<CriticAgent["critique"]>[0], { ...options, registry: qualityBenchmarkRegistrySnapshot });
}

function reviewSafeOutput(stage: NormalEventStage, raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const output = raw as Record<string, unknown>;
  if (stage === "translator") {
    const sourceMaterial = typeof output.translatedSourceMaterial === "string" ? output.translatedSourceMaterial : "";
    return {
      schemaVersion: output.schemaVersion,
      eventKey: output.eventKey,
      sourceLanguage: output.sourceLanguage,
      targetLanguage: output.targetLanguage,
      translatedTitle: output.translatedTitle,
      translatedFacts: output.translatedFacts,
      preservedNames: output.preservedNames,
      translationNotes: output.translationNotes,
      translatedSourceMaterial: { omitted: true, characterCount: sourceMaterial.length },
    };
  }
  return raw;
}

function safeExecutionError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    const code = (error as { code: string }).code;
    return /^[A-Z0-9_:-]{3,120}$/.test(code) ? code : "QUALITY_BENCHMARK_STAGE_FAILED";
  }
  return error instanceof Error && /^BLOCKED_[A-Z0-9_:-]{3,120}$/.test(error.message) ? error.message : "QUALITY_BENCHMARK_STAGE_FAILED";
}

async function executeBenchmark(): Promise<void> {
  const approvedPlan = readApprovedPlan();
  verifyExecutionEnvironment();
  const inputs = await allExecutionInputs();
  for (const planned of approvedPlan.plannedCalls) {
    const prepared = inputs.get(`${planned.benchmarkCaseId}/${planned.stage}`)!;
    const expectedHash = planned.inputSha256;
    if (expectedHash !== null && expectedHash !== prepared.inputSha256) throw new Error(`BLOCKED_QUALITY_BENCHMARK_INPUT_HASH_CHANGED:${planned.benchmarkCaseId}:${planned.stage}`);
    if (planned.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.mitControl && prepared.stage === "critic") {
      check(prepared.deterministicDiagnostics.deterministicPrechecks === "PASS", "MIT_CRITIC_CONTROL_UNUSABLE");
    }
  }
  const capacity = readProviderCapacityConfig(QUALITY_BENCHMARK_PROVIDER, { ...process.env, CLOUDFLARE_MODEL: QUALITY_BENCHMARK_MODEL });
  const softNeuronLimit = Math.floor((capacity.dailyNeuronAllocation ?? 0) * capacity.softLimitRatio);
  const capacityAuditLogger = new SupabaseAgentLogger(createSupabaseServerClient());
  const baselineDateUtc = new Date().toISOString().slice(0, 10);
  const baselineUsage = await capacityAuditLogger.getProviderDailyUsage(QUALITY_BENCHMARK_PROVIDER, baselineDateUtc);
  const baselineBlock = await capacityAuditLogger.getProviderRateLimitState(QUALITY_BENCHMARK_PROVIDER);
  const temporaryBlock = Boolean(baselineBlock?.blockedUntil && Date.parse(baselineBlock.blockedUntil) > Date.now());
  check(baselineUsage.neuronUsageKnown === true && Number.isSafeInteger(baselineUsage.neuronsUsed), "BLOCKED_CLOUDFLARE_NEURON_USAGE_UNKNOWN");
  check(baselineUsage.neuronsUsed! < softNeuronLimit && baselineUsage.neuronsUsed! <= CAPTURED_NEURON_HARD_LIMIT, "BLOCKED_FREE_CAPACITY_EXHAUSTED");
  check(!temporaryBlock, "BLOCKED_CLOUDFLARE_TEMPORARY_PROVIDER_BLOCK");
  if (capacity.dailyRequestLimit !== undefined) {
    check(baselineUsage.requestsReserved + approvedPlan.plannedCalls.length <= capacity.dailyRequestLimit, "BLOCKED_CLOUDFLARE_REQUEST_CAPACITY_EXHAUSTED");
  }
  const baselineCapacity = {
    utcDate: baselineDateUtc,
    reservedRequests: baselineUsage.requestsReserved,
    dispatchedRequests: baselineUsage.requestsDispatched,
    reservedNeurons: baselineUsage.neuronsUsed,
    neuronUsageKnown: baselineUsage.neuronUsageKnown,
    softLimitNeurons: softNeuronLimit,
    softRemainingNeurons: Math.max(0, softNeuronLimit - baselineUsage.neuronsUsed!),
    hardLimitNeurons: CAPTURED_NEURON_HARD_LIMIT,
    hardRemainingNeurons: CAPTURED_NEURON_HARD_LIMIT - baselineUsage.neuronsUsed!,
    temporaryBlock,
    blockedUntil: baselineBlock?.blockedUntil ?? null,
  };
  const provider = new CloudflareWorkersAIModelProvider(
    requiredEnv("CLOUDFLARE_ACCOUNT_ID"),
    requiredEnv("CLOUDFLARE_AI_API_TOKEN"),
    fetch,
    QUALITY_BENCHMARK_MODEL,
  );
  const requestBudget = new ProviderScopedDailyRequestBudget();
  const results: Array<Record<string, unknown>> = [];
  let stoppedOnTechnicalFailure = false;
  let attempts = 0;
  const executionStartedAt = new Date().toISOString();
  const dispatchers = Object.fromEntries(([
    "verifier", "translator", "editor", "classifier", "ranker", "critic",
  ] as const).map((stage) => [stage, async (call: QualityBenchmarkPlannedCall): Promise<StageResult> => {
    check(call.stage === stage, "BLOCKED_ISOLATED_STAGE_DISPATCH_MISMATCH");
    const prepared = inputs.get(`${call.benchmarkCaseId}/${call.stage}`)!;
    const response = await runOneRealAgent(call, prepared, requestBudget, provider);
    return response;
  }])) as Record<NormalEventStage, (call: QualityBenchmarkPlannedCall) => Promise<StageResult>>;

  for (const call of approvedPlan.plannedCalls) {
    check(attempts < 8, "BLOCKED_QUALITY_BENCHMARK_CALL_CEILING");
    try {
      const result = await invokeExactlyOneQualityBenchmarkStage(call.stage, call, dispatchers);
      check(result.attempts === 1 && result.providerRequestsUsed === 1, "BLOCKED_QUALITY_BENCHMARK_NOT_EXACTLY_ONE_DISPATCH");
      attempts += result.providerRequestsUsed;
      results.push({
        benchmarkCaseId: call.benchmarkCaseId,
        stage: call.stage,
        agentVersion: call.agentVersion,
        provider: QUALITY_BENCHMARK_PROVIDER,
        model: QUALITY_BENCHMARK_MODEL,
        inputSha256: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)!.inputSha256,
        inputReadiness: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)!.readiness,
        historicalInputRelationship: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)!.historicalInputComparability,
        inputSource: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)!.checkpointPaths,
        inputDiagnostics: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)!.deterministicDiagnostics,
        historicalProviderProvenance: qualityBenchmarkCases[call.benchmarkCaseId].historicalProviderProvenance,
        historicalOutput: (approvedPlan.benchmarkCases.find((entry) => entry.benchmarkCaseId === call.benchmarkCaseId) as { availableHistoricalOutputs: Record<string, unknown> }).availableHistoricalOutputs[call.stage],
        cloudflareOutput: reviewSafeOutput(call.stage, result.output),
        deterministicDiagnostics: result.diagnostics ?? null,
        telemetry: result.telemetry ?? null,
        humanQuestions: ["Does the output preserve the supported facts and uncertainty?", "For Critic, does it identify the known unsupported assertion without inventing evidence?", "Are any differences attributable to input projection or model behavior?"],
      });
    } catch (error) {
      stoppedOnTechnicalFailure = true;
      const failureDetails = getAgentFailureDetails(error);
      const failureDispatches = qualityBenchmarkFailureDispatchCount(failureDetails.providerRequestsUsed);
      attempts += failureDispatches;
      results.push({
        benchmarkCaseId: call.benchmarkCaseId,
        stage: call.stage,
        agentVersion: call.agentVersion,
        provider: QUALITY_BENCHMARK_PROVIDER,
        model: QUALITY_BENCHMARK_MODEL,
        inputSha256: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)?.inputSha256 ?? null,
        inputReadiness: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)?.readiness ?? "MISSING",
        historicalInputRelationship: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)?.historicalInputComparability ?? "NOT_PROVEN",
        inputSource: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)?.checkpointPaths ?? [],
        inputDiagnostics: inputs.get(`${call.benchmarkCaseId}/${call.stage}`)?.deterministicDiagnostics ?? null,
        providerRequestsUsed: failureDispatches,
        failureAttempts: failureDetails.attempts,
        technicalFailure: safeExecutionError(error),
      });
      break;
    }
  }

  const report = {
    phase: "10G.7b.3",
    purpose: QUALITY_BENCHMARK_PURPOSE,
    provider: QUALITY_BENCHMARK_PROVIDER,
    model: QUALITY_BENCHMARK_MODEL,
    startedAt: executionStartedAt,
    generatedAt: new Date().toISOString(),
    status: stoppedOnTechnicalFailure ? "STOPPED_ON_TECHNICAL_FAILURE" : "CAPTURED_FOR_HUMAN_REVIEW",
    attempts,
    maxCalls: 8,
    retries: 0,
    plannedCalls: approvedPlan.plannedCalls.length,
    completedCalls: results.filter((result) => !("technicalFailure" in result)).length,
    stoppedAt: stoppedOnTechnicalFailure ? results.at(-1)?.stage ?? "UNKNOWN_STAGE" : null,
    stopReason: stoppedOnTechnicalFailure ? results.at(-1)?.technicalFailure ?? "QUALITY_BENCHMARK_STAGE_FAILED" : null,
    baselineCapacity,
    inputPlan: approvedPlan.plannedCalls.map((call) => {
      const input = inputs.get(`${call.benchmarkCaseId}/${call.stage}`)!;
      return {
        benchmarkCaseId: call.benchmarkCaseId,
        stage: call.stage,
        inputSha256: input.inputSha256,
        inputReadiness: input.readiness,
        historicalInputRelationship: input.historicalInputComparability,
        inputSource: input.checkpointPaths,
        deterministicDiagnostics: input.deterministicDiagnostics,
      };
    }),
    results,
    semanticWinner: null,
    globalQualityScore: null,
    qualityBenchmarkCompleted: !stoppedOnTechnicalFailure && results.length === approvedPlan.plannedCalls.length,
    semanticQualityGateValidated: false,
    humanQualityDecisionRequired: true,
    realMultiSourceQualityEvidence: "MISSING",
    technicalAllStagesValidated: true,
    capacityProductionReady: false,
    schedulerThroughputReady: false,
    productionRoutingEnabled: false,
  };
  mkdirSync(resolve(process.cwd(), "artifacts"), { recursive: true });
  writeFileSync(resolve(process.cwd(), RESULT_PATH), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ status: report.status, resultsPath: RESULT_PATH, attemptedProviderCalls: attempts, stoppedOnTechnicalFailure }, null, 2)}\n`);
  if (stoppedOnTechnicalFailure) process.exitCode = 1;
}

async function main(): Promise<void> {
  const mode = parseQualityBenchmarkCliArgs(process.argv.slice(2));
  if (mode === "PREFLIGHT_ONLY") {
    const plan = buildQualityBenchmarkPlanArtifact();
    writePlanArtifact(plan);
    const hashesReady = plan.plannedCalls.every((call) => call.inputSha256 !== null);
    process.stdout.write(`${JSON.stringify({
      status: "PREFLIGHT_ONLY",
      planPath: PLAN_PATH,
      plannedCalls: plan.plannedCalls.length,
      maximumCalls: 8,
      providerCalls: 0,
      inputHashesComplete: hashesReady,
      remoteReads: 0,
      remoteWrites: 0,
    }, null, 2)}\n`);
    return;
  }
  await executeBenchmark();
}

main().catch((error: unknown) => {
  process.stderr.write(`${safeExecutionError(error)}\n`);
  process.exitCode = 1;
});
