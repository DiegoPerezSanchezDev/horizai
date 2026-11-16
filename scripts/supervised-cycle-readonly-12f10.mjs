import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { readSafeCriticPipelineCheckpoint } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { runDirectMigrationCommand } from "./supabase-direct-migration-command.mjs";
import { parseCliJson } from "./migration36-validation-runner.mjs";

const mode = process.argv[2];
if (!["trigger", "before", "after"].includes(mode)) throw new Error("12F10_READONLY_MODE_REQUIRED");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = async (name, value) => writeFile(`artifacts/supervised-cycle-12f10-${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const hashRows = (rows) => Object.fromEntries(rows.map((row) => [row.id, hash(row)]));
const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
const fetchRead = globalThis.fetch.bind(globalThis);
const readRpcs = new Set(["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator", "get_pipeline_human_review_operator_inspect"]);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.origin !== origin || !url.pathname.startsWith("/rest/v1/") || !(["GET", "HEAD"].includes(method) || method === "POST" && readRpcs.has(url.pathname.split("/").at(-1)))) throw new Error("12F10_READONLY_NETWORK_GUARD");
  return fetchRead(input, init);
};
const supabase = createSupabaseServerClient();
const data = (response, label) => { if (response.error || response.data === null) throw new Error(`${label}:${response.error?.code ?? "NO_DATA"}`); return response.data; };
async function allRows(table) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = data(await supabase.from(table).select("*").order("id").range(offset, offset + 499), `12F10_${table}`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

const utcDate = new Date().toISOString().slice(0, 10);
const trigger = `supervised-candidates:${utcDate}`;
const today = data(await supabase.from("scheduler_runs").select("*").eq("trigger_id", trigger), "12F10_TRIGGER");
if (mode === "trigger") {
  const proof = { utcDate, trigger, capturedAtUtc: new Date().toISOString(), available: today.length === 0, runs: today.map((row) => ({ id: row.id, status: row.run_status, leaseStatus: row.lease_status, createdAt: row.created_at })), classification: today.length ? "DAILY_TRIGGER_BLOCKED" : "DAILY_TRIGGER_AVAILABLE", remoteWrites: 0, providerCalls: 0 };
  await save("trigger", proof);
  console.log(JSON.stringify(proof));
} else {
  const [attempts, logs, runs, articles, schedulerRows] = await Promise.all([allRows("pipeline_event_attempts"), allRows("agent_logs"), allRows("agent_runs"), allRows("articles"), allRows("scheduler_runs")]);
  const realAttempts = attempts.filter((row) => row.validation_namespace === null);
  const pending = realAttempts.filter((row) => row.completed_at === null);
  const deferred = pending.filter((row) => row.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED");
  const active = pending.filter((row) => row.stop_reason !== "PROVIDER_CAPACITY_EXHAUSTED");
  const stuck = active.filter((row) => Date.parse(row.started_at) + 3_600_000 <= Date.now());
  const publicRows = articles.filter((row) => row.publication_status === "published");
  const fingerprints = publicRows.map((row) => ({ id: row.id, fingerprint: publicArticleFingerprintV1(row) }));
  const established = await readJson("artifacts/supervised-cycle-12f9b-baseline-after.json");
  assert.deepEqual(fingerprints, established.fingerprints, "PUBLIC_FINGERPRINT_INCIDENT");
  assert.equal(hash(articles), established.integrity.allArticles, "ARTICLE_MUTATION_INCIDENT");
  const astraArchived = articles.find((row) => row.id === "756b0ee0-b5e6-4153-846f-278a12c9afe3")?.publication_status === "archived";
  assert.equal(astraArchived, true);
  const reviewRepository = new SupabaseHumanReviewReadRepository(supabase);
  const status = await reviewRepository.status();
  const list = await reviewRepository.list(500);
  const logger = new SupabaseAgentLogger(supabase);
  const accounting = {};
  for (const provider of ["groq", "cloudflare_workers_ai", "cerebras"]) {
    const usage = await logger.getProviderDailyUsage(provider, utcDate);
    accounting[provider] = { requestsReserved: usage.requestsReserved, requestsDispatched: usage.requestsDispatched, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, unknownTokenRequests: usage.unknownTokenRequests };
  }
  const rowHashes = { attempts: hashRows(attempts), logs: hashRows(logs), runs: hashRows(runs), articles: hashRows(articles), scheduler: hashRows(schedulerRows) };
  const output = { mode, utcDate, trigger, capturedAtUtc: new Date().toISOString(), attemptsTotal: realAttempts.length, activeDeferredStuck: [active.length, deferred.length, stuck.length], reviewsTotal: status.totalReviews, waitingTotal: status.waitingReviews, publicArticles: publicRows.length, astraArchived, fingerprints, m32: { status: "PASS", list: "PASS", inspect: "NA" }, accounting, rowHashes, scheduler: today, review: null, m34Proof: "NA", providerCallsFromAudit: 0, remoteWritesFromAudit: 0 };
  if (mode === "before") {
    assert.equal(today.length, 0, "DAILY_TRIGGER_BLOCKED");
    assert.equal(realAttempts.length, 17);
    assert.equal(pending.length, 0);
    assert.equal(status.totalReviews, 0);
    assert.equal(status.waitingReviews, 0);
    assert.equal(list.reviews.length, 0);
    assert.ok(Object.values(accounting).every((row) => Object.values(row).every((n) => n === 0)), "UNEXPECTED_PROVIDER_BASELINE");
    const schemaResult = await runDirectMigrationCommand("m36-acl");
    assert.equal(schemaResult.code, 0, "12F10_SCHEMA_READ_FAILED");
    const schema = parseCliJson(schemaResult.output).rows[0].migration36_evidence;
    const knownSchema = await readJson("artifacts/supervised-cycle-12f9b-acl-after.json");
    assert.equal(schema.head, "20261015120000");
    assert.equal(schema.m35Count, 1); assert.equal(schema.m36Count, 1);
    assert.deepEqual(schema.rpc, knownSchema.rpc);
    assert.deepEqual(schema.tableAcls, knownSchema.tableAcls);
    assert.deepEqual(schema.otherFunctionHashes, knownSchema.otherFunctionHashes);
    assert.equal(schema.legacyRowsObserved, 46);
    assert.equal(schema.legacyRowsCountedAsCurrentPendingUnderM36, 0);
    const historyResult = await runDirectMigrationCommand("history");
    assert.equal(historyResult.code, 0);
    const history = parseCliJson(historyResult.output).migrations;
    for (const version of ["20261007215233", "20261012120000", "20261014120000", "20261015120000"]) assert.ok(history.some((row) => row.local === version && row.remote === version));
    output.schema = { status: "PASS", head: schema.head, M32: true, M34: true, M35: true, M36: true, legacyRowsObserved: 46, legacyRowsCountedAsCurrentPending: 0, rpcHash: schema.rpc.hash, acl: "PASS" };
    const pipeline = createProductionPipeline({ supabase, config: { mode: "supervised", dryRun: true, publish: false, automaticRevision: false } });
    const preflight = await pipeline.preflight();
    assert.equal(preflight.provider.toLowerCase(), "groq");
    assert.equal(preflight.allowPaidFallback, false);
    assert.equal(preflight.allowProviderPacingWait, false);
    assert.ok(Object.values(preflight.maxRetries).every((n) => n === 0));
    assert.ok(Object.values(preflight.models).every((model) => model === "openai/gpt-oss-20b"));
    output.runtimePreflight = preflight;
    assert.equal(hash(attempts), established.integrity.attempts);
    assert.equal(hash(logs), established.integrity.agentLogs);
    assert.equal(hash(runs), established.integrity.agentRuns);
    const oldTrigger = schedulerRows.filter((row) => row.trigger_id === "supervised-candidates:2026-10-15");
    assert.equal(hash(oldTrigger), established.integrity.consumedTrigger);
  } else {
    const before = await readJson("artifacts/supervised-cycle-12f10-before.json");
    assert.equal(utcDate, before.utcDate, "UTC_DAY_CHANGED_DURING_EXECUTION");
    for (const table of Object.keys(before.rowHashes)) for (const [id, digest] of Object.entries(before.rowHashes[table])) assert.equal(rowHashes[table][id], digest, `HISTORICAL_${table}_ROW_CHANGED`);
    output.historicalRowsUnchanged = true;
    const freshRuns = runs.filter((row) => !Object.hasOwn(before.rowHashes.runs, row.id));
    const freshLogs = logs.filter((row) => !Object.hasOwn(before.rowHashes.logs, row.id));
    output.newAttempts = realAttempts.filter((row) => !Object.hasOwn(before.rowHashes.attempts, row.id)).map((row) => ({ id: row.id, eventKey: row.event_key, pipelineRunId: row.pipeline_run_id, attemptNumber: row.attempt_number, startedAt: row.started_at, completedAt: row.completed_at, finalState: row.final_state, stopStage: row.stop_stage, stopReason: row.stop_reason, retryClass: row.retry_class, countsTowardRetryLimit: row.counts_toward_retry_limit, resumeStage: row.capacity_resume_snapshot?.resumeStage ?? null, resumeSnapshotPresent: row.capacity_resume_snapshot !== null && row.capacity_resume_snapshot !== undefined }));
    output.newAgentRuns = freshRuns.map((row) => ({ id: row.id, runType: row.run_type, status: row.status, provider: row.provider, agentName: row.config?.agentName ?? null, eventKey: row.config?.eventKey ?? null, attemptId: row.config?.attemptId ?? null, pipelineRunId: row.config?.pipelineRunId ?? null, startedAt: row.started_at, finishedAt: row.finished_at, telemetry: row.stats?.telemetry ?? null }));
    output.logStepCounts = Object.fromEntries([...new Set(freshLogs.map((row) => row.step))].map((step) => [step, freshLogs.filter((row) => row.step === step).length]));
    output.reservations = freshLogs.filter((row) => row.step === "provider_request_reserved").map((row) => ({ id: row.id, runId: row.run_id, agent: row.agent_name, provider: row.provider, tokens: row.provider_unit_amount, dispatched: row.payload?.providerRequestDispatched ?? null, tokenUsageState: row.payload?.tokenUsageState ?? null, actualInputTokens: row.payload?.actualInputTokens ?? null, actualOutputTokens: row.payload?.actualOutputTokens ?? null, actualTokens: row.payload?.actualTokens ?? null }));
    assert.equal(today.length, 1, "SCHEDULER_ROW_COUNT_UNEXPECTED");
    const scheduler = today[0];
    assert.equal(scheduler.lease_status, "released"); assert.ok(scheduler.finished_at);
    assert.ok(output.newAttempts.length <= 3);
    assert.ok(accounting.groq.requestsReserved <= 18);
    assert.equal(accounting.groq.unknownTokenRequests, 0, "UNKNOWN_RESERVATION_LEAK");
    for (const provider of ["cloudflare_workers_ai", "cerebras"]) assert.deepEqual(accounting[provider], before.accounting[provider]);
    assert.ok(list.reviews.length <= 1);
    if (list.reviews.length) {
      const inspection = await reviewRepository.inspect(list.reviews[0].id);
      const review = inspection.review;
      assert.ok(inspection.found && review);
      assert.equal(review.status, "WAITING_FOR_HUMAN_REVIEW"); assert.equal(review.consumed_at, null); assert.equal(review.action, null);
      const attempt = output.newAttempts.find((row) => row.id === review.attempt_id);
      assert.ok(attempt); assert.equal(attempt.eventKey, review.event_key); assert.equal(attempt.pipelineRunId, review.pipeline_run_id);
      const proven = freshRuns.filter((row) => row.config?.agentName === "critic" && row.config?.eventKey === review.event_key && row.config?.pipelineRunId === review.pipeline_run_id && row.config?.attemptId === review.attempt_id && row.status === "succeeded" && row.stats?.telemetry?.zodValid === true && row.stats?.telemetry?.finalCriticResultValid === true && row.stats?.telemetry?.deterministicPrechecksPassed === true && row.stats?.telemetry?.finalDecision === "pass");
      assert.equal(proven.length, 1);
      const execution = await readJson("artifacts/supervised-cycle-12f10-execution-result.json");
      const event = execution.result.eventResults.find((row) => row.attemptId === review.attempt_id);
      const criticPath = resolve(event.checkpoints.critic.path);
      const child = relative(resolve("artifacts/pipeline-checkpoints"), criticPath);
      assert.ok(child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
      const checkpoint = await readSafeCriticPipelineCheckpoint(criticPath);
      assert.equal(checkpoint.attemptId, review.attempt_id); assert.equal(checkpoint.eventKey, review.event_key); assert.equal(checkpoint.critic.decision, "pass");
      assert.equal(createHash("sha256").update(await readFile(criticPath)).digest("hex"), review.review_manifest.checkpoints.critic.sha256);
      assert.equal(review.review_manifest.checkpoints.critic.identity, `${review.pipeline_run_id}:${review.attempt_id}:critic:${review.event_key}`);
      output.review = review;
      output.m32.inspect = "PASS"; output.m34Proof = "PASS";
    }
  }
  output.status = "PASS";
  await save(mode, output);
  console.log(JSON.stringify({ mode, utcDate, trigger, status: "PASS", attemptsTotal: output.attemptsTotal, activeDeferredStuck: output.activeDeferredStuck, reviewsTotal: output.reviewsTotal, waitingTotal: output.waitingTotal, publicArticles: output.publicArticles, astraArchived, m32: output.m32, m34Proof: output.m34Proof, accounting, schema: output.schema ?? null }));
}
