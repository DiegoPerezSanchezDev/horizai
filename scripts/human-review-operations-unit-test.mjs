// The shared decide/publish rules used by BOTH the pipeline:human-review CLI and the editorial panel.
// Doubles only: no database, no network. Packages and checkpoints are real files in a temp directory.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { createHumanReviewOperations, humanReviewCheckNames, humanReviewChecksFromVerdicts } from "../lib/agents/publisher/human-review-operations.ts";
import { allChecksPass, approvedRow, buildReviewScenario, ids } from "./editorial-test-support.mjs";

const NOW = new Date("2026-10-21T12:00:00.000Z");

function harness(scenario, { row = scenario.row, publishedToday = 0, lease = { status: "acquired" }, publishFails = false } = {}) {
  const state = { row, publishedToday, decideCalls: [], publishCalls: [], acquireCalls: [], finishCalls: [], releaseCalls: [] };
  const operations = createHumanReviewOperations({
    readRepository: { async inspect(reviewId) { return reviewId === state.row.id ? { found: true, review: state.row, publishedToday: state.publishedToday } : { found: false, review: null, publishedToday: state.publishedToday }; } },
    decisionRepository: {
      async decide(input) { state.decideCalls.push(input); return { reviewId: input.reviewId, status: input.decision === "APPROVE" ? "APPROVED" : input.decision === "HOLD" ? "HOLD" : "REJECTED" }; },
      async publishReviewed(input) { if (publishFails) throw new Error("publication_failed"); state.publishCalls.push(input); return { articleId: "article-1" }; },
    },
    scheduler: {
      async acquire(input) { state.acquireCalls.push(input); return lease; },
      async finish(input) { state.finishCalls.push(input); return true; },
      async release(input) { state.releaseCalls.push(input); return true; },
    },
    artifactRoot: scenario.artifactRoot, checkpointRoot: scenario.checkpointRoot, now: () => NOW, newOwnerRunId: () => "owner-run",
  });
  return { state, operations };
}

const decision = (scenario, patch = {}) => ({
  reviewId: ids.review, decision: "APPROVE", reviewerId: "operator@example.org", expectedPackageSha256: scenario.packageSha256,
  checks: humanReviewChecksFromVerdicts(allChecksPass), ...patch,
});

test("check names and the verdict mapping cover all seven checks", () => {
  assert.deepEqual([...humanReviewCheckNames], ["facts", "attribution", "uncertainty", "headline", "summary", "unsupported-claims", "source-chain"]);
  assert.deepEqual(humanReviewChecksFromVerdicts(allChecksPass), {
    factsAcceptable: true, attributionAcceptable: true, uncertaintyPreserved: true, headlineAcceptable: true,
    summaryAcceptable: true, noUnsupportedMaterialClaims: true, sourceChainAcceptable: true,
  });
});

test("approve with the exact package hash and seven passing checks reaches the repository with the reviewer identity", async () => {
  const scenario = await buildReviewScenario();
  try {
    const { operations, state } = harness(scenario);
    const result = await operations.decide(decision(scenario));
    assert.equal(result.status, "APPROVED");
    assert.equal(state.decideCalls.length, 1);
    assert.equal(state.decideCalls[0].reviewerId, "operator@example.org");
    assert.equal(state.decideCalls[0].decision, "APPROVE");
    assert.equal(state.decideCalls[0].approvalTargetRevisionSha256, undefined);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("a stale or wrong expected package hash blocks every decision before the repository is touched", async () => {
  const scenario = await buildReviewScenario();
  try {
    const { operations, state } = harness(scenario);
    await assert.rejects(() => operations.decide(decision(scenario, { expectedPackageSha256: "a".repeat(64) })), /HUMAN_REVIEW_PACKAGE_IDENTITY_OR_HASH_STALE/);
    await assert.rejects(() => operations.decide(decision(scenario, { expectedPackageSha256: "not-a-hash" })), /EXPECTED_PACKAGE_SHA256_MUST_BE_HEX/);
    await assert.rejects(() => operations.decide(decision(scenario, { reviewId: "not-a-uuid" })), /HUMAN_REVIEW_ID_MUST_BE_UUID/);
    await assert.rejects(() => operations.decide(decision(scenario, { reviewId: "99999999-9999-4999-8999-999999999999" })), /HUMAN_REVIEW_NOT_FOUND/);
    assert.equal(state.decideCalls.length, 0);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("approval needs all seven checks, but hold and reject may carry failed checks; a reviewer is mandatory", async () => {
  const scenario = await buildReviewScenario();
  try {
    const { operations, state } = harness(scenario);
    for (const name of humanReviewCheckNames) {
      const verdicts = { ...allChecksPass, [name]: false };
      await assert.rejects(() => operations.decide(decision(scenario, { checks: humanReviewChecksFromVerdicts(verdicts) })), /HUMAN_APPROVAL_REQUIRES_ALL_SEVEN_CHECKS_TO_PASS/, name);
    }
    assert.equal(state.decideCalls.length, 0);
    const failing = humanReviewChecksFromVerdicts({ ...allChecksPass, facts: false });
    assert.equal((await operations.decide(decision(scenario, { decision: "HOLD", checks: failing }))).status, "HOLD");
    assert.equal((await operations.decide(decision(scenario, { decision: "REJECT", checks: failing }))).status, "REJECTED");
    await assert.rejects(() => operations.decide(decision(scenario, { reviewerId: "  " })), /HUMAN_REVIEW_REVIEWER_REQUIRED/);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("only WAITING and HOLD reviews can be decided; a HOLD review can be decided again", async () => {
  const scenario = await buildReviewScenario();
  try {
    for (const status of ["APPROVED", "REJECTED", "PUBLISHING", "PUBLISHED"]) {
      const { operations } = harness(scenario, { row: { ...scenario.row, status } });
      await assert.rejects(() => operations.decide(decision(scenario)), new RegExp(`HUMAN_REVIEW_STATUS_NOT_ALLOWED:${status}`));
    }
    const { operations } = harness(scenario, { row: { ...scenario.row, status: "HOLD" } });
    assert.equal((await operations.decide(decision(scenario))).status, "APPROVED");
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("a changed checkpoint or a tampered package makes the review stale", async () => {
  const scenario = await buildReviewScenario();
  try {
    const { operations, state } = harness(scenario);
    await writeFile(scenario.checkpointPath("editor"), "changed after review");
    await assert.rejects(() => operations.decide(decision(scenario)), /HUMAN_REVIEW_CHECKPOINT_STALE:editor/);
    assert.equal(state.decideCalls.length, 0);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
  const tampered = await buildReviewScenario();
  try {
    const path = (await import("../lib/agents/publisher/human-review.ts")).humanReviewArtifactPath(tampered.artifactRoot, ids.attempt);
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored.draft.headlineEs = "Titular cambiado sin aprobación";
    await writeFile(path, JSON.stringify(stored));
    const { operations, state } = harness(tampered);
    await assert.rejects(() => operations.decide(decision(tampered)), /HUMAN_REVIEW_PACKAGE_IDENTITY_OR_HASH_STALE/);
    assert.equal(state.decideCalls.length, 0);
  } finally { await rm(tampered.base, { recursive: true, force: true }); }
});

test("the first load attaches the review id to a package written before the review existed", async () => {
  const scenario = await buildReviewScenario({ reviewIdAttached: false });
  try {
    const { operations } = harness(scenario);
    await operations.decide(decision(scenario, { decision: "HOLD" }));
    const { humanReviewArtifactPath } = await import("../lib/agents/publisher/human-review.ts");
    const stored = JSON.parse(await readFile(humanReviewArtifactPath(scenario.artifactRoot, ids.attempt), "utf8"));
    assert.equal(stored.reviewId, ids.review);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("a corrected (human revision) target needs its own exact revision hash only when approving", async () => {
  const scenario = await buildReviewScenario();
  try {
    const revisionRow = { ...scenario.row, approval_target_kind: "HUMAN_REVISION", approval_target_revision_id: ids.revision, approval_target_revision_sha256: "c".repeat(64) };
    const { operations, state } = harness(scenario, { row: revisionRow });
    await assert.rejects(() => operations.decide(decision(scenario)), /HUMAN_REVIEW_EXPECTED_REVISION_SHA256_REQUIRED/);
    await assert.rejects(() => operations.decide(decision(scenario, { expectedRevisionSha256: "d".repeat(64) })), /HUMAN_REVIEW_APPROVAL_REVISION_HASH_STALE/);
    await assert.rejects(() => operations.decide(decision(scenario, { decision: "HOLD", expectedRevisionSha256: "c".repeat(64) })), /HUMAN_REVIEW_REVISION_HASH_NOT_EXPECTED/);
    assert.equal(state.decideCalls.length, 0);
    await operations.decide(decision(scenario, { expectedRevisionSha256: "c".repeat(64) }));
    assert.equal(state.decideCalls[0].approvalTargetRevisionSha256, "c".repeat(64));
    const plain = harness(scenario);
    await assert.rejects(() => plain.operations.decide(decision(scenario, { expectedRevisionSha256: "c".repeat(64) })), /HUMAN_REVIEW_REVISION_HASH_NOT_EXPECTED/);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("publishing an approved review checks the package, takes the daily lease and always releases it", async () => {
  const scenario = await buildReviewScenario();
  try {
    const { operations, state } = harness(scenario, { row: approvedRow(scenario.row), publishedToday: 1 });
    const seen = [];
    const published = await operations.publishApproved([ids.review], [scenario.packageSha256], (entry) => seen.push(entry));
    assert.deepEqual(published, [{ reviewId: ids.review, articleId: "article-1" }]);
    assert.deepEqual(seen, published);
    assert.equal(state.acquireCalls[0].triggerId, "supervised-human-review-publish:2026-10-21");
    assert.equal(state.acquireCalls[0].maxEventsPerRun, 2);
    assert.equal(state.publishCalls.length, 1);
    assert.equal(state.publishCalls[0].authorization.publishedToday, 1);
    assert.equal(state.publishCalls[0].authorization.packageSha256, scenario.packageSha256);
    assert.equal(state.finishCalls[0].runStatus, "succeeded");
    assert.equal(state.releaseCalls.length, 1);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("publication refuses stale hashes, wrong status and missing approval flags without publishing anything", async () => {
  const scenario = await buildReviewScenario();
  try {
    const approved = approvedRow(scenario.row);
    let { operations, state } = harness(scenario, { row: approved });
    await assert.rejects(() => operations.publishApproved([ids.review], ["a".repeat(64)]), /HUMAN_REVIEW_PACKAGE_IDENTITY_OR_HASH_STALE/);
    ({ operations, state } = harness(scenario, { row: scenario.row }));
    await assert.rejects(() => operations.publishApproved([ids.review], [scenario.packageSha256]), /HUMAN_REVIEW_STATUS_NOT_ALLOWED:WAITING_FOR_HUMAN_REVIEW/);
    for (const field of ["facts_acceptable", "attribution_acceptable", "uncertainty_preserved", "headline_acceptable", "summary_acceptable", "no_unsupported_material_claims", "source_chain_acceptable", "reviewer_approved"]) {
      ({ operations, state } = harness(scenario, { row: { ...approved, [field]: false } }));
      await assert.rejects(() => operations.publishApproved([ids.review], [scenario.packageSha256]), /HUMAN_APPROVAL_REQUIRED/, field);
      // Same order as the CLI always had: the per-review authorization is checked under the lease, which is then failed and released.
      assert.equal(state.publishCalls.length, 0, field);
      assert.equal(state.finishCalls.at(-1).runStatus, "failed", field);
      assert.equal(state.releaseCalls.length, 1, field);
    }
    ({ operations, state } = harness(scenario, { row: { ...approved, critic_pass: false } }));
    await assert.rejects(() => operations.publishApproved([ids.review], [scenario.packageSha256]), /HUMAN_APPROVAL_REQUIRED/);
    ({ operations, state } = harness(scenario, { row: { ...approved, consumed_at: "2026-10-21T10:00:00Z" } }));
    await assert.rejects(() => operations.publishApproved([ids.review], [scenario.packageSha256]), /HUMAN_APPROVAL_REQUIRED/);
    assert.equal(state.publishCalls.length, 0);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("the two-per-UTC-day cap and the id/hash pairing rules apply to every publication", async () => {
  const scenario = await buildReviewScenario();
  try {
    const approved = approvedRow(scenario.row);
    let { operations, state } = harness(scenario, { row: approved, publishedToday: 2 });
    await assert.rejects(() => operations.publishApproved([ids.review], [scenario.packageSha256]), /HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT_REACHED/);
    assert.equal(state.acquireCalls.length, 0);
    ({ operations, state } = harness(scenario, { row: approved, publishedToday: 0 }));
    const other = "99999999-9999-4999-8999-999999999999";
    await assert.rejects(() => operations.publishApproved([ids.review, other, ids.revision], [scenario.packageSha256, scenario.packageSha256, scenario.packageSha256]), /PUBLISH_APPROVED_REQUIRES_ONE_OR_TWO_DISTINCT_ID_HASH_PAIRS/);
    await assert.rejects(() => operations.publishApproved([ids.review, ids.review], [scenario.packageSha256, scenario.packageSha256]), /PUBLISH_APPROVED_REQUIRES_ONE_OR_TWO_DISTINCT_ID_HASH_PAIRS/);
    await assert.rejects(() => operations.publishApproved([ids.review], [scenario.packageSha256, scenario.packageSha256]), /PUBLISH_APPROVED_REQUIRES_ONE_OR_TWO_DISTINCT_ID_HASH_PAIRS/);
    await assert.rejects(() => operations.publishApproved([], []), /HUMAN_REVIEW_ID_MUST_BE_UUID|PUBLISH_APPROVED_REQUIRES/);
    ({ operations, state } = harness(scenario, { row: approved, publishedToday: 1 }));
    await assert.rejects(() => operations.publishApproved([ids.review, other], [scenario.packageSha256, scenario.packageSha256]), /HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT_REACHED/);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("a lease that is not acquired blocks publication; a failed publication marks the lease failed and still releases it", async () => {
  const scenario = await buildReviewScenario();
  try {
    const approved = approvedRow(scenario.row);
    let { operations, state } = harness(scenario, { row: approved, lease: { status: "busy" } });
    await assert.rejects(() => operations.publishApproved([ids.review], [scenario.packageSha256]), /HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT_OR_MUTEX:busy/);
    assert.equal(state.publishCalls.length, 0);
    ({ operations, state } = harness(scenario, { row: approved, publishFails: true }));
    await assert.rejects(() => operations.publishApproved([ids.review], [scenario.packageSha256]), /publication_failed/);
    assert.equal(state.finishCalls.at(-1).runStatus, "failed");
    assert.equal(state.finishCalls.at(-1).stopReason, "HUMAN_REVIEW_PUBLICATION_FAILED");
    assert.equal(state.releaseCalls.length, 1);
  } finally { await rm(scenario.base, { recursive: true, force: true }); }
});

test("the CLI delegates to the shared module instead of keeping its own copy of the rules", async () => {
  const cli = await readFile("scripts/pipeline-human-review.ts", "utf8");
  assert.match(cli, /createHumanReviewOperations/);
  assert.match(cli, /\.decide\(/);
  assert.match(cli, /\.publishApproved\(/);
  for (const forbidden of ["assertHumanReviewPublicationAuthorization", "assertDailyHumanReviewPublicationLimit", "scheduler.acquire", "assertCurrentCheckpoints(artifact:"]) {
    assert.equal(cli.includes(forbidden), false, `${forbidden} must live in the shared module only`);
  }
  const shared = await readFile("lib/agents/publisher/human-review-operations.ts", "utf8");
  for (const required of ["assertDailyHumanReviewPublicationLimit", "assertHumanReviewPublicationAuthorization", "supervised-human-review-publish:", "HUMAN_REVIEW_CHECKPOINT_STALE", "HUMAN_REVIEW_PACKAGE_IDENTITY_OR_HASH_STALE"]) {
    assert.ok(shared.includes(required), required);
  }
});
