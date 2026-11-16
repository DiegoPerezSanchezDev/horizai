import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { editorialFixtures } from "../lib/editorial/fixtures.ts";
import { editorialReviewSchema, isWaitingReview, toReviewSummary, getExpectedApproval } from "../lib/editorial/review.ts";
import { canAccessEditorialFixtures } from "../lib/editorial/access-policy.ts";
import { editorialNotificationDedupeKey, getEditorialNotificationEligibility, prepareEditorialNotification } from "../lib/editorial/notifications.ts";
import { inspectEditorialNotificationCapability, isEditorialNotificationTarget, openEditorialNotificationTarget } from "../lib/editorial/notification-client.ts";

const [normal, blocked, corrected] = editorialFixtures;
const state = { deliveredDedupeKeys: [], reservedDedupeKeys: [] };
const eligible = (review, options) => getEditorialNotificationEligibility(review, state, options);

test("strict operator DTO rejects raw internals and unsafe sources", () => {
  for (const review of editorialFixtures) assert.deepEqual(editorialReviewSchema.parse(review), review);
  for (const field of ["providerPrompts", "reasoning", "serviceRoleKey", "checkpoint", "rawSourceBody"]) {
    assert.equal(editorialReviewSchema.safeParse({ ...normal, [field]: "must-not-serialize" }).success, false);
  }
  assert.equal(editorialReviewSchema.safeParse({ ...normal, sources: [{ ...normal.sources[0], url: "javascript:alert(1)" }] }).success, false);
  assert.equal(editorialReviewSchema.safeParse({ ...normal, approvalTargetSha256: "bad" }).success, false);
  assert.equal(editorialReviewSchema.safeParse({ ...normal, humanRevisionId: "unexpected-revision" }).success, false);
  assert.equal(editorialReviewSchema.safeParse({ ...corrected, humanRevisionId: null }).success, false);
});

test("inbox omits bodies and identity hashes, filters consumed and nonwaiting reviews", () => {
  const rows = [normal, { ...normal, reviewId: "consumed", consumed: true },
    ...["HOLD", "APPROVED", "REJECTED", "PUBLISHING", "PUBLISHED"].map((reviewStatus) => ({ ...normal, reviewId: reviewStatus, reviewStatus }))];
  assert.deepEqual(rows.filter(isWaitingReview).map(toReviewSummary).map((review) => review.reviewId), [normal.reviewId]);
  assert.deepEqual([].filter(isWaitingReview).map(toReviewSummary), []);
  const summary = toReviewSummary(normal);
  assert.equal(summary.sourceCount, 2);
  assert.equal(summary.primarySource, normal.sources[0].publisher);
  for (const field of ["body", "approvalTargetSha256", "sourceLineageSha256", "attemptId"]) assert.equal(field in summary, false);
  assert.equal(toReviewSummary({ ...normal, sources: [] }).primarySource, null);
});

test("eligibility requires each proven gate, never a guessed score", () => {
  assert.equal(normal.rankerScore, null);
  assert.equal(eligible(normal).eligible, true);
  assert.deepEqual(eligible(null).reasons, ["REVIEW_MISSING"]);
  for (const reviewStatus of ["HOLD", "APPROVED", "REJECTED", "PUBLISHING", "PUBLISHED"]) {
    assert.deepEqual(eligible({ ...normal, reviewStatus }).reasons, ["NOT_WAITING"]);
  }
  assert.deepEqual(eligible({ ...normal, consumed: true }).reasons, ["CONSUMED"]);
  for (const [field, reason] of [["criticProofStatus", "CRITIC_PROOF_REQUIRED"], ["m34Status", "M34_REQUIRED"], ["sourceLineageStatus", "SOURCE_LINEAGE_REQUIRED"]]) {
    for (const value of ["FAIL", "UNKNOWN", undefined]) assert.deepEqual(eligible({ ...normal, [field]: value }).reasons, [reason]);
  }
  assert.equal(eligible(blocked).eligible, false);
  assert.equal(eligible(corrected).eligible, true);
  assert.ok(eligible({ ...normal, approvalTargetSha256: "" }).reasons.includes("INVALID_TARGET"));
  assert.ok(eligible({ ...corrected, humanRevisionId: null }).reasons.includes("INVALID_TARGET"));
});

test("optional future quality threshold is explicit and fails closed", () => {
  assert.deepEqual(eligible(normal, { minimumEditorialQuality: 50 }).reasons, ["QUALITY_THRESHOLD_NOT_MET"]);
  assert.equal(eligible({ ...normal, rankerScore: 60 }, { minimumEditorialQuality: 50 }).eligible, true);
  assert.equal(eligible({ ...normal, rankerScore: 49 }, { minimumEditorialQuality: 50 }).eligible, false);
  assert.equal(eligible(normal, { minimumEditorialQuality: Number.NaN }).eligible, false);
});

test("dedupe is stable across polls and copy changes, sensitive to revision, hash and lineage", () => {
  const key = editorialNotificationDedupeKey(normal);
  assert.equal(editorialNotificationDedupeKey({ ...normal, headline: "New title", createdAt: "2026-10-22T00:00:00Z" }), key);
  for (const patch of [{ reviewId: "other" }, { approvalTargetSha256: "e".repeat(64) },
    { sourceLineageSha256: "e".repeat(64) }, { approvalTarget: "HUMAN_REVISION", humanRevisionId: "revision-3" }]) {
    assert.notEqual(editorialNotificationDedupeKey({ ...normal, ...patch }), key);
  }
  for (const field of ["deliveredDedupeKeys", "reservedDedupeKeys"]) {
    assert.deepEqual(getEditorialNotificationEligibility(normal, { ...state, [field]: [key] }).reasons, ["ALREADY_NOTIFIED"]);
  }
  const delivered = { ...state, deliveredDedupeKeys: [key] };
  for (let poll = 0; poll < 5; poll++) assert.equal(getEditorialNotificationEligibility(normal, delivered).eligible, false);
});

test("stale approval representation retains original and corrected expected identities", () => {
  const first = getExpectedApproval(normal);
  const revision = getExpectedApproval(corrected);
  assert.equal(first.humanRevisionId, null);
  assert.equal(first.expectedApprovalTargetSha256, normal.approvalTargetSha256);
  assert.equal(revision.humanRevisionId, corrected.humanRevisionId);
  assert.equal(revision.approvalTarget, "HUMAN_REVISION");
  assert.equal(revision.expectedSourceLineageSha256, corrected.sourceLineageSha256);
  const next = getExpectedApproval({ ...corrected, approvalTargetSha256: "e".repeat(64), humanRevisionId: "revision-3" });
  assert.notDeepEqual(revision, next);
  assert.equal(revision.expectedApprovalTargetSha256, corrected.approvalTargetSha256);
  assert.equal(revision.expectedReviewStatus, "WAITING_FOR_HUMAN_REVIEW");
  assert.equal(revision.expectedConsumed, false);
});

test("notification payload is minimal and is never prepared for ineligible/delivered data", () => {
  const payload = prepareEditorialNotification(normal, "2026-10-21T09:00:00Z", state);
  assert.equal(payload.targetPath, "/editorial/reviews/demo-madrid");
  assert.equal(payload.status, "PREPARED");
  assert.deepEqual(Object.keys(payload).sort(), ["notificationId", "reviewId", "headline", "shortReason", "createdAt", "status", "targetPath", "dedupeKey"].sort());
  assert.equal(prepareEditorialNotification(blocked, payload.createdAt, state), null);
  assert.equal(prepareEditorialNotification(normal, "invalid", state), null);
  assert.equal(prepareEditorialNotification(normal, payload.createdAt, { ...state, deliveredDedupeKeys: [payload.dedupeKey] }), null);
});

test("fixture access fails closed outside local development", () => {
  for (const env of ["production", "test", undefined, ""]) {
    for (const host of ["localhost:3016", "127.0.0.1", "[::1]:3016", null]) assert.equal(canAccessEditorialFixtures(env, host), false);
  }
  for (const host of ["localhost:3016", "127.0.0.1:3016", "[::1]:3016"]) assert.equal(canAccessEditorialFixtures("development", host), true);
  for (const host of [null, "", "horizai.com", "localhost.attacker.test", "localhost@attacker.test", "127.0.0.2", "localhost:3016/path"]) assert.equal(canAccessEditorialFixtures("development", host), false);
});

test("fixture adapter guards before loading examples and live reads stay in a separate read-only server boundary", () => {
  const source = readFileSync("lib/editorial/data.ts", "utf8");
  assert.match(source, /^import "server-only"/);
  assert.ok(source.indexOf("await requireEditorialDevelopmentAccess()") < source.indexOf('await import("./fixtures.ts")'));
  assert.match(source, /filter\(isWaitingReview\)\.map\(toReviewSummary\)/);
  assert.doesNotMatch(source, /createSupabase|\.rpc\(|fetch\(|process\.env|live:/);
  const guard = readFileSync("lib/editorial/access.ts", "utf8");
  assert.match(guard, /NODE_ENV !== "development"\) notFound\(\)/);
  const proxy = readFileSync("proxy.ts", "utf8");
  assert.match(proxy, /matcher: \["\/editorial\/:path\*", "\/api\/editorial\/:path\*"\]/);
  assert.match(proxy, /await resolveEditorialOperator/);
  assert.match(guard, /await requireEditorialOperator\(\)/);
  for (const file of ["access-policy.ts", "review.ts", "notifications.ts", "notification-client.ts"]) {
    const text = readFileSync(`lib/editorial/${file}`, "utf8");
    assert.doesNotMatch(text, /from ["'][^"']*(?:agents|supabase)|fetch\(|\.rpc\(|requestPermission\(|\.subscribe\(|serviceWorker\.register\(/, file);
  }
  const live = readFileSync("lib/editorial/live-data.ts", "utf8");
  assert.match(live, /^import "server-only"/);
  assert.match(live, /await requireEditorialOperator\(\)/);
  assert.doesNotMatch(live, /create_pipeline_human_review|bind_pipeline_human_review_revision|decide_pipeline_human_review|publish_reviewed_article_atomic/);
  const actions = readFileSync("components/editorial/review-actions.tsx", "utf8");
  assert.match(actions, /disabled aria-describedby="ed-confirm-disabled"/);
  assert.doesNotMatch(actions, /fetch\(|use server|\.rpc\(|formAction|action=|onSubmit/);
});

test("notification client is SSR safe and rejects external or unrelated targets", async () => {
  assert.deepEqual(await inspectEditorialNotificationCapability(), { secureContext: false, supported: false, permission: "unsupported", subscription: "unsupported" });
  assert.equal(isEditorialNotificationTarget("/editorial/reviews/demo-madrid"), true);
  for (const path of ["//evil.test", "https://evil.test/editorial/reviews/a", "/editorial/reviews/a/../../", "/editorial", "/editorial/reviews/a?next=evil", "javascript:alert(1)"]) assert.equal(isEditorialNotificationTarget(path), false);
  assert.equal(openEditorialNotificationTarget("/editorial/reviews/demo-madrid"), false);
});

test("discovery and metadata never expose editorial content", () => {
  const metadata = readFileSync("app/editorial/layout.tsx", "utf8");
  assert.match(metadata, /index: false, follow: false/);
  assert.doesNotMatch(metadata, /review\.headline|generateMetadata/);
  assert.match(readFileSync("next.config.ts", "utf8"), /X-Robots-Tag/);
  assert.match(readFileSync("app/robots.ts", "utf8"), /"\/editorial"/);
  assert.doesNotMatch(readFileSync("app/sitemap.ts", "utf8"), /editorial/);
  for (const path of ["components/hero/hero-header.tsx", "components/footer/site-footer.tsx"]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /["']\/editorial/);
  }
});
