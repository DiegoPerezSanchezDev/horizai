import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createCapacityResumeProductionPipeline } from "./capacity-resume-production-pipeline.ts";
import { createCapacityResumeRequestBudget, inspectSupervisedRequestCapContract } from "../lib/agents/pipeline/supervised-request-cap-contract.ts";
import { assessCapacityResume, capacityResumeSnapshotsMatch, checkpointSha256, readCapacityResumeSnapshot } from "../lib/agents/pipeline/provider-capacity-resume.ts";
import { readSafeCriticPipelineCheckpoint } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { parseHumanReviewOperatorList, parseHumanReviewOperatorInspection } from "../lib/agents/publisher/human-review-read-repository.ts";
import { parseHumanReviewOperatorStatus } from "../lib/agents/publisher/human-review-status.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { readGroqMaxConcurrentEvents } from "../lib/agents/runtime/groq-capacity-policy.ts";
import { AgentError } from "../lib/agents/runtime/agent-errors.ts";
import { captureSafeRunnerError } from "../lib/agents/pipeline/preflight-runner-observability.ts";
import { secretValuesFromEnvironment } from "../lib/agents/pipeline/construction-diagnostics.ts";
import { isAllowedSupabaseRequest } from "../lib/supabase/readonly-request-guard.ts";

export const identity = {
  attemptId: "4658d5c0-857c-4ed5-b97f-afb133b2bf22",
  eventKey: "event-5c7d0ef5ea6f72bec96704aded750851",
  pipelineRunId: "f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d",
};
const { attemptId, eventKey, pipelineRunId } = identity;
const root = `artifacts/pipeline-checkpoints/${pipelineRunId}`;
const snapshotPath = `${root}/capacity-resume-${eventKey}-critic-g1.json`;
const criticPath = `${root}/critic-${eventKey}.json`;
const outputPath = "artifacts/supervised-cycle-12f12h-critic-human-review.json";
const invocationPath = "artifacts/supervised-cycle-12f12h-invocation.json";
const docPath = "docs/supervised-cycle-12f12h-critic-human-review.md";
const gatesPath = "artifacts/supervised-cycle-12f12h-local-gates.json";
const priorStages = ["verifier", "translator", "editor", "classifier", "ranker"];
const readTables = new Set(["pipeline_event_attempts", "agent_runs", "agent_logs", "articles", "scheduler_runs", "regions", "categories", "sources", "raw_items"]);
const readRpcs = new Set(["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator", "get_pipeline_human_review_operator_inspect"]);
const resumeRpcs = new Set(["claim_pipeline_event_attempt_capacity_resume_m35", "release_pipeline_event_attempt_capacity_resume_m35", "defer_pipeline_event_attempt_capacity_m35", "finalize_pipeline_event_attempt", "reserve_groq_request_and_tokens_m35", "release_agent_request", "mark_agent_request_dispatched", "settle_groq_token_usage", "create_pipeline_human_review"]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const rowHash = (value) => sha(JSON.stringify(canonical(value)));

export function cumulativeAccounting(accounting) {
  const tokensKnown = accounting.newDispatches === 0 || accounting.settled === true;
  return { requests: 5 + accounting.newDispatches,
    inputTokens: tokensKnown ? 6748 + accounting.newInputTokens : null,
    outputTokens: tokensKnown ? 1617 + accounting.newOutputTokens : null,
    totalTokens: tokensKnown ? 8365 + accounting.newTotalTokens : null,
    actualTokensKnown: tokensKnown };
}

export function validatePreClaim(target, snapshot, previous, hashes, criticAbsent) {
  assert.equal(rowHash(target), previous.preflightEvidence.rowHashes.attempts[attemptId], "PRECLAIM_ATTEMPT_CHANGED");
  assert.deepEqual([target.id, target.event_key, target.pipeline_run_id], [attemptId, eventKey, pipelineRunId], "PRECLAIM_LINEAGE_CHANGED");
  assert.deepEqual([target.completed_at, target.final_state, target.stop_stage, target.stop_reason, target.counts_toward_retry_limit], [null, null, "critic", "PROVIDER_CAPACITY_EXHAUSTED", false], "PRECLAIM_NOT_DEFERRED_CRITIC");
  assert.ok(capacityResumeSnapshotsMatch(snapshot, target.capacity_resume_snapshot), "PRECLAIM_SNAPSHOT_CHANGED");
  assert.deepEqual([snapshot.resumeStage, snapshot.resumeGeneration, snapshot.nextStageDispatchCount, snapshot.nextStageCheckpointPresent], ["critic", 1, 0, false]);
  assert.deepEqual(Object.keys(snapshot.checkpoints).sort(), priorStages.slice().sort());
  assert.equal(criticAbsent, true, "PRECLAIM_CRITIC_CHECKPOINT_PRESENT");
  for (const stage of priorStages) assert.equal(hashes[stage], previous.preflightEvidence.checkpoints.hashes[stage], "PRECLAIM_CHECKPOINT_CHANGED:" + stage);
}

export function validateM34Create(body, durable, hash) {
  assert.deepEqual([body.p_attempt_id, body.p_event_key, body.p_pipeline_run_id], [attemptId, eventKey, pipelineRunId], "M34_REVIEW_LINEAGE_MISMATCH");
  assert.deepEqual([durable.attemptId, durable.eventKey, durable.critic.decision], [attemptId, eventKey, "pass"], "M34_DURABLE_PASS_REQUIRED");
  assert.deepEqual(body.p_review_manifest.checkpoints.critic, { identity: `${pipelineRunId}:${attemptId}:critic:${eventKey}`, sha256: hash }, "M34_DURABLE_CHECKPOINT_PROOF_MISMATCH");
}

export async function runOnce() {
  const previous = JSON.parse(readFileSync("artifacts/supervised-cycle-12f12g2-request-cap.json", "utf8"));
  const gates = JSON.parse(readFileSync(gatesPath, "utf8"));
  assert.equal(gates.status, "PASS", "LOCAL_GATES_REQUIRED");
  for (const [path, hash] of Object.entries(gates.sourceHashes)) assert.equal(sha(readFileSync(path)), hash, "GATED_SOURCE_CHANGED:" + path);
  assert.equal(previous.canonicalPreflight.status, "PASS");
  assert.equal(previous.readyForCriticResume, true);
  for (const path of [outputPath, invocationPath, docPath]) assert.equal(existsSync(path), false, "12F12H_ALREADY_RECORDED");
  const output = {
    phase: "12F.12H", targetAttempt: identity, startedAtUtc: new Date().toISOString(), localGates: gates,
    canonicalPreflightInvocations: 0, preClaimState: null, capacity: { status: "NOT_EVALUATED" }, requestBudget: null,
    claim: "NOT_RUN", claims: 0, claimRequests: 0, generationTransition: { before: 1, afterClaim: null, after: null },
    resumeInvocationCount: 0, stageInvocations: Object.fromEntries([...priorStages, "critic", "publisher"].map((s) => [s, 0])),
    stageDispatches: Object.fromEntries([...priorStages, "critic"].map((s) => [s, 0])),
    critic: null, criticCheckpoint: { status: "ABSENT" }, m34: { status: "NOT_RUN" }, review: { created: false },
    m32: { status: "NOT_RUN", list: "NOT_RUN", inspect: "NOT_RUN" },
    providerAccounting: { historical: { requests: 5, inputTokens: 6748, outputTokens: 1617, totalTokens: 8365 }, newReservations: 0, newDispatches: 0, providerCalls: 0, newInputTokens: 0, newOutputTokens: 0, newTotalTokens: 0, retries: 0, fallback: 0, cloudflareCalls: 0, cerebrasCalls: 0 },
    publisher: "NOT RUN", dailySchedulerRuns: 0, newTriggers: 0, newAttempts: 0, humanActions: 0, remoteWrites: 0,
    finalClassification: "TECHNICAL_FAILURE", readyForHumanAction: false, requests: [],
  };
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
  writeFileSync(invocationPath, JSON.stringify({ phase: output.phase, startedAtUtc: output.startedAtUtc, attemptId, resumeInvocationCount: 0 }, null, 2) + "\n", { flag: "wx" });
  let phase = "PRECLAIM";
  const originalFetch = globalThis.fetch;
  const secrets = secretValuesFromEnvironment();
  const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
  const runIds = new Set();
  let reserveCalls = 0, reviewCalls = 0;
  let pipeline, supabase, logger, snapshot, priorHashes, dayBefore;
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
      assert.equal(phase, "RESUME"); assert.equal(output.claims, 1); assert.equal(output.resumeInvocationCount, 1);
      assert.equal(output.providerAccounting.providerCalls, 0, "SECOND_PROVIDER_CALL_FORBIDDEN");
      assert.equal(output.providerAccounting.newReservations, 1, "PROVIDER_RESERVATION_REQUIRED");
      output.providerAccounting.providerCalls += 1;
    } else {
      assert.equal(url.origin, origin, "NETWORK_ORIGIN_FORBIDDEN");
      assert.equal(isAllowedSupabaseRequest({ pathname: url.pathname, method, phase: phase === "RESUME" ? "RESUME" : "PREFLIGHT", readTables, readRpcs, resumeRpcs }), true, "REMOTE_OPERATION_FORBIDDEN");
      if (write) {
        body = await request.clone().json();
        if (rpc === "claim_pipeline_event_attempt_capacity_resume_m35") {
          assert.equal(output.claimRequests, 0, "SECOND_CLAIM_FORBIDDEN"); output.claimRequests += 1;
        }
        if (["claim_pipeline_event_attempt_capacity_resume_m35", "release_pipeline_event_attempt_capacity_resume_m35", "defer_pipeline_event_attempt_capacity_m35", "finalize_pipeline_event_attempt", "create_pipeline_human_review"].includes(rpc)) {
          assert.equal(body.p_attempt_id, attemptId); assert.equal(body.p_pipeline_run_id, pipelineRunId);
          if (body.p_event_key !== undefined) assert.equal(body.p_event_key, eventKey);
          if (body.p_resume_stage !== undefined) assert.equal(body.p_resume_stage, "critic");
        }
        if (rpc === "reserve_groq_request_and_tokens_m35") {
          assert.equal(reserveCalls++, 0, "SECOND_RESERVATION_FORBIDDEN");
          assert.equal(body.p_agent_name, "critic"); assert.equal(body.p_event_key, eventKey); assert.equal(body.p_attempt, 1);
          assert.ok(runIds.has(body.p_run_id));
        }
        if (["release_agent_request", "mark_agent_request_dispatched", "settle_groq_token_usage"].includes(rpc)) assert.ok(runIds.has(body.p_run_id));
        if (rpc === "create_pipeline_human_review") {
          assert.equal(reviewCalls++, 0, "SECOND_REVIEW_FORBIDDEN");
          const durable = await readSafeCriticPipelineCheckpoint(criticPath);
          const hash = sha(readFileSync(criticPath));
          validateM34Create(body, durable, hash);
          assert.equal(output.providerAccounting.newDispatches, 1);
          output.m34 = { status: "DURABLE_PROOF_VALIDATED_BEFORE_CREATE", checkpointSha256: hash, identity: body.p_review_manifest.checkpoints.critic.identity };
        }
        if (url.pathname === "/rest/v1/agent_runs" && method === "POST") {
          assert.deepEqual([body.config?.agentName, body.config?.pipelineRunId, body.config?.eventKey, body.provider], ["critic", pipelineRunId, eventKey, "groq"]);
          assert.equal(runIds.size, 0, "SECOND_AGENT_RUN_FORBIDDEN");
        }
        if (url.pathname === "/rest/v1/agent_runs" && method === "PATCH") assert.ok(runIds.has(url.searchParams.get("id")?.replace(/^eq\./, "")));
        if (url.pathname === "/rest/v1/agent_logs") assert.ok(runIds.has(body.run_id));
        output.remoteWrites += 1;
      }
    }
    const record = { phase, method, endpoint: url.pathname, hostClass: providerCall ? "GROQ" : "SUPABASE", httpStatus: null };
    output.requests.push(record);
    persist();
    const response = await originalFetch(request);
    record.httpStatus = response.status;
    let payload = null;
    // Never persist a provider response body or credentials.
    if (!providerCall && method !== "HEAD") payload = await response.clone().json().catch(() => null);
    if (response.ok) {
      if (rpc === "claim_pipeline_event_attempt_capacity_resume_m35" && payload === true) { output.claims += 1; output.claim = "PASS"; }
      if (phase === "RESUME" && method === "GET" && url.pathname === "/rest/v1/pipeline_event_attempts" && output.claims === 1) {
        const row = Array.isArray(payload) ? payload[0] : payload;
        if (row?.capacity_resume_snapshot) output.generationTransition.afterClaim = row.capacity_resume_snapshot.resumeGeneration;
      }
      if (url.pathname === "/rest/v1/agent_runs" && method === "POST") {
        const row = Array.isArray(payload) ? payload[0] : payload;
        assert.ok(row?.id); runIds.add(row.id);
      }
      if (rpc === "reserve_groq_request_and_tokens_m35") {
        output.capacity.reservation = payload;
        if (payload?.allowed) output.providerAccounting.newReservations += 1;
      }
      if (rpc === "mark_agent_request_dispatched" && payload === true) { output.providerAccounting.newDispatches += 1; output.stageDispatches.critic += 1; }
      if (rpc === "release_agent_request" && payload === true) output.providerAccounting.releasedBeforeDispatch = true;
      if (rpc === "settle_groq_token_usage" && payload?.settled) {
        output.providerAccounting.newInputTokens = body.p_actual_input_tokens;
        output.providerAccounting.newOutputTokens = body.p_actual_output_tokens;
        output.providerAccounting.newTotalTokens = body.p_actual_input_tokens + body.p_actual_output_tokens;
        output.providerAccounting.settled = true;
      }
      if (rpc === "create_pipeline_human_review") output.review = { created: true, id: payload?.reviewId, status: payload?.status, consumed: false, factualReviewRequired: true, attributionReviewRequired: true };
    } else if (!providerCall) {
      output.remoteFailure = captureSafeRunnerError({ error: payload ?? { message: "Remote HTTP failure" }, phase, secretValues: secrets });
    }
    persist();
    return response;
  };
  const read = async (action) => { const r = await action(); if (r.error) throw r.error; return r.data; };
  const all = async (table) => {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const data = await read(() => supabase.from(table).select("*").order("id").range(offset, offset + 499));
      assert.ok(Array.isArray(data)); rows.push(...data); if (data.length < 500) return rows;
    }
  };
  async function finalRead(result) {
    phase = "FINAL_READ";
    const attempts = await all("pipeline_event_attempts");
    const target = attempts.find((row) => row.id === attemptId);
    assert.ok(target);
    output.finalAttemptState = { id: target.id, state: target.final_state ?? (target.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED" ? "DEFERRED_PROVIDER_CAPACITY" : "ACTIVE"), stopStage: target.stop_stage, stopReason: target.stop_reason, countsTowardRetryLimit: target.counts_toward_retry_limit, completedAt: target.completed_at, generation: target.capacity_resume_snapshot?.resumeGeneration ?? null };
    const real = attempts.filter((row) => row.validation_namespace == null);
    const pending = real.filter((row) => row.completed_at === null && row.final_state === null);
    const deferred = pending.filter((row) => row.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED");
    const active = pending.filter((row) => row.stop_reason !== "PROVIDER_CAPACITY_EXHAUSTED");
    output.finalCounts = { attempts: real.length, activeDeferredStuck: [active.length, deferred.length, active.filter((row) => Date.parse(row.started_at) + 3600000 <= Date.now()).length] };
    assert.equal(real.length, 19); assert.equal(active.length, 0, "ATTEMPT_LEFT_ACTIVE");
    output.generationTransition.after = target.capacity_resume_snapshot?.resumeGeneration ?? null;
    const articles = await all("articles");
    output.publicState = { count: articles.filter((row) => row.publication_status === "published").length, astraStatus: articles.find((row) => row.id === "756b0ee0-b5e6-4153-846f-278a12c9afe3")?.publication_status, fingerprints: articles.filter((row) => row.publication_status === "published").map((row) => ({ id: row.id, sha256: publicArticleFingerprintV1(row) })).sort((a, b) => a.id.localeCompare(b.id)) };
    assert.equal(output.publicState.count, 2); assert.equal(output.publicState.astraStatus, "archived");
    assert.deepEqual(output.publicState.fingerprints, previous.baseline.public.fingerprints);
    output.publicState.fingerprintsUnchanged = true;
    const scheduler = await all("scheduler_runs");
    assert.deepEqual(Object.fromEntries(scheduler.map((row) => [row.id, rowHash(row)])), previous.preflightEvidence.rowHashes.scheduler);
    output.schedulerUnchanged = true;
    const status = parseHumanReviewOperatorStatus(await read(() => supabase.rpc("get_pipeline_human_review_operator_status", {})));
    const list = parseHumanReviewOperatorList(await read(() => supabase.rpc("list_pipeline_human_reviews_operator", { p_limit: 500 })));
    output.m32.status = "PASS"; output.m32.list = "PASS";
    output.finalReviewState = { total: status.totalReviews, waiting: status.waitingReviews };
    if (output.review.created) {
      assert.equal(list.reviews.length, 1); assert.equal(status.totalReviews, 1); assert.equal(status.waitingReviews, 1);
      const review = list.reviews[0];
      const inspected = parseHumanReviewOperatorInspection(await read(() => supabase.rpc("get_pipeline_human_review_operator_inspect", { p_review_id: review.id })));
      assert.equal(inspected.found, true);
      for (const row of [review, inspected.review]) {
        assert.deepEqual([row.id, row.attempt_id, row.event_key, row.pipeline_run_id, row.status, row.consumed_at, row.action], [output.review.id, attemptId, eventKey, pipelineRunId, "WAITING_FOR_HUMAN_REVIEW", null, null]);
        assert.equal(row.critic_pass, true); assert.equal(row.provider_usage_settled, true);
        assert.equal(row.review_manifest.checkpoints.critic.sha256, output.m34.checkpointSha256);
        assert.equal(row.review_manifest.checkpoints.critic.identity, output.m34.identity);
      }
      assert.equal(result?.humanReviewId, review.id);
      output.m32.inspect = "PASS"; output.m34.status = "PASS";
      output.review = { ...output.review, status: "WAITING", consumed: false };
    } else { assert.equal(status.totalReviews, 0); assert.equal(list.reviews.length, 0); }
    const day = new Date().toISOString().slice(0, 10);
    output.providerAccounting.dailyAfter = {};
    for (const provider of ["groq", "cloudflare_workers_ai", "cerebras"]) {
      const usage = await logger.getProviderDailyUsage(provider, day);
      assert.equal(usage.unknownTokenRequests, 0, "UNKNOWN_RESERVATIONS");
      output.providerAccounting.dailyAfter[provider] = usage;
    }
    output.providerAccounting.unknownReservations = 0;
    const actual = output.providerAccounting.dailyAfter.groq;
    assert.equal(actual.requestsDispatched - dayBefore.requestsDispatched, output.providerAccounting.newDispatches);
    output.providerAccounting.cumulative = cumulativeAccounting(output.providerAccounting);
    assert.ok(output.providerAccounting.cumulative.requests <= output.requestBudget.supervisedExecutionRequestCap);
    assert.deepEqual(await checkpointSha256(snapshot.checkpoints), priorHashes, "PRIOR_CHECKPOINT_CHANGED");
    if (existsSync(criticPath)) {
      const durable = await readSafeCriticPipelineCheckpoint(criticPath);
      assert.deepEqual([durable.eventKey, durable.attemptId], [eventKey, attemptId]);
      output.criticCheckpoint = { status: "PASS", decision: durable.critic.decision, sha256: sha(readFileSync(criticPath)), path: criticPath };
    }
    output.finalClassification = result?.finalState === "FAILED" ? "TECHNICAL_FAILURE" : result?.finalState ?? "TECHNICAL_FAILURE";
    if (result?.stopReason === "INCIDENT_DUPLICATE_STAGE_DISPATCH") output.finalClassification = "INCIDENT_DUPLICATE_STAGE_DISPATCH";
    output.readyForHumanAction = output.finalClassification === "WAITING_FOR_HUMAN_REVIEW" && output.criticCheckpoint.decision === "pass" && output.m34.status === "PASS" && output.m32.inspect === "PASS" && output.publicState.fingerprintsUnchanged && priorStages.every((stage) => output.stageDispatches[stage] === 0);
  }
  try {
    ({ snapshot } = await readCapacityResumeSnapshot(snapshotPath));
    const history = Object.values(snapshot.providerAccounting);
    assert.deepEqual(["providerRequestsUsed", "inputTokens", "outputTokens", "totalTokens"].map((key) => history.reduce((sum, row) => sum + row[key], 0)), [5, 6748, 1617, 8365], "HISTORICAL_ACCOUNTING_CHANGED");
    const budget = createCapacityResumeRequestBudget(snapshot);
    ({ supabase, logger, pipeline } = createCapacityResumeProductionPipeline({ requestBudget: budget, pipelineRunId }));
    assert.equal(process.env.AGENT_PROVIDER?.trim(), "groq");
    assert.equal(readGroqMaxConcurrentEvents(), 1);
    assert.ok(Object.values(pipeline.configs).every((c) => c.maxRetries === 0 && !c.allowPaidFallback && !c.allowProviderPacingWait));
    const target = await read(() => supabase.from("pipeline_event_attempts").select("*").eq("id", attemptId).single());
    priorHashes = await checkpointSha256(snapshot.checkpoints);
    validatePreClaim(target, snapshot, previous, priorHashes, !existsSync(criticPath));
    // Target only this pipeline's runs/logs; the full diagnostic preflight is not repeated.
    const runs = await read(() => supabase.from("agent_runs").select("*").eq("config->>pipelineRunId", pipelineRunId).limit(501));
    assert.ok(runs.length < 501);
    for (const run of runs) assert.equal(rowHash(run), previous.preflightEvidence.rowHashes.runs[run.id], "PRECLAIM_AGENT_RUN_CHANGED");
    const logs = runs.length ? await read(() => supabase.from("agent_logs").select("*").in("run_id", runs.map((r) => r.id)).range(0, 4999)) : [];
    assert.ok(logs.length < 5000);
    for (const log of logs) assert.equal(rowHash(log), previous.preflightEvidence.rowHashes.logs[log.id], "PRECLAIM_AGENT_LOG_CHANGED");
    output.preClaimState = { status: "PASS", state: "DEFERRED_PROVIDER_CAPACITY", resumeStage: "Critic", generation: 1, countsTowardRetryLimit: false, checkpoints: "PASS", criticCheckpoint: "ABSENT", criticDispatch: false, lineage: "PASS", comparison: "same target row and same pipeline runs/logs as 12F.12G.2" };
    const day = new Date().toISOString().slice(0, 10);
    dayBefore = await logger.getProviderDailyUsage("groq", day);
    assert.equal(dayBefore.unknownTokenRequests, 0);
    const capacity = pipeline.configs.critic.groqCapacity;
    assert.deepEqual([capacity.requestHardLimit, capacity.requestSoftLimit], [previous.providerRpdHardLimit, previous.providerRpdSoftLimit], "PROVIDER_RPD_CONFIG_CHANGED");
    output.requestBudget = inspectSupervisedRequestCapContract({ providerRpdHardLimit: capacity.requestHardLimit, providerRpdSoftLimit: capacity.requestSoftLimit, providerRpdRemaining: await pipeline.quota.remaining(), requestBudget: budget });
    assert.deepEqual([output.requestBudget.supervisedExecutionRequestCap, output.requestBudget.cumulativeAttemptRequests, output.requestBudget.remainingExecutionRequests], [18, 5, 13]);
    output.capacity = { status: "UNIFIED_PRODUCTION_ADMISSION_PENDING", limits: capacity, currentDailyUsage: dayBefore, minuteWindow: "recomputed atomically by M35/M36 at reservation; no previous minute window reused", providerState: "read by AgentRunner under current unified policy" };
    for (const stage of [...priorStages, "publisher", "geo", "discovery", "extraction", "clustering"]) pipeline.stages[stage] = async () => { throw new AgentError("INCIDENT_DUPLICATE_STAGE_DISPATCH", "Stage forbidden during Critic-only resume: " + stage); };
    const originalCritic = pipeline.stages.critic;
    pipeline.stages.critic = async (...args) => { assert.equal(output.stageInvocations.critic++, 0, "SECOND_CRITIC_STAGE_FORBIDDEN"); return originalCritic(...args); };
    const ownerId = randomUUID();
    const evidence = { attempt: { attemptId, eventKey, pipelineRunId, startedAt: target.started_at, completedAt: target.completed_at, finalState: target.final_state, stopStage: target.stop_stage, stopReason: target.stop_reason, countsTowardRetryLimit: target.counts_toward_retry_limit }, currentEvent: snapshot.event, currentSources: snapshot.sources, currentItems: snapshot.items, currentCheckpointSha256: priorHashes, nextStageDispatchCount: 0, nextStageCheckpointPresent: false, unresolvedProviderUsage: false, activeOwner: false, terminalEditorialRejection: false };
    const assessment = assessCapacityResume(snapshot, evidence, { ownerId });
    assert.equal(assessment.valid, true); assert.equal(assessment.firstStage, "critic");
    phase = "RESUME";
    output.resumeInvocationCount = 1;
    writeFileSync(invocationPath, JSON.stringify({ phase: output.phase, attemptId, startedAtUtc: output.startedAtUtc, resumeInvocationCount: 1, ownerId }, null, 2) + "\n");
    persist();
    let result;
    try { result = await pipeline.orchestrator.resumeCapacityDeferred({ snapshot, evidence, ownerId }); }
    catch (error) { output.resumeError = captureSafeRunnerError({ error, phase, secretValues: secrets }); }
    output.requestBudget.after = budget.executionSnapshot();
    output.critic = result ? { decision: result.criticDecision, finalState: result.finalState, stopStage: result.stopStage, stopReason: result.stopReason, failure: result.failure ?? null, newRequests: result.requestsUsed } : null;
    output.capacity.status = output.providerAccounting.newDispatches === 1 ? "PASS" : result?.finalState === "DEFERRED_PROVIDER_CAPACITY" ? "DEFER" : "FAIL";
    await finalRead(result);
  } catch (error) {
    output.error = captureSafeRunnerError({ error, phase, secretValues: secrets });
    output.finalClassification = "TECHNICAL_FAILURE"; output.readyForHumanAction = false;
  } finally {
    globalThis.fetch = originalFetch;
    output.providerAccounting.cumulative ??= cumulativeAccounting(output.providerAccounting);
    if (!output.providerAccounting.cumulative.actualTokensKnown) {
      output.providerAccounting.newInputTokens = null;
      output.providerAccounting.newOutputTokens = null;
      output.providerAccounting.newTotalTokens = null;
    }
    output.completedAtUtc = new Date().toISOString();
    persist();
    writeFileSync(docPath, "# 12F.12H — Critic y primera revisión humana\n\nResultado: " + output.finalClassification + ". READY FOR HUMAN ACTION: " + output.readyForHumanAction + ".\n\nEvidencia: artifacts/supervised-cycle-12f12h-critic-human-review.json\n", { flag: "wx" });
  }
  console.log(serialize({ phase: output.phase, preClaimState: output.preClaimState, capacity: output.capacity.status, claims: output.claims, resumeInvocationCount: output.resumeInvocationCount, critic: output.critic, m34: output.m34, review: output.review, m32: output.m32, providerAccounting: output.providerAccounting, finalAttemptState: output.finalAttemptState, finalCounts: output.finalCounts, publicState: output.publicState, finalClassification: output.finalClassification, readyForHumanAction: output.readyForHumanAction }));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--execute-once") throw new Error("EXACT_EXECUTE_ONCE_FLAG_REQUIRED");
  runOnce().catch((error) => { console.log(JSON.stringify(captureSafeRunnerError({ error, phase: "RUNNER_SETUP", secretValues: secretValuesFromEnvironment() }))); process.exitCode = 1; });
}
