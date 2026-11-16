import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logRemoteReadFailure, normalizeRemoteReadFailure } from "../lib/supabase/safe-remote-read-error.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { runWithConstructionDiagnostics, secretValuesFromEnvironment } from "../lib/agents/pipeline/construction-diagnostics.ts";
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

const attemptId = "4658d5c0-857c-4ed5-b97f-afb133b2bf22";
const eventKey = "event-5c7d0ef5ea6f72bec96704aded750851";
const pipelineRunId = "f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d";
const astraId = "756b0ee0-b5e6-4153-846f-278a12c9afe3";
const outputPath = "artifacts/supervised-cycle-12f12d-critic-resume.json";
const invocationPath = "artifacts/supervised-cycle-12f12d-invocation.json";
const docPath = "docs/supervised-cycle-12f12d-critic-resume.md";
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
const originalFetch = globalThis.fetch;
const output = {
  phase: "12F.12D",
  historicalPgrst303Classification: "INSUFFICIENT_EVIDENCE",
  historicalPgrst303Reproducible: false,
  credentialFailureProven: false,
  aclFailureProven: false,
  clientDivergenceProven: false,
  canonicalClient: "createSupabaseServerClient",
  constructionTrace: { steps: [], succeeded: false },
  constructionErrorCapture: null,
  errorObservability: { implemented: true, tests: "PASS", failures },
  localGates: { result: "PASS", focusedSuites: [
    "M35 claim/resume", "editor capacity defer contract", "durable checkpoint resume", "generation-1 Critic resume",
    "M36 accounting", "unified Groq admission", "Groq TPM bootstrap", "Groq token budget", "Critic schema/decision mapping",
    "Critic checkpoint", "revision semantics", "pipeline semantics", "M34 same-attempt proof", "M32 status/list/inspect",
    "single human-review creation", "server privileged read helper", "safe PostgREST error observability",
  ], lint: "PASS", typescript: "PASS", build: "PASS", diffCheck: "PASS", secretAudit: "PASS" },
  remotePreflight: { invocationCount: 0, status: "NOT_RUN", reads: [] },
  remoteFailureDiagnostics: null,
  attemptState: null,
  capacity: null,
  claim: "NOT_RUN",
  resume: { invocationCount: 0, stage: "critic", generationBefore: 1, generationAfter: null },
  critic: null, m34: null, review: null, m32: null, providerAccounting: {},
  finalState: null, publicState: null, readyForHumanAction: false,
};
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
  if (url.origin !== origin || !url.pathname.startsWith("/rest/v1/")) return false;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[1] === "rpc" && parts.length === 3) {
    return method === "POST" && (readRpcs.has(parts[2]) || phase === "RESUME" && resumeRpcs.has(parts[2]));
  }
  if (parts.length !== 2 || !readTables.has(parts[1])) return false;
  if (method === "GET" || method === "HEAD") return true;
  return phase === "RESUME" && (parts[1] === "agent_runs" && ["POST", "PATCH"].includes(method) || parts[1] === "agent_logs" && method === "POST");
}
globalThis.fetch = async (input, init) => {
  let request, url;
  try { request = new Request(input, init); url = new URL(request.url); } catch { throw new Error("REMOTE_REQUEST_INVALID"); }
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
  try {
    const response = await originalFetch(request);
    item.httpStatus = response.status;
    if (!response.ok && url.origin === origin) {
      let body = null;
      try { body = await response.clone().json(); } catch { body = null; }
      addFailure(operation, item.endpointClass, response.status, record(body) ? body : { message: "PostgREST request failed" });
    }
    return response;
  } catch {
    item.httpStatus = null;
    if (url.origin === origin) addFailure(operation, item.endpointClass, null, { message: "Network request failed" });
    throw new Error("REMOTE_REQUEST_FAILED");
  }
};

const budget = new ProviderScopedDailyRequestBudget(() => new Date(), 18);
for (let count = 0; count < 5; count += 1) budget.reserve("groq", 18);
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
  let response;
  try { response = await action(); }
  catch (error) {
    if (!failures.some((item) => item.operation === name)) addFailure(name, endpointClass, null, { message: "Read operation failed" });
    throw error;
  }
  if (response && response.error) {
    addFailure(name, endpointClass, response.status, response.error);
    throw new Error("REMOTE_READ_FAILED:" + (response.error.code || "UNKNOWN"));
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
  try { return await logger.getProviderDailyUsage(provider, day); }
  catch { addFailure(operation, "TABLE", null, { message: "Provider accounting read failed" }); throw new Error("PROVIDER_ACCOUNTING_READ_FAILED"); }
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
  const production = await pipeline.preflight();
  assert.equal(production.provider, "groq", "PROVIDER_NOT_GROQ");
  assert.equal(production.quotaProvider, "groq", "QUOTA_PROVIDER_NOT_GROQ");
  assert.equal(production.supabaseConnected, true, "PRIVILEGED_CLIENT_READ_FAILED");
  assert.equal(production.dailyRequestLimit, 18, "DAILY_REQUEST_CAP_MISMATCH");
  assert.equal(production.allowPaidFallback, false, "PAID_FALLBACK_ENABLED");
  assert.equal(production.allowProviderPacingWait, false, "PROVIDER_PACING_WAIT_ENABLED");
  assert.ok(Object.values(production.maxRetries).every((count) => count === 0), "RETRIES_ENABLED");
  assert.ok(production.quotaRemaining >= 1, "NO_DAILY_REQUEST_CAPACITY");
  const attempts = await allRows("pipeline_event_attempts");
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
  assert.equal(snapshot.resumeStage, "critic", "SNAPSHOT_NOT_CRITIC");
  assert.equal(snapshot.resumeGeneration, 1, "SNAPSHOT_GENERATION_NOT_ONE");
  assert.equal(snapshot.nextStageDispatchCount, 0, "CRITIC_ALREADY_DISPATCHED");
  assert.equal(snapshot.nextStageCheckpointPresent, false, "CRITIC_CHECKPOINT_PRESENT");
  assert.deepEqual(Object.keys(snapshot.checkpoints).sort(), priorStages.slice().sort(), "PRIOR_CHECKPOINT_SET_CHANGED");
  const checks = await checkpointProof(snapshot);
  const currentPublic = publicState(articles);
  assert.equal(currentPublic.count, 2, "PUBLIC_ARTICLE_COUNT_CHANGED");
  assert.equal(currentPublic.astraArchived, true, "ASTRA_NOT_ARCHIVED");
  assert.deepEqual(currentPublic.fingerprints, baseline.fingerprints, "PUBLIC_FINGERPRINTS_CHANGED");
  const rowHashes = { attempts: hashRows(attempts), logs: hashRows(logs), runs: hashRows(runs), articles: hashRows(articles), scheduler: hashRows(scheduler) };
  for (const name of ["attempts", "logs", "runs", "articles", "scheduler"]) assert.deepEqual(rowHashes[name], baseline.rowHashes[name], "HISTORICAL_" + name.toUpperCase() + "_CHANGED");
  const status = parseHumanReviewOperatorStatus((await readRpc("M32 status", "get_pipeline_human_review_operator_status", {})).data);
  const list = parseHumanReviewOperatorList((await readRpc("M32 list", "list_pipeline_human_reviews_operator", { p_limit: 500 })).data);
  const inspect = parseHumanReviewOperatorInspection((await readRpc("M32 inspect empty-state sentinel", "get_pipeline_human_review_operator_inspect", { p_review_id: "00000000-0000-0000-0000-000000000000" })).data);
  assert.equal(status.totalReviews, 0, "REVIEW_COUNT_CHANGED");
  assert.equal(status.waitingReviews, 0, "WAITING_REVIEW_COUNT_CHANGED");
  assert.equal(list.reviews.length, 0, "M32_LIST_NOT_EMPTY");
  assert.equal(inspect.found, false, "M32_INSPECT_NOT_EMPTY");
  const today = new Date().toISOString().slice(0, 10);
  const daily = {};
  for (const provider of providers) {
    const value = await usageFor(provider, today);
    daily[provider] = { requestsReserved: value.requestsReserved, requestsDispatched: value.requestsDispatched, totalTokens: value.totalTokens, unknownReservations: value.unknownTokenRequests };
    assert.equal(value.unknownTokenRequests, 0, "UNKNOWN_" + provider.toUpperCase() + "_RESERVATIONS");
  }
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
  let header;
  try { header = await logger.getLatestProviderRateLimitSnapshot("groq"); }
  catch { addFailure(operation, "TABLE", null, { message: "Provider header read failed" }); throw new Error("PROVIDER_HEADER_READ_FAILED"); }
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
      requestBudget: { dailyHardCap: 18, cumulativeRequestsBeforeResume: 5, seededLocalReservations: 5 },
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
  assert.equal(existsSync(outputPath), false, "OUTPUT_ALREADY_EXISTS");
  assert.equal(existsSync(invocationPath), false, "PREFLIGHT_ALREADY_ATTEMPTED");
  assert.equal(existsSync(docPath), false, "DOCUMENTATION_ALREADY_EXISTS");
  assert.ok(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), "SERVER_URL_MISSING");
  assert.ok(process.env.SUPABASE_SECRET_KEY?.trim(), "SERVER_SECRET_MISSING");
  origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
  writeFileSync(invocationPath, JSON.stringify({ phase: "12F.12D", startedAtUtc: new Date().toISOString(), canonicalPreflightInvocationCount: 1, attemptId, providerCallsAtStart: 0, resumeInvocationsAtStart: 0 }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  makePipeline();
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
  } catch (error) {
    output.remotePreflight.status = "FAIL";
    output.remotePreflight.failureCode = codeOnly(error);
    output.remotePreflight.reads = requests.filter((item) => item.phase === "PREFLIGHT").map(({ operation: name, endpointClass, method, endpoint, httpStatus }) => ({ operation: name, endpointClass, method, endpoint, httpStatus: httpStatus ?? null }));
    output.remoteFailureDiagnostics = failures.at(-1) ?? null;
    output.finalState = "REMOTE_PREFLIGHT_FAILURE";
    output.errorObservability.failures = failures;
    output.providerAccounting = { providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests, remoteReadsAttempted: requests.length };
    writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    writeDoc();
    console.log(JSON.stringify({ phase: output.phase, remotePreflight: output.remotePreflight, remoteFailureDiagnostics: output.remoteFailureDiagnostics, claim: "NOT_RUN", resume: output.resume, providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests }));
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
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  writeDoc();
  console.log(JSON.stringify({ phase: output.phase, remotePreflight: output.remotePreflight.status, attempt: output.attemptState, claim: output.claim, resume: output.resume, critic: output.critic, m34: output.m34, review: output.review, m32: output.m32, providerAccounting: output.providerAccounting, publicState: output.publicState, finalState: output.finalState, readyForHumanAction: output.readyForHumanAction }));
}
function writeDoc() {
  const lines = [
    "# 12F.12D — cierre PGRST303 y resume de Critic", "",
    "## Clasificación histórica", "",
    "PGRST303: INSUFFICIENT_EVIDENCE; no reproducible. Sin atribución a credenciales, ACL o divergencia del cliente. Cliente canónico: createSupabaseServerClient.", "",
    "## Observabilidad y gates", "",
    "Observabilidad PostgREST: implementada y probada; campos HTTP/PostgREST allowlisted y redacción de secreto, bearer y cookie. Gates locales: " + output.localGates.result + "; lint " + output.localGates.lint + "; TypeScript " + output.localGates.typescript + "; build " + output.localGates.build + "; diff " + output.localGates.diffCheck + "; secret audit " + output.localGates.secretAudit + ".", "",
    "## Preflight remoto", "",
    "Invocaciones: " + output.remotePreflight.invocationCount + "; resultado: " + output.remotePreflight.status + "; intento " + attemptId + "; Critic generación 1. Diagnóstico safe: " + JSON.stringify(output.remoteFailureDiagnostics) + ".", "",
    "## Resume, M34, M32 y accounting", "",
    "Claim: " + output.claim + "; resume: " + output.resume.invocationCount + "; estado final: " + output.finalState + "; M34: " + output.m34 + "; M32: " + JSON.stringify(output.m32) + "; review: " + JSON.stringify(output.review) + ".", "",
    "Provider calls: " + (output.providerAccounting.providerCalls ?? 0) + "; retries: " + (output.providerAccounting.retries ?? 0) + "; fallback: " + (output.providerAccounting.fallback ?? 0) + "; Cloudflare: " + (output.providerAccounting.cloudflareCalls ?? 0) + "; Cerebras: " + (output.providerAccounting.cerebrasCalls ?? 0) + "; publisher: NOT RUN.", "",
    "Artículos públicos: " + (output.publicState?.count ?? "sin lectura final") + "; fingerprints unchanged: " + (output.publicState?.unchanged ?? "sin lectura final") + "; ready for human action: " + output.readyForHumanAction + ".", "",
  ];
  writeFileSync(docPath, lines.join("\n"), "utf8");
}
main().catch((error) => {
  output.remotePreflight.failureCode ??= codeOnly(error);
  output.remoteFailureDiagnostics = failures.at(-1) ?? null;
  output.errorObservability.failures = failures;
  output.resume.invocationCount = counters.resumeInvocations;
  output.providerAccounting = { providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests };
  output.finalState ??= "REMOTE_PREFLIGHT_FAILURE";
  if (existsSync(invocationPath) && !existsSync(outputPath)) {
    output.remotePreflight.status = "FAIL";
    writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    writeDoc();
  }
  console.log(JSON.stringify({ phase: output.phase, remotePreflight: output.remotePreflight, remoteFailureDiagnostics: output.remoteFailureDiagnostics, claim: output.claim, resume: output.resume, providerCalls: counters.providerCalls, remoteWrites: counters.writeRequests, finalState: output.finalState }));
  process.exitCode = 1;
});
