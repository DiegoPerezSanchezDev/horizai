import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildHumanRevisionBinding, parseHumanCorrectedDraft, verifyHumanRevisionBinding } from "../lib/agents/publisher/human-review-revision.ts";
import { humanReviewArtifactSchema, verifyHumanReviewArtifact } from "../lib/agents/publisher/human-review.ts";
import { humanReviewSourceLineageSha256 } from "../lib/agents/publisher/human-review-source-lineage-hash.ts";
import { assertHumanReviewPublicationAuthorization, assertHumanReviewPublicationTarget } from "../lib/agents/publisher/human-review-policy.ts";
import { buildHumanReviewRevisionBindRpcArgs, SupabaseHumanReviewRepository } from "../lib/agents/publisher/human-review-repository.ts";
import { SafeRpcFailureError } from "../lib/supabase/safe-rpc-error.ts";

const artifact = humanReviewArtifactSchema.parse(JSON.parse(readFileSync("artifacts/human-review-packages/4658d5c0-857c-4ed5-b97f-afb133b2bf22.json", "utf8")));
const auditBytes = readFileSync("artifacts/supervised-cycle-12f12k-editorial-remediation.json");
const audit = JSON.parse(auditBytes.toString("utf8"));
const markdown = readFileSync("artifacts/supervised-cycle-12f12k-corrected-draft.md", "utf8");
const binding = buildHumanRevisionBinding({ markdown, audit, auditBytes, artifact, auditedAt: "2026-10-20T20:00:00.000Z" });
assert.equal(verifyHumanReviewArtifact(artifact), true, "original package remains valid");
assert.equal(verifyHumanRevisionBinding(binding), true, "human revision hash and payload binding are valid");
assert.equal(binding.originalDraftSha256, artifact.draftSha256);
assert.equal(binding.sourceLineageSha256, humanReviewSourceLineageSha256(artifact.sourceLineage));
assert.equal(binding.humanRevisionProof.actorClass, "HUMAN_OPERATOR");
assert.equal(binding.humanRevisionProof.automatedCriticScope, "ORIGINAL_DRAFT_ONLY");
assert.notEqual(binding.correctedRevisionSha256, binding.originalDraftSha256);
assert.equal(binding.correctedPublicationPayload.sources.length, artifact.publicationPayload.sources.length);
assert.deepEqual(binding.correctedPublicationPayload.sources, artifact.publicationPayload.sources, "revision cannot add or change source lineage");
assert.deepEqual(binding.correctedPublicationPayload.critic, artifact.publicationPayload.critic, "M34 critic proof stays on original model draft");
assert.equal(binding.correctedPublicationPayload.article.slug, artifact.publicationPayload.article.slug);
assert.throws(() => parseHumanCorrectedDraft(markdown.replace("## Titular", "## Título")), /SECTION_INVALID/);
assert.throws(() => buildHumanRevisionBinding({
  markdown: markdown.replace("https://www.cert-in.org.in/s2cMainServlet?CACODE=CICA-2026-3630&pageid=PUBADV01", "https://example.org/foreign-source"),
  audit, auditBytes, artifact, auditedAt: "2026-10-20T20:00:00.000Z",
}), /SOURCE_URL_NOT_APPROVED/);
assert.throws(() => buildHumanRevisionBinding({
  markdown, audit: { ...audit, claimRecheck: { ...audit.claimRecheck, headline: "FAIL" } }, auditBytes, artifact, auditedAt: "2026-10-20T20:00:00.000Z",
}), /12K_AUDIT_NOT_PASS/);

const authorization = {
  action: "APPROVE", status: "APPROVED", eventKey: artifact.eventKey, attemptId: artifact.attemptId,
  pipelineRunId: artifact.pipelineRunId, draftId: artifact.draftId, draftSha256: artifact.draftSha256,
  packageSha256: artifact.packageSha256, checkpoints: artifact.checkpoints, sourceLineage: artifact.sourceLineage,
  criticPass: true, usageSettled: true, factualReviewPassed: true, attributionReviewPassed: true,
  uncertaintyReviewPassed: true, headlineReviewPassed: true, summaryReviewPassed: true,
  noUnsupportedMaterialClaims: true, sourceChainPassed: true,
  approvalTargetKind: "HUMAN_REVISION", approvalTargetRevisionSha256: binding.correctedRevisionSha256,
  approvedRevisionSha256: binding.correctedRevisionSha256,
  lineageCurrent: true, manifestCurrent: true, approvalConsumed: false, publishedToday: 0,
};
assertHumanReviewPublicationAuthorization(authorization);
assert.throws(() => assertHumanReviewPublicationAuthorization({ ...authorization, approvedRevisionSha256: artifact.draftSha256 }), /HUMAN_APPROVAL_REQUIRED/);
assert.throws(() => assertHumanReviewPublicationTarget({
  eventKey: artifact.eventKey, attemptId: artifact.attemptId, pipelineRunId: artifact.pipelineRunId,
  draftId: artifact.draftId, draftSha256: artifact.draftSha256, packageSha256: artifact.packageSha256,
  checkpoints: artifact.checkpoints, sourceLineage: artifact.sourceLineage,
  approvalTargetRevisionSha256: artifact.draftSha256, authorization,
}), /HUMAN_APPROVAL_REQUIRED/);
assertHumanReviewPublicationTarget({
  eventKey: artifact.eventKey, attemptId: artifact.attemptId, pipelineRunId: artifact.pipelineRunId,
  draftId: artifact.draftId, draftSha256: artifact.draftSha256, packageSha256: artifact.packageSha256,
  checkpoints: artifact.checkpoints, sourceLineage: artifact.sourceLineage,
  approvalTargetRevisionSha256: binding.correctedRevisionSha256, authorization,
});

const rpcArgs = buildHumanReviewRevisionBindRpcArgs({ reviewId: artifact.reviewId, artifact, binding });
assert.deepEqual(rpcArgs, {
  p_review_id: artifact.reviewId,
  p_expected_original_draft_sha256: binding.originalDraftSha256,
  p_original_draft: binding.originalDraft,
  p_original_publication_payload: binding.originalPublicationPayload,
  p_corrected_draft: binding.correctedDraft,
  p_corrected_publication_payload: binding.correctedPublicationPayload,
  p_source_lineage: artifact.sourceLineage,
  p_corrected_revision_sha256: binding.correctedRevisionSha256,
  p_human_revision_proof: binding.humanRevisionProof,
}, "RPC parameter names, JSON shapes, hashes, and UUID match the M38 caller contract");

const expectedRpcResult = {
  reviewId: artifact.reviewId,
  revisionId: "00000000-0000-4000-8000-000000000038",
  revisionVersion: 1,
  revisionSha256: binding.correctedRevisionSha256,
  originalDraftSha256: binding.originalDraftSha256,
  sourceLineageSha256: binding.sourceLineageSha256,
  status: "WAITING_FOR_HUMAN_REVIEW",
  approvalTargetKind: "HUMAN_REVISION",
  reused: false,
};
let successfulRpcCall = null;
const successfulRepository = new SupabaseHumanReviewRepository({
  rpc: async (name, args) => {
    successfulRpcCall = { name, args };
    return { data: expectedRpcResult, error: null, status: 200, statusText: "OK" };
  },
});
assert.deepEqual(await successfulRepository.bindRevision({ reviewId: artifact.reviewId, artifact, binding }), {
  revisionId: expectedRpcResult.revisionId,
  revisionVersion: 1,
  revisionSha256: binding.correctedRevisionSha256,
  originalDraftSha256: binding.originalDraftSha256,
  sourceLineageSha256: binding.sourceLineageSha256,
  reused: false,
}, "successful RPC response contract remains unchanged");
assert.deepEqual(successfulRpcCall, { name: "bind_pipeline_human_review_revision", args: rpcArgs });

const failedRepository = new SupabaseHumanReviewRepository({
  rpc: async () => ({
    data: null,
    error: { code: "P0001", message: "human_review_revision_binding_invalid", details: "safe db detail", hint: "safe db hint" },
    status: 400,
    statusText: "Bad Request",
  }),
});
await assert.rejects(failedRepository.bindRevision({ reviewId: artifact.reviewId, artifact, binding }), (error) => {
  assert.ok(error instanceof SafeRpcFailureError);
  assert.deepEqual(error.rpcFailure, {
    operation: "bind_pipeline_human_review_revision",
    httpStatus: 400,
    postgrestCode: null,
    sqlState: "P0001",
    message: "human_review_revision_binding_invalid",
    details: "safe db detail",
    hint: "safe db hint",
    causeName: null,
    causeMessage: null,
  });
  return true;
});

const migration = readFileSync("supabase/migrations/20261020130000_human_review_revision_binding.sql", "utf8").toLowerCase();
const bindRunner = readFileSync("scripts/supervised-cycle-12f12l-bind-human-revision.ts", "utf8");
assert.match(migration, /create table public\.pipeline_human_review_revisions/);
assert.match(migration, /review_id uuid not null unique/);
assert.match(migration, /original_draft jsonb not null/);
assert.match(migration, /corrected_draft jsonb not null/);
assert.match(migration, /create trigger pipeline_human_review_revisions_immutable/);
assert.match(migration, /approval_target_kind = 'human_revision'/);
assert.match(migration, /human_review_revision_hash_required/);
assert.match(migration, /create function public\.decide_pipeline_human_review_revision/);
assert.match(migration, /p_approval_target_revision_sha256 text/);
assert.match(migration, /approved_revision_sha256 is distinct from v_review\.approval_target_revision_sha256/);
assert.match(migration, /p_publication_payload is distinct from v_revision\.corrected_publication_payload/);
assert.match(migration, /automated_critic_draft_sha256 is not distinct from original_draft_sha256/);
assert.match(migration, /source_lineage_sha256 is distinct from v_review\.source_lineage_sha256/);
assert.doesNotMatch(migration, /update public\.pipeline_human_review_revisions/);
assert.doesNotMatch(migration, /insert into public\.pipeline_human_reviews\s*\(/);
const bindFunction = migration.slice(migration.indexOf("create function public.bind_pipeline_human_review_revision"), migration.indexOf("create function public.get_pipeline_human_review_revision"));
assert.match(bindFunction, /insert into public\.pipeline_human_review_revisions[\s\S]*?update public\.pipeline_human_reviews/);
assert.match(bindFunction, /if not found then raise exception/);
assert.doesNotMatch(bindFunction, /\b(?:commit|rollback)\s*;/);
assert.doesNotMatch(bindFunction, /insert into public\.[a-z_]*(?:audit|log)[a-z_]*\b/);
assert.match(bindFunction, /p_expected_original_draft_sha256 is distinct from v_review\.draft_sha256/);
assert.match(bindFunction, /p_corrected_revision_sha256/);
assert.match(bindFunction, /v_source_lineage_sha256 is distinct from v_review\.source_lineage_sha256/);
assert.match(bindFunction, /p_original_draft is distinct from jsonb_build_object/);
assert.match(bindFunction, /approval_target_kind = 'human_revision'/);
assert.match(bindFunction, /if v_existing\.id is not null/);
assert.match(bindRunner, /\[before\.id, before\.status, before\.consumed_at, before\.approval_target_kind, before\.approval_target_revision_id\][\s\S]*?"WAITING_FOR_HUMAN_REVIEW", null, "ORIGINAL", null/);
assert.equal((bindRunner.match(/\.bindRevision\s*\(/g) ?? []).length, 1, "one canonical bind invocation and no retry loop");

console.log(JSON.stringify({ status: "PASS", originalDraftPreserved: true, correctedHash: binding.correctedRevisionSha256, sourceLineage: "PASS", staleApproval: "BLOCKED", criticScope: "ORIGINAL_DRAFT_ONLY", noNewReview: true }, null, 2));
