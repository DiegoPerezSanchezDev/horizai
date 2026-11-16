import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { SupabaseHumanReviewRepository } from "../lib/agents/publisher/human-review-repository.ts";
import { readHumanReviewArtifact } from "../lib/agents/publisher/human-review.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { mapPublicArticle, type PublicArticleRow } from "../lib/public-content-model.ts";
import { canonicalJsonString } from "../lib/agents/pipeline/factual-remediation-continuation.ts";

const target = {
  reviewId: "ebd8acc0-76a2-4977-81d9-60a7f6240084",
  revisionId: "6fd9fae7-dbc6-4e13-abba-c4c6dfca38d9",
  attemptId: "4658d5c0-857c-4ed5-b97f-afb133b2bf22",
  articleId: "64ac852b-2d67-4048-953c-9c9e8c5e2ef2",
  correctedSha256: "69f0d3e350621f86c69a72d2cb1cbf1cb390212d695f932eedb03d325ade2045",
  slug: "india-detecta-actividad-de-agentes-de-ia-no-autorizados",
  headline: "CERT-In informa de accesos de agentes de IA durante evaluaciones en India",
  astraSlug: "openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad",
};

const supabase = createSupabaseServerClient();
const reads = new SupabaseHumanReviewReadRepository(supabase);
const inspection = await reads.inspect(target.reviewId);
assert.equal(inspection.found, true);
const review = inspection.review!;
assert.deepEqual([
  review.id, review.status, review.action, review.reviewer_approved,
  review.approval_target_kind, review.approval_target_revision_id,
  review.approval_target_revision_sha256, review.approved_revision_sha256,
  review.consumed_at !== null, review.published_article_id,
], [target.reviewId, "PUBLISHED", "APPROVE", true, "HUMAN_REVISION", target.revisionId,
  target.correctedSha256, target.correctedSha256, true, target.articleId]);

const artifact = await readHumanReviewArtifact("artifacts/human-review-packages", target.attemptId);
const revision = await new SupabaseHumanReviewRepository(supabase).getRevision(target.reviewId);
assert.equal(revision.id, target.revisionId);
assert.equal(revision.corrected_revision_sha256, target.correctedSha256);
assert.equal(review.source_lineage_sha256, revision.source_lineage_sha256);
const expectedArticle = revision.corrected_publication_payload.article;
assert.equal(expectedArticle.headlineEs, target.headline);

const articleResponse = await supabase.from("articles").select("*").eq("id", target.articleId).maybeSingle();
assert.equal(articleResponse.error, null);
assert.ok(articleResponse.data, "PUBLISHED_ARTICLE_ROW_REQUIRED");
const article = articleResponse.data;
assert.deepEqual([
  article.id, article.publication_status, article.slug, article.headline_es,
  article.summary_es, article.why_it_matters_es, article.body_es,
], [target.articleId, "published", target.slug, expectedArticle.headlineEs,
  expectedArticle.summaryEs, expectedArticle.whyItMattersEs, expectedArticle.bodyEs]);

const eventResponse = await supabase.from("events").select("id,event_status,event_key").eq("id", article.event_id).maybeSingle();
assert.equal(eventResponse.error, null);
assert.ok(eventResponse.data);
assert.equal(eventResponse.data.event_key, review.event_key);
assert.equal(eventResponse.data.event_status, "active");
const eventSourceResponse = await supabase.from("event_sources").select("source_id,raw_item_id,is_primary").eq("event_id", article.event_id);
assert.equal(eventSourceResponse.error, null);
const expectedSources = revision.corrected_publication_payload.sources.map((source) => ({
  source_id: source.sourceId, raw_item_id: source.rawItemId, is_primary: source.isPrimary,
})).sort((a, b) => a.source_id.localeCompare(b.source_id));
assert.deepEqual((eventSourceResponse.data ?? []).map((source) => ({
  source_id: source.source_id, raw_item_id: source.raw_item_id, is_primary: source.is_primary,
})).sort((a, b) => a.source_id.localeCompare(b.source_id)), expectedSources);

const publicResponse = await supabase.from("public_published_articles").select("*").order("published_at", { ascending: false });
assert.equal(publicResponse.error, null);
const publicRows = publicResponse.data ?? [];
assert.equal(publicRows.length, 3);
const publicRouteRecord = publicRows.find((row) => row.slug === target.slug);
assert.ok(publicRouteRecord, "PUBLIC_ARTICLE_ROUTE_ROW_REQUIRED");
const publicArticle = mapPublicArticle(publicRouteRecord as PublicArticleRow);
assert.deepEqual([
  publicArticle.headline, publicArticle.summary, publicArticle.whyItMatters, publicArticle.body,
], [expectedArticle.headlineEs, expectedArticle.summaryEs, expectedArticle.whyItMattersEs, expectedArticle.bodyEs]);
assert.deepEqual(publicArticle.sources.map((source) => ({ name: source.name, url: source.url })),
  revision.corrected_publication_payload.sources.map((source) => ({ name: source.sourceName, url: source.url })));
assert.notEqual(publicArticle.body, revision.original_publication_payload.article.bodyEs,
  "the original flawed body is not publicly selected");

const publishedRows = await supabase.from("articles").select("id,event_id,slug,publication_status").eq("publication_status", "published");
assert.equal(publishedRows.error, null);
assert.equal((publishedRows.data ?? []).length, 3);
const sameEventPublished = (publishedRows.data ?? []).filter((row) => row.event_id === article.event_id);
assert.equal(sameEventPublished.length, 1, "no duplicate publication for event");
const prior = JSON.parse(readFileSync("artifacts/supervised-cycle-12f12j-after.json", "utf8")) as {
  fingerprints: Array<{ id: string; sha256: string }>;
};
const oldPublicRows = (publishedRows.data ?? []).filter((row) => row.id !== target.articleId);
const oldArticleDetails = await supabase.from("articles").select("*").in("id", oldPublicRows.map((row) => row.id));
assert.equal(oldArticleDetails.error, null);
const unchangedFingerprints = (oldArticleDetails.data ?? []).map((row) => ({
  id: row.id,
  sha256: publicArticleFingerprintV1(row),
})).sort((a, b) => a.id.localeCompare(b.id));
assert.deepEqual(unchangedFingerprints, prior.fingerprints);

const astraResponse = await supabase.from("articles").select("id,slug,publication_status").eq("slug", target.astraSlug).maybeSingle();
assert.equal(astraResponse.error, null);
assert.equal(astraResponse.data?.publication_status, "archived");
assert.equal(publicRows.some((row) => row.slug === target.astraSlug), false);

const status = await reads.status();
assert.deepEqual([status.totalReviews, status.waitingReviews, status.approvedReviews, status.publishedReviews,
  status.consumedReviews, status.publishedToday, status.attemptsToday, status.activeWork, status.stuckWork], [1, 0, 0, 1, 1, 1, 0, 0, 0]);
const finalRows = await reads.list(500);
assert.equal(finalRows.reviews.length, 1);
assert.equal(finalRows.reviews.filter((row) => row.status === "PUBLISHED").length, 1);

const providerAccounting = artifact.reviewEvidence.providerAccounting;
const cumulativeProviderRequests = Object.values(providerAccounting).reduce((sum, value) => sum + value.requestCount, 0);
const providerTokenTotals = Object.values(providerAccounting).map((value) => value.totalTokens);
assert.ok(providerTokenTotals.every((value): value is number => typeof value === "number"), "PROVIDER_TOKEN_TOTALS_MUST_BE_KNOWN");
const cumulativeProviderTokens = providerTokenTotals.reduce((sum, value) => sum + value, 0);
assert.deepEqual([cumulativeProviderRequests, cumulativeProviderTokens], [6, 10792]);

console.log(JSON.stringify({
  status: "POSTPUBLISH_PASS",
  review: { id: review.id, status: review.status, action: review.action, consumed: review.consumed_at !== null,
    publishedArticleId: review.published_article_id, approvedRevisionId: review.approval_target_revision_id,
    approvedRevisionSha256: review.approved_revision_sha256 },
  article: { id: article.id, slug: article.slug, publicationStatus: article.publication_status,
    eventId: article.event_id, eventStatus: eventResponse.data.event_status, sourceRevisionId: revision.id,
    correctedSha256: revision.corrected_revision_sha256 },
  publicArticle: { count: publicRows.length, headline: publicArticle.headline, summaryMatches: publicArticle.summary === expectedArticle.summaryEs,
    whyItMattersMatches: publicArticle.whyItMatters === expectedArticle.whyItMattersEs,
    bodyMatches: publicArticle.body === expectedArticle.bodyEs,
    sourcesMatchReviewedSet: canonicalJsonString(publicArticle.sources.map((source) => ({ name: source.name, url: source.url })))
      === canonicalJsonString(revision.corrected_publication_payload.sources.map((source) => ({ name: source.sourceName, url: source.url }))),
    originalFlawedPassageAbsent: publicArticle.body !== revision.original_publication_payload.article.bodyEs },
  publicArticlesBefore: prior.fingerprints.length,
  publicArticlesAfter: publicRows.length,
  duplicatePublication: sameEventPublished.length !== 1,
  existingFingerprintsUnchanged: true,
  astraArchived: astraResponse.data?.publication_status === "archived",
  reviewDuplicates: finalRows.reviews.length - 1,
  attemptsToday: status.attemptsToday,
  providerCallsThisPhase: 0,
  cumulativeProviderRequests,
  cumulativeProviderTokens,
  publisherInvocations: 1,
}, null, 2));
