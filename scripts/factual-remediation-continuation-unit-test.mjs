import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertFactualRemediationContinuationEligible,
  canonicalJsonString,
  createContinuationCheckpointManifestSchema,
  continuationCheckpointManifestSchema,
  continuationCheckpointManifestsEqual,
  factualRemediationContinuation,
  parseFactualRemediationContinuationCommand,
} from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { loadFactualRemediationContinuationCheckpoints } from "../lib/agents/pipeline/factual-remediation-continuation-checkpoints.ts";
import { SupabaseFactualRemediationContinuationRepository } from "../lib/agents/pipeline/factual-remediation-continuation-repository.ts";
import { factualRemediationIncident } from "../lib/agents/pipeline/factual-remediation.ts";
import { estimateCriticV3Request, estimateCriticV4Request } from "../lib/agents/critic/critic-estimate.ts";
import { PipelineOrchestrator, createPipelineConfig } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import { createOfflineStages } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { createStaticPipelineQuota } from "../lib/agents/pipeline/pipeline-budget.ts";

const root = resolve(".");
const migrationName = "20261002105220_factual_remediation_continuation.sql";
const migrationPath = resolve(root, "supabase/migrations", migrationName);
const migration = await readFile(migrationPath, "utf8");
const migrations = (await readdir(resolve(root, "supabase/migrations"))).filter((name) => /factual_remediation_(?:continuation|lifecycle)\.sql$/.test(name));
assert.deepEqual(migrations.sort(), ["20260930211903_factual_remediation_lifecycle.sql", migrationName]);
assert.match(migration, /^--[\s\S]*?\bbegin;/i);
assert.match(migration, /commit;\s*$/i);
assert.match(migration, /alter table public\.pipeline_event_attempts\s+add column continuation jsonb/i);
assert.doesNotMatch(migration, /create\s+table\b/i, "migration 28 needs no new table");
assert.doesNotMatch(migration, /insert\s+into\s+public\.pipeline_event_attempts/i, "continuation does not create attempt 6");
assert.doesNotMatch(migration, /set\s+(?:final_state|completed_at|stop_stage|stop_reason)\s*=/i, "terminal fields stay unchanged");
assert.match(migration, /continuation is null/i);
assert.match(migration, /attempt_number\s*>\s*2/i);
assert.match(migration, /pilot_attempt_number\s*=\s*6/i);
assert.match(migration, /pilot_attempt_number\s*<>\s*5/i);
assert.match(migration, /validation_namespace\s*~\s*'\^12c2b2d:/i);
assert.match(migration, /v_is_synthetic[\s\S]*validation_namespace/i);
assert.match(migration, /ar\.config\s*->>\s*'attemptId'\s*=\s*v_attempt\.id::text/i);
assert.match(migration, /l\.payload\s*->>\s*'eventKey'\s*=\s*v_event_key/i);
assert.match(migration, /l\.payload\s*->>\s*'runId'\s*=\s*ar\.id::text/i);
assert.match(migration, /l\.created_at\s*>=\s*ar\.created_at/i);
assert.match(migration, /CRITIC_CHECKPOINT_ALREADY_EXISTS/i);
assert.match(migration, /validationNamespace',\s*case when v_is_synthetic/i);
assert.match(migration, /stop_reason\s*<>\s*'cost_guard_violation'/i);
assert.match(migration, /GROQ_TPM_STAGE_EXCEEDS_TPM/i);
assert.match(migration, /provider_request_reserved/i);
assert.match(migration, /v_critic_runs\s*<>\s*1/i);
assert.match(migration, /ar\.stats\s*->>\s*'finalDecision'\s*=\s*'pass'/i);
assert.match(migration, /ar\.stats\s*->>\s*'deterministicPrechecksPassed'\s*=\s*'true'/i);
assert.match(migration, /ar\.stats\s*->>\s*'evidenceRefsValidated'\s*=\s*'true'/i);
assert.match(migration, /tokenUsageState'\s*=\s*'settled'/i);
assert.match(migration, /v_dispatched_requests\s*>\s*1/i);
assert.match(migration, /resumeStage',\s*'critic'/i);
assert.match(migration, /p_checkpoint_manifest\s*->>\s*'criticCheckpoint'\s+is\s+distinct\s+from\s+'absent'/i);
for (const stage of ["verifier", "translator", "editor", "classifier", "ranker"]) assert.match(migration, new RegExp(`checkpoints,${stage}`));
assert.match(migration, /event_sources[\s\S]*raw_items[\s\S]*sources/i);
assert.match(migration, /sha256:9f053bdbb6d53e5d59baf254201811874992bf7cad444b38431b8f364bfe5caa/);
assert.match(migration, /publication_status\s*=\s*'archived'/i);
assert.match(migration, /public_published_articles/i);
assert.equal((migration.match(/pg_advisory_xact_lock\(hashtextextended\(v_event_key, 0\)\)/g) ?? []).length, 3);
assert.equal((migration.match(/auth\.role\(\) is distinct from 'service_role'/g) ?? []).length, 3);
assert.equal((migration.match(/set search_path = pg_catalog, public/g) ?? []).length, 3);
assert.equal((migration.match(/revoke all on function public\.(?:authorize|finish|publish)_incident_factual_remediation_continuation/g) ?? []).length, 3);
assert.equal((migration.match(/grant execute on function public\.(?:authorize|finish|publish)_incident_factual_remediation_continuation/g) ?? []).length, 3);
assert.doesNotMatch(migration, /from\s+anon\s*,\s*authenticated\s*,\s*service_role/i);
assert.doesNotMatch(migration, /scheduler|netlify|router/i);

const id = factualRemediationContinuation.attemptId;
const validEvidence = {
  attemptId: id,
  eventKey: factualRemediationIncident.eventKey,
  attemptNumber: 2,
  pilotAttemptNumber: 5,
  pilotAttempts: 5,
  purpose: "FACTUAL_REMEDIATION",
  finalState: "TECHNICAL_FAILURE",
  completed: true,
  stopStage: "critic",
  stopReason: "cost_guard_violation",
  failureCode: "cost_guard_violation",
  failureClass: "GROQ_TPM_STAGE_EXCEEDS_TPM",
  criticProviderRequestDispatched: false,
  canonicalPreDispatchProof: true,
  criticCheckpointPresent: false,
  upstreamCheckpointStages: ["verifier", "translator", "editor", "classifier", "ranker"],
  laterAttemptExists: false,
  continuationAlreadyAuthorized: false,
  requestedRestartStage: "critic",
  databaseRole: "service_role",
  authorization: { authorizedBy: "Diego", authorizationReference: "Codex request 12C.2B.2c", reason: "Continue the existing attempt at Critic once." },
};
assert.equal(assertFactualRemediationContinuationEligible(validEvidence), undefined);
for (const [key, value] of [
  ["databaseRole", "anon"], ["attemptNumber", 3], ["pilotAttemptNumber", 6], ["pilotAttempts", 6],
  ["purpose", "NORMAL"], ["finalState", "READY_FOR_PUBLICATION"], ["completed", false],
  ["stopStage", "ranker"], ["failureClass", "GROQ_RPD_LIMIT"],
  ["criticProviderRequestDispatched", true], ["canonicalPreDispatchProof", false],
  ["criticCheckpointPresent", true], ["laterAttemptExists", true], ["continuationAlreadyAuthorized", true],
  ["requestedRestartStage", "ranker"],
]) {
  assert.throws(() => assertFactualRemediationContinuationEligible({ ...validEvidence, [key]: value }), /FACTUAL_REMEDIATION_CONTINUATION/);
}
for (const [key, value] of [
  ["attemptId", "11111111-1111-4111-8111-111111111111"], ["eventKey", "event-other"],
  ["stopReason", "provider_timeout"], ["failureCode", "other"], ["failureClass", "GROQ_RPD_LIMIT"],
]) assert.throws(() => assertFactualRemediationContinuationEligible({ ...validEvidence, [key]: value }), /FACTUAL_REMEDIATION_CONTINUATION/);
assert.throws(() => assertFactualRemediationContinuationEligible({ ...validEvidence, upstreamCheckpointStages: ["verifier"] }), /CHECKPOINTS_MISSING/);
assert.throws(() => assertFactualRemediationContinuationEligible({ ...validEvidence, authorization: undefined }), /HUMAN_AUTHORIZATION_REQUIRED/);
assert.throws(() => assertFactualRemediationContinuationEligible({ ...validEvidence, authorization: { ...validEvidence.authorization, authorizedBy: "" } }), /FACTUAL_REMEDIATION/);

assert.deepEqual(parseFactualRemediationContinuationCommand([]), { mode: "preflight" });
assert.deepEqual(parseFactualRemediationContinuationCommand(["--preflight-only"]), { mode: "preflight" });
const runId = "11111111-1111-4111-8111-111111111111";
const executeArgs = ["--execute-critic-continuation", `--continuation-run-id=${factualRemediationContinuation.continuationPipelineRunId}`];
assert.deepEqual(parseFactualRemediationContinuationCommand(executeArgs), {
  mode: "execute", continuationPipelineRunId: factualRemediationContinuation.continuationPipelineRunId,
});
for (const args of [
  ["--unknown"], ["--authorized-by=Diego"], ["--execute-critic-continuation"],
  ["--execute-critic-continuation", "--continuation-run-id=not-a-uuid"],
  [...executeArgs, "--preflight-only"], [...executeArgs, "--authorized-by=Other"],
  ["--execute-critic-continuation", `--continuation-run-id=${runId}`],
  ["--execute-critic-continuation", `--continuation-run-id=${runId}`, "--authorized-by=Diego", "--authorization-reference=Codex request 12C.2B.2c", "--reason=ok"],
]) assert.throws(() => parseFactualRemediationContinuationCommand(args), /FACTUAL_REMEDIATION/);
assert.throws(() => parseFactualRemediationContinuationCommand([
  "--execute-critic-continuation", `--continuation-run-id=${factualRemediationContinuation.originalPipelineRunId}`,
]), /RUN_ID_REQUIRED/);

const bundle = await loadFactualRemediationContinuationCheckpoints();
const localManifestFixture = {
  schemaVersion: 1,
  eventKey: factualRemediationIncident.eventKey,
  sourceRunId: factualRemediationContinuation.originalPipelineRunId,
  resumeStage: "critic",
  criticCheckpoint: "absent",
  checkpoints: {
    verifier: factualRemediationContinuation.checkpointHashes.verifier,
    translator: factualRemediationContinuation.checkpointHashes.translator,
    editor: factualRemediationContinuation.checkpointHashes.editor,
    classifier: factualRemediationContinuation.checkpointHashes.classifier,
    ranker: factualRemediationContinuation.checkpointHashes.ranker,
  },
};
const jsonbRoundTripManifestFixture = {
  eventKey: factualRemediationIncident.eventKey,
  checkpoints: {
    editor: factualRemediationContinuation.checkpointHashes.editor,
    ranker: factualRemediationContinuation.checkpointHashes.ranker,
    verifier: factualRemediationContinuation.checkpointHashes.verifier,
    classifier: factualRemediationContinuation.checkpointHashes.classifier,
    translator: factualRemediationContinuation.checkpointHashes.translator,
  },
  resumeStage: "critic",
  sourceRunId: factualRemediationContinuation.originalPipelineRunId,
  schemaVersion: 1,
  criticCheckpoint: "absent",
};
assert.notEqual(JSON.stringify(localManifestFixture), JSON.stringify(jsonbRoundTripManifestFixture), "the incident regression reproduces the old order-sensitive failure");
assert.equal(continuationCheckpointManifestSchema.safeParse(localManifestFixture).success, true);
assert.equal(continuationCheckpointManifestSchema.safeParse(jsonbRoundTripManifestFixture).success, true);
assert.equal(continuationCheckpointManifestsEqual(localManifestFixture, jsonbRoundTripManifestFixture), true, "same manifest semantics pass despite root and nested key ordering");
assert.equal(bundle.manifest && continuationCheckpointManifestsEqual(bundle.manifest, jsonbRoundTripManifestFixture), true);
assert.equal(createHash("sha256").update(canonicalJsonString(localManifestFixture)).digest("hex"), "0c3a6f8dab750a345f38e0efbd8481557a1fbfd49a43b2a13879b1ee43e555a6", "the exact incident manifest canonical fingerprint remains deterministic");
const syntheticManifestHashes = Object.fromEntries(["verifier", "translator", "editor", "classifier", "ranker"].map((stage) => [stage, createHash("sha256").update(`12c2b2f1a:${stage}`).digest("hex")]));
const syntheticManifestSchema = createContinuationCheckpointManifestSchema({
  eventKey: "event-synthetic-resume",
  sourceRunId: "33333333-3333-4333-8333-333333333333",
  checkpointHashes: syntheticManifestHashes,
});
const syntheticManifest = {
  schemaVersion: 1,
  eventKey: "event-synthetic-resume",
  sourceRunId: "33333333-3333-4333-8333-333333333333",
  resumeStage: "critic",
  criticCheckpoint: "absent",
  checkpoints: syntheticManifestHashes,
};
const syntheticJsonbRoundTrip = {
  eventKey: syntheticManifest.eventKey,
  checkpoints: Object.fromEntries(Object.entries(syntheticManifestHashes).reverse()),
  resumeStage: "critic",
  sourceRunId: syntheticManifest.sourceRunId,
  schemaVersion: 1,
  criticCheckpoint: "absent",
};
assert.equal(syntheticManifestSchema.safeParse(syntheticManifest).success, true, "the synthetic manifest uses the same strict six-key/five-hash contract");
assert.notEqual(JSON.stringify(syntheticManifest), JSON.stringify(syntheticJsonbRoundTrip));
assert.equal(continuationCheckpointManifestsEqual(syntheticManifest, syntheticJsonbRoundTrip, syntheticManifestSchema), true);
assert.equal(continuationCheckpointManifestsEqual(syntheticManifest, { ...syntheticJsonbRoundTrip, checkpoints: { ...syntheticJsonbRoundTrip.checkpoints, ranker: "f".repeat(64) } }, syntheticManifestSchema), false);
const resumeRpcCalls = [];
const resumeExecutionId = "22222222-2222-4222-8222-222222222222";
const resumeRepository = new SupabaseFactualRemediationContinuationRepository({
  async rpc(name, args) {
    resumeRpcCalls.push({ name, args });
    return { data: { status: "RESUMED", attemptId: id, pipelineRunId: "f140d01b-b7f1-4f05-b8f7-9ad0081e7105", resumeExecutionId, resumeGeneration: 1, authorizationReused: true, newAuthorizationCreated: false, newAttemptCreated: false }, error: null };
  },
});
await resumeRepository.resumePreviouslyAuthorized({
  attemptId: id,
  continuationPipelineRunId: "f140d01b-b7f1-4f05-b8f7-9ad0081e7105",
  resumeExecutionId,
  manifest: bundle.manifest,
});
assert.equal(resumeRpcCalls.length, 1);
assert.equal(resumeRpcCalls[0].name, "resume_incident_factual_remediation_continuation", "the resume path never calls the one-time authorization RPC");
assert.deepEqual(Object.keys(resumeRpcCalls[0].args).sort(), ["p_attempt_id", "p_checkpoint_manifest", "p_pipeline_run_id", "p_resume_execution_id"]);
assert.equal(resumeRpcCalls[0].args.p_attempt_id, id);
assert.equal(resumeRpcCalls[0].args.p_pipeline_run_id, "f140d01b-b7f1-4f05-b8f7-9ad0081e7105");
assert.equal(resumeRpcCalls[0].args.p_resume_execution_id, resumeExecutionId);

for (const changed of [
  { ...localManifestFixture, eventKey: "event-other" },
  { ...localManifestFixture, sourceRunId: "11111111-1111-4111-8111-111111111111" },
  { ...localManifestFixture, resumeStage: "translator" },
  { ...localManifestFixture, checkpoints: { ...localManifestFixture.checkpoints, ranker: "f".repeat(64) } },
  { ...localManifestFixture, attemptId: "11111111-1111-4111-8111-111111111111" },
  { ...localManifestFixture, authorizedBy: "other" },
  { ...localManifestFixture, checkpoints: Object.fromEntries(Object.entries(localManifestFixture.checkpoints).filter(([stage]) => stage !== "verifier")) },
  { ...localManifestFixture, checkpoints: { ...localManifestFixture.checkpoints, critic: "a".repeat(64) } },
  { ...localManifestFixture, checkpoints: { ...Object.fromEntries(Object.entries(localManifestFixture.checkpoints).filter(([stage]) => stage !== "verifier")), verification: localManifestFixture.checkpoints.verifier } },
  Object.fromEntries(Object.entries(localManifestFixture).filter(([key]) => key !== "criticCheckpoint")),
  { ...localManifestFixture, extraRootField: true },
]) {
  assert.equal(continuationCheckpointManifestSchema.safeParse(changed).success, false);
  assert.equal(continuationCheckpointManifestsEqual(localManifestFixture, changed), false);
}

assert.equal(canonicalJsonString({ z: { right: 1, left: 2 }, a: [{ y: true, x: null }] }), canonicalJsonString({ a: [{ x: null, y: true }], z: { left: 2, right: 1 } }), "nested object key order is canonicalized recursively");
assert.notEqual(canonicalJsonString({}), canonicalJsonString({ absent: null }), "missing and null keys stay distinct");
assert.notEqual(canonicalJsonString({ value: "one" }), canonicalJsonString({ value: "two" }));
assert.notEqual(canonicalJsonString({ value: true }), canonicalJsonString({ value: false }));
assert.notEqual(canonicalJsonString({ value: 1 }), canonicalJsonString({ value: 2 }));
assert.notEqual(canonicalJsonString({ hashes: ["a", "b"] }), canonicalJsonString({ hashes: ["b", "a"] }), "array order is preserved");
assert.throws(() => canonicalJsonString({ value: undefined }), /JSON_VALUE_INVALID/);

assert.equal(bundle.priorDispatchProven, true);
assert.equal(bundle.criticCheckpointAbsent, true);
assert.equal(bundle.providerCallsSoFar, 24);
assert.deepEqual(bundle.manifest.checkpoints, factualRemediationContinuation.checkpointHashes);
assert.equal(bundle.manifest.resumeStage, "critic");
assert.equal(bundle.criticInput.event.eventKey, factualRemediationIncident.eventKey);
assert.equal(bundle.criticInput.sourceEvidence[0].contentExcerpt.length <= 1_000, true);
assert.match(bundle.criticInput.sourceEvidence[0].contentExcerpt, /The Wall Street Journal reports/);
assert.match(bundle.criticInput.sourceEvidence[0].contentExcerpt, /TechCrunch reached out to OpenAI/);
assert.equal(bundle.criticInput.verification.status, "single_source");
assert.ok(bundle.criticInput.verification.uncertainClaims.length > 0);
const estimateV3 = estimateCriticV3Request(bundle.criticInput);
const estimateV4 = estimateCriticV4Request(bundle.criticInput);
assert.equal(estimateV3.estimatedStageTokenRequirement, 9_005);
assert.equal(estimateV4.estimatedStageTokenRequirement, 6_397);
assert.ok(estimateV4.estimatedStageTokenRequirement + 128 <= 8_000);

const makeGuard = () => {
  const calls = { assert: 0, finish: [] };
  return {
    calls,
    async assertOwned(attemptId, continuationPipelineRunId, resumeExecutionId, manifest) {
      calls.assert += 1;
      assert.equal(attemptId, factualRemediationContinuation.attemptId);
      assert.notEqual(continuationPipelineRunId, factualRemediationContinuation.originalPipelineRunId);
      assert.equal(resumeExecutionId, continuationInput.resumeExecutionId);
      assert.deepEqual(manifest, bundle.manifest);
    },
    async finish(input) { calls.finish.push(input); },
  };
};
const continuationInput = {
  attemptId: factualRemediationContinuation.attemptId,
  originalPipelineRunId: factualRemediationContinuation.originalPipelineRunId,
  continuationPipelineRunId: runId,
  resumeExecutionId,
  initial: bundle.initial,
  manifest: bundle.manifest,
};
const attachAccountedCriticTelemetry = (harness, usageKnown = true, overrides = {}) => {
  const critic = harness.stages.critic;
  harness.stages.critic = async (...args) => {
    const outcome = await critic(...args);
    return {
      ...outcome,
      ...(overrides.outcome ?? {}),
      provider: "groq",
      model: "openai/gpt-oss-20b",
      telemetry: {
        provider: "groq",
        model: "openai/gpt-oss-20b",
        providerRequestDispatched: true,
        providerRequestsUsed: 1,
        providerUnit: "tokens",
        providerUnitUsageKnown: usageKnown,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        ...(overrides.telemetry ?? {}),
      },
    };
  };
  return harness;
};
const successHarness = attachAccountedCriticTelemetry(createOfflineStages());
const successGuard = makeGuard();
const successOrchestrator = new PipelineOrchestrator({ stages: successHarness.stages, quota: { ...createStaticPipelineQuota(1), provider: "groq" }, config: createPipelineConfig({ dryRun: false, publish: true, automaticRevision: false }) });
const success = await successOrchestrator.runFactualRemediationContinuation({ ...continuationInput, guard: successGuard });
assert.equal(success.finalState, "SUCCESS");
assert.equal(success.criticDecision, "pass");
assert.deepEqual(successHarness.calls, ["critic", "publisher"]);
assert.equal(successGuard.calls.assert, 1);
assert.equal(successGuard.calls.finish.length, 0, "atomic publish finalizes the continuation");

const reviseHarness = attachAccountedCriticTelemetry(createOfflineStages({ critic: "revise" }));
const reviseGuard = makeGuard();
const reviseOrchestrator = new PipelineOrchestrator({ stages: reviseHarness.stages, quota: { ...createStaticPipelineQuota(1), provider: "groq" }, config: createPipelineConfig({ dryRun: false, publish: true, automaticRevision: false }) });
const revised = await reviseOrchestrator.runFactualRemediationContinuation({ ...continuationInput, guard: reviseGuard });
assert.equal(revised.finalState, "BLOCKED_REVISION_REQUIRED");
assert.deepEqual(reviseHarness.calls, ["critic"], "a non-pass Critic decision never reaches Publisher");
assert.equal(reviseGuard.calls.finish.length, 1);
assert.equal(reviseGuard.calls.finish[0].stopStage, "critic");
assert.equal(reviseGuard.calls.finish[0].providerRequestsUsed, 1);

const rejectHarness = attachAccountedCriticTelemetry(createOfflineStages({ critic: "reject" }));
const rejectGuard = makeGuard();
const rejectOrchestrator = new PipelineOrchestrator({ stages: rejectHarness.stages, quota: { ...createStaticPipelineQuota(1), provider: "groq" }, config: createPipelineConfig({ dryRun: false, publish: true, automaticRevision: false }) });
const rejected = await rejectOrchestrator.runFactualRemediationContinuation({ ...continuationInput, guard: rejectGuard });
assert.equal(rejected.finalState, "BLOCKED_REJECTED");
assert.deepEqual(rejectHarness.calls, ["critic"]);
assert.equal(rejectGuard.calls.finish[0].criticDecision, "reject");

const unknownUsageHarness = attachAccountedCriticTelemetry(createOfflineStages(), false);
const unknownUsageGuard = makeGuard();
const unknownUsageOrchestrator = new PipelineOrchestrator({ stages: unknownUsageHarness.stages, quota: { ...createStaticPipelineQuota(1), provider: "groq" }, config: createPipelineConfig({ dryRun: false, publish: true, automaticRevision: false }) });
const unknownUsage = await unknownUsageOrchestrator.runFactualRemediationContinuation({ ...continuationInput, guard: unknownUsageGuard });
assert.equal(unknownUsage.finalState, "FAILED");
assert.equal(unknownUsage.stopReason, "FACTUAL_REMEDIATION_CRITIC_USAGE_UNKNOWN");
assert.deepEqual(unknownUsageHarness.calls, ["critic"], "Publisher is never reached when Critic usage is unknown");
assert.equal(unknownUsageGuard.calls.finish[0].providerRequestsUsed, 1, "the dispatched Critic request remains accounted in the lifecycle stop");

const reservationOnlyHarness = attachAccountedCriticTelemetry(createOfflineStages(), true, {
  outcome: { providerRequestsUsed: 0 },
  telemetry: {
    providerRequestDispatched: false,
    providerRequestsUsed: 0,
    providerUnitUsageKnown: false,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: undefined,
  },
});
const reservationOnlyGuard = makeGuard();
const reservationOnlyOrchestrator = new PipelineOrchestrator({ stages: reservationOnlyHarness.stages, quota: { ...createStaticPipelineQuota(1), provider: "groq" }, config: createPipelineConfig({ dryRun: false, publish: true, automaticRevision: false }) });
const reservationOnly = await reservationOnlyOrchestrator.runFactualRemediationContinuation({ ...continuationInput, guard: reservationOnlyGuard });
assert.equal(reservationOnly.finalState, "FAILED");
assert.equal(reservationOnly.stopReason, "FACTUAL_REMEDIATION_CRITIC_USAGE_UNKNOWN");
assert.deepEqual(reservationOnlyHarness.calls, ["critic"], "an estimate/reservation without dispatched settled usage cannot reach Publisher");
assert.equal(reservationOnlyGuard.calls.finish[0].providerRequestsUsed, 0);

const absentCriticHarness = createOfflineStages();
const absentCriticOrchestrator = new PipelineOrchestrator({ stages: absentCriticHarness.stages, quota: { ...createStaticPipelineQuota(0), provider: "groq" }, config: createPipelineConfig({ dryRun: false, publish: true, automaticRevision: false }) });
const absentCritic = await absentCriticOrchestrator.runFactualRemediationContinuation({ ...continuationInput, guard: makeGuard() });
assert.equal(absentCritic.finalState, "BLOCKED");
assert.deepEqual(absentCriticHarness.calls, [], "without an admitted Critic stage Publisher is never reached");

const failingHarness = createOfflineStages({ critic: "fail" });
const failingGuard = makeGuard();
const failingOrchestrator = new PipelineOrchestrator({ stages: failingHarness.stages, quota: { ...createStaticPipelineQuota(1), provider: "groq" }, config: createPipelineConfig({ dryRun: false, publish: true, automaticRevision: false }) });
const failed = await failingOrchestrator.runFactualRemediationContinuation({ ...continuationInput, guard: failingGuard });
assert.equal(failed.finalState, "FAILED");
assert.deepEqual(failingHarness.calls, ["critic"]);
assert.equal(failingGuard.calls.finish.length, 1);
assert.equal(failingGuard.calls.finish[0].criticDecision, null);

const wrongLineage = structuredClone(bundle.initial);
wrongLineage.event.eventKey = "event-other";
await assert.rejects(() => successOrchestrator.runFactualRemediationContinuation({ ...continuationInput, initial: wrongLineage, guard: makeGuard() }), /CHECKPOINT_LINEAGE_INVALID/);

console.log("Factual remediation continuation lifecycle fixtures passed");
