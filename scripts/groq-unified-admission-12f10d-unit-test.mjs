process.env.GROQ_TPM_PACING_MAX_WAIT_MS = "0"; // this suite asserts raw local admission; the pacing wait is covered separately
import assert from "node:assert/strict";
import { z } from "zod";
import { AgentError } from "../lib/agents/runtime/agent-errors.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { readGroqMaxConcurrentEvents } from "../lib/agents/runtime/groq-capacity-policy.ts";
import { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { SUPERVISED_PROVIDER_REQUEST_LIMIT } from "../lib/agents/pipeline/supervised-throughput-policy.ts";

const today = new Date().toISOString().slice(0, 10);
const model = "openai/gpt-oss-20b";
const schema = z.object({ ok: z.literal(true) }).strict();
const baseLimits = {
  requestHardLimit: 18,
  requestSoftLimit: 15,
  tokenHardLimit: 200_000,
  tokenSoftLimit: 170_000,
  tokenMinuteHardLimit: 8_000,
  requestMinuteHardLimit: 30,
};
let seedCounter = 0;
const configFor = (overrides = {}) => ({
  model,
  timeoutMs: 1_000,
  maxRetries: 0,
  retryBackoffMs: 0,
  maxOutputTokens: 64,
  dailyRequestLimit: 18,
  failOnRateLimit: true,
  allowPaidFallback: false,
  allowProviderPacingWait: false,
  structuredOutputMode: "json_object",
  groqCapacity: { ...baseLimits, ...(overrides.groqCapacity ?? {}) },
  ...overrides,
});
const freshSnapshot = (remaining, observedAt = new Date().toISOString()) => ({
  observedAt,
  telemetry: {
    requestLimitDaily: null,
    requestRemainingDaily: null,
    requestReset: null,
    requestResetSeconds: null,
    tokenLimitMinute: 8_000,
    tokenRemainingMinute: remaining,
    tokenReset: null,
    tokenResetSeconds: remaining === null ? null : 30,
    retryAfterSeconds: null,
  },
});

async function seedUsage(logger, estimate, limits = baseLimits) {
  const metadata = {
    agentName: "synthetic-seed",
    agentVersion: "12f10d-fixture-v1",
    eventKey: `synthetic-seed-${estimate}-${seedCounter++}`,
    model,
    provider: "groq",
    dryRun: true,
  };
  const runId = await logger.startRun(metadata, new Date().toISOString());
  const reservation = await logger.reserveGroqCapacity(runId, metadata, 1, today, limits, estimate);
  assert.equal(reservation.allowed, true, "seed reservation must fit by itself");
  assert.equal(await logger.markRequestDispatched(runId, reservation.reservationId, today), true);
  assert.equal((await logger.settleGroqTokenUsage(runId, reservation.reservationId, today, estimate - 1, 1)).settled, true);
}

async function execute({ stage, snapshot = null, limits = baseLimits, seedTokens = null, accountingFailure = null, headerReadFailure = false }) {
  const logger = new InMemoryAgentLogger();
  if (seedTokens !== null) await seedUsage(logger, seedTokens, limits);
  logger.getLatestProviderRateLimitSnapshot = async () => snapshot;
  if (headerReadFailure) logger.getLatestProviderRateLimitSnapshot = async () => { throw new Error("synthetic provider-header read failure"); };
  if (accountingFailure === "query") logger.reserveGroqCapacity = async () => { throw new Error("synthetic durable accounting query failure"); };
  if (accountingFailure === "malformed") logger.reserveGroqCapacity = async () => ({ allowed: false, reason: "GROQ_TPM_LOCAL_USAGE_UNKNOWN" });
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${today}T12:00:00.000Z`));
  let dispatches = 0;
  const provider = {
    providerId: "groq",
    async generateStructured(request) {
      dispatches += 1;
      await request.onRequestDispatched();
      return { output: { ok: true }, model, provider: "groq", usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } };
    },
  };
  try {
    await runStructuredAgent({
      agentName: stage,
      agentVersion: "12f10d-fixture-v1",
      eventKey: `synthetic-${stage}`,
      input: { fixture: true },
      systemInstructions: "Return only the synthetic result.",
      schemaName: "SyntheticAdmissionFixture",
      schema,
      modelConfig: configFor({ groqCapacity: limits }),
      provider,
      logger,
      dryRun: true,
      requestBudget: budget,
    });
    return { decision: "ALLOW", dispatches, logger };
  } catch (error) {
    return { decision: error instanceof AgentError ? error.code : "UNEXPECTED_ERROR", dispatches, logger };
  }
}

// A fresh-process resume has no in-memory header. It shares bootstrap admission with first and later stages.
for (const stage of ["verifier", "translator", "editor", "ranker"]) {
  const result = await execute({ stage });
  assert.equal(result.decision, "ALLOW", `${stage} must allow local-known-zero bootstrap with no provider header`);
  assert.equal(result.dispatches, 1);
  const decision = result.logger.entries.find((entry) => entry.entry.step === "groq_tpm_pacing_decision");
  assert.equal(decision.entry.payload.externalState, "HEADER_ABSENT");
  assert.equal(decision.entry.payload.localWindowState, "LOCAL_WINDOW_KNOWN_ZERO");
}

// The current response headers are provider-wide and have an explicit observation age.
{
  const stale = await execute({ stage: "editor", snapshot: freshSnapshot(0, new Date(Date.now() - 3_600_000).toISOString()) });
  assert.equal(stale.decision, "ALLOW");
  assert.equal(stale.logger.entries.find((entry) => entry.entry.step === "groq_tpm_pacing_decision").entry.payload.externalState, "HEADER_STALE");
  const unknown = await execute({ stage: "ranker", snapshot: freshSnapshot(null) });
  assert.equal(unknown.decision, "ALLOW");
  assert.equal(unknown.logger.entries.find((entry) => entry.entry.step === "groq_tpm_pacing_decision").entry.payload.externalState, "EXTERNAL_REMAINING_UNKNOWN");
  const insufficient = await execute({ stage: "editor", snapshot: freshSnapshot(0) });
  assert.equal(insufficient.decision, "PROVIDER_CAPACITY_EXHAUSTED");
  assert.equal(insufficient.dispatches, 0);
  assert.equal((await insufficient.logger.getProviderDailyUsage("groq", today)).requestsReserved, 0, "fresh-header defer releases the local hold");
}

// Normal and resumed entries reach the same atomic local checks for each supported local quota dimension.
const dimensions = [
  { name: "RPM", seedTokens: 100, limits: { ...baseLimits }, expected: "ALLOW" },
  { name: "TPM", seedTokens: 7_800, limits: { ...baseLimits }, expected: "PROVIDER_CAPACITY_EXHAUSTED" },
  { name: "RPD", seedTokens: 100, limits: { ...baseLimits, requestHardLimit: 1, requestSoftLimit: 1 }, expected: "PROVIDER_CAPACITY_EXHAUSTED" },
  { name: "TPD", seedTokens: 200, limits: { ...baseLimits, tokenHardLimit: 1_000, tokenSoftLimit: 200 }, expected: "PROVIDER_CAPACITY_EXHAUSTED" },
];
for (const dimension of dimensions) {
  const equivalentStages = ["verifier", "translator", "editor", "ranker"];
  const decisions = [];
  for (const stage of equivalentStages) {
    const result = await execute({ stage, seedTokens: dimension.seedTokens, limits: dimension.limits });
    decisions.push(result.decision);
    assert.equal(result.decision, dimension.expected, `${dimension.name} admission must not depend on normal/resume stage position`);
    assert.equal(result.dispatches, dimension.expected === "ALLOW" ? 1 : 0);
  }
  assert.ok(decisions.every((decision) => decision === decisions[0]), `${dimension.name} NORMAL_ADMISSION must equal RESUME_ADMISSION`);
}

// A complete local accounting failure or malformed/unknown local reservation is technical and fail-closed.
for (const accountingFailure of ["query", "malformed"]) {
  const result = await execute({ stage: "editor", accountingFailure });
  assert.equal(result.decision, "cost_guard_violation");
  assert.equal(result.dispatches, 0);
}
{
  const result = await execute({ stage: "editor", headerReadFailure: true });
  assert.equal(result.decision, "cost_guard_violation");
  assert.equal(result.dispatches, 0);
  assert.equal((await result.logger.getProviderDailyUsage("groq", today)).requestsReserved, 0, "header-read failure releases the local hold");
}

// A no-header response from an earlier dispatched stage is persisted as unknown, then does not deadlock the next stage.
{
  const logger = new InMemoryAgentLogger();
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(`${today}T12:00:00.000Z`));
  const provider = { providerId: "groq", async generateStructured(request) {
    await request.onRequestDispatched();
    return { output: { ok: true }, model, provider: "groq", usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } };
  } };
  const runStage = (agentName) => runStructuredAgent({
    agentName, agentVersion: "12f10d-fixture-v1", eventKey: "synthetic-headerless-continuation",
    input: { fixture: true }, systemInstructions: "Return only the synthetic result.", schemaName: "SyntheticAdmissionFixture",
    schema, modelConfig: configFor(), provider, logger, dryRun: true, requestBudget: budget,
  });
  await runStage("verifier");
  const persisted = await logger.getLatestProviderRateLimitSnapshot("groq");
  assert.ok(persisted);
  assert.equal(persisted.telemetry.tokenRemainingMinute, null);
  await runStage("editor");
  assert.equal((await logger.getProviderDailyUsage("groq", today)).requestsDispatched, 2);
}

assert.equal(SUPERVISED_PROVIDER_REQUEST_LIMIT, 36);
assert.equal(readGroqMaxConcurrentEvents({}), 1);
assert.equal(configFor().maxRetries, 0);
assert.equal(configFor().allowPaidFallback, false);
console.log(JSON.stringify({ status: "PASS", sharedNormalResumeAdmission: "PASS", rpm: "EQUIVALENT; supervised cap 18 and concurrency 1 unchanged", tpm: "EQUIVALENT", rpd: "EQUIVALENT", tpd: "EQUIVALENT", headerAbsence: "ALLOW_LOCAL_RESERVATION", staleHeader: "IGNORED", freshInsufficientHeader: "DEFER_AND_RELEASE", localAccountingFailures: "TECHNICAL_FAILURE", syntheticProviderCalls: 0 }));
