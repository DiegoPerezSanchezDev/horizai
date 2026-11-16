import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";

const migrationPath = "supabase/migrations/20261009120000_provider_capacity_attempt_lifecycle_rpc.sql";
const migration = readFileSync(migrationPath, "utf8");
const remoteFixture = readFileSync("scripts/migration33-remote-rollback-fixture.sql", "utf8");
const repositorySource = readFileSync("lib/agents/pipeline/event-attempt-repository.ts", "utf8");
const orchestratorSource = readFileSync("lib/agents/pipeline/pipeline-orchestrator.ts", "utf8");
assert.match(migration, /add column capacity_resume_snapshot jsonb/i);
assert.equal((migration.match(/create function public\./gi) ?? []).length, 3, "M33 exposes only defer, claim, and release RPCs");
assert.equal((migration.match(/security definer/gi) ?? []).length, 3);
assert.equal((migration.match(/set search_path = pg_catalog, public/gi) ?? []).length, 3);
assert.match(migration, /revoke all on function public\.defer_pipeline_event_attempt_capacity[\s\S]*from public, anon, authenticated, service_role/i);
assert.match(migration, /grant execute on function public\.defer_pipeline_event_attempt_capacity[\s\S]*to service_role/i);
assert.match(migration, /grant execute on function public\.claim_pipeline_event_attempt_capacity_resume[\s\S]*to service_role/i);
assert.match(migration, /grant execute on function public\.release_pipeline_event_attempt_capacity_resume[\s\S]*to service_role/i);
assert.doesNotMatch(migration, /grant\s+(?:all|update|insert|delete)\s+on\s+table\s+public\.pipeline_event_attempts/i);
assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_event_key, 0\)\)/g);
assert.match(migration, /p_provider_request_dispatched is distinct from false/);
assert.match(migration, /p_provider_requests_used is distinct from 0/);
assert.match(migration, /capacity_resume_snapshot = p_snapshot/);
assert.match(migration, /capacity_attempt_terminal/);
assert.match(migration, /resumeGeneration.*capacity_resume_snapshot/s);
assert.match(remoteFixture, /m33_conflicting_defer_was_accepted/);
assert.match(remoteFixture, /m33_wrong_event_was_accepted/);
assert.match(remoteFixture, /m33_stale_generation_was_accepted/);
assert.match(remoteFixture, /m33_double_claim_was_accepted/);
assert.match(remoteFixture, /m33_terminal_reopen_was_accepted/);
assert.match(remoteFixture, /M33_FIXTURE_FORCE_ROLLBACK/);
assert.match(repositorySource, /rpc\("defer_pipeline_event_attempt_capacity_m35"/);
assert.match(repositorySource, /rpc\("claim_pipeline_event_attempt_capacity_resume_m35"/);
assert.match(repositorySource, /rpc\("release_pipeline_event_attempt_capacity_resume_m35"/);
assert.doesNotMatch(repositorySource, /from\("pipeline_event_attempts"\)\.update\(/);
assert.match(repositorySource, /loadCapacityResumeSnapshot/);
assert.match(orchestratorSource, /providerRequestDispatched: false,[\s\S]*providerRequestsUsed: 0/);
assert.match(orchestratorSource, /delete result\.capacityResumeSnapshot/);

const event = structuredClone(validFixtures.ClusteredEvent);
const item = structuredClone(validFixtures.ExtractedItem);
const sourceId = event.sourceItems[0].sourceId;
item.metadata = { ...item.metadata, sourceId };
const source = {
  sourceId,
  sourceItemId: event.sourceItems[0].candidateId,
  rawItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceName: "Synthetic source",
  sourceUrl: item.canonicalUrl,
  sourceType: "official",
  countryCode: "US",
  language: "en",
};
const makeCheckpoint = (stage) => ({ stage, eventKey: event.eventKey, path: `synthetic://${stage}`, written: true, readable: true, valid: true });
const makeTelemetry = () => ({
  status: "SUCCESS", provider: "groq", providerRequestDispatched: true, providerRequestsUsed: 1,
  attempts: 1, retries: 0, providerUnit: "tokens", providerUnitUsageKnown: true,
  inputTokens: 2, outputTokens: 3, totalTokens: 5,
});
const makeSnapshot = (resumeGeneration = 0) => ({
  schemaVersion: 1,
  kind: "SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME",
  attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  pipelineRunId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  eventKey: event.eventKey,
  resumeStage: "editor",
  event,
  items: [item],
  sources: [source],
  verification: structuredClone(validFixtures.VerificationResult),
  translation: structuredClone(validFixtures.TranslationResult),
  checkpoints: { verifier: makeCheckpoint("verifier"), translator: makeCheckpoint("translator") },
  checkpointSha256: { verifier: "a".repeat(64), translator: "b".repeat(64) },
  providerAccounting: { verifier: makeTelemetry(), translator: makeTelemetry() },
  nextStageDispatchCount: 0,
  nextStageCheckpointPresent: false,
  resumeGeneration,
});
const snapshot = makeSnapshot();
const attempt = {
  id: snapshot.attemptId,
  eventKey: snapshot.eventKey,
  pipelineRunId: snapshot.pipelineRunId,
  attemptNumber: 1,
  startedAt: "2026-10-09T00:00:00.000Z",
  completedAt: null,
  finalState: null,
  stopStage: null,
  stopReason: null,
  retryClass: "NONE",
  countsTowardRetryLimit: false,
  nextEligibleAt: null,
  createdAt: "2026-10-09T00:00:00.000Z",
};
const registry = new InMemoryPipelineEventAttemptRegistry([attempt]);
const deferInput = { attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, stopStage: "editor", snapshot, providerRequestDispatched: false, providerRequestsUsed: 0 };
await registry.deferCapacity(deferInput);
await registry.deferCapacity(deferInput);
assert.equal(registry.snapshot().length, 1, "repeat defer reuses the same attempt");
assert.equal(registry.snapshot()[0].attemptNumber, 1);
assert.equal(registry.snapshot()[0].countsTowardRetryLimit, false);
assert.deepEqual(await registry.loadCapacityResumeSnapshot({ attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, resumeStage: "editor" }), snapshot);
const claims = await Promise.all([
  registry.claimCapacityResume({ attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, ownerId: "owner-a", resumeStage: "editor" }),
  registry.claimCapacityResume({ attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, ownerId: "owner-b", resumeStage: "editor" }),
]);
assert.deepEqual(claims, [true, false], "only one concurrent resume claim wins");
await registry.deferCapacity({ ...deferInput, snapshot: makeSnapshot(1), ownerId: "owner-a", claimedStage: "editor" });
assert.equal(registry.snapshot().length, 1, "resume remains on the same attempt");
assert.equal(registry.snapshot()[0].stopReason, "PROVIDER_CAPACITY_EXHAUSTED");
assert.equal(registry.snapshot()[0].capacityResumeSnapshot.resumeGeneration, 1);
await assert.rejects(registry.deferCapacity({ ...deferInput, providerRequestDispatched: true }), /EVENT_ATTEMPT_CAPACITY_DEFER_DISPATCHED/);

const calls = [];
const supabase = {
  rpc(name, args) {
    calls.push({ name, args });
    if (name === "defer_pipeline_event_attempt_capacity_m35") return Promise.resolve({ data: { status: "DEFERRED" }, error: null });
    if (name === "claim_pipeline_event_attempt_capacity_resume_m35") return Promise.resolve({ data: true, error: null });
    if (name === "release_pipeline_event_attempt_capacity_resume_m35") return Promise.resolve({ data: true, error: null });
    throw new Error("unexpected_rpc");
  },
  from() { throw new Error("capacity mutations must not use direct PostgREST table DML"); },
};
const repository = new SupabasePipelineEventAttemptRepository(supabase);
await repository.deferCapacity(deferInput);
assert.equal(await repository.claimCapacityResume({ attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, ownerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", resumeStage: "editor" }), true);
await repository.releaseCapacityResume({ attemptId: attempt.id, eventKey: attempt.eventKey, pipelineRunId: attempt.pipelineRunId, ownerId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", resumeStage: "editor" });
assert.deepEqual(calls.map(({ name }) => name), [
  "defer_pipeline_event_attempt_capacity_m35",
  "claim_pipeline_event_attempt_capacity_resume_m35",
  "release_pipeline_event_attempt_capacity_resume_m35",
]);
assert.equal(calls[0].args.p_provider_request_dispatched, false);
assert.equal(calls[0].args.p_provider_requests_used, 0);

console.log("Migration 33 local lifecycle fixtures passed: immutable RPC surface, same-attempt defer, CAS claim, snapshot persistence/read, no direct UPDATE, pre-dispatch-only guard");
