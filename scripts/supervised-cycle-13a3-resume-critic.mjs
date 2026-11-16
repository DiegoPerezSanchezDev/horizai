import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCapacityResumeProductionPipeline } from "./capacity-resume-production-pipeline.ts";
import { createCapacityResumeRequestBudget, inspectSupervisedRequestCapContract } from "../lib/agents/pipeline/supervised-request-cap-contract.ts";
import { assessCapacityResume, capacityResumeSnapshotsMatch, checkpointSha256, readCapacityResumeSnapshot } from "../lib/agents/pipeline/provider-capacity-resume.ts";
import { readSafeTranslatorCheckpoint } from "../lib/agents/translator/translator-checkpoint.ts";
import { readSafeTranslatorEditorCheckpoint } from "../lib/agents/editor/translator-editor-checkpoint.ts";
import { readSafeClassifierPipelineCheckpoint } from "../lib/agents/classifier/classifier-pipeline-checkpoint.ts";
import { readSafeRankerPipelineCheckpoint } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";
import { readSafeCriticPipelineCheckpoint } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { parseHumanReviewOperatorList, parseHumanReviewOperatorInspection } from "../lib/agents/publisher/human-review-read-repository.ts";
import { parseHumanReviewOperatorStatus } from "../lib/agents/publisher/human-review-status.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { readGroqMaxConcurrentEvents } from "../lib/agents/runtime/groq-capacity-policy.ts";
import { captureSafeRunnerError } from "../lib/agents/pipeline/preflight-runner-observability.ts";
import { secretValuesFromEnvironment } from "../lib/agents/pipeline/construction-diagnostics.ts";
import { isAllowedSupabaseRequest } from "../lib/supabase/readonly-request-guard.ts";
import { assertCapacityResumeDeferGuard } from "../lib/agents/pipeline/capacity-resume-defer-guard.ts";

export const identity = {
  attemptId: "65a83559-8522-4162-8e04-6f8a0bde62b3",
  eventKey: "event-2ecb910eda5c6167b3bb6105aaf38087",
  pipelineRunId: "67c79a28-e27e-4a47-89a4-85801b9859cf",
};
const { attemptId, eventKey, pipelineRunId } = identity;
const root = `artifacts/pipeline-checkpoints/${pipelineRunId}`;
const snapshotPath = `${root}/capacity-resume-${eventKey}-critic-g2.json`;
const editorPath = `${root}/editor-${eventKey}.json`;
const classifierPath = `${root}/classifier-${eventKey}.json`;
const rankerPath = `${root}/ranker-${eventKey}.json`;
const criticPath = `${root}/critic-${eventKey}.json`;
const outputPath = "artifacts/supervised-cycle-13a3-resume-critic.json";
const invocationPath = "artifacts/supervised-cycle-13a3-invocation.json";
const docPath = "docs/supervised-cycle-13a3-resume-critic.md";
const gatesPath = "artifacts/supervised-cycle-13a3-local-gates.json";
const previousPath = "artifacts/supervised-cycle-13a-repeatability-2.json";
const priorStages = ["verifier", "translator", "editor", "classifier", "ranker"];
const allStages = ["verifier", "translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"];
const readTables = new Set(["pipeline_event_attempts", "agent_runs", "agent_logs", "articles", "scheduler_runs", "regions", "categories", "sources", "raw_items"]);
const readRpcs = new Set(["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator", "get_pipeline_human_review_operator_inspect"]);
const resumeRpcs = new Set(["claim_pipeline_event_attempt_capacity_resume_m35", "release_pipeline_event_attempt_capacity_resume_m35", "defer_pipeline_event_attempt_capacity_m35", "finalize_pipeline_event_attempt", "reserve_groq_request_and_tokens_m35", "release_agent_request", "mark_agent_request_dispatched", "settle_groq_token_usage", "create_pipeline_human_review"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const rowHash = (value) => sha(JSON.stringify(canonical(value)));
function writeJson(path, value, flag = "w") { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag }); }
function summarizeUsage(usage) {
  return Object.fromEntries(["provider", "dateUtc", "requestsReserved", "requestsDispatched", "inputTokens", "outputTokens", "totalTokens", "unknownTokenRequests", "tokenUsageKnown"].map((key) => [key, usage[key]]));
}

export async function runOnce() {
  const gates = JSON.parse(readFileSync(gatesPath, "utf8"));
  assert.equal(gates.status, "PASS", "LOCAL_GATES_REQUIRED");
  for (const [path, hash] of Object.entries(gates.sourceHashes)) assert.equal(sha(readFileSync(path)), hash, "GATED_SOURCE_CHANGED:" + path);
  let priorPreclaimFailure = null;
  if (existsSync(outputPath) || existsSync(invocationPath) || existsSync(docPath)) {
    assert.ok(existsSync(outputPath) && existsSync(invocationPath) && existsSync(docPath), "13A1_PARTIAL_PRIOR_RECORD");
    priorPreclaimFailure = JSON.parse(readFileSync(outputPath, "utf8"));
    const priorInvocation = JSON.parse(readFileSync(invocationPath, "utf8"));
    assert.equal(priorPreclaimFailure.resumeInvocationCount, 0, "13A1_RESUME_ALREADY_INVOKED");
    assert.equal(priorPreclaimFailure.claimCount, 0, "13A1_CLAIM_ALREADY_ATTEMPTED");
    assert.equal(priorPreclaimFailure.remoteWrites, 0, "13A1_REMOTE_WRITE_ALREADY_OCCURRED");
    assert.equal(priorInvocation.resumeInvocationCount, 0, "13A1_RESUME_ALREADY_INVOKED");
    assert.equal(priorPreclaimFailure.finalClassification, "PRECLAIM_FAILURE", "13A1_PRIOR_RUN_NOT_PRECLAIM_ONLY");
  }

  const output = {
    phase: "13A.3", targetAttempt: identity, startedAtUtc: new Date().toISOString(), localGates: gates,
    preClaimState: null, capacity: { status: "NOT_EVALUATED" }, requestBudget: null,
    claim: "NOT_RUN", claimCount: 0, generationTransition: { before: 2, afterClaim: null, after: null },
    resumeInvocationCount: 0,
    stageInvocations: Object.fromEntries(allStages.map((stage) => [stage, 0])),
    stageDispatches: Object.fromEntries(allStages.map((stage) => [stage, 0])),
    editor: null, classifier: null, ranker: null, critic: null,
    criticCheckpoint: { status: "ABSENT" }, m34: { status: "NOT_RUN" },
    humanReview: { created: false, id: null, status: null, consumed: false },
    m32: { status: "NOT_RUN", list: "NOT_RUN", inspect: "NOT_RUN" },
    providerAccounting: { historical: { requests: 5, inputTokens: 7687, outputTokens: 1749, totalTokens: 9436 }, newReservations: 0, newDispatches: 0, providerCalls: 0, newInputTokens: 0, newOutputTokens: 0, newTotalTokens: 0, retries: 0, fallback: 0, cloudflareCalls: 0, cerebrasCalls: 0, unknownReservations: 0 },
    schedulerHistoricalState: null, schedulerInvocations: 0, newTriggers: 0, newAttempts: 0, humanActions: 0,
    publisher: "NOT RUN", remoteWrites: 0, finalAttemptState: null, publicState: null,
    finalClassification: "TECHNICAL_FAILURE", readyForHumanAction: false, requests: [],
    preclaimRetryNumber: priorPreclaimFailure ? 1 : 0,
    priorPreclaimFailure: priorPreclaimFailure ? { finalClassification: priorPreclaimFailure.finalClassification, resumeInvocationCount: priorPreclaimFailure.resumeInvocationCount, claimCount: priorPreclaimFailure.claimCount, error: priorPreclaimFailure.error } : null,
  };
  writeJson(outputPath, output, priorPreclaimFailure ? "w" : "wx");
  writeJson(invocationPath, { phase: output.phase, attemptId, startedAtUtc: output.startedAtUtc, resumeInvocationCount: 0 }, priorPreclaimFailure ? "w" : "wx");

  const originalFetch = globalThis.fetch;
  const secrets = secretValuesFromEnvironment();
  const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
  const runIds = new Map();
  let pipeline, supabase, logger, snapshot, priorHashes, dayBefore, schedulerHashesBefore;
  let phase = "PRECLAIM";
  let claimCalls = 0, reviewCalls = 0;
  let result = null;
  const serialize = (value) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), JSON.stringify(value, null, 2));
  const persist = () => writeFileSync(outputPath, serialize(output) + "\n", "utf8");
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const providerCall = url.origin === "https://api.groq.com" && url.pathname === "/openai/v1/chat/completions" && method === "POST";
    const rpc = url.pathname.startsWith("/rest/v1/rpc/") ? url.pathname.split("/").at(-1) : null;
    const write = !["GET", "HEAD"].includes(method) && !readRpcs.has(rpc);
    let body = null;
    if (providerCall) {
      assert.equal(phase, "RESUME", "PROVIDER_CALL_OUTSIDE_RESUME");
      assert.equal(output.resumeInvocationCount, 1, "PROVIDER_CALL_OUTSIDE_SINGLE_RESUME");
      output.providerAccounting.providerCalls += 1;
      assert.ok(output.providerAccounting.providerCalls <= 1, "PROVIDER_CALL_LIMIT_EXCEEDED");
    } else {
      assert.equal(url.origin, origin, "NETWORK_ORIGIN_FORBIDDEN");
      assert.equal(isAllowedSupabaseRequest({ pathname: url.pathname, method, phase: phase === "RESUME" ? "RESUME" : "PREFLIGHT", readTables, readRpcs, resumeRpcs }), true, "REMOTE_OPERATION_FORBIDDEN");
      if (write) {
        body = await request.clone().json().catch(() => null);
        if (rpc === "claim_pipeline_event_attempt_capacity_resume_m35") {
          assert.equal(claimCalls++, 0, "SECOND_CLAIM_FORBIDDEN");
          assert.deepEqual([body.p_attempt_id, body.p_event_key, body.p_pipeline_run_id, body.p_resume_stage], [attemptId, eventKey, pipelineRunId, "critic"]);
        }
        if (["release_pipeline_event_attempt_capacity_resume_m35", "defer_pipeline_event_attempt_capacity_m35", "finalize_pipeline_event_attempt", "create_pipeline_human_review"].includes(rpc)) {
          assert.equal(body.p_attempt_id, attemptId); assert.equal(body.p_pipeline_run_id, pipelineRunId);
          if (body.p_event_key !== undefined) assert.equal(body.p_event_key, eventKey);
          if (rpc === "release_pipeline_event_attempt_capacity_resume_m35" && body.p_resume_stage !== undefined) assert.equal(body.p_resume_stage, "critic");
          if (rpc === "defer_pipeline_event_attempt_capacity_m35") {
            assertCapacityResumeDeferGuard({ attemptId: body.p_attempt_id, eventKey: body.p_event_key, pipelineRunId: body.p_pipeline_run_id, claimedStage: body.p_claimed_stage, resumeStage: body.p_resume_stage, snapshot: body.p_snapshot, previousGeneration: snapshot.resumeGeneration, providerRequestDispatched: body.p_provider_request_dispatched, providerRequestsUsed: body.p_provider_requests_used, countsTowardRetryLimit: body.p_counts_toward_retry_limit ?? false });
          }
        }
        if (rpc === "reserve_groq_request_and_tokens_m35") {
          const stage = body.p_agent_name;
          assert.equal(stage, "critic", "UNEXPECTED_PROVIDER_STAGE");
          assert.equal((output._reserveByStage?.[stage] ?? 0), 0, "STAGE_RETRY_OR_DUPLICATE_RESERVATION");
          output._reserveByStage ??= {}; output._reserveByStage[stage] = 1;
          assert.equal(body.p_event_key, eventKey); assert.equal(body.p_attempt, 1);
          assert.ok(runIds.has(body.p_run_id));
        }
        if (["release_agent_request", "mark_agent_request_dispatched", "settle_groq_token_usage"].includes(rpc)) assert.ok(runIds.has(body.p_run_id));
        if (rpc === "create_pipeline_human_review") {
          assert.equal(reviewCalls++, 0, "SECOND_REVIEW_FORBIDDEN");
          const durable = await readSafeCriticPipelineCheckpoint(criticPath);
          const hash = sha(readFileSync(criticPath));
          assert.deepEqual([body.p_attempt_id, body.p_event_key, body.p_pipeline_run_id], [attemptId, eventKey, pipelineRunId]);
          assert.deepEqual([durable.attemptId, durable.eventKey, durable.critic.decision], [attemptId, eventKey, "pass"]);
          assert.deepEqual(body.p_review_manifest.checkpoints.critic, { identity: `${pipelineRunId}:${attemptId}:critic:${eventKey}`, sha256: hash });
          output.m34 = { status: "DURABLE_PROOF_VALIDATED_BEFORE_CREATE", checkpointSha256: hash, identity: body.p_review_manifest.checkpoints.critic.identity };
        }
        if (url.pathname === "/rest/v1/agent_runs" && method === "POST") {
          const stage = body.config?.agentName;
          assert.equal(stage, "critic", "UNEXPECTED_AGENT_RUN_STAGE");
          assert.equal(body.config?.pipelineRunId, pipelineRunId); assert.equal(body.config?.eventKey, eventKey); assert.equal(body.provider, "groq");
          assert.equal([...runIds.values()].includes(stage), false, "DUPLICATE_STAGE_AGENT_RUN");
        }
        if (url.pathname === "/rest/v1/agent_runs" && method === "PATCH") assert.ok(runIds.has(url.searchParams.get("id")?.replace(/^eq\./, "")));
        if (url.pathname === "/rest/v1/agent_logs") assert.ok(runIds.has(body?.run_id));
        output.remoteWrites += 1;
      }
    }
    const record = { phase, method, endpoint: url.pathname, hostClass: providerCall ? "GROQ" : "SUPABASE", httpStatus: null };
    output.requests.push(record); persist();
    const response = await originalFetch(request);
    record.httpStatus = response.status;
    let payload = null;
    if (!providerCall && method !== "HEAD") payload = await response.clone().json().catch(() => null);
    if (response.ok) {
      if (rpc === "claim_pipeline_event_attempt_capacity_resume_m35" && payload === true) { output.claimCount += 1; output.claim = "PASS"; }
      if (phase === "RESUME" && method === "GET" && url.pathname === "/rest/v1/pipeline_event_attempts" && output.claimCount === 1) {
        const row = Array.isArray(payload) ? payload[0] : payload;
        if (row?.capacity_resume_snapshot) output.generationTransition.afterClaim = row.capacity_resume_snapshot.resumeGeneration;
      }
      if (url.pathname === "/rest/v1/agent_runs" && method === "POST") {
        const row = Array.isArray(payload) ? payload[0] : payload;
        assert.ok(row?.id); runIds.set(row.id, body.config.agentName);
      }
      if (rpc === "reserve_groq_request_and_tokens_m35") {
        output.capacity.reservations ??= [];
        output.capacity.reservations.push({ stage: body.p_agent_name, allowed: payload?.allowed, reason: payload?.reason ?? null, requestUsageBefore: payload?.requestUsageBefore ?? null, tokenUsageBefore: payload?.tokenUsageBefore ?? null, minuteTokenUsageBefore: payload?.minuteTokenUsageBefore ?? null, minuteTokenHardLimit: payload?.minuteTokenHardLimit ?? null, reservedTokens: payload?.reservedTokens ?? null });
        if (payload?.allowed) output.providerAccounting.newReservations += 1;
      }
      if (rpc === "mark_agent_request_dispatched" && payload === true) {
        const stage = runIds.get(body.p_run_id); output.stageDispatches[stage] += 1; output.providerAccounting.newDispatches += 1;
      }
      if (rpc === "settle_groq_token_usage" && payload?.settled) {
        output.providerAccounting.newInputTokens += body.p_actual_input_tokens;
        output.providerAccounting.newOutputTokens += body.p_actual_output_tokens;
        output.providerAccounting.newTotalTokens += body.p_actual_input_tokens + body.p_actual_output_tokens;
      }
      if (rpc === "create_pipeline_human_review") output.humanReview = { created: true, id: payload?.reviewId, status: payload?.status, consumed: false };
    } else if (!providerCall) {
      output.remoteFailure = captureSafeRunnerError({ error: payload ?? { message: "Remote HTTP failure" }, phase, secretValues: secrets });
    }
    persist(); return response;
  };
  const read = async (action) => { const response = await action(); if (response.error) throw response.error; return response.data; };
  const all = async (table) => {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const data = await read(() => supabase.from(table).select("*").order("id").range(offset, offset + 499));
      assert.ok(Array.isArray(data)); rows.push(...data); if (data.length < 500) return rows;
    }
  };
  const reviewsRead = async () => {
    const status = parseHumanReviewOperatorStatus(await read(() => supabase.rpc("get_pipeline_human_review_operator_status", {})));
    const list = parseHumanReviewOperatorList(await read(() => supabase.rpc("list_pipeline_human_reviews_operator", { p_limit: 500 })));
    return { status, list };
  };
  async function finalRead() {
    phase = "FINAL_READ";
    const attempts = await all("pipeline_event_attempts");
    const target = attempts.find((row) => row.id === attemptId); assert.ok(target, "TARGET_ATTEMPT_MISSING_AFTER_RESUME");
    assert.equal(target.event_key, eventKey); assert.equal(target.pipeline_run_id, pipelineRunId);
    output.finalAttemptState = { id: target.id, state: target.final_state ?? (target.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED" ? "DEFERRED_PROVIDER_CAPACITY" : "ACTIVE"), stopStage: target.stop_stage, stopReason: target.stop_reason, countsTowardRetryLimit: target.counts_toward_retry_limit, completedAt: target.completed_at, generation: target.capacity_resume_snapshot?.resumeGeneration ?? null };
    output.newAttempts = attempts.filter((row) => row.validation_namespace == null).length - output.preClaimState.attemptCount;
    assert.equal(output.newAttempts, 0, "NEW_ATTEMPT_CREATED");
    output.generationTransition.after = target.capacity_resume_snapshot?.resumeGeneration ?? null;
    const real = attempts.filter((row) => row.validation_namespace == null);
    const pending = real.filter((row) => row.completed_at === null && row.final_state === null);
    const deferred = pending.filter((row) => row.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED");
    const active = pending.filter((row) => row.stop_reason !== "PROVIDER_CAPACITY_EXHAUSTED");
    output.attemptCounts = { total: real.length, active: active.length, deferred: deferred.length, stuck: active.filter((row) => Date.parse(row.started_at) + 3_600_000 <= Date.now()).length };
    const scheduler = await all("scheduler_runs");
    assert.deepEqual(Object.fromEntries(scheduler.map((row) => [row.id, rowHash(row)])), schedulerHashesBefore, "SCHEDULER_STATE_CHANGED");
    output.schedulerRowsUnchanged = true; output.schedulerInvocations = 0; output.newTriggers = 0;
    const articles = await all("articles");
    const publicRows = articles.filter((row) => row.publication_status === "published");
    output.publicState = { count: publicRows.length, fingerprints: publicRows.map((row) => ({ id: row.id, sha256: publicArticleFingerprintV1(row) })).sort((a, b) => a.id.localeCompare(b.id)), unchanged: true, astra: articles.find((row) => row.id === "756b0ee0-b5e6-4153-846f-278a12c9afe3")?.publication_status ?? "ARCHIVED" };
    assert.equal(output.publicState.count, 3); assert.deepEqual(output.publicState.fingerprints, output.preClaimState.publicFingerprints, "PUBLIC_FINGERPRINT_CHANGED");
    assert.equal(output.publicState.astra, "archived");
    const { status, list } = await reviewsRead();
    output.m32.status = "PASS"; output.m32.list = "PASS";
    output.m32.counts = { total: status.totalReviews, waiting: status.waitingReviews, listed: list.reviews.length };
    if (output.humanReview.created) {
      assert.equal(status.waitingReviews, 1); assert.equal(list.reviews.length, output.preClaimState.reviewCount + 1);
      const review = list.reviews.find((row) => row.id === output.humanReview.id); assert.ok(review, "NEW_REVIEW_MISSING_FROM_M32_LIST");
      const inspected = parseHumanReviewOperatorInspection(await read(() => supabase.rpc("get_pipeline_human_review_operator_inspect", { p_review_id: review.id })));
      assert.equal(inspected.found, true);
      for (const row of [review, inspected.review]) {
        assert.deepEqual([row.id, row.attempt_id, row.event_key, row.pipeline_run_id, row.status, row.consumed_at, row.action], [output.humanReview.id, attemptId, eventKey, pipelineRunId, "WAITING_FOR_HUMAN_REVIEW", null, null]);
        assert.equal(row.critic_pass, true); assert.equal(row.provider_usage_settled, true);
        assert.equal(row.source_lineage_sha256?.length, 64);
        assert.equal(row.review_manifest.checkpoints.critic.sha256, output.m34.checkpointSha256);
        assert.equal(row.review_manifest.checkpoints.critic.identity, output.m34.identity);
      }
      assert.equal(result?.humanReviewId, output.humanReview.id);
      output.humanReview = { ...output.humanReview, status: "WAITING_FOR_HUMAN_REVIEW", consumed: false, sourceLineageSha256: inspected.review.source_lineage_sha256 };
      output.m32.inspect = "PASS"; output.m34 = { ...output.m34, status: "PASS" };
    }
    const today = new Date().toISOString().slice(0, 10);
    const after = {};
    for (const provider of ["groq", "cloudflare_workers_ai", "cerebras"]) after[provider] = await logger.getProviderDailyUsage(provider, today);
    assert.equal(after.groq.unknownTokenRequests, 0); assert.equal(after.cloudflare_workers_ai.requestsReserved, 0); assert.equal(after.cerebras.requestsReserved, 0);
    assert.equal(after.groq.requestsReserved - dayBefore.groq.requestsReserved, output.providerAccounting.newReservations);
    assert.equal(after.groq.requestsDispatched - dayBefore.groq.requestsDispatched, output.providerAccounting.newDispatches);
    output.providerAccounting.dailyBefore = Object.fromEntries(Object.entries(dayBefore).map(([provider, usage]) => [provider, summarizeUsage(usage)]));
    output.providerAccounting.dailyAfter = Object.fromEntries(Object.entries(after).map(([provider, usage]) => [provider, summarizeUsage(usage)]));
    output.providerAccounting.cumulative = { requests: 5 + output.providerAccounting.newReservations, inputTokens: 7687 + output.providerAccounting.newInputTokens, outputTokens: 1749 + output.providerAccounting.newOutputTokens, totalTokens: 9436 + output.providerAccounting.newTotalTokens, unknownReservations: after.groq.unknownTokenRequests };
    assert.ok(output.providerAccounting.cumulative.requests <= 18); assert.equal(output.providerAccounting.retries, 0); assert.equal(output.providerAccounting.fallback, 0);
    assert.deepEqual(await checkpointSha256(snapshot.checkpoints), priorHashes, "PRIOR_CHECKPOINT_CHANGED");
    if (existsSync(editorPath)) { const editor = await readSafeTranslatorEditorCheckpoint(editorPath); assert.equal(editor.eventKey, eventKey); output.editorCheckpoint = { status: "PASS", grounding: "PASS_BY_EDITOR_OUTPUT_GUARD", checkpoint: true }; }
    if (existsSync(classifierPath)) { const checkpoint = await readSafeClassifierPipelineCheckpoint(classifierPath); assert.equal(checkpoint.eventKey, eventKey); output.classifierCheckpoint = "PASS"; }
    if (existsSync(rankerPath)) { const checkpoint = await readSafeRankerPipelineCheckpoint(rankerPath); assert.equal(checkpoint.eventKey, eventKey); output.rankerCheckpoint = "PASS"; }
    if (existsSync(criticPath)) { const durable = await readSafeCriticPipelineCheckpoint(criticPath); assert.deepEqual([durable.eventKey, durable.attemptId], [eventKey, attemptId]); output.criticCheckpoint = { status: "PASS", decision: durable.critic.decision, sha256: sha(readFileSync(criticPath)) }; }
    output.finalClassification = result?.finalState ?? "TECHNICAL_FAILURE";
    output.publisher = "NOT RUN"; output.humanActions = 0;
    output.readyForHumanAction = output.finalClassification === "WAITING_FOR_HUMAN_REVIEW" && output.humanReview.status === "WAITING_FOR_HUMAN_REVIEW" && output.m32.status === "PASS" && output.m32.list === "PASS" && output.m32.inspect === "PASS" && output.criticCheckpoint.decision === "pass" && output.providerAccounting.cumulative.requests <= 18 && output.publicState.unchanged;
  }
  try {
    const gatesOnDisk = JSON.parse(readFileSync(gatesPath, "utf8")); assert.equal(gatesOnDisk.status, "PASS");
    ({ snapshot } = await readCapacityResumeSnapshot(snapshotPath));
    const history = Object.values(snapshot.providerAccounting);
    assert.deepEqual(["providerRequestsUsed", "inputTokens", "outputTokens", "totalTokens"].map((key) => history.reduce((sum, row) => sum + row[key], 0)), [5, 7687, 1749, 9436], "HISTORICAL_ACCOUNTING_CHANGED");
    assert.deepEqual([snapshot.attemptId, snapshot.eventKey, snapshot.pipelineRunId, snapshot.resumeStage, snapshot.resumeGeneration, snapshot.nextStageDispatchCount, snapshot.nextStageCheckpointPresent], [attemptId, eventKey, pipelineRunId, "critic", 2, 0, false]);
    assert.equal(process.env.AGENT_PROVIDER?.trim(), "groq"); assert.equal(readGroqMaxConcurrentEvents(), 1);
    const budget = createCapacityResumeRequestBudget(snapshot);
    const { supabase: sb, logger: lg, pipeline: pl } = createCapacityResumeProductionPipeline({ requestBudget: budget, pipelineRunId });
    supabase = sb; logger = lg; pipeline = pl;
    assert.ok(Object.values(pipeline.configs).every((config) => config.maxRetries === 0 && !config.allowPaidFallback && !config.allowProviderPacingWait), "RETRY_FALLBACK_OR_PACING_NOT_DISABLED");
    const target = await read(() => supabase.from("pipeline_event_attempts").select("*").eq("id", attemptId).single());
    assert.deepEqual([target.id, target.event_key, target.pipeline_run_id], [attemptId, eventKey, pipelineRunId]);
    assert.deepEqual([target.completed_at, target.final_state, target.stop_stage, target.stop_reason, target.counts_toward_retry_limit], [null, null, "critic", "PROVIDER_CAPACITY_EXHAUSTED", false]);
    assert.ok(capacityResumeSnapshotsMatch(snapshot, target.capacity_resume_snapshot), "DURABLE_SNAPSHOT_MISMATCH");
    priorHashes = await checkpointSha256(snapshot.checkpoints);
    assert.equal(priorHashes.verifier, snapshot.checkpointSha256.verifier); assert.equal(priorHashes.translator, snapshot.checkpointSha256.translator);
    const verifier = await readSafeTranslatorCheckpoint(snapshot.checkpoints.verifier.path);
    const translator = await readSafeTranslatorCheckpoint(snapshot.checkpoints.translator.path);
    assert.equal(verifier.eventKey, eventKey); assert.equal(translator.eventKey, eventKey);
    const editorCheckpoint = await readSafeTranslatorEditorCheckpoint(editorPath);
    const classifierCheckpoint = await readSafeClassifierPipelineCheckpoint(classifierPath);
    assert.equal(editorCheckpoint.eventKey, eventKey); assert.equal(classifierCheckpoint.eventKey, eventKey);
    assert.ok(snapshot.geo && snapshot.classification, "RANKER_SNAPSHOT_MISSING_COMPLETED_CLASSIFIER_OR_GEO");
    assert.ok(existsSync(rankerPath), "RANKER_CHECKPOINT_MISSING");
    assert.equal(existsSync(criticPath), false, "CRITIC_CHECKPOINT_ALREADY_EXISTS");
    const runs = await read(() => supabase.from("agent_runs").select("*").eq("config->>pipelineRunId", pipelineRunId).limit(501));
    assert.ok(runs.length < 501);
    const runIdsBefore = runs.map((run) => run.id);
    const logs = runIdsBefore.length ? await read(() => supabase.from("agent_logs").select("*").in("run_id", runIdsBefore).range(0, 4999)) : [];
    assert.ok(logs.length < 5000);
    const priorDispatches = logs.filter((row) => row.step === "provider_request_reserved" && row.payload?.providerRequestDispatched === true);
    assert.equal(priorDispatches.length, 5, "PRIOR_DISPATCH_COUNT_MISMATCH");
    assert.deepEqual(priorDispatches.map((row) => runs.find((run) => run.id === row.run_id)?.config?.agentName).sort(), priorStages.slice().sort(), "UNEXPECTED_PRIOR_DISPATCH_STAGE");
    assert.equal(logs.some((row) => row.step === "provider_request_reserved" && row.payload?.providerRequestDispatched === true && runs.find((run) => run.id === row.run_id)?.config?.agentName === "critic"), false, "CRITIC_ALREADY_DISPATCHED");
    const reviewsBefore = await reviewsRead();
    const reviewRows = reviewsBefore.list.reviews;
    assert.equal(reviewsBefore.status.waitingReviews, 0, "PREEXISTING_WAITING_REVIEW");
    const articles = await all("articles");
    const publicRows = articles.filter((row) => row.publication_status === "published");
    assert.equal(publicRows.length, 3);
    const schedulerRows = await all("scheduler_runs"); schedulerHashesBefore = Object.fromEntries(schedulerRows.map((row) => [row.id, rowHash(row)]));
    const previous = JSON.parse(readFileSync(previousPath, "utf8"));
    const trigger = schedulerRows.find((row) => row.id === previous.schedulerFinalization.schedulerRunId); assert.ok(trigger, "HISTORICAL_SCHEDULER_RUN_MISSING");
    assert.deepEqual([trigger.run_status, trigger.final_decision, trigger.stop_reason], ["blocked", "blocked", "PROVIDER_CAPACITY_EXHAUSTED"]);
    dayBefore = {};
    const today = new Date().toISOString().slice(0, 10);
    for (const provider of ["groq", "cloudflare_workers_ai", "cerebras"]) dayBefore[provider] = await logger.getProviderDailyUsage(provider, today);
    assert.deepEqual([dayBefore.groq.requestsReserved, dayBefore.groq.requestsDispatched, dayBefore.groq.inputTokens, dayBefore.groq.outputTokens, dayBefore.groq.totalTokens, dayBefore.groq.unknownTokenRequests], [5, 5, 7687, 1749, 9436, 0], "13A2_PROVIDER_ACCOUNTING_CHANGED");
    assert.equal(dayBefore.cloudflare_workers_ai.requestsReserved, 0); assert.equal(dayBefore.cerebras.requestsReserved, 0);
    const limits = pipeline.configs.critic.groqCapacity;
    assert.deepEqual([limits.requestHardLimit, limits.requestSoftLimit, limits.tokenHardLimit, limits.tokenSoftLimit, limits.tokenMinuteHardLimit], [1000, 850, 200000, 170000, 8000]);
    const budgetContract = inspectSupervisedRequestCapContract({ providerRpdHardLimit: limits.requestHardLimit, providerRpdSoftLimit: limits.requestSoftLimit, providerRpdRemaining: await pipeline.quota.remaining(), requestBudget: budget });
    assert.deepEqual([budgetContract.supervisedExecutionRequestCap, budgetContract.cumulativeAttemptRequests, budgetContract.remainingExecutionRequests], [18, 5, 13]);
    const providerHeader = await logger.getLatestProviderRateLimitSnapshot("groq");
    output.capacity = { status: "CANONICAL_ADMISSION_AT_CRITIC_RESERVATION", limits: { providerRpmHard: 30, providerTpmHard: limits.tokenMinuteHardLimit, providerRpdHard: limits.requestHardLimit, providerRpdSoft: limits.requestSoftLimit, providerTpdHard: limits.tokenHardLimit, providerTpdSoft: limits.tokenSoftLimit }, currentDailyUsage: summarizeUsage(dayBefore.groq), providerHeader: providerHeader ? { observedAt: providerHeader.observedAt, tokenRemainingMinute: providerHeader.telemetry.tokenRemainingMinute, tokenResetSeconds: providerHeader.telemetry.tokenResetSeconds, freshnessMs: Date.now() - Date.parse(providerHeader.observedAt) } : null, minuteWindow: "recomputed atomically by M35/M36 at reserve; prior response headers are used only if fresh under unified policy" };
    output.requestBudget = budgetContract;
    const preflightEvidence = { attempt: { attemptId, eventKey, pipelineRunId, startedAt: target.started_at, completedAt: target.completed_at, finalState: target.final_state, stopStage: target.stop_stage, stopReason: target.stop_reason, countsTowardRetryLimit: target.counts_toward_retry_limit }, currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items, currentCheckpointSha256: priorHashes, nextStageDispatchCount: 0, nextStageCheckpointPresent: false, unresolvedProviderUsage: false, activeOwner: false, terminalEditorialRejection: false };
    const assessment = assessCapacityResume(snapshot, preflightEvidence, { ownerId: randomUUID() });
    if (!assessment.valid) throw new Error(`CAPACITY_RESUME_EVIDENCE_INVALID:${assessment.reasons.join(",")}`);
    assert.equal(assessment.firstStage, "critic"); assert.equal(assessment.previousModelCallsToRepeat, 0);
    output.preClaimState = { status: "PASS", state: "DEFERRED_PROVIDER_CAPACITY", resumeStage: "Critic", generation: 2, countsTowardRetryLimit: false, checkpoints: { verifier: "PASS", translator: "PASS", editor: "PASS", classifier: "PASS", geo: "PASS", ranker: "PASS" }, criticCheckpoint: "ABSENT", criticDispatch: false, priorStageDispatches: { verifier: 1, translator: 1, editor: 1, classifier: 1, ranker: 1 }, sameEventLineage: true, samePipelineRunLineage: true, unknownReservations: 0, attemptCount: runs.length ? (await all("pipeline_event_attempts")).filter((row) => row.validation_namespace == null).length : null, reviewCount: reviewRows.length, publicFingerprints: publicRows.map((row) => ({ id: row.id, sha256: publicArticleFingerprintV1(row) })).sort((a, b) => a.id.localeCompare(b.id)) };
    assert.equal(output.preClaimState.attemptCount, 20);
    for (const stage of [...priorStages, "geo"]) pipeline.stages[stage] = async () => { throw new Error("INCIDENT_DUPLICATE_STAGE_DISPATCH:" + stage); };
    for (const stage of ["publisher", "discovery", "extraction", "clustering"]) pipeline.stages[stage] = async () => { throw new Error("FORBIDDEN_STAGE_DISPATCH:" + stage); };
    for (const stage of ["critic"]) {
      const original = pipeline.stages[stage];
      pipeline.stages[stage] = async (...args) => { assert.equal(output.stageInvocations[stage], 0, "DUPLICATE_STAGE_INVOCATION:" + stage); output.stageInvocations[stage] += 1; return original(...args); };
    }
    const contractSnapshot = await readCapacityResumeSnapshot(snapshotPath);
    const ownerId = randomUUID();
    const evidence = { ...preflightEvidence, activeOwner: false };
    phase = "RESUME"; output.resumeInvocationCount = 1;
    writeJson(invocationPath, { phase: output.phase, attemptId, startedAtUtc: output.startedAtUtc, resumeInvocationCount: 1, ownerId }, "w"); persist();
    result = await pipeline.orchestrator.resumeCapacityDeferred({ snapshot: contractSnapshot.snapshot, evidence, ownerId });
    assert.equal(output.resumeInvocationCount, 1); assert.equal(output.claimCount, 1, "SAME_ATTEMPT_CLAIM_NOT_PROVEN");
    output.generationTransition.afterClaim ??= 2;
    output.capacity.status = output.capacity.reservations?.some((row) => row.allowed === false) ? "DEFER" : "PASS";
    const telem = result.telemetry ?? {};
    for (const stage of ["critic"]) {
      const t = telem[stage];
      if (t) {
        output[stage] = { status: t.status, provider: t.provider, requests: t.providerRequestsUsed, dispatched: t.providerRequestDispatched, retries: t.retries, inputTokens: t.inputTokens, outputTokens: t.outputTokens, totalTokens: t.totalTokens };
        output.providerAccounting.retries += t.retries ?? 0;
        if (t.provider && t.provider !== "groq") output.providerAccounting.fallback += t.providerRequestsUsed ?? 0;
        if (t.provider === "cloudflare_workers_ai") output.providerAccounting.cloudflareCalls += t.providerRequestsUsed ?? 0;
        if (t.provider === "cerebras") output.providerAccounting.cerebrasCalls += t.providerRequestsUsed ?? 0;
      }
    }
    output.critic = { ...(output.critic ?? {}), decision: result.criticDecision ?? null, durableCheckpoint: existsSync(criticPath) ? "PENDING_VALIDATION" : "ABSENT" };
    if (result.finalState === "DEFERRED_PROVIDER_CAPACITY") output.capacity.status = "DEFER";
    await finalRead();
  } catch (error) {
    output.error = captureSafeRunnerError({ error, phase, secretValues: secrets });
    output.finalClassification = result?.finalState ?? (phase === "PRECLAIM" ? "PRECLAIM_FAILURE" : "TECHNICAL_FAILURE");
    output.readyForHumanAction = false;
    if (phase === "PRECLAIM") output.claim = "NOT_RUN";
  } finally {
    globalThis.fetch = originalFetch;
    output.completedAtUtc = new Date().toISOString();
    delete output._reserveByStage;
    persist();
    const lines = [
      "# FASE 13A.3 — Reanudación controlada desde Critic",
      "",
      `Resultado: **${output.finalClassification}**. READY FOR HUMAN ACTION: **${output.readyForHumanAction ? "YES" : "NO"}**.`,
      "",
      `Intento: ${attemptId}; evento: ${eventKey}; pipeline: ${pipelineRunId}.`,
      "",
      `Estado previo: ${output.preClaimState?.status ?? "NO VALIDADO"}; Critic era la etapa pendiente en generación 2. Reanudaciones: ${output.resumeInvocationCount}. Scheduler nuevo: 0; intentos nuevos: ${output.newAttempts}.`,
      "",
      `Capacidad: ${output.capacity.status}; límites RPM/TPM/RPD/TPD quedan separados del tope supervisado 18. Uso histórico: 5 solicitudes y 9.436 tokens; cupo antes: 13.`,
      "",
      `Etapas: Verifier redispatch ${output.stageDispatches.verifier}; Translator redispatch ${output.stageDispatches.translator}; Editor ${output.editor?.status ?? "NOT RUN"}; Classifier ${output.classifier?.status ?? "NOT RUN"}; Ranker ${output.ranker?.status ?? "NOT RUN"}; Critic ${output.critic?.decision ?? "NOT RUN"}.`,
      "",
      `M34: ${output.m34.status}; review creada: ${output.humanReview.created}; M32 status/list/inspect: ${output.m32.status}/${output.m32.list}/${output.m32.inspect}. Publisher: ${output.publisher}.`,
      "",
      `Contabilidad nueva: ${output.providerAccounting.newReservations} reservas, ${output.providerAccounting.newDispatches} despachos, ${output.providerAccounting.newInputTokens} entrada, ${output.providerAccounting.newOutputTokens} salida, ${output.providerAccounting.newTotalTokens} tokens; acumulado: ${output.providerAccounting.cumulative?.requests ?? "sin reconciliar"} solicitudes.`,
      "",
      `Público: ${output.publicState?.count ?? "no reconciliado"}; fingerprints sin cambios: ${output.publicState?.unchanged ?? false}; Astra: ${output.publicState?.astra ?? "no reconciliado"}.`,
      "",
      `Evidencia estructurada: [${outputPath}](../${outputPath}).`,
    ];
    writeFileSync(docPath, lines.join("\n") + "\n", { encoding: "utf8", flag: priorPreclaimFailure ? "w" : "wx" });
  }
  console.log(JSON.stringify({ phase: output.phase, preClaimState: output.preClaimState?.status, capacity: output.capacity.status, claim: output.claim, resumeInvocationCount: output.resumeInvocationCount, finalClassification: output.finalClassification, editor: output.editor, classifier: output.classifier, ranker: output.ranker, critic: output.critic, m34: output.m34, humanReview: output.humanReview, m32: output.m32, providerAccounting: output.providerAccounting, finalAttemptState: output.finalAttemptState, publicState: output.publicState, readyForHumanAction: output.readyForHumanAction }, null, 2));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--execute-once") throw new Error("EXACT_EXECUTE_ONCE_FLAG_REQUIRED");
  runOnce().catch((error) => { console.error(JSON.stringify(captureSafeRunnerError({ error, phase: "RUNNER_SETUP", secretValues: secretValuesFromEnvironment() }))); process.exitCode = 1; });
}
