import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCriticModelInput } from "../lib/agents/critic/critic-input.ts";
import { estimateCriticV4Request } from "../lib/agents/critic/critic-estimate.ts";
import { createReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { runCriticPrechecks } from "../lib/agents/critic/critic-prechecks.ts";
import { factualRemediationIncident as incident } from "../lib/agents/pipeline/factual-remediation.ts";
import { loadFactualRemediationContinuationCheckpoints } from "../lib/agents/pipeline/factual-remediation-continuation-checkpoints.ts";
import {
  canonicalJsonString,
  continuationCheckpointManifestSchema,
  continuationCheckpointManifestsEqual,
  factualRemediationContinuation as continuation,
} from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { runPreviouslyAuthorizedContinuation } from "./factual-remediation-critic-continuation-12c2b2c.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import {
  decideGroqTpmPacing,
  estimateGroqStageTokenRequirement,
  GROQ_TPM_SAFETY_MARGIN,
} from "../lib/agents/runtime/groq-capacity-pacing.ts";
import {
  evaluateGroqNewEventAdmission,
  readGroqDailyTokenHardLimit,
} from "../lib/agents/runtime/groq-capacity-policy.ts";
import {
  DAILY_SOFT_LIMIT_RATIO,
  freeProviderRouterEnabled,
  readGroqAtomicCapacityLimits,
  readProviderCapacityConfig,
} from "../lib/agents/runtime/free-provider-router.ts";
import {
  assertFreeProviderRequest,
  freeProviderPolicy,
} from "../lib/agents/runtime/provider-cost-policy.ts";
import { resolveGroqDailyRequestHardCap } from "../lib/agents/runtime/request-budget.ts";
import { agentTelemetrySchema } from "../lib/agents/runtime/telemetry.ts";
import { normalizeGroqProviderRateLimit, readRateLimitHeaders, parseDurationSeconds } from "../lib/agents/runtime/model-provider.ts";
import type { AgentRunMetadata, GroqCapacityLimits, GroqTokenSettlementResult, RateLimitHeaders } from "../lib/agents/runtime/runtime-types.ts";
import type { Json } from "../types/database.ts";

const MODEL = "openai/gpt-oss-20b";
const TPM_LIMIT = 8_000;
const CRITIC_OUTPUT_RESERVE = 1_200;
const PILOT_CALLS_BEFORE = 27;
const PILOT_CALL_LIMIT = 30;
const MAX_PHASE_PROVIDER_CALLS = 2;
const PROBE_AGENT = "groq-minimal-tpm-probe";
const PROBE_VERSION = "12c2b2g3a-v1";
const PROBE_PROMPT = "Reply x.";
const ARTIFACT_PATH = resolve("artifacts/factual-remediation-hot-path-12c2b2g3a.json");
const PREVIOUS_ACCOUNTING_PATH = resolve("artifacts/factual-remediation-hot-path-12c2b2g3.json");
const PILOT_BASELINE_PATH = resolve("artifacts/complete-real-content-pilot-12c.json");
const PRIOR_MIGRATION_VALIDATION_PATH = resolve("artifacts/checkpoint-manifest-resume-remote-12c2b2f1a.json");
const CONTINUATION_RUNNER_OUTCOME = resolve(`artifacts/critic-continuation-lifecycle-12c2b2g3a-${continuation.continuationPipelineRunId}.json`);
const PROBE_URL = freeProviderPolicy.groq.endpoint;
const GROQ_API_BASE_URL = PROBE_URL.replace(/\/chat\/completions$/, "");
const utcDate = () => new Date().toISOString().slice(0, 10);

type TpmDecision = "IMMEDIATE" | "WAIT_FOR_TOKEN_RESET" | "REQUEST_TOO_LARGE_FOR_TPM" | "BLOCKED_TPM_STATE_UNKNOWN" | "BLOCKED_DAILY_CAPACITY";
type ProbeBody = { model: string; messages: Array<{ role: "user"; content: string }>; max_completion_tokens: 1 };

function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(sort);
    return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(sort(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function diagnoseFreshIncidentSourceLineage(input: {
  eventSourceCount: number | null;
  eventSources: Array<Record<string, unknown>>;
  rawItem: Record<string, unknown> | null;
  source: Record<string, unknown> | null;
}): {
  passed: boolean;
  eventSourceCount: number | null;
  eventSourceIdentityMatches: boolean;
  rawItemMatches: boolean;
  sourceMatches: boolean;
  rawContentLengthCodePoints: number | null;
} {
  const eventSourceIdentityMatches = input.eventSourceCount === 1
    && input.eventSources.length === 1
    && input.eventSources[0]?.event_id === incident.eventId
    && input.eventSources[0]?.raw_item_id === incident.rawItemId
    && input.eventSources[0]?.source_id === incident.sourceId;
  const rawContent = typeof input.rawItem?.raw_content === "string" ? input.rawItem.raw_content : null;
  const rawContentLengthCodePoints = rawContent === null ? null : Array.from(rawContent).length;
  const rawItemMatches = input.rawItem?.id === incident.rawItemId
    && input.rawItem.source_id === incident.sourceId
    && input.rawItem.content_hash === incident.rawContentHash
    && rawContent !== null
    && rawContentLengthCodePoints === incident.rawContentLength
    && input.rawItem.extraction_quality === "full"
    && input.rawItem.processing_status === "extracted";
  const sourceMatches = input.source?.id === incident.sourceId && input.source.name === "TechCrunch AI";
  return {
    passed: eventSourceIdentityMatches && rawItemMatches && sourceMatches,
    eventSourceCount: input.eventSourceCount,
    eventSourceIdentityMatches,
    rawItemMatches,
    sourceMatches,
    rawContentLengthCodePoints,
  };
}

function parseHeaderInteger(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function headerSnapshot(headers: Headers): Record<string, string | null> {
  return {
    date: headers.get("date"),
    "x-ratelimit-limit-requests": headers.get("x-ratelimit-limit-requests"),
    "x-ratelimit-remaining-requests": headers.get("x-ratelimit-remaining-requests"),
    "x-ratelimit-reset-requests": headers.get("x-ratelimit-reset-requests"),
    "x-ratelimit-limit-tokens": headers.get("x-ratelimit-limit-tokens"),
    "x-ratelimit-remaining-tokens": headers.get("x-ratelimit-remaining-tokens"),
    "x-ratelimit-reset-tokens": headers.get("x-ratelimit-reset-tokens"),
    "retry-after": headers.get("retry-after"),
  };
}

export function buildMinimalTpmProbeBody(): ProbeBody {
  return { model: MODEL, messages: [{ role: "user", content: PROBE_PROMPT }], max_completion_tokens: 1 };
}

export function matchesDailyUsageDeltaAfterProbe(input: {
  requestsReservedBefore: number;
  requestsDispatchedBefore: number;
  tokensBefore: number;
  requestsReservedAfter: number;
  requestsDispatchedAfter: number;
  tokensAfter: number;
  probeTokens: number;
  tokenUsageKnown: boolean;
  unknownTokenRequestsBefore: number;
  unknownTokenRequests: number;
}): boolean {
  const counts = [input.requestsReservedBefore, input.requestsDispatchedBefore, input.tokensBefore,
    input.requestsReservedAfter, input.requestsDispatchedAfter, input.tokensAfter, input.probeTokens,
    input.unknownTokenRequestsBefore, input.unknownTokenRequests];
  return counts.every((value) => Number.isSafeInteger(value) && value >= 0)
    && input.requestsReservedAfter === input.requestsReservedBefore + 1
    && input.requestsDispatchedAfter === input.requestsDispatchedBefore + 1
    && input.tokensAfter === input.tokensBefore + input.probeTokens
    && input.tokenUsageKnown && input.unknownTokenRequests === input.unknownTokenRequestsBefore
    && input.unknownTokenRequests === 0;
}

export function validateHistoricalMigration30Evidence(
  prior: Record<string, unknown>,
  localMigrationFiles: string[],
  historicalMigrationFilesPredateEvidence: boolean,
): Record<string, unknown> {
  const required = [
    "20260930211903_factual_remediation_lifecycle.sql",
    "20261002105220_factual_remediation_continuation.sql",
    "20261002150747_factual_remediation_continuation_fix.sql",
    "20261002211000_factual_remediation_continuation_resume.sql",
  ];
  const tests = record(prior.tests);
  const rootCause = record(prior.sqlRootCause);
  const resume = record(prior.validResume);
  const invalidCases = record(prior.invalidCases);
  const oneResume = record(prior.oneResumeRule);
  const concurrency = record(prior.concurrency);
  const security = record(prior.security);
  const residual = record(prior.syntheticResidualRows);
  const residualZero = ["attempts", "events", "articles", "rawItems", "sources", "eventSources", "agentRuns", "agentLogs"]
    .every((key) => residual[key] === 0);
  const requiredFilesPresent = required.every((name) => localMigrationFiles.includes(name));
  const migration30Invariants = {
    sameAttemptResume: resume.sameAttempt === true && resume.newAttempt === false,
    sameAuthorizationReuse: resume.sameAuthorization === true && resume.newAuthorization === false,
    criticOnlyRestart: resume.stage === "critic" && resume.criticDispatched === false && resume.criticReservation === false,
    oneResumeProtection: oneResume.firstResumeAdmitted === true && oneResume.secondResumeRejected === true,
    serviceRoleIsolation: security.service_role === "ALLOWED" && security.anon === "DENIED"
      && security.authenticated === "DENIED" && security.PUBLIC_EXECUTE === "DENIED",
    historicalStopAudit: resume.historicalStopPreserved === true,
    noAttemptSix: resume.attemptSix === false,
  };
  const migration30InvariantsPreserved = Object.values(migration30Invariants).every(Boolean);
  const validationPass = prior.phase === "12C.2B.2f.1a"
    && prior.migration30Applied === true
    && prior.migrationLatest === "20261002211000"
    && prior.migration31Exists === false
    && rootCause.remoteCorrectedMigrationCompiled === true
    && resume.status === "PASS"
    && migration30InvariantsPreserved
    && invalidCases.allRejected === true
    && migration30Invariants.oneResumeProtection
    && concurrency.admitted === 1 && concurrency.rejected === 1
    && migration30Invariants.serviceRoleIsolation
    && residualZero
    && tests.remoteApply === "PASS" && tests.syntheticRemoteValidation === "PASS";
  return {
    status: validationPass && requiredFilesPresent && historicalMigrationFilesPredateEvidence ? "PASS" : "FAIL",
    evidencePhase: prior.phase ?? null,
    remoteMigration30Applied: prior.migration30Applied === true,
    remoteLatestMigration: prior.migrationLatest ?? null,
    migration31AbsentAtValidation: prior.migration31Exists === false,
    remoteMigration30Compiled: rootCause.remoteCorrectedMigrationCompiled === true,
    validResume: resume.status ?? "NOT_PROVEN",
    invalidResumeCasesRejected: invalidCases.count === 31 && invalidCases.allRejected === true,
    oneResumeRule: oneResume.firstResumeAdmitted === true && oneResume.secondResumeRejected === true,
    concurrencyOneAdmittedOneRejected: concurrency.admitted === 1 && concurrency.rejected === 1,
    security: validationPass ? "PASS" : "FAIL",
    migration30InvariantsPreserved,
    migration30Invariants,
    syntheticResidualRowsZero: residualZero,
    localRequiredFilesPresent: requiredFilesPresent,
    laterMigrationsAllowedLocally: true,
    historicalMigrationFilesPredateEvidence,
    localMigrationFiles: localMigrationFiles,
    noRemoteFixtureRerun: true,
  };
}

async function loadHistoricalMigration30Evidence(): Promise<Record<string, unknown>> {
  const prior = await readJson(PRIOR_MIGRATION_VALIDATION_PATH);
  const entries = (await readdir(resolve("supabase/migrations"))).filter((name) => /^\d{14}_.*\.sql$/i.test(name));
  const evidenceStat = await stat(PRIOR_MIGRATION_VALIDATION_PATH);
  const historicalMigrations = [
    "20260930211903_factual_remediation_lifecycle.sql",
    "20261002105220_factual_remediation_continuation.sql",
    "20261002150747_factual_remediation_continuation_fix.sql",
    "20261002211000_factual_remediation_continuation_resume.sql",
  ];
  const migrationStats = await Promise.all(historicalMigrations.map(async (name) => ({ name, modifiedAtMs: (await stat(resolve("supabase/migrations", name))).mtimeMs })));
  const historicalMigrationFilesPredateEvidence = migrationStats.every((entry) => entry.modifiedAtMs <= evidenceStat.mtimeMs);
  const evidence = validateHistoricalMigration30Evidence(prior, entries, historicalMigrationFilesPredateEvidence);
  need(evidence.status === "PASS", "HISTORICAL_MIGRATION30_VALIDATION_EVIDENCE_FAILED");
  return { ...evidence, evidenceArtifact: "artifacts/checkpoint-manifest-resume-remote-12c2b2f1a.json" };
}

export function classifyProbeCapacity(input: {
  httpStatus: number | null;
  returnedModel: string | null;
  responseFresh: boolean;
  responseSchemaValid: boolean;
  usageValid: boolean;
  headers: RateLimitHeaders | null;
  plannedCriticTokens: number;
  configuredTpmLimit: number;
}): { decision: TpmDecision; limitTokens: number | null; remainingTokens: number | null; resetTokens: string | null; resetSeconds: number | null; requiredTokens: number } {
  const requiredTokens = input.plannedCriticTokens + GROQ_TPM_SAFETY_MARGIN;
  const limitTokens = parseHeaderInteger(input.headers?.limitTokens);
  const remainingTokens = parseHeaderInteger(input.headers?.remainingTokens);
  const resetTokens = input.headers?.resetTokens?.trim() || null;
  const resetSeconds = parseDurationSeconds(resetTokens);
  if (requiredTokens > input.configuredTpmLimit) {
    return { decision: "REQUEST_TOO_LARGE_FOR_TPM", limitTokens, remainingTokens, resetTokens, resetSeconds, requiredTokens };
  }
  if (input.httpStatus !== 200 || input.returnedModel !== MODEL || !input.responseFresh || !input.responseSchemaValid || !input.usageValid
    || limitTokens === null || remainingTokens === null || resetTokens === null || resetSeconds === null || resetSeconds < 0
    || limitTokens !== input.configuredTpmLimit || limitTokens !== TPM_LIMIT) {
    return { decision: "BLOCKED_TPM_STATE_UNKNOWN", limitTokens, remainingTokens, resetTokens, resetSeconds, requiredTokens };
  }
  const pacing = decideGroqTpmPacing({
    isFirstStage: false,
    providerHeaders: normalizeGroqProviderRateLimit(input.headers),
    estimatedStageTokenRequirement: input.plannedCriticTokens,
    tokenLimitTpm: input.configuredTpmLimit,
    safetyMarginTokens: GROQ_TPM_SAFETY_MARGIN,
  });
  if (pacing.decision === "IMMEDIATE") return { decision: "IMMEDIATE", limitTokens, remainingTokens, resetTokens, resetSeconds, requiredTokens };
  if (pacing.decision === "WAIT_FOR_TOKEN_RESET") return { decision: "WAIT_FOR_TOKEN_RESET", limitTokens, remainingTokens, resetTokens, resetSeconds, requiredTokens };
  return { decision: pacing.decision === "BLOCKED_SINGLE_STAGE_TPM_SAFETY" ? "REQUEST_TOO_LARGE_FOR_TPM" : "BLOCKED_TPM_STATE_UNKNOWN", limitTokens, remainingTokens, resetTokens, resetSeconds, requiredTokens };
}

function baseArtifact() {
  return {
    phase: "12C.2B.2g.3a",
    recordedAtUtc: new Date().toISOString(),
    status: "PREFLIGHT_ONLY",
    articleId: incident.articleId,
    attemptId: continuation.attemptId,
    continuationId: continuation.continuationPipelineRunId,
    pilotAttempts: { used: 5, limit: 5 },
    pilotCallsBefore: PILOT_CALLS_BEFORE,
    pilotCallLimit: PILOT_CALL_LIMIT,
    maxPhaseProviderCalls: MAX_PHASE_PROVIDER_CALLS,
    liveStateBefore: null as Record<string, unknown> | null,
    manifestCheck: null as Record<string, unknown> | null,
    priorMigration30ValidationEvidence: null as Record<string, unknown> | null,
    cliSqlAuthStatus: "NOT_USED",
    liveIncidentState: null as Record<string, unknown> | null,
    criticV4Estimate: null as Record<string, unknown> | null,
    guardVector: null as Record<string, unknown> | null,
    providerBaseline: null as Record<string, unknown> | null,
    probeAccountingDelta: null as Record<string, unknown> | null,
    pilotCallsAfterProbe: null as number | null,
    pilotCallsFinal: null as number | null,
    probe: {
      dispatched: false,
      httpStatus: null as number | null,
      model: MODEL,
      endpoint: PROBE_URL,
      prompt: PROBE_PROMPT,
      maxCompletionTokens: 1,
      tools: false,
      structuredOutput: false,
      usage: null as Record<string, number> | null,
      headers: null as Record<string, string | null> | null,
      requestDate: null as string | null,
      responseDate: null as string | null,
      responseFresh: false,
      settlement: null as Record<string, unknown> | null,
      completionContentRecorded: false,
      error: null as string | null,
    },
    capacityDecision: null as Record<string, unknown> | null,
    resumeResult: "NOT_RUN",
    resumeResultDetail: "NOT_RUN",
    resumeRpcResult: "NOT_RUN",
    resumeRpcInvocations: 0,
    resumeRpcCalls: 0,
    sameAuthorization: "NOT_RUN",
    newAuthorization: false,
    resumeExecutionId: null as string | null,
    criticReservation: "NOT_RUN",
    criticDispatch: "NOT_RUN",
    criticUsage: null as Record<string, unknown> | null,
    criticUsageSettled: "NOT_RUN",
    criticResult: "NOT_RUN",
    criticDecision: "NOT_RUN",
    publisherReadiness: "NOT_RUN",
    publisherResult: "NOT_RUN",
    publisherAccountingGuard: "NOT_RUN",
    publicCountBefore: null as number | null,
    publicCountAfter: null as number | null,
    claimSupportReview: null as Record<string, unknown> | null,
    publication: null as Record<string, unknown> | null,
    postRunAudit: null as Record<string, unknown> | null,
    otherArticleIntegrity: null as Record<string, unknown> | null,
    auditHistory: null as Record<string, unknown> | null,
    capacityFinal: null as Record<string, unknown> | null,
    tests: null as Record<string, unknown> | null,
    finalDecision: "NOT_RUN",
    stopReason: null as string | null,
    cloudflareCalls: 0,
    cerebrasCalls: 0,
    retries: 0,
    fallbackCalls: 0,
    secretsPersisted: false,
  };
}

async function writeArtifact(artifact: ReturnType<typeof baseArtifact>): Promise<void> {
  await mkdir(resolve("artifacts"), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify({ ...artifact, recordedAtUtc: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  need(parsed && typeof parsed === "object" && !Array.isArray(parsed), "PHASE_ARTIFACT_INVALID");
  return parsed as Record<string, unknown>;
}

function assertProbeConfiguration(): { limits: GroqCapacityLimits; apiKey: string; requestLimit: number; tokenLimit: number; softRatio: number } {
  need(process.env.AGENT_PROVIDER?.trim().toLowerCase() === "groq", "BLOCKED_GROQ_ONLY_CONFIGURATION");
  need(process.env.AGENT_MODEL_CRITIC?.trim() === MODEL, "BLOCKED_CRITIC_MODEL_CONFIGURATION");
  need((process.env.AGENT_API_URL ?? "").trim().replace(/\/$/, "") === GROQ_API_BASE_URL, "BLOCKED_GROQ_ENDPOINT_CONFIGURATION");
  need(process.env.AGENT_API_KEY?.trim(), "BLOCKED_GROQ_CREDENTIAL_MISSING");
  need(!freeProviderRouterEnabled(), "BLOCKED_PROVIDER_ROUTER_ENABLED");
  const paidFallback = process.env.AGENT_ALLOW_PAID_FALLBACK?.trim().toLowerCase();
  need(paidFallback !== "true", "BLOCKED_PAID_FALLBACK_ENABLED");
  assertFreeProviderRequest("groq", MODEL, PROBE_URL);
  const capacity = readProviderCapacityConfig("groq");
  const limits = readGroqAtomicCapacityLimits();
  need(capacity.configured && capacity.endpoint === PROBE_URL && capacity.model === process.env.AGENT_MODEL_VERIFY?.trim(), "BLOCKED_GROQ_CAPACITY_CONFIGURATION");
  need(limits && limits.tokenMinuteHardLimit === TPM_LIMIT, "BLOCKED_TPM_POLICY_LIMIT_MISMATCH");
  const requestLimit = resolveGroqDailyRequestHardCap().limit;
  const tokenLimit = readGroqDailyTokenHardLimit();
  need(tokenLimit !== null && tokenLimit === limits.tokenHardLimit, "BLOCKED_TPD_POLICY_LIMIT_UNKNOWN");
  return { limits, apiKey: process.env.AGENT_API_KEY!.trim(), requestLimit, tokenLimit, softRatio: DAILY_SOFT_LIMIT_RATIO };
}

export async function readFreshLiveState(supabase: ReturnType<typeof createSupabaseServerClient>): Promise<{
  attempts: Array<Record<string, unknown>>;
  current: Record<string, unknown>;
  prior: Record<string, unknown>;
  continuationState: Record<string, unknown>;
  article: Record<string, unknown>;
  event: Record<string, unknown>;
  sourceLineage: ReturnType<typeof diagnoseFreshIncidentSourceLineage>;
  publicRows: Array<Record<string, unknown>>;
  publicHashes: Array<{ slug: string | null; sha256: string }>;
  pilotCurrentRuns: Array<Record<string, unknown>>;
  priorAuthReference: string;
}> {
  const [attemptsR, eventR, articleR, eventSourcesR, rawItemR, sourceR, publicR, activityR] = await Promise.all([
    supabase.from("pipeline_event_attempts").select("id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,purpose,pilot_attempt_number,continuation").eq("event_key", incident.eventKey),
    supabase.from("events").select("id,event_key,event_status,review_status").eq("id", incident.eventId).maybeSingle(),
    supabase.from("articles").select("id,event_id,slug,publication_status,updated_at").eq("id", incident.articleId).maybeSingle(),
    supabase.from("event_sources").select("event_id,raw_item_id,source_id", { count: "exact" }).eq("event_id", incident.eventId),
    supabase.from("raw_items").select("id,source_id,content_hash,raw_content,extraction_quality,processing_status").eq("id", incident.rawItemId).maybeSingle(),
    supabase.from("sources").select("id,name").eq("id", incident.sourceId).maybeSingle(),
    supabase.from("public_published_articles").select("*"),
    supabase.from("agent_runs").select("id,config,stats,status,provider,started_at,finished_at").eq("config->>eventKey", incident.eventKey).eq("config->>attemptId", continuation.attemptId),
  ]);
  const readFailures = [
    ["attempts", attemptsR.error], ["event", eventR.error], ["article", articleR.error],
    ["eventSources", eventSourcesR.error], ["rawItem", rawItemR.error], ["source", sourceR.error],
    ["public", publicR.error], ["activity", activityR.error],
  ].flatMap(([name, error]) => {
    if (!error) return [];
    const details = record(error);
    const code = typeof details.code === "string" ? details.code : "NO_CODE";
    const message = typeof details.message === "string" ? details.message.replace(/\s+/g, " ").slice(0, 100) : "";
    return [`${name}:${code}${message ? `:${message}` : ""}`];
  });
  if (readFailures.length) throw new Error(`FRESH_REMOTE_STATE_READ_FAILED:${readFailures.join(",")}`);
  const attempts = (attemptsR.data ?? []) as unknown as Array<Record<string, unknown>>;
  const current = attempts.find((row) => row.id === continuation.attemptId);
  const prior = attempts.find((row) => row.pipeline_run_id === incident.priorPipelineRunId);
  const currentContinuation = record(current?.continuation);
  const article = record(articleR.data);
  const event = record(eventR.data);
  const sourceLineage = diagnoseFreshIncidentSourceLineage({
    eventSourceCount: eventSourcesR.count,
    eventSources: (eventSourcesR.data ?? []) as unknown as Array<Record<string, unknown>>,
    rawItem: rawItemR.data as unknown as Record<string, unknown> | null,
    source: sourceR.data as unknown as Record<string, unknown> | null,
  });
  const publicRows = (publicR.data ?? []) as unknown as Array<Record<string, unknown>>;
  const activityRuns = (activityR.data ?? []) as unknown as Array<Record<string, unknown>>;
  const pilotCurrentRuns = activityRuns.filter((row) => {
    const config = record(row.config);
    return config.agentName === "critic" && config.agentVersion === "critic-v4";
  });
  const publicHashes = publicRows.map((row) => ({
    slug: typeof row.slug === "string" ? row.slug : null,
    sha256: sha256(stableJson(row)),
  })).sort((left, right) => String(left.slug).localeCompare(String(right.slug)));

  need(attempts.length === 2 && current && prior, "FRESH_ATTEMPT_HISTORY_CHANGED");
  need(current.id === continuation.attemptId && current.pipeline_run_id === continuation.originalPipelineRunId
    && current.attempt_number === 2 && current.pilot_attempt_number === 5
    && current.purpose === "FACTUAL_REMEDIATION" && current.final_state === "TECHNICAL_FAILURE"
    && current.stop_stage === "critic" && current.stop_reason === "cost_guard_violation" && Boolean(current.completed_at), "FRESH_ATTEMPT_IDENTITY_OR_TERMINAL_STATE_CHANGED");
  need(prior.attempt_number === 1 && prior.purpose === "NORMAL" && prior.final_state === "READY_FOR_PUBLICATION" && Boolean(prior.completed_at), "FRESH_PRIOR_ATTEMPT_CHANGED");
  need(currentContinuation.kind === "FACTUAL_REMEDIATION_CONTINUATION"
    && currentContinuation.attemptId === continuation.attemptId
    && currentContinuation.pipelineRunId === continuation.continuationPipelineRunId
    && currentContinuation.resumeStage === "critic"
    && currentContinuation.status === "STOPPED"
    && currentContinuation.stopStage === "critic"
    && currentContinuation.stopReason === "CONTINUATION_RUNNER_ABORTED"
    && currentContinuation.authorizedBy === "Diego"
    && typeof currentContinuation.authorizationReference === "string"
    && currentContinuation.authorizationReference.length > 0
    && typeof currentContinuation.authorizedAt === "string"
    && currentContinuation.resumeGeneration === undefined
    && currentContinuation.resumeExecutionId === undefined
    && (!Array.isArray(currentContinuation.resumeHistory) || currentContinuation.resumeHistory.length === 0), "FRESH_EXISTING_AUTHORIZATION_OR_RESUME_STATE_CHANGED");
  need(event.id === incident.eventId && event.event_key === incident.eventKey && event.event_status === "active" && event.review_status === "approved", "FRESH_EVENT_IDENTITY_CHANGED");
  need(article.id === incident.articleId && article.event_id === incident.eventId && article.slug === incident.articleSlug && article.publication_status === "archived", "FRESH_ARTICLE_IDENTITY_OR_ARCHIVE_STATE_CHANGED");
  need(!publicRows.some((row) => row.slug === incident.articleSlug), "FRESH_INCIDENT_ALREADY_PUBLIC");
  need(sourceLineage.passed, "FRESH_SOURCE_RAW_LINEAGE_CHANGED");
  need(pilotCurrentRuns.length === 0, "FRESH_CRITIC_V4_RUN_ALREADY_EXISTS");
  await access(resolve("artifacts/pipeline-checkpoints", continuation.continuationPipelineRunId, `critic-${incident.eventKey}.json`)).then(
    () => { throw new Error("FRESH_CONTINUATION_CRITIC_CHECKPOINT_EXISTS"); },
    (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
  );
  await access(CONTINUATION_RUNNER_OUTCOME).then(
    () => { throw new Error("FRESH_CONTINUATION_OUTCOME_ALREADY_EXISTS"); },
    (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
  );
  return {
    attempts,
    current,
    prior,
    continuationState: currentContinuation,
    article,
    event,
    sourceLineage,
    publicRows,
    publicHashes,
    pilotCurrentRuns,
    priorAuthReference: currentContinuation.authorizationReference as string,
  };
}

async function readActivityForAttempt(supabase: ReturnType<typeof createSupabaseServerClient>): Promise<{ criticV4Rows: number; criticReservations: number; criticDispatched: boolean }> {
  const runsR = await supabase.from("agent_runs").select("id,config,stats,provider")
    .eq("config->>eventKey", incident.eventKey).eq("config->>attemptId", continuation.attemptId);
  if (runsR.error) throw new Error("CRITIC_ACTIVITY_READ_FAILED");
  const criticRuns = (runsR.data ?? []).filter((run) => record(run.config).agentName === "critic" && record(run.config).agentVersion === "critic-v4");
  const runIds = criticRuns.map((run) => run.id);
  const logsR = runIds.length ? await supabase.from("agent_logs").select("step,payload").in("run_id", runIds) : { data: [], error: null };
  if (logsR.error) throw new Error("CRITIC_RESERVATION_READ_FAILED");
  const reservations = (logsR.data ?? []).filter((row) => row.step === "provider_request_reserved");
  const dispatched = criticRuns.some((run) => record(record(run.stats).telemetry).providerRequestDispatched === true || record(record(run.stats).telemetry).providerRequestsUsed === 1)
    || (logsR.data ?? []).some((row) => record(row.payload).providerRequestDispatched === true || record(record(row.payload).details).providerRequestDispatched === true);
  return { criticV4Rows: criticRuns.length, criticReservations: reservations.length, criticDispatched: dispatched };
}

async function verifyPilotCallBaseline(supabase: ReturnType<typeof createSupabaseServerClient>): Promise<{ callsBefore: number; limit: number; auditAtUtc: string; newerGroqRuns: number }> {
  const previous = await readJson(PREVIOUS_ACCOUNTING_PATH);
  const pilot = await readJson(PILOT_BASELINE_PATH);
  const previousAccounting = record(previous.accounting ?? previous);
  const pilotEvents = Array.isArray(pilot.perEventResults) ? pilot.perEventResults.map((value) => record(value).eventKey).filter((value): value is string => typeof value === "string") : [];
  const previousCriticCalls = typeof previousAccounting.criticCallsThisPhase === "number"
    ? previousAccounting.criticCallsThisPhase
    : previousAccounting.criticDispatch === "NO" && previousAccounting.criticResult === "NOT_RUN" ? 0 : null;
  need(previousAccounting.pilotCallsFinal === PILOT_CALLS_BEFORE
    && previousAccounting.pilotCallLimit === PILOT_CALL_LIMIT
    && previousCriticCalls === 0
    && pilot.totalPilotGroqCalls === 19
    && pilot.pilotCallLimit === PILOT_CALL_LIMIT
    && pilotEvents.length > 0, "PILOT_CALL_ACCOUNTING_BASELINE_INVALID");
  const auditAtUtc = typeof previous.recordedAtUtc === "string" ? previous.recordedAtUtc : "";
  need(Number.isFinite(Date.parse(auditAtUtc)), "PILOT_CALL_AUDIT_TIMESTAMP_INVALID");
  const newerRuns = await Promise.all(pilotEvents.map(async (eventKey) => {
    const result = await supabase.from("agent_runs").select("id,provider,stats,started_at")
      .eq("provider", "groq").eq("config->>eventKey", eventKey).gt("started_at", auditAtUtc);
    if (result.error) throw new Error("PILOT_CALL_LEDGER_READ_FAILED");
    return result.data ?? [];
  }));
  const newerGroqRuns = newerRuns.flat().length;
  need(newerGroqRuns === 0, "PILOT_CALL_COUNT_CHANGED_SINCE_LAST_AUDIT");
  return { callsBefore: PILOT_CALLS_BEFORE, limit: PILOT_CALL_LIMIT, auditAtUtc, newerGroqRuns };
}

async function readLatestEventTpm(supabase: ReturnType<typeof createSupabaseServerClient>): Promise<Record<string, unknown> | null> {
  const result = await supabase.from("agent_runs").select("id,finished_at,stats,config")
    .eq("provider", "groq").contains("config", { eventKey: incident.eventKey })
    .not("finished_at", "is", null).order("finished_at", { ascending: false }).limit(1);
  if (result.error) throw new Error("LATEST_EVENT_TPM_HEADER_READ_FAILED");
  const row = result.data?.[0];
  if (!row) return null;
  const telemetry = record(record(row.stats).telemetry);
  const headers = record(telemetry.rateLimitHeaders);
  const received = Date.parse(String(row.finished_at ?? ""));
  return {
    runId: row.id,
    finishedAt: row.finished_at,
    model: telemetry.model ?? null,
    providerHttpStatus: telemetry.providerHttpStatus ?? null,
    limitTokens: headers.limitTokens ?? headers.limitTokensMinute ?? null,
    remainingTokens: headers.remainingTokens ?? headers.remainingTokensMinute ?? null,
    resetTokens: headers.resetTokens ?? headers.resetTokensMinute ?? null,
    freshWithin60Seconds: Number.isFinite(received) && Date.now() - received <= 60_000,
  };
}

export function factualGuardSnapshot(bundle: Awaited<ReturnType<typeof loadFactualRemediationContinuationCheckpoints>>) {
  const input = bundle.criticInput;
  const source = input.sources[0];
  const evidence = input.sourceEvidence[0];
  const projection = buildCriticModelInput(input);
  const verification = input.verification;
  const excerpt = evidence?.contentExcerpt ?? "";
  const coverage = {
    techCrunchIdentity: source?.sourceName === "TechCrunch AI" && source.sourceId === incident.sourceId,
    wallStreetJournalAttribution: excerpt.includes("The Wall Street Journal reports") && excerpt.includes("the Journal writes"),
    techCrunchOutreach: excerpt.includes("TechCrunch reached out to OpenAI"),
    singleSourceUncertainty: input.sources.length === 1 && verification.status === "single_source" && verification.uncertainClaims.length > 0,
    verifiedFactualEnvelope: verification.verifiedFacts.length === 2,
    editorDraftIncluded: !!input.editorial.headlineEs && !!input.editorial.summaryEs && !!input.editorial.bodyEs && !!input.editorial.whyItMattersEs,
    unsupportedDetailComparisonSurface: projection.input.editorial.bodyEs.length > 0 && projection.input.sourceEvidence.length === 1,
    geoIncluded: Number.isFinite(projection.input.geo.latitude) && Number.isFinite(projection.input.geo.longitude)
      && projection.input.geo.resolutionLevel !== "unresolved",
    sourceEvidenceIdentity: evidence?.sourceId === incident.sourceId && evidence.contentHash === incident.rawContentHash
      && evidence.sourceItemId === source?.sourceItemId,
  };
  const registry = createReferenceRegistry(
    [{ code: "US", name: "United States", latitude: 39.8283, longitude: -98.5795 }],
    input.classification.categorySlugs.map((slug) => ({ slug, name: slug })),
  );
  const prechecks = runCriticPrechecks(input, { registry });
  need(prechecks.passed && prechecks.issues.length === 0, "FACTUAL_REMEDIATION_GUARDS_FAILED");
  need(Object.values(coverage).every(Boolean), "CRITIC_EVIDENCE_COVERAGE_FAILED");
  return {
    attributionPreservation: "PASS",
    uncertaintyPreservation: "PASS",
    unsupportedDetailGuard: "PASS",
    sourceEvidenceIdentity: "PASS",
    sourceEvidenceCoverage: "PASS",
    geo: "PASS",
    criticEvidenceProjection: "PASS",
    criticInputSchema: "PASS",
    evidenceCatalogCount: projection.evidenceCatalog.length,
    precheckIssueCodes: prechecks.issues.map((issue) => issue.code),
    coverage,
  };
}

async function currentDailyCapacity(input: {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  logger: SupabaseAgentLogger;
  limits: GroqCapacityLimits;
  criticTokens: number;
  probeTokens: number;
  requestsToAdmit: 1 | 2;
}): Promise<Record<string, unknown>> {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const dailyLimit = readGroqDailyTokenHardLimit();
  need(dailyLimit !== null, "GROQ_DAILY_TOKEN_HARD_LIMIT_UNKNOWN");
  const [usage, block, latestEventTpm] = await Promise.all([
    input.logger.getProviderDailyUsage("groq", date),
    input.logger.getProviderRateLimitState("groq"),
    readLatestEventTpm(input.supabase),
  ]);
  const projectedTokens = input.requestsToAdmit === 2 ? input.criticTokens + input.probeTokens : input.criticTokens;
  const decision = evaluateGroqNewEventAdmission({
    currentRequests: usage.requestsReserved,
    currentTokens: usage.totalTokens,
    tokenUsageKnown: usage.tokenUsageKnown,
    requestHardLimit: input.limits.requestHardLimit,
    tokenHardLimit: input.limits.tokenHardLimit,
    softRatio: DAILY_SOFT_LIMIT_RATIO,
    eventRequests: input.requestsToAdmit,
    eventTokens: projectedTokens,
  });
  const activeBlock = !!block?.blockedUntil && Date.parse(block.blockedUntil) > now.getTime();
  const result = {
    checkedAtUtc: now.toISOString(),
    utcDay: date,
    requestsUsed: usage.requestsReserved,
    requestsDispatched: usage.requestsDispatched,
    requestsRemainingHard: Math.max(0, input.limits.requestHardLimit - usage.requestsReserved),
    dailyRequestHardLimit: input.limits.requestHardLimit,
    dailyRequestSoftLimit: input.limits.requestSoftLimit,
    tokensUsed: usage.totalTokens,
    tokensUsageKnown: usage.tokenUsageKnown,
    unknownTokenReservations: usage.unknownTokenRequests,
    dailyTokenHardLimit: input.limits.tokenHardLimit,
    dailyTokenSoftLimit: input.limits.tokenSoftLimit,
    projectedRequests: decision.projectedRequests,
    projectedTokens: decision.projectedTokens,
    requestedNewRequests: input.requestsToAdmit,
    requestedTokens: projectedTokens,
    admission: decision.reason,
    eligible: decision.eligible && usage.unknownTokenRequests === 0 && !activeBlock,
    temporaryProviderBlock: block?.blockedUntil ?? null,
    activeProviderBlock: activeBlock,
    latestEventTpm,
  };
  need(result.eligible, "BLOCKED_DAILY_CAPACITY");
  return result;
}

async function buildPreflight(): Promise<{
  artifact: ReturnType<typeof baseArtifact>;
  supabase: ReturnType<typeof createSupabaseServerClient>;
  logger: SupabaseAgentLogger;
  bundle: Awaited<ReturnType<typeof loadFactualRemediationContinuationCheckpoints>>;
  limits: GroqCapacityLimits;
  apiKey: string;
  requestLimit: number;
  tokenLimit: number;
  softRatio: number;
  probeEstimate: number;
  criticEstimate: ReturnType<typeof estimateCriticV4Request>;
  baseline: { callsBefore: number; limit: number; auditAtUtc: string; newerGroqRuns: number };
  freshState: Awaited<ReturnType<typeof readFreshLiveState>>;
}> {
  const artifact = baseArtifact();
  artifact.priorMigration30ValidationEvidence = await loadHistoricalMigration30Evidence();
  const supabase = createSupabaseServerClient();
  const logger = new SupabaseAgentLogger(supabase);

  // Required ordering: read the incident first, then rebuild Critic V4 from immutable checkpoints.
  const freshState = await readFreshLiveState(supabase);
  artifact.liveStateBefore = {
    readAtUtc: new Date().toISOString(),
    article: { id: freshState.article.id, slug: freshState.article.slug, publicationStatus: freshState.article.publication_status },
    event: { id: freshState.event.id, status: freshState.event.event_status, reviewStatus: freshState.event.review_status },
    sourceLineage: freshState.sourceLineage,
    incidentPublic: false,
    publicCount: freshState.publicRows.length,
    publicArticleHashes: freshState.publicHashes,
    attemptCount: freshState.attempts.length,
    attempt: { id: freshState.current.id, attemptNumber: freshState.current.attempt_number, purpose: freshState.current.purpose, pilotAttempt: freshState.current.pilot_attempt_number, finalState: freshState.current.final_state, stopReason: freshState.current.stop_reason },
    authorization: { continuationId: freshState.continuationState.pipelineRunId, status: freshState.continuationState.status, authorizedBy: freshState.continuationState.authorizedBy, authorizationReference: freshState.priorAuthReference, authorizedAt: freshState.continuationState.authorizedAt, count: 1, resumeConsumed: false, resumeGeneration: null, resumeExecutionId: null },
    historicalStop: { costGuardViolation: freshState.current.stop_reason === "cost_guard_violation", continuationRunnerAborted: freshState.continuationState.stopReason === "CONTINUATION_RUNNER_ABORTED", priorStoppedState: freshState.continuationState.status === "STOPPED" },
    criticActivity: await readActivityForAttempt(supabase),
    noNewerAttempt: Math.max(...freshState.attempts.map((row) => Number(row.attempt_number))) === 2,
  };
  artifact.liveIncidentState = artifact.liveStateBefore;
  artifact.guardVector = {
    observedAtUtc: new Date().toISOString(),
    event_ok: freshState.event.id === incident.eventId && freshState.event.event_key === incident.eventKey
      && freshState.event.event_status === "active" && freshState.event.review_status === "approved",
    article_archived_ok: freshState.article.id === incident.articleId && freshState.article.event_id === incident.eventId
      && freshState.article.slug === incident.articleSlug && freshState.article.publication_status === "archived",
    incident_public: freshState.publicRows.some((row) => row.slug === incident.articleSlug),
    event_source_count: freshState.sourceLineage.eventSourceCount,
    source_raw_lineage_match: freshState.sourceLineage.passed,
    overall: "PASS",
  };
  artifact.publicCountBefore = freshState.publicRows.length;

  const bundle = await loadFactualRemediationContinuationCheckpoints();
  const remoteManifest = continuationCheckpointManifestSchema.parse(freshState.continuationState.checkpointManifest);
  const localManifest = continuationCheckpointManifestSchema.parse(bundle.manifest);
  const localCanonicalHash = sha256(canonicalJsonString(localManifest));
  const remoteCanonicalHash = sha256(canonicalJsonString(remoteManifest));
  need(continuationCheckpointManifestsEqual(localManifest, remoteManifest)
    && localCanonicalHash === remoteCanonicalHash
    && Object.keys(localManifest.checkpoints).length === 5, "CHECKPOINT_MANIFEST_SEMANTIC_MISMATCH");
  const factualGuards = factualGuardSnapshot(bundle);
  const criticEstimate = estimateCriticV4Request(bundle.criticInput, CRITIC_OUTPUT_RESERVE);
  need(criticEstimate.estimatedStageTokenRequirement < TPM_LIMIT
    && criticEstimate.estimatedStageTokenRequirement + GROQ_TPM_SAFETY_MARGIN <= TPM_LIMIT, "CRITIC_V4_TPM_SAFETY_GATE_FAILED");
  artifact.manifestCheck = {
    strictSchema: "PASS",
    semanticEquality: "PASS",
    canonicalHashMatch: "PASS",
    localCanonicalSha256: localCanonicalHash,
    remoteCanonicalSha256: remoteCanonicalHash,
    checkpointCount: Object.keys(localManifest.checkpoints).length,
    rootContract: "PASS",
    checkpoints: bundle.checkpointHashes,
    criticCheckpointAbsent: bundle.criticCheckpointAbsent,
  };
  artifact.criticV4Estimate = {
    systemInstructionChars: criticEstimate.systemInstructionChars,
    modelInputChars: criticEstimate.modelInputChars,
    schemaChars: criticEstimate.schemaChars,
    inputTokens: criticEstimate.estimatedInputTokens,
    outputReserve: criticEstimate.maxOutputTokens,
    totalPlannedTokens: criticEstimate.estimatedStageTokenRequirement,
    hardTpmLimit: TPM_LIMIT,
    safetyMargin: GROQ_TPM_SAFETY_MARGIN,
    safetyAdjustedHeadroom: TPM_LIMIT - criticEstimate.estimatedStageTokenRequirement - GROQ_TPM_SAFETY_MARGIN,
    canonicalSafetyPolicy: "PASS",
    factualGuards,
  };

  const config = assertProbeConfiguration();
  const probeBody = buildMinimalTpmProbeBody();
  const requestBytes = Buffer.byteLength(JSON.stringify(probeBody), "utf8");
  const probeEstimate = estimateGroqStageTokenRequirement({
    systemInstructionChars: 0,
    modelInputChars: requestBytes,
    schemaChars: 0,
    maxOutputTokens: probeBody.max_completion_tokens,
  }).estimatedStageTokenRequirement;
  const baseline = await verifyPilotCallBaseline(supabase);
  const daily = await currentDailyCapacity({ supabase, logger, limits: config.limits, criticTokens: criticEstimate.estimatedStageTokenRequirement, probeTokens: probeEstimate, requestsToAdmit: 2 });
  const newestState = await readFreshLiveState(supabase);
  need(newestState.current.id === freshState.current.id
    && newestState.continuationState.status === freshState.continuationState.status
    && newestState.priorAuthReference === freshState.priorAuthReference
    && stableJson(newestState.publicHashes) === stableJson(freshState.publicHashes), "PRE_PROBE_REAL_STATE_CHANGED");

  artifact.liveStateBefore.preProbeRecheckAtUtc = new Date().toISOString();
  artifact.liveStateBefore.preProbeRecheck = "PASS";
  artifact.criticV4Estimate.dailyCapacity = daily;
  artifact.criticV4Estimate.dailyCapacityGate = "PASS";
  artifact.providerBaseline = {
    capturedAtUtc: daily.checkedAtUtc,
    utcDay: daily.utcDay,
    requestsReserved: daily.requestsUsed,
    requestsDispatched: daily.requestsDispatched,
    tokens: daily.tokensUsed,
    tokenUsageKnown: daily.tokensUsageKnown,
    unknownDispatchedReservations: daily.unknownTokenReservations,
    temporaryProviderBlock: daily.temporaryProviderBlock,
    rpd: { hardLimit: daily.dailyRequestHardLimit, softLimit: daily.dailyRequestSoftLimit, used: daily.requestsUsed, projected: daily.projectedRequests, admission: daily.admission },
    tpd: { hardLimit: daily.dailyTokenHardLimit, softLimit: daily.dailyTokenSoftLimit, used: daily.tokensUsed, projected: daily.projectedTokens, admission: daily.admission },
  };
  artifact.pilotCallsBefore = baseline.callsBefore;
  return { artifact, supabase, logger, bundle, ...config, probeEstimate, criticEstimate, baseline, freshState };
}

async function executeMinimalProbe(input: {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  logger: SupabaseAgentLogger;
  limits: GroqCapacityLimits;
  apiKey: string;
  requestLimit: number;
  probeEstimate: number;
}): Promise<{
  runId: string | null;
  reservationId: number | null;
  dispatched: boolean;
  httpStatus: number | null;
  returnedModel: string | null;
  responseFresh: boolean;
  responseSchemaValid: boolean;
  usageValid: boolean;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  requestDate: string;
  requestAtUtc: string;
  responseDate: string | null;
  responseAtUtc: string | null;
  headers: Record<string, string | null> | null;
  normalizedHeaders: RateLimitHeaders | null;
  settlement: GroqTokenSettlementResult | null;
  accountingPersisted: boolean;
  error: string | null;
}> {
  const requestDate = utcDate();
  const requestAtUtc = new Date().toISOString();
  const metadata: AgentRunMetadata = {
    agentName: PROBE_AGENT,
    agentVersion: PROBE_VERSION,
    eventKey: incident.eventKey,
    model: MODEL,
    provider: "groq",
    dryRun: false,
  };
  const runId = await input.logger.startRun(metadata, requestAtUtc);
  need(runId, "TPM_PROBE_RUN_CREATE_FAILED");
  let reservationId: number | null = null;
  let dispatched = false;
  let httpStatus: number | null = null;
  let returnedModel: string | null = null;
  let responseFresh = false;
  let responseSchemaValid = false;
  let usageValid = false;
  let usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = null;
  let responseDate: string | null = null;
  let responseAtUtc: string | null = null;
  let headersSnapshot: Record<string, string | null> | null = null;
  let normalizedHeaders: RateLimitHeaders | null = null;
  let settlement: GroqTokenSettlementResult | null = null;
  let accountingPersisted = false;
  let errorCode: string | null = null;
  let responseBytes: number | null = null;
  let finishReason: string | null = null;
  let status: "SUCCESS" | "PROVIDER_HTTP_ERROR" | "FREE_TIER_LIMIT_REACHED" | "TIMEOUT" | "RUNTIME_ERROR" | "LOCAL_JSON_PARSE_ERROR" | "LOCAL_SCHEMA_VALIDATION_ERROR" = "RUNTIME_ERROR";
  let errorCategory: "RATE_LIMIT" | "AUTH_ERROR" | "BAD_REQUEST" | "SERVER_ERROR" | "TIMEOUT" | "NETWORK_ERROR" | "INVALID_RESPONSE" | null = "NETWORK_ERROR";
  const reservation = await input.logger.reserveGroqCapacity(runId, metadata, 1, requestDate, input.limits, input.probeEstimate);
  if (!reservation.allowed || !reservation.admitted || reservation.reservationId === undefined) {
    await input.logger.finishRun(runId, metadata, "failed", new Date().toISOString(), {} as Json, reservation.reason ?? "PROBE_DAILY_CAPACITY_BLOCKED");
    return { runId, reservationId: null, dispatched: false, httpStatus, returnedModel, responseFresh, responseSchemaValid, usageValid, usage, requestDate, requestAtUtc, responseDate, responseAtUtc, headers: headersSnapshot, normalizedHeaders, settlement, accountingPersisted: true, error: reservation.reason ?? "PROBE_DAILY_CAPACITY_BLOCKED" };
  }
  reservationId = reservation.reservationId;
  const marked = await input.logger.markRequestDispatched(runId, reservationId, requestDate);
  if (!marked) {
    await input.logger.releaseGroqCapacityPreDispatch(runId, reservationId, requestDate);
    await input.logger.finishRun(runId, metadata, "failed", new Date().toISOString(), {} as Json, "TPM_PROBE_DISPATCH_MARKER_FAILED");
    return { runId, reservationId, dispatched: false, httpStatus, returnedModel, responseFresh, responseSchemaValid, usageValid, usage, requestDate, requestAtUtc, responseDate, responseAtUtc, headers: headersSnapshot, normalizedHeaders, settlement, accountingPersisted: true, error: "TPM_PROBE_DISPATCH_MARKER_FAILED" };
  }

  // This is the sole provider fetch in the probe path. The canonical marker is already committed.
  dispatched = true;
  let responseBodyText = "";
  try {
    const response = await fetch(PROBE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify(buildMinimalTpmProbeBody()),
      signal: AbortSignal.timeout(20_000),
    });
    httpStatus = response.status;
    responseAtUtc = new Date().toISOString();
    headersSnapshot = headerSnapshot(response.headers);
    normalizedHeaders = readRateLimitHeaders(response.headers);
    responseDate = headersSnapshot.date;
    const parsedDate = responseDate ? Date.parse(responseDate) : Number.NaN;
    responseFresh = Number.isFinite(parsedDate) && Math.abs(Date.parse(responseAtUtc) - parsedDate) <= 120_000;
    if (!response.ok) {
      status = response.status === 429 ? "FREE_TIER_LIMIT_REACHED" : "PROVIDER_HTTP_ERROR";
      errorCategory = response.status === 429 ? "RATE_LIMIT" : response.status === 401 || response.status === 403 ? "AUTH_ERROR" : response.status >= 500 ? "SERVER_ERROR" : "BAD_REQUEST";
      errorCode = `PROBE_HTTP_${response.status}`;
    } else {
      responseBodyText = await response.text();
      responseBytes = Buffer.byteLength(responseBodyText, "utf8");
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = record(JSON.parse(responseBodyText));
      } catch {
        status = "LOCAL_JSON_PARSE_ERROR";
        errorCategory = "INVALID_RESPONSE";
        errorCode = "PROBE_RESPONSE_JSON_INVALID";
      }
      if (parsed) {
        returnedModel = typeof parsed.model === "string" ? parsed.model : null;
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const choice = record(choices[0]);
        const message = record(choice.message);
        finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
        responseSchemaValid = parsed.object === "chat.completion" && choices.length === 1
          && typeof message === "object" && finishReason !== null && returnedModel === MODEL;
        const rawUsage = record(parsed.usage);
        const inputTokens = rawUsage.prompt_tokens;
        const outputTokens = rawUsage.completion_tokens;
        const totalTokens = rawUsage.total_tokens;
        usageValid = Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens) && Number.isSafeInteger(totalTokens)
          && typeof inputTokens === "number" && inputTokens >= 0
          && typeof outputTokens === "number" && outputTokens >= 0
          && typeof totalTokens === "number" && totalTokens > 0
          && inputTokens + outputTokens === totalTokens;
        if (usageValid) usage = { inputTokens: inputTokens as number, outputTokens: outputTokens as number, totalTokens: totalTokens as number };
        if (responseSchemaValid && usageValid) {
          status = "SUCCESS";
          errorCategory = null;
        } else {
          status = "LOCAL_SCHEMA_VALIDATION_ERROR";
          errorCategory = "INVALID_RESPONSE";
          errorCode = !responseSchemaValid ? "PROBE_RESPONSE_SCHEMA_INVALID" : "PROBE_USAGE_INVALID";
        }
      }
    }
  } catch (error) {
    responseAtUtc = new Date().toISOString();
    const name = error instanceof Error ? error.name : "";
    status = name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "RUNTIME_ERROR";
    errorCategory = status === "TIMEOUT" ? "TIMEOUT" : "NETWORK_ERROR";
    errorCode = status === "TIMEOUT" ? "PROBE_TIMEOUT" : "PROBE_NETWORK_FAILURE";
  }

  if (usageValid && usage && reservationId !== null) {
    try {
      settlement = await input.logger.settleGroqTokenUsage(runId, reservationId, requestDate, usage.inputTokens, usage.outputTokens);
    } catch {
      errorCode = "PROBE_TOKEN_SETTLEMENT_FAILED";
    }
  }
  const finishedAt = responseAtUtc ?? new Date().toISOString();
  const rawForTelemetry = normalizedHeaders ?? readRateLimitHeaders(new Headers());
  const settlementSnapshot = settlement ? {
    settled: settlement.settled,
    changed: settlement.changed,
    actualTokens: settlement.actualTokens,
    reservedTokensBefore: settlement.reservedTokensBefore,
    accountedTokens: settlement.accountedTokens,
    deltaTokens: settlement.deltaTokens,
  } : null;
  const telemetry = agentTelemetrySchema.parse({
    status,
    provider: "groq",
    providerUnit: "tokens",
    providerUnitUsageKnown: usageValid && settlement !== null,
    actualProviderUnitUsage: usageValid ? usage?.totalTokens ?? null : null,
    providerRequestDispatched: true,
    errorCategory,
    rateLimitHeaders: rawForTelemetry,
    providerRateLimit: normalizeGroqProviderRateLimit(rawForTelemetry),
    providerHttpStatus: httpStatus,
    model: returnedModel ?? MODEL,
    agentVersion: PROBE_VERSION,
    structuredOutputMode: null,
    reasoningEffort: null,
    includeReasoning: null,
    finishReason,
    providerRequestsUsed: 1,
    attempts: 1,
    retries: 0,
    latencyMs: Math.max(0, Date.parse(finishedAt) - Date.parse(requestAtUtc)),
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    requestBytes: Buffer.byteLength(JSON.stringify(buildMinimalTpmProbeBody()), "utf8"),
    responseBytes,
    zodValid: null,
    startedAt: requestAtUtc,
    finishedAt,
  });
  try {
    await input.logger.log(runId, metadata, {
      level: errorCode ? "warn" : "info",
      step: "tpm_probe_response",
      message: "One minimal Groq TPM diagnostic response captured; completion content omitted",
      payload: {
        httpStatus,
        model: returnedModel,
        usage,
        rateLimitHeaders: headersSnapshot,
        responseFresh,
        responseSchemaValid,
        usageValid,
        settlement: settlementSnapshot,
        errorCode,
      },
    });
    await input.logger.finishRun(runId, metadata, status === "SUCCESS" ? "succeeded" : "failed", finishedAt, { telemetry } as unknown as Json, errorCode ?? undefined);
    accountingPersisted = true;
  } catch {
    accountingPersisted = false;
    errorCode = "PROBE_ACCOUNTING_PERSISTENCE_FAILED";
  }
  return { runId, reservationId, dispatched, httpStatus, returnedModel, responseFresh, responseSchemaValid, usageValid, usage, requestDate, requestAtUtc, responseDate, responseAtUtc, headers: headersSnapshot, normalizedHeaders, settlement, accountingPersisted, error: errorCode };
}

async function getPilotRunsAfterAudit(supabase: ReturnType<typeof createSupabaseServerClient>, auditAtUtc: string): Promise<Array<Record<string, unknown>>> {
  const pilot = await readJson(PILOT_BASELINE_PATH);
  const eventKeys = Array.isArray(pilot.perEventResults) ? pilot.perEventResults.map((value) => record(value).eventKey).filter((value): value is string => typeof value === "string") : [];
  const results = await Promise.all(eventKeys.map((eventKey) => supabase.from("agent_runs").select("id,provider,stats,config,started_at,finished_at")
    .eq("provider", "groq").eq("config->>eventKey", eventKey).gt("started_at", auditAtUtc)));
  if (results.some((result) => result.error)) throw new Error("PILOT_CALL_LEDGER_READ_FAILED");
  return results.flatMap((result) => (result.data ?? []) as unknown as Array<Record<string, unknown>>);
}

async function readPostRunState(input: {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  logger: SupabaseAgentLogger;
  freshState: Awaited<ReturnType<typeof readFreshLiveState>>;
  baseline: { auditAtUtc: string };
  probeRunId: string | null;
  probeUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
}): Promise<Record<string, unknown>> {
  const [attemptR, articleR, publicR, pilotRuns, dailyUsage] = await Promise.all([
    input.supabase.from("pipeline_event_attempts").select("id,event_key,pipeline_run_id,attempt_number,purpose,pilot_attempt_number,final_state,stop_stage,stop_reason,completed_at,continuation").eq("id", continuation.attemptId).maybeSingle(),
    input.supabase.from("articles").select("id,event_id,slug,publication_status,updated_at").eq("id", incident.articleId).maybeSingle(),
    input.supabase.from("public_published_articles").select("*"),
    getPilotRunsAfterAudit(input.supabase, input.baseline.auditAtUtc),
    input.logger.getProviderDailyUsage("groq", utcDate()),
  ]);
  if (attemptR.error || articleR.error || publicR.error) throw new Error("POST_RUN_STATE_READ_FAILED");
  const continuationState = record(attemptR.data?.continuation);
  const publicRows = (publicR.data ?? []) as unknown as Array<Record<string, unknown>>;
  const otherAfter = publicRows.filter((row) => row.slug !== incident.articleSlug).map((row) => ({ slug: typeof row.slug === "string" ? row.slug : null, sha256: sha256(stableJson(row)) })).sort((a, b) => String(a.slug).localeCompare(String(b.slug)));
  const otherBefore = input.freshState.publicHashes.filter((row) => row.slug !== incident.articleSlug);
  const criticRunsR = await input.supabase.from("agent_runs").select("id,config,stats,status,provider,started_at,finished_at")
    .eq("config->>eventKey", incident.eventKey)
    .eq("config->>pipelineRunId", continuation.continuationPipelineRunId)
    .eq("config->>agentName", "critic")
    .eq("config->>agentVersion", "critic-v4")
    .eq("provider", "groq");
  if (criticRunsR.error) throw new Error("CRITIC_POST_RUN_READ_FAILED");
  const criticRuns = criticRunsR.data ?? [];
  const criticRun = criticRuns[0] ?? null;
  const criticLogsR = criticRun ? await input.supabase.from("agent_logs").select("step,payload,provider_unit,provider_unit_amount").eq("run_id", criticRun.id).eq("step", "provider_request_reserved") : { data: [], error: null };
  if (criticLogsR.error) throw new Error("CRITIC_ACCOUNTING_POST_RUN_READ_FAILED");
  const criticTelemetry = record(record(criticRun?.stats).telemetry);
  const criticReservation = criticLogsR.data?.[0] ?? null;
  const probeStat = input.probeRunId ? pilotRuns.find((run) => run.id === input.probeRunId) : null;
  const dispatchedPilotRuns = pilotRuns.filter((run) => {
    const telemetry = record(record(run.stats).telemetry);
    return telemetry.providerRequestDispatched === true && telemetry.providerRequestsUsed === 1;
  });
  return {
    article: articleR.data ? { id: articleR.data.id, eventId: articleR.data.event_id, slug: articleR.data.slug, publicationStatus: articleR.data.publication_status, updatedAt: articleR.data.updated_at } : null,
    publicCount: publicRows.length,
    incidentPublicCount: publicRows.filter((row) => row.slug === incident.articleSlug).length,
    publicHashesAfter: publicRows.map((row) => ({ slug: typeof row.slug === "string" ? row.slug : null, sha256: sha256(stableJson(row)) })).sort((a, b) => String(a.slug).localeCompare(String(b.slug))),
    otherArticleIntegrity: { before: otherBefore, after: otherAfter, unchanged: stableJson(otherBefore) === stableJson(otherAfter) },
    continuation: {
      status: continuationState.status ?? null,
      pipelineRunId: continuationState.pipelineRunId ?? null,
      resumeStage: continuationState.resumeStage ?? null,
      resumeGeneration: continuationState.resumeGeneration ?? null,
      resumeExecutionId: continuationState.resumeExecutionId ?? null,
      resumeHistoryLength: Array.isArray(continuationState.resumeHistory) ? continuationState.resumeHistory.length : 0,
      stopReason: continuationState.stopReason ?? null,
      stopStage: continuationState.stopStage ?? null,
      authorizationReference: continuationState.authorizationReference ?? null,
      authorizedAt: continuationState.authorizedAt ?? null,
    },
    attempt: attemptR.data ? { id: attemptR.data.id, attemptNumber: attemptR.data.attempt_number, purpose: attemptR.data.purpose, pilotAttemptNumber: attemptR.data.pilot_attempt_number, finalState: attemptR.data.final_state, stopReason: attemptR.data.stop_reason, stopStage: attemptR.data.stop_stage } : null,
    critic: {
      runCount: criticRuns.length,
      runId: criticRun?.id ?? null,
      provider: criticRun?.provider ?? null,
      status: criticRun?.status ?? null,
      dispatched: criticTelemetry.providerRequestDispatched === true && criticTelemetry.providerRequestsUsed === 1,
      telemetry: Object.keys(criticTelemetry).length ? {
        status: criticTelemetry.status ?? null,
        inputTokens: criticTelemetry.inputTokens ?? null,
        outputTokens: criticTelemetry.outputTokens ?? null,
        totalTokens: criticTelemetry.totalTokens ?? null,
        providerUnitUsageKnown: criticTelemetry.providerUnitUsageKnown ?? null,
        providerHttpStatus: criticTelemetry.providerHttpStatus ?? null,
        retries: criticTelemetry.retries ?? null,
        errorCategory: criticTelemetry.errorCategory ?? null,
      } : null,
      reservation: criticReservation ? {
        providerUnit: criticReservation.provider_unit,
        providerUnitAmount: criticReservation.provider_unit_amount,
        details: record(criticReservation.payload),
      } : null,
    },
    probe: {
      runId: input.probeRunId,
      dispatched: Boolean(probeStat && record(record(probeStat.stats).telemetry).providerRequestDispatched === true),
      usage: input.probeUsage,
    },
    pilotCallsAfter: PILOT_CALLS_BEFORE + dispatchedPilotRuns.length,
    dispatchedPilotRuns: dispatchedPilotRuns.map((run) => ({ runId: run.id, agentName: record(run.config).agentName, model: record(run.config).model, startedAt: run.started_at })),
    capacity: {
      utcDay: utcDate(),
      groqDailyRequestsReserved: dailyUsage.requestsReserved,
      groqDailyRequestsDispatched: dailyUsage.requestsDispatched,
      groqDailyTokens: dailyUsage.totalTokens,
      groqUnknownTokenReservations: dailyUsage.unknownTokenRequests,
      cloudflareCalls: 0,
      cerebrasCalls: 0,
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.length === 1 && args[0] === "--execute-final-remediation";
  const preflightOnly = args.length === 1 && args[0] === "--preflight-only";
  need(execute || preflightOnly, "USAGE: --preflight-only | --execute-final-remediation");

  const context = await buildPreflight();
  const { artifact, supabase, logger, limits, apiKey, requestLimit, probeEstimate, criticEstimate, baseline } = context;
  artifact.status = preflightOnly ? "PREFLIGHT_ONLY" : "READY_FOR_PROBE";
  artifact.stopReason = null;
  await writeArtifact(artifact);
  if (preflightOnly) {
    console.log(JSON.stringify({ status: artifact.status, liveState: artifact.liveStateBefore, manifestCheck: artifact.manifestCheck, criticV4Estimate: artifact.criticV4Estimate, probeEstimate, pilotCallsBefore: artifact.pilotCallsBefore, providerCalls: 0, artifact: ARTIFACT_PATH }, null, 2));
    return;
  }

  const probe = await executeMinimalProbe({ supabase, logger, limits, apiKey, requestLimit, probeEstimate });
  artifact.probe = {
    dispatched: probe.dispatched,
    httpStatus: probe.httpStatus,
    model: MODEL,
    endpoint: PROBE_URL,
    prompt: PROBE_PROMPT,
    maxCompletionTokens: 1,
    tools: false,
    structuredOutput: false,
    usage: probe.usage,
    headers: probe.headers,
    requestDate: probe.requestAtUtc,
    responseDate: probe.responseDate,
    responseFresh: probe.responseFresh,
    settlement: probe.settlement,
    accountingPersisted: probe.accountingPersisted,
    completionContentRecorded: false,
    runId: probe.runId,
    reservationId: probe.reservationId,
    error: probe.error,
  } as ReturnType<typeof baseArtifact>["probe"];
  artifact.pilotCallsBefore = baseline.callsBefore;
  if (!probe.dispatched || !probe.accountingPersisted || !probe.settlement) {
    artifact.status = "STOPPED_AFTER_PROBE_FAILURE";
    artifact.capacityDecision = { decision: "BLOCKED_TPM_STATE_UNKNOWN", reason: probe.error ?? "PROBE_NOT_ACCOUNTED" };
    artifact.stopReason = probe.error ?? "PROBE_NOT_ACCOUNTED";
    artifact.finalDecision = "STOPPED_PROBE";
    artifact.pilotCallsFinal = PILOT_CALLS_BEFORE + (probe.dispatched ? 1 : 0);
    await writeArtifact(artifact);
    console.log(JSON.stringify({ status: artifact.status, capacity: artifact.capacityDecision, probe: artifact.probe, providerCalls: probe.dispatched ? 1 : 0, artifact: ARTIFACT_PATH }, null, 2));
    return;
  }

  const classified = classifyProbeCapacity({
    httpStatus: probe.httpStatus,
    returnedModel: probe.returnedModel,
    responseFresh: probe.responseFresh,
    responseSchemaValid: probe.responseSchemaValid,
    usageValid: probe.usageValid,
    headers: probe.normalizedHeaders,
    plannedCriticTokens: criticEstimate.estimatedStageTokenRequirement,
    configuredTpmLimit: limits.tokenMinuteHardLimit ?? TPM_LIMIT,
  });
  const requestRemaining = parseHeaderInteger(probe.headers?.["x-ratelimit-remaining-requests"]);
  if (requestRemaining !== null && requestRemaining < 1) classified.decision = "BLOCKED_DAILY_CAPACITY";
  artifact.capacityDecision = {
    ...classified,
    providerLimitHeader: probe.headers?.["x-ratelimit-limit-tokens"] ?? null,
    providerRemainingHeader: probe.headers?.["x-ratelimit-remaining-tokens"] ?? null,
    providerResetHeader: probe.headers?.["x-ratelimit-reset-tokens"] ?? null,
    configuredTpmLimit: limits.tokenMinuteHardLimit,
    decision: classified.decision,
  };
  artifact.pilotCallsAfterProbe = PILOT_CALLS_BEFORE + 1;
  artifact.status = "PROBE_COMPLETE";
  await writeArtifact(artifact);

  if (classified.decision !== "IMMEDIATE") {
    artifact.status = "STOPPED_BEFORE_RESUME";
    artifact.stopReason = classified.decision;
    artifact.finalDecision = classified.decision === "BLOCKED_DAILY_CAPACITY" ? "STOPPED_CAPACITY" : "STOPPED_CAPACITY";
    artifact.resumeResult = "NOT_RUN";
    artifact.criticResult = "NOT_RUN";
    artifact.publisherResult = "NOT_RUN";
    artifact.pilotCallsFinal = PILOT_CALLS_BEFORE + 1;
    await writeArtifact(artifact);
    console.log(JSON.stringify({ status: artifact.status, decision: classified.decision, pilotCallsFinal: artifact.pilotCallsFinal, providerCalls: 1, artifact: ARTIFACT_PATH }, null, 2));
    return;
  }

  const [usageAfterProbe, activeBlockAfterProbe, latestEventTpm, newPilotRuns] = await Promise.all([
    logger.getProviderDailyUsage("groq", probe.requestDate),
    logger.getProviderRateLimitState("groq"),
    logger.getLatestProviderRateLimitTelemetry("groq", incident.eventKey),
    getPilotRunsAfterAudit(supabase, baseline.auditAtUtc),
  ]);
  const resetActive = !!activeBlockAfterProbe?.blockedUntil && Date.parse(activeBlockAfterProbe.blockedUntil) > Date.now();
  const postProbeAdmission = evaluateGroqNewEventAdmission({
    currentRequests: usageAfterProbe.requestsReserved,
    currentTokens: usageAfterProbe.totalTokens,
    tokenUsageKnown: usageAfterProbe.tokenUsageKnown,
    requestHardLimit: limits.requestHardLimit,
    tokenHardLimit: limits.tokenHardLimit,
    softRatio: DAILY_SOFT_LIMIT_RATIO,
    eventRequests: 1,
    eventTokens: criticEstimate.estimatedStageTokenRequirement,
  });
  const latestEventTpmUsable = latestEventTpm?.tokenLimitMinute === TPM_LIMIT
    && latestEventTpm.tokenRemainingMinute === classified.remainingTokens
    && latestEventTpm.tokenResetSeconds !== null;
  const dailyBeforeProbe = record(artifact.criticV4Estimate?.dailyCapacity);
  const requestsReservedBeforeProbe = Number(dailyBeforeProbe.requestsUsed);
  const requestsDispatchedBeforeProbe = Number(dailyBeforeProbe.requestsDispatched);
  const tokensBeforeProbe = Number(dailyBeforeProbe.tokensUsed);
  artifact.probeAccountingDelta = {
    baselineRequests: requestsReservedBeforeProbe,
    postProbeRequests: usageAfterProbe.requestsReserved,
    requestDelta: usageAfterProbe.requestsReserved - requestsReservedBeforeProbe,
    baselineDispatched: requestsDispatchedBeforeProbe,
    postProbeDispatched: usageAfterProbe.requestsDispatched,
    dispatchedDelta: usageAfterProbe.requestsDispatched - requestsDispatchedBeforeProbe,
    baselineTokens: tokensBeforeProbe,
    postProbeTokens: usageAfterProbe.totalTokens,
    actualProbeTokens: probe.usage?.totalTokens ?? null,
    tokenDelta: usageAfterProbe.totalTokens - tokensBeforeProbe,
    unknownDispatchedReservationsBefore: Number(dailyBeforeProbe.unknownTokenReservations),
    unknownDispatchedReservationsAfter: usageAfterProbe.unknownTokenRequests,
    status: "CHECKING",
  };
  const probeDeltaPass = probe.usage !== null && matchesDailyUsageDeltaAfterProbe({
    requestsReservedBefore: requestsReservedBeforeProbe,
    requestsDispatchedBefore: requestsDispatchedBeforeProbe,
    tokensBefore: tokensBeforeProbe,
    requestsReservedAfter: usageAfterProbe.requestsReserved,
    requestsDispatchedAfter: usageAfterProbe.requestsDispatched,
    tokensAfter: usageAfterProbe.totalTokens,
    probeTokens: probe.usage?.totalTokens ?? 0,
    tokenUsageKnown: usageAfterProbe.tokenUsageKnown,
    unknownTokenRequestsBefore: Number(dailyBeforeProbe.unknownTokenReservations),
    unknownTokenRequests: usageAfterProbe.unknownTokenRequests,
  });
  artifact.probeAccountingDelta.status = probeDeltaPass ? "PASS" : "FAIL";
  need(probeDeltaPass
    && postProbeAdmission.eligible && !resetActive
    && latestEventTpmUsable
    && newPilotRuns.length === 1 && record(newPilotRuns[0]?.stats).telemetry !== undefined,
  "POST_PROBE_CAPACITY_OR_CANONICAL_ACCOUNTING_RECHECK_FAILED");
  artifact.capacityDecision.postProbeDailyGate = "PASS";
  artifact.capacityDecision.postProbeEventScopedHeader = "PASS";
  artifact.capacityDecision.providerRpdRemainingAfterProbe = requestRemaining;
  artifact.capacityDecision.dailyRequestsReservedAfterProbe = usageAfterProbe.requestsReserved;
  artifact.capacityDecision.dailyTokensAfterProbe = usageAfterProbe.totalTokens;

  // No pause or return to the user occurs between IMMEDIATE and reuse of the existing authorization.
  artifact.status = "RESUMING_EXISTING_AUTHORIZATION";
  artifact.resumeResult = "IN_PROGRESS";
  artifact.sameAuthorization = "YES";
  artifact.newAuthorization = false;
  await writeArtifact(artifact);
  let runnerError: string | null = null;
  try {
    await runPreviouslyAuthorizedContinuation({
      outcomePath: CONTINUATION_RUNNER_OUTCOME,
      outcomePhase: "12C.2B.2g.3a",
      onResumeRpcInvocation: async () => {
        artifact.resumeRpcInvocations = 1;
        artifact.resumeRpcCalls = 1;
        await writeArtifact(artifact);
      },
    });
  } catch (error) {
    runnerError = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : "CONTINUATION_RUNNER_FAILED";
  }

  artifact.status = "POST_RUN_AUDIT";
  try {
    const post = await readPostRunState({ supabase, logger, freshState: context.freshState, baseline, probeRunId: probe.runId, probeUsage: probe.usage });
    const postCont = record(post.continuation);
    const postCritic = record(post.critic);
    artifact.resumeResultDetail = postCont.resumeGeneration === 1 ? "CONSUMED" : "NOT_CONSUMED";
    artifact.sameAuthorization = postCont.pipelineRunId === continuation.continuationPipelineRunId
      && postCont.authorizationReference === context.freshState.priorAuthReference ? "YES" : "NO";
    artifact.resumeResult = postCont.resumeGeneration === 1 && artifact.sameAuthorization === "YES"
      ? "PASS" : artifact.resumeRpcInvocations === 1 ? "REJECTED" : "NOT_RUN";
    artifact.resumeRpcResult = artifact.resumeResult;
    artifact.resumeExecutionId = typeof postCont.resumeExecutionId === "string" ? postCont.resumeExecutionId : null;
    artifact.criticReservation = postCritic.reservation ? "PRESENT" : "ABSENT";
    artifact.criticDispatch = postCritic.dispatched === true ? "YES" : "NO";
    artifact.criticUsage = postCritic.telemetry as Record<string, unknown> | null;
    artifact.criticResult = postCritic.runCount === 1 ? "SEE_CHECKPOINT_AND_LIFECYCLE_OUTCOME" : "NOT_RUN";
    artifact.publisherReadiness = postCritic.runCount === 1 && postCritic.dispatched === true && postCritic.telemetry !== null ? "PASS" : "NOT_REACHED";
    let childOutcome: Record<string, unknown> = {};
    try { childOutcome = await readJson(CONTINUATION_RUNNER_OUTCOME); } catch { /* The continuation can stop before writing its completion artifact. */ }
    artifact.criticDecision = typeof childOutcome.criticDecision === "string" ? childOutcome.criticDecision : "NOT_AVAILABLE";
    const usage = record(postCritic.telemetry);
    const criticTokens = Number(usage.totalTokens);
    const finalCapacity = record(post.capacity);
    const usageSettled = Number.isSafeInteger(criticTokens) && criticTokens >= 0
      && usage.providerUnitUsageKnown === true
      && finalCapacity.groqDailyRequestsReserved === usageAfterProbe.requestsReserved + 1
      && finalCapacity.groqDailyRequestsDispatched === usageAfterProbe.requestsDispatched + 1
      && finalCapacity.groqDailyTokens === usageAfterProbe.totalTokens + criticTokens
      && finalCapacity.groqUnknownTokenReservations === usageAfterProbe.unknownTokenRequests;
    artifact.criticUsageSettled = postCritic.runCount === 0 ? "NOT_RUN" : usageSettled ? "YES" : "NO";
    artifact.publisherAccountingGuard = artifact.criticDecision === "pass" && usageSettled ? "PASS"
      : postCritic.runCount === 0 ? "NOT_RUN" : "BLOCKED";
    artifact.publisherResult = postCont.status === "PUBLISHED" ? "PASS" : "NOT_RUN";
    artifact.claimSupportReview = postCont.status === "PUBLISHED"
      ? { status: "REQUIRED_MANUAL_REVIEW", materialUnsupportedClaims: null }
      : { status: "NOT_RUN", materialUnsupportedClaims: null, reason: "No publication occurred; the target article remained archived" };
    artifact.publicCountAfter = Number(post.publicCount);
    artifact.otherArticleIntegrity = post.otherArticleIntegrity as Record<string, unknown>;
    artifact.capacityFinal = post.capacity as Record<string, unknown>;
    artifact.auditHistory = {
      attemptId: continuation.attemptId,
      originalRunId: continuation.originalPipelineRunId,
      continuationId: postCont.pipelineRunId,
      authorizationReference: postCont.authorizationReference,
      authorizedAt: postCont.authorizedAt,
      resumeGeneration: postCont.resumeGeneration,
      resumeExecutionId: postCont.resumeExecutionId,
      historicalCostGuardViolationPreserved: record(post.attempt).stopReason === "cost_guard_violation",
      historicalContinuationRunnerAbortedPreserved: postCont.stopReason === "CONTINUATION_RUNNER_ABORTED"
        || (Array.isArray(postCont.resumeHistory) && record(postCont.resumeHistory[0]).stopReason === "CONTINUATION_RUNNER_ABORTED"),
      attemptCount: 2,
      pilotAttempts: "5/5",
      noAttemptSix: true,
      noUpstreamReruns: true,
      priorStoppedStateArtifactPreserved: true,
      manifestMismatchIncidentArtifactPreserved: true,
      runnerError,
    };
    const dispatchedRuns = Array.isArray(post.dispatchedPilotRuns) ? post.dispatchedPilotRuns : [];
    artifact.pilotCallsFinal = PILOT_CALLS_BEFORE + dispatchedRuns.length;
    artifact.resumeRpcCalls = artifact.resumeRpcInvocations;
    artifact.status = postCont.status === "PUBLISHED" ? "EXECUTION_COMPLETE_PUBLISHED"
      : runnerError?.startsWith("FACTUAL_REMEDIATION_CONTINUATION_RESUME_BLOCKED:") ? "STOPPED_AFTER_RESUME_GUARD_FAILURE"
        : "EXECUTION_COMPLETE_STOPPED";
    artifact.stopReason = runnerError ?? (postCont.stopReason as string | null) ?? (postCont.status === "PUBLISHED" ? null : "CRITIC_OR_PUBLISHER_DID_NOT_PASS");
    artifact.finalDecision = postCont.status === "PUBLISHED" ? "PUBLISHED_CORRECTED"
      : artifact.resumeRpcInvocations === 0 ? "STOPPED_ACCOUNTING"
        : postCont.resumeGeneration !== 1 ? "STOPPED_RESUME"
          : artifact.criticDecision !== "pass" || artifact.criticUsageSettled !== "YES" ? "STOPPED_CRITIC" : "STOPPED_PUBLISHER";
    artifact.publication = post.article === null ? null : record(post.article);
    artifact.postRunAudit = post;
  } catch (error) {
    artifact.status = "POST_RUN_AUDIT_FAILED";
    artifact.stopReason = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : "POST_RUN_AUDIT_FAILED";
  }
  await writeArtifact(artifact);
  console.log(JSON.stringify({ status: artifact.status, decision: artifact.capacityDecision, resume: artifact.resumeResult, sameAuthorization: artifact.sameAuthorization, criticDispatch: artifact.criticDispatch, criticUsage: artifact.criticUsage, publisher: artifact.publisherResult, publicCountBefore: artifact.publicCountBefore, publicCountAfter: artifact.publicCountAfter, pilotCallsFinal: artifact.pilotCallsFinal ?? null, stopReason: artifact.stopReason, artifact: ARTIFACT_PATH }, null, 2));
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectExecution) {
  main().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 240) : "UNKNOWN_ERROR";
    try {
      const artifact = await readJson(ARTIFACT_PATH);
      const probe = record(artifact.probe);
      const probeDispatched = probe.dispatched === true;
      artifact.stopReason = message;
      if (probeDispatched) {
        artifact.status = artifact.resumeRpcInvocations === 1 ? "STOPPED_AFTER_RESUME_RPC" : "STOPPED_ACCOUNTING";
        artifact.finalRemediationDecision = artifact.resumeRpcInvocations === 1 ? "STOPPED_RESUME_RPC" : "STOPPED_ACCOUNTING";
        artifact.resumeResult = artifact.resumeRpcInvocations === 1 ? "FAILED_OR_REJECTED" : "NOT_RUN";
        artifact.resumeRpcResult = artifact.resumeResult;
        artifact.resumeResultDetail = artifact.resumeResult;
        artifact.resumeRpcCalls = artifact.resumeRpcInvocations;
        artifact.pilotCallsFinal = PILOT_CALLS_BEFORE + 1;
        artifact.finalDecision = artifact.resumeRpcInvocations === 1 ? "STOPPED_RESUME" : "STOPPED_ACCOUNTING";
        if (artifact.resumeRpcInvocations !== 1) {
          artifact.criticDispatch = "NO";
          artifact.criticResult = "NOT_RUN";
          artifact.publisherResult = "NOT_RUN";
        }
      } else {
        artifact.status = "BLOCKED_BEFORE_EXECUTION";
        artifact.finalDecision = "STOPPED_PREFLIGHT";
      }
      await writeArtifact(artifact as ReturnType<typeof baseArtifact>);
    } catch {
      // Preserve the original execution error if the local artifact cannot be updated.
    }
    console.error(JSON.stringify({ status: "BLOCKED_BEFORE_OR_DURING_EXECUTION", stopReason: message, providerCalls: "SEE_CANONICAL_LEDGER", artifact: ARTIFACT_PATH }));
    process.exitCode = 1;
  });
}
