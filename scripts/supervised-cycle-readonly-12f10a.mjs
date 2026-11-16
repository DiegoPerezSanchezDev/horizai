import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { parseCapacityResumeSnapshot, checkpointSha256 } from "../lib/agents/pipeline/provider-capacity-resume.ts";
import { readSafeTranslatorCheckpoint } from "../lib/agents/translator/translator-checkpoint.ts";
import { runDirectMigrationCommand } from "./supabase-direct-migration-command.mjs";
import { parseCliJson } from "./migration36-validation-runner.mjs";

const mode = process.argv[2];
if (!["before", "after"].includes(mode)) throw new Error("12F10A_READONLY_MODE_REQUIRED");
const attemptId = "16f922f2-0409-4c28-aadb-13fb5e489e7d";
const eventKey = "event-0d2cec33a9acdaff882291db5e686f6c";
const pipelineRunId = "4453d15d-1bcd-42dc-ba55-c060e1222aab";
const schedulerRunId = "4b0a02dd-e0b7-46ea-a21f-ac9fac7b7c00";
const expectedUsage = { requestsReserved: 2, requestsDispatched: 2, inputTokens: 4085, outputTokens: 789, totalTokens: 4874, unknownTokenRequests: 0 };
const baselinePath = "artifacts/supervised-cycle-12f10-after.json";
const outputPath = `artifacts/supervised-cycle-12f10a-remote-${mode}.json`;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hashRows = (rows) => Object.fromEntries(rows.map((row) => [row.id, hash(row)]));
const containsEventKey = (value) => {
  if (value === eventKey) return true;
  if (Array.isArray(value)) return value.some(containsEventKey);
  if (value && typeof value === "object") return Object.entries(value).some(([key, entry]) => key === "eventKey" && entry === eventKey || containsEventKey(entry));
  return false;
};

const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
const fetchRead = globalThis.fetch.bind(globalThis);
const allowedRpcs = new Set(["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator", "get_pipeline_human_review_operator_inspect"]);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const path = url.pathname.split("/").at(-1);
  if (url.origin !== origin || !url.pathname.startsWith("/rest/v1/")
    || !(method === "GET" || method === "HEAD" || method === "POST" && allowedRpcs.has(path))) {
    throw new Error("12F10A_READONLY_NETWORK_GUARD");
  }
  return fetchRead(input, init);
};

const supabase = createSupabaseServerClient();
const checked = (response, label) => {
  if (response.error || response.data === null) throw new Error(`${label}:${response.error?.code ?? "NO_DATA"}`);
  return response.data;
};
async function allRows(table) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = checked(await supabase.from(table).select("*").order("id").range(offset, offset + 499), `12F10A_${table}`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

const utcDate = new Date().toISOString().slice(0, 10);
const triggerId = `supervised-candidates:${utcDate}`;
const [attemptRows, logRows, runRows, articleRows, schedulerRows] = await Promise.all([
  allRows("pipeline_event_attempts"), allRows("agent_logs"), allRows("agent_runs"), allRows("articles"), allRows("scheduler_runs"),
]);
const realAttempts = attemptRows.filter((row) => row.validation_namespace === null);
const pending = realAttempts.filter((row) => row.completed_at === null && row.final_state === null);
const deferred = pending.filter((row) => row.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED");
const active = pending.filter((row) => row.stop_reason !== "PROVIDER_CAPACITY_EXHAUSTED");
const stuck = active.filter((row) => Date.parse(row.started_at) + 3_600_000 <= Date.now());
const target = realAttempts.find((row) => row.id === attemptId);
assert.ok(target, "12F10A_REAL_ATTEMPT_MISSING");
const targetRuns = runRows.filter((row) => row.config?.pipelineRunId === pipelineRunId && row.config?.eventKey === eventKey);
const eventReservations = logRows.filter((row) => row.step === "provider_request_reserved" && containsEventKey(row.payload));
const editorReservations = eventReservations.filter((row) => row.agent_name === "editor" || row.payload?.agentName === "editor" || row.payload?.agent === "editor");
const capacityLogs = logRows.filter((row) => containsEventKey(row.payload) && /capacity/i.test(`${row.step} ${row.message}`));
const publicArticles = articleRows.filter((row) => row.publication_status === "published");
const fingerprints = publicArticles.map((row) => ({ id: row.id, fingerprint: publicArticleFingerprintV1(row) }));
const reviewRepository = new SupabaseHumanReviewReadRepository(supabase);
const [reviewStatus, reviewList, harmlessInspection] = await Promise.all([
  reviewRepository.status(), reviewRepository.list(500), reviewRepository.inspect(randomUUID()),
]);
const logger = new SupabaseAgentLogger(supabase);
const accounting = {};
for (const provider of ["groq", "cloudflare_workers_ai", "cerebras"]) {
  const usage = await logger.getProviderDailyUsage(provider, utcDate);
  accounting[provider] = {
    requestsReserved: usage.requestsReserved,
    requestsDispatched: usage.requestsDispatched,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    unknownTokenRequests: usage.unknownTokenRequests,
  };
}
const schedulerTriggerRows = schedulerRows.filter((row) => row.trigger_id === "supervised-candidates:2026-10-16");
const schedulerTarget = schedulerRows.find((row) => row.id === schedulerRunId);
const parentRunLog = logRows.find((row) => row.step === "EVENT_STARTED" && row.payload?.runId === pipelineRunId && row.payload?.eventKey == null);
const parentAgentRun = parentRunLog ? runRows.find((row) => row.id === parentRunLog.run_id) : undefined;
const openAgentRuns = runRows.filter((row) => row.status === "running").map((row) => ({ id: row.id, runType: row.run_type, finishedAt: row.finished_at, provider: row.provider, configKeys: Object.keys(row.config ?? {}), agentName: row.config?.agentName ?? null, pipelineRunId: row.config?.pipelineRunId ?? null, eventKey: row.config?.eventKey ?? null }));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const astraArchived = articleRows.find((row) => row.id === "756b0ee0-b5e6-4153-846f-278a12c9afe3")?.publication_status === "archived";
const rowHashes = { attempts: hashRows(attemptRows), logs: hashRows(logRows), runs: hashRows(runRows), articles: hashRows(articleRows), scheduler: hashRows(schedulerRows) };

const checkpointRoot = `artifacts/pipeline-checkpoints/${pipelineRunId}`;
const checkpointPaths = {
  verifier: `${checkpointRoot}/verifier-${eventKey}.json`,
  translator: `${checkpointRoot}/translator-${eventKey}.json`,
  editor: `${checkpointRoot}/editor-${eventKey}.json`,
  capacitySnapshot: `${checkpointRoot}/capacity-resume-${eventKey}-editor-g2.json`,
};
const localSnapshotRaw = JSON.parse(readFileSync(checkpointPaths.capacitySnapshot, "utf8"));
const localSnapshot = parseCapacityResumeSnapshot(localSnapshotRaw);
const localCheckpointHashes = await checkpointSha256(localSnapshot.checkpoints);
const verifierCheckpoint = await readSafeTranslatorCheckpoint(checkpointPaths.verifier);
const translatorCheckpoint = await readSafeTranslatorCheckpoint(checkpointPaths.translator);
const editorCheckpointPresent = existsSync(checkpointPaths.editor);
const correctedInitialSnapshot = parseCapacityResumeSnapshot({ ...localSnapshotRaw, resumeGeneration: 0 });
const checkpointAudit = {
  localSnapshotIdentityMatchesAttempt: localSnapshot.attemptId === attemptId && localSnapshot.eventKey === eventKey && localSnapshot.pipelineRunId === pipelineRunId,
  resumeStage: localSnapshot.resumeStage,
  observedGeneration: localSnapshot.resumeGeneration,
  correctedInitialGeneration: correctedInitialSnapshot.resumeGeneration,
  initialSnapshotSchemaValidAtGenerationZero: correctedInitialSnapshot.resumeGeneration === 0,
  completedCheckpoints: Object.keys(localSnapshot.checkpoints),
  checkpointHashesValid: JSON.stringify(canonical(localCheckpointHashes)) === JSON.stringify(canonical(localSnapshot.checkpointSha256)),
  verifierSchemaAndLineageValid: verifierCheckpoint.eventKey === eventKey && verifierCheckpoint.verification?.eventKey === eventKey,
  translatorSchemaAndLineageValid: translatorCheckpoint.eventKey === eventKey && translatorCheckpoint.verification?.eventKey === eventKey && translatorCheckpoint.translationResult?.eventKey === eventKey,
  verifierTranslatorEventEqual: JSON.stringify(canonical(verifierCheckpoint.event)) === JSON.stringify(canonical(translatorCheckpoint.event)),
  verifierTranslatorFactsEqual: JSON.stringify(canonical(verifierCheckpoint.verification)) === JSON.stringify(canonical(translatorCheckpoint.verification)),
  eventSourceLineageComplete: localSnapshot.event.sourceItems.length === localSnapshot.sources.length && localSnapshot.event.sourceItems.every((item) => localSnapshot.sources.some((source) => source.sourceItemId === item.candidateId && source.sourceId === item.sourceId && Boolean(source.rawItemId))),
  editorCheckpointPresent,
};

const output = {
  mode, utcDate, capturedAtUtc: new Date().toISOString(), triggerId, targetAttempt: {
    id: target.id, eventKey: target.event_key, pipelineRunId: target.pipeline_run_id, attemptNumber: target.attempt_number,
    startedAt: target.started_at, completedAt: target.completed_at, finalState: target.final_state,
    stopStage: target.stop_stage, stopReason: target.stop_reason, retryClass: target.retry_class,
    countsTowardRetryLimit: target.counts_toward_retry_limit, nextEligibleAt: target.next_eligible_at,
    resumeSnapshotPresent: target.capacity_resume_snapshot !== null && target.capacity_resume_snapshot !== undefined,
    resumeGeneration: target.capacity_resume_snapshot?.resumeGeneration ?? null,
  },
  attemptsTotal: realAttempts.length, activeDeferredStuck: [active.length, deferred.length, stuck.length],
  reviews: { total: reviewStatus.totalReviews, waiting: reviewStatus.waitingReviews, listReturned: reviewList.returned, inspectRpc: "PASS", inspectFound: harmlessInspection.found },
  publicArticles: publicArticles.length, fingerprints, astraArchived,
  accounting, eventReservations: eventReservations.map((row) => ({ id: row.id, agent: row.agent_name, provider: row.provider, tokens: row.provider_unit_amount, dispatched: row.payload?.providerRequestDispatched ?? null, inputTokens: row.payload?.actualInputTokens ?? null, outputTokens: row.payload?.actualOutputTokens ?? null, totalTokens: row.payload?.actualTokens ?? null })),
  editorReservationCount: editorReservations.length, editorAgentRuns: targetRuns.filter((row) => row.config?.agentName === "editor").map((row) => ({ id: row.id, status: row.status, providerRequestDispatched: row.stats?.telemetry?.providerRequestDispatched ?? null, providerRequestsUsed: row.stats?.telemetry?.providerRequestsUsed ?? null })),
  criticRuns: targetRuns.filter((row) => row.config?.agentName === "critic").length, capacityLogs: capacityLogs.map((row) => ({ id: row.id, step: row.step, agent: row.agent_name, provider: row.provider, providerRequestDispatched: row.payload?.providerRequestDispatched ?? row.payload?.details?.providerRequestDispatched ?? null, providerRequestsUsed: row.payload?.providerRequestsUsed ?? row.payload?.details?.providerRequestsUsed ?? null })),
  checkpointAudit,
  scheduler: schedulerTarget ? { id: schedulerTarget.id, triggerId: schedulerTarget.trigger_id, pipelineRunId: schedulerTarget.pipeline_run_id, runStatus: schedulerTarget.run_status, schedulerDecision: schedulerTarget.scheduler_decision, stopReason: schedulerTarget.stop_reason, eventAttempts: schedulerTarget.event_attempts, requestsUsed: schedulerTarget.requests_used, leaseStatus: schedulerTarget.lease_status, rowHash: rowHashes.scheduler[schedulerTarget.id] } : null,
  parentAgentRun: parentAgentRun ? { id: parentAgentRun.id, status: parentAgentRun.status, finishedAt: parentAgentRun.finished_at, runType: parentAgentRun.run_type } : null,
  openAgentRuns,
  schedulerTriggerRows: schedulerTriggerRows.map((row) => ({ id: row.id, status: row.run_status, decision: row.scheduler_decision, leaseStatus: row.lease_status })),
  rowHashes,
  previousBaseline: { attemptsTotal: baseline.attemptsTotal, activeDeferredStuck: baseline.activeDeferredStuck, fingerprints: baseline.fingerprints, consumedSchedulerHash: baseline.rowHashes.scheduler[schedulerRunId] },
  providerCallsFromAudit: 0,
  realPipelineRunsFromAudit: 0,
  remoteWritesFromAudit: 0,
  authorizedRemoteWritesBeforeThisRead: mode === "before" ? 0 : 2,
};

assert.equal(astraArchived, true, "ASTRA_NOT_ARCHIVED");
assert.equal(publicArticles.length, 2, "PUBLIC_ARTICLE_COUNT_CHANGED");
assert.deepEqual(fingerprints, baseline.fingerprints, "PUBLIC_FINGERPRINT_CHANGED");
assert.equal(reviewStatus.totalReviews, 0, "UNEXPECTED_HUMAN_REVIEWS");
assert.equal(reviewStatus.waitingReviews, 0, "UNEXPECTED_WAITING_REVIEWS");
assert.equal(reviewList.returned, 0, "UNEXPECTED_REVIEW_LIST_ROWS");
assert.equal(harmlessInspection.found, false, "RANDOM_INSPECTION_UUID_UNEXPECTEDLY_FOUND");
assert.equal(rowHashes.scheduler[schedulerRunId], baseline.rowHashes.scheduler[schedulerRunId], "HISTORICAL_SCHEDULER_ROW_CHANGED");
assert.equal(accounting.groq.requestsReserved, expectedUsage.requestsReserved, "GROQ_RESERVATION_COUNT_CHANGED");
assert.equal(accounting.groq.requestsDispatched, expectedUsage.requestsDispatched, "GROQ_DISPATCH_COUNT_CHANGED");
assert.equal(accounting.groq.inputTokens, expectedUsage.inputTokens, "GROQ_INPUT_TOKENS_CHANGED");
assert.equal(accounting.groq.outputTokens, expectedUsage.outputTokens, "GROQ_OUTPUT_TOKENS_CHANGED");
assert.equal(accounting.groq.totalTokens, expectedUsage.totalTokens, "GROQ_TOTAL_TOKENS_CHANGED");
assert.equal(accounting.groq.unknownTokenRequests, 0, "GROQ_UNKNOWN_RESERVATION");
assert.equal(accounting.cloudflare_workers_ai.requestsReserved, 0);
assert.equal(accounting.cerebras.requestsReserved, 0);
assert.equal(checkpointAudit.localSnapshotIdentityMatchesAttempt, true, "LOCAL_RESUME_SNAPSHOT_IDENTITY_MISMATCH");
assert.equal(checkpointAudit.resumeStage, "editor");
assert.equal(checkpointAudit.observedGeneration, 2);
assert.equal(checkpointAudit.initialSnapshotSchemaValidAtGenerationZero, true);
assert.equal(checkpointAudit.checkpointHashesValid, true, "DURABLE_CHECKPOINT_HASH_MISMATCH");
assert.equal(checkpointAudit.verifierSchemaAndLineageValid, true, "VERIFIER_CHECKPOINT_INVALID");
assert.equal(checkpointAudit.translatorSchemaAndLineageValid, true, "TRANSLATOR_CHECKPOINT_INVALID");
assert.equal(checkpointAudit.verifierTranslatorEventEqual, true, "UPSTREAM_EVENT_LINEAGE_MISMATCH");
assert.equal(checkpointAudit.verifierTranslatorFactsEqual, true, "UPSTREAM_FACT_CHECKPOINT_MISMATCH");
assert.equal(checkpointAudit.eventSourceLineageComplete, true, "SOURCE_LINEAGE_INCOMPLETE");
assert.equal(checkpointAudit.editorCheckpointPresent, false, "EDITOR_CHECKPOINT_SHOULD_BE_ABSENT");
assert.equal(eventReservations.length, 2, "EVENT_PROVIDER_ACCOUNTING_COUNT_MISMATCH");
assert.equal(editorReservations.length, 0, "EDITOR_REQUEST_WAS_DISPATCHED");
assert.equal(output.criticRuns, 0, "CRITIC_SHOULD_NOT_HAVE_RUN");
assert.equal(schedulerTarget?.run_status, "failed");
assert.equal(schedulerTarget?.lease_status, "released");
assert.equal(schedulerTarget?.pipeline_run_id, pipelineRunId);
assert.equal(schedulerTarget?.stop_reason, "SUPERVISED_EXECUTION_FAILED");
assert.equal(schedulerTarget?.event_attempts, 0);
assert.equal(schedulerTarget?.requests_used, 0);

if (mode === "before") {
  assert.equal(realAttempts.length, 18, "ATTEMPT_BASELINE_CHANGED");
  assert.deepEqual([active.length, deferred.length, stuck.length], [1, 0, 0], "ATTEMPT_STATE_BASELINE_CHANGED");
  assert.equal(target.completed_at, null);
  assert.equal(target.final_state, null);
  assert.equal(target.stop_stage, null);
  assert.equal(target.stop_reason, null);
  assert.equal(target.capacity_resume_snapshot, null);
  assert.equal(target.attempt_number, 1);
  assert.equal(target.pipeline_run_id, pipelineRunId);
  assert.equal(schedulerTriggerRows.length, 1, "CURRENT_DAILY_TRIGGER_NOT_CONSUMED_EXACTLY_ONCE");
  assert.equal(schedulerTriggerRows[0].id, schedulerRunId);
  for (const [table, previousHashes] of Object.entries(baseline.rowHashes)) {
    assert.deepEqual(rowHashes[table], previousHashes, `BASELINE_${table.toUpperCase()}_ROW_CHANGE`);
  }
} else {
  const before = JSON.parse(readFileSync("artifacts/supervised-cycle-12f10a-remote-before.json", "utf8"));
  assert.equal(realAttempts.length, 18, "ATTEMPT_COUNT_CHANGED");
  assert.deepEqual([active.length, deferred.length, stuck.length], [0, 1, 0], "ATTEMPT_NOT_DEFERRED_AS_EXPECTED");
  assert.equal(target.completed_at, null);
  assert.equal(target.final_state, null);
  assert.equal(target.stop_stage, "editor");
  assert.equal(target.stop_reason, "PROVIDER_CAPACITY_EXHAUSTED");
  assert.equal(target.retry_class, "NONE");
  assert.equal(target.counts_toward_retry_limit, false);
  assert.equal(target.next_eligible_at, null);
  assert.equal(target.capacity_resume_snapshot?.attemptId, attemptId);
  assert.equal(target.capacity_resume_snapshot?.pipelineRunId, pipelineRunId);
  assert.equal(target.capacity_resume_snapshot?.eventKey, eventKey);
  assert.equal(target.capacity_resume_snapshot?.resumeStage, "editor");
  assert.equal(target.capacity_resume_snapshot?.resumeGeneration, 0);
  assert.equal(hashRows(attemptRows.filter((row) => row.id !== attemptId))[attemptId], undefined);
  for (const table of Object.keys(before.rowHashes)) {
    const current = rowHashes[table];
    for (const [id, digest] of Object.entries(before.rowHashes[table])) {
      if (table === "attempts" && id === attemptId) continue;
      if (table === "runs" && id === before.openAgentRuns[0]?.id) continue;
      assert.equal(current[id], digest, `UNEXPECTED_HISTORICAL_${table.toUpperCase()}_ROW_CHANGE`);
    }
  }
  assert.deepEqual(rowHashes.scheduler, before.rowHashes.scheduler, "HISTORICAL_SCHEDULER_ROWS_CHANGED");
  assert.deepEqual(rowHashes.articles, before.rowHashes.articles, "ARTICLE_ROWS_CHANGED");
  assert.deepEqual(rowHashes.logs, before.rowHashes.logs, "PROVIDER_OR_LOG_ROWS_CHANGED");
  const parentRunId = before.openAgentRuns[0]?.id;
  const priorRunHashes = Object.fromEntries(Object.entries(before.rowHashes.runs).filter(([id]) => id !== parentRunId));
  const currentRunHashes = Object.fromEntries(Object.entries(rowHashes.runs).filter(([id]) => id !== parentRunId));
  assert.deepEqual(currentRunHashes, priorRunHashes, "UNEXPECTED_HISTORICAL_AGENT_RUN_CHANGE");
  const parentAfter = runRows.find((row) => row.id === parentRunId);
  assert.equal(parentAfter?.status, "failed", "PIPELINE_PARENT_RUN_NOT_CLOSED");
  assert.ok(parentAfter?.finished_at, "PIPELINE_PARENT_RUN_FINISHED_AT_MISSING");
  assert.equal(parentAfter?.error_message, "EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023", "PIPELINE_PARENT_RUN_REASON_MISMATCH");
  output.parentPipelineRunStillRunning = runRows.some((row) => row.id === parentRunId && row.status === "running");
  output.parentAgentRunFinalized = true;
  output.unexpectedAttemptRows = realAttempts.filter((row) => !Object.hasOwn(before.rowHashes.attempts, row.id)).map((row) => row.id);
  assert.deepEqual(output.unexpectedAttemptRows, [], "DUPLICATE_ATTEMPT_CREATED");
}

const m35Acl = await runDirectMigrationCommand("m35-acl");
assert.equal(m35Acl.code, 0, "M35_ACL_READ_FAILED");
const m35AclEvidence = parseCliJson(m35Acl.output).rows[0].migration35_acl;
for (const fn of m35AclEvidence.functions) {
  assert.equal(fn.function_exists, true);
  assert.equal(fn.service_role_execute, true);
  assert.equal(fn.anon_execute, false);
  assert.equal(fn.authenticated_execute, false);
  assert.equal(fn.public_execute, false);
}
assert.equal(m35AclEvidence.pipelineEventAttemptsUpdateAcl.anon_update, false);
assert.equal(m35AclEvidence.pipelineEventAttemptsUpdateAcl.authenticated_update, false);
assert.equal(m35AclEvidence.pipelineEventAttemptsUpdateAcl.public_update, false);
output.m35Acl = { status: "PASS", functions: m35AclEvidence.functions.length, directUpdateDenied: true };

const m36Acl = await runDirectMigrationCommand("m36-acl");
assert.equal(m36Acl.code, 0, "M36_ACL_READ_FAILED");
const m36Evidence = parseCliJson(m36Acl.output).rows[0].migration36_evidence;
assert.equal(m36Evidence.head, "20261015120000");
assert.equal(m36Evidence.m36Count, 1);
output.m36 = { status: "PASS", head: m36Evidence.head, appliedCount: m36Evidence.m36Count };

const historyResult = await runDirectMigrationCommand("history");
assert.equal(historyResult.code, 0, "MIGRATION_HISTORY_READ_FAILED");
const history = parseCliJson(historyResult.output).migrations;
for (const version of ["20261009120000", "20261014120000", "20261015120000"]) {
  assert.ok(history.some((row) => row.local === version && row.remote === version), `MIGRATION_${version}_HISTORY_MISMATCH`);
}
output.migrationHistory = { status: "PASS", m33: true, m35: true, m36: true };

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ mode, utcDate, triggerId, attemptsTotal: realAttempts.length, activeDeferredStuck: output.activeDeferredStuck, reviews: output.reviews, publicArticles: output.publicArticles, astraArchived, targetAttempt: output.targetAttempt, checkpointAudit, accounting, scheduler: output.scheduler, m35Acl: output.m35Acl, m36: output.m36, migrationHistory: output.migrationHistory, remoteWrites: 0, providerCalls: 0, pipelineRuns: 0 }));
