import assert from "node:assert/strict";
process.env.GROQ_TPM_PACING_MAX_WAIT_MS = "0";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { AgentError, getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { decideGroqFirstStageCapacity } from "../lib/agents/runtime/groq-capacity-pacing.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, createStaticPipelineQuota, parseCapacityResumeSnapshot, writeCapacityResumeSnapshot } from "../lib/agents/pipeline/index.ts";

const migration = readFileSync("supabase/migrations/20261014120000_verifier_first_stage_capacity_resume.sql", "utf8");
const aclSql = readFileSync("scripts/migration35-remote-acl-readonly.sql", "utf8");
const remoteFixture = readFileSync("scripts/migration35-remote-rollback-fixture.sql", "utf8");
assert.match(migration, /defer_pipeline_event_attempt_capacity_m35/);
assert.match(migration, /claim_pipeline_event_attempt_capacity_resume_m35/);
assert.match(migration, /release_pipeline_event_attempt_capacity_resume_m35/);
assert.match(migration, /reserve_groq_request_and_tokens_m35/);
assert.match(migration, /array\['verifier', 'translator', 'editor', 'classifier', 'ranker', 'critic'\]/);
assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_event_key, 0\)\)/);
assert.match(migration, /capacity_attempt_start_time_mismatch/);
assert.match(migration, /GROQ_TPM_LOCAL_CAPACITY_EXHAUSTED/);
assert.match(migration, /GROQ_TPM_LOCAL_USAGE_UNKNOWN/);
assert.match(migration, /p_token_minute_hard_limit/);
assert.match(migration, /p_safety_margin_tokens/);
assert.match(migration, /revoke all on function public\.defer_pipeline_event_attempt_capacity_m35[\s\S]*from public, anon, authenticated, service_role/i);
assert.match(migration, /grant execute on function public\.reserve_groq_request_and_tokens_m35[\s\S]*to service_role/i);
assert.doesNotMatch(migration, /grant\s+(?:all|update|insert|delete)\s+on\s+table\s+public\.pipeline_event_attempts/i);
assert.match(aclSql, /has_table_privilege\('service_role', c\.oid, 'UPDATE'\)/);
assert.match(remoteFixture, /M35_FIXTURE_FORCE_ROLLBACK/);
for (const scenario of ["invalid_stage", "wrong_event_lineage", "cross_attempt", "incomplete_lineage", "second_verifier_claim", "terminal_attempt"]) {
  assert.ok(remoteFixture.includes(scenario), `remote rollback fixture covers ${scenario}`);
}
assert.equal((remoteFixture.match(/\bcommit\s*;/gi) ?? []).length, 0, "the M35 remote fixture always rolls back");
assert.match(readFileSync("lib/agents/pipeline/event-attempt-repository.ts", "utf8"), /rpc\("defer_pipeline_event_attempt_capacity_m35"/);
assert.match(readFileSync("lib/agents/runtime/agent-logger.ts", "utf8"), /rpc\("reserve_groq_request_and_tokens_m35"/);

const at = new Date("2026-10-14T12:00:00.000Z");
const telemetry = (remaining) => ({
  requestLimitDaily: null, requestRemainingDaily: null, requestReset: null, requestResetSeconds: null,
  tokenLimitMinute: 8_000, tokenRemainingMinute: remaining, tokenReset: null, tokenResetSeconds: 10, retryAfterSeconds: null,
});
const estimate = 3_000;
const header = (remaining, observedAt = at.toISOString()) => ({ observedAt, telemetry: telemetry(remaining) });
assert.equal(decideGroqFirstStageCapacity({ estimatedStageTokenRequirement: estimate, tokenLimitTpm: 8_000, now: at, providerSnapshot: null }).decision, "ALLOW_LOCAL_RESERVATION");
assert.equal(decideGroqFirstStageCapacity({ estimatedStageTokenRequirement: estimate, tokenLimitTpm: 8_000, now: at, providerSnapshot: header(2_000) }).decision, "DEFER_TEMPORARY_CAPACITY");
assert.equal(decideGroqFirstStageCapacity({ estimatedStageTokenRequirement: estimate, tokenLimitTpm: 8_000, now: at, providerSnapshot: header(7_000) }).evidence, "FRESH_HEADER_SUFFICIENT");
assert.equal(decideGroqFirstStageCapacity({ estimatedStageTokenRequirement: estimate, tokenLimitTpm: 8_000, now: at, providerSnapshot: header(0, "2026-10-14T11:59:00.000Z") }).evidence, "NO_FRESH_HEADER");
assert.equal(decideGroqFirstStageCapacity({ estimatedStageTokenRequirement: 7_900, tokenLimitTpm: 8_000, now: at }).decision, "INTRINSICALLY_TOO_LARGE");
assert.equal(decideGroqFirstStageCapacity({ estimatedStageTokenRequirement: estimate, tokenLimitTpm: 8_000, now: at, providerSnapshot: { observedAt: at.toISOString(), telemetry: telemetry(null) } }).evidence, "FRESH_HEADER_REMAINING_UNKNOWN");

const modelConfig = {
  model: "openai/gpt-oss-20b", timeoutMs: 1_000, maxRetries: 0, retryBackoffMs: 0,
  maxOutputTokens: 1_200, dailyRequestLimit: 100, failOnRateLimit: true, allowPaidFallback: false,
  structuredOutputMode: "json_object", groqCapacity: {
    requestHardLimit: 100, requestSoftLimit: 90, tokenHardLimit: 200_000, tokenSoftLimit: 170_000, tokenMinuteHardLimit: 8_000,
  },
};
const schema = z.object({ ok: z.boolean() });
let providerCalls = 0;
const neverCallProvider = {
  providerId: "groq",
  async generateStructured() { providerCalls += 1; throw new Error("SYNTHETIC_TEST_PROVIDER_MUST_NOT_RUN"); },
};
const systemInstructions = "Synthetic verifier instructions.";
const syntheticEventKey = "synthetic-m35-capacity-test";
const requestDate = new Date().toISOString().slice(0, 10);
const logger = new InMemoryAgentLogger();
const seedMetadata = { agentName: "synthetic-seed", agentVersion: "fixture", eventKey: "synthetic-seed", model: modelConfig.model, provider: "groq", dryRun: true };
const seedRun = await logger.startRun(seedMetadata, new Date().toISOString());
const seedReservation = await logger.reserveGroqCapacity(seedRun, seedMetadata, 1, requestDate, modelConfig.groqCapacity, 7_700);
assert.equal(seedReservation.allowed, true, "synthetic local durable TPM usage is admitted within the configured hard limit");
let temporaryCapacityError;
try {
  await runStructuredAgent({
    agentName: "verifier", agentVersion: "m35-synthetic", eventKey: syntheticEventKey,
    pipelineRunId: "synthetic-run", input: { title: "synthetic event" }, systemInstructions,
    schemaName: "SyntheticVerifierOutput", schema, modelConfig, provider: neverCallProvider, logger,
  });
} catch (error) { temporaryCapacityError = error; }
assert.ok(temporaryCapacityError instanceof AgentError);
assert.equal(temporaryCapacityError.code, "PROVIDER_CAPACITY_EXHAUSTED");
assert.equal(getAgentFailureDetails(temporaryCapacityError).providerRequestsUsed, 0);
assert.equal(getAgentFailureDetails(temporaryCapacityError).diagnostics?.providerRequestDispatched, false);
assert.equal(providerCalls, 0);
const syntheticUsage = await logger.getProviderDailyUsage("groq", requestDate);
assert.equal(syntheticUsage.requestsReserved, 1, "only the explicit synthetic capacity seed is reserved; denied Verifier creates none");
assert.equal(syntheticUsage.requestsDispatched, 0);

const oversizeLogger = new InMemoryAgentLogger();
let oversizeError;
try {
  await runStructuredAgent({
    agentName: "verifier", agentVersion: "m35-synthetic", eventKey: syntheticEventKey,
    input: { body: "x".repeat(20_000) }, systemInstructions, schemaName: "SyntheticVerifierOutput",
    schema, modelConfig, provider: neverCallProvider, logger: oversizeLogger,
  });
} catch (error) { oversizeError = error; }
assert.ok(oversizeError instanceof AgentError);
assert.equal(oversizeError.code, "VERIFIER_INPUT_TOO_LARGE", "intrinsic static overflow stays a safe reject, distinct from temporary capacity");
assert.equal((await oversizeLogger.getProviderDailyUsage("groq", requestDate)).requestsReserved, 0);
assert.equal(providerCalls, 0);

// Drive the actual orchestrator to a Verifier pre-dispatch defer, serialize its
// durable snapshot, then resume it in a brand-new Node process.
const fixture = createOfflineStages();
fixture.stages.verifier = async (context, run) => {
  await runStructuredAgent({
    agentName: "verifier", agentVersion: "m35-synthetic", eventKey: context.event.eventKey,
    pipelineRunId: run.runId, attemptId: context.eventAttemptId,
    input: { title: context.event.canonicalTitle }, systemInstructions,
    schemaName: "SyntheticVerifierOutput", schema, modelConfig, provider: neverCallProvider, logger,
  });
  throw new Error("SYNTHETIC_VERIFIER_DID_NOT_DEFER");
};
const attempts = new InMemoryPipelineEventAttemptRegistry();
const snapshotRoot = await mkdtemp(join(tmpdir(), "horizai-m35-verifier-resume-"));
let initialResult;
try {
  const orchestrator = new PipelineOrchestrator({
    stages: fixture.stages,
    quota: createStaticPipelineQuota(100),
    attemptRegistry: attempts,
    humanReviewGateway: { async createReview() { throw new Error("INITIAL_DEFER_MUST_NOT_REVIEW"); } },
    capacityResumeSnapshotWriter: async (value) => writeCapacityResumeSnapshot(value, join(snapshotRoot, `${value.attemptId}-${value.resumeStage}-g${value.resumeGeneration}.json`)),
    now: () => new Date(),
    runId: "35555555-5555-4555-8555-555555555555",
    config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
  });
  initialResult = await orchestrator.run();
  assert.equal(initialResult.finalState, "DEFERRED_PROVIDER_CAPACITY", JSON.stringify(initialResult.eventResults));
  assert.equal(initialResult.eventResults.length, 1);
  assert.equal(initialResult.eventResults[0].stopStage, "verifier");
  assert.equal(initialResult.eventResults[0].failure?.providerRequestDispatched, false);
  assert.equal(initialResult.eventResults[0].failure?.providerRequestsUsed, 0);
  assert.equal(initialResult.eventResults[0].requestsUsed, 0);
  assert.equal(attempts.snapshot().length, 1, "deferral does not create a second attempt");
  const deferredAttempt = attempts.snapshot()[0];
  assert.equal(deferredAttempt.attemptNumber, 1);
  assert.equal(deferredAttempt.countsTowardRetryLimit, false);
  assert.equal(deferredAttempt.stopReason, "PROVIDER_CAPACITY_EXHAUSTED");
  const snapshot = parseCapacityResumeSnapshot(deferredAttempt.capacityResumeSnapshot);
  assert.equal(snapshot.resumeStage, "verifier");
  assert.deepEqual(snapshot.checkpoints, {});
  assert.deepEqual(snapshot.providerAccounting, {});
  assert.ok(snapshot.attemptStartedAt);
  const evidence = {
    attempt: {
      attemptId: deferredAttempt.id, eventKey: deferredAttempt.eventKey, pipelineRunId: deferredAttempt.pipelineRunId,
      startedAt: deferredAttempt.startedAt, completedAt: null, finalState: null, stopStage: "verifier",
      stopReason: "PROVIDER_CAPACITY_EXHAUSTED", countsTowardRetryLimit: false,
    },
    currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items,
    currentCheckpointSha256: {}, nextStageDispatchCount: 0, nextStageCheckpointPresent: false,
    unresolvedProviderUsage: false, activeOwner: false, terminalEditorialRejection: false,
  };
  const handoffPath = join(snapshotRoot, "fresh-process-handoff.json");
  await writeFile(handoffPath, JSON.stringify({ snapshot, evidence, attempt: deferredAttempt }), "utf8");
  const child = spawnSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", resolve("scripts/verifier-first-stage-capacity-migration35-resume-child.mjs"), handoffPath], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, `fresh-process resume child exits successfully: ${child.stderr}`);
  const childResult = JSON.parse(child.stdout.trim());
  assert.equal(childResult.finalState, "WAITING_FOR_HUMAN_REVIEW");
  assert.deepEqual(childResult.stages, ["verifier", "translator", "editor", "classifier", "geo", "ranker", "critic"]);
  assert.equal(childResult.providerRequestsUsed, 0);
  assert.equal(childResult.attemptCount, 1);
  assert.equal(childResult.attemptId, deferredAttempt.id);
  assert.equal(childResult.attemptFinalState, "WAITING_FOR_HUMAN_REVIEW");
  assert.equal(childResult.reviewCount, 1);
  assert.equal(childResult.rawItemCount, 1, "fresh-process resume uses stored raw lineage without rediscovery or re-extraction");
  assert.equal(providerCalls, 0);
  assert.equal((await logger.getProviderDailyUsage("groq", requestDate)).requestsReserved, 1, "resume does not double-reserve provider accounting");
} finally {
  await rm(snapshotRoot, { recursive: true, force: true });
}

console.log("M35 Verifier first-stage capacity unit tests passed: static/fresh header policy, atomic synthetic TPM defer, intrinsic oversize separation, durable snapshot, fresh-process same-attempt resume, zero provider dispatch");
