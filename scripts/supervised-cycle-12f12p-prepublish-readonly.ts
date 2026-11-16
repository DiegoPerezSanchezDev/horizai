import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { SupabaseHumanReviewRepository } from "../lib/agents/publisher/human-review-repository.ts";
import { humanReviewSourceLineageSha256 } from "../lib/agents/publisher/human-review-source-lineage-hash.ts";
import { readHumanReviewArtifact } from "../lib/agents/publisher/human-review.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { canonicalJsonString } from "../lib/agents/pipeline/factual-remediation-continuation.ts";

const target = {
  reviewId: "ebd8acc0-76a2-4977-81d9-60a7f6240084",
  revisionId: "6fd9fae7-dbc6-4e13-abba-c4c6dfca38d9",
  attemptId: "4658d5c0-857c-4ed5-b97f-afb133b2bf22",
  pipelineRunId: "f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d",
  correctedSha256: "69f0d3e350621f86c69a72d2cb1cbf1cb390212d695f932eedb03d325ade2045",
  headline: "CERT-In informa de accesos de agentes de IA durante evaluaciones en India",
};

const supabase = createSupabaseServerClient();
const reads = new SupabaseHumanReviewReadRepository(supabase);
const inspection = await reads.inspect(target.reviewId);
assert.equal(inspection.found, true);
const review = inspection.review!;
assert.deepEqual([
  review.id, review.status, review.consumed_at, review.action, review.reviewer_approved,
  review.approval_target_kind, review.approval_target_revision_id,
  review.approval_target_revision_sha256, review.approved_revision_sha256,
  review.source_lineage_sha256, review.attempt_id, review.pipeline_run_id,
], [
  target.reviewId, "APPROVED", null, "APPROVE", true, "HUMAN_REVISION", target.revisionId,
  target.correctedSha256, target.correctedSha256,
  "42c5de597f333d80c31d634f61960181d7f5480201237b9f447d37b651d968dc",
  target.attemptId, target.pipelineRunId,
]);

const artifact = await readHumanReviewArtifact("artifacts/human-review-packages", target.attemptId);
const revision = await new SupabaseHumanReviewRepository(supabase).getRevision(target.reviewId);
assert.equal(revision.id, target.revisionId);
assert.equal(revision.corrected_revision_sha256, target.correctedSha256);
assert.equal(revision.original_draft_sha256, artifact.draftSha256);
assert.equal(revision.automated_critic_draft_sha256, artifact.draftSha256);
assert.equal(revision.source_lineage_sha256, humanReviewSourceLineageSha256(artifact.sourceLineage));
assert.deepEqual(revision.original_draft, artifact.draft);
assert.deepEqual(revision.original_publication_payload, artifact.publicationPayload);
const payload = revision.corrected_publication_payload;
assert.equal(payload.article.headlineEs, target.headline);
assert.equal(payload.article.headlineEs, revision.corrected_draft.headlineEs);
assert.equal(payload.article.summaryEs, revision.corrected_draft.summaryEs);
assert.equal(payload.article.whyItMattersEs, revision.corrected_draft.whyItMattersEs);
assert.equal(payload.article.bodyEs, revision.corrected_draft.bodyEs);
assert.deepEqual(payload.sources, artifact.publicationPayload.sources);
assert.equal(canonicalJsonString({
  headlineEs: payload.article.headlineEs, dekEs: payload.article.dekEs,
  summaryEs: payload.article.summaryEs, whyItMattersEs: payload.article.whyItMattersEs,
  bodyEs: payload.article.bodyEs, keyPoints: payload.article.keyPoints,
}), canonicalJsonString(revision.corrected_draft));
assert.notEqual(review.approved_revision_sha256, review.draft_sha256);

const status = await reads.status();
assert.deepEqual([status.totalReviews, status.waitingReviews, status.approvedReviews,
  status.consumedReviews, status.publishedReviews, status.publishedToday], [1, 0, 1, 0, 0, 0]);
const reviews = await reads.list(500);
assert.equal(reviews.reviews.length, 1, "no duplicate review");
const publicResponse = await supabase.from("articles").select("*").eq("publication_status", "published");
assert.equal(publicResponse.error, null);
const publicRows = publicResponse.data ?? [];
assert.equal(publicRows.length, 2);
const publicFingerprints = publicRows.map((row) => ({ id: row.id, sha256: publicArticleFingerprintV1(row) }))
  .sort((a, b) => a.id.localeCompare(b.id));
const prior = JSON.parse(readFileSync("artifacts/supervised-cycle-12f12j-after.json", "utf8")) as {
  fingerprints: typeof publicFingerprints;
};
assert.deepEqual(publicFingerprints, prior.fingerprints);

const providerAccounting = artifact.reviewEvidence.providerAccounting;
const cumulativeProviderRequests = Object.values(providerAccounting).reduce((sum, value) => sum + value.requestCount, 0);
const providerTokenTotals = Object.values(providerAccounting).map((value) => value.totalTokens);
assert.ok(providerTokenTotals.every((value): value is number => typeof value === "number"), "PROVIDER_TOKEN_TOTALS_MUST_BE_KNOWN");
const cumulativeProviderTokens = providerTokenTotals.reduce((sum, value) => sum + value, 0);
assert.deepEqual([cumulativeProviderRequests, cumulativeProviderTokens], [6, 10792]);

console.log(JSON.stringify({
  status: "PREPUBLISH_PASS",
  reviewId: review.id,
  decision: review.action,
  reviewStatus: review.status,
  consumed: review.consumed_at !== null,
  approvalTargetKind: review.approval_target_kind,
  approvedRevisionId: review.approval_target_revision_id,
  approvedRevisionSha256: review.approved_revision_sha256,
  draftSha256: review.draft_sha256,
  sourceLineageSha256: review.source_lineage_sha256,
  packageIntegrity: "PASS",
  currentCheckpoints: "PASS",
  originalDraftPreserved: canonicalJsonString(revision.original_draft) === canonicalJsonString(artifact.draft),
  publisherPayload: {
    selection: "CORRECTED_HUMAN_REVISION",
    revisionId: revision.id,
    correctedSha256: revision.corrected_revision_sha256,
    headline: payload.article.headlineEs,
    summaryMatchesRevision: payload.article.summaryEs === revision.corrected_draft.summaryEs,
    whyItMattersMatchesRevision: payload.article.whyItMattersEs === revision.corrected_draft.whyItMattersEs,
    bodyMatchesRevision: payload.article.bodyEs === revision.corrected_draft.bodyEs,
    sourceSetMatchesReviewedPackage: canonicalJsonString(payload.sources) === canonicalJsonString(artifact.publicationPayload.sources),
    slug: payload.article.slug,
  },
  publicArticlesBefore: publicRows.length,
  existingFingerprintsUnchanged: true,
  duplicateReviews: reviews.reviews.length - 1,
  publisherForReviewNotRun: true,
  providerCallsThisPhase: 0,
  cumulativeProviderRequests,
  cumulativeProviderTokens,
}, null, 2));
