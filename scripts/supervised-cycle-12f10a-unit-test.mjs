import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AgentError } from "../lib/agents/runtime/agent-errors.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import {
  InMemoryPipelineEventAttemptRegistry,
  PipelineOrchestrator,
  assessCapacityResume,
  checkpointSha256,
  createStaticPipelineQuota,
  nextCapacityResumeGeneration,
  writeCapacityResumeSnapshot,
} from "../lib/agents/pipeline/index.ts";
import { runAndFinalizeSupervisedExecution } from "../lib/agents/pipeline/scheduler/scheduler-terminal-contract.ts";

const root = await mkdtemp(join(tmpdir(), "horizai-12f10a-"));
const now = () => new Date("2026-10-16T08:00:00.000Z");
const timestamp = now().toISOString();
const resumeChildPath = fileURLToPath(new URL("./supervised-cycle-12f10a-resume-child.mjs", import.meta.url));

function telemetry(stage) {
  return {
    status: "SUCCESS", provider: "groq", providerUnit: "tokens", providerUnitUsageKnown: true,
    providerRequestDispatched: true, providerRequestsUsed: 1, attempts: 1, retries: 0,
    inputTokens: 60, outputTokens: 40, totalTokens: 100,
    agentVersion: `${stage}-synthetic-v1`, model: "offline-synthetic", latencyMs: 1,
    startedAt: timestamp, finishedAt: timestamp,
  };
}

function stagesWithCapacityStop({ blockedStage, checkpointRoot }) {
  const fixture = createOfflineStages();
  for (const stage of ["verifier", "translator", "editor", "classifier", "ranker", "critic"]) {
    const original = fixture.stages[stage];
    fixture.stages[stage] = async (...args) => {
      if (stage === blockedStage) {
        fixture.calls.push(stage);
        throw new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "synthetic pre-dispatch capacity stop", undefined, {
          providerRequestDispatched: false,
          failureKind: "PROVIDER_CAPACITY_EXHAUSTED",
        });
      }
      const outcome = await original(...args);
      const [context] = args;
      const path = join(checkpointRoot, `${context.event.eventKey}-${stage}.json`);
      return {
        ...outcome,
        telemetry: telemetry(stage),
        provider: "groq",
        checkpoint: async () => {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, `${JSON.stringify({ stage, eventKey: context.event.eventKey, output: outcome.output })}\n`, { encoding: "utf8", flag: "wx" });
          return { stage, eventKey: context.event.eventKey, path, written: true, readable: true, valid: true };
        },
      };
    };
  }
  return fixture;
}

function makeOrchestrator({ fixture, registry, runId, snapshotRoot }) {
  return new PipelineOrchestrator({
    stages: fixture.stages,
    quota: createStaticPipelineQuota(20),
    attemptRegistry: registry,
    humanReviewGateway: { async createReview() { throw new Error("SYNTHETIC_TEST_MUST_NOT_CREATE_REVIEW"); } },
    runId,
    now,
    config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false },
    capacityResumeSnapshotWriter: async (snapshot) => writeCapacityResumeSnapshot(
      snapshot,
      join(snapshotRoot, `${snapshot.eventKey}-${snapshot.resumeStage}-g${snapshot.resumeGeneration}.json`),
    ),
  });
}

async function resumeEvidence(attempt, snapshot) {
  return {
    attempt: {
      attemptId: attempt.id,
      eventKey: attempt.eventKey,
      pipelineRunId: attempt.pipelineRunId,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      finalState: attempt.finalState,
      stopStage: attempt.stopStage,
      stopReason: attempt.stopReason,
      countsTowardRetryLimit: attempt.countsTowardRetryLimit,
    },
    currentEvent: snapshot.event,
    currentSources: snapshot.sources,
    currentItems: snapshot.items,
    currentCheckpointSha256: await checkpointSha256(snapshot.checkpoints),
    nextStageDispatchCount: 0,
    nextStageCheckpointPresent: false,
    unresolvedProviderUsage: false,
    activeOwner: false,
    terminalEditorialRejection: false,
  };
}

try {
  assert.equal(nextCapacityResumeGeneration(), 0, "the first defer uses M35 initial generation zero");
  assert.equal(nextCapacityResumeGeneration(0), 1, "the first resume advances exactly once");
  assert.equal(nextCapacityResumeGeneration(1), 2, "the second resume advances exactly once");
  assert.throws(() => nextCapacityResumeGeneration(1000), /CAPACITY_RESUME_GENERATION_INVALID/);

  for (const blockedStage of ["verifier", "translator", "editor"]) {
    const scenarioRoot = join(root, `initial-${blockedStage}`);
    const fixture = stagesWithCapacityStop({ blockedStage, checkpointRoot: join(scenarioRoot, "checkpoints") });
    const registry = new InMemoryPipelineEventAttemptRegistry();
    const result = await makeOrchestrator({ fixture, registry, runId: randomUUID(), snapshotRoot: join(scenarioRoot, "snapshots") }).run();
    assert.equal(result.finalState, "DEFERRED_PROVIDER_CAPACITY");
    assert.equal(registry.snapshot().length, 1);
    assert.equal(registry.snapshot()[0].capacityResumeSnapshot.resumeGeneration, 0, `${blockedStage} first defer uses generation zero`);
  }

  const resumeRoot = join(root, "resume-cycles");
  const firstFixture = stagesWithCapacityStop({ blockedStage: "editor", checkpointRoot: join(resumeRoot, "checkpoints") });
  const registry = new InMemoryPipelineEventAttemptRegistry();
  const runId = randomUUID();
  const firstResult = await makeOrchestrator({ fixture: firstFixture, registry, runId, snapshotRoot: join(resumeRoot, "snapshots") }).run();
  assert.equal(firstResult.eventResults[0].finalState, "DEFERRED_PROVIDER_CAPACITY");
  assert.equal(registry.snapshot()[0].capacityResumeSnapshot.resumeGeneration, 0);
  const originalGenerationZeroSnapshot = registry.snapshot()[0].capacityResumeSnapshot;
  let currentAttempt = registry.snapshot()[0];
  const originalAttempt = currentAttempt;
  const originalEvidence = await resumeEvidence(originalAttempt, originalGenerationZeroSnapshot);
  assert.equal(assessCapacityResume(originalGenerationZeroSnapshot, {
    ...originalEvidence,
    attempt: { ...originalEvidence.attempt, attemptId: randomUUID() },
  }).valid, false, "wrong attempt lineage is rejected");
  assert.equal(assessCapacityResume(originalGenerationZeroSnapshot, {
    ...originalEvidence,
    currentEvent: { ...originalEvidence.currentEvent, eventKey: "wrong-event-lineage" },
  }).valid, false, "wrong event lineage is rejected");
  assert.equal(assessCapacityResume(originalGenerationZeroSnapshot, {
    ...originalEvidence,
    attempt: { ...originalEvidence.attempt, completedAt: timestamp, finalState: "TECHNICAL_FAILURE" },
  }).valid, false, "terminal attempts are rejected");
  assert.equal(assessCapacityResume(originalGenerationZeroSnapshot, {
    ...originalEvidence,
    nextStageDispatchCount: 1,
  }).valid, false, "provider-dispatched next stages cannot use pre-dispatch recovery");

  for (const expectedGeneration of [1, 2]) {
    const attempt = currentAttempt;
    const snapshot = attempt.capacityResumeSnapshot;
    const assessment = assessCapacityResume(snapshot, await resumeEvidence(attempt, snapshot), { ownerId: `synthetic-owner-${expectedGeneration}` });
    assert.equal(assessment.valid, true);
    if (expectedGeneration === 2) {
      const staleFixture = stagesWithCapacityStop({ blockedStage: "editor", checkpointRoot: join(resumeRoot, "stale-checkpoints") });
      const staleRegistry = new InMemoryPipelineEventAttemptRegistry([attempt]);
      await assert.rejects(
        makeOrchestrator({ fixture: staleFixture, registry: staleRegistry, runId, snapshotRoot: join(resumeRoot, "stale-snapshots") })
          .resumeCapacityDeferred({ snapshot: originalGenerationZeroSnapshot, evidence: await resumeEvidence(attempt, originalGenerationZeroSnapshot), ownerId: "synthetic-stale-owner" }),
        /CAPACITY_RESUME_STALE_SNAPSHOT/,
      );
      assert.deepEqual(staleFixture.calls, [], "stale snapshot is rejected before any provider stage begins");
      assert.equal(staleRegistry.snapshot()[0].stopReason, "PROVIDER_CAPACITY_EXHAUSTED", "stale snapshot rejection does not claim or mutate the attempt");
    }
    const inputPath = join(resumeRoot, `resume-child-${expectedGeneration}.json`);
    const childSnapshotRoot = join(resumeRoot, `resume-child-${expectedGeneration}-snapshots`);
    await writeFile(inputPath, JSON.stringify({
      attempt,
      snapshot,
      evidence: await resumeEvidence(attempt, snapshot),
      ownerId: `synthetic-owner-${expectedGeneration}`,
      startedAt: timestamp,
      snapshotRoot: childSnapshotRoot,
    }), "utf8");
    const child = spawnSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", resumeChildPath, inputPath], {
      cwd: process.cwd(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    assert.equal(child.status, 0, `fresh process resume cycle ${expectedGeneration}: ${child.stderr}`);
    const resumed = JSON.parse(child.stdout);
    assert.equal(resumed.finalState, "DEFERRED_PROVIDER_CAPACITY");
    assert.deepEqual(resumed.calls, ["editor"], "fresh process resumes at Editor without rerunning Verifier or Translator");
    assert.equal(resumed.requestsUsed, 0);
    assert.equal(resumed.attempt.id, attempt.id);
    assert.equal(resumed.attempt.attemptNumber, 1);
    assert.equal(resumed.attempt.capacityResumeSnapshot.resumeGeneration, expectedGeneration);
    assert.equal(resumed.attempt.stopReason, "PROVIDER_CAPACITY_EXHAUSTED");
    currentAttempt = resumed.attempt;
  }

  const failureRoot = join(root, "scheduler-observability");
  const failedFixture = stagesWithCapacityStop({ blockedStage: "editor", checkpointRoot: join(failureRoot, "checkpoints") });
  const failingRegistry = new InMemoryPipelineEventAttemptRegistry();
  failingRegistry.deferCapacity = async () => { throw new Error("EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023"); };
  const failingRunId = randomUUID();
  const failingOrchestrator = makeOrchestrator({ fixture: failedFixture, registry: failingRegistry, runId: failingRunId, snapshotRoot: join(failureRoot, "snapshots") });
  const finalized = [];
  const execution = await runAndFinalizeSupervisedExecution({
    triggerId: "supervised-candidates:2026-10-16",
    ownerRunId: randomUUID(),
    startedAt: now(),
    pipelineRunId: () => failingRunId,
    execute: () => failingOrchestrator.run(),
    quotaUsed: () => 0,
    quotaRemaining: () => 20,
    now,
    finishExecution: async (input) => { finalized.push(input); return true; },
  });
  assert.equal(execution.result.finalState, "SUCCESS_WITH_FAILURES");
  assert.equal(execution.result.eventResults.length, 1);
  const failedEvent = execution.result.eventResults[0];
  assert.equal(failedEvent.attemptId, failingRegistry.snapshot()[0].id);
  assert.equal(failedEvent.finalState, "FAILED");
  assert.equal(failedEvent.stopStage, "editor");
  assert.equal(failedEvent.stopReason, "EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023");
  assert.deepEqual(failedEvent.persistenceFailure, {
    operation: "CAPACITY_DEFER", errorCode: "EVENT_ATTEMPT_CAPACITY_DEFER_FAILED", databaseCode: "22023", commitState: "NOT_COMMITTED",
  });
  assert.equal(execution.result.eventsAttempted, 1);
  assert.equal(execution.result.providerRequestsUsed, 2);
  assert.equal(execution.outcome.schedulerDecision, "TECHNICAL_FAILURE");
  assert.equal(execution.outcome.stopReason, "EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023");
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].eventAttempts, 1);
  assert.equal(finalized[0].requestsUsed, 2);
  assert.equal(finalized[0].quotaUsed, 2);
  const serialized = finalized[0].eventFinalStates[0];
  assert.equal(serialized.finalState, "FAILED");
  assert.equal(serialized.providerRequests, 2);
  assert.equal(serialized.tokenUsageKnown, true);
  assert.equal(serialized.totalTokens, 200);
  assert.deepEqual(serialized.persistenceFailure, failedEvent.persistenceFailure);
  assert.equal(serialized.reviewCreated, false);
  assert.equal(failingRegistry.snapshot().length, 1, "failed defer did not create another attempt");
  assert.equal(failedFixture.calls.includes("publisher"), false);

  console.log("12F.10A offline regression PASS: M35 generation is per resume cycle; first defer=0, re-defers=1/2; same attempt/checkpoints reused; defer persistence failure retains typed cause and known scheduler counters; no provider or publisher call");
} finally {
  if (!resolve(root).startsWith(resolve(tmpdir()))) throw new Error("12F10A_TEST_TEMP_PATH_INVALID");
  await rm(root, { recursive: true, force: true });
}
