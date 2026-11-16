import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { PipelineOrchestrator } from "../lib/agents/pipeline/pipeline-orchestrator.ts";
import {
  assertFactualRemediationLease,
  assertPilotAttemptBaseline,
  createFactualRemediationPlan,
  factualRemediationIncident,
  factualRemediationStages,
  parseFactualRemediationCommand,
} from "../lib/agents/pipeline/factual-remediation.ts";
import { SupabaseFactualRemediationRepository } from "../lib/agents/pipeline/factual-remediation-repository.ts";
import { evaluateNormalEligibility } from "../lib/agents/pipeline/event-attempt-policy.ts";

const repo = resolve(".");
const migrationName = "20260930211903_factual_remediation_lifecycle.sql";
const migration = await readFile(resolve(repo, "supabase/migrations", migrationName), "utf8");
const migrationFiles = (await (await import("node:fs/promises")).readdir(resolve(repo, "supabase/migrations"))).filter((name) => /factual_remediation_lifecycle\.sql$/.test(name));
assert.deepEqual(migrationFiles, [migrationName], "only migration 27 is prepared");
assert.doesNotMatch(migration, /create\s+table\b/i, "no new table");
assert.match(migration, /purpose\s+text\s+not null\s+default\s+'NORMAL'/i);
assert.match(migration, /validation_namespace\s+text/i);
assert.match(migration, /purpose\s*=\s*'FACTUAL_REMEDIATION'\s+and\s+start_stage\s*=\s*'VERIFIER'/i);
assert.match(migration, /create unique index pipeline_event_attempts_one_factual_remediation_idx[\s\S]*where purpose = 'FACTUAL_REMEDIATION'/i);
assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_event_key, 0\)\)/i);
assert.match(migration, /auth\.role\(\) is distinct from 'service_role'/i);
assert.match(migration, /set search_path = pg_catalog, public/i);
assert.match(migration, /claim_factual_remediation_attempt[\s\S]*p_validation_namespace/i);
assert.match(migration, /p_validation_namespace !~ '\^12c2b1:/i);
assert.match(migration, /classification_payload ->> 'validationNamespace' = p_validation_namespace/i);
assert.match(migration, /metadata ->> 'validationNamespace' = p_validation_namespace/i);
assert.match(migration, /normalized_payload ->> 'validationNamespace' = p_validation_namespace/i);
assert.match(migration, /validation_namespace is null[\s\S]*pilot_attempt_number = 5/i);
assert.match(migration, /validation_namespace ~ '\^12c2b1:[\s\S]*pilot_attempt_number is null/i);
assert.match(migration, /revoke all on function public\.claim_factual_remediation_attempt\(uuid, text, text, text, text, uuid, uuid, uuid, uuid, text, text, text\) from public, anon, authenticated/i);
assert.match(migration, /grant execute on function public\.claim_factual_remediation_attempt\(uuid, text, text, text, text, uuid, uuid, uuid, uuid, text, text, text\) to service_role/i);
assert.match(migration, /revoke all on function public\.claim_incident_factual_remediation_attempt\(uuid, text, text, text\) from public, anon, authenticated/i);
assert.match(migration, /grant execute on function public\.claim_incident_factual_remediation_attempt\(uuid, text, text, text\) to service_role/i);
assert.match(migration, /revoke all on function public\.publish_factual_remediation_article_atomic\(uuid, uuid, uuid, text, jsonb\) from public, anon, authenticated/i);
assert.match(migration, /grant execute on function public\.publish_factual_remediation_article_atomic\(uuid, uuid, uuid, text, jsonb\) to service_role/i);
assert.match(migration, /publication_status = 'archived' for update/i);
assert.match(migration, /public\.publish_article_atomic\(p_payload\)/i);
assert.match(migration, /publication_status = 'published'/i);
assert.match(migration, /pilot_attempt_number\s*=\s*5/i);
assert.match(migration, /ARCHIVED_ARTICLE_IDENTITY_CHANGED/i);
assert.match(migration, /EVENT_IDENTITY_CHANGED/i);
assert.match(migration, /RAW_LINEAGE_CHANGED/i);
assert.match(migration, /STORED_EXTRACTION_CHANGED/i);
assert.match(migration, /PRIOR_TERMINAL_ATTEMPT_CHANGED/i);
assert.match(migration, /ACTIVE_ATTEMPT/i);
assert.match(migration, /REMEDIATION_ALREADY_CLAIMED/i);
assert.match(migration, /purpose in \('NORMAL', 'FACTUAL_REMEDIATION'\)/i);
assert.match(migration, /and start_stage = 'VERIFIER'/i);
assert.match(migration, /revoke insert, update, delete on table public\.pipeline_event_attempts from service_role/i);
const claimFunction = migration.split("create or replace function public.claim_factual_remediation_attempt")[1].split("create or replace function public.claim_incident_factual_remediation_attempt")[0];
const incidentWrapper = migration.split("create or replace function public.claim_incident_factual_remediation_attempt")[1].split("revoke all on function public.claim_factual_remediation_attempt")[0];
assert.doesNotMatch(claimFunction, /update\s+public\.pipeline_event_attempts\s+set/i, "claim inserts a new attempt and leaves prior attempts unchanged");
assert.match(claimFunction, /'ce894b55-5c50-44dc-87db-58bcbf09834b'/i);
assert.match(claimFunction, /'8c96ffb9-4705-4aab-b396-7e4cc41b2939'/i);
assert.match(claimFunction, /'0327c9a0-1b2b-49a9-b814-351c6ff53b51'/i);
assert.match(claimFunction, /'63b81d9a-e46f-4434-9637-335d3f455e0b'/i);
assert.match(claimFunction, /'INVALID_PURPOSE'/i);
assert.match(claimFunction, /'INVALID_START_STAGE'/i);
assert.match(claimFunction, /'VALIDATION_NAMESPACE_INVALID'/i);
assert.match(claimFunction, /case when v_is_incident then 5 else null end/i);
assert.match(incidentWrapper, /public\.claim_factual_remediation_attempt\(/i);

const baseline = [
  { eventKey: "event-cbbf85234317a442f59ece63ef1b40c8", pipelineRunId: "ce894b55-5c50-44dc-87db-58bcbf09834b", attemptNumber: 1, finalState: "TECHNICAL_FAILURE" },
  { eventKey: "event-cbbf85234317a442f59ece63ef1b40c8", pipelineRunId: "8c96ffb9-4705-4aab-b396-7e4cc41b2939", attemptNumber: 2, finalState: "READY_FOR_PUBLICATION" },
  { eventKey: "event-f91a0e775887c720bb2bee5363ce6f26", pipelineRunId: "0327c9a0-1b2b-49a9-b814-351c6ff53b51", attemptNumber: 1, finalState: "READY_FOR_PUBLICATION" },
  { eventKey: factualRemediationIncident.eventKey, pipelineRunId: factualRemediationIncident.priorPipelineRunId, attemptNumber: 1, finalState: "READY_FOR_PUBLICATION" },
  { eventKey: "event-unrelated-a", pipelineRunId: "historic-1", attemptNumber: 1, finalState: "READY_FOR_PUBLICATION" },
  { eventKey: "event-unrelated-b", pipelineRunId: "historic-2", attemptNumber: 1, finalState: "TECHNICAL_FAILURE" },
  { eventKey: "event-unrelated-c", pipelineRunId: "historic-3", attemptNumber: 2, finalState: "READY_FOR_PUBLICATION" },
];
assertPilotAttemptBaseline(baseline);
assert.throws(() => assertPilotAttemptBaseline(baseline.slice(0, 3)), /PILOT_BASELINE_CHANGED/);
assert.equal(evaluateNormalEligibility([{
  id: "prior",
  eventKey: factualRemediationIncident.eventKey,
  pipelineRunId: factualRemediationIncident.priorPipelineRunId,
  attemptNumber: 1,
  startedAt: "2026-09-30T00:00:00.000Z",
  completedAt: "2026-09-30T00:01:00.000Z",
  finalState: "READY_FOR_PUBLICATION",
  stopStage: null,
  stopReason: null,
  retryClass: "NONE",
  countsTowardRetryLimit: false,
  nextEligibleAt: null,
  createdAt: "2026-09-30T00:00:00.000Z",
}], new Date("2026-09-30T00:02:00.000Z")).reason, "PERMANENT_OUTCOME");

assert.equal(parseFactualRemediationCommand([]).mode, "preflight");
assert.equal(parseFactualRemediationCommand(["--preflight-only"]).mode, "preflight");
assert.deepEqual(parseFactualRemediationCommand(["--execute-factual-remediation", "--authorized-by=Diego", "--authorization-reference=incident-12c1", "--reason=Correct factual attribution based on preserved source evidence."]), {
  mode: "execute",
  authorizedBy: "Diego",
  authorizationReference: "incident-12c1",
  reason: "Correct factual attribution based on preserved source evidence.",
});
assert.throws(() => parseFactualRemediationCommand(["--execute-factual-remediation"]), /AUTHORIZED_BY_REQUIRED/);
assert.throws(() => parseFactualRemediationCommand(["--authorized-by=Diego"]), /AUTHORIZATION_REQUIRES_EXECUTION_FLAG/);
assert.throws(() => parseFactualRemediationCommand(["--execute-factual-remediation", "--preflight-only", "--authorized-by=Diego", "--authorization-reference=incident-12c1", "--reason=Correct factual attribution based on preserved source evidence."]), /MODE_CONFLICT/);

const plan = createFactualRemediationPlan();
assert.equal(plan.startStage, "VERIFIER");
assert.equal(plan.maxRetries, 0);
assert.equal(plan.maxGroqCalls, 6);
assert.equal(plan.pilotAttemptBefore, "4/5");
assert.equal(plan.pilotAttemptAfterClaim, "5/5");
assert.equal(plan.reuseOldCheckpointsFromStartStage, false);
assert.deepEqual(plan.stages, factualRemediationStages);

const priorAttemptId = "30000000-0000-4000-8000-000000000003";
const runId = "30000000-0000-4000-8000-000000000001";
const attempt = {
  id: "30000000-0000-4000-8000-000000000002",
  eventKey: factualRemediationIncident.eventKey,
  pipelineRunId: runId,
  attemptNumber: 2,
  startedAt: "2026-09-30T22:00:00.000Z",
  completedAt: null,
  finalState: null,
  stopStage: null,
  stopReason: null,
  retryClass: "NONE",
  countsTowardRetryLimit: false,
  nextEligibleAt: null,
  createdAt: "2026-09-30T22:00:00.000Z",
};
const rpcRow = {
  id: attempt.id,
  event_key: attempt.eventKey,
  pipeline_run_id: attempt.pipelineRunId,
  attempt_number: attempt.attemptNumber,
  started_at: attempt.startedAt,
  completed_at: null,
  final_state: null,
  stop_stage: null,
  stop_reason: null,
  retry_class: "NONE",
  counts_toward_retry_limit: false,
  next_eligible_at: null,
  created_at: attempt.createdAt,
  purpose: "FACTUAL_REMEDIATION",
  start_stage: "VERIFIER",
  remediation_article_id: factualRemediationIncident.articleId,
  remediation_raw_item_id: factualRemediationIncident.rawItemId,
  remediation_prior_attempt_id: priorAttemptId,
  pilot_attempt_number: 5,
};
let rpcCall = null;
const repository = new SupabaseFactualRemediationRepository({
  rpc: async (name, args) => {
    rpcCall = { name, args };
    return { data: { status: "ACQUIRED", attempt: rpcRow }, error: null };
  },
});
const lease = await repository.claim(runId, {
  authorizedBy: "Diego",
  authorizationReference: "incident-12c1",
  reason: "Correct factual attribution based on preserved source evidence.",
});
assert.equal(rpcCall.name, "claim_incident_factual_remediation_attempt");
assert.equal(rpcCall.args.p_pipeline_run_id, runId);
assert.equal(lease.purpose, "FACTUAL_REMEDIATION");
assert.equal(lease.startStage, "VERIFIER");
assert.equal(lease.pilotAttemptNumber, 5);
assert.equal(lease.priorAttemptId, priorAttemptId);
assertFactualRemediationLease(lease);
assert.throws(() => assertFactualRemediationLease({ ...lease, startStage: "EDITOR" }), /START_STAGE_FORBIDDEN/);
assert.throws(() => assertFactualRemediationLease({ ...lease, articleId: "wrong" }), /TARGET_MISMATCH/);

const eventKey = factualRemediationIncident.eventKey;
const event = {
  ...structuredClone(validFixtures.ClusteredEvent),
  eventKey,
  sourceItems: validFixtures.ClusteredEvent.sourceItems.map((sourceItem) => ({ ...sourceItem, sourceId: factualRemediationIncident.sourceId })),
};
const extracted = structuredClone(validFixtures.ExtractedItem);
const sources = [{
  sourceId: factualRemediationIncident.sourceId,
  sourceItemId: extracted.candidateId,
  rawItemId: factualRemediationIncident.rawItemId,
  sourceName: "TechCrunch AI",
  sourceUrl: extracted.canonicalUrl,
  sourceType: "website",
  countryCode: "US",
  language: "en",
}];
const calls = [];
const stageContexts = [];
const finalizeCalls = [];
const ownershipChecks = [];
const outcome = (output, stage, context, requests = 1) => {
  stageContexts.push({ stage, context });
  calls.push(stage);
  return Promise.resolve({
    output: { ...structuredClone(output), eventKey },
    eventKey,
    agentVersion: `${stage}-offline-test`,
    model: "groq-test-fixture",
    provider: requests ? "groq" : undefined,
    attempts: requests,
    retries: 0,
    providerRequestsUsed: requests,
    latencyMs: 1,
    checkpoint: async () => ({ stage, eventKey, path: `memory://${stage}`, written: true, readable: true, valid: true }),
  });
};
const publisherOutput = { status: "success", dryRun: false, summary: { idempotencyOutcome: "deterministic_update" } };
const stages = {
  discovery: async () => { throw new Error("remediation must not run discovery"); },
  extraction: async () => { throw new Error("remediation must not run extraction"); },
  clustering: async () => { throw new Error("remediation must not rerun clustering"); },
  sourceMetadata: () => sources,
  verifier: (context) => {
    assert.equal(ownershipChecks.length, 1, "ownership validation precedes all agent execution");
    assert.equal(context.verification, undefined, "stale verifier output is not loaded");
    assert.equal(context.editorial, undefined, "stale downstream output is not loaded");
    assert.equal(context.factualRemediationTarget.articleId, factualRemediationIncident.articleId);
    return outcome(validFixtures.VerificationResult, "verifier", context);
  },
  translator: (context) => outcome(validFixtures.TranslationResult, "translator", context),
  editor: (context) => outcome(validFixtures.EditorialDraft, "editor", context),
  classifier: (context) => outcome(validFixtures.ClassificationResult, "classifier", context),
  geo: (context) => outcome({ eventKey, primaryRegionCode: "US", countryCodes: ["US"], latitude: 39.8283, longitude: -98.5795, resolutionLevel: "region", resolvedFrom: "reference_registry", provenance: "reference_registry" }, "geo", context, 0),
  ranker: (context) => outcome(validFixtures.RankingResult, "ranker", context),
  critic: (context) => outcome({ ...validFixtures.CriticResult, decision: "pass" }, "critic", context),
  publisher: (context, run, options) => {
    assert.equal(run.dryRun, false);
    assert.equal(options.dryRun, false);
    assert.equal(context.factualRemediationTarget.articleSlug, factualRemediationIncident.articleSlug);
    calls.push("publisher");
    return Promise.resolve({ output: publisherOutput, eventKey, agentVersion: "publisher-offline-test", model: "deterministic", attempts: 0, retries: 0, providerRequestsUsed: 0, latencyMs: 0 });
  },
};
const attemptRegistry = {
  async getEligibility() { throw new Error("normal eligibility is not used for factual remediation"); },
  async claim() { throw new Error("normal claim is not used for factual remediation"); },
  async finalize(value) { finalizeCalls.push(value); },
};
const orchestrator = new PipelineOrchestrator({
  stages,
  quota: { provider: "groq", async remaining() { return 20; } },
  attemptRegistry,
  factualRemediationAttemptGuard: { async assertOwned(value) { ownershipChecks.push(value.attempt.id); } },
  config: { dryRun: false, publish: true, trigger: "manual", automaticRevision: false },
  now: () => new Date("2026-09-30T22:00:00.000Z"),
});
const remediationResult = await orchestrator.runFactualRemediation({
  lease,
  initial: { event, items: [extracted], sources, verification: validFixtures.VerificationResult, editorial: validFixtures.EditorialDraft },
});
assert.equal(remediationResult.finalState, "SUCCESS");
assert.deepEqual(ownershipChecks, [lease.attempt.id], "database ownership is checked before the first stage");
assert.equal(remediationResult.requestsUsed, 6);
assert.deepEqual(calls, ["verifier", "translator", "editor", "classifier", "geo", "ranker", "critic", "publisher"]);
assert.equal(finalizeCalls.length, 1);
assert.equal(finalizeCalls[0].attemptId, lease.attempt.id);
assert.equal(finalizeCalls[0].pipelineRunId, lease.attempt.pipelineRunId);
assert.equal(finalizeCalls[0].finalState, "READY_FOR_PUBLICATION");
assert.equal(finalizeCalls[0].countsTowardRetryLimit, false);
assert.equal(finalizeCalls[0].retryClass, "NONE");
assert.equal(finalizeCalls[0].nextEligibleAt, null);

const attemptRepositorySource = await readFile(resolve(repo, "lib/agents/pipeline/event-attempt-repository.ts"), "utf8");
assert.match(attemptRepositorySource, /rpc\("claim_pipeline_event_attempt"/);
assert.doesNotMatch(attemptRepositorySource, /claim_incident_factual_remediation_attempt/);
const loaderSource = await readFile(resolve(repo, "lib/agents/pipeline/factual-remediation-input.ts"), "utf8");
assert.match(loaderSource, /hashContent\(raw\.raw_content\) !== raw\.content_hash/);
assert.match(loaderSource, /rawContentSha256/);
assert.match(loaderSource, /clusterExtractedItems\(\[item\]\)/);
assert.doesNotMatch(loaderSource, /\bfetch\s*\(|\.from\([^)]*\)\.(insert|update|upsert)\s*\(/i, "stored evidence loading has no source fetch or database writes");
const productionSource = await readFile(resolve(repo, "lib/agents/pipeline/create-production-pipeline.ts"), "utf8");
assert.match(productionSource, /function checkpointPath\(root: string, run: PipelineRunContext, stage: PipelineStage, eventKey: string\): string \{ return join\(root, safePart\(run\.runId\)/);
assert.match(productionSource, /slug: remediationTarget\.articleSlug/);
const publisherRepositorySource = await readFile(resolve(repo, "lib/agents/publisher/supabase-publisher-repository.ts"), "utf8");
assert.match(publisherRepositorySource, /async publishFactualRemediationAtomic\([\s\S]*?throw new Error\("HUMAN_APPROVAL_REQUIRED"\)/);
assert.doesNotMatch(publisherRepositorySource, /rpc\("publish_factual_remediation_article_atomic"/, "factual-remediation publication cannot bypass human approval");
const remediationRunnerSource = await readFile(resolve(repo, "scripts/factual-remediation-12c2b0.ts"), "utf8");
assert.ok(remediationRunnerSource.indexOf('if (command.mode === "preflight") return;') < remediationRunnerSource.indexOf("remediationAttempts.claim("), "preflight returns before creating an attempt");
assert.match(remediationRunnerSource, /runFactualRemediation\(\{ lease, initial: executionInput \}\)/);
for (const name of ["scheduler-execution.ts", "scheduler-runner.ts", "scheduler-repository.ts"]) {
  const source = await readFile(resolve(repo, "lib/agents/pipeline/scheduler", name), "utf8");
  assert.doesNotMatch(source, /claim_incident_factual_remediation_attempt|SupabaseFactualRemediationRepository/);
}

console.log(JSON.stringify({ status: "PASS", migration: migrationName, noNewTable: true, pilotBaseline: "4/5", remediationAttempt: "5/5", startStage: "VERIFIER", stages: calls, simulatedGroqRequests: remediationResult.requestsUsed, actualProviderCalls: 0, remoteWrites: 0 }));
