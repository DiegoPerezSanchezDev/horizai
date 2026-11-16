import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalJsonString } from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { humanReviewSourceLineageSha256 } from "../lib/agents/publisher/human-review-source-lineage-hash.ts";
import { humanReviewPublicationPayloadSha256 } from "../lib/agents/publisher/human-review-jsonb-hash.ts";
import { sha256 } from "../lib/agents/publisher/human-review.ts";
import { humanReviewRevisionRecordSchema, verifyHumanReviewRevisionRecord } from "../lib/agents/publisher/human-review-revision.ts";
import { parseHumanReviewOperatorInspection, parseHumanReviewOperatorList, SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { resolveEditorialDataMode } from "../lib/editorial/data-mode-policy.ts";
import { getEditorialNotificationEligibility } from "../lib/editorial/notifications.ts";
import { isM32Waiting, mapM32Review } from "../lib/editorial/live-mapping.ts";
import { getEditorialReviewDetailWith, listWaitingEditorialReviewsWith } from "../lib/editorial/live-service.ts";

const reviewId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const eventKey = "example-event";
const hash = (value) => sha256(canonicalJsonString(value));
const lineage = [{ source_id: "55555555-5555-4555-8555-555555555555", raw_item_id: "66666666-6666-4666-8666-666666666666", content_hash: "source-content-hash", canonical_url: "https://source.example/story", source_url: "https://source.example/story" }];
const draft = { headlineEs: "Titular original sobre un proyecto de investigación", dekEs: "Bajada original que resume el contexto del proyecto.", summaryEs: "Resumen original con contexto suficiente para explicar el alcance del anuncio y sus límites.", whyItMattersEs: "Este contexto original explica por qué el anuncio puede ser relevante para quienes siguen la investigación.", bodyEs: `## Contexto\n\n${"Texto del borrador original con suficiente detalle para revisar la atribución, el alcance y la incertidumbre del material. ".repeat(2).trim()}`, keyPoints: ["Punto original para revisar el alcance"] };
const payload = {
  schemaVersion: 1, eventKey,
  event: { canonicalTitle: "Example event", probableOccurredAt: null, probableCountryCode: "ES", probableRegionCode: "EU" },
  article: { slug: "example-event", ...draft },
  sources: [
    { sourceId: "55555555-5555-4555-8555-555555555555", rawItemId: "66666666-6666-4666-8666-666666666666", sourceName: "Fuente principal", url: "https://source.example/story", isPrimary: true, publishedAt: "2026-10-21T08:00:00Z" },
    { sourceId: "77777777-7777-4777-8777-777777777777", rawItemId: "88888888-8888-4888-8888-888888888888", sourceName: "Fuente secundaria", url: "https://another.example/report", isPrimary: false, publishedAt: null },
  ],
  categories: [{ categorySlug: "investigacion", isPrimary: true, confidenceScore: 90 }],
  entities: [], region: { code: "EU", latitude: null, longitude: null },
  scores: { impact: 60, novelty: 60, reach: 60, credibility: 60, economicImpact: 60, momentum: 60, importanceScore: 74 },
  verification: { schemaVersion: 1, eventKey, status: "confirmed", confidenceScore: 90, primarySourceId: "55555555-5555-4555-8555-555555555555", supportingSourceIds: [], contradictions: [], uncertainClaims: [], reason: "Confirmación sintética para la prueba de contrato.", verifiedFacts: [] },
  critic: { schemaVersion: 1, eventKey, decision: "pass", issues: [], unsupportedClaims: [], severity: "low", notes: "Prueba sintética del resultado estructurado." },
};
const checkpoints = Object.fromEntries(["verifier", "translator", "editor", "classifier", "ranker", "critic"].map((stage) => [stage, {
  identity: stage === "critic" ? `${runId}:${attemptId}:critic:${eventKey}` : `${runId}:${attemptId}:${stage}:${eventKey}`,
  sha256: (stage.charCodeAt(0).toString(16).padStart(2, "0")).repeat(32),
}]));
const draftSha = hash(draft);
const lineageSha = humanReviewSourceLineageSha256(lineage);
const publicationSha = humanReviewPublicationPayloadSha256(payload);
const packageSha = "a".repeat(64);
const checkpointManifest = { schemaVersion: "1", packageSha256: packageSha, checkpoints, manifestSha256: "b".repeat(64) };
const artifact = {
  schemaVersion: 1, reviewId, eventKey, attemptId, pipelineRunId: runId, draftId: `${runId}:${eventKey}`,
  draftSha256: draftSha, draft, sourceLineage: lineage, checkpoints,
  reviewEvidence: { critic: { decision: "pass" }, geo: { countryCodes: ["ES"] }, classifier: { primaryRegionCode: "EU" }, ranking: { importanceScore: 74 } },
  publicationPayload: payload, packageSha256: packageSha, reviewManifest: checkpointManifest,
  createdAt: "2026-10-21T08:00:00Z",
};
const reviewManifest = {
  ...checkpointManifest, eventKey, attemptId, pipelineRunId: runId, draftId: `${runId}:${eventKey}`,
  draftSha256: draftSha, sourceLineageSha256: lineageSha, publicationPayloadSha256: publicationSha,
};
const baseRow = {
  id: reviewId, eventId: eventKey, event_key: eventKey, attempt_id: attemptId, pipeline_run_id: runId,
  draft_id: `${runId}:${eventKey}`, draft_sha256: draftSha, source_lineage_sha256: lineageSha,
  publication_payload_sha256: publicationSha, approval_target_kind: "ORIGINAL", approval_target_revision_id: null,
  approval_target_revision_sha256: null, approved_revision_sha256: null, review_manifest: reviewManifest,
  critic_pass: true, provider_usage_settled: true, status: "WAITING_FOR_HUMAN_REVIEW", action: null,
  reviewer_approved: null, facts_acceptable: null, attribution_acceptable: null, reviewed_at: null,
  consumed_at: null, published_article_id: null, created_at: "2026-10-21T08:00:00Z", updated_at: "2026-10-21T08:00:00Z",
};
const m32List = (reviews) => ({ reviews, publishedToday: 2, returned: reviews.length, limit: 500 });

test("M32 list and inspect contracts are strict and reject malformed remote payloads", () => {
  assert.equal(parseHumanReviewOperatorList(m32List([baseRow])).reviews.length, 1);
  assert.throws(() => parseHumanReviewOperatorList({ ...m32List([baseRow]), privatePayload: "must not pass" }));
  assert.throws(() => parseHumanReviewOperatorList({ ...m32List([baseRow]), reviews: [{ ...baseRow, status: "UNKNOWN" }] }));
  const inspectionRow = { ...baseRow, source_lineage: lineage, reviewer_id: null, uncertainty_preserved: null, headline_acceptable: null, summary_acceptable: null,
    no_unsupported_material_claims: null, source_chain_acceptable: null, decision_history: [] };
  assert.equal(parseHumanReviewOperatorInspection({ found: true, review: inspectionRow, publishedToday: 2 }).review.id, reviewId);
  assert.deepEqual(parseHumanReviewOperatorInspection({ found: false, review: null, publishedToday: 2 }).review, null);
});

test("401/403 and PostgREST failures are reduced to safe repository codes", async () => {
  const forbidden = new SupabaseHumanReviewReadRepository({ rpc: async () => ({ data: null, error: { code: "42501", message: "private review content" } }) });
  await assert.rejects(() => forbidden.status(), (error) => {
    assert.equal(error.message, "HUMAN_REVIEW_OPERATOR_READ_FORBIDDEN");
    assert.doesNotMatch(error.message, /private review/);
    return true;
  });
  const unauthorized = new SupabaseHumanReviewReadRepository({ rpc: async () => ({ data: null, error: { code: "401", message: "expired private session" } }) });
  await assert.rejects(() => unauthorized.list(), (error) => {
    assert.equal(error.message, "HUMAN_REVIEW_OPERATOR_LIST_FAILED:401");
    assert.doesNotMatch(error.message, /expired private session/);
    return true;
  });
  const postgrest = new SupabaseHumanReviewReadRepository({ rpc: async () => ({ data: null, error: { code: "PGRST301", message: "private review content" } }) });
  await assert.rejects(() => postgrest.list(), (error) => {
    assert.equal(error.message, "HUMAN_REVIEW_OPERATOR_LIST_FAILED:PGRST301");
    assert.doesNotMatch(error.message, /private review/);
    return true;
  });
});

test("M32 maps only bound, verified metadata into the inbox/detail DTO", () => {
  const mapped = mapM32Review(baseRow, artifact);
  assert.equal(mapped.review.headline, draft.headlineEs);
  assert.equal(mapped.review.category, "investigacion");
  assert.equal(mapped.review.country, "España");
  assert.equal(mapped.review.region, "EU");
  assert.equal(mapped.review.rankerScore, 74);
  assert.equal(mapped.review.sources.length, 2);
  assert.equal(mapped.review.sources[0].publisher, "source.example");
  assert.equal(mapped.review.sources[0].classification, "PRIMARY");
  assert.equal(mapped.review.body[0].kind, "heading");
  assert.equal(mapped.detail.mode, "LIVE_READ_ONLY");
  for (const forbidden of ["checkpoints", "reviewEvidence", "publicationPayload", "providerResponses", "serviceRoleKey", "rawSourceText"]) {
    assert.equal(forbidden in mapped.review, false);
    assert.equal(forbidden in mapped.detail, false);
  }
  assert.equal(JSON.stringify(mapped.review).includes("source-content-hash"), false);
});

test("waiting filter excludes consumed and nonwaiting records", () => {
  assert.equal(isM32Waiting(baseRow), true);
  assert.equal(isM32Waiting({ ...baseRow, consumed_at: "2026-10-21T09:00:00Z" }), false);
  assert.equal(isM32Waiting({ ...baseRow, status: "APPROVED" }), false);
});

test("authorized read-service mock runs status/list/inspect mapping and fails closed on M32 errors", async () => {
  const calls = { status: 0, list: 0, inspect: 0, artifact: 0, revision: 0 };
  const repository = {
    async status() { calls.status++; return { waitingReviews: 1, publishedToday: 2 }; },
    async list(limit) { calls.list++; return { ...m32List([baseRow, { ...baseRow, id: "99999999-9999-4999-8999-999999999999", status: "APPROVED" }, { ...baseRow, consumed_at: "2026-10-21T09:00:00Z" }]), limit }; },
    async inspect(id) { calls.inspect++; return { found: id === reviewId, review: id === reviewId ? { ...baseRow, source_lineage: lineage, reviewer_id: null, uncertainty_preserved: null, headline_acceptable: null,
      summary_acceptable: null, no_unsupported_material_claims: null, source_chain_acceptable: null, decision_history: [] } : null, publishedToday: 2 }; },
  };
  const dependencies = { repository, async readArtifact(row) { calls.artifact++; assert.equal(row.id, reviewId); return artifact; }, async readRevision() { calls.revision++; throw new Error("revision should not be read for an original target"); } };
  const inbox = await listWaitingEditorialReviewsWith(dependencies);
  assert.deepEqual(inbox.reviews.map((review) => review.reviewId), [reviewId]);
  assert.equal(inbox.waitingCount, 1);
  assert.equal(inbox.publishedToday, 2);
  const detail = await getEditorialReviewDetailWith(reviewId, dependencies);
  assert.equal(detail.review.headline, draft.headlineEs);
  assert.deepEqual(calls, { status: 1, list: 1, inspect: 1, artifact: 2, revision: 0 });
  await assert.rejects(() => getEditorialReviewDetailWith("00000000-0000-0000-0000-000000000000", dependencies), (error) => error.code === "REVIEW_NOT_FOUND");
  const failedRepository = { ...repository, async status() { throw new Error("PostgREST secret-bearing detail"); } };
  await assert.rejects(() => listWaitingEditorialReviewsWith({ ...dependencies, repository: failedRepository }), (error) => {
    assert.equal(error.code, "M32_UNAVAILABLE");
    assert.doesNotMatch(error.message, /PostgREST|secret-bearing/);
    return true;
  });
});

test("human revision is verified and displayed as the current approval target while Critic stays bound to original", () => {
  const correctedDraft = { ...draft, headlineEs: "Titular corregido sobre un proyecto de investigación", summaryEs: "Resumen corregido con contexto suficiente para explicar el alcance del anuncio y sus límites.", bodyEs: `Texto corregido con suficiente detalle para revisar la atribución, el alcance y la incertidumbre del material. ${"Texto adicional corregido para completar el contenido mínimo de revisión. ".repeat(2)}`.trim() };
  const correctedPayload = { ...payload, article: { ...payload.article, ...correctedDraft } };
  const correctedRevisionSha = hash(correctedDraft);
  const revision = {
    id: revisionId, review_id: reviewId, revision_version: 1, attempt_id: attemptId, pipeline_run_id: runId,
    original_draft: draft, original_publication_payload: payload, corrected_draft: correctedDraft,
    corrected_publication_payload: correctedPayload, original_draft_sha256: draftSha,
    corrected_revision_sha256: correctedRevisionSha, source_lineage_sha256: lineageSha,
    automated_critic_draft_sha256: draftSha,
    human_revision_proof: { schemaVersion: 1, status: "PASS", actorClass: "HUMAN_OPERATOR", correctedRevisionSha256: correctedRevisionSha,
      originalDraftSha256: draftSha, sourceLineageSha256: lineageSha, auditSha256: "c".repeat(64), auditedAt: "2026-10-21T08:10:00Z",
      automatedCriticScope: "ORIGINAL_DRAFT_ONLY", humanAttestation: "FACTUAL_ATTRIBUTION_ORIGINALITY_SOURCE_LINEAGE_PASS" },
    created_at: "2026-10-21T08:10:00Z",
  };
  const parsedRevision = humanReviewRevisionRecordSchema.safeParse(revision);
  assert.equal(parsedRevision.success, true, parsedRevision.success ? "" : JSON.stringify(parsedRevision.error.issues));
  assert.equal(verifyHumanReviewRevisionRecord(parsedRevision.data), true);
  assert.equal(canonicalJsonString(parsedRevision.data.original_publication_payload), canonicalJsonString(artifact.publicationPayload));
  const row = { ...baseRow, approval_target_kind: "HUMAN_REVISION", approval_target_revision_id: revisionId,
    approval_target_revision_sha256: correctedRevisionSha, review_manifest: reviewManifest };
  const result = mapM32Review(row, artifact, revision);
  assert.equal(result.review.headline, correctedDraft.headlineEs);
  assert.equal(result.review.approvalTarget, "HUMAN_REVISION");
  assert.equal(result.review.approvalTargetSha256, correctedRevisionSha);
  assert.equal(result.review.humanRevisionId, revisionId);
  assert.equal(result.detail.originalDraft.headline, draft.headlineEs);
  assert.equal(result.review.criticProofStatus, "PASS");
  assert.throws(() => mapM32Review(row, artifact, { ...revision, id: "99999999-9999-4999-8999-999999999999" }));
  assert.throws(() => mapM32Review(row, artifact, revision, []));
});

test("proof warnings are deterministic and notification eligibility consumes the live DTO", () => {
  const eligible = mapM32Review(baseRow, artifact).review;
  assert.equal(getEditorialNotificationEligibility(eligible, { deliveredDedupeKeys: [], reservedDedupeKeys: [] }).eligible, true);
  const weakCritic = mapM32Review({ ...baseRow, critic_pass: false }, artifact).review;
  assert.equal(weakCritic.criticProofStatus, "UNKNOWN");
  assert.equal(weakCritic.m34Status, "UNKNOWN");
  assert.deepEqual(getEditorialNotificationEligibility(weakCritic, { deliveredDedupeKeys: [], reservedDedupeKeys: [] }).reasons,
    ["CRITIC_PROOF_REQUIRED", "M34_REQUIRED"]);
  assert.throws(() => mapM32Review(baseRow, { ...artifact, sourceLineage: [] }));
  assert.equal(getEditorialNotificationEligibility({ ...eligible, consumed: true }, { deliveredDedupeKeys: [], reservedDedupeKeys: [] }).reasons[0], "CONSUMED");
});

test("environment mode fails closed in production and never falls back to fixtures", () => {
  assert.equal(resolveEditorialDataMode("production", undefined), "LIVE_DISABLED");
  assert.equal(resolveEditorialDataMode("production", "false"), "LIVE_DISABLED");
  assert.equal(resolveEditorialDataMode("production", "true"), "LIVE_READ_ONLY");
  assert.equal(resolveEditorialDataMode("development", "false"), "FIXTURE");
  assert.equal(resolveEditorialDataMode("development", "true"), "LIVE_READ_ONLY");
  const live = readFileSync("lib/editorial/live-data.ts", "utf8");
  assert.match(live, /await requireEditorialOperator\(\)/);
  assert.ok(live.indexOf("await requireEditorialOperator()") < live.indexOf("createSupabaseServerClient({ privateNoStore: true })"));
  assert.match(live, /EDITORIAL_LIVE_DATA_ENABLED !== "true"/);
  assert.doesNotMatch(live, /editorial\/data|editorial\/fixtures/);
  assert.doesNotMatch(readFileSync(".env.example", "utf8"), /NEXT_PUBLIC_EDITORIAL_LIVE_DATA_ENABLED/);
});

test("private reads are no-store, dynamic and limited to read RPCs", () => {
  const client = readFileSync("lib/supabase/server-client.ts", "utf8");
  const live = readFileSync("lib/editorial/live-data.ts", "utf8");
  const pages = ["app/editorial/(workspace)/page.tsx", "app/editorial/(workspace)/reviews/[id]/page.tsx"];
  assert.match(client, /cache: "no-store"/);
  assert.match(live, /privateNoStore: true/g);
  for (const page of pages) assert.match(readFileSync(page, "utf8"), /dynamic = "force-dynamic"/);
  assert.match(readFileSync("next.config.ts", "utf8"), /Cache-Control", value: "private, no-store, max-age=0"/);
  for (const rpc of ["create_pipeline_human_review", "bind_pipeline_human_review_revision", "decide_pipeline_human_review", "publish_reviewed_article_atomic"]) assert.equal(live.includes(rpc), false);
  assert.match(live, /get_pipeline_human_review_revision/);
});

test("client components have no privileged Supabase imports or M32 RPCs", () => {
  const clientFiles = ["components/editorial/refresh-inbox.tsx", "components/editorial/review-actions.tsx"];
  for (const path of clientFiles) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /SUPABASE_SECRET_KEY|createSupabaseServerClient|\.rpc\(/);
  }
  const page = readFileSync("app/editorial/(workspace)/page.tsx", "utf8");
  assert.match(page, /mode === "FIXTURE"[\s\S]*import\("@\/lib\/editorial\/data"\)/);
  assert.match(page, /no se muestran datos de ejemplo/);
});
