import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { getAgentFailureDetails, getProviderDiagnostics } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { ProviderScopedDailyRequestBudget, resolveGroqDailyRequestHardCap } from "../lib/agents/runtime/request-budget.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import type { AgentTelemetry, ProviderRateLimitTelemetry, RateLimitHeaders, ModelConfig } from "../lib/agents/runtime/runtime-types.ts";

const MODEL = "openai/gpt-oss-20b";
const SOFT_RATIO = 0.85;
const MAX_OUTPUT_TOKENS = 64;
const AGENT_VERSION = "groq-capacity-probe-v1";
const ARTIFACT_PATH = resolve(process.cwd(), "artifacts/groq-effective-capacity-probe-10g7a3.json");
const PROBE_SCHEMA = z.object({ ok: z.literal(true) }).strict();

type PreflightResult = {
  passed: boolean;
  checkedAtUtc: string;
  requestDateUtc: string;
  provider: "groq";
  model: string;
  checks: Record<string, boolean>;
  internalHardCap: number;
  internalCapSource: string;
  internalSoftThreshold: number;
  requestsUsedBefore: number | null;
  requestsRemainingBefore: number | null;
  requestsProjected: number | null;
  activeProviderBlock: boolean | null;
  persistentReads: { client: string; quota: string; usage: string; rateLimit: string };
  eventKey: null;
  reason: string | null;
};

class ProbeLogger extends SupabaseAgentLogger {
  probeRunId: string | null = null;

  override async startRun(metadata: Parameters<SupabaseAgentLogger["startRun"]>[0], startedAt: string): Promise<string | null> {
    this.probeRunId = await super.startRun(metadata, startedAt);
    return this.probeRunId;
  }
}

function envBoolean(name: string, fallback: boolean): boolean | null {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function baseChecks(): { checks: Record<string, boolean>; cap: ReturnType<typeof resolveGroqDailyRequestHardCap> } {
  const cap = resolveGroqDailyRequestHardCap();
  const providerPolicy = freeProviderPolicy.groq;
  const configuredUrl = process.env.AGENT_API_URL?.trim().replace(/\/$/, "");
  const routerEnabled = envBoolean("FREE_PROVIDER_ROUTER_ENABLED", false);
  const allowPaidFallback = envBoolean("AGENT_ALLOW_PAID_FALLBACK", false);
  const failOnRateLimit = envBoolean("AGENT_FAIL_ON_RATE_LIMIT", true);
  return {
    cap,
    checks: {
      providerIsGroq: process.env.AGENT_PROVIDER?.trim().toLowerCase() === "groq",
      modelIsApproved: process.env.AGENT_MODEL_VERIFY?.trim() === MODEL && providerPolicy.approvedModels.includes(MODEL),
      endpointIsOfficialGroq: configuredUrl === "https://api.groq.com/openai/v1",
      providerPolicyIsFreeOnly: providerPolicy.billingMode === "free_only" && providerPolicy.costClass === "PERMANENT_FREE_APPROVED",
      apiKeyPresent: !!process.env.AGENT_API_KEY?.trim(),
      paidFallbackForbidden: allowPaidFallback === false,
      rateLimitFailsClosed: failOnRateLimit === true,
      providerRouterNotUsed: routerEnabled === false,
      supabaseUrlPresent: !!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
      supabaseSecretPresent: !!process.env.SUPABASE_SECRET_KEY?.trim(),
      noServiceTierOrToolsInAdapter: true,
      singleAttemptConfiguration: true,
    },
  };
}

async function getPreflight(): Promise<PreflightResult> {
  const checkedAtUtc = new Date().toISOString();
  const requestDateUtc = checkedAtUtc.slice(0, 10);
  const { checks, cap } = baseChecks();
  const internalSoftThreshold = Math.floor(cap.limit * SOFT_RATIO);
  let used: number | null = null;
  let remaining: number | null = null;
  let activeProviderBlock: boolean | null = null;
  let reason: string | null = null;
  const persistentReads = { client: "NOT_RUN", quota: "NOT_RUN", usage: "NOT_RUN", rateLimit: "NOT_RUN" };

  if (!Object.values(checks).every(Boolean)) {
    reason = "BLOCKED_FREE_ONLY_OR_CONFIGURATION_CHECK";
  } else {
    try {
      const logger = new SupabaseAgentLogger(createSupabaseServerClient());
      persistentReads.client = "PASS";
      const quota = await logger.getRemainingRequests(cap.limit, requestDateUtc);
      persistentReads.quota = "PASS";
      const usage = await logger.getProviderDailyUsage("groq", requestDateUtc);
      persistentReads.usage = "PASS";
      const block = await logger.getProviderRateLimitState("groq");
      persistentReads.rateLimit = "PASS";
      used = quota.used;
      remaining = quota.remaining;
      if (usage.provider !== "groq" || usage.dateUtc !== requestDateUtc || usage.requestsReserved !== quota.used) {
        reason = "BLOCKED_INCONSISTENT_GROQ_ACCOUNTING";
      }
      const blockedUntil = block?.blockedUntil ?? null;
      activeProviderBlock = !!blockedUntil && Date.parse(blockedUntil) > Date.parse(checkedAtUtc);
      if (!reason && activeProviderBlock) reason = "BLOCKED_ACTIVE_GROQ_RATE_LIMIT";
      if (!reason && (remaining < 1 || used + 1 >= internalSoftThreshold)) reason = "BLOCKED_GROQ_SOFT_OR_HARD_CAPACITY";
    } catch {
      reason = `BLOCKED_PERSISTENT_GROQ_${persistentReads.client !== "PASS" ? "CLIENT" : persistentReads.quota !== "PASS" ? "QUOTA_READ" : persistentReads.usage !== "PASS" ? "USAGE_READ" : "RATE_LIMIT_READ"}_UNAVAILABLE`;
    }
  }
  checks.persistentClientReadable = persistentReads.client === "PASS";
  checks.persistentQuotaReadable = persistentReads.quota === "PASS";
  checks.providerUsageReadable = persistentReads.usage === "PASS";
  checks.providerRateLimitReadable = persistentReads.rateLimit === "PASS";

  const requestsProjected = used === null ? null : used + 1;
  const capacityAvailable = used !== null && remaining !== null && remaining > 0
    && requestsProjected !== null && requestsProjected < internalSoftThreshold;
  const passed = reason === null && capacityAvailable && activeProviderBlock === false;
  return {
    passed,
    checkedAtUtc,
    requestDateUtc,
    provider: "groq",
    model: MODEL,
    checks,
    internalHardCap: cap.limit,
    internalCapSource: cap.source,
    internalSoftThreshold,
    requestsUsedBefore: used,
    requestsRemainingBefore: remaining,
    requestsProjected,
    activeProviderBlock,
    persistentReads,
    eventKey: null,
    reason: passed ? null : reason ?? "BLOCKED_GROQ_CAPACITY_UNKNOWN",
  };
}

function safeHeaderSnapshot(headers: RateLimitHeaders | null | undefined): Record<string, string | null> | null {
  if (!headers) return null;
  return {
    "x-ratelimit-limit-requests": headers.limitRequestsDay ?? headers.limitRequests ?? null,
    "x-ratelimit-remaining-requests": headers.remainingRequestsDay ?? headers.remainingRequests ?? null,
    "x-ratelimit-reset-requests": headers.resetRequestsDay ?? headers.resetRequests ?? null,
    "x-ratelimit-limit-tokens": headers.limitTokensMinute ?? headers.limitTokens ?? null,
    "x-ratelimit-remaining-tokens": headers.remainingTokensMinute ?? headers.remainingTokens ?? null,
    "x-ratelimit-reset-tokens": headers.resetTokensMinute ?? headers.resetTokens ?? null,
    "retry-after": headers.retryAfter ?? null,
  };
}

function headerCoverage(headers: Record<string, string | null> | null): "CAPTURED" | "PARTIAL" | "ABSENT" {
  if (!headers) return "ABSENT";
  const primary = [
    headers["x-ratelimit-limit-requests"], headers["x-ratelimit-remaining-requests"], headers["x-ratelimit-reset-requests"],
    headers["x-ratelimit-limit-tokens"], headers["x-ratelimit-remaining-tokens"], headers["x-ratelimit-reset-tokens"],
  ];
  const present = primary.filter((value) => value !== null).length;
  return present === primary.length ? "CAPTURED" : present > 0 ? "PARTIAL" : "ABSENT";
}

function compareRpd(internal: number, provider: number | null): string {
  if (provider === null) return "UNKNOWN";
  if (internal < provider) return "INTERNAL_CAP_MORE_RESTRICTIVE";
  if (internal > provider) return "PROVIDER_CAP_MORE_RESTRICTIVE";
  return "SAME";
}

function baseArtifact(preflight: PreflightResult) {
  return {
    phase: "10G.7a.3",
    recordedAtUtc: new Date().toISOString(),
    preflight,
    provider: "groq",
    model: MODEL,
    limitScope: "UNKNOWN",
    providerHttpStatus: null as number | null,
    providerCalls: 0,
    attempts: 0,
    retries: 0,
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    totalTokens: null as number | null,
    latencyMs: null as number | null,
    finishReason: null as string | null,
    providerRateLimitHeaders: null as Record<string, string | null> | null,
    providerReportedLimits: null as Record<string, unknown> | null,
    normalizedProviderRateLimit: null as ProviderRateLimitTelemetry | null,
    headerCoverage: "ABSENT" as "CAPTURED" | "PARTIAL" | "ABSENT",
    internalGroqRequestCap: {
      hard: preflight.internalHardCap,
      source: preflight.internalCapSource,
      softRatio: SOFT_RATIO,
      softThreshold: preflight.internalSoftThreshold,
      changeApplied: false,
    },
    internalVsProviderRpd: "UNKNOWN",
    providerReportedRpm: "UNKNOWN_FROM_API_HEADERS",
    providerReportedTpd: "UNKNOWN_FROM_API_HEADERS",
    rateLimitTelemetryPersistedSafely: "NOT_YET_VERIFIED",
    migrationRequired: false,
    secretsPersisted: false,
    cloudflareCalls: 0,
    cerebrasCalls: 0,
    capacityProductionReady: false,
    productionRoutingEnabled: false,
  };
}

async function writeArtifact(value: unknown): Promise<void> {
  await mkdir(resolve(process.cwd(), "artifacts"), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function persistIdentityCheck(runId: string, expectedModel: string) {
  const client = createSupabaseServerClient();
  const [runResult, logResult] = await Promise.all([
    client.from("agent_runs").select("provider,stats,config").eq("id", runId).single(),
    client.from("agent_logs").select("provider,payload").eq("run_id", runId).eq("step", "provider_request_reserved").limit(2),
  ]);
  if (runResult.error || !runResult.data || logResult.error || !logResult.data) return { verified: false, requestDateUtc: null as string | null };
  const stats = typeof runResult.data.stats === "object" && runResult.data.stats !== null && !Array.isArray(runResult.data.stats) ? runResult.data.stats : {};
  const telemetry = typeof stats.telemetry === "object" && stats.telemetry !== null && !Array.isArray(stats.telemetry) ? stats.telemetry : {};
  const reservation = logResult.data.length === 1 ? logResult.data[0] : null;
  const payload = reservation && typeof reservation.payload === "object" && reservation.payload !== null && !Array.isArray(reservation.payload) ? reservation.payload : {};
  const details = typeof payload.details === "object" && payload.details !== null && !Array.isArray(payload.details) ? payload.details : payload;
  const requestDateUtc = typeof (details.requestDate ?? payload.requestDate) === "string" ? String(details.requestDate ?? payload.requestDate) : null;
  const storedProvider = payload.provider ?? details.provider;
  const storedModel = payload.model ?? details.model;
  const storedEventKey = Object.hasOwn(payload, "eventKey") ? payload.eventKey : details.eventKey;
  const verified = runResult.data.provider === "groq"
    && telemetry.provider === "groq"
    && telemetry.model === expectedModel
    && reservation?.provider === "groq"
    && storedProvider === "groq"
    && storedModel === expectedModel
    && requestDateUtc !== null
    && storedEventKey === null;
  return { verified, requestDateUtc };
}

async function writePreflightAndExit(preflight: PreflightResult): Promise<boolean> {
  const preflightOnly = process.argv.includes("--preflight-only");
  const executeOneRequest = process.argv.includes("--execute-one-request");
  if (preflightOnly || !executeOneRequest) {
    const status = preflight.passed ? "PREFLIGHT_PASSED_NO_CALL" : "PREFLIGHT_BLOCKED";
    await writeArtifact({ ...baseArtifact(preflight), providerCalls: 0, status });
    console.log(JSON.stringify({ preflight, providerCalls: 0, status, artifact: "artifacts/groq-effective-capacity-probe-10g7a3.json" }, null, 2));
    if (!preflight.passed) process.exitCode = 1;
    return true;
  }
  if (!preflight.passed) {
    await writeArtifact({ ...baseArtifact(preflight), status: "PREFLIGHT_BLOCKED" });
    console.log(JSON.stringify({ preflight, providerCalls: 0, status: "BLOCKED_BEFORE_INFERENCE" }, null, 2));
    process.exitCode = 1;
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const allowedArgs = new Set(["--preflight-only", "--execute-one-request"]);
  const unknownArgs = process.argv.slice(2).filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0 || process.argv.includes("--preflight-only") && process.argv.includes("--execute-one-request")) {
    throw new Error("Unsupported probe mode");
  }
  const preflight = await getPreflight();
  if (await writePreflightAndExit(preflight)) return;

  const hardCap = preflight.internalHardCap;
  const modelConfig: ModelConfig = {
    model: MODEL,
    timeoutMs: 20_000,
    maxRetries: 0,
    retryBackoffMs: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    dailyRequestLimit: hardCap,
    failOnRateLimit: true,
    allowPaidFallback: false,
    structuredOutputMode: "json_object",
    reasoningEffort: "low",
    includeReasoning: false,
  };
  const logger = new ProbeLogger(createSupabaseServerClient());
  const provider = createConfiguredModelProvider();
  if (provider.providerId !== "groq") throw new Error("BLOCKED_FREE_ONLY_STATUS_UNCONFIRMED");

  let fetchCalls = 0;
  const directProvider = provider;
  // The configured adapter omits service_tier and tools; the offline contract test pins that behavior.
  if (modelConfig.maxRetries !== 0 || modelConfig.allowPaidFallback || modelConfig.model !== MODEL) throw new Error("BLOCKED_FREE_ONLY_STATUS_UNCONFIRMED");

  const startedAtMs = Date.now();
  let resultTelemetry: AgentTelemetry | null = null;
  let failureTelemetry: AgentTelemetry | null = null;
  let providerHttpStatus: number | null = null;
  let runId: string | null = null;
  let errorCategory: string | null = null;
  try {
    const result = await runStructuredAgent({
      agentName: "groq-free-capacity-probe",
      agentVersion: AGENT_VERSION,
      eventKey: null,
      input: { diagnostic: "Reply with ok=true." },
      systemInstructions: "Return only the tiny JSON object required by the schema. This is a synthetic provider-capacity check; do not use tools or external sources.",
      schemaName: "GroqCapacityProbe",
      schema: PROBE_SCHEMA,
      modelConfig,
      provider: directProvider,
      logger,
      dryRun: true,
      requestBudget: new ProviderScopedDailyRequestBudget(),
    });
    fetchCalls = result.providerRequestsUsed;
    runId = result.runId;
    resultTelemetry = result.telemetry ?? null;
    providerHttpStatus = result.telemetry?.providerHttpStatus ?? null;
  } catch (error) {
    const details = getAgentFailureDetails(error);
    fetchCalls = details.providerRequestsUsed ?? (details.telemetry?.providerRequestsUsed ?? 0);
    failureTelemetry = details.telemetry ?? null;
    providerHttpStatus = details.telemetry?.providerHttpStatus ?? getProviderDiagnostics(error)?.httpStatus ?? null;
    errorCategory = details.telemetry?.errorCategory ?? getProviderDiagnostics(error)?.errorCategory ?? "PROBE_FAILED";
    runId = logger.probeRunId;
  }

  const telemetry = resultTelemetry ?? failureTelemetry;
  const normalized = telemetry?.providerRateLimit ?? null;
  let persistedIdentity = { verified: false, requestDateUtc: null as string | null };
  if (runId) {
    try { persistedIdentity = await persistIdentityCheck(runId, MODEL); } catch { /* telemetry result remains available locally */ }
  }
  const reservationDate = persistedIdentity.requestDateUtc ?? telemetry?.startedAt.slice(0, 10) ?? preflight.requestDateUtc;
  let usageAfter: number | null = null;
  if (telemetry?.providerRequestsUsed === 1) {
    try { usageAfter = (await logger.getRemainingRequests(hardCap, reservationDate)).used; } catch { /* do not hide a completed provider attempt */ }
  }
  const rateHeaders = safeHeaderSnapshot(telemetry?.rateLimitHeaders);
  const rpd = normalized?.requestLimitDaily ?? null;
  const providerReportedLimits = normalized ? {
    provenance: "PROVIDER_REPORTED",
    rpd: { limit: normalized.requestLimitDaily, remaining: normalized.requestRemainingDaily, reset: normalized.requestReset },
    tpm: { limit: normalized.tokenLimitMinute, remaining: normalized.tokenRemainingMinute, reset: normalized.tokenReset },
    retryAfter: rateHeaders?.["retry-after"] ?? null,
    rpm: "UNKNOWN_FROM_API_HEADERS",
    tpd: "UNKNOWN_FROM_API_HEADERS",
  } : null;
  const artifact = {
    ...baseArtifact(preflight),
    recordedAtUtc: new Date().toISOString(),
    status: telemetry?.status ?? "RUNTIME_ERROR",
    providerHttpStatus,
    providerCalls: fetchCalls,
    attempts: telemetry?.attempts ?? 0,
    retries: telemetry?.retries ?? 0,
    inputTokens: telemetry?.inputTokens ?? null,
    outputTokens: telemetry?.outputTokens ?? null,
    totalTokens: telemetry?.totalTokens ?? null,
    latencyMs: telemetry?.latencyMs ?? Date.now() - startedAtMs,
    finishReason: telemetry?.finishReason ?? null,
    providerRateLimitHeaders: rateHeaders,
    providerReportedLimits,
    normalizedProviderRateLimit: normalized,
    headerCoverage: headerCoverage(rateHeaders),
    internalVsProviderRpd: compareRpd(hardCap, rpd),
    currentUsageAfter: { requestDateUtc: reservationDate, requestsUsed: usageAfter },
    providerIdentityPersistedExplicitly: persistedIdentity.verified,
    rateLimitTelemetryPersistedSafely: persistedIdentity.verified ? "PASS" : "PARTIAL",
    errorCategory,
    rpmStatus: "UNKNOWN_FROM_API_HEADERS",
    tpdStatus: "UNKNOWN_FROM_API_HEADERS",
    accountOrProjectLimitScope: "UNKNOWN",
    cloudflareCalls: 0,
    cerebrasCalls: 0,
    productionRoutingEnabled: false,
    capacityProductionReady: false,
    secretsPersisted: false,
  };
  await writeArtifact(artifact);
  console.log(JSON.stringify({
    status: artifact.status,
    providerHttpStatus,
    providerCalls: fetchCalls,
    provider: "groq",
    model: MODEL,
    attempts: artifact.attempts,
    retries: artifact.retries,
    inputTokens: artifact.inputTokens,
    outputTokens: artifact.outputTokens,
    totalTokens: artifact.totalTokens,
    latencyMs: artifact.latencyMs,
    finishReason: artifact.finishReason,
    providerRateLimitHeaders: rateHeaders,
    normalizedProviderRateLimit: normalized,
    internalVsProviderRpd: artifact.internalVsProviderRpd,
    currentUsageBefore: { requestDateUtc: preflight.requestDateUtc, requestsUsed: preflight.requestsUsedBefore, requestsRemaining: preflight.requestsRemainingBefore },
    currentUsageAfter: artifact.currentUsageAfter,
    providerIdentityPersistedExplicitly: persistedIdentity.verified,
    errorCategory,
    artifact: "artifacts/groq-effective-capacity-probe-10g7a3.json",
  }, null, 2));

  if (providerHttpStatus !== 200 || telemetry?.status !== "SUCCESS" || fetchCalls !== 1 || artifact.attempts !== 1 || artifact.retries !== 0 || !persistedIdentity.verified) process.exitCode = 1;
}

await main();
