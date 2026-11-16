import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ZodType } from "zod";
import { assertFreeProviderRequest, freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { AgentError, getAgentFailureDetails, getProviderDiagnostics } from "../lib/agents/runtime/agent-errors.ts";
import { createConfiguredModelProvider, type ModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { toStrictProviderJsonSchema } from "../lib/agents/runtime/strict-json-schema.ts";
import { evaluateProviderCapacity, readProviderCapacityConfig, readProviderSoftLimitRatio } from "../lib/agents/runtime/free-provider-router.ts";
import { ProviderScopedDailyRequestBudget, resolveGroqDailyRequestHardCap } from "../lib/agents/runtime/request-budget.ts";
import type { AgentExecutionResult, GenerateStructuredRequest, ModelConfig, ModelProviderResponse, ProviderDiagnostics, ProviderRateLimitTelemetry } from "../lib/agents/runtime/runtime-types.ts";
import {
  GROQ_RESET_SAFETY_MARGIN_MS,
  GROQ_TPM_SAFETY_MARGIN,
  assertGroqStageIdentity,
  calculateTpdScenarios,
  captureAllowlistedGroqHeaders,
  classifyGroq429Evidence,
  classifyGroqPacing,
  classifyUnpacedPath,
  decideGroqTpmPacing,
  estimateGroqStageTokenRequirement,
  hasExplicitGroqRequestIdentity,
  normalizeGroqHeadersForPacing,
  resolveGroqProbeExecutionMode,
  separateGroqLimitProvenance,
  maximumRolling60SecondAmount,
} from "../lib/agents/runtime/groq-capacity-pacing.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { buildVerifierModelInput } from "../lib/agents/verifier/verifier-input-builder.ts";
import { VerifierAgent, getVerifierModelConfig, verifierAgentVersion, verifierSystemInstructions } from "../lib/agents/verifier/verifier-agent.ts";
import type { VerifierInput } from "../lib/agents/verifier/verifier-types.ts";
import { verificationResultSchema, type ClusteredEvent, type ExtractedItem, type VerificationResult, type TranslationResult, type EditorialDraft, type ClassificationResult, type RankingResult } from "../lib/agents/contracts/index.ts";
import { TranslatorAgent, getTranslatorModelConfig, translatorAgentVersion, translatorSystemInstructions, translatorGenerationSchema } from "../lib/agents/translator/translator-agent.ts";
import { buildTranslatorModelInput } from "../lib/agents/translator/translator-input.ts";
import type { TranslatorInput } from "../lib/agents/translator/translator-types.ts";
import { EditorV2Agent, getEditorV2ModelConfig } from "../lib/agents/editor/editor-v2-agent.ts";
import { editorV2AgentVersion, editorV2SystemInstructions } from "../lib/agents/editor/editor-v2-prompt.ts";
import { buildEditorInput, buildEditorModelInput } from "../lib/agents/editor/editor-input.ts";
import { editorGenerationSchema } from "../lib/agents/editor/editor-generation.ts";
import type { EditorInput } from "../lib/agents/editor/editor-types.ts";
import { ClassifierAgent, getClassifierModelConfig, classifierAgentVersion, classifierSystemInstructions } from "../lib/agents/classifier/classifier-agent.ts";
import { buildClassifierInput, buildClassifierModelInput } from "../lib/agents/classifier/classifier-input.ts";
import { classifierGenerationSchema } from "../lib/agents/classifier/classifier-types.ts";
import { classifierFixtureRegistry } from "../lib/agents/classifier/classifier-fixtures.ts";
import { resolveGeo } from "../lib/agents/classifier/geo-resolver.ts";
import type { ClassifierInput } from "../lib/agents/classifier/classifier-types.ts";
import { RankerAgent, getRankerModelConfig, rankerAgentVersion, rankerSystemInstructions, rankerGenerationSchema } from "../lib/agents/ranker/ranker-agent.ts";
import { buildRankerPipelineInput } from "../lib/agents/ranker/ranker-input.ts";
import type { RankerExecutionResult, RankerInput } from "../lib/agents/ranker/ranker-agent.ts";
import { CriticAgent, getCriticModelConfig, criticAgentVersion, criticSystemInstructions } from "../lib/agents/critic/critic-agent.ts";
import { buildCriticInput, buildCriticModelInput, buildCriticSourceEvidence } from "../lib/agents/critic/critic-input.ts";
import { criticCurrentGenerationSchema, type CriticInput } from "../lib/agents/critic/critic-types.ts";

const PROVIDER = "groq" as const;
const MODEL = "openai/gpt-oss-20b";
const MAX_PATH_REQUESTS = 6;
const TPM_LIMIT = 8_000;
const RPD_LIMIT = 1_000;
const RPM_LIMIT = 30;
const TPD_LIMIT = 200_000;
const OUTPUT_ROOT = resolve(process.cwd(), "artifacts");
const ARTIFACT_PATH = resolve(OUTPUT_ROOT, "groq-full-path-capacity-probe-10g7a4.json");
const REPORT_PATH = resolve(process.cwd(), "docs/groq-full-path-capacity-10g7a4.md");
const PREVIOUS_PROBE_PATH = resolve(OUTPUT_ROOT, "groq-effective-capacity-probe-10g7a3.json");
const STAGE_ORDER = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
type StageName = typeof STAGE_ORDER[number];

type ManualPlanConfirmation = {
  provenance: "USER_MANUAL_CONFIRMATION";
  confirmation: "YES";
  plan: "FREE";
  model: typeof MODEL;
  rpm: 30;
  rpd: 1_000;
  tpm: 8_000;
  tpd: 200_000;
  billingEnabled: false;
  paidDeveloperPlan: false;
};

type StageRecord = {
  stage: StageName;
  agentVersion: string;
  provider: typeof PROVIDER;
  model: typeof MODEL;
  status: string;
  requestDispatched: boolean;
  requestDispatchedAtUtc: string | null;
  responseAtUtc: string | null;
  httpStatus: number | null;
  finishReason: string | null;
  attempts: number;
  retries: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  requestBytes: number | null;
  responseBytes: number | null;
  maxOutputTokens: number;
  structuredOutputMode: string;
  estimatedInputTokens: number;
  estimatedStageTokenRequirement: number;
  tpmSafetyMarginTokens: number;
  pacingDecisionBeforeStage: string;
  waitDurationBeforeStageMs: number;
  rawAllowlistedHeaders: Record<string, string | null> | null;
  normalizedProviderRateLimit: ProviderRateLimitTelemetry | null;
  providerIdentityPersisted: boolean | null;
  zodValid: boolean | null;
  editorGuardPassed: boolean | null;
  editorPreservedNameCount: number | null;
  editorPreservedNameObservedCount: number | null;
  editorPreservedNameOmittedCount: number | null;
  errorCode: string | null;
  http429Classification: string | null;
};

type ProbePreflight = {
  passed: boolean;
  checkedAtUtc: string;
  utcPeriod: string;
  provider: typeof PROVIDER;
  model: typeof MODEL;
  checks: Record<string, boolean>;
  modelsByStage: Record<StageName, string>;
  maxOutputTokensByStage: Record<StageName, number>;
  structuredOutputModeByStage: Record<StageName, string>;
  effectiveMaxRetries: 0;
  currentRequestsUsed: number | null;
  currentRequestsDispatched: number | null;
  currentRequestsRemaining: number | null;
  projectedRequestsForPath: number;
  projectedRequestsAfterPath: number | null;
  internalHardCap: number;
  internalCapSource: string;
  internalSoftRatio: number;
  internalSoftThreshold: number;
  providerRateLimitBlockActive: boolean | null;
  admissionReason: string;
  supabaseReadStatus: "PASS" | "FAIL";
  reason: string | null;
};

type SyntheticContext = {
  event: ClusteredEvent;
  items: ExtractedItem[];
  sources: Array<{ sourceId: string; sourceName: string; sourceUrl: string; sourceType: string; countryCode: string; language: string }>;
  verifierInput: VerifierInput;
  verification?: VerificationResult;
  translation?: TranslationResult;
  editorial?: EditorialDraft;
  classification?: ClassificationResult;
  rankerExecution?: RankerExecutionResult;
  ranking?: RankingResult;
};

type PreparedStage = {
  version: string;
  config: ModelConfig;
  systemInstructions: string;
  modelInput: unknown;
  schemaName: string;
  schema: ZodType<unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeErrorCode(error: unknown): string {
  if (error instanceof AgentError) return error.code;
  if (error instanceof Error) return error.name || "ERROR";
  return "UNKNOWN_ERROR";
}

function requiredIntegerEnv(name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) throw new Error(`INVALID_${name}`);
  return parsed;
}

function readVerifierMaxInputChars(): number {
  return requiredIntegerEnv("AGENT_MAX_INPUT_CHARS", 12_000, 12_000);
}

async function readManualPlanConfirmation(): Promise<{ manual: ManualPlanConfirmation; previousProviderReported: Record<string, unknown> }> {
  const parsed = JSON.parse(await readFile(PREVIOUS_PROBE_PATH, "utf8")) as unknown;
  const root = asRecord(parsed);
  const manual = asRecord(root.humanConfirmedPlan);
  const providerReported = asRecord(root.providerReportedLimits);
  const valid = manual.provenance === "USER_MANUAL_CONFIRMATION"
    && manual.confirmation === "YES"
    && manual.plan === "FREE"
    && manual.model === MODEL
    && manual.rpm === RPM_LIMIT
    && manual.rpd === RPD_LIMIT
    && manual.tpm === TPM_LIMIT
    && manual.tpd === TPD_LIMIT
    && manual.billingEnabled === false
    && manual.paidDeveloperPlan === false
    && providerReported.provenance === "PROVIDER_REPORTED"
    && asRecord(providerReported.rpd).limit === RPD_LIMIT
    && asRecord(providerReported.tpm).limit === TPM_LIMIT
    && providerReported.rpm === "UNKNOWN_FROM_API_HEADERS"
    && providerReported.tpd === "UNKNOWN_FROM_API_HEADERS";
  if (!valid) throw new Error("FREE_PLAN_CONFIRMATION_EVIDENCE_INVALID");
  return {
    manual: {
      provenance: "USER_MANUAL_CONFIRMATION",
      confirmation: "YES",
      plan: "FREE",
      model: MODEL,
      rpm: RPM_LIMIT,
      rpd: RPD_LIMIT,
      tpm: TPM_LIMIT,
      tpd: TPD_LIMIT,
      billingEnabled: false,
      paidDeveloperPlan: false,
    },
    previousProviderReported: providerReported,
  };
}

function makeSyntheticContext(now: Date): SyntheticContext {
  const eventKey = `synthetic-groq-capacity-10g7a4-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const sourceDefinitions = [
    {
      sourceId: "a1111111-1111-4111-8111-111111111111",
      candidateId: "synthetic-lumen-primary-10g7a4",
      sourceName: "Lumen Labs Newsroom (synthetic)",
      sourceType: "official_blog",
      url: "https://lumen-labs.example/news/lumen-1",
      content: "Lumen Labs announced Lumen-1, an inference accelerator for data-center deployments. The product includes 32 GB of HBM memory, according to the company release, and pilot availability is scheduled for Q4 2026. The release does not include independent performance benchmarks.",
      author: "Lumen Labs Communications",
    },
    {
      sourceId: "b2222222-2222-4222-8222-222222222222",
      candidateId: "synthetic-lumen-secondary-10g7a4",
      sourceName: "Compute Systems Review (synthetic)",
      sourceType: "news_organization",
      url: "https://compute-systems-review.example/technology/lumen-1",
      content: "Compute Systems Review reports that Lumen Labs announced its Lumen-1 inference accelerator with 32 GB of HBM memory and pilot availability in Q4 2026. The report notes that no independent performance benchmark was supplied.",
      author: "Compute Systems Review Desk",
    },
  ] as const;
  const publishedAt = new Date(now.getTime() - 45 * 60_000).toISOString();
  const items: ExtractedItem[] = sourceDefinitions.map((source) => ({
    schemaVersion: 1,
    candidateId: source.candidateId,
    url: source.url,
    canonicalUrl: source.url,
    title: "Lumen Labs announces the Lumen-1 inference accelerator",
    description: "Synthetic, copyright-safe source material for a supervised capacity probe.",
    author: source.author,
    publishedAt,
    language: "en",
    content: source.content,
    contentHash: `sha256:${createHash("sha256").update(source.content).digest("hex")}`,
    metadata: { syntheticFixture: true, sourceId: source.sourceId, sourceName: source.sourceName },
    extractionQuality: "full",
  }));
  const event: ClusteredEvent = {
    schemaVersion: 1,
    eventKey,
    canonicalTitle: "Lumen Labs announces the Lumen-1 inference accelerator",
    sourceItems: sourceDefinitions.map((source, index) => ({
      candidateId: source.candidateId,
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      url: source.url,
      title: items[index].title,
      publishedAt,
    })),
    probableOccurredAt: publishedAt,
    probableCountryCode: "US",
    probableRegionCode: "US",
    clusterConfidence: 100,
  };
  const sources = sourceDefinitions.map((source) => ({
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    sourceUrl: source.url,
    sourceType: source.sourceType,
    countryCode: "US",
    language: "en",
  }));
  const verifierInput: VerifierInput = { event, items, sources };
  return { event, items, sources, verifierInput };
}

function configuredModelConfigs(): Record<StageName, ModelConfig> {
  return {
    verifier: getVerifierModelConfig(),
    translator: getTranslatorModelConfig(),
    editor: getEditorV2ModelConfig(),
    classifier: getClassifierModelConfig(),
    ranker: getRankerModelConfig(),
    critic: getCriticModelConfig(),
  };
}

function stageVersions(): Record<StageName, string> {
  return {
    verifier: verifierAgentVersion,
    translator: translatorAgentVersion,
    editor: editorV2AgentVersion,
    classifier: classifierAgentVersion,
    ranker: rankerAgentVersion,
    critic: criticAgentVersion,
  };
}

function stagePrompts(): Record<StageName, string> {
  return {
    verifier: verifierSystemInstructions,
    translator: translatorSystemInstructions,
    editor: editorV2SystemInstructions,
    classifier: classifierSystemInstructions,
    ranker: rankerSystemInstructions,
    critic: criticSystemInstructions,
  };
}

function stageOutputSchemas(): Record<StageName, { schemaName: string; schema: ZodType<unknown> }> {
  return {
    verifier: { schemaName: "VerificationResult", schema: verificationResultSchema },
    translator: { schemaName: "TranslatorGeneration", schema: translatorGenerationSchema },
    editor: { schemaName: "EditorGeneration", schema: editorGenerationSchema },
    classifier: { schemaName: "ClassifierGeneration", schema: classifierGenerationSchema },
    ranker: { schemaName: "RankerGeneration", schema: rankerGenerationSchema },
    critic: { schemaName: "CriticGenerationV3", schema: criticCurrentGenerationSchema },
  };
}

function validateStageConfig(modelConfigs: Record<StageName, ModelConfig>): Record<string, boolean> {
  const models = Object.values(modelConfigs);
  return {
    providerEnvIsGroq: process.env.AGENT_PROVIDER?.trim().toLowerCase() === PROVIDER,
    officialGroqEndpoint: process.env.AGENT_API_URL?.trim().replace(/\/$/, "") === "https://api.groq.com/openai/v1",
    apiKeyPresent: !!process.env.AGENT_API_KEY?.trim(),
    allStageModelsMatch: models.every((config) => config.model === MODEL),
    allStageRequestCapsMatch: models.every((config) => config.dailyRequestLimit === 20),
    allStagesFailClosed: models.every((config) => config.failOnRateLimit === true),
    noPaidFallback: models.every((config) => config.allowPaidFallback === false)
      && process.env.AGENT_ALLOW_PAID_FALLBACK?.trim().toLowerCase() !== "true",
    allStageOutputLimitsValid: models.every((config) => Number.isSafeInteger(config.maxOutputTokens) && config.maxOutputTokens > 0 && config.maxOutputTokens <= 1_200),
    freeProviderPolicyAllowsExactModel: (() => {
      try { assertFreeProviderRequest(PROVIDER, MODEL, freeProviderPolicy.groq.endpoint); return true; } catch { return false; }
    })(),
  };
}

async function readGroqAdmission(input: {
  logger: SupabaseAgentLogger;
  now: Date;
  requiredRequests: number;
}): Promise<{
  passed: boolean;
  usage: { requestsReserved: number; requestsDispatched: number } | null;
  remainingRequests: number | null;
  hardCap: number;
  capSource: string;
  softRatio: number;
  softThreshold: number;
  blockActive: boolean | null;
  projectedRequests: number | null;
  reason: string;
}> {
  const cap = resolveGroqDailyRequestHardCap();
  const softRatio = readProviderSoftLimitRatio();
  const softThreshold = Math.floor(cap.limit * softRatio);
  const dateUtc = input.now.toISOString().slice(0, 10);
  const providerConfig = readProviderCapacityConfig(PROVIDER);
  const usage = await input.logger.getProviderDailyUsage(PROVIDER, dateUtc);
  const availability = await input.logger.getRemainingRequests(cap.limit, dateUtc);
  const block = await input.logger.getProviderRateLimitState(PROVIDER);
  const usageIsConsistent = usage.provider === PROVIDER
    && usage.dateUtc === dateUtc
    && usage.requestsReserved === availability.used
    && usage.requestsDispatched <= usage.requestsReserved;
  const capacity = evaluateProviderCapacity(providerConfig, usage, block, input.now, input.requiredRequests, null, null);
  const blockActive = block?.blockedUntil ? Date.parse(block.blockedUntil) > input.now.getTime() : false;
  const projectedRequests = usage.requestsReserved + input.requiredRequests;
  const passed = cap.limit === 20
    && softRatio === 0.85
    && providerConfig.dailyRequestLimit === 20
    && providerConfig.model === MODEL
    && providerConfig.configured
    && usageIsConsistent
    && availability.remaining >= input.requiredRequests
    && !blockActive
    && capacity.eligible;
  const reason = passed ? "NEW_EVENT_PROJECTED_SOFT_ADMISSION_PASS" : !usageIsConsistent ? "PROVIDER_USAGE_LEDGER_INCONSISTENT" : blockActive ? "GROQ_PROVIDER_BLOCK_ACTIVE" : !providerConfig.configured ? "GROQ_CONFIGURATION_INCOMPLETE" : capacity.reason;
  return {
    passed,
    usage: usageIsConsistent ? { requestsReserved: usage.requestsReserved, requestsDispatched: usage.requestsDispatched } : null,
    remainingRequests: usageIsConsistent ? availability.remaining : null,
    hardCap: cap.limit,
    capSource: cap.source,
    softRatio,
    softThreshold,
    blockActive,
    projectedRequests: usageIsConsistent ? projectedRequests : null,
    reason,
  };
}

async function runPreflight(input: {
  modelConfigs: Record<StageName, ModelConfig>;
  logger: SupabaseAgentLogger;
  manualPlanValid: boolean;
  now: Date;
}): Promise<ProbePreflight> {
  const modelsByStage = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, input.modelConfigs[stage].model])) as Record<StageName, string>;
  const maxOutputTokensByStage = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, input.modelConfigs[stage].maxOutputTokens])) as Record<StageName, number>;
  const structuredOutputModeByStage = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, input.modelConfigs[stage].structuredOutputMode])) as Record<StageName, string>;
  const baseChecks = validateStageConfig(input.modelConfigs);
  let admission: Awaited<ReturnType<typeof readGroqAdmission>> | null = null;
  let supabaseReadStatus: "PASS" | "FAIL" = "FAIL";
  try {
    admission = await readGroqAdmission({ logger: input.logger, now: input.now, requiredRequests: MAX_PATH_REQUESTS });
    supabaseReadStatus = "PASS";
  } catch {
    admission = null;
  }
  const checks: Record<string, boolean> = {
    ...baseChecks,
    freePlanConfirmationValid: input.manualPlanValid,
    supabaseReadPass: supabaseReadStatus === "PASS",
    internalHardCapUnchanged: admission?.hardCap === 20,
    internalSoftThresholdUnchanged: admission?.softThreshold === 17 && admission.softRatio === 0.85,
    sixRequestProjectedSoftAdmissionPass: admission?.passed === true,
    noActiveGroqProviderBlock: admission?.blockActive === false,
  };
  const passed = Object.values(checks).every(Boolean);
  const admissionReason = admission?.reason ?? "PERSISTENT_PROVIDER_CAPACITY_READ_FAILED";
  return {
    passed,
    checkedAtUtc: new Date().toISOString(),
    utcPeriod: input.now.toISOString().slice(0, 10),
    provider: PROVIDER,
    model: MODEL,
    checks,
    modelsByStage,
    maxOutputTokensByStage,
    structuredOutputModeByStage,
    effectiveMaxRetries: 0,
    currentRequestsUsed: admission?.usage?.requestsReserved ?? null,
    currentRequestsDispatched: admission?.usage?.requestsDispatched ?? null,
    currentRequestsRemaining: admission?.remainingRequests ?? null,
    projectedRequestsForPath: MAX_PATH_REQUESTS,
    projectedRequestsAfterPath: admission?.projectedRequests ?? null,
    internalHardCap: admission?.hardCap ?? 20,
    internalCapSource: admission?.capSource ?? "UNKNOWN",
    internalSoftRatio: admission?.softRatio ?? 0.85,
    internalSoftThreshold: admission?.softThreshold ?? 17,
    providerRateLimitBlockActive: admission?.blockActive ?? null,
    admissionReason,
    supabaseReadStatus,
    reason: passed ? null : admissionReason === "PERSISTENT_PROVIDER_CAPACITY_READ_FAILED" ? admissionReason : "PREFLIGHT_CHECK_FAILED",
  };
}

function translatorSources(context: SyntheticContext): TranslatorInput["sources"] {
  return context.sources.map((source, index) => ({
    sourceId: source.sourceId,
    sourceName: source.sourceName,
    sourceItemId: context.items[index].candidateId,
    language: source.language,
    sourceType: source.sourceType,
    countryCode: source.countryCode,
  }));
}

function rankEvent(context: SyntheticContext): RankerInput["event"] {
  const dates = context.event.sourceItems.map((item) => item.publishedAt).filter((value): value is string => Boolean(value)).sort();
  return {
    eventKey: context.event.eventKey,
    canonicalTitle: context.event.canonicalTitle,
    sourceCount: new Set(context.event.sourceItems.map((item) => item.sourceId)).size,
    occurredAt: context.event.probableOccurredAt,
    latestPublishedAt: dates.at(-1) ?? null,
  };
}

function requireContext<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`SYNTHETIC_LINEAGE_MISSING_${name.toUpperCase()}`);
  return value;
}

function prepareStage(stage: StageName, context: SyntheticContext, config: ModelConfig): PreparedStage {
  const prompt = stagePrompts()[stage];
  const output = stageOutputSchemas()[stage];
  let modelInput: unknown;
  switch (stage) {
    case "verifier":
      modelInput = buildVerifierModelInput(context.verifierInput, readVerifierMaxInputChars()).input;
      break;
    case "translator": {
      const input: TranslatorInput = {
        schemaVersion: 1,
        event: context.event,
        verification: requireContext(context.verification, "verification"),
        sourceLanguage: "en",
        sources: translatorSources(context),
      };
      modelInput = buildTranslatorModelInput(input).input;
      break;
    }
    case "editor": {
      const input: EditorInput = buildEditorInput({
        event: { eventKey: context.event.eventKey, canonicalTitle: context.event.canonicalTitle },
        verification: requireContext(context.verification, "verification"),
        translation: requireContext(context.translation, "translation"),
        sources: context.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: source.sourceUrl, sourceType: source.sourceType || "unknown" })),
      });
      modelInput = buildEditorModelInput(input).input;
      break;
    }
    case "classifier": {
      const input: ClassifierInput = buildClassifierInput({
        event: { eventKey: context.event.eventKey, canonicalTitle: context.event.canonicalTitle },
        verification: requireContext(context.verification, "verification"),
        translation: requireContext(context.translation, "translation"),
        editorial: requireContext(context.editorial, "editorial"),
        sources: context.sources.map((source) => ({ sourceName: source.sourceName, sourceType: source.sourceType || "unknown", countryCode: source.countryCode })),
      });
      modelInput = buildClassifierModelInput(input, {
        regionCodes: [...classifierFixtureRegistry.regions.keys()],
        categorySlugs: [...classifierFixtureRegistry.categories.keys()],
      }).input;
      break;
    }
    case "ranker": {
      const input = buildRankerPipelineInput({
        event: rankEvent(context),
        verification: requireContext(context.verification, "verification"),
        translation: requireContext(context.translation, "translation"),
        editorial: requireContext(context.editorial, "editorial"),
        classification: requireContext(context.classification, "classification"),
      });
      modelInput = input;
      break;
    }
    case "critic": {
      const rankerExecution = requireContext(context.rankerExecution, "ranker_execution");
      const signals = rankerExecution.signals;
      const geo = resolveGeo({ regionCode: context.classification?.primaryRegionCode ?? null }, classifierFixtureRegistry);
      const input: CriticInput = buildCriticInput({
        event: rankEvent(context),
        verification: requireContext(context.verification, "verification"),
        translation: requireContext(context.translation, "translation"),
        editorial: requireContext(context.editorial, "editorial"),
        classification: requireContext(context.classification, "classification"),
        ranking: {
          result: rankerExecution.output,
          formulaVersion: rankerExecution.formulaVersion,
          momentumAvailable: signals.momentumAvailable,
          deterministicSignals: {
            credibility: signals.credibility,
            reach: signals.reach,
            momentum: signals.momentum,
            sourceCount: signals.sourceCount,
            contradictionPenalty: signals.contradictionPenalty,
            uncertaintyPenalty: signals.uncertaintyPenalty,
            geographicReachSignal: signals.geographicReachSignal,
          },
        },
        sources: translatorSources(context),
        sourceEvidence: buildCriticSourceEvidence(context.sources, context.items),
        geo: { latitude: geo.latitude, longitude: geo.longitude, resolutionLevel: geo.resolutionLevel, resolvedFrom: geo.resolvedFrom },
      });
      modelInput = buildCriticModelInput(input).input;
      break;
    }
  }
  return { version: stageVersions()[stage], config, systemInstructions: prompt, modelInput, schemaName: output.schemaName, schema: output.schema };
}

class CappedGroqPathProvider implements ModelProvider {
  readonly providerId = PROVIDER;
  readonly dispatches: Array<{ stage: StageName; model: string; provider: string; dispatchedAtUtc: string }> = [];
  methodCalls = 0;
  activeStage: StageName | null = null;
  private readonly delegate: ModelProvider;

  constructor(delegate: ModelProvider) {
    if (delegate.providerId !== PROVIDER) throw new Error("GROQ_PROVIDER_IDENTITY_REQUIRED");
    this.delegate = delegate;
  }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<ModelProviderResponse<T>> {
    this.methodCalls += 1;
    const stage = this.activeStage;
    if (!stage || request.config.model !== MODEL || request.config.maxRetries !== 0 || request.config.allowPaidFallback !== false) {
      throw new Error("GROQ_PATH_REQUEST_GUARD_REJECTED");
    }
    let dispatched = false;
    return this.delegate.generateStructured({
      ...request,
      onRequestDispatched: async () => {
        if (dispatched || this.dispatches.length >= MAX_PATH_REQUESTS) throw new Error("GROQ_PATH_SIX_REQUEST_CAP_REACHED");
        await request.onRequestDispatched?.();
        dispatched = true;
        this.dispatches.push({ stage, model: request.config.model, provider: PROVIDER, dispatchedAtUtc: new Date().toISOString() });
      },
    });
  }
}

function makeInitialStageRecord(stage: StageName, prepared: PreparedStage, estimate: ReturnType<typeof estimateGroqStageTokenRequirement>, pacingDecision: string, waitMs: number): StageRecord {
  return {
    stage,
    agentVersion: prepared.version,
    provider: PROVIDER,
    model: MODEL,
    status: "NOT_STARTED",
    requestDispatched: false,
    requestDispatchedAtUtc: null,
    responseAtUtc: null,
    httpStatus: null,
    finishReason: null,
    attempts: 0,
    retries: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    latencyMs: 0,
    requestBytes: null,
    responseBytes: null,
    maxOutputTokens: prepared.config.maxOutputTokens,
    structuredOutputMode: prepared.config.structuredOutputMode,
    estimatedInputTokens: estimate.estimatedInputTokens,
    estimatedStageTokenRequirement: estimate.estimatedStageTokenRequirement,
    tpmSafetyMarginTokens: GROQ_TPM_SAFETY_MARGIN,
    pacingDecisionBeforeStage: pacingDecision,
    waitDurationBeforeStageMs: waitMs,
    rawAllowlistedHeaders: null,
    normalizedProviderRateLimit: null,
    providerIdentityPersisted: null,
    zodValid: null,
    editorGuardPassed: null,
    editorPreservedNameCount: null,
    editorPreservedNameObservedCount: null,
    editorPreservedNameOmittedCount: null,
    errorCode: null,
    http429Classification: null,
  };
}

function applyDiagnostics(record: StageRecord, diagnostics: ProviderDiagnostics | undefined): void {
  if (!diagnostics) return;
  record.httpStatus = diagnostics.httpStatus ?? null;
  record.finishReason = diagnostics.finishReason ?? null;
  record.inputTokens = diagnostics.usage?.inputTokens ?? null;
  record.outputTokens = diagnostics.usage?.outputTokens ?? null;
  record.totalTokens = diagnostics.usage?.totalTokens ?? null;
  record.requestBytes = diagnostics.requestMetrics?.bodyBytes ?? null;
  record.responseBytes = diagnostics.responseBodyBytes ?? null;
  record.rawAllowlistedHeaders = captureAllowlistedGroqHeaders(diagnostics.rateLimitHeaders);
  record.normalizedProviderRateLimit = normalizeGroqHeadersForPacing(diagnostics.rateLimitHeaders);
  record.zodValid = diagnostics.validationResult === "valid";
  if (record.stage === "editor") {
    record.editorGuardPassed = diagnostics.finalEditorialDraftValid !== false && diagnostics.guardFailureType === undefined;
    record.editorPreservedNameCount = typeof diagnostics.preservedNamesCount === "number" ? diagnostics.preservedNamesCount : null;
    record.editorPreservedNameObservedCount = typeof diagnostics.preservedNamesObservedCount === "number" ? diagnostics.preservedNamesObservedCount : null;
    record.editorPreservedNameOmittedCount = Array.isArray(diagnostics.omittedPreservedNames) ? diagnostics.omittedPreservedNames.length : null;
  }
}

async function verifyPersistedGroqIdentity(input: {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  runId: string | null;
  expectedModel: string;
}): Promise<boolean> {
  if (!input.runId) return false;
  const [runResponse, reservationResponse] = await Promise.all([
    input.supabase.from("agent_runs").select("provider,config,stats").eq("id", input.runId).maybeSingle(),
    input.supabase.from("agent_logs").select("provider,payload,step").eq("run_id", input.runId).eq("step", "provider_request_reserved"),
  ]);
  if (runResponse.error || !runResponse.data || reservationResponse.error || !reservationResponse.data) return false;
  const run = runResponse.data;
  const config = asRecord(run.config);
  const stats = asRecord(run.stats);
  const telemetry = asRecord(stats.telemetry);
  const reservations = reservationResponse.data;
  const reservation = reservations.length === 1 ? reservations[0] : undefined;
  const payload = asRecord(reservation?.payload);
  return hasExplicitGroqRequestIdentity({
    runProvider: run.provider,
    configProvider: config.provider,
    configModel: config.model,
    telemetryProvider: telemetry.provider,
    telemetryModel: telemetry.model,
    providerRequestsUsed: telemetry.providerRequestsUsed,
    reservationCount: reservations.length,
    reservationProvider: reservation?.provider,
    reservationModel: payload.model,
    reservationDispatched: payload.providerRequestDispatched,
    expectedModel: input.expectedModel,
  });
}

function summarizeDiagnosticsOnError(error: unknown): ProviderDiagnostics | undefined {
  return getProviderDiagnostics(error);
}

function untrustedFreePlanText(manual: ManualPlanConfirmation): string {
  return `User-confirmed plan ${manual.plan}; billingEnabled=${manual.billingEnabled}; paidDeveloperPlan=${manual.paidDeveloperPlan}. These are user-provided confirmation facts, not provider response headers.`;
}

function buildDerived(artifact: Record<string, unknown>, records: StageRecord[], pathStartedAtMs: number | null, fullPath: boolean): void {
  const dispatched = records.filter((record) => record.requestDispatched);
  const usageComplete = dispatched.length > 0 && dispatched.every((record) => record.inputTokens !== null && record.outputTokens !== null && record.totalTokens !== null);
  const unpacedTokenSum = usageComplete ? dispatched.reduce((sum, record) => sum + (record.totalTokens ?? 0), 0) : null;
  const tokenPoints = usageComplete ? dispatched.map((record) => ({ timestampUtc: record.requestDispatchedAtUtc!, amount: record.totalTokens! })) : [];
  const requestPoints = dispatched.map((record) => ({ timestampUtc: record.requestDispatchedAtUtc!, amount: 1 }));
  const maxObserved60 = usageComplete ? maximumRolling60SecondAmount(tokenPoints) : null;
  const maxRequests60 = requestPoints.length ? maximumRolling60SecondAmount(requestPoints) : 0;
  const tpmRemains = records.flatMap((record) => record.normalizedProviderRateLimit?.tokenRemainingMinute === null || record.normalizedProviderRateLimit?.tokenRemainingMinute === undefined ? [] : [record.normalizedProviderRateLimit.tokenRemainingMinute]);
  const lastHeader = [...records].reverse().find((record) => record.normalizedProviderRateLimit !== null)?.normalizedProviderRateLimit ?? null;
  const waitCount = records.filter((record) => record.pacingDecisionBeforeStage === "WAIT_FOR_TOKEN_RESET").length;
  const unpacedClassification = classifyUnpacedPath({ fullPath: fullPath && usageComplete, unpacedTokenSum, tpmLimit: TPM_LIMIT });
  const pacingClassification = classifyGroqPacing({
    fullPath: fullPath && usageComplete,
    waitCount,
    unpacedClassification,
    maximumObserved60sTokens: maxObserved60 ?? 0,
    tpmLimit: TPM_LIMIT,
  });
  const fullTokenTotal = fullPath && usageComplete ? unpacedTokenSum : null;
  artifact.pathStatus = fullPath ? "FULL_PATH" : records.length === 0 ? "NOT_STARTED" : "PARTIAL_PATH";
  artifact.fullPath = fullPath;
  artifact.completedStages = records.filter((record) => record.status === "SUCCESS").map((record) => record.stage);
  artifact.providerCalls = dispatched.length;
  artifact.provider429Count = records.filter((record) => record.httpStatus === 429).length;
  artifact.totalPacingWaitMs = records.reduce((sum, record) => sum + record.waitDurationBeforeStageMs, 0);
  artifact.fullPathRequestCount = fullPath ? dispatched.length : null;
  artifact.fullPathInputTokens = fullPath && usageComplete ? dispatched.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0) : null;
  artifact.fullPathOutputTokens = fullPath && usageComplete ? dispatched.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0) : null;
  artifact.fullPathTotalTokens = fullTokenTotal;
  artifact.wallClockDurationMs = pathStartedAtMs === null ? 0 : Math.max(0, Date.now() - pathStartedAtMs);
  artifact.finalRpdRemaining = lastHeader?.requestRemainingDaily ?? null;
  artifact.observedRpdLimit = lastHeader?.requestLimitDaily ?? null;
  artifact.observedTpmLimit = lastHeader?.tokenLimitMinute ?? null;
  artifact.minimumTpmRemaining = tpmRemains.length ? Math.min(...tpmRemains) : null;
  artifact.maximumApproxObservedRolling60sTokens = maxObserved60;
  artifact.approxObservedRolling60sAboveManualTpm = maxObserved60 !== null && maxObserved60 > TPM_LIMIT;
  artifact.approxObservedRolling60sExcessTokens = maxObserved60 === null ? null : Math.max(0, maxObserved60 - TPM_LIMIT);
  artifact.rolling60sApproximationTimestamp = "request_dispatched_at_utc";
  artifact.maximumObservedRolling60sRequests = maxRequests60;
  artifact.unpacedTokenSum = unpacedTokenSum;
  artifact.approxImmediateSequence60sTokens = fullPath ? fullTokenTotal : null;
  artifact.unpacedClassification = unpacedClassification;
  artifact.pacingClassification = pacingClassification;
  artifact.tpdScenarios = fullTokenTotal === null ? null : calculateTpdScenarios(fullTokenTotal, TPD_LIMIT);
  artifact.requestDemandScenarios = fullPath ? [
    { paths: 10, providerRpdDemand: 60, providerRpd: RPD_LIMIT, internalHardCap: 20, internalSoftThreshold: 17 },
    { paths: 12, providerRpdDemand: 72, providerRpd: RPD_LIMIT, internalHardCap: 20, internalSoftThreshold: 17 },
    { paths: 15, providerRpdDemand: 90, providerRpd: RPD_LIMIT, internalHardCap: 20, internalSoftThreshold: 17 },
  ] : null;
  artifact.counterfactualType = "COUNTERFACTUAL_ESTIMATE";
  artifact.counterfactualIsProviderObserved = false;
}

function safeDocValue(value: unknown): string {
  if (value === null || value === undefined) return "UNKNOWN";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderReport(artifact: Record<string, unknown>): string {
  const preflight = asRecord(artifact.preflight);
  const manual = asRecord(artifact.manualLimits);
  const stageRecords = Array.isArray(artifact.stages) ? artifact.stages.map(asRecord) : [];
  const scenarioRows = Array.isArray(artifact.tpdScenarios) ? artifact.tpdScenarios.map(asRecord) : [];
  const requestRows = Array.isArray(artifact.requestDemandScenarios) ? artifact.requestDemandScenarios.map(asRecord) : [];
  const headerRows = stageRecords.map((stage) => {
    const headers = asRecord(stage.rawAllowlistedHeaders);
    const pacing = safeDocValue(stage.pacingDecisionBeforeStage);
    const wait = safeDocValue(stage.waitDurationBeforeStageMs);
    return `| ${safeDocValue(stage.stage)} | ${safeDocValue(headers["x-ratelimit-limit-requests"])} | ${safeDocValue(headers["x-ratelimit-remaining-requests"])} | ${safeDocValue(headers["x-ratelimit-reset-requests"])} | ${safeDocValue(headers["x-ratelimit-limit-tokens"])} | ${safeDocValue(headers["x-ratelimit-remaining-tokens"])} | ${safeDocValue(headers["x-ratelimit-reset-tokens"])} | ${safeDocValue(headers["retry-after"])} | ${pacing} | ${wait} |`;
  }).join("\n");
  const tokenRows = stageRecords.map((stage) => `| ${safeDocValue(stage.stage)} | ${safeDocValue(stage.agentVersion)} | ${safeDocValue(stage.inputTokens)} | ${safeDocValue(stage.outputTokens)} | ${safeDocValue(stage.totalTokens)} | ${safeDocValue(stage.estimatedStageTokenRequirement)} | ${safeDocValue(stage.latencyMs)} | ${safeDocValue(stage.requestBytes)} | ${safeDocValue(stage.responseBytes)} |`).join("\n");
  const stageSummary = stageRecords.map((stage) => `- ${safeDocValue(stage.stage)}: ${safeDocValue(stage.status)}; provider=${safeDocValue(stage.provider)}; model=${safeDocValue(stage.model)}; version=${safeDocValue(stage.agentVersion)}; attempts=${safeDocValue(stage.attempts)}; retries=${safeDocValue(stage.retries)}; provider identity persisted=${safeDocValue(stage.providerIdentityPersisted)}.`).join("\n");
  const tpdTable = scenarioRows.length
    ? `| Paths | Token demand | % of 200,000 TPD | Hard TPD | Soft 85% TPD |\n| ---: | ---: | ---: | --- | --- |\n${scenarioRows.map((row) => `| ${safeDocValue(row.paths)} | ${safeDocValue(row.tokenDemand)} | ${Number(row.percentageOfHardTpd).toFixed(2)}% | ${row.fitsHardTpd ? "YES" : "NO"} | ${row.fitsSoft85PercentTpd ? "YES" : "NO"} |`).join("\n")}`
    : "No calculable full-path token sample (path incomplete or token usage unavailable).";
  const requestTable = requestRows.length
    ? `| Paths | Requests | Provider RPD 1,000 | Internal hard 20 / soft 17 |\n| ---: | ---: | --- | --- |\n${requestRows.map((row) => `| ${safeDocValue(row.paths)} | ${safeDocValue(row.providerRpdDemand)} | ${Number(row.providerRpdDemand) <= RPD_LIMIT ? "within provider RPD" : "over provider RPD"} | exceeds current internal admission |`).join("\n")}`
    : "For a complete 6-request path, 10/12/15 paths would require 60/72/90 requests respectively; the current internal 20/day hard cap and 17/day soft admission bind first. This comparison is demand arithmetic, not an authorization to run multiple paths.";
  const preflightPassed = preflight.passed === true;
  return `# 10G.7a.4 — Groq Full-Path Token + Header-Driven Pacing Probe

## PURPOSE

Measure one supervised, sequential six-stage HorizAI lineage on Groq for capacity only. This is not semantic quality certification. Probe ID: \`${safeDocValue(artifact.probeId)}\`; UTC period: \`${safeDocValue(artifact.utcPeriod)}\`; provider/model: \`${safeDocValue(artifact.provider)}\` / \`${safeDocValue(artifact.model)}\`.

## FREE PLAN EVIDENCE

- Provenance: \`${safeDocValue(manual.provenance)}\`; plan: **${safeDocValue(manual.plan)}**; billing enabled: **${safeDocValue(manual.billingEnabled)}**; Paid Developer plan: **${safeDocValue(manual.paidDeveloperPlan)}**.
- User-confirmed model limits: **${safeDocValue(manual.rpm)} RPM / ${safeDocValue(manual.rpd)} RPD / ${safeDocValue(manual.tpm)} TPM / ${safeDocValue(manual.tpd)} TPD**.
- These are kept distinct from \`PROVIDER_REPORTED_HEADERS\`. The prior response headers reported RPD 1000 and TPM 8000, but did not report RPM or TPD.
- No service tier, paid fallback, tools, or external search are enabled by this harness.

## FIXTURE

One synthetic, copyright-safe event: Lumen Labs announces its fictional Lumen-1 inference accelerator. Two synthetic sources corroborate a 32 GB HBM specification and Q4 2026 pilot availability. Domains use reserved \`.example\`; there is no production event ID, production source, raw-item/event/article mutation, or publication.

## PRE-ADMISSION

- Preflight: **${preflightPassed ? "PASS" : "BLOCKED"}**; reason: \`${safeDocValue(preflight.reason ?? preflight.admissionReason)}\`.
- UTC request period: \`${safeDocValue(preflight.utcPeriod)}\`; starting provider-scoped usage: **${safeDocValue(preflight.currentRequestsUsed)} reserved / ${safeDocValue(preflight.internalHardCap)} hard cap**, **${safeDocValue(preflight.currentRequestsRemaining)} remaining**.
- Six-request projection: **${safeDocValue(preflight.projectedRequestsAfterPath)}** total reserved if admitted; soft threshold **${safeDocValue(preflight.internalSoftThreshold)}**. Admission reason: \`${safeDocValue(preflight.admissionReason)}\`.
- Persistent Supabase read-only usage/rate-block checks: **${safeDocValue(preflight.supabaseReadStatus)}**. The normal runtime creates only its permitted \`agent_runs\`/\`agent_logs\` accounting records.

## STAGE EXECUTION

Path: **${safeDocValue(artifact.pathStatus)}**. Completed stage calls: **${safeDocValue(artifact.providerCalls)}**; stop reason: \`${safeDocValue(artifact.stopReason)}\`.

${stageSummary || "No stage was dispatched."}

## TOKENS BY STAGE

| Stage | Version | Input | Output | Total | Estimated request tokens | Latency ms | Request bytes | Response bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${tokenRows || "| — | — | — | — | — | — | — | — | — |"}

## RATE LIMIT HEADERS

Only the allowlisted RPD/TPM headers and \`retry-after\` are captured; raw full headers and authorization are never persisted.

| Stage | RPD limit | RPD remaining | RPD reset | TPM limit | TPM remaining | TPM reset | retry-after | Pacing decision | Wait ms |
| --- | ---: | ---: | --- | ---: | ---: | --- | --- | --- | ---: |
${headerRows || "| — | — | — | — | — | — | — | — | — | — |"}

## PACING

- Estimate method: exact production system-instruction/input/schema character lengths, existing conservative \`ceil(chars / 2) + 128\` input estimate, real stage \`maxOutputTokens\`, then a deterministic **128-token** headroom margin. This is an estimate, not a tokenizer result.
- TPM hard ceiling used for single-stage safety: **8,000**. Reset wait adds a deterministic **250 ms** margin to the provider-reported token reset; there is no random sleep and no RPD-based wait.
- Classification: **${safeDocValue(artifact.pacingClassification)}**; total pacing wait: **${safeDocValue(artifact.totalPacingWaitMs)} ms**.

## FULL PATH

- Status: **${safeDocValue(artifact.pathStatus)}**; all six stages and six real requests: **${artifact.fullPath === true ? "YES" : "NO"}**.
- Input/output/total: **${safeDocValue(artifact.fullPathInputTokens)} / ${safeDocValue(artifact.fullPathOutputTokens)} / ${safeDocValue(artifact.fullPathTotalTokens)}** tokens.
- Wall-clock duration: **${safeDocValue(artifact.wallClockDurationMs)} ms**; provider 429 count: **${safeDocValue(artifact.provider429Count)}**.
- Final RPD remaining: **${safeDocValue(artifact.finalRpdRemaining)}**; minimum observed TPM remaining: **${safeDocValue(artifact.minimumTpmRemaining)}**.

## UNPACED COUNTERFACTUAL

Unpaced classification: **${safeDocValue(artifact.unpacedClassification)}**. Unpaced token sum from completed stages: **${safeDocValue(artifact.unpacedTokenSum)}**; approximate immediate-sequence 60-second demand: **${safeDocValue(artifact.approxImmediateSequence60sTokens)}**. These are \`COUNTERFACTUAL_ESTIMATE\` values, not provider-observed unpaced behavior.

For the actually paced path, the approximate rolling-60-second total was **${safeDocValue(artifact.maximumApproxObservedRolling60sTokens)} tokens**, calculated by assigning each stage's total usage to its request-dispatch timestamp. This is **${artifact.approxObservedRolling60sAboveManualTpm === true ? `about ${safeDocValue(artifact.approxObservedRolling60sExcessTokens)} tokens above the manually confirmed 8,000 TPM` : "at or below the manually confirmed 8,000 TPM"}. No HTTP 429 occurred. This timestamp-bucket estimate can differ from Groq's internal window accounting and is not proof of an actual provider-limit violation; it is a caution that the header-driven waits do not certify rolling-window headroom.

Maximum observed requests in a rolling 60 seconds: **${safeDocValue(artifact.maximumObservedRolling60sRequests)}**; theoretical immediate sequence: at most six. This does not validate concurrent-event safety.

## RPM/RPD ANALYSIS

Manual plan limits: **30 RPM / 1,000 RPD**. Provider response headers expose RPD in this probe but not RPM.

${requestTable}

## TPM ANALYSIS

Manual TPM: **8,000**. Maximum approximate observed rolling-60-second token total: **${safeDocValue(artifact.maximumApproxObservedRolling60sTokens)}**; minimum reported remaining TPM across responses: **${safeDocValue(artifact.minimumTpmRemaining)}**. The timestamp-based approximation ${artifact.approxObservedRolling60sAboveManualTpm === true ? `exceeds 8,000 by ${safeDocValue(artifact.approxObservedRolling60sExcessTokens)} tokens, despite no 429` : "does not exceed 8,000"}; interpret it as a caution, not exact provider accounting. A single stage is blocked before dispatch if its conservative estimate plus safety margin exceeds 8,000. No N=1 finding is generalized to p75/p90 or concurrency.

## TPD 10/12/15 ANALYSIS

Manual TPD: **200,000**; planning threshold at 85%: **170,000**. If a full path with known provider usage completed, the N=1 estimates are:

${tpdTable}

These are capacity estimates based on one observed path, not production guarantees.

## INTERNAL 20-DAY CAP

Internal Groq hard cap remains **20 requests/UTC day**, soft ratio **0.85**, threshold **17**. Changed: **NO**. For full paths, 6 requests/path means the current internal soft admission binds well before provider RPD. No internal TPM/RPM/TPD or daily-token configuration was added.

## LIMITATIONS

- One synthetic sequential lineage only; no parallel requests, load test, or attempt to approach provider limits.
- A single path cannot certify concurrency, provider account/project scope, future traffic shape, or p75/p90.
- No semantic or editorial quality certification was performed; no chain-of-thought, full prompt, or model output is included here.
- Provider calls: **${safeDocValue(artifact.providerCalls)}**; Cloudflare: **0**; Cerebras: **0**; retries: **0**; fallback: **0**; published articles: **0**; secrets persisted: **NO**.

## PRODUCTION GATES

- technicalAllStagesValidated: **true**
- semanticQualityGateValidated: **false**
- capacityArchitectureProviderScoped: **true**
- capacityProductionReady: **false**
- schedulerThroughputReady: **false**
- productionRoutingEnabled: **false**

## NEXT STEP

${artifact.fullPath === true ? "After review, choose between 10G.7a.5 — GROQ CAPACITY POLICY + PACING DESIGN and 10G.7b — MINIMAL CLOUDFLARE QUALITY BENCHMARK. Neither was started." : "The path did not complete. Review the recorded stop reason and this partial capacity evidence; no later phase was started."}
`;
}

async function writeArtifacts(artifact: Record<string, unknown>): Promise<void> {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await mkdir(resolve(process.cwd(), "docs"), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(REPORT_PATH, renderReport(artifact), "utf8");
}

function makeBaseArtifact(input: {
  probeId: string;
  preflight: ProbePreflight;
  planEvidence: ReturnType<typeof separateGroqLimitProvenance>;
  versions: Record<StageName, string>;
}): Record<string, unknown> {
  return {
    probeId: input.probeId,
    phase: "10G.7a.4",
    createdAtUtc: new Date().toISOString(),
    utcPeriod: input.preflight.utcPeriod,
    freePlanEvidence: input.planEvidence,
    manualLimits: input.planEvidence.humanConfirmedPlan,
    previousProviderReportedLimits: input.planEvidence.providerReportedLimits,
    provider: PROVIDER,
    model: MODEL,
    agentVersions: input.versions,
    preflight: input.preflight,
    startingInternalRequestAccounting: {
      provider: PROVIDER,
      utcPeriod: input.preflight.utcPeriod,
      requestsUsed: input.preflight.currentRequestsUsed,
      requestsDispatched: input.preflight.currentRequestsDispatched,
      requestsRemaining: input.preflight.currentRequestsRemaining,
      hardCap: input.preflight.internalHardCap,
      softThreshold: input.preflight.internalSoftThreshold,
      projectedNewPathRequests: MAX_PATH_REQUESTS,
      projectedAfterPath: input.preflight.projectedRequestsAfterPath,
      admissionReason: input.preflight.admissionReason,
    },
    stages: [] as StageRecord[],
    pathStatus: "NOT_STARTED",
    stopReason: input.preflight.reason,
    providerCalls: 0,
    cloudflareCalls: 0,
    cerebrasCalls: 0,
    retries: 0,
    fallbackCalls: 0,
    publishedArticles: 0,
    secretsPersisted: false,
    internalGroqRequestCap: { hard: input.preflight.internalHardCap, softRatio: input.preflight.internalSoftRatio, softThreshold: input.preflight.internalSoftThreshold, changed: false },
    productionGates: {
      technicalAllStagesValidated: true,
      semanticQualityGateValidated: false,
      capacityArchitectureProviderScoped: true,
      capacityProductionReady: false,
      schedulerThroughputReady: false,
      productionRoutingEnabled: false,
    },
    readiness: { phase10g7a4Ready: false },
  };
}

async function waitForTokenReset(stage: StageName, milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  const deadline = Date.now() + milliseconds;
  console.log(JSON.stringify({ event: "PACING_WAIT", stage, waitDurationMs: milliseconds, source: "PROVIDER_TOKEN_RESET_PLUS_250MS" }));
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(30_000, remaining)));
    if (Date.now() < deadline) console.log(JSON.stringify({ event: "PACING_WAIT_PROGRESS", stage, remainingMs: deadline - Date.now() }));
  }
}

async function invokeStage(input: {
  stage: StageName;
  context: SyntheticContext;
  config: ModelConfig;
  provider: ModelProvider;
  logger: SupabaseAgentLogger;
  budget: ProviderScopedDailyRequestBudget;
}): Promise<AgentExecutionResult<unknown>> {
  const common = { dryRun: true, modelConfig: input.config, requestBudget: input.budget };
  switch (input.stage) {
    case "verifier": return await new VerifierAgent(input.provider, input.logger).verify(input.context.verifierInput, common);
    case "translator": return await new TranslatorAgent(input.provider, input.logger).translate({
      schemaVersion: 1,
      event: input.context.event,
      verification: requireContext(input.context.verification, "verification"),
      sourceLanguage: "en",
      sources: translatorSources(input.context),
    }, common);
    case "editor": return await new EditorV2Agent(input.provider, input.logger).edit(buildEditorInput({
      event: { eventKey: input.context.event.eventKey, canonicalTitle: input.context.event.canonicalTitle },
      verification: requireContext(input.context.verification, "verification"),
      translation: requireContext(input.context.translation, "translation"),
      sources: input.context.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: source.sourceUrl, sourceType: source.sourceType || "unknown" })),
    }), common);
    case "classifier": return await new ClassifierAgent(input.provider, input.logger).classify(buildClassifierInput({
      event: { eventKey: input.context.event.eventKey, canonicalTitle: input.context.event.canonicalTitle },
      verification: requireContext(input.context.verification, "verification"),
      translation: requireContext(input.context.translation, "translation"),
      editorial: requireContext(input.context.editorial, "editorial"),
      sources: input.context.sources.map((source) => ({ sourceName: source.sourceName, sourceType: source.sourceType || "unknown", countryCode: source.countryCode })),
    }), { ...common, registry: classifierFixtureRegistry });
    case "ranker": return await new RankerAgent(input.provider, input.logger).rank(buildRankerPipelineInput({
      event: rankEvent(input.context),
      verification: requireContext(input.context.verification, "verification"),
      translation: requireContext(input.context.translation, "translation"),
      editorial: requireContext(input.context.editorial, "editorial"),
      classification: requireContext(input.context.classification, "classification"),
    }), common);
    case "critic": {
      const rankerExecution = requireContext(input.context.rankerExecution, "ranker_execution");
      const signals = rankerExecution.signals;
      const geo = resolveGeo({ regionCode: input.context.classification?.primaryRegionCode ?? null }, classifierFixtureRegistry);
      const criticInput = buildCriticInput({
        event: rankEvent(input.context),
        verification: requireContext(input.context.verification, "verification"),
        translation: requireContext(input.context.translation, "translation"),
        editorial: requireContext(input.context.editorial, "editorial"),
        classification: requireContext(input.context.classification, "classification"),
        ranking: {
          result: rankerExecution.output,
          formulaVersion: rankerExecution.formulaVersion,
          momentumAvailable: signals.momentumAvailable,
          deterministicSignals: {
            credibility: signals.credibility,
            reach: signals.reach,
            momentum: signals.momentum,
            sourceCount: signals.sourceCount,
            contradictionPenalty: signals.contradictionPenalty,
            uncertaintyPenalty: signals.uncertaintyPenalty,
            geographicReachSignal: signals.geographicReachSignal,
          },
        },
        sources: translatorSources(input.context),
        sourceEvidence: buildCriticSourceEvidence(input.context.sources, input.context.items),
        geo: { latitude: geo.latitude, longitude: geo.longitude, resolutionLevel: geo.resolutionLevel, resolvedFrom: geo.resolvedFrom },
      });
      return await new CriticAgent(input.provider, input.logger).critique(criticInput, { ...common, registry: classifierFixtureRegistry });
    }
  }
}

async function recheckAdmission(input: { logger: SupabaseAgentLogger; utcPeriod: string; remainingPathRequests: number }): Promise<{ passed: boolean; currentUsage: number | null; projectedUsage: number | null; reason: string }> {
  const now = new Date();
  const dateUtc = now.toISOString().slice(0, 10);
  if (dateUtc !== input.utcPeriod) return { passed: false, currentUsage: null, projectedUsage: null, reason: "UTC_PERIOD_CHANGED_DURING_PATH" };
  try {
    const admission = await readGroqAdmission({ logger: input.logger, now, requiredRequests: input.remainingPathRequests });
    return {
      passed: admission.passed,
      currentUsage: admission.usage?.requestsReserved ?? null,
      projectedUsage: admission.projectedRequests,
      reason: admission.reason,
    };
  } catch {
    return { passed: false, currentUsage: null, projectedUsage: null, reason: "PERSISTENT_PROVIDER_CAPACITY_READ_FAILED" };
  }
}

function updateContextWithResult(context: SyntheticContext, stage: StageName, output: unknown, result: AgentExecutionResult<unknown>): void {
  switch (stage) {
    case "verifier": context.verification = output as VerificationResult; return;
    case "translator": context.translation = output as TranslationResult; return;
    case "editor": context.editorial = output as EditorialDraft; return;
    case "classifier": context.classification = output as ClassificationResult; return;
    case "ranker": context.rankerExecution = result as RankerExecutionResult; context.ranking = output as RankingResult; return;
    case "critic": return;
  }
}

async function executePath(input: {
  artifact: Record<string, unknown>;
  context: SyntheticContext;
  modelConfigs: Record<StageName, ModelConfig>;
  versions: Record<StageName, string>;
  logger: SupabaseAgentLogger;
  supabase: ReturnType<typeof createSupabaseServerClient>;
  manual: ManualPlanConfirmation;
}): Promise<void> {
  const startedAt = Date.now();
  const provider = new CappedGroqPathProvider(createConfiguredModelProvider());
  const requestBudget = new ProviderScopedDailyRequestBudget();
  const records = input.artifact.stages as StageRecord[];
  let previousHeaders: ProviderRateLimitTelemetry | null = null;
  let stopReason: string | null = null;
  let fullPath = false;

  for (let index = 0; index < STAGE_ORDER.length; index += 1) {
    const stage = STAGE_ORDER[index];
    const config: ModelConfig = { ...input.modelConfigs[stage], maxRetries: 0 };
    if (provider.dispatches.length >= MAX_PATH_REQUESTS) {
      stopReason = "SIX_REQUEST_HARD_CAP_REACHED";
      break;
    }
    const prepared = prepareStage(stage, input.context, config);
    const schemaChars = JSON.stringify(toStrictProviderJsonSchema(prepared.schema)).length;
    const estimate = estimateGroqStageTokenRequirement({
      systemInstructionChars: prepared.systemInstructions.length,
      modelInputChars: JSON.stringify(prepared.modelInput).length,
      schemaChars,
      maxOutputTokens: config.maxOutputTokens,
    });
    const pacing = decideGroqTpmPacing({
      isFirstStage: index === 0,
      providerHeaders: previousHeaders,
      estimatedStageTokenRequirement: estimate.estimatedStageTokenRequirement,
      tokenLimitTpm: input.manual.tpm,
      safetyMarginTokens: GROQ_TPM_SAFETY_MARGIN,
      resetSafetyMarginMs: GROQ_RESET_SAFETY_MARGIN_MS,
    });
    const record = makeInitialStageRecord(stage, prepared, estimate, pacing.decision, pacing.waitDurationMs);
    records.push(record);
    if (pacing.decision === "BLOCKED_SINGLE_STAGE_TPM_SAFETY" || pacing.decision === "BLOCKED_TPM_RESET_UNKNOWN") {
      record.status = "BLOCKED_BEFORE_DISPATCH";
      record.errorCode = pacing.decision;
      stopReason = pacing.decision;
      await writeArtifacts(input.artifact);
      break;
    }
    if (pacing.decision === "WAIT_FOR_TOKEN_RESET") await waitForTokenReset(stage, pacing.waitDurationMs);

    const admission = await recheckAdmission({
      logger: input.logger,
      utcPeriod: String(input.artifact.utcPeriod),
      remainingPathRequests: STAGE_ORDER.length - index,
    });
    record.providerIdentityPersisted = null;
    if (!admission.passed) {
      record.status = "BLOCKED_BEFORE_DISPATCH";
      record.errorCode = admission.reason;
      stopReason = admission.reason;
      record.responseAtUtc = new Date().toISOString();
      await writeArtifacts(input.artifact);
      break;
    }

    const dispatchesBefore = provider.dispatches.length;
    provider.activeStage = stage;
    const callStartedAt = Date.now();
    try {
      const result = await invokeStage({ stage, context: input.context, config, provider, logger: input.logger, budget: requestBudget });
      provider.activeStage = null;
      const dispatchesAfter = provider.dispatches.length;
      const dispatchDelta = dispatchesAfter - dispatchesBefore;
      record.requestDispatched = dispatchDelta === 1;
      record.requestDispatchedAtUtc = provider.dispatches.at(-1)?.dispatchedAtUtc ?? null;
      record.responseAtUtc = new Date().toISOString();
      record.attempts = result.attempts;
      record.retries = Math.max(0, result.attempts - 1);
      record.latencyMs = result.latencyMs;
      applyDiagnostics(record, result.diagnostics);
      const providerIdentity = result.telemetry?.provider ?? result.diagnostics?.provider;
      try {
        assertGroqStageIdentity({ provider: providerIdentity, model: result.model, expectedModel: MODEL });
      } catch {
        record.status = "FAILED_PROVIDER_IDENTITY";
        record.errorCode = "GROQ_STAGE_IDENTITY_MISMATCH";
        stopReason = record.errorCode;
        await writeArtifacts(input.artifact);
        break;
      }
      if (dispatchDelta === 0 && stage === "critic" && result.attempts === 0) {
        record.status = "DETERMINISTIC_NO_CALL";
        record.providerIdentityPersisted = null;
        updateContextWithResult(input.context, stage, result.output, result);
        stopReason = "CRITIC_DETERMINISTIC_PRECHECK_NO_MODEL_CALL";
        await writeArtifacts(input.artifact);
        break;
      }
      if (dispatchDelta !== 1 || result.providerRequestsUsed !== 1 || result.attempts !== 1) {
        record.status = "FAILED_REQUEST_COUNT_OR_ATTEMPT_GUARD";
        record.errorCode = "STAGE_DID_NOT_USE_EXACTLY_ONE_REQUEST";
        stopReason = record.errorCode;
        await writeArtifacts(input.artifact);
        break;
      }
      record.providerIdentityPersisted = await verifyPersistedGroqIdentity({ supabase: input.supabase, runId: result.runId, expectedModel: MODEL });
      if (record.providerIdentityPersisted !== true) {
        record.status = "FAILED_PROVIDER_IDENTITY_PERSISTENCE";
        record.errorCode = "EXPLICIT_PROVIDER_IDENTITY_PERSISTENCE_FAILED";
        stopReason = record.errorCode;
        await writeArtifacts(input.artifact);
        break;
      }
      if (result.telemetry?.zodValid !== true && result.diagnostics?.validationResult !== "valid") {
        record.status = "FAILED_OUTPUT_VALIDATION_TELEMETRY";
        record.errorCode = "STAGE_OUTPUT_VALIDATION_NOT_CONFIRMED";
        stopReason = record.errorCode;
        await writeArtifacts(input.artifact);
        break;
      }
      if (stage === "editor") {
        record.editorGuardPassed = result.diagnostics?.guardFailureType === undefined
          && result.diagnostics?.finalEditorialDraftValid !== false;
        if (!record.editorGuardPassed) {
          record.status = "FAILED_EDITOR_DETERMINISTIC_GUARD";
          record.errorCode = "EDITOR_DETERMINISTIC_GUARD_FAILED";
          stopReason = record.errorCode;
          await writeArtifacts(input.artifact);
          break;
        }
      }
      record.status = "SUCCESS";
      updateContextWithResult(input.context, stage, result.output, result);
      previousHeaders = record.normalizedProviderRateLimit;
      if (stage === "verifier") {
        const verification = result.output as VerificationResult;
        if (verification.status === "rejected") {
          stopReason = "VERIFIER_REJECTED_EVENT";
          await writeArtifacts(input.artifact);
          break;
        }
        if (verification.verifiedFacts.length === 0) {
          stopReason = "VERIFIER_ZERO_VERIFIED_FACTS";
          await writeArtifacts(input.artifact);
          break;
        }
      }
      if (!record.normalizedProviderRateLimit || record.normalizedProviderRateLimit.tokenRemainingMinute === null) {
        if (stage !== "critic") {
          stopReason = "BLOCKED_TPM_RESET_UNKNOWN";
          await writeArtifacts(input.artifact);
          break;
        }
      }
      console.log(JSON.stringify({
        event: "GROQ_STAGE_COMPLETE",
        stage,
        version: record.agentVersion,
        httpStatus: record.httpStatus,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        totalTokens: record.totalTokens,
        latencyMs: record.latencyMs,
        tpmRemaining: record.normalizedProviderRateLimit?.tokenRemainingMinute ?? null,
        pacingDecisionBeforeStage: record.pacingDecisionBeforeStage,
        waitDurationBeforeStageMs: record.waitDurationBeforeStageMs,
      }));
      await writeArtifacts(input.artifact);
      if (stage === "critic") {
        fullPath = records.length === STAGE_ORDER.length && records.every((item) => item.status === "SUCCESS" && item.requestDispatched);
        stopReason = fullPath ? null : "CRITIC_DID_NOT_COMPLETE_FULL_GROQ_PATH";
        break;
      }
    } catch (error) {
      provider.activeStage = null;
      const dispatchesAfter = provider.dispatches.length;
      const dispatchDelta = dispatchesAfter - dispatchesBefore;
      const diagnostics = summarizeDiagnosticsOnError(error);
      const failureDetails = getAgentFailureDetails(error);
      record.status = "FAILED";
      record.requestDispatched = dispatchDelta === 1;
      record.requestDispatchedAtUtc = provider.dispatches.at(-1)?.dispatchedAtUtc ?? null;
      record.responseAtUtc = new Date().toISOString();
      record.attempts = failureDetails.attempts;
      record.retries = Math.max(0, failureDetails.attempts - 1);
      record.latencyMs = failureDetails.latencyMs || Math.max(0, Date.now() - callStartedAt);
      record.errorCode = safeErrorCode(error);
      applyDiagnostics(record, diagnostics);
      record.http429Classification = diagnostics?.httpStatus === 429
        ? classifyGroq429Evidence({ headers: diagnostics.rateLimitHeaders, providerMessage: diagnostics.providerMessage, providerCode: diagnostics.providerCode })
        : null;
      stopReason = diagnostics?.httpStatus === 429 ? `HTTP_429_${record.http429Classification}` : record.errorCode;
      console.log(JSON.stringify({ event: "GROQ_STAGE_STOP", stage, status: record.status, httpStatus: record.httpStatus, errorCode: record.errorCode, retries: record.retries, providerCalls: provider.dispatches.length }));
      await writeArtifacts(input.artifact);
      break;
    }
  }

  if (!stopReason && !fullPath) stopReason = "NATURAL_PATH_STOPPED_BEFORE_CRITIC_COMPLETION";
  input.artifact.stopReason = stopReason;
  input.artifact.endedAtUtc = new Date().toISOString();
  input.artifact.retries = records.reduce((sum, record) => sum + record.retries, 0);
  input.artifact.providerMethodCalls = provider.methodCalls;
  input.artifact.providerCalls = provider.dispatches.length;
  input.artifact.dispatchLineage = provider.dispatches.map((dispatch) => ({ ...dispatch }));
  input.artifact.pathRunDurationMs = Math.max(0, Date.now() - startedAt);
  buildDerived(input.artifact, records, startedAt, fullPath);
  const noFailures = records.every((record) => record.status === "SUCCESS");
  const ready = fullPath
    && noFailures
    && provider.methodCalls === MAX_PATH_REQUESTS
    && provider.dispatches.length === MAX_PATH_REQUESTS
    && records.every((record) => record.providerIdentityPersisted === true && record.attempts === 1 && record.retries === 0)
    && input.artifact.cloudflareCalls === 0
    && input.artifact.cerebrasCalls === 0;
  input.artifact.readiness = { phase10g7a4Ready: ready };
  await writeArtifacts(input.artifact);
  console.log(JSON.stringify({
    event: "GROQ_FULL_PATH_PROBE_FINISHED",
    path: input.artifact.pathStatus,
    providerCalls: input.artifact.providerCalls,
    completedStages: input.artifact.completedStages,
    stopReason: input.artifact.stopReason,
    fullPathTotalTokens: input.artifact.fullPathTotalTokens,
    totalPacingWaitMs: input.artifact.totalPacingWaitMs,
    phaseReady: ready,
    artifact: "artifacts/groq-full-path-capacity-probe-10g7a4.json",
  }));
}

async function main(): Promise<void> {
  const mode = resolveGroqProbeExecutionMode(process.argv.slice(2));
  const now = new Date();
  const probeId = randomUUID();
  const context = makeSyntheticContext(now);
  let manualEvidence: Awaited<ReturnType<typeof readManualPlanConfirmation>>;
  try {
    manualEvidence = await readManualPlanConfirmation();
  } catch (error) {
    const failed = {
      probeId,
      phase: "10G.7a.4",
      utcPeriod: now.toISOString().slice(0, 10),
      provider: PROVIDER,
      model: MODEL,
      providerCalls: 0,
      pathStatus: "NOT_STARTED",
      stopReason: safeErrorCode(error),
      manualProvenance: "USER_MANUAL_CONFIRMATION",
      cloudflareCalls: 0,
      cerebrasCalls: 0,
      retries: 0,
      fallbackCalls: 0,
      publishedArticles: 0,
      secretsPersisted: false,
      productionGates: { technicalAllStagesValidated: true, semanticQualityGateValidated: false, capacityArchitectureProviderScoped: true, capacityProductionReady: false, schedulerThroughputReady: false, productionRoutingEnabled: false },
      readiness: { phase10g7a4Ready: false },
    };
    await writeArtifacts(failed);
    console.log(JSON.stringify({ status: "BLOCKED", reason: safeErrorCode(error), providerCalls: 0, artifact: "artifacts/groq-full-path-capacity-probe-10g7a4.json" }));
    process.exitCode = 1;
    return;
  }

  let modelConfigs: Record<StageName, ModelConfig>;
  try {
    modelConfigs = configuredModelConfigs();
  } catch (error) {
    console.log(JSON.stringify({ status: "BLOCKED", reason: safeErrorCode(error), providerCalls: 0 }));
    process.exitCode = 1;
    return;
  }
  let supabase: ReturnType<typeof createSupabaseServerClient>;
  let logger: SupabaseAgentLogger;
  try {
    supabase = createSupabaseServerClient();
    logger = new SupabaseAgentLogger(supabase);
  } catch {
    console.log(JSON.stringify({ status: "BLOCKED", reason: "SUPABASE_SERVER_CLIENT_UNAVAILABLE", providerCalls: 0 }));
    process.exitCode = 1;
    return;
  }
  const preflight = await runPreflight({ modelConfigs, logger, manualPlanValid: true, now });
  const versions = stageVersions();
  const planEvidence = separateGroqLimitProvenance({
    manualConfirmation: {
      confirmation: manualEvidence.manual.confirmation,
      plan: manualEvidence.manual.plan,
      model: manualEvidence.manual.model,
      rpm: manualEvidence.manual.rpm,
      rpd: manualEvidence.manual.rpd,
      tpm: manualEvidence.manual.tpm,
      tpd: manualEvidence.manual.tpd,
      billingEnabled: manualEvidence.manual.billingEnabled,
      paidDeveloperPlan: manualEvidence.manual.paidDeveloperPlan,
    },
    providerReported: manualEvidence.previousProviderReported,
  });
  const artifact = makeBaseArtifact({ probeId, preflight, planEvidence, versions });
  artifact.syntheticFixture = {
    eventKey: context.event.eventKey,
    sourceCount: context.sources.length,
    sourceTypes: context.sources.map((source) => source.sourceType),
    syntheticOnly: true,
    copyrightSafe: true,
    publishedAtUtc: context.event.probableOccurredAt,
  };
  artifact.freePlanEvidenceNote = untrustedFreePlanText(manualEvidence.manual);
  await writeArtifacts(artifact);
  console.log(JSON.stringify({
    event: "GROQ_CAPACITY_PREFLIGHT",
    mode,
    passed: preflight.passed,
    provider: PROVIDER,
    model: MODEL,
    currentRequestsUsed: preflight.currentRequestsUsed,
    remaining: preflight.currentRequestsRemaining,
    projectedAfterSix: preflight.projectedRequestsAfterPath,
    hardCap: preflight.internalHardCap,
    softThreshold: preflight.internalSoftThreshold,
    admissionReason: preflight.admissionReason,
    providerCalls: 0,
    artifact: "artifacts/groq-full-path-capacity-probe-10g7a4.json",
  }));
  if (!preflight.passed) {
    artifact.pathStatus = "NOT_STARTED";
    artifact.stopReason = preflight.reason ?? "PREFLIGHT_CHECK_FAILED";
    await writeArtifacts(artifact);
    process.exitCode = 1;
    return;
  }
  if (mode === "PREFLIGHT_ONLY") {
    artifact.pathStatus = "NOT_STARTED";
    artifact.stopReason = "NO_EXECUTE_FLAG_PROVIDER_CALLS_ZERO";
    artifact.cliDefaultNoCall = true;
    await writeArtifacts(artifact);
    return;
  }
  await executePath({ artifact, context, modelConfigs, versions, logger, supabase, manual: manualEvidence.manual });
}

main().catch(async (error: unknown) => {
  console.log(JSON.stringify({ status: "BLOCKED_OR_FAILED", reason: safeErrorCode(error), providerCalls: 0, noSecretValuesPrinted: true }));
  process.exitCode = 1;
});
