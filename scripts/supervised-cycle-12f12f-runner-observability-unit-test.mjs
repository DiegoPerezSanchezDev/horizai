import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  artifactCanStartRun,
  captureSafeRunnerError,
  classifyPreflightFailure,
  PreflightRunnerObservability,
  runObservedPhase,
} from "../lib/agents/pipeline/preflight-runner-observability.ts";
import { isAllowedSupabaseRequest } from "../lib/supabase/readonly-request-guard.ts";

const supabaseSecret = "synthetic-supabase-secret-value";
const groqSecret = ["gsk_", "synthetic_groq_key_value_123456789"].join("");
const databasePassword = "synthetic-db-password-value";
const databaseUrl = ["postgresql://dbuser:", databasePassword, "@db.invalid/app"].join("");
const assignments = ["SUPABASE_SECRET_KEY=", supabaseSecret, "; AGENT_API_KEY=", groqSecret].join("");
const secrets = [supabaseSecret, groqSecret, databasePassword];
const guardPolicy = {
  phase: "PREFLIGHT",
  readTables: new Set(["regions", "pipeline_event_attempts", "agent_runs", "agent_logs"]),
  readRpcs: new Set(["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator", "get_pipeline_human_review_operator_inspect"]),
  resumeRpcs: new Set(["claim_pipeline_event_attempt_capacity_resume_m35", "create_pipeline_human_review"]),
};
assert.equal(isAllowedSupabaseRequest({ ...guardPolicy, pathname: "/rest/v1/regions", method: "GET" }), true);
assert.equal(isAllowedSupabaseRequest({ ...guardPolicy, pathname: "/rest/v1/rpc/get_pipeline_human_review_operator_status", method: "POST" }), true);
assert.equal(isAllowedSupabaseRequest({ ...guardPolicy, pathname: "/rest/v1/rpc/claim_pipeline_event_attempt_capacity_resume_m35", method: "POST" }), false);
assert.equal(isAllowedSupabaseRequest({ ...guardPolicy, pathname: "/rest/v1/rpc/create_pipeline_human_review", method: "POST", phase: "RESUME" }), true);
assert.equal(isAllowedSupabaseRequest({ ...guardPolicy, pathname: "/rest/v1/agent_runs", method: "PATCH", phase: "RESUME" }), true);
assert.equal(isAllowedSupabaseRequest({ ...guardPolicy, pathname: "/rest/v1/articles", method: "POST", phase: "RESUME" }), false);
assert.equal(isAllowedSupabaseRequest({ ...guardPolicy, pathname: "/rest/v2/regions", method: "GET" }), false);
assert.equal(isAllowedSupabaseRequest({ ...guardPolicy, pathname: "/rest/v1/regions/extra", method: "GET" }), false);
const nested = new Error(["nested failure; Authorization: Bearer ", supabaseSecret].join(""));
nested.code = "ECAUSE";
const root = new TypeError(["preflight setup failed; ", assignments, "; ", databaseUrl].join(""), { cause: nested });
root.code = "ESETUP";
const safe = captureSafeRunnerError({ error: root, phase: "PREFLIGHT_START", step: "create private client", secretValues: secrets });
const safeText = JSON.stringify(safe);
assert.equal(safe.name, "TypeError");
assert.equal(safe.code, "ESETUP");
assert.match(safe.message, /preflight setup failed/);
assert.equal(safe.causeChain[0].code, "ECAUSE");
assert.match(safe.causeChain[0].message, /nested failure/);
assert.match(safe.safeStack ?? "", /TypeError/);
assert.match(safe.safeStackFingerprint ?? "", /^[a-f0-9]{64}$/);
for (const secret of secrets) assert.equal(safeText.includes(secret), false, `secret leaked: ${secret}`);
assert.match(safe.message, /\[REDACTED\]/);
assert.match(safe.message, /\[REDACTED_DATABASE_URL\]/);
const httpsCredentialUrl = ["https://svc:", "synthetic-url-password", "@example.invalid/rest?apikey=", "synthetic-query-key"].join("");
const safeUrlError = captureSafeRunnerError({ error: new Error(httpsCredentialUrl), phase: "PREFLIGHT_START" });
assert.equal(JSON.stringify(safeUrlError).includes("synthetic-url-password"), false);
assert.equal(JSON.stringify(safeUrlError).includes("synthetic-query-key"), false);

const postgrest = captureSafeRunnerError({
  error: { name: "PostgrestError", code: "PGRST303", message: ["denied: SUPABASE_SECRET_KEY=", supabaseSecret].join(""), details: ["database password ", databasePassword].join(""), hint: "check request" },
  phase: "ATTEMPT_READ_START",
  secretValues: secrets,
});
assert.equal(postgrest.name, "PostgrestError");
assert.equal(postgrest.code, "PGRST303");
assert.match(postgrest.details ?? "", /database password/);
assert.equal(JSON.stringify(postgrest).includes(databasePassword), false);

const stringThrow = captureSafeRunnerError({ error: "synthetic string throw", phase: "PREFLIGHT_START" });
assert.equal(stringThrow.name, "NonErrorThrow");
assert.equal(stringThrow.message, "synthetic string throw");
const objectThrow = captureSafeRunnerError({ error: { message: "plain object throw", code: "EPLAIN" }, phase: "PREFLIGHT_START" });
assert.equal(objectThrow.name, "NonErrorThrow");
assert.equal(objectThrow.code, "EPLAIN");

const beforeFetch = new PreflightRunnerObservability(secrets);
beforeFetch.enter("PREFLIGHT_START", "preflight dependency initialization");
const beforeError = new Error("exact local setup failure");
beforeError.code = "ELOCAL";
const beforeSafe = beforeFetch.capture(beforeError);
assert.equal(beforeSafe.message, "exact local setup failure");
assert.equal(beforeSafe.code, "ELOCAL");
assert.equal(beforeFetch.snapshot().remoteRequestCount, 0);
assert.equal(classifyPreflightFailure({ phase: beforeFetch.snapshot().failingPhase, remoteRequestCount: 0 }), "LOCAL_PREFLIGHT_FAILURE");

const afterFetch = new PreflightRunnerObservability(secrets);
afterFetch.enter("PREFLIGHT_START", "synthetic Supabase fetch");
afterFetch.remoteRequestStarted("GET /rest/v1/regions");
const fetchError = new TypeError("synthetic fetch failure");
fetchError.code = "ECONNRESET";
const fetchSafe = afterFetch.capture(fetchError);
assert.equal(fetchSafe.message, "synthetic fetch failure");
assert.equal(afterFetch.snapshot().remoteRequestCount, 1);
assert.equal(afterFetch.snapshot().firstRemoteOperation, "GET /rest/v1/regions");
assert.equal(classifyPreflightFailure({ phase: afterFetch.snapshot().failingPhase, remoteRequestCount: 1, remoteFailureOccurred: true }), "REMOTE_PREFLIGHT_FAILURE");
assert.equal(classifyPreflightFailure({ phase: "PREFLIGHT_COMPLETE", remoteRequestCount: 3, remoteFailureOccurred: false }), "LOCAL_PREFLIGHT_FAILURE");
const postgrestBoundary = new PreflightRunnerObservability(secrets);
postgrestBoundary.enter("PREFLIGHT_START", "synthetic HTTP/PostgREST response");
postgrestBoundary.remoteRequestStarted("GET /rest/v1/regions");
postgrestBoundary.remoteResponseReceived("GET /rest/v1/regions", 401);
const postgrestFailure = captureSafeRunnerError({
  error: { name: "PostgrestError", code: "PGRST303", message: "synthetic permission failure", details: "role denied", hint: "check test fixture" },
  phase: "PREFLIGHT_START",
  secretValues: secrets,
});
assert.equal(postgrestBoundary.snapshot().firstRemoteHttpStatus, 401);
assert.equal(postgrestFailure.code, "PGRST303");
assert.equal(classifyPreflightFailure({ phase: postgrestBoundary.snapshot().failingPhase, remoteRequestCount: 1, remoteFailureOccurred: true }), "REMOTE_PREFLIGHT_FAILURE");
assert.equal(artifactCanStartRun(["result.json", "invocation.json"], (path) => path === "invocation.json"), false);
assert.equal(artifactCanStartRun(["result.json", "invocation.json"], () => false), true);

const runnerSource = readFileSync(new URL("./supervised-cycle-12f12e-critic-resume.mjs", import.meta.url), "utf8");
// Exercise the actual attempt-validation block with in-memory reads. This catches
// a temporal-dead-zone failure after HTTP succeeds, without a remote preflight.
const attemptValidation = runnerSource.slice(
  runnerSource.indexOf("  const target = attempts.find", runnerSource.indexOf("async function baselineRead")),
  runnerSource.indexOf("  const currentPublic = publicState", runnerSource.indexOf("async function baselineRead")),
);
const fixtureSnapshot = {
  resumeStage: "critic", resumeGeneration: 1, nextStageDispatchCount: 0,
  nextStageCheckpointPresent: false,
  checkpoints: Object.fromEntries(["verifier", "translator", "editor", "classifier", "ranker"].map((stage) => [stage, "fixture"])),
};
const fixtureTarget = {
  id: "fixture-attempt", event_key: "fixture-event", pipeline_run_id: "fixture-run",
  completed_at: null, final_state: null, stop_stage: "critic",
  stop_reason: "PROVIDER_CAPACITY_EXHAUSTED", retry_class: "NONE",
  counts_toward_retry_limit: false, capacity_resume_snapshot: fixtureSnapshot,
};
const fixtureOutput = {};
const validateAttempt = new (Object.getPrototypeOf(async function () {}).constructor)("context", `
  const { assert, attempts, attemptId, eventKey, pipelineRunId, attemptCounts,
    readCapacityResumeSnapshot, snapshotPath, parseCapacityResumeSnapshot,
    capacityResumeSnapshotsMatch, budgetSnapshot, priorStages, checkpointProof,
    preflightObservabilityMode, output } = context;
  ${attemptValidation}
  return { snapshot, checks };
`);
await validateAttempt({
  assert, attempts: [fixtureTarget], attemptId: fixtureTarget.id,
  eventKey: fixtureTarget.event_key, pipelineRunId: fixtureTarget.pipeline_run_id,
  attemptCounts: () => ({ real: Array(19).fill(fixtureTarget), counts: [0, 1, 0] }),
  readCapacityResumeSnapshot: async () => ({ snapshot: fixtureSnapshot }), snapshotPath: "fixture",
  parseCapacityResumeSnapshot: (value) => value,
  capacityResumeSnapshotsMatch: (local, remote) => local === remote,
  budgetSnapshot: fixtureSnapshot,
  priorStages: Object.keys(fixtureSnapshot.checkpoints), checkpointProof: async () => ({ status: "PASS" }),
  preflightObservabilityMode: true, output: fixtureOutput,
});
assert.equal(fixtureOutput.attemptReadResult.status, "PASS");
assert.equal(fixtureOutput.attemptReadResult.attempt.generation, 1);
assert.equal(fixtureOutput.attemptReadResult.attempt.criticDispatches, 0);
assert.match(runnerSource, /const preflightObservabilityMode = dnsRecoveryPreflightMode \|\|/);
assert.match(runnerSource, /--dns-recovery-preflight-12f12g1/);
assert.match(runnerSource, /artifacts\/supervised-cycle-12f12g1-dns-recovery\.json/);
const observabilitySource = readFileSync(new URL("../lib/agents/pipeline/preflight-runner-observability.ts", import.meta.url), "utf8");
assert.match(runnerSource, /runObservedPhase\(observability, "PREFLIGHT_START"/);
assert.match(runnerSource, /runObservedPhase\(observability, "ATTEMPT_READ_START"/);
for (const phase of ["RUNNER_START", "ENV_VALIDATED", "ARTIFACT_PRECONDITION_VALIDATED", "PIPELINE_CONSTRUCTION_START", "PIPELINE_CONSTRUCTION_COMPLETE", "PREFLIGHT_START", "PREFLIGHT_CLIENT_READY", "ATTEMPT_READ_START", "FIRST_REMOTE_REQUEST_START", "FIRST_REMOTE_RESPONSE_RECEIVED", "PREFLIGHT_COMPLETE"]) {
  assert.ok(runnerSource.includes(`"${phase}"`) || observabilitySource.includes(`"${phase}"`), `runner phase marker missing: ${phase}`);
}
const readonlyBranch = runnerSource.indexOf('if (preflightObservabilityMode) {\n    observability.complete("PREFLIGHT_COMPLETE"');
const readonlyReturn = runnerSource.indexOf("return;\n  }\n  const snapshot = state.snapshot;", readonlyBranch);
const resumeCall = runnerSource.indexOf("resumeCapacityDeferred", readonlyBranch);
assert.ok(readonlyBranch >= 0 && readonlyReturn > readonlyBranch && resumeCall > readonlyReturn, "preflight-only branch must return before claim/resume code");
assert.match(runnerSource.slice(readonlyBranch, readonlyReturn), /output\.claim = "NOT_RUN"/);
assert.match(runnerSource.slice(readonlyBranch, readonlyReturn), /output\.resume = \{ invocationCount: 0/);

const [{ ProviderScopedDailyRequestBudget }, { createCapacityResumeProductionPipeline }] = await Promise.all([
  import("../lib/agents/runtime/request-budget.ts"),
  import("./capacity-resume-production-pipeline.ts"),
]);
assert.ok(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), "server environment must be loaded without logging its value");
assert.ok(process.env.SUPABASE_SECRET_KEY?.trim(), "privileged credential must be loaded without logging its value");

const originalFetch = globalThis.fetch;
const pipelineBoundary = new PreflightRunnerObservability(secrets);
let activeBoundary = pipelineBoundary;
const fakeCalls = [];
let rejectNextFetch = false;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const operation = request.method.toUpperCase() + " " + url.pathname;
  fakeCalls.push({ operation, host: url.hostname });
  activeBoundary.remoteRequestStarted(operation);
  if (rejectNextFetch) throw new Error("synthetic mocked fetch rejection");
  activeBoundary.remoteResponseReceived(operation, 200);
  return new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "0-0/0" } });
};

try {
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(), 18);
  for (let count = 0; count < 5; count += 1) budget.reserve("groq", 18);
  pipelineBoundary.enter("PIPELINE_CONSTRUCTION_START", "createCapacityResumeProductionPipeline");
  const constructed = createCapacityResumeProductionPipeline({ requestBudget: budget, pipelineRunId: "12f12f-local-observability-probe" });
  pipelineBoundary.complete("PIPELINE_CONSTRUCTION_COMPLETE", "pipeline constructed");
  assert.equal(typeof constructed.pipeline.preflight, "function");
  pipelineBoundary.complete("PREFLIGHT_CLIENT_READY", "Supabase client and preflight function ready");
  const preflightResult = await runObservedPhase(pipelineBoundary, "PREFLIGHT_START", "pipeline.preflight with mocked fetch", () => constructed.pipeline.preflight());
  assert.equal(preflightResult.supabaseConnected, true);
  assert.ok(fakeCalls.length >= 1, "mocked pipeline preflight must reach the network boundary");
  const attemptRead = await runObservedPhase(pipelineBoundary, "ATTEMPT_READ_START", "read target attempt using mocked fetch", () => constructed.supabase.from("pipeline_event_attempts").select("id").limit(1));
  assert.equal(attemptRead.error, null);
  assert.ok(pipelineBoundary.snapshot().phaseMarkers.some((marker) => marker.phase === "FIRST_REMOTE_REQUEST_START"));
  assert.ok(pipelineBoundary.snapshot().phaseMarkers.some((marker) => marker.phase === "FIRST_REMOTE_RESPONSE_RECEIVED"));
  assert.ok(pipelineBoundary.snapshot().phaseMarkers.some((marker) => marker.phase === "ATTEMPT_READ_START"));
  assert.equal(pipelineBoundary.snapshot().remoteRequestCount, fakeCalls.length);
  assert.equal(fakeCalls.some((call) => call.host === "api.groq.com"), false);
  assert.equal(fakeCalls.every((call) => /^(GET|HEAD) /.test(call.operation)), true, "local mocked preflight uses read-only table requests: " + JSON.stringify(fakeCalls));
  pipelineBoundary.complete("PREFLIGHT_COMPLETE", "mocked attempt read returned");

  rejectNextFetch = true;
  const failureBoundary = new PreflightRunnerObservability(secrets);
  activeBoundary = failureBoundary;
  let capturedFetchFailure;
  try {
    await runObservedPhase(failureBoundary, "PREFLIGHT_START", "mocked remote failure", async () => {
      const response = await constructed.supabase.from("regions").select("id").limit(1);
      if (response.error) throw new Error("SUPABASE_READ_FAILED", { cause: response.error });
      return response;
    });
  } catch (error) {
    capturedFetchFailure = error;
  }
  capturedFetchFailure ??= new Error("synthetic Supabase read failure");
  const safeFetchFailure = failureBoundary.capture(capturedFetchFailure);
  assert.equal(safeFetchFailure.message.length > 0, true);
  assert.ok(failureBoundary.snapshot().remoteRequestCount >= 1);
  assert.equal(safeFetchFailure.causeChain.some((cause) => cause.message.includes("synthetic mocked fetch rejection")), true);
  assert.equal(classifyPreflightFailure({ phase: failureBoundary.snapshot().failingPhase, remoteRequestCount: failureBoundary.snapshot().remoteRequestCount, remoteFailureOccurred: true }), "REMOTE_PREFLIGHT_FAILURE");
  assert.equal(fakeCalls.every((call) => call.host !== "api.groq.com"), true);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({
  result: "PASS",
  errorSerialization: "PASS",
  redaction: "PASS",
  artifactPrecondition: "PASS",
  localFailureClassification: "PASS",
  syntheticRemoteFailureClassification: "PASS",
  productionPipelineConstruction: "PASS",
  preflightClientSetup: "PASS",
  attemptReadBoundary: "PASS",
  remoteRequestsMocked: fakeCalls.length,
  remoteWritesMocked: 0,
  claims: 0,
  resumeInvocations: 0,
  providerCalls: 0,
}));
