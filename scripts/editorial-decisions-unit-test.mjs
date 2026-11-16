// Panel decisions: form parsing, feature flags, safe error codes, execution through the shared operations,
// secondary queues and the static security properties of the endpoint. Doubles only; no database, no network.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import {
  EDITORIAL_CHECK_LABELS, EDITORIAL_DECISION_MESSAGES, isEditorialDecisionEnabled, isEditorialDecisionOutcome,
  mapEditorialDecisionError, parseEditorialDecisionForm,
} from "../lib/editorial/decision-policy.ts";
import { executeEditorialDecision } from "../lib/editorial/decision-service.ts";
import { humanReviewCheckNames } from "../lib/agents/publisher/human-review-operations.ts";
import { mapM32Review } from "../lib/editorial/live-mapping.ts";
import { listActionableQueuesWith, loadWaitingEditorialReviewsWith } from "../lib/editorial/live-service.ts";
import { toReviewSummary } from "../lib/editorial/review.ts";
import { approvedRow, buildReviewScenario, ids } from "./editorial-test-support.mjs";

const sha = "a".repeat(64);
const decisionForm = (patch = {}, drop = []) => {
  const entries = { action: "approve", review_id: ids.review, package_sha256: sha, confirm: "yes",
    ...Object.fromEntries(humanReviewCheckNames.map((name) => [`check_${name}`, "pass"])), ...patch };
  for (const key of drop) delete entries[key];
  return new URLSearchParams(entries);
};
const code = (form) => { const result = parseEditorialDecisionForm(form); assert.equal(result.ok, false); return result.code; };

test("decisions need BOTH explicit flags to be exactly 'true'", () => {
  assert.equal(isEditorialDecisionEnabled("true", "true"), true);
  for (const [decisions, live] of [[undefined, "true"], ["true", undefined], ["true", "false"], ["false", "true"], ["1", "true"], ["TRUE", "true"], [" true", "true"], ["", ""]]) {
    assert.equal(isEditorialDecisionEnabled(decisions, live), false, `${decisions}/${live}`);
  }
});

test("a valid decision form yields a strict command; unticked checks are explicit failures", () => {
  const ok = parseEditorialDecisionForm(decisionForm());
  assert.equal(ok.ok, true);
  assert.equal(ok.command.action, "approve");
  assert.equal(ok.command.reviewId, ids.review);
  assert.equal(ok.command.expectedPackageSha256, sha);
  assert.deepEqual(Object.keys(ok.command.checks), [...humanReviewCheckNames]);
  assert.ok(Object.values(ok.command.checks).every((value) => value === true));
  const partial = parseEditorialDecisionForm(decisionForm({ action: "hold" }, ["check_facts", "check_headline"]));
  assert.equal(partial.ok, true);
  assert.equal(partial.command.checks.facts, false);
  assert.equal(partial.command.checks.headline, false);
  assert.equal(partial.command.checks.summary, true);
  const revision = parseEditorialDecisionForm(decisionForm({ revision_sha256: "b".repeat(64) }));
  assert.equal(revision.command.expectedRevisionSha256, "b".repeat(64));
});

test("decision forms reject anything outside the strict shape", () => {
  assert.equal(code(decisionForm({ action: "delete" })), "invalid");
  assert.equal(code(decisionForm({}, ["action"])), "invalid");
  assert.equal(code(decisionForm({ review_id: "not-a-uuid" })), "invalid_id");
  assert.equal(code(decisionForm({}, ["review_id"])), "invalid_id");
  assert.equal(code(decisionForm({ package_sha256: "short" })), "invalid_hash");
  assert.equal(code(decisionForm({ package_sha256: "A".repeat(64) })), "invalid_hash");
  assert.equal(code(decisionForm({ revision_sha256: "zz" })), "invalid_hash");
  assert.equal(code(decisionForm({}, ["confirm"])), "not_confirmed");
  assert.equal(code(decisionForm({ confirm: "on" })), "not_confirmed");
  assert.equal(code(decisionForm({ check_facts: "yes" })), "invalid");
  assert.equal(code(decisionForm({ reviewer: "someone@else.org" })), "invalid", "the reviewer is never taken from the form");
  const duplicated = decisionForm();
  duplicated.append("review_id", "99999999-9999-4999-8999-999999999999");
  assert.equal(code(duplicated), "invalid");
});

test("publish forms accept one or two distinct id:hash pairs and need confirmation", () => {
  const publish = (items, extra = {}) => {
    const form = new URLSearchParams({ action: "publish", ...extra });
    for (const item of items) form.append("item", item);
    return form;
  };
  const other = "99999999-9999-4999-8999-999999999999";
  const parsed = parseEditorialDecisionForm(publish([`${ids.review}:${sha}`, `${other}:${"b".repeat(64)}`], { confirm: "yes" }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.command.items, [{ reviewId: ids.review, expectedPackageSha256: sha }, { reviewId: other, expectedPackageSha256: "b".repeat(64) }]);
  assert.equal(code(publish([], { confirm: "yes" })), "invalid_selection");
  assert.equal(code(publish([`${ids.review}:${sha}`, `${other}:${sha}`, `${ids.run}:${sha}`], { confirm: "yes" })), "invalid_selection");
  assert.equal(code(publish([`${ids.review}:${sha}`, `${ids.review}:${sha}`], { confirm: "yes" })), "invalid_selection");
  assert.equal(code(publish([`${ids.review}:${sha}`])), "not_confirmed");
  assert.equal(code(publish(["not-a-uuid:" + sha], { confirm: "yes" })), "invalid_id");
  assert.equal(code(publish([`${ids.review}:xyz`], { confirm: "yes" })), "invalid_hash");
  assert.equal(code(publish([`${ids.review}:${sha}:extra`], { confirm: "yes" })), "invalid_id");
  assert.equal(code(publish([`${ids.review}:${sha}`], { confirm: "yes", package_sha256: sha })), "invalid");
});

test("errors become stable outcome codes and raw messages never reach the UI", () => {
  const cases = {
    HUMAN_REVIEW_PACKAGE_IDENTITY_OR_HASH_STALE: "stale", "HUMAN_REVIEW_CHECKPOINT_STALE:editor": "stale", HUMAN_REVIEW_APPROVAL_REVISION_HASH_STALE: "stale",
    HUMAN_APPROVAL_REQUIRED: "stale", HUMAN_APPROVAL_REQUIRES_ALL_SEVEN_CHECKS_TO_PASS: "checks_required",
    HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT_REACHED: "daily_limit", "HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT_OR_MUTEX:busy": "daily_limit",
    "HUMAN_REVIEW_STATUS_NOT_ALLOWED:PUBLISHED": "status", HUMAN_REVIEW_DECISION_NOT_ALLOWED: "status", "HUMAN_REVIEW_NOT_APPROVED:HOLD": "status",
    HUMAN_REVIEW_NOT_FOUND: "not_found", "relation \"secret_table\" row 42 leaked": "error", "": "error",
  };
  for (const [message, expected] of Object.entries(cases)) assert.equal(mapEditorialDecisionError(new Error(message)), expected, message);
  assert.equal(mapEditorialDecisionError(Object.assign(new Error("ENOENT: no such file C:\\secret\\path"), { code: "ENOENT" })), "package_unavailable");
  assert.equal(mapEditorialDecisionError("not an error"), "error");
  for (const outcome of Object.keys(EDITORIAL_DECISION_MESSAGES)) {
    assert.equal(isEditorialDecisionOutcome(outcome), true);
    assert.doesNotMatch(EDITORIAL_DECISION_MESSAGES[outcome].text, /HUMAN_|ENOENT|C:\\/);
  }
  assert.equal(isEditorialDecisionOutcome("__proto__"), false);
  assert.deepEqual(Object.keys(EDITORIAL_CHECK_LABELS), [...humanReviewCheckNames]);
});

test("execution goes through the shared operations with the session operator as reviewer", async () => {
  const calls = [];
  const operations = {
    async decide(input) { calls.push(["decide", input]); return { reviewId: input.reviewId, status: "x" }; },
    async publishApproved(ids, hashes) { calls.push(["publish", ids, hashes]); return []; },
  };
  const parsed = parseEditorialDecisionForm(decisionForm({ revision_sha256: "b".repeat(64) }));
  assert.equal(await executeEditorialDecision(parsed.command, "operator@example.org", operations), "approved");
  assert.equal(calls[0][1].reviewerId, "operator@example.org");
  assert.equal(calls[0][1].decision, "APPROVE");
  assert.equal(calls[0][1].expectedRevisionSha256, "b".repeat(64));
  assert.equal(calls[0][1].checks.factsAcceptable, true);
  const hold = parseEditorialDecisionForm(decisionForm({ action: "hold", revision_sha256: "b".repeat(64) }));
  assert.equal(await executeEditorialDecision(hold.command, "operator@example.org", operations), "held");
  assert.equal(calls[1][1].expectedRevisionSha256, undefined, "only an approval consumes the revision hash");
  const reject = parseEditorialDecisionForm(decisionForm({ action: "reject" }));
  assert.equal(await executeEditorialDecision(reject.command, "operator@example.org", operations), "rejected");
  const publish = new URLSearchParams({ action: "publish", confirm: "yes" });
  publish.append("item", `${ids.review}:${sha}`);
  assert.equal(await executeEditorialDecision(parseEditorialDecisionForm(publish).command, "operator@example.org", operations), "published");
  assert.deepEqual(calls[3].slice(1), [[ids.review], [sha]]);
  const failing = { decide: async () => { throw new Error("HUMAN_REVIEW_PACKAGE_IDENTITY_OR_HASH_STALE"); }, publishApproved: async () => { throw new Error("HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT_REACHED"); } };
  assert.equal(await executeEditorialDecision(parsed.command, "operator@example.org", failing), "stale");
  assert.equal(await executeEditorialDecision(parseEditorialDecisionForm(publish).command, "operator@example.org", failing), "daily_limit");
});

test("secondary queues list HOLD and APPROVED only, never consumed ones, and degrade per review", async () => {
  const scenario = await buildReviewScenario();
  try {
    const held = { ...scenario.row, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "HOLD" };
    const approved = approvedRow(scenario.row);
    const broken = { ...scenario.row, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "APPROVED", attempt_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    const rows = [
      { ...scenario.row }, // waiting: not part of the secondary queues
      approved, // APPROVED with a valid package
      { ...approvedRow(scenario.row), id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", consumed_at: "2026-10-21T10:00:00Z" },
      broken,
    ];
    const dependencies = {
      repository: { async status() { return {}; }, async list() { return { reviews: rows, publishedToday: 1, returned: rows.length, limit: 500 }; }, async inspect() { throw new Error("unused"); } },
      async readArtifact(row) { if (row.id === broken.id) throw new Error("missing package"); return scenario.artifact; },
      async readRevision() { throw new Error("unused"); },
    };
    const result = await listActionableQueuesWith(dependencies);
    assert.equal(result.publishedToday, 1);
    assert.deepEqual(result.reviews.map((review) => review.reviewStatus), ["APPROVED"]);
    assert.equal(result.reviews[0].packageSha256, scenario.packageSha256);
    assert.equal(result.reviews[0].selectionReason, scenario.artifact.reviewEvidence.ranking.rankReason);
    assert.deepEqual(result.unavailable.map((entry) => entry.reviewId), [broken.id]);
    assert.equal(JSON.stringify(result.unavailable).includes("headline"), false, "unavailable entries expose no content");
    void held;
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("the digest loader returns the full DTO of every pending review and fails closed", async () => {
  const scenario = await buildReviewScenario();
  try {
    const dependencies = {
      repository: { async status() { return {}; }, async list() { return { reviews: [scenario.row, { ...scenario.row, status: "HOLD" }], publishedToday: 1, returned: 2, limit: 500 }; }, async inspect() { throw new Error("unused"); } },
      async readArtifact() { return scenario.artifact; }, async readRevision() { throw new Error("unused"); },
    };
    const loaded = await loadWaitingEditorialReviewsWith(dependencies);
    assert.equal(loaded.publishedToday, 1);
    assert.equal(loaded.reviews.length, 1);
    assert.equal(loaded.reviews[0].evidence.ranking.importanceScore, 74.45);
    await assert.rejects(() => loadWaitingEditorialReviewsWith({ ...dependencies, async readArtifact() { throw new Error("secret detail"); } }), (error) => error.code === "M32_UNAVAILABLE" && !/secret/.test(error.message));
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("real pipeline evidence is copied, source names resolved, and nothing is invented when it is absent", async () => {
  const scenario = await buildReviewScenario();
  try {
    const { review } = mapM32Review(scenario.row, scenario.artifact);
    const evidence = review.evidence;
    assert.equal(review.packageSha256, scenario.packageSha256);
    assert.equal(evidence.ranking.importanceScore, 74.45);
    assert.equal(evidence.ranking.impact, 74);
    assert.equal(evidence.ranking.credibility, 88);
    assert.equal(evidence.ranking.rankReason, scenario.artifact.reviewEvidence.ranking.rankReason);
    assert.equal(evidence.verification.status, "confirmed");
    assert.deepEqual(evidence.verification.verifiedFacts[0].sources, ["Example Tech Journal"]);
    assert.deepEqual(evidence.verification.uncertainClaims[0].sources, ["Second Source Weekly"]);
    assert.equal(evidence.verification.contradictions.length, 1);
    assert.equal(evidence.critic.decision, "pass");
    assert.equal(toReviewSummary(review).selectionReason, evidence.ranking.rankReason);
    // A package whose evidence block is incomplete yields NO evidence rather than defaults.
    const incomplete = structuredClone(scenario.artifact);
    delete incomplete.reviewEvidence.verifier;
    const mapped = mapM32Review(scenario.row, incomplete).review;
    assert.equal(mapped.evidence, undefined);
    assert.equal(toReviewSummary(mapped).selectionReason, null);
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("the decision endpoint is origin-checked, authenticated, flag-gated, strictly parsed and never trusts the form for identity", () => {
  const route = readFileSync("app/editorial/(workspace)/decisiones/route.ts", "utf8");
  const order = ["isSameOriginAuthPost", "await requireEditorialOperator()", "isEditorialDecisionEnabled", "readSmallForm(request)", "parseEditorialDecisionForm", "executeEditorialDecision"].map((marker) => route.indexOf(marker, route.indexOf("export async function POST")));
  assert.ok(order.every((index) => index > 0), "all steps present");
  assert.deepEqual([...order].sort((left, right) => left - right), order, "same-origin, operator, flags, parse, execute — in that order");
  assert.match(route, /operator\.email/);
  assert.doesNotMatch(route, /form\.get\("(reviewer|operator|email)"\)/);
  assert.doesNotMatch(route, /NEXT_PUBLIC|SUPABASE_SECRET_KEY|\.rpc\(/, "the route never touches credentials or RPCs directly");
  assert.match(route, /Cache-Control": "private, no-store/);
  assert.match(route, /redirect\(url, 303\)/);
  const proxy = readFileSync("proxy.ts", "utf8");
  assert.match(proxy, /matcher: \["\/editorial\/:path\*"/);
  const factory = readFileSync("lib/editorial/review-operations.ts", "utf8");
  assert.match(factory, /^import "server-only"/);
});

test("decision UI is server-rendered, carries no secrets and has no privileged imports", () => {
  for (const path of ["components/editorial/review-decision-panel.tsx", "components/editorial/review-queues.tsx", "components/editorial/review-evidence.tsx"]) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /^"use client"/, path);
    assert.doesNotMatch(source, /SUPABASE|createSupabaseServerClient|\.rpc\(|process\.env/, path);
  }
  const panel = readFileSync("components/editorial/review-decision-panel.tsx", "utf8");
  assert.match(panel, /action="\/editorial\/decisiones"|DECISION_ACTION = "\/editorial\/decisiones"/);
  assert.match(panel, /humanReviewCheckNames\.map/);
  assert.match(panel, /disabled=\{!enabled \|\| blocked\}/, "a blocked review cannot be approved from the panel");
  const withdrawal = readFileSync("app/editorial/(workspace)/publicadas/withdraw/route.ts", "utf8");
  assert.match(withdrawal, /isWithdrawalEnabled\(process\.env\.EDITORIAL_WITHDRAWAL_ENABLED\)/, "hiding a published article keeps its own flag, audit trail and restore path");
  const example = readFileSync(".env.example", "utf8");
  assert.match(example, /^EDITORIAL_DECISIONS_ENABLED=false$/m);
  assert.doesNotMatch(example, /NEXT_PUBLIC_EDITORIAL/);
});
