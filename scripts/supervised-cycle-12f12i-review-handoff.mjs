import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { readSafeCriticPipelineCheckpoint } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { humanReviewCheckpointStages } from "../lib/agents/publisher/human-review.ts";
import { canonicalJsonString } from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { isAllowedSupabaseRequest } from "../lib/supabase/readonly-request-guard.ts";
import { assertRowArtifactMatch } from "./pipeline-human-review.ts";

export const identity = { reviewId: "ebd8acc0-76a2-4977-81d9-60a7f6240084", attemptId: "4658d5c0-857c-4ed5-b97f-afb133b2bf22", pipelineRunId: "f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d", eventKey: "event-5c7d0ef5ea6f72bec96704aded750851" };
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const root = `artifacts/pipeline-checkpoints/${identity.pipelineRunId}`;
export async function validateExistingReview(row, artifact) {
  assert.deepEqual([row.id, row.attempt_id, row.pipeline_run_id, row.event_key, row.status, row.consumed_at, row.action], [identity.reviewId, identity.attemptId, identity.pipelineRunId, identity.eventKey, "WAITING_FOR_HUMAN_REVIEW", null, null], "EXISTING_REVIEW_IDENTITY_OR_STATE_CHANGED");
  assertRowArtifactMatch(row, artifact, artifact.packageSha256);
  assert.equal(row.critic_pass, true); assert.equal(row.provider_usage_settled, true);
  if (row.source_lineage) assert.equal(canonicalJsonString(row.source_lineage), canonicalJsonString(artifact.sourceLineage), "SOURCE_LINEAGE_CHANGED");
  for (const stage of humanReviewCheckpointStages) {
    assert.deepEqual(row.review_manifest.checkpoints[stage], { identity: `${identity.pipelineRunId}:${identity.attemptId}:${stage}:${identity.eventKey}`, sha256: sha(`${root}/${stage}-${identity.eventKey}.json`) }, `DURABLE_CHECKPOINT_MISMATCH:${stage}`);
  }
  const critic = await readSafeCriticPipelineCheckpoint(`${root}/critic-${identity.eventKey}.json`);
  assert.deepEqual([critic.attemptId, critic.eventKey, critic.critic.decision], [identity.attemptId, identity.eventKey, "pass"], "M34_DURABLE_PASS_REQUIRED");
  assert.equal(canonicalJsonString(critic.critic), canonicalJsonString(artifact.reviewEvidence.critic));
  const accounting = Object.values(artifact.reviewEvidence.providerAccounting);
  const totals = ["requestCount", "inputTokens", "outputTokens", "totalTokens"].map((key) => accounting.reduce((sum, stage) => sum + stage[key], 0));
  assert.deepEqual(totals, [6, 9140, 1652, 10792]);
  return { status: "PASS", sourceLineage: "PASS", criticDurableProof: "PASS", m34: "PASS", checkpointHashes: Object.fromEntries(humanReviewCheckpointStages.map((s) => [s, artifact.checkpoints[s].sha256])), providerAccounting: { requests: 6, inputTokens: 9140, outputTokens: 1652, totalTokens: 10792 } };
}
export async function readOnlyValidation() {
  // This script has no resume/create/complete/decide/publish capability.
  const gates = readJson("artifacts/supervised-cycle-12f12i-local-gates.json"); assert.equal(gates.status, "PASS");
  for (const [path, hash] of Object.entries(gates.sourceHashes)) assert.equal(sha(path), hash, `GATED_SOURCE_CHANGED:${path}`);
  assert.equal(readJson("artifacts/supervised-cycle-12f12i-acl-after.json").head, "20261020120000");
  const originalFetch = globalThis.fetch;
  const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
  const requests = [];
  const readTables = new Set(["pipeline_event_attempts", "articles", "scheduler_runs", "agent_runs", "agent_logs"]);
  const readRpcs = new Set(["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator", "get_pipeline_human_review_operator_inspect"]);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); const url = new URL(request.url);
    assert.equal(url.origin, origin, "NETWORK_ORIGIN_FORBIDDEN");
    assert.equal(isAllowedSupabaseRequest({ pathname: url.pathname, method: request.method, phase: "PREFLIGHT", readTables, readRpcs, resumeRpcs: new Set() }), true, "READ_ONLY_OPERATION_REQUIRED");
    if (url.pathname.endsWith("/get_pipeline_human_review_operator_inspect")) assert.equal((await request.clone().json()).p_review_id, identity.reviewId);
    const response = await originalFetch(request); requests.push({ method: request.method, endpoint: url.pathname, httpStatus: response.status }); return response;
  };
  try {
    const supabase = createSupabaseServerClient(); const repository = new SupabaseHumanReviewReadRepository(supabase);
    const status = await repository.status(); const list = await repository.list(500); const inspect = await repository.inspect(identity.reviewId);
    assert.deepEqual([status.totalReviews, status.waitingReviews, status.consumedReviews, status.activeWork, status.stuckWork, list.reviews.length, inspect.found], [1, 1, 0, 0, 0, 1, true]);
    const artifact = readJson(`artifacts/human-review-packages/${identity.attemptId}.json`);
    await validateExistingReview(list.reviews[0], artifact); const reviewValidation = await validateExistingReview(inspect.review, artifact);
    const all = async (table) => {
      const rows = []; for (let offset = 0; ; offset += 500) {
        const response = await supabase.from(table).select("*").order("id").range(offset, offset + 499); assert.equal(response.error, null, "READ_FAILED");
        rows.push(...response.data); if (response.data.length < 500) return rows;
      }
    };
    const attempts = (await all("pipeline_event_attempts")).filter((a) => a.validation_namespace == null);
    const attempt = attempts.find((a) => a.id === identity.attemptId); assert.ok(attempt);
    assert.deepEqual([attempt.event_key, attempt.pipeline_run_id, attempt.final_state, attempt.stop_stage, attempt.stop_reason, attempt.counts_toward_retry_limit], [identity.eventKey, identity.pipelineRunId, "WAITING_FOR_HUMAN_REVIEW", "human_review", "HUMAN_REVIEW_PENDING", false]); assert.ok(attempt.completed_at);
    const pending = attempts.filter((a) => a.completed_at === null || a.final_state === null);
    assert.equal(attempts.length, 19); assert.equal(pending.length, 0);
    const prior = readJson("artifacts/supervised-cycle-12f12h-critic-human-review.json");
    assert.equal(attempt.completed_at, prior.finalAttemptState.completedAt);
    const articles = await all("articles"); const publicRows = articles.filter((a) => a.publication_status === "published");
    const fingerprints = publicRows.map((a) => ({ id: a.id, sha256: publicArticleFingerprintV1(a) })).sort((a, b) => a.id.localeCompare(b.id));
    assert.equal(publicRows.length, 2); assert.deepEqual(fingerprints, prior.publicState.fingerprints);
    assert.equal(articles.find((a) => a.id === "756b0ee0-b5e6-4153-846f-278a12c9afe3")?.publication_status, "archived");
    const logger = new SupabaseAgentLogger(supabase); const daily = {};
    for (const provider of ["groq", "cerebras", "cloudflare_workers_ai"]) {
      daily[provider] = await logger.getProviderDailyUsage(provider, "2026-10-20");
      assert.deepEqual(daily[provider], prior.providerAccounting.dailyAfter[provider], "NEW_PROVIDER_ACTIVITY"); assert.equal(daily[provider].unknownTokenRequests, 0);
    }
    const result = { capturedAtUtc: new Date().toISOString(), target: identity, reviewValidation,
      m32Status: "PASS", m32List: "PASS", m32Inspect: "PASS", status, review: { id: inspect.review.id, status: "WAITING", consumed: false, sourceLineageSha256: inspect.review.source_lineage_sha256 },
      attemptValidation: { status: "PASS", terminal: true, completedAt: attempt.completed_at, finalState: attempt.final_state, resumeGeneration: attempt.capacity_resume_snapshot?.resumeGeneration, stageReruns: 0 },
      baseline: { attempts: 19, activeDeferredStuck: [0, 0, 0], reviews: 1, waiting: 1, public: 2, astra: "ARCHIVED", fingerprints, fingerprintsUnchanged: true, unknownReservations: 0, publisher: "NOT RUN" },
      providerAccounting: { ...reviewValidation.providerAccounting, daily, providerCallsThisPhase: 0 },
      prohibitedActions: { criticResumes: 0, providerCalls: 0, newReviews: 0, newAttempts: 0, schedulerRuns: 0, remoteEditorialMutations: 0, approve: 0, hold: 0, reject: 0, publications: 0 }, requests, readyForHumanAction: true };
    writeFileSync("artifacts/supervised-cycle-12f12i-readonly-validation.json", JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally { globalThis.fetch = originalFetch; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) readOnlyValidation().then((r) => console.log(JSON.stringify(r))).catch((e) => { console.error(e instanceof Error ? e.message : "READ_ONLY_VALIDATION_FAILED"); process.exitCode = 1; });
