process.env.GROQ_TPM_PACING_MAX_WAIT_MS = "0"; // asserts the no-wait deferral contract; the pacing wait is exercised live
import assert from "node:assert/strict";
import { z } from "zod";
import { AgentTimeoutError, FreeTierLimitReachedError, getAgentFailureDetails, StructuredOutputError } from "../lib/agents/runtime/agent-errors.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { maxGroqModelInputCharsForTpm } from "../lib/agents/runtime/groq-capacity-pacing.ts";

const verifierInputChars = maxGroqModelInputCharsForTpm({ systemInstructionChars: 3_064, schemaChars: 1_228, maxOutputTokens: 1_200, tokenLimitTpm: 8_000 });
assert.equal(verifierInputChars, 8_796, "full JSON input is bounded after output, estimator overhead, and TPM safety margin are reserved");

const day = "2026-09-25";
const metadata = (runId = "") => ({ agentName: "verifier", agentVersion: "verifier-v1", eventKey: `event-${runId}`, model: "openai/gpt-oss-20b", provider: "groq", dryRun: true });
const limits = (overrides = {}) => ({ requestHardLimit: 100, requestSoftLimit: 100, tokenHardLimit: 200_000, tokenSoftLimit: 170_000, tokenMinuteHardLimit: 1_000_000, ...overrides });
async function newRun(logger, runMeta = metadata("run")) { return logger.startRun(runMeta, `${day}T12:00:00.000Z`); }
async function reserve(logger, id, estimate, capacity = limits(), requestDate = day) {
  const runMeta = logger.runs.find((run) => run.id === id)?.metadata ?? metadata(id);
  return logger.reserveGroqCapacity(id, runMeta, 1, requestDate, capacity, estimate);
}

// ALL OR NOTHING: request rejection and token rejection never leave half rows.
{
  const logger = new InMemoryAgentLogger();
  const id = await newRun(logger);
  const denied = await reserve(logger, id, 10, limits({ requestHardLimit: 1, requestSoftLimit: 1, tokenHardLimit: 9, tokenSoftLimit: 9 }));
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "GROQ_DAILY_TOKEN_HARD_LIMIT");
  assert.equal(denied.requestUsageAfter, denied.requestUsageBefore);
  assert.equal(denied.tokenUsageAfter, denied.tokenUsageBefore);
  assert.equal(denied.reservationId, undefined);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).requestsReserved, 0);

  const admitted = await reserve(logger, id, 9, limits({ requestHardLimit: 1, requestSoftLimit: 1, tokenHardLimit: 9, tokenSoftLimit: 9 }));
  assert.equal(admitted.allowed, true);
  const requestDenied = await reserve(logger, id, 1, limits({ requestHardLimit: 1, requestSoftLimit: 1, tokenHardLimit: 20, tokenSoftLimit: 20 }));
  assert.equal(requestDenied.reason, "GROQ_DAILY_REQUEST_HARD_LIMIT");
  assert.equal(requestDenied.requestUsageAfter, requestDenied.requestUsageBefore);
  assert.equal(requestDenied.tokenUsageAfter, requestDenied.tokenUsageBefore);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).totalTokens, 9);
}

// Concurrent workers serialize in the in-memory executable model; SQL's
// corresponding advisory-lock proof is static-only in this environment.
{
  const logger = new InMemoryAgentLogger();
  const workers = await Promise.all(Array.from({ length: 20 }, (_, index) => newRun(logger, metadata(`soft-seed-${index}`))));
  for (const id of workers) assert.equal((await reserve(logger, id, 8_000, limits())).allowed, true);
  const contenders = await Promise.all(["soft-a", "soft-b"].map(async (key) => {
    const id = await newRun(logger, metadata(key));
    return reserve(logger, id, 8_000, limits());
  }));
  assert.equal(contenders.filter((result) => result.allowed).length, 1);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).totalTokens, 168_000);
}
{
  const logger = new InMemoryAgentLogger();
  const workers = await Promise.all(Array.from({ length: 24 }, (_, index) => newRun(logger, metadata(`hard-seed-${index}`))));
  for (const id of workers) assert.equal((await reserve(logger, id, 8_000, limits({ tokenSoftLimit: 200_000 }))).allowed, true);
  const contenders = await Promise.all(["hard-a", "hard-b"].map(async (key) => {
    const id = await newRun(logger, metadata(key));
    return reserve(logger, id, 8_000, limits({ tokenSoftLimit: 200_000 }));
  }));
  assert.equal(contenders.filter((result) => result.allowed).length, 1);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).totalTokens, 200_000);
}

// Settlement lower/equal/greater, idempotency and conflict fail-closed.
for (const scenario of [
  { name: "lower", input: 1_250, output: 750, expected: 2_000, delta: -2_000 },
  { name: "equal", input: 2_500, output: 1_500, expected: 4_000, delta: 0 },
  { name: "greater", input: 3_000, output: 2_000, expected: 5_000, delta: 1_000 },
]) {
  const logger = new InMemoryAgentLogger();
  const id = await newRun(logger, metadata(scenario.name));
  const reservation = await reserve(logger, id, 4_000, limits({ tokenHardLimit: 4_000, tokenSoftLimit: 4_000 }));
  assert.equal(reservation.allowed, true);
  assert.equal(await logger.markRequestDispatched(id, reservation.reservationId, day), true);
  const settlement = await logger.settleGroqTokenUsage(id, reservation.reservationId, day, scenario.input, scenario.output);
  assert.equal(settlement.accountedTokens, scenario.expected);
  assert.equal(settlement.deltaTokens, scenario.delta);
  const duplicate = await logger.settleGroqTokenUsage(id, reservation.reservationId, day, scenario.input, scenario.output);
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.accountedTokens, scenario.expected);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).totalTokens, scenario.expected);
  await assert.rejects(() => logger.settleGroqTokenUsage(id, reservation.reservationId, day, scenario.input + 1, scenario.output), /provider_token_settlement_conflict/);
  assert.deepEqual(logger.getGroqTokenReservationSnapshot(day, reservation.reservationId), {
    runId: id, dispatched: true, accountedTokens: scenario.expected, tokenUsageState: "settled",
  });
  if (scenario.expected > 4_000) {
    const nextId = await newRun(logger, metadata(`${scenario.name}-followup`));
    assert.equal((await reserve(logger, nextId, 1, limits({ tokenHardLimit: 4_000, tokenSoftLimit: 4_000 }))).reason, "GROQ_DAILY_TOKEN_HARD_LIMIT");
  }
}

// Pre-dispatch release frees both dimensions; it cannot win after dispatch.
{
  const releaseWins = new InMemoryAgentLogger();
  const id = await newRun(releaseWins, metadata("release-wins"));
  const reservation = await reserve(releaseWins, id, 2_000);
  assert.equal(await releaseWins.releaseGroqCapacityPreDispatch(id, reservation.reservationId, day), true);
  assert.equal(await releaseWins.markRequestDispatched(id, reservation.reservationId, day), false);
  assert.equal(releaseWins.getGroqTokenReservationSnapshot(day, reservation.reservationId), null);
  assert.equal((await releaseWins.getProviderDailyUsage("groq", day)).requestsReserved, 0);
  assert.equal((await releaseWins.getProviderDailyUsage("groq", day)).totalTokens, 0);

  const dispatchWins = new InMemoryAgentLogger();
  const owner = await newRun(dispatchWins, metadata("dispatch-wins"));
  const dispatchedReservation = await reserve(dispatchWins, owner, 2_000);
  assert.equal(await dispatchWins.markRequestDispatched(owner, dispatchedReservation.reservationId, day), true);
  assert.equal(await dispatchWins.releaseGroqCapacityPreDispatch("another-worker", dispatchedReservation.reservationId, day), false);
  assert.equal(await dispatchWins.releaseGroqCapacityPreDispatch(owner, dispatchedReservation.reservationId, day), false);
  assert.deepEqual(dispatchWins.getGroqTokenReservationSnapshot(day, dispatchedReservation.reservationId), {
    runId: owner, dispatched: true, accountedTokens: 2_000, tokenUsageState: "reserved_estimate",
  });
}

// A projected amount equal to either soft boundary is admitted; the next
// reservation crossing it is rejected without changing either counter.
{
  const logger = new InMemoryAgentLogger();
  const firstId = await newRun(logger, metadata("soft-boundary-first"));
  const capacity = limits({ requestHardLimit: 5, requestSoftLimit: 1, tokenHardLimit: 20, tokenSoftLimit: 10 });
  const first = await reserve(logger, firstId, 10, capacity);
  assert.equal(first.allowed, true);
  const secondId = await newRun(logger, metadata("soft-boundary-second"));
  const second = await reserve(logger, secondId, 1, capacity);
  assert.equal(second.reason, "GROQ_DAILY_REQUEST_SOFT_LIMIT");
  assert.equal(second.requestUsageAfter, 1);
  assert.equal(second.tokenUsageAfter, 10);

  const tokenLogger = new InMemoryAgentLogger();
  const tokenCapacity = limits({ requestHardLimit: 5, requestSoftLimit: 5, tokenHardLimit: 20, tokenSoftLimit: 10 });
  const tokenFirstId = await newRun(tokenLogger, metadata("token-soft-first"));
  assert.equal((await reserve(tokenLogger, tokenFirstId, 10, tokenCapacity)).allowed, true);
  const tokenSecondId = await newRun(tokenLogger, metadata("token-soft-second"));
  const tokenSecond = await reserve(tokenLogger, tokenSecondId, 1, tokenCapacity);
  assert.equal(tokenSecond.reason, "GROQ_DAILY_TOKEN_SOFT_LIMIT");
  assert.equal(tokenSecond.requestUsageAfter, 1);
  assert.equal(tokenSecond.tokenUsageAfter, 10);
}

// Unknown post-dispatch usage retains the estimate; a settlement after UTC
// midnight remains attached to its original day, not the new day's quota.
{
  const logger = new InMemoryAgentLogger();
  const id = await newRun(logger, metadata("unknown"));
  const reservation = await reserve(logger, id, 3_200);
  await logger.markRequestDispatched(id, reservation.reservationId, day);
  assert.deepEqual(logger.getGroqTokenReservationSnapshot(day, reservation.reservationId), {
    runId: id, dispatched: true, accountedTokens: 3_200, tokenUsageState: "reserved_estimate",
  });
  await logger.settleGroqTokenUsage(id, reservation.reservationId, day, 1_200, 800);
  const nextDay = "2026-09-26";
  const nextRun = await newRun(logger, metadata("next-day"));
  const nextReservation = await reserve(logger, nextRun, 1_000, limits(), nextDay);
  assert.equal(nextReservation.tokenUsageBefore, 0);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).totalTokens, 2_000);
  assert.equal((await logger.getProviderDailyUsage("groq", nextDay)).totalTokens, 1_000);
}

// A legacy request-only Groq row cannot be assumed to have used zero tokens.
{
  const logger = new InMemoryAgentLogger();
  const legacyId = await newRun(logger, metadata("legacy"));
  await logger.reserveProviderRequest(legacyId, metadata("legacy"), 1, 20, day, "groq");
  const nextId = await newRun(logger, metadata("after-legacy"));
  const result = await reserve(logger, nextId, 100);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "GROQ_DAILY_TOKEN_USAGE_UNKNOWN");
}

// Runtime path settles usage before Zod parsing; pre-dispatch failure releases,
// and post-dispatch 429 retains the estimate. Providers below are local fakes.
const runtimeConfig = {
  model: "openai/gpt-oss-20b", timeoutMs: 1_000, maxRetries: 0, retryBackoffMs: 0,
  maxOutputTokens: 64, dailyRequestLimit: 20, failOnRateLimit: true, allowPaidFallback: false,
  structuredOutputMode: "json_object", groqCapacity: limits({ requestHardLimit: 20, requestSoftLimit: 20, tokenMinuteHardLimit: 8_000, requestMinuteHardLimit: 30 }),
};
const runtimeSchema = z.object({ ok: z.literal(true) }).strict();
function fakeProvider(generateStructured) { return { providerId: "groq", generateStructured }; }
const runOptions = (logger, provider, budget) => ({
  agentName: "runtime-test", agentVersion: "fixture-v1", eventKey: "runtime-event", input: { test: true },
  systemInstructions: "Return the requested object.", schemaName: "RuntimeFixture", schema: runtimeSchema,
  modelConfig: runtimeConfig, provider, logger, dryRun: true, requestBudget: budget,
});
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  const provider = fakeProvider(async (request) => {
    await request.onRequestDispatched();
    return { output: { ok: false }, model: runtimeConfig.model, provider: "groq", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, diagnostics: { provider: "groq", httpStatus: 200 } };
  });
  await assert.rejects(() => runStructuredAgent(runOptions(logger, provider, budget)), StructuredOutputError);
  const reserved = logger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
  assert.equal(logger.getGroqTokenReservationSnapshot(day, reserved.entry.payload.reservationId).accountedTokens, 4,
    "schema-invalid HTTP 200 usage is still settled before parsing");
}
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  const provider = fakeProvider(async (request) => {
    await request.onRequestDispatched();
    return { output: { ok: true }, model: runtimeConfig.model, provider: "groq", usage: { inputTokens: 31, outputTokens: 9, totalTokens: 40 }, diagnostics: { provider: "groq", httpStatus: 200 } };
  });
  const result = await runStructuredAgent(runOptions(logger, provider, budget));
  const reserved = logger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
  const settled = logger.entries.find((entry) => entry.entry.step === "groq_token_settlement");
  assert.ok(reserved && settled);
  assert.ok(reserved.entry.payload.estimatedTokens > 40, "the runtime reserves the conservative stage estimate before dispatch");
  const snapshot = logger.getGroqTokenReservationSnapshot(day, reserved.entry.payload.reservationId);
  assert.deepEqual(snapshot, { runId: result.runId, dispatched: true, accountedTokens: 40, tokenUsageState: "settled" });
  assert.equal(result.telemetry.inputTokens, 31);
  assert.equal(result.telemetry.outputTokens, 9);
  assert.equal(result.telemetry.totalTokens, 40);
  const capacity = await logger.getProviderDailyUsage("groq", day);
  assert.equal(capacity.requestsReserved, 1);
  assert.equal(capacity.requestsDispatched, 1);
  assert.equal(capacity.totalTokens, 40, "the canonical ledger reflects actual settled usage, not the estimate");
}
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  const provider = fakeProvider(async () => { throw new Error("local failure before dispatch marker"); });
  await assert.rejects(() => runStructuredAgent(runOptions(logger, provider, budget)));
  const reserved = logger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
  assert.equal(logger.getGroqTokenReservationSnapshot(day, reserved.entry.payload.reservationId), null,
    "no HTTP dispatch marker means the paired reservation was released");
  assert.equal((await logger.getProviderDailyUsage("groq", day)).requestsReserved, 0);
}
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  const provider = fakeProvider(async (request) => {
    await request.onRequestDispatched();
    throw new FreeTierLimitReachedError({ provider: "groq", httpStatus: 429, providerRequestDispatched: true });
  });
  await assert.rejects(() => runStructuredAgent(runOptions(logger, provider, budget)), FreeTierLimitReachedError);
  const reserved = logger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
  assert.equal(logger.getGroqTokenReservationSnapshot(day, reserved.entry.payload.reservationId).accountedTokens, reserved.entry.payload.estimatedTokens);
  assert.equal(logger.getGroqTokenReservationSnapshot(day, reserved.entry.payload.reservationId).dispatched, true);
  const usage = await logger.getProviderDailyUsage("groq", day);
  assert.equal(usage.requestsReserved, 1);
  assert.equal(usage.requestsDispatched, 1);
  assert.equal(usage.totalTokens, reserved.entry.payload.estimatedTokens, "unknown post-dispatch usage retains the conservative estimate");
}

// Freshness applies to every stage; a header whose token window already reset cannot block the next stage.
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  const headers = {
    retryAfter: null, limitRequests: "30", remainingRequests: "28", resetRequests: "60s",
    limitTokens: "8000", remainingTokens: "100", resetTokens: "0s",
    retryAfterSeconds: null, resetRequestsSeconds: 60, resetTokensSeconds: 0,
  };
  const firstProvider = fakeProvider(async (request) => {
    await request.onRequestDispatched();
    return { output: { ok: true }, model: runtimeConfig.model, provider: "groq", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, diagnostics: { provider: "groq", httpStatus: 200, rateLimitHeaders: headers } };
  });
  await runStructuredAgent({ ...runOptions(logger, firstProvider, budget), agentName: "verifier", eventKey: "paced-event" });
  const latest = await logger.getLatestProviderRateLimitTelemetry("groq", "paced-event");
  assert.equal(latest.tokenRemainingMinute, 100);
  assert.equal(latest.tokenResetSeconds, 0);

  let dispatchedAt = 0;
  const nextProvider = fakeProvider(async (request) => {
    dispatchedAt = Date.now();
    await request.onRequestDispatched();
    return { output: { ok: true }, model: runtimeConfig.model, provider: "groq", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, diagnostics: { provider: "groq", httpStatus: 200 } };
  });
  await runStructuredAgent({ ...runOptions(logger, nextProvider, budget), agentName: "translator", eventKey: "paced-event" });
  assert.ok(dispatchedAt > 0, "stale reset headers do not block the next stage");
  assert.ok(logger.entries.some((entry) => entry.entry.step === "groq_tpm_pacing_decision" && entry.entry.payload.externalState === "HEADER_STALE"));
}

// A fresh provider header that proves local request headroom insufficient defers identically across modes.
{
  const logger = new InMemoryAgentLogger();
  logger.getLatestProviderRateLimitSnapshot = async () => ({
    observedAt: new Date().toISOString(),
    telemetry: { requestLimitDaily: null, requestRemainingDaily: null, requestReset: null, requestResetSeconds: null, tokenLimitMinute: 8_000, tokenRemainingMinute: 0, tokenReset: null, tokenResetSeconds: 1, retryAfterSeconds: null },
  });
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  let providerCalls = 0;
  const provider = fakeProvider(async () => { providerCalls += 1; throw new Error("fresh-header shortage must stop before dispatch"); });
  let capacityError;
  await assert.rejects(() => runStructuredAgent({
    ...runOptions(logger, provider, budget),
    agentName: "editor",
    eventKey: "supervised-no-wait",
    modelConfig: { ...runtimeConfig, allowProviderPacingWait: false },
  }), (error) => {
    capacityError = error;
    return error.code === "PROVIDER_CAPACITY_EXHAUSTED";
  });
  assert.equal(providerCalls, 0);
  assert.equal(getAgentFailureDetails(capacityError).telemetry.status, "PROVIDER_CAPACITY_EXHAUSTED");
  assert.equal(getAgentFailureDetails(capacityError).telemetry.providerRequestDispatched, false);
  assert.equal(getAgentFailureDetails(capacityError).telemetry.providerRequestsUsed, 0);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).requestsReserved, 0);
  assert.ok(logger.entries.some((entry) => entry.entry.step === "groq_tpm_pacing_decision" && entry.entry.payload.reason === "GROQ_TPM_FRESH_HEADER_CAPACITY_EXHAUSTED"));
}

// A long provider reset and the normal wait preference do not change admission; both modes defer.
{
  const logger = new InMemoryAgentLogger();
  logger.getLatestProviderRateLimitSnapshot = async () => ({
    observedAt: new Date().toISOString(),
    telemetry: { requestLimitDaily: null, requestRemainingDaily: null, requestReset: null, requestResetSeconds: null, tokenLimitMinute: 8_000, tokenRemainingMinute: 0, tokenReset: null, tokenResetSeconds: 60, retryAfterSeconds: null },
  });
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  let providerCalls = 0;
  const provider = fakeProvider(async () => { providerCalls += 1; throw new Error("fresh-header shortage must not dispatch"); });
  let capacityError;
  await assert.rejects(() => runStructuredAgent({
    ...runOptions(logger, provider, budget),
    agentName: "editor",
    eventKey: "supervised-over-bound-wait",
    modelConfig: { ...runtimeConfig, allowProviderPacingWait: true },
  }), (error) => {
    capacityError = error;
    return error.code === "PROVIDER_CAPACITY_EXHAUSTED";
  });
  assert.equal(providerCalls, 0);
  assert.equal(getAgentFailureDetails(capacityError).telemetry.providerRequestDispatched, false);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).requestsReserved, 0);
  assert.ok(logger.entries.some((entry) => entry.entry.step === "groq_tpm_pacing_decision" && entry.entry.payload.reason === "GROQ_TPM_FRESH_HEADER_CAPACITY_EXHAUSTED"));
}

// A later stage allows dispatch when local accounting passes and external TPM remains unknown.
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  let providerCalls = 0;
  const provider = fakeProvider(async (request) => {
    providerCalls += 1;
    await request.onRequestDispatched();
    return { output: { ok: true }, model: runtimeConfig.model, provider: "groq", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } };
  });
  const result = await runStructuredAgent({ ...runOptions(logger, provider, budget), agentName: "translator", eventKey: "headers-missing" });
  assert.deepEqual(result.output, { ok: true });
  assert.equal(providerCalls, 1);
  assert.equal(result.telemetry.providerRequestsUsed, 1);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).requestsDispatched, 1);
  assert.ok(logger.entries.some((entry) => entry.entry.step === "groq_tpm_pacing_decision" && entry.entry.payload.externalState === "HEADER_ABSENT"));
}
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  const provider = fakeProvider(async (request) => {
    await request.onRequestDispatched();
    throw new AgentTimeoutError(10);
  });
  await assert.rejects(() => runStructuredAgent(runOptions(logger, provider, budget)), AgentTimeoutError);
  const reserved = logger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
  assert.equal(logger.getGroqTokenReservationSnapshot(day, reserved.entry.payload.reservationId).accountedTokens, reserved.entry.payload.estimatedTokens);
}

// Exhausted atomic token capacity blocks the event before provider invocation.
{
  const logger = new InMemoryAgentLogger();
  let providerCalls = 0;
  const provider = fakeProvider(async () => { providerCalls += 1; return { output: { ok: true }, model: runtimeConfig.model, provider: "groq" }; });
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  await assert.rejects(() => runStructuredAgent({
    ...runOptions(logger, provider, budget),
    modelConfig: { ...runtimeConfig, groqCapacity: limits({ requestHardLimit: 20, requestSoftLimit: 20, tokenHardLimit: 1, tokenSoftLimit: 1 }) },
  }), { code: "PROVIDER_CAPACITY_EXHAUSTED" });
  assert.equal(providerCalls, 0);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).requestsReserved, 0);
}

// A settlement conflict fails the model run closed and does not release a dispatched estimate.
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${day}T12:00:00Z`));
  logger.settleGroqTokenUsage = async () => { throw new Error("provider_token_settlement_conflict"); };
  const provider = fakeProvider(async (request) => {
    await request.onRequestDispatched();
    return { output: { ok: true }, model: runtimeConfig.model, provider: "groq", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, diagnostics: { provider: "groq", httpStatus: 200 } };
  });
  await assert.rejects(() => runStructuredAgent(runOptions(logger, provider, budget)), { code: "cost_guard_violation" });
  const reserved = logger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
  const snapshot = logger.getGroqTokenReservationSnapshot(day, reserved.entry.payload.reservationId);
  assert.equal(snapshot.dispatched, true);
  assert.equal(snapshot.tokenUsageState, "reserved_estimate");
}

// Groq tokens never affect the Cloudflare Neuron ledger, and vice versa.
{
  const logger = new InMemoryAgentLogger();
  const cfMetadata = { ...metadata("cf-run"), provider: "cloudflare_workers_ai", model: "@cf/openai/gpt-oss-20b" };
  const cfRun = await newRun(logger, cfMetadata);
  const cfCapacity = { provider: "cloudflare_workers_ai", requestLimit: 5, hardNeuronLimit: 1_000, neuronLimit: 900, estimatedNeurons: 100 };
  assert.equal((await logger.reserveRequest(cfRun, cfMetadata, 1, 5, day, cfCapacity)).allowed, true);
  const groqRun = await newRun(logger, metadata("isolation"));
  assert.equal((await reserve(logger, groqRun, 50)).allowed, true);
  assert.equal((await logger.getProviderDailyUsage("cloudflare_workers_ai", day)).neuronsUsed, 100);
  assert.equal((await logger.getProviderDailyUsage("groq", day)).totalTokens, 50);
}

// Missing explicit policy prevents reaching the provider: no legacy request-
// only fallback can silently bypass the atomic token guard.
{
  const logger = new InMemoryAgentLogger();
  const provider = fakeProvider(async () => { throw new Error("must not be called"); });
  await assert.rejects(() => runStructuredAgent({ ...runOptions(logger, provider, new ProviderScopedDailyRequestBudget()), modelConfig: { ...runtimeConfig, groqCapacity: undefined } }), {
    code: "cost_guard_violation",
  });
  assert.equal(logger.runs.length, 0);
}

console.log("Groq atomic token budget runtime/model checks passed (offline; provider and Supabase calls: 0)");
