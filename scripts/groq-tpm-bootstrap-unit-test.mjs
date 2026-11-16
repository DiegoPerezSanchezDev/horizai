import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { localMinuteUsage } from "./fixtures/groq-tpm-bootstrap-model.mjs";
import { decideGroqFirstStageCapacity, decideGroqProviderHeaderAdmission } from "../lib/agents/runtime/groq-capacity-pacing.ts";
import { SupabaseAgentLogger, InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { OpenAICompatibleModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { attemptOutcomeFromPipelineResult } from "../lib/agents/pipeline/event-attempt-policy.ts";
import { SUPERVISED_PROVIDER_REQUEST_LIMIT, SUPERVISED_EVENT_ATTEMPT_LIMIT } from "../lib/agents/pipeline/supervised-throughput-policy.ts";
import { readGroqMaxConcurrentEvents } from "../lib/agents/runtime/groq-capacity-policy.ts";

globalThis.fetch = async () => { throw new Error("BOOTSTRAP_UNIT_NETWORK_FORBIDDEN"); };
const now = "2026-01-02T00:00:10.000Z";
const run = { id: "synthetic-run", provider: "groq", status: "running", startedAt: "2026-01-01T23:59:50.000Z", finishedAt: null, updatedAt: "2026-01-01T23:59:50.000Z" };
const reservation = { id: 1, runId: run.id, createdAt: "2026-01-01T23:59:55.000Z", providerUnit: "tokens", providerUnitAmount: 1000, payload: { providerRequestDispatched: true, dispatchedAt: "2026-01-01T23:59:56.000Z", tokenUsageState: "settled" } };
const usage = (rows = [], runs = [run], extra = {}) => localMinuteUsage({ rows, runs, now, ...extra });
assert.deepEqual(usage(), { status: "KNOWN_ZERO", tokens: 0, included: 0, excludedLegacy: 0, unknownReservations: 0 });
assert.equal(usage([reservation]).tokens, 1000, "rolling TPM crosses the UTC day boundary");
const boundary = { ...reservation, payload: { ...reservation.payload, dispatchedAt: "2026-01-01T23:59:10.000Z" } };
assert.equal(usage([boundary]).included, 1, "the SQL >= cutoff is inclusive");
assert.equal(usage([{ ...boundary, payload: { ...boundary.payload, dispatchedAt: "2026-01-01T23:59:09.999Z" } }]).status, "KNOWN_ZERO");
const hold = { ...reservation, createdAt: "2025-12-01T10:00:00Z", payload: { providerRequestDispatched: false, tokenUsageState: "reserved_estimate" } };
assert.equal(usage([hold]).tokens, 1000, "an unreleased explicit hold does not expire at a minute or day boundary");
const legacy = { ...reservation, createdAt: "2025-12-01T10:00:00Z", providerUnit: null, providerUnitAmount: null, payload: { requestDate: "2025-12-01" } };
const completed = { ...run, status: "succeeded", startedAt: legacy.createdAt, finishedAt: "2025-12-01T10:00:01Z", updatedAt: "2025-12-01T10:00:02Z" };
assert.deepEqual(usage([legacy], [completed]), { status: "KNOWN_ZERO", tokens: 0, included: 0, excludedLegacy: 1, unknownReservations: 0 });
assert.equal(usage([legacy], [{ ...completed, finishedAt: "2025-12-01T09:59:59.868Z" }]).status, "KNOWN_ZERO", "valid timestamps from different clocks use the latest activity bound");
assert.throws(() => usage([legacy], [{ ...completed, updatedAt: now }]), /GROQ_TPM_LOCAL_USAGE_UNKNOWN/, "a recently updated terminal run cannot age out yet");
for (const uncertain of [run, { ...completed, status: "running" }, { ...completed, finishedAt: "2026-01-02T00:00:05Z" }, { ...completed, finishedAt: null }]) {
  assert.throws(() => usage([legacy], [uncertain]), /GROQ_TPM_LOCAL_USAGE_UNKNOWN/);
}
assert.throws(() => usage([{ ...legacy, payload: { providerRequestDispatched: false } }], [completed]), /GROQ_TPM_LOCAL_USAGE_UNKNOWN/, "explicit malformed hold is not retired as legacy");
assert.throws(() => usage([], [], { readSucceeded: false }), /ACCOUNTING_QUERY_FAILURE/);
assert.throws(() => usage([], [], { complete: false }), /PARTIAL_ACCOUNTING_STATE/);
assert.throws(() => usage([reservation], []), /PARTIAL_ACCOUNTING_STATE/);
assert.throws(() => usage([{ ...reservation, providerUnitAmount: null }]), /GROQ_TPM_LOCAL_USAGE_UNKNOWN/);
assert.throws(() => usage([{ ...reservation, payload: null }]), /MALFORMED_ACCOUNTING_STATE/);
assert.throws(() => usage([{ ...reservation, payload: { providerRequestDispatched: "false" } }]), /MALFORMED_ACCOUNTING_STATE/);

const telemetry = (remaining) => ({ requestLimitDaily: null, requestRemainingDaily: null, requestReset: null, requestResetSeconds: null, tokenLimitMinute: 8000, tokenRemainingMinute: remaining, tokenReset: null, tokenResetSeconds: 30, retryAfterSeconds: null });
const header = (remaining, observedAt = now) => ({ observedAt, telemetry: telemetry(remaining) });
const admission = (local, snapshot = null, estimate = 2000) => {
  const first = decideGroqFirstStageCapacity({ estimatedStageTokenRequirement: estimate, tokenLimitTpm: 8000, providerSnapshot: snapshot, now: new Date(now) });
  if (first.decision === "INTRINSICALLY_TOO_LARGE") return "VERIFIER_INPUT_TOO_LARGE";
  if (first.decision === "DEFER_TEMPORARY_CAPACITY" || local.tokens + estimate + 128 > 8000) return "DEFERRED_PROVIDER_CAPACITY";
  return "ALLOW_LOCAL_RESERVATION";
};
assert.equal(admission(usage()), "ALLOW_LOCAL_RESERVATION", "fresh day/minute, empty successful read, no headers: no bootstrap deadlock");
assert.equal(admission(usage([reservation])), "ALLOW_LOCAL_RESERVATION");
assert.equal(admission(usage([{ ...reservation, providerUnitAmount: 7000 }])), "DEFERRED_PROVIDER_CAPACITY");
assert.equal(admission(usage(), header(100)), "DEFERRED_PROVIDER_CAPACITY");
assert.equal(admission(usage(), header(0, "2026-01-01T23:59:00Z")), "ALLOW_LOCAL_RESERVATION", "stale headers do not state current external capacity");
assert.equal(admission(usage(), null, 7900), "VERIFIER_INPUT_TOO_LARGE");

const editorEstimate = 4_448;
const editorRequired = editorEstimate + 128;
assert.equal(editorRequired, 4_576);
assert.deepEqual(decideGroqProviderHeaderAdmission({ estimatedStageTokenRequirement: editorEstimate, tokenLimitTpm: 8_000 }), {
  decision: "ALLOW_LOCAL_RESERVATION", externalState: "HEADER_ABSENT", requiredTokens: editorRequired,
});
assert.deepEqual(decideGroqProviderHeaderAdmission({
  estimatedStageTokenRequirement: editorEstimate, tokenLimitTpm: 8_000,
  providerSnapshot: { observedAt: now, telemetry: telemetry(null) }, now: new Date(now),
}), { decision: "ALLOW_LOCAL_RESERVATION", externalState: "EXTERNAL_REMAINING_UNKNOWN", requiredTokens: editorRequired });
assert.deepEqual(decideGroqProviderHeaderAdmission({
  estimatedStageTokenRequirement: editorEstimate, tokenLimitTpm: 8_000,
  providerSnapshot: header(0, "2026-01-01T23:59:00Z"), now: new Date(now),
}), { decision: "ALLOW_LOCAL_RESERVATION", externalState: "HEADER_STALE", requiredTokens: editorRequired });
assert.deepEqual(decideGroqProviderHeaderAdmission({
  estimatedStageTokenRequirement: editorEstimate, tokenLimitTpm: 8_000,
  providerSnapshot: header(editorRequired - 1), now: new Date(now),
}), { decision: "DEFER_TEMPORARY_CAPACITY", externalState: "EXTERNAL_REMAINING_KNOWN_INSUFFICIENT", requiredTokens: editorRequired, remainingTokens: editorRequired - 1 });
assert.deepEqual(decideGroqProviderHeaderAdmission({
  estimatedStageTokenRequirement: editorEstimate, tokenLimitTpm: 8_000,
  providerSnapshot: header(editorRequired), now: new Date(now),
}), { decision: "ALLOW_LOCAL_RESERVATION", externalState: "EXTERNAL_REMAINING_KNOWN_SUFFICIENT", requiredTokens: editorRequired });
const historicalEditorLocal = usage([], [], { now: "2026-10-16T09:42:59.942Z" });
assert.equal(historicalEditorLocal.status, "KNOWN_ZERO");
assert.equal(decideGroqProviderHeaderAdmission({ estimatedStageTokenRequirement: editorEstimate, tokenLimitTpm: 8_000 }).decision, "ALLOW_LOCAL_RESERVATION",
  "the 12F.10C shape (complete known-zero local minute, 4448 estimate plus 128 margin, no fresh header) reaches the atomic reservation path");

const metadata = { agentName: "verifier", agentVersion: "synthetic-bootstrap-v1", eventKey: "synthetic-bootstrap", provider: "groq", model: "openai/gpt-oss-20b", dryRun: true };
const limits = { requestHardLimit: 1000, requestSoftLimit: 850, tokenHardLimit: 200000, tokenSoftLimit: 170000, tokenMinuteHardLimit: 8000 };
const response = { allowed: true, admitted: true, reason: null, dailyCount: 1, dailyLimit: 1000, requestDate: "2026-01-02", quotaPeriodUtc: "2026-01-02", reservationId: 1, requestUsageBefore: 0, requestUsageAfter: 1, tokenUsageBefore: 0, tokenUsageAfter: 2000, reservedTokens: 2000, requestHardLimit: 1000, requestSoftLimit: 850, tokenHardLimit: 200000, tokenSoftLimit: 170000, minuteTokenUsageBefore: 0, minuteTokenUsageAfter: 2000, minuteTokenHardLimit: 8000, safetyMarginTokens: 128 };
const rpcLogger = (data, error = null) => new SupabaseAgentLogger({ rpc: async (name) => { assert.equal(name, "reserve_groq_request_and_tokens_m35"); return { data, error }; } });
assert.equal((await rpcLogger(response).reserveGroqCapacity("synthetic", metadata, 1, "2026-01-02", limits, 2000)).allowed, true);
await assert.rejects(() => rpcLogger(null, { code: "SYNTHETIC_DB_FAILURE" }).reserveGroqCapacity("synthetic", metadata, 1, "2026-01-02", limits, 2000), /Unable to reserve atomic/);
await assert.rejects(() => rpcLogger({ ...response, minuteTokenUsageBefore: null }).reserveGroqCapacity("synthetic", metadata, 1, "2026-01-02", limits, 2000));
await assert.rejects(() => rpcLogger({ allowed: true }).reserveGroqCapacity("synthetic", metadata, 1, "2026-01-02", limits, 2000));

const config = { model: metadata.model, timeoutMs: 1000, maxRetries: 0, retryBackoffMs: 0, maxOutputTokens: 64, dailyRequestLimit: 1000, failOnRateLimit: true, allowPaidFallback: false, allowProviderPacingWait: false, structuredOutputMode: "json_object", groqCapacity: limits };
const schema = z.object({ ok: z.literal(true) }).strict();
let syntheticDispatches = 0;
const provider = { providerId: "groq", async generateStructured(request) { syntheticDispatches += 1; await request.onRequestDispatched(); return { output: { ok: true }, model: metadata.model, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }; } };
const logger = new InMemoryAgentLogger();
await runStructuredAgent({ agentName: "verifier", agentVersion: metadata.agentVersion, eventKey: metadata.eventKey, input: { synthetic: true }, systemInstructions: "Return the synthetic fixture.", schemaName: "BootstrapFixture", schema, modelConfig: config, provider, logger, dryRun: true, requestBudget: new ProviderScopedDailyRequestBudget() });
assert.equal(syntheticDispatches, 1);
const daily = await logger.getProviderDailyUsage("groq", new Date().toISOString().slice(0, 10));
assert.equal(daily.requestsDispatched, 1);
assert.equal(daily.unknownTokenRequests, 0);

let synthetic429Requests = 0;
const rateLimited = new OpenAICompatibleModelProvider(freeProviderPolicy.groq.endpoint, "SYNTHETIC_OFFLINE_BOOTSTRAP", {
  providerId: "groq", enforceFreeOnly: true, configuredModel: metadata.model,
  fetchImpl: async () => { synthetic429Requests += 1; return new Response(JSON.stringify({ error: { message: "Synthetic tokens per minute rate limit", type: "rate_limit_error" } }), { status: 429, headers: { "x-ratelimit-remaining-tokens": "0", "x-ratelimit-reset-tokens": "2s", "retry-after": "2" } }); },
});
const rateLogger = new InMemoryAgentLogger();
let failure;
try { await runStructuredAgent({ agentName: "verifier", agentVersion: metadata.agentVersion, eventKey: metadata.eventKey, input: { synthetic: true }, systemInstructions: "Synthetic 429 fixture.", schemaName: "BootstrapFixture", schema, modelConfig: config, provider: rateLimited, logger: rateLogger, dryRun: true, requestBudget: new ProviderScopedDailyRequestBudget() }); } catch (error) { failure = getAgentFailureDetails(error); }
assert.equal(synthetic429Requests, 1);
assert.equal(failure.telemetry.providerRequestDispatched, true);
assert.equal(failure.providerRequestsUsed, 1);
assert.equal(failure.telemetry.retries, 0);
assert.equal(failure.telemetry.providerHttpStatus, 429);
assert.equal(failure.telemetry.totalTokens, null, "429 without usage does not invent actual tokens");
const reserved = rateLogger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
assert.equal(rateLogger.getGroqTokenReservationSnapshot(reserved.entry.payload.requestDate, reserved.entry.payload.reservationId).tokenUsageState, "reserved_estimate");
assert.equal(attemptOutcomeFromPipelineResult({ finalState: "FAILED", stopStage: "verifier", stopReason: "FREE_TIER_LIMIT_REACHED", failure }, new Date()).finalState, "PROVIDER_RATE_LIMIT");
assert.equal(SUPERVISED_PROVIDER_REQUEST_LIMIT, 36);
assert.equal(SUPERVISED_EVENT_ATTEMPT_LIMIT, 5);
assert.equal(readGroqMaxConcurrentEvents({}), 1);
assert.equal(config.maxRetries, 0);
assert.equal(config.allowPaidFallback, false);

const proposed = readFileSync("scripts/migration36-groq-tpm-window.proposed.sql", "utf8");
const original = readFileSync("supabase/migrations/20261014120000_verifier_first_stage_capacity_resume.sql", "utf8");
assert.equal((proposed.match(/and not coalesce\(\(/g) ?? []).length, 2, "sum and unknown-count queries use the same retirement predicate");
for (const constraint of ["r.status in ('succeeded', 'failed')", "greatest(r.started_at, r.finished_at, r.updated_at, l.created_at) <= v_window_start", "r.provider = 'groq'", "l.payload ?| array['providerRequestDispatched', 'dispatchedAt', 'estimatedTokens', 'tokenUsageState']"]) assert.equal(proposed.split(constraint).length - 1, 2);
assert.match(proposed, /v_window_start timestamptz := now\(\) - interval '60 seconds'/);
assert.match(proposed, /perform pg_advisory_xact_lock/);
assert.match(proposed, /public\.reserve_groq_request_and_tokens\(/);
assert.match(proposed, /auth\.role\(\) is distinct from 'service_role'/);
assert.doesNotMatch(proposed, /grant\s|alter table|delete from|update public\./i);
assert.doesNotMatch(original, /r\.finished_at <= v_window_start/, "M35 source is immutable; fix is a separate proposal");
console.log(JSON.stringify({ status: "PASS", emptyWindow: "KNOWN_ZERO", legacyTerminalRowsExpireWithoutRewriting: true, activeHoldsPreserved: true, queryFailureMalformedPartial: "TECHNICAL_FAILURE", externalCapacityUnknown: true, bootstrap: "PASS", synthetic429: "DISPATCHED_RATE_LIMIT; ESTIMATE_RETAINED; NO_M35_RESUME", requestCap: 36, concurrency: 1, retries: 0, fallback: 0, actualProviderCalls: 0, remoteWrites: 0, sqlExecution: "NOT_RUN_LOCAL_POSTGRES_UNAVAILABLE" }));
