import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { checkpointSha256, parseCapacityResumeSnapshot } from "../lib/agents/pipeline/provider-capacity-resume.ts";
import { readSafeTranslatorCheckpoint } from "../lib/agents/translator/translator-checkpoint.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";

const attemptId = "16f922f2-0409-4c28-aadb-13fb5e489e7d";
const eventKey = "event-0d2cec33a9acdaff882291db5e686f6c";
const pipelineRunId = "4453d15d-1bcd-42dc-ba55-c060e1222aab";
const triggerId = "supervised-candidates:2026-10-16";
const schedulerRunId = "4b0a02dd-e0b7-46ea-a21f-ac9fac7b7c00";
const expectedAccounting = { requestsReserved: 2, requestsDispatched: 2, inputTokens: 4085, outputTokens: 789, totalTokens: 4874, unknownTokenRequests: 0 };
const before = JSON.parse(readFileSync("artifacts/supervised-cycle-12f10a-remote-before.json", "utf8"));
const historical = JSON.parse(readFileSync("artifacts/supervised-cycle-12f10-after.json", "utf8"));
const snapshotFile = "artifacts/pipeline-checkpoints/4453d15d-1bcd-42dc-ba55-c060e1222aab/capacity-resume-event-0d2cec33a9acdaff882291db5e686f6c-editor-g2.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;

assert.equal(before.mode, "before");
assert.equal(before.utcDate, "2026-10-16");
assert.equal(before.triggerId, triggerId);
assert.equal(before.attemptsTotal, 18);
assert.deepEqual(before.activeDeferredStuck, [1, 0, 0]);
assert.deepEqual(before.reviews, { total: 0, waiting: 0, listReturned: 0, inspectRpc: "PASS", inspectFound: false });
assert.equal(before.publicArticles, 2);
assert.equal(before.astraArchived, true);
assert.deepEqual(before.accounting.groq, expectedAccounting);
assert.equal(before.editorReservationCount, 0);
assert.equal(before.criticRuns, 0);
assert.equal(before.scheduler.id, schedulerRunId);
assert.equal(before.scheduler.runStatus, "failed");
assert.equal(before.scheduler.leaseStatus, "released");
assert.equal(before.scheduler.stopReason, "SUPERVISED_EXECUTION_FAILED");
assert.equal(before.scheduler.rowHash, historical.rowHashes.scheduler[schedulerRunId]);
assert.equal(before.scheduler.pipelineRunId, pipelineRunId);
assert.equal(before.targetAttempt.id, attemptId);
assert.equal(before.targetAttempt.eventKey, eventKey);
assert.equal(before.targetAttempt.pipelineRunId, pipelineRunId);
assert.equal(before.targetAttempt.attemptNumber, 1);
assert.equal(before.targetAttempt.resumeSnapshotPresent, false);
assert.equal(before.checkpointAudit.resumeStage, "editor");
assert.equal(before.checkpointAudit.observedGeneration, 2);
assert.equal(before.checkpointAudit.correctedInitialGeneration, 0);
assert.equal(before.checkpointAudit.checkpointHashesValid, true);
assert.equal(before.checkpointAudit.verifierSchemaAndLineageValid, true);
assert.equal(before.checkpointAudit.translatorSchemaAndLineageValid, true);
assert.equal(before.checkpointAudit.editorCheckpointPresent, false);
assert.equal(before.openAgentRuns.length, 1);
const parentRunId = before.openAgentRuns[0].id;
assert.equal(before.openAgentRuns[0].agentName, "pipeline-orchestrator");
assert.equal(before.openAgentRuns[0].pipelineRunId, pipelineRunId);

const remoteOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
const originalFetch = globalThis.fetch.bind(globalThis);
let allowedDeferCalls = 0;
let allowedParentFinishCalls = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.origin !== remoteOrigin) throw new Error("12F10A_RECOVERY_NETWORK_ORIGIN_BLOCKED");
  if (method === "GET" || method === "HEAD") return originalFetch(input, init);
  if (method === "POST" && url.pathname === "/rest/v1/rpc/defer_pipeline_event_attempt_capacity_m35") {
    allowedDeferCalls += 1;
    if (allowedDeferCalls !== 1) throw new Error("12F10A_DUPLICATE_DEFER_RPC_BLOCKED");
    return originalFetch(input, init);
  }
  if (method === "PATCH" && url.pathname === "/rest/v1/agent_runs" && url.searchParams.get("id") === `eq.${parentRunId}`) {
    allowedParentFinishCalls += 1;
    if (allowedParentFinishCalls !== 1) throw new Error("12F10A_DUPLICATE_PARENT_RUN_FINALIZE_BLOCKED");
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (body.status !== "failed" || body.error_message !== "EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023"
      || typeof body.finished_at !== "string" || typeof body.stats !== "object") throw new Error("12F10A_PARENT_RUN_FINALIZE_PAYLOAD_INVALID");
    return originalFetch(input, init);
  }
  throw new Error("12F10A_RECOVERY_NETWORK_METHOD_BLOCKED");
};

const supabase = createSupabaseServerClient();
const data = (response, label) => {
  if (response.error || response.data === null) throw new Error(`${label}:${response.error?.code ?? "NO_DATA"}`);
  return response.data;
};
const [attemptRows, currentRun, currentScheduler, articleRows] = await Promise.all([
  supabase.from("pipeline_event_attempts").select("*").eq("id", attemptId),
  supabase.from("agent_runs").select("*").eq("id", parentRunId).maybeSingle(),
  supabase.from("scheduler_runs").select("*").eq("id", schedulerRunId).maybeSingle(),
  supabase.from("articles").select("*").order("id"),
]);
const target = data(attemptRows, "12F10A_ATTEMPT_READ")[0];
const parent = data(currentRun, "12F10A_PARENT_RUN_READ");
const scheduler = data(currentScheduler, "12F10A_SCHEDULER_READ");
const articles = data(articleRows, "12F10A_ARTICLES_READ");
assert.equal(target.id, attemptId);
assert.equal(target.event_key, eventKey);
assert.equal(target.pipeline_run_id, pipelineRunId);
assert.equal(target.attempt_number, 1);
assert.equal(target.validation_namespace, null);
assert.equal(target.completed_at, null);
assert.equal(target.final_state, null);
assert.equal(target.stop_stage, null);
assert.equal(target.stop_reason, null);
assert.equal(target.retry_class, "NONE");
assert.equal(target.counts_toward_retry_limit, false);
assert.equal(target.next_eligible_at, null);
assert.equal(target.capacity_resume_snapshot, null);
assert.equal(parent.id, parentRunId);
assert.equal(parent.status, "running");
assert.equal(parent.finished_at, null);
assert.equal(parent.config?.agentName, "pipeline-orchestrator");
assert.equal(parent.config?.pipelineRunId, pipelineRunId);
assert.equal(scheduler.id, schedulerRunId);
assert.equal(scheduler.trigger_id, triggerId);
assert.equal(scheduler.run_status, "failed");
assert.equal(scheduler.lease_status, "released");
assert.equal(scheduler.stop_reason, "SUPERVISED_EXECUTION_FAILED");
assert.equal(sha256(JSON.stringify(canonical(scheduler))), before.scheduler.rowHash);
assert.deepEqual(articles.filter((row) => row.publication_status === "published").map((row) => ({ id: row.id, fingerprint: publicArticleFingerprintV1(row) })), historical.fingerprints);

const verifierPath = "artifacts/pipeline-checkpoints/4453d15d-1bcd-42dc-ba55-c060e1222aab/verifier-event-0d2cec33a9acdaff882291db5e686f6c.json";
const translatorPath = "artifacts/pipeline-checkpoints/4453d15d-1bcd-42dc-ba55-c060e1222aab/translator-event-0d2cec33a9acdaff882291db5e686f6c.json";
const localRaw = JSON.parse(readFileSync(snapshotFile, "utf8"));
const snapshot = parseCapacityResumeSnapshot({ ...localRaw, resumeGeneration: 0 });
const hashes = await checkpointSha256(snapshot.checkpoints);
const [verifierCheckpoint, translatorCheckpoint] = await Promise.all([
  readSafeTranslatorCheckpoint(verifierPath), readSafeTranslatorCheckpoint(translatorPath),
]);
assert.equal(snapshot.attemptId, attemptId);
assert.equal(snapshot.pipelineRunId, pipelineRunId);
assert.equal(snapshot.eventKey, eventKey);
assert.equal(snapshot.resumeStage, "editor");
assert.equal(snapshot.resumeGeneration, 0);
assert.equal(Date.parse(snapshot.attemptStartedAt), Date.parse(target.started_at));
assert.deepEqual(hashes, snapshot.checkpointSha256);
assert.deepEqual(Object.keys(snapshot.checkpoints).sort(), ["translator", "verifier"]);
assert.equal(verifierCheckpoint.eventKey, eventKey);
assert.equal(translatorCheckpoint.eventKey, eventKey);
assert.equal(verifierCheckpoint.verification?.eventKey, eventKey);
assert.equal(translatorCheckpoint.verification?.eventKey, eventKey);
assert.equal(translatorCheckpoint.translationResult?.eventKey, eventKey);
assert.deepEqual(canonical(verifierCheckpoint.event), canonical(translatorCheckpoint.event));
assert.deepEqual(canonical(verifierCheckpoint.verification), canonical(translatorCheckpoint.verification));
assert.equal(snapshot.providerAccounting.verifier.providerRequestsUsed, 1);
assert.equal(snapshot.providerAccounting.translator.providerRequestsUsed, 1);
assert.equal(snapshot.providerAccounting.verifier.inputTokens + snapshot.providerAccounting.translator.inputTokens, expectedAccounting.inputTokens);
assert.equal(snapshot.providerAccounting.verifier.outputTokens + snapshot.providerAccounting.translator.outputTokens, expectedAccounting.outputTokens);
assert.equal(snapshot.providerAccounting.verifier.totalTokens + snapshot.providerAccounting.translator.totalTokens, expectedAccounting.totalTokens);

const attemptRepository = new SupabasePipelineEventAttemptRepository(supabase);
await attemptRepository.deferCapacity({
  attemptId,
  eventKey,
  pipelineRunId,
  stopStage: "editor",
  snapshot,
  providerRequestDispatched: false,
  providerRequestsUsed: 0,
});
assert.equal(allowedDeferCalls, 1, "exactly one validated M35 defer RPC was invoked");

const [afterAttemptRows, afterParentRow] = await Promise.all([
  supabase.from("pipeline_event_attempts").select("*").eq("id", attemptId),
  supabase.from("agent_runs").select("*").eq("id", parentRunId).maybeSingle(),
]);
const deferredAttempt = data(afterAttemptRows, "12F10A_DEFERRED_ATTEMPT_READ")[0];
assert.equal(deferredAttempt.id, attemptId);
assert.equal(deferredAttempt.attempt_number, 1);
assert.equal(deferredAttempt.event_key, eventKey);
assert.equal(deferredAttempt.pipeline_run_id, pipelineRunId);
assert.equal(deferredAttempt.completed_at, null);
assert.equal(deferredAttempt.final_state, null);
assert.equal(deferredAttempt.stop_stage, "editor");
assert.equal(deferredAttempt.stop_reason, "PROVIDER_CAPACITY_EXHAUSTED");
assert.equal(deferredAttempt.retry_class, "NONE");
assert.equal(deferredAttempt.counts_toward_retry_limit, false);
assert.equal(deferredAttempt.next_eligible_at, null);
assert.deepEqual(canonical(deferredAttempt.capacity_resume_snapshot), canonical(snapshot));

const parentAfterDefer = data(afterParentRow, "12F10A_PARENT_RUN_AFTER_DEFER");
assert.equal(parentAfterDefer.status, "running");
const logger = new SupabaseAgentLogger(supabase);
await logger.finishRun(parentRunId, {
  agentName: "pipeline-orchestrator",
  agentVersion: String(parent.config?.agentVersion ?? "unknown"),
  eventKey: null,
  pipelineRunId,
  model: String(parent.config?.model ?? "unknown"),
  provider: undefined,
  dryRun: true,
}, "failed", new Date().toISOString(), parent.stats, "EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023");
assert.equal(allowedParentFinishCalls, 1, "the existing parent agent-run logger closed the orphan exactly once");

const finalParentResult = await supabase.from("agent_runs").select("id,status,finished_at,error_message,stats,config").eq("id", parentRunId).maybeSingle();
const finalParent = data(finalParentResult, "12F10A_PARENT_RUN_FINAL_READ");
assert.equal(finalParent.status, "failed");
assert.ok(finalParent.finished_at);
assert.equal(finalParent.error_message, "EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:22023");
assert.deepEqual(canonical(finalParent.stats), canonical(parent.stats), "parent stats were preserved when closing the orphaned run");
assert.equal(finalParent.config?.pipelineRunId, pipelineRunId);

console.log(JSON.stringify({
  recovery: "RECOVER_AS_DEFERRED_PROVIDER_CAPACITY",
  attemptId: deferredAttempt.id,
  attemptNumber: deferredAttempt.attempt_number,
  eventKey: deferredAttempt.event_key,
  pipelineRunId: deferredAttempt.pipeline_run_id,
  stopStage: deferredAttempt.stop_stage,
  stopReason: deferredAttempt.stop_reason,
  resumeGeneration: deferredAttempt.capacity_resume_snapshot.resumeGeneration,
  sameAttempt: true,
  verifierRerun: false,
  translatorRerun: false,
  editorDispatchAdded: false,
  parentAgentRunClosed: true,
  parentRunId,
  historicalSchedulerUnchanged: true,
  providerAccountingUnchanged: true,
  providerCalls: 0,
  pipelineRuns: 0,
  remoteWrites: { m35CapacityDeferRpc: allowedDeferCalls, parentAgentRunFinish: allowedParentFinishCalls },
}));
