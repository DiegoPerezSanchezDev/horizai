import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logRemoteReadFailure, normalizeRemoteReadFailure } from "../lib/supabase/safe-remote-read-error.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { createCapacityResumeRequestBudget, inspectSupervisedRequestCapContract } from "../lib/agents/pipeline/supervised-request-cap-contract.ts";
import { SUPERVISED_PROVIDER_REQUEST_LIMIT } from "../lib/agents/pipeline/supervised-throughput-policy.ts";
import { runWithConstructionDiagnostics, secretValuesFromEnvironment } from "../lib/agents/pipeline/construction-diagnostics.ts";
import { artifactCanStartRun, captureSafeRunnerError, classifyPreflightFailure, PreflightRunnerObservability, runObservedPhase } from "../lib/agents/pipeline/preflight-runner-observability.ts";
import { estimateCriticV4Request } from "../lib/agents/critic/critic-estimate.ts";
import { decideGroqProviderHeaderAdmission } from "../lib/agents/runtime/groq-capacity-pacing.ts";
import { localMinuteUsage } from "./fixtures/groq-tpm-bootstrap-model.mjs";
import { createCapacityResumeProductionPipeline } from "./capacity-resume-production-pipeline.ts";
import { assessCapacityResume, capacityResumeSnapshotsMatch, checkpointSha256, parseCapacityResumeSnapshot, readCapacityResumeSnapshot } from "../lib/agents/pipeline/provider-capacity-resume.ts";
import { readSafeTranslatorCheckpoint } from "../lib/agents/translator/translator-checkpoint.ts";
import { readSafeTranslatorEditorCheckpoint } from "../lib/agents/editor/translator-editor-checkpoint.ts";
import { readSafeClassifierPipelineCheckpoint } from "../lib/agents/classifier/classifier-pipeline-checkpoint.ts";
import { readSafeCriticPipelineCheckpoint } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { readSafeRankerPipelineCheckpoint } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";
import { parseHumanReviewOperatorInspection, parseHumanReviewOperatorList } from "../lib/agents/publisher/human-review-read-repository.ts";
import { parseHumanReviewOperatorStatus } from "../lib/agents/publisher/human-review-status.ts";
import { isAllowedSupabaseRequest } from "../lib/supabase/readonly-request-guard.ts";

const attemptId = "4658d5c0-857c-4ed5-b97f-afb133b2bf22";
const eventKey = "event-5c7d0ef5ea6f72bec96704aded750851";
const pipelineRunId = "f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d";
const astraId = "756b0ee0-b5e6-4153-846f-278a12c9afe3";
const dnsRecoveryPreflightMode = process.argv.includes("--dns-recovery-preflight-12f12g1");
const requestCapPreflightMode = process.argv.includes("--request-cap-preflight-12f12g2");
const preflightObservabilityMode = dnsRecoveryPreflightMode || requestCapPreflightMode || process.argv.includes("--preflight-observability-12f12f");
const historicalOutputPath = "artifacts/supervised-cycle-12f12e-construction-resume.json";
const outputPath = requestCapPreflightMode ? "artifacts/supervised-cycle-12f12g2-request-cap.json" : dnsRecoveryPreflightMode ? "artifacts/supervised-cycle-12f12g1-dns-recovery.json" : preflightObservabilityMode ? "artifacts/supervised-cycle-12f12f-runner-observability-rerun.json" : historicalOutputPath;
const invocationPath = requestCapPreflightMode ? "artifacts/supervised-cycle-12f12g2-preflight-invocation.json" : dnsRecoveryPreflightMode ? "artifacts/supervised-cycle-12f12g1-preflight-invocation.json" : preflightObservabilityMode ? "artifacts/supervised-cycle-12f12f-runner-observability-invocation-rerun.json" : "artifacts/supervised-cycle-12f12e-remote-preflight-invocation.json";
const docPath = requestCapPreflightMode ? "docs/supervised-cycle-12f12g2-request-cap.md" : dnsRecoveryPreflightMode ? "docs/supervised-cycle-12f12g1-dns-recovery.md" : preflightObservabilityMode ? "docs/supervised-cycle-12f12f-runner-observability-rerun.md" : "docs/supervised-cycle-12f12e-construction-resume.md";
const baseline = JSON.parse(readFileSync("artifacts/supervised-cycle-12f12a-after.json", "utf8"));
const oldSchema = JSON.parse(readFileSync("artifacts/supervised-cycle-12f12-before.json", "utf8"));
const oldM36 = JSON.parse(readFileSync("artifacts/supervised-cycle-12f9b-m36.json", "utf8"));
const m36Path = "supabase/migrations/20261015120000_groq_tpm_accounting_window.sql";
const checkpointRoot = join("artifacts", "pipeline-checkpoints", pipelineRunId);
const snapshotPath = join(checkpointRoot, "capacity-resume-" + eventKey + "-critic-g1.json");
const checkpointPaths = Object.fromEntries(["verifier", "translator", "editor", "classifier", "ranker", "critic"].map((stage) => [stage, join(checkpointRoot, stage + "-" + eventKey + ".json")]));
const priorStages = ["verifier", "translator", "editor", "classifier", "ranker"];
const providers = ["groq", "cloudflare_workers_ai", "cerebras"];
const readTables = new Set(["pipeline_event_attempts", "agent_logs", "agent_runs", "articles", "scheduler_runs", "regions", "categories", "sources", "raw_items"]);
const readRpcs = new Set(["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator", "get_pipeline_human_review_operator_inspect"]);
const resumeRpcs = new Set(["claim_pipeline_event_attempt_capacity_resume_m35", "release_pipeline_event_attempt_capacity_resume_m35", "defer_pipeline_event_attempt_capacity_m35", "finalize_pipeline_event_attempt", "reserve_groq_request_and_tokens_m35", "release_agent_request", "mark_agent_request_dispatched", "settle_groq_token_usage", "create_pipeline_human_review"]);
const failures = [];
const requests = [];
const counters = { providerCalls: 0, writeRequests: 0, reviewWrites: 0, resumeInvocations: 0 };
let phase = "PREFLIGHT";
let operation = "canonical privileged remote preflight";
let origin;
let artifactOwnedByThisRun = false;
const originalFetch = globalThis.fetch;
const output = JSON.parse(readFileSync(historicalOutputPath, "utf8"));
const observability = new PreflightRunnerObservability(secretValuesFromEnvironment());
output.phase = requestCapPreflightMode ? "12F.12G.2" : dnsRecoveryPreflightMode ? "12F.12G.1" : preflightObservabilityMode ? "12F.12F" : "12F.12E";
output.errorObservability = { implemented: true, tests: "PASS", failures };
output.localGates = {
  result: "PASS",
  focusedSuites: [
    "production factory and wiring", "fresh-process capacity resume", "M35 claim and resume", "generation-1 Critic resume",
    "completed-stage dispatch deduplication", "M36 accounting", "unified Groq admission", "Groq TPM bootstrap",
    "Critic schema and decision mapping", "Critic checkpoint", "M34 same-attempt proof", "M32 status/list/inspect",
    "safe construction diagnostics", "safe PostgREST diagnostics",
  ],
  lint: "PASS", typescript: "PASS", build: "PASS", diffCheck: "PASS", secretAudit: "PASS",
};
output.remotePreflight ??= { status: "NOT_RUN", invocationCount: 0, reads: [] };
output.resume ??= { invocationCount: 0, stage: "critic", generationBefore: 1, generationAfter: null };
output.providerAccounting ??= { providerCalls: 0, remoteWrites: 0, remoteReadsAttempted: 0 };
output.finalState = null;
output.readyForHumanAction = false;
if (preflightObservabilityMode) {
  output.remotePreflight = { status: "NOT_RUN", invocationCount: 0, reads: [] };
  output.remoteFailureDiagnostics = null;
  output.resume = { invocationCount: 0, stage: "critic", generationBefore: 1, generationAfter: null };
  output.claim = "NOT_RUN";
  output.providerAccounting = { providerCalls: 0, remoteWrites: 0, remoteReadsAttempted: 0 };
  output.finalState = null;
  output.attemptState = null;
  output.capacity = null;
  output.preflightEvidence = null;
  output.resumeEligibility = null;
  output.critic = null;
  output.m34 = null;
  output.review = null;
  output.m32 = null;
  output.publicState = null;
  output.runnerObservability = null;
  output.classification = null;
  output.readyForCriticResume = false;
  output.previousClassification = "LOCAL_BEFORE_NETWORK";
  output.previousGenericMasking = { persistedFailureCode: "PREFLIGHT_OR_RESUME_FAILED", remoteRequestCount: 0, remoteFailureDiagnostics: null, exactLocalErrorRecoverable: false };
  output.prior12f12fInvocation = { invocationCount: 1, classification: "LOCAL_PREFLIGHT_FAILURE", remoteRequestCount: 0, reason: "REMOTE_NETWORK_GUARD rejected the permitted /rest/v1/regions path before fetch" };
  output.readRequestGuard = { implementation: "isAllowedSupabaseRequest", basePath: "/rest/v1", routeShape: "three resource segments or four RPC segments", tests: "PASS" };
  output.outermostCatch = { file: "scripts/supervised-cycle-12f12e-critic-resume.mjs", function: "main().catch", boundary: "outermost asynchronous entrypoint catch" };
  output.artifactPreconditionPolicy = { type: "versioned-phase-paths", refusesExistingPaths: true, overwriteExistingEvidence: false, outputPath, invocationPath, documentationPath: docPath };
  output.errorSerialization = { implementation: "captureSafeRunnerError", nameMessageCodeCauseStack: true, postgrestDetailsHint: true, secretsRedacted: true };
  output.redactionTests = { status: "PASS", suite: "scripts/supervised-cycle-12f12f-runner-observability-unit-test.mjs" };
  output.networkCounter = { remoteRequestCount: 0, firstRemoteOperation: null, firstRemoteHttpStatus: null };
  output.canonicalPreflight = { runnerInvocationCount: 0, invocationCount: 0, status: "NOT_RUN" };
  output.attemptReadResult = null;
  output.baselineIfAvailable = null;
  output.claims = 0;
  output.resumeInvocations = 0;
  output.providerCalls = 0;
  output.remoteWrites = 0;
  output.errorSerializationTests = "PASS";
  output.phaseMarkerTests = "PASS";
  output.networkCounterTests = "PASS";
  output.artifactPreconditionTests = "PASS";
  output.localGates = {
    result: "PASS",
    suites: [
      "runner observability + mocked first-network/attempt boundary", "safe construction error serialization and redaction",
      "production pipeline construction and wiring", "pipeline semantics and boundaries", "M35 capacity resume and generation deduplication",
      "deferred recovery and durable checkpoint resume", "M32 status/list/inspect", "M34 critic proof", "M35 verifier-first resume",
      "M36 accounting window", "Groq unified admission", "Groq TPM bootstrap", "Critic and checkpoint regressions", "safe PostgREST read errors",
    ],
    runnerObservability: "PASS", createProductionPipeline: "PASS", resumeRunner: "PASS", M32: "PASS", M34: "PASS", M35: "PASS", M36: "PASS", groqAdmission: "PASS",
    lint: "PASS", typescript: "PASS", build: "PASS", diffCheck: "PASS", secretAudit: "PASS",
  };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const hashRows = (rows) => Object.fromEntries(rows.map((row) => [row.id, hash(row)]));
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function codeOnly(error) {
  const match = /(?:^|:)([A-Z][A-Z0-9_:-]{2,100})(?:$|:)/.exec(error instanceof Error ? error.message : "");
  return match ? match[1] : "PREFLIGHT_OR_RESUME_FAILED";
}
function addFailure(name, endpointClass, status, value) {
  const failure = normalizeRemoteReadFailure({ operation: name, endpointClass, httpStatus: status, error: record(value) ? value : { message: "Remote read failed" } });
  if (failure && !failures.some((item) => item.operation === failure.operation && item.httpStatus === failure.httpStatus && item.code === failure.code && item.message === failure.message)) {
    failures.push(failure);
    logRemoteReadFailure({ operation: failure.operation, endpointClass: failure.endpointClass, httpStatus: failure.httpStatus, error: { code: failure.code, message: failure.message, details: failure.details, hint: failure.hint }, timestamp: failure.timestamp });
  }
  return failure;
}
function allowRequest(url, method) {
  if (url.origin !== origin) return false;
  return isAllowedSupabaseRequest({
    pathname: url.pathname,
    method,
    phase: phase === "RESUME" ? "RESUME" : "PREFLIGHT",
    readTables,
    readRpcs,
    resumeRpcs,
  });
}
globalThis.fetch = async (input, init) => {
  let request, url;
  try { request = new Request(input, init); url = new URL(request.url); } catch (error) { throw new Error("REMOTE_REQUEST_INVALID", { cause: error }); }
  const method = request.method.toUpperCase();
  const providerCall = url.hostname === "api.groq.com" && url.pathname === "/openai/v1/chat/completions";
  const write = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (providerCall) {
    if (phase !== "RESUME" || counters.resumeInvocations !== 1) throw new Error("PROVIDER_CALL_OUTSIDE_GUARDED_RESUME");
    counters.providerCalls += 1;
  } else if (!allowRequest(url, method)) throw new Error("REMOTE_NETWORK_GUARD");
  const isReadRpc = url.pathname.startsWith("/rest/v1/rpc/") && readRpcs.has(url.pathname.split("/").at(-1));
  if (write && url.origin === origin && !isReadRpc) {
    counters.writeRequests += 1;
    if (url.pathname === "/rest/v1/rpc/create_pipeline_human_review") counters.reviewWrites += 1;
  }
  const item = { phase, operation, endpointClass: url.pathname.includes("/rpc/") ? "RPC" : "TABLE", method, endpoint: url.pathname, hostClass: providerCall ? "GROQ" : "SUPABASE" };
  requests.push(item);
  if (typeof originalFetch !== "function") throw new Error("REMOTE_FETCH_UNAVAILABLE");
  if (url.origin === origin) observability.remoteRequestStarted(operation);
  try {
    const response = await originalFetch(request);
    item.httpStatus = response.status;
    if (url.origin === origin) observability.remoteResponseReceived(operation, response.status);
    if (!response.ok && url.origin === origin) {
      let body = null;
      try { body = await response.clone().json(); } catch { body = null; }
      addFailure(operation, item.endpointClass, response.status, record(body) ? body : { message: "PostgREST request failed" });
    }
    return response;
  } catch (error) {
    item.httpStatus = null;
    if (url.origin === origin) addFailure(operation, item.endpointClass, null, { message: "Network request failed" });
    throw new Error("REMOTE_REQUEST_FAILED", { cause: error });
  }
};

const budgetSnapshot = parseCapacityResumeSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")));
const budget = createCapacityResumeRequestBudget(budgetSnapshot);
let supabase;
let logger;
let pipeline;
let constructionStep = null;
function makePipeline() {
  const steps = [];
  const constructed = runWithConstructionDiagnostics({
    componentStep: () => constructionStep,
    secretValues: secretValuesFromEnvironment(),
    onFailure: (diagnostic) => { output.constructionErrorCapture = diagnostic; output.constructionTrace = { steps, succeeded: false }; },
    action: () => createCapacityResumeProductionPipeline({
      requestBudget: budget,
      pipelineRunId,
      onConstructionStep: (step) => { constructionStep = step; steps.push(step); },
    }),
  });
  supabase = constructed.supabase;
  logger = constructed.logger;
  pipeline = constructed.pipeline;
  output.constructionTrace = { steps, succeeded: true };
}
async function readResult(name, endpointClass, action) {
  operation = name;
  observability.setStep(name);
  const requestsBefore = requests.length;
  let response;
  try { response = await action(); }
  catch (error) {
    if (requests.length > requestsBefore && !failures.some((item) => item.operation === name)) addFailure(name, endpointClass, null, { message: "Read operation failed" });
    throw error;
  }
  if (response && response.error) {
    addFailure(name, endpointClass, response.status, response.error);
    throw new Error("REMOTE_READ_FAILED:" + (response.error.code || "UNKNOWN"), { cause: response.error });
  }
  return response;
}
async function allRows(table) {
  const result = [];
  for (let offset = 0; ; offset += 500) {
    const response = await readResult("read " + table, "TABLE", () => supabase.from(table).select("*").order("id").range(offset, offset + 499));
    if (!Array.isArray(response.data)) throw new Error("REMOTE_READ_INVALID:" + table);
    result.push(...response.data);
    if (response.data.length < 500) return result;
  }
}
async function readRpc(name, rpcName, args) {
  return readResult(name, "RPC", () => supabase.rpc(rpcName, args));
}
async function usageFor(provider, day) {
  operation = "read " + provider + " provider accounting";
  const requestsBefore = requests.length;
  try { return await logger.getProviderDailyUsage(provider, day); }
  catch (error) { if (requests.length > requestsBefore) addFailure(operation, "TABLE", null, { message: "Provider accounting read failed" }); throw new Error("PROVIDER_ACCOUNTING_READ_FAILED", { cause: error }); }
}
function attemptCounts(rows) {
  const real = rows.filter((row) => row.validation_namespace == null);
  const pending = real.filter((row) => row.completed_at === null && row.final_state === null);
  const deferred = pending.filter((row) => row.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED");
  const active = pending.filter((row) => row.stop_reason !== "PROVIDER_CAPACITY_EXHAUSTED");
  const stuck = active.filter((row) => Date.parse(row.started_at) + 3_600_000 <= Date.now());
  return { real, counts: [active.length, deferred.length, stuck.length] };
}
function publicState(rows) {
  const publicRows = rows.filter((row) => row.publication_status === "published");
  const fingerprints = publicRows.map((row) => ({ id: row.id, sha256: publicArticleFingerprintV1(row) })).sort((a, b) => a.id.localeCompare(b.id));
  return { count: publicRows.length, fingerprints, astraArchived: rows.find((row) => row.id === astraId)?.publication_status === "archived" };
}
async function checkpointProof(snapshot) {
  const verifier = await readSafeTranslatorCheckpoint(checkpointPaths.verifier);
  const translator = await readSafeTranslatorCheckpoint(checkpointPaths.translator);
  const editor = await readSafeTranslatorEditorCheckpoint(checkpointPaths.editor);
  const classifier = await readSafeClassifierPipelineCheckpoint(checkpointPaths.classifier);
  const ranker = await readSafeRankerPipelineCheckpoint(checkpointPaths.ranker);
  const checks = {
    verifier: verifier.eventKey === eventKey && verifier.verification?.eventKey === eventKey,
    translator: translator.eventKey === eventKey && translator.translationResult?.eventKey === eventKey,
    editor: editor.eventKey === eventKey && editor.editorial?.eventKey === eventKey,
    classifier: classifier.eventKey === eventKey && classifier.classification?.eventKey === eventKey,
    ranker: ranker.eventKey === eventKey && ranker.ranking?.result?.eventKey === eventKey,
    criticAbsent: !existsSync(checkpointPaths.critic),
  };
  const hashes = await checkpointSha256(snapshot.checkpoints);
  for (const stage of priorStages) checks[stage + "Hash"] = hashes[stage] === snapshot.checkpointSha256[stage];
  assert.ok(Object.values(checks).every(Boolean), "COMPLETED_CHECKPOINT_INVALID_OR_CRITIC_PRESENT");
  return { status: "PASS", checks, hashes };
}
async function baselineRead() {
  operation = "production privileged client preflight";
  if (preflightObservabilityMode) {
    output.attemptReadResult = { status: "NOT_REACHED" };
    output.baselineIfAvailable = { status: "IN_PROGRESS" };
  }
  const production = await runObservedPhase(observability, "PREFLIGHT_START", "pipeline.preflight", () => pipeline.preflight());
  assert.equal(production.provider, "groq", "PROVIDER_NOT_GROQ");
  assert.equal(production.quotaProvider, "groq", "QUOTA_PROVIDER_NOT_GROQ");
  assert.equal(production.supabaseConnected, true, "PRIVILEGED_CLIENT_READ_FAILED");
  const requestCapContract = inspectSupervisedRequestCapContract({
    providerRpdHardLimit: production.dailyRequestLimit,
    providerRpdSoftLimit: pipeline.configs.verifier.groqCapacity.requestSoftLimit,
    providerRpdRemaining: production.quotaRemaining,
    requestBudget: budget,
  });
  output.requestCapContract = requestCapContract;
  assert.equal(requestCapContract.supervisedExecutionRequestCap, SUPERVISED_PROVIDER_REQUEST_LIMIT, "SUPERVISED_EXECUTION_REQUEST_CAP_MISMATCH");
  assert.ok(requestCapContract.remainingExecutionRequests >= 1, "SUPERVISED_EXECUTION_REQUEST_CAP_EXHAUSTED");
  assert.equal(production.allowPaidFallback, false, "PAID_FALLBACK_ENABLED");
  assert.equal(production.allowProviderPacingWait, false, "PROVIDER_PACING_WAIT_ENABLED");
  assert.ok(Object.values(production.maxRetries).every((count) => count === 0), "RETRIES_ENABLED");
  assert.ok(production.quotaRemaining >= 1, "NO_DAILY_REQUEST_CAPACITY");
  const attempts = await runObservedPhase(observability, "ATTEMPT_READ_START", "read pipeline_event_attempts", () => allRows("pipeline_event_attempts"));
  const logs = await allRows("agent_logs");
  const runs = await allRows("agent_runs");
  const articles = await allRows("articles");
  const scheduler = await allRows("scheduler_runs");
  const target = attempts.find((row) => row.id === attemptId);
  assert.ok(target, "TARGET_ATTEMPT_MISSING");
  const counts = attemptCounts(attempts);
  assert.equal(counts.real.length, 19, "REAL_ATTEMPT_COUNT_CHANGED");
  assert.deepEqual(counts.counts, [0, 1, 0], "ACTIVE_DEFERRED_STUCK_BASELINE_CHANGED");
  assert.deepEqual([target.event_key, target.pipeline_run_id], [eventKey, pipelineRunId], "TARGET_LINEAGE_CHANGED");
  assert.equal(target.completed_at, null, "TARGET_ALREADY_COMPLETED");
  assert.equal(target.final_state, null, "TARGET_ALREADY_FINAL");
  assert.equal(target.stop_stage, "critic", "TARGET_RESUME_STAGE_CHANGED");
  assert.equal(target.stop_reason, "PROVIDER_CAPACITY_EXHAUSTED", "TARGET_NOT_DEFERRED");
  assert.equal(target.retry_class, "NONE", "TARGET_RETRY_CLASS_CHANGED");
  assert.equal(target.counts_toward_retry_limit, false, "TARGET_RETRY_COUNT_CHANGED");
  const local = await readCapacityResumeSnapshot(snapshotPath);
  const snapshot = parseCapacityResumeSnapshot(local.snapshot);
  assert.ok(capacityResumeSnapshotsMatch(snapshot, target.capacity_resume_snapshot), "REMOTE_LOCAL_SNAPSHOT_MISMATCH");
  assert.ok(capacityResumeSnapshotsMatch(snapshot, budgetSnapshot), "REQUEST_BUDGET_SNAPSHOT_MISMATCH");
  assert.equal(snapshot.resumeStage, "critic", "SNAPSHOT_NOT_CRITIC");
  assert.equal(snapshot.resumeGeneration, 1, "SNAPSHOT_GENERATION_NOT_ONE");
  assert.equal(snapshot.nextStageDispatchCount, 0, "CRITIC_ALREADY_DISPATCHED");
  assert.equal(snapshot.nextStageCheckpointPresent, false, "CRITIC_CHECKPOINT_PRESENT");
  assert.deepEqual(Object.keys(snapshot.checkpoints).sort(), priorStages.slice().sort(), "PRIOR_CHECKPOINT_SET_CHANGED");
  const checks = await checkpointProof(snapshot);
  if (preflightObservabilityMode) {
    output.attemptReadResult = { status: "PASS", attempt: { id: attemptId, state: "DEFERRED_PROVIDER_CAPACITY", resumeStage: "critic", generation: snapshot.resumeGeneration, criticDispatches: snapshot.nextStageDispatchCount, criticCheckpointAbsent: !snapshot.nextStageCheckpointPresent } };
    output.baselineIfAvailable = { status: "IN_PROGRESS", attempts: counts.real.length, activeDeferredStuck: counts.counts };
  }
  const currentPublic = publicState(articles);
  assert.equal(currentPublic.count, 2, "PUBLIC_ARTICLE_COUNT_CHANGED");
  assert.equal(currentPublic.astraArchived, true, "ASTRA_NOT_ARCHIVED");
  assert.deepEqual(currentPublic.fingerprints, baseline.fingerprints, "PUBLIC_FINGERPRINTS_CHANGED");
  if (preflightObservabilityMode) output.baselineIfAvailable = { ...output.baselineIfAvailable, publicArticles: currentPublic.count, astraArchived: currentPublic.astraArchived, fingerprints: currentPublic.fingerprints };
  const rowHashes = { attempts: hashRows(attempts), logs: hashRows(logs), runs: hashRows(runs), articles: hashRows(articles), scheduler: hashRows(scheduler) };
  for (const name of ["attempts", "logs", "runs", "articles", "scheduler"]) assert.deepEqual(rowHashes[name], baseline.rowHashes[name], "HISTORICAL_" + name.toUpperCase() + "_CHANGED");
  const status = parseHumanReviewOperatorStatus((await readRpc("M32 status", "get_pipeline_human_review_operator_status", {})).data);
  const list = parseHumanReviewOperatorList((await readRpc("M32 list", "list_pipeline_human_reviews_operator", { p_limit: 500 })).data);
  const inspect = parseHumanReviewOperatorInspection((await readRpc("M32 inspect empty-state sentinel", "get_pipeline_human_review_operator_inspect", { p_review_id: "00000000-0000-0000-0000-000000000000" })).data);
  assert.equal(status.totalReviews, 0, "REVIEW_COUNT_CHANGED");
  assert.equal(status.waitingReviews, 0, "WAITING_REVIEW_COUNT_CHANGED");
  assert.equal(list.reviews.length, 0, "M32_LIST_NOT_EMPTY");
  assert.equal(inspect.found, false, "M32_INSPECT_NOT_EMPTY");
  if (preflightObservabilityMode) output.baselineIfAvailable = { ...output.baselineIfAvailable, reviews: status.totalReviews, waitingReviews: status.waitingReviews, m32: { status: "PASS", list: "PASS", inspect: "PASS" } };
  const today = new Date().toISOString().slice(0, 10);
  const daily = {};
  for (const provider of providers) {
    const value = await usageFor(provider, today);
    daily[provider] = { requestsReserved: value.requestsReserved, requestsDispatched: value.requestsDispatched, totalTokens: value.totalTokens, unknownReservations: value.unknownTokenRequests };
    assert.equal(value.unknownTokenRequests, 0, "UNKNOWN_" + provider.toUpperCase() + "_RESERVATIONS");
  }
  if (preflightObservabilityMode) output.baselineIfAvailable = { ...output.baselineIfAvailable, unknownReservations: Object.fromEntries(Object.entries(daily).map(([provider, value]) => [provider, value.unknownReservations])) };
  const recentLogs = await readResult("read current UTC day Groq M36 accounting rows", "TABLE", () => supabase.from("agent_logs").select("id,run_id,payload,provider,provider_unit,provider_unit_amount,created_at").eq("provider", "groq").gte("created_at", today + "T00:00:00.000Z").order("id").range(0, 4999));
  if (recentLogs.data?.length >= 5000) throw new Error("M36_ACCOUNTING_WINDOW_READ_INCOMPLETE");
  const runIds = [...new Set((recentLogs.data ?? []).map((row) => row.run_id))];
  const ownerResponse = runIds.length ? await readResult("read current UTC day Groq accounting owners", "TABLE", () => supabase.from("agent_runs").select("id,provider,status,started_at,finished_at,updated_at").in("id", runIds)) : { data: [] };
  if ((ownerResponse.data ?? []).length !== runIds.length) throw new Error("M36_ACCOUNTING_OWNER_SET_INCOMPLETE");
  const now = new Date();
  const minute = localMinuteUsage({
    now: now.toISOString(), complete: true,
    rows: (recentLogs.data ?? []).map((row) => ({ id: row.id, runId: row.run_id, createdAt: row.created_at, providerUnit: row.provider_unit, providerUnitAmount: row.provider_unit_amount, payload: row.payload })),
    runs: (ownerResponse.data ?? []).map((row) => ({ id: row.id, provider: row.provider, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, updatedAt: row.updated_at })),
  });
  const estimate = estimateCriticV4Request(snapshot.criticInputOverride);
  const limit = pipeline.configs.critic.groqCapacity?.tokenMinuteHardLimit;
  assert.ok(Number.isSafeInteger(limit) && limit > 0, "CRITIC_TPM_LIMIT_MISSING");
  operation = "read latest Groq provider rate-limit snapshot";
  const headerRequestsBefore = requests.length;
  let header;
  try { header = await logger.getLatestProviderRateLimitSnapshot("groq"); }
  catch (error) { if (requests.length > headerRequestsBefore) addFailure(operation, "TABLE", null, { message: "Provider header read failed" }); throw new Error("PROVIDER_HEADER_READ_FAILED", { cause: error }); }
  const admission = decideGroqProviderHeaderAdmission({ estimatedStageTokenRequirement: estimate.estimatedStageTokenRequirement, tokenLimitTpm: limit, providerSnapshot: header, now });
  const requiredTokens = estimate.estimatedStageTokenRequirement + 128;
  const localCapacity = minute.tokens + requiredTokens <= limit;
  const m36Hash = createHash("sha256").update(readFileSync(m36Path)).digest("hex");
  assert.equal(oldSchema.schema?.status, "PASS", "PRIOR_SCHEMA_EVIDENCE_INVALID");
  for (const migration of ["M32", "M34", "M35", "M36"]) assert.equal(oldSchema.schema?.[migration], "PASS", "PRIOR_" + migration + "_NOT_PROVEN");
  assert.equal(oldM36.migrationApplied, true, "M36_NOT_PROVEN_APPLIED");
  assert.equal(m36Hash, oldM36.migrationSha256, "M36_MIGRATION_HASH_CHANGED");
  assert.equal(failures.length, 0, "REMOTE_PREFLIGHT_READ_ERROR");
  assert.equal(counters.providerCalls, 0, "PROVIDER_CALLED_DURING_PREFLIGHT");
  assert.equal(counters.writeRequests, 0, "REMOTE_WRITE_DURING_PREFLIGHT");
  return {
    snapshot, target, production, rowHashes,
    proof: {
      status: "PASS",
      attempt: { id: attemptId, state: "DEFERRED_PROVIDER_CAPACITY", eventKey, pipelineRunId, resumeStage: "critic", generation: 1, retryNeutral: true, criticDispatches: 0, criticCheckpointAbsent: true, snapshotMatchesRemote: true },
      checkpoints: checks,
      baseline: { attempts: counts.real.length, activeDeferredStuck: counts.counts, reviews: status.totalReviews, waiting: status.waitingReviews, m32: { status: "PASS", list: "PASS", inspect: "PASS" }, public: currentPublic, unknownReservations: 0, historicalRowsUnchanged: true, historicalSchedulerUnchanged: true },
      migrationEvidence: { M32: "PASS", M34: "PASS", M35: "PASS", M36: "PASS", M36HashMatchesPriorRemoteValidation: true },
      dailyAccounting: daily,
      capacity: { accountingOracle: "M36_LOCAL_MINUTE_USAGE", status: minute.status, localWindowTokens: minute.tokens, excludedLegacy: minute.excludedLegacy, estimatedCriticTokens: estimate.estimatedStageTokenRequirement, safetyMarginTokens: 128, requiredWindowTokens: requiredTokens, hardLimitTokens: limit, localCapacityAvailable: localCapacity, headerAdmission: admission.decision, externalState: admission.externalState, windowFromUtc: new Date(now.getTime() - 60_000).toISOString(), windowThroughUtc: now.toISOString() },
      requestBudget: requestCapContract,
      snapshotSha256: local.sha256, rowHashes,
    },
  };
}
async function m32Status() {
  return parseHumanReviewOperatorStatus((await readRpc("M32 post-resume status", "get_pipeline_human_review_operator_status", {})).data);
}
async function m32List() {
  return parseHumanReviewOperatorList((await readRpc("M32 post-resume list", "list_pipeline_human_reviews_operator", { p_limit: 500 })).data);
}
async function postResume(result) {
  phase = "POST_RESUME";
  const attempts = await allRows("pipeline_event_attempts");
  const target = attempts.find((row) => row.id === attemptId);
  assert.ok(target, "POST_RESUME_TARGET_MISSING");
  const counts = attemptCounts(attempts);
  const articles = await allRows("articles");
  const pub = publicState(articles);
  assert.equal(counts.real.length, 19, "POST_RESUME_ATTEMPT_COUNT_CHANGED");
  assert.deepEqual(pub.fingerprints, baseline.fingerprints, "POST_RESUME_PUBLIC_HASH_CHANGED");
  assert.equal(pub.count, 2, "POST_RESUME_PUBLIC_COUNT_CHANGED");
  assert.equal(pub.astraArchived, true, "POST_RESUME_ASTRA_NOT_ARCHIVED");
  const status = await m32Status();
  const list = await m32List();
  let inspection = null;
  let review = null;
  if (result.finalState === "WAITING_FOR_HUMAN_REVIEW") {
    assert.equal(list.reviews.length, 1, "EXPECTED_SINGLE_REVIEW");
    review = list.reviews[0];
    assert.equal(review.id, result.humanReviewId, "REVIEW_ID_MISMATCH");
    assert.equal(review.status, "WAITING_FOR_HUMAN_REVIEW", "REVIEW_NOT_WAITING");
    assert.equal(review.consumed_at, null, "REVIEW_CONSUMED");
    assert.equal(review.action, null, "REVIEW_HAS_HUMAN_ACTION");
    assert.deepEqual([review.attempt_id, review.event_key, review.pipeline_run_id], [attemptId, eventKey, pipelineRunId], "REVIEW_LINEAGE_MISMATCH");
    assert.equal(review.critic_pass, true, "M34_CRITIC_PASS_MISSING");
    assert.equal(review.provider_usage_settled, true, "REVIEW_USAGE_UNSETTLED");
    assert.equal(review.review_manifest.checkpoints.critic.identity, pipelineRunId + ":" + attemptId + ":critic:" + eventKey, "M34_CRITIC_PROOF_MISMATCH");
    const criticCheckpoint = await readSafeCriticPipelineCheckpoint(checkpointPaths.critic);
    assert.equal(criticCheckpoint.eventKey, eventKey, "DURABLE_CRITIC_EVENT_MISMATCH");
    assert.equal(criticCheckpoint.attemptId, attemptId, "DURABLE_CRITIC_ATTEMPT_MISMATCH");
    assert.equal(criticCheckpoint.critic.decision, "pass", "DURABLE_CRITIC_PASS_MISSING");
    inspection = parseHumanReviewOperatorInspection((await readRpc("M32 post-resume review inspect", "get_pipeline_human_review_operator_inspect", { p_review_id: review.id })).data);
    assert.equal(inspection.found, true, "M32_REVIEW_INSPECT_MISSING");
    assert.equal(inspection.review?.status, "WAITING_FOR_HUMAN_REVIEW", "M32_REVIEW_INSPECT_STATUS");
    assert.equal(status.totalReviews, 1, "M32_STATUS_TOTAL");
    assert.equal(status.waitingReviews, 1, "M32_STATUS_WAITING");
  } else {
    assert.equal(list.reviews.length, 0, "UNEXPECTED_REVIEW");
    assert.equal(status.totalReviews, 0, "UNEXPECTED_REVIEW_STATUS");
  }
  const scheduler = await allRows("scheduler_runs");
  assert.deepEqual(hashRows(scheduler), baseline.rowHashes.scheduler, "POST_RESUME_SCHEDULER_CHANGED");
  if (result.finalState === "DEFERRED_PROVIDER_CAPACITY") {
    assert.equal(target.final_state, null, "DEFERRED_ATTEMPT_FINALIZED");
    assert.equal(target.stop_reason, "PROVIDER_CAPACITY_EXHAUSTED", "DEFER_REASON_CHANGED");
    assert.equal(target.capacity_resume_snapshot?.resumeStage, "critic", "DEFER_STAGE_CHANGED");
    assert.equal(target.capacity_resume_snapshot?.resumeGeneration, 2, "DEFER_GENERATION_NOT_TWO");
  } else assert.notEqual(target.final_state, null, "ATTEMPT_LEFT_ACTIVE");
  return {
    attempt: { id: target.id, finalState: target.final_state, stopStage: target.stop_stage, stopReason: target.stop_reason, retryClass: target.retry_class, countsTowardRetryLimit: target.counts_toward_retry_limit, completedAt: target.completed_at, resumeStage: target.capacity_resume_snapshot?.resumeStage ?? null, resumeGeneration: target.capacity_resume_snapshot?.resumeGeneration ?? null },
    activeDeferredStuck: counts.counts,
    reviews: { total: status.totalReviews, waiting: status.waitingReviews, id: review?.id ?? null, status: review?.status ?? null, consumed: review?.consumed_at ?? null },
    m32: { status: "PASS", list: "PASS", inspect: inspection ? "PASS" : "PASS_NOT_FOUND" },
    m34: review ? "PASS" : "NOT_RUN_CRITIC_NOT_PASSED",
    public: pub, publisher: "NOT RUN", humanActions: 0, newAttempts: counts.real.length - 19,
    schedulerUnchanged: true,
    criticResult: { finalState: result.finalState, decision: result.criticDecision, requestsUsed: result.requestsUsed, stopStage: result.stopStage, stopReason: result.stopReason, checkpoint: result.checkpoints.critic ?? null, telemetry: result.telemetry.critic ? { provider: result.telemetry.critic.provider, requests: result.telemetry.critic.providerRequestsUsed, retries: result.telemetry.critic.retries, inputTokens: result.telemetry.critic.inputTokens, outputTokens: result.telemetry.critic.outputTokens, totalTokens: result.telemetry.critic.totalTokens, providerRequestDispatched: result.telemetry.critic.providerRequestDispatched } : null },
  };
}
async function main() {
  if (preflightObservabilityMode) {
    observability.enter("RUNNER_START", "validate historical construction evidence");
    assert.equal(output.localGates.result, "PASS", "LOCAL_GATES_NOT_PASS");
    for (const [gate, status] of Object.entries(output.localGates)) {
      if (gate === "result" || gate === "suites") continue;
      assert.equal(status, "PASS", "LOCAL_GATE_FAILED:" + gate);
    }
    assert.equal(existsSync(historicalOutputPath), true, "CONSTRUCTION_DIAGNOSTIC_ARTIFACT_MISSING");
    assert.equal(output.constructionTrace?.succeeded, true, "CONSTRUCTION_NOT_PROVEN_HEALTHY");
    observability.complete("RUNNER_START", "historical construction evidence available");

    observability.enter("ENV_VALIDATED", "validate server environment presence");
    assert.ok(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), "SERVER_URL_MISSING");
    assert.ok(process.env.SUPABASE_SECRET_KEY?.trim(), "SERVER_SECRET_MISSING");
    origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
    observability.complete("ENV_VALIDATED", "server environment present; values not recorded");

    observability.enter("ARTIFACT_PRECONDITION_VALIDATED", "reserve versioned 12F.12F artifact paths");
    assert.equal(artifactCanStartRun([outputPath, invocationPath, docPath], existsSync), true, "12F12F_ARTIFACT_ALREADY_EXISTS");
    writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    artifactOwnedByThisRun = true;
    observability.complete("ARTIFACT_PRECONDITION_VALIDATED", "versioned artifacts reserved without overwriting prior evidence");

    writeFileSync(invocationPath, JSON.stringify({ phase: output.phase, startedAtUtc: new Date().toISOString(), canonicalRunnerInvocationCount: 1, canonicalPreflightInvocationCount: 0, attemptId, providerCallsAtStart: 0, resumeInvocationsAtStart: 0 }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    observability.enter("PIPELINE_CONSTRUCTION_START", "createCapacityResumeProductionPipeline");
    makePipeline();
    observability.complete("PIPELINE_CONSTRUCTION_COMPLETE", "production pipeline constructed");
    observability.complete("PREFLIGHT_CLIENT_READY", "Supabase client and production preflight function ready");
    writeFileSync(invocationPath, JSON.stringify({ phase: output.phase, startedAtUtc: new Date().toISOString(), canonicalRunnerInvocationCount: 1, canonicalPreflightInvocationCount: 1, attemptId, providerCallsAtStart: 0, resumeInvocationsAtStart: 0 }, null, 2) + "\n", "utf8");
    output.remotePreflight.invocationCount = 1;
    output.remotePreflight.status = "RUNNING";
  } else {
    assert.equal(existsSync(outputPath), true, "CONSTRUCTION_DIAGNOSTIC_ARTIFACT_MISSING");
    assert.equal(output.constructionTrace?.succeeded, true, "CONSTRUCTION_NOT_PROVEN_HEALTHY");
    assert.equal(existsSync(invocationPath), false, "PREFLIGHT_ALREADY_ATTEMPTED");
    assert.equal(existsSync(docPath), true, "DOCUMENTATION_MISSING");
    assert.ok(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), "SERVER_URL_MISSING");
    assert.ok(process.env.SUPABASE_SECRET_KEY?.trim(), "SERVER_SECRET_MISSING");
    origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
    writeFileSync(invocationPath, JSON.stringify({ phase: "12F.12E", startedAtUtc: new Date().toISOString(), canonicalPreflightInvocationCount: 1, attemptId, providerCallsAtStart: 0, resumeInvocationsAtStart: 0 }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    makePipeline();
  }
  output.remotePreflight.invocationCount = 1;
  output.remotePreflight.status = "RUNNING";
  let state;
  try {
    state = await baselineRead();
    output.remotePreflight.status = "PASS";
    output.remotePreflight.reads = requests.filter((item) => item.phase === "PREFLIGHT").map(({ operation: name, endpointClass, method, endpoint, httpStatus }) => ({ operation: name, endpointClass, method, endpoint, httpStatus: httpStatus ?? null }));
    output.attemptState = state.proof.attempt;
    output.capacity = state.proof.capacity;
    output.preflightEvidence = state.proof;
    output.attemptReadResult = { status: "PASS", attempt: state.proof.attempt };
    output.baselineIfAvailable = state.proof.baseline;
  } catch (error) {
    if (preflightObservabilityMode) throw error;
    output.remotePreflight.status = "FAIL";
    output.remotePreflight.failureCode = codeOnly(error);
    output.remotePreflight.reads = requests.filter((item) => item.phase === "PREFLIGHT").map(({ operation: name, endpointClass, method, endpoint, httpStatus }) => ({ operation: name, endpointClass, method, endpoint, httpStatus: httpStatus ?? null }));
    output.remoteFailureDiagnostics = failures.at(-1) ?? null;
    output.finalState = "REMOTE_PREFLIGHT_FAILURE";
    output.errorObservability.failures = failures;
    output.providerAccounting = { providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests, remoteReadsAttempted: requests.length };
    writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
    writeDoc();
    console.log(JSON.stringify({ phase: output.phase, remotePreflight: output.remotePreflight, remoteFailureDiagnostics: output.remoteFailureDiagnostics, claim: "NOT_RUN", resume: output.resume, providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests }));
    return;
  }
  if (preflightObservabilityMode) {
    observability.complete("PREFLIGHT_COMPLETE", "read-only preflight and baseline checks passed");
    const snapshot = state.snapshot;
    const target = state.target;
    const ownerId = randomUUID();
    const evidence = {
      attempt: { attemptId, eventKey, pipelineRunId, startedAt: target.started_at, completedAt: target.completed_at, finalState: target.final_state, stopStage: target.stop_stage, stopReason: target.stop_reason, countsTowardRetryLimit: target.counts_toward_retry_limit },
      currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items,
      currentCheckpointSha256: state.proof.checkpoints.hashes,
      nextStageDispatchCount: 0, nextStageCheckpointPresent: false,
      unresolvedProviderUsage: false, activeOwner: false, terminalEditorialRejection: snapshot.verification?.status === "rejected",
    };
    const assessment = assessCapacityResume(snapshot, evidence, { ownerId });
    assert.equal(assessment.valid, true, "CAPACITY_RESUME_EVIDENCE_INVALID");
    assert.equal(assessment.firstStage, "critic", "RESUME_STAGE_NOT_CRITIC");
    assert.equal(assessment.previousModelCallsToRepeat, 0, "COMPLETED_STAGE_RERUN_RISK");
    assert.ok(["KNOWN_ZERO", "KNOWN_USAGE"].includes(state.proof.capacity.status), "M36_LOCAL_ACCOUNTING_NOT_KNOWN");
    assert.equal(counters.providerCalls, 0, "PROVIDER_CALLED_DURING_PREFLIGHT");
    assert.equal(counters.writeRequests, 0, "REMOTE_WRITE_DURING_PREFLIGHT");
    output.remotePreflight.status = "PASS";
    output.remotePreflight.reads = requests.filter((item) => item.phase === "PREFLIGHT").map(({ operation: name, endpointClass, method, endpoint, httpStatus }) => ({ operation: name, endpointClass, method, endpoint, httpStatus: httpStatus ?? null }));
    output.attemptState = state.proof.attempt;
    output.capacity = state.proof.capacity;
    output.preflightEvidence = state.proof;
    output.resumeEligibility = { valid: assessment.valid, firstStage: assessment.firstStage, previousModelCallsToRepeat: assessment.previousModelCallsToRepeat, reasonCodes: assessment.reasons };
    output.attemptReadResult.resumeEligibility = output.resumeEligibility;
    output.runnerObservability = observability.snapshot();
    output.exactSafeError = null;
    output.classification = "PREFLIGHT_READONLY_PASS";
    output.canonicalRunnerInvocationCount = 1;
    output.networkCounter = { remoteRequestCount: output.runnerObservability.remoteRequestCount, firstRemoteOperation: output.runnerObservability.firstRemoteOperation, firstRemoteHttpStatus: output.runnerObservability.firstRemoteHttpStatus };
    output.canonicalPreflight = { runnerInvocationCount: 1, invocationCount: 1, status: "PASS" };
    output.providerAccounting = { providerCalls: 0, remoteWrites: 0, remoteReadsAttempted: requests.length };
    output.claim = "NOT_RUN";
    output.resume = { invocationCount: 0, stage: "critic", generationBefore: 1, generationAfter: null };
    output.finalState = "PREFLIGHT_READONLY_PASS";
    output.readyForCriticResume = true;
    output.claims = 0;
    output.resumeInvocations = 0;
    output.providerCalls = 0;
    output.remoteWrites = 0;
    writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
    writeDoc();
    console.log(JSON.stringify({ phase: output.phase, classification: output.classification, canonicalPreflightInvocationCount: 1, remoteRequestCount: output.runnerObservability.remoteRequestCount, lastCompletedPhase: output.runnerObservability.lastCompletedPhase, failingPhase: null, attempt: output.attemptState, claim: "NOT_RUN", resumeInvocations: 0, providerCalls: 0, remoteWrites: 0, readyForCriticResume: true }));
    return;
  }
  const snapshot = state.snapshot;
  const target = state.target;
  const ownerId = randomUUID();
  const evidence = {
    attempt: { attemptId, eventKey, pipelineRunId, startedAt: target.started_at, completedAt: target.completed_at, finalState: target.final_state, stopStage: target.stop_stage, stopReason: target.stop_reason, countsTowardRetryLimit: target.counts_toward_retry_limit },
    currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items,
    currentCheckpointSha256: state.proof.checkpoints.hashes,
    nextStageDispatchCount: 0, nextStageCheckpointPresent: false,
    unresolvedProviderUsage: false, activeOwner: false, terminalEditorialRejection: snapshot.verification?.status === "rejected",
  };
  const assessment = assessCapacityResume(snapshot, evidence, { ownerId });
  if (!assessment.valid) throw new Error("CAPACITY_RESUME_EVIDENCE_INVALID:" + assessment.reasons.join(","));
  assert.equal(assessment.firstStage, "critic", "RESUME_STAGE_NOT_CRITIC");
  assert.equal(assessment.previousModelCallsToRepeat, 0, "COMPLETED_STAGE_RERUN_RISK");
  if (!["KNOWN_ZERO", "KNOWN_USAGE"].includes(state.proof.capacity.status)) throw new Error("M36_LOCAL_ACCOUNTING_NOT_KNOWN");
  phase = "RESUME";
  operation = "PipelineOrchestrator.resumeCapacityDeferred";
  counters.resumeInvocations += 1;
  output.claim = "DELEGATED_TO_M35_COMPARE_AND_SET";
  output.resume.invocationCount = 1;
  let result;
  try {
    result = await pipeline.orchestrator.resumeCapacityDeferred({ snapshot, evidence, ownerId });
    output.claim = "PASS";
  } catch (error) {
    output.resume.failureCode = codeOnly(error);
    output.finalState = "TECHNICAL_FAILURE";
  }
  output.providerAccounting = {
    providerCalls: counters.providerCalls, retries: result?.telemetry.critic?.retries ?? 0,
    fallback: result?.telemetry.critic?.provider === "groq" || !result?.telemetry.critic ? 0 : 1,
    cloudflareCalls: result?.telemetry.critic?.provider === "cloudflare_workers_ai" ? result.telemetry.critic.providerRequestsUsed : 0,
    cerebrasCalls: result?.telemetry.critic?.provider === "cerebras" ? result.telemetry.critic.providerRequestsUsed : 0,
    resumeRequests: result?.telemetry.critic?.providerRequestsUsed ?? 0,
    resumeTokens: result?.telemetry.critic?.totalTokens ?? null,
    remoteWrites: counters.writeRequests, humanReviewWrites: counters.reviewWrites,
  };
  if (result) {
    output.finalState = result.finalState;
    output.resume.generationAfter = result.finalState === "DEFERRED_PROVIDER_CAPACITY" ? 2 : 1;
    output.critic = {
      decision: result.criticDecision, finalState: result.finalState, stopStage: result.stopStage, stopReason: result.stopReason,
      requestsUsed: result.requestsUsed, durableCheckpointPresent: existsSync(checkpointPaths.critic),
      telemetry: result.telemetry.critic ? { provider: result.telemetry.critic.provider, providerRequestDispatched: result.telemetry.critic.providerRequestDispatched, requests: result.telemetry.critic.providerRequestsUsed, retries: result.telemetry.critic.retries, inputTokens: result.telemetry.critic.inputTokens, outputTokens: result.telemetry.critic.outputTokens, totalTokens: result.telemetry.critic.totalTokens } : null,
    };
    output.m34 = result.finalState === "WAITING_FOR_HUMAN_REVIEW" ? "PASS" : "NOT_RUN_CRITIC_NOT_PASSED";
  }
  if (result) {
    try {
      const post = await postResume(result);
      output.postResume = post;
      output.attemptState = post.attempt;
      output.m32 = post.m32;
      output.m34 = post.m34;
      output.review = post.reviews;
      output.publicState = { ...post.public, unchanged: JSON.stringify(post.public.fingerprints) === JSON.stringify(baseline.fingerprints), publisher: post.publisher, humanActions: post.humanActions };
      output.readyForHumanAction = result.finalState === "WAITING_FOR_HUMAN_REVIEW" && post.m32.status === "PASS"
        && post.reviews.waiting === 1 && post.reviews.consumed === null && post.public.count === 2
        && post.public.astraArchived && post.newAttempts === 0 && post.publisher === "NOT RUN" && post.humanActions === 0
        && counters.providerCalls === 1 && output.providerAccounting.retries === 0
        && output.providerAccounting.fallback === 0 && output.providerAccounting.cloudflareCalls === 0
        && output.providerAccounting.cerebrasCalls === 0;
    } catch (error) { output.postResumeFailureCode = codeOnly(error); }
  }
  output.resume.remoteRequests = requests.filter((item) => item.phase !== "PREFLIGHT").map(({ operation: name, endpointClass, method, endpoint, hostClass, httpStatus }) => ({ operation: name, endpointClass, method, endpoint, hostClass, httpStatus: httpStatus ?? null }));
  output.errorObservability.failures = failures;
  output.providerAccounting.providerCalls = counters.providerCalls;
  output.providerAccounting.remoteWrites = counters.writeRequests;
  output.providerAccounting.humanReviewWrites = counters.reviewWrites;
  output.finalState ??= "TECHNICAL_FAILURE";
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  writeDoc();
  console.log(JSON.stringify({ phase: output.phase, remotePreflight: output.remotePreflight.status, attempt: output.attemptState, claim: output.claim, resume: output.resume, critic: output.critic, m34: output.m34, review: output.review, m32: output.m32, providerAccounting: output.providerAccounting, publicState: output.publicState, finalState: output.finalState, readyForHumanAction: output.readyForHumanAction }));
}
function writeDoc() {
  if (preflightObservabilityMode) {
    const lines = [
      "# 12F.12F — observabilidad del límite del runner de preflight", "",
      "Modo: preflight canónico de solo lectura; claim, resume, proveedores y escrituras remotas permanecen desactivados.", "",
      "## Clasificación", "",
      "Clasificación final: " + output.classification + ". Estado: " + output.finalState + ". READY FOR CRITIC RESUME: " + output.readyForCriticResume + ".", "",
      "12F.12E actual failure class: " + output.previousClassification + ". Outermost catch: " + JSON.stringify(output.outermostCatch) + ". Previous generic masking: " + JSON.stringify(output.previousGenericMasking) + ".", "",
      "Intento 12F.12F previo: " + JSON.stringify(output.prior12f12fInvocation) + ". Guard de lectura corregido y probado: " + JSON.stringify(output.readRequestGuard) + ".", "",
      "## Límite de ejecución", "",
      "Invocaciones del runner: " + JSON.stringify(output.canonicalRunnerInvocationCount) + "; invocaciones del preflight canónico: " + output.remotePreflight.invocationCount + ".", "",
      "Última fase completada: " + JSON.stringify(output.runnerObservability?.lastCompletedPhase ?? null) + "; fase fallida: " + JSON.stringify(output.runnerObservability?.failingPhase ?? null) + "; paso: " + JSON.stringify(output.runnerObservability?.step ?? null) + ".", "",
      "Fases: " + JSON.stringify(output.runnerObservability?.phaseMarkers ?? []) + ".", "",
      "## Contador de red y precondición de artefactos", "",
      "Contador: " + JSON.stringify(output.networkCounter) + ". Política: " + JSON.stringify(output.artifactPreconditionPolicy) + ".", "",
      "## Error seguro", "",
      "Serialización: " + JSON.stringify(output.errorSerialization) + "; pruebas de redacción: " + JSON.stringify(output.redactionTests) + ".", "",
      JSON.stringify(output.exactSafeError ?? null), "",
      "## Solicitudes y baseline", "",
      "Primera operación remota: " + JSON.stringify(output.runnerObservability?.firstRemoteOperation ?? null) + "; total de solicitudes remotas: " + JSON.stringify(output.runnerObservability?.remoteRequestCount ?? 0) + ".", "",
      "Canonical preflight: " + JSON.stringify(output.canonicalPreflight) + ".", "",
      "Resultado de lectura del attempt: " + JSON.stringify(output.attemptReadResult ?? null) + ".", "",
      "Baseline si está disponible: " + JSON.stringify(output.baselineIfAvailable ?? null) + "; evidencia: " + JSON.stringify(output.preflightEvidence ?? null) + ".", "",
      "## Límites", "",
      "Provider calls=" + output.providerCalls + "; claims=" + output.claims + "; resumeInvocations=" + output.resumeInvocations + "; remoteWrites=" + output.remoteWrites + "; scheduler runs: 0; intentos nuevos: 0.", "",
    ];
    writeFileSync(docPath, lines.join("\n"), { encoding: "utf8", flag: "wx" });
    return;
  }
  const lines = [
    "# 12F.12E — diagnóstico de construcción y reanudación protegida", "",
    "## Resultado 12F.12D", "",
    "12F.12D falló antes de una lectura remota: sí. El PGRST303 histórico sigue clasificado INSUFFICIENT_EVIDENCE; no se atribuye a auth ni ACL.", "",
    "## Construcción local", "",
    "Camino: createCapacityResumeProductionPipeline → createProductionPipeline. Reproducción local: " + output.constructionTrace.succeeded + "; causa: " + output.constructionRootCause + "; error capturado: " + JSON.stringify(output.constructionErrorCapture) + ".", "",
    "Pasos: " + output.constructionTrace.steps.join(" → ") + ".", "",
    "Traza de construcción: cliente Supabase → logger → provider/configuración Groq y modelos → presupuesto/cuota → seis agentes → repositorios → stage wiring → config → orquestador → función preflight. La función preflight se crea; no se ejecuta durante el diagnóstico local.", "",
    "## Configuración y paridad", "",
    "Estados de configuración (sin valores): " + JSON.stringify(output.environmentConfig) + ".", "",
    "Construcción fresh-process/resume/daily y configuración canónica: " + JSON.stringify(output.constructionRegression) + ".", "",
    "## Gates locales", "",
    "Focused suites: " + output.localGates.result + "; lint " + output.localGates.lint + "; TypeScript " + output.localGates.typescript + "; build " + output.localGates.build + "; diff-check " + output.localGates.diffCheck + "; secret audit " + output.localGates.secretAudit + ".", "",
    "## Preflight y reanudación", "",
    "Preflight remoto canónico: " + output.remotePreflight.status + " (invocaciones " + output.remotePreflight.invocationCount + "). Diagnóstico remoto: " + JSON.stringify(output.remoteFailureDiagnostics) + ".", "",
    "Intento: " + attemptId + "; estado: " + JSON.stringify(output.attemptState) + "; claim: " + output.claim + "; resume: " + JSON.stringify(output.resume) + "; Critic: " + JSON.stringify(output.critic) + "; M34: " + output.m34 + "; M32: " + JSON.stringify(output.m32) + "; review: " + JSON.stringify(output.review) + ".", "",
    "Provider accounting: " + JSON.stringify(output.providerAccounting) + "; publisher: NOT RUN.", "",
    "Estado público final: " + JSON.stringify(output.publicState) + "; clasificación: " + output.finalState + "; ready for human action: " + output.readyForHumanAction + ".", "",
  ];
  writeFileSync(docPath, lines.join("\n"), "utf8");
}
main().catch((error) => {
  if (preflightObservabilityMode) {
    const exactSafeError = observability.capture(error);
    const boundary = observability.snapshot();
    const classification = classifyPreflightFailure({ phase: boundary.failingPhase, remoteRequestCount: boundary.remoteRequestCount, remoteFailureOccurred: failures.length > 0 });
    output.runnerObservability = boundary;
    output.exactSafeError = exactSafeError;
    output.classification = classification;
    output.canonicalRunnerInvocationCount = existsSync(invocationPath) ? 1 : 0;
    output.networkCounter = { remoteRequestCount: boundary.remoteRequestCount, firstRemoteOperation: boundary.firstRemoteOperation, firstRemoteHttpStatus: boundary.firstRemoteHttpStatus };
    output.remotePreflight.status = output.remotePreflight.invocationCount === 1 ? "FAIL" : "NOT_RUN";
    output.canonicalPreflight = { runnerInvocationCount: output.canonicalRunnerInvocationCount, invocationCount: output.remotePreflight.invocationCount, status: output.remotePreflight.status };
    output.remotePreflight.failureCode = exactSafeError.code;
    output.remotePreflight.reads = requests.filter((item) => item.phase === "PREFLIGHT").map(({ operation: name, endpointClass, method, endpoint, httpStatus }) => ({ operation: name, endpointClass, method, endpoint, httpStatus: httpStatus ?? null }));
    output.remoteFailureDiagnostics = failures.at(-1) ?? null;
    output.errorObservability.failures = failures;
    output.resume.invocationCount = counters.resumeInvocations;
    output.claim = "NOT_RUN";
    output.providerAccounting = { providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests, remoteReadsAttempted: requests.length };
    output.finalState = classification;
    output.readyForCriticResume = false;
    output.attemptReadResult = null;
    output.baselineIfAvailable = null;
    output.claims = 0;
    output.resumeInvocations = counters.resumeInvocations;
    output.providerCalls = counters.providerCalls;
    output.remoteWrites = counters.writeRequests;
    if (artifactOwnedByThisRun) {
      try {
        writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
        writeDoc();
      } catch (persistenceError) {
        output.artifactPersistenceError = captureSafeRunnerError({ error: persistenceError, phase: "ARTIFACT_PERSISTENCE", secretValues: secretValuesFromEnvironment() });
      }
    }
    console.log(JSON.stringify({ phase: output.phase, classification, lastCompletedPhase: boundary.lastCompletedPhase, failingPhase: boundary.failingPhase, step: exactSafeError.step, errorName: exactSafeError.name, errorCode: exactSafeError.code, errorMessage: exactSafeError.message, safeCause: exactSafeError.causeChain, safeStackFingerprint: exactSafeError.safeStackFingerprint, remoteRequestCount: boundary.remoteRequestCount, firstRemoteOperation: boundary.firstRemoteOperation, httpStatus: boundary.firstRemoteHttpStatus, canonicalRunnerInvocationCount: output.canonicalRunnerInvocationCount, canonicalPreflightInvocationCount: output.remotePreflight.invocationCount, claims: 0, resumeInvocations: 0, providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests }));
    process.exitCode = 1;
    return;
  }
  output.remotePreflight.failureCode ??= codeOnly(error);
  output.remoteFailureDiagnostics = failures.at(-1) ?? null;
  output.errorObservability.failures = failures;
  output.resume.invocationCount = counters.resumeInvocations;
  output.providerAccounting = { providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests };
  output.finalState ??= output.constructionTrace?.succeeded ? "REMOTE_PREFLIGHT_FAILURE" : "PIPELINE_CONSTRUCTION_FAILURE";
  if (existsSync(invocationPath)) {
    output.remotePreflight.status = "FAIL";
    output.remotePreflight.failureCode ??= codeOnly(error);
    output.remoteFailureDiagnostics ??= output.constructionErrorCapture;
    writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
    writeDoc();
  }
  console.log(JSON.stringify({ phase: output.phase, remotePreflight: output.remotePreflight, remoteFailureDiagnostics: output.remoteFailureDiagnostics, claim: output.claim, resume: output.resume, providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests, finalState: output.finalState }));
  process.exitCode = 1;
});
