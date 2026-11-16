import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../../types/database.ts";
import { createSupabaseServerClient } from "../../supabase/server-client.ts";
import type { AtomicPublicationResult } from "./publisher-repository.ts";
import type { HumanReviewArtifact, HumanReviewManifest } from "./human-review.ts";
import { assertHumanReviewPublicationTarget, type HumanReviewPublicationAuthorization } from "./human-review-policy.ts";
import { humanReviewRevisionRecordSchema, verifyHumanReviewRevisionRecord, type HumanRevisionBinding } from "./human-review-revision.ts";
import { canonicalJsonString } from "../pipeline/factual-remediation-continuation.ts";
import { humanReviewSourceLineageSha256 } from "./human-review-source-lineage-hash.ts";
import { normalizeSafeRpcFailure, SafeRpcFailureError } from "../../supabase/safe-rpc-error.ts";

type Client = SupabaseClient<Database>;

type BindRevisionInput = { reviewId: string; artifact: HumanReviewArtifact; binding: HumanRevisionBinding };

export function buildHumanReviewRevisionBindRpcArgs(input: BindRevisionInput): Database["public"]["Functions"]["bind_pipeline_human_review_revision"]["Args"] {
  const { artifact, binding } = input;
  return {
    p_review_id: input.reviewId,
    p_expected_original_draft_sha256: binding.originalDraftSha256,
    p_original_draft: binding.originalDraft as unknown as Json,
    p_original_publication_payload: binding.originalPublicationPayload as unknown as Json,
    p_corrected_draft: binding.correctedDraft as unknown as Json,
    p_corrected_publication_payload: binding.correctedPublicationPayload as unknown as Json,
    p_source_lineage: artifact.sourceLineage as unknown as Json,
    p_corrected_revision_sha256: binding.correctedRevisionSha256,
    p_human_revision_proof: binding.humanRevisionProof as unknown as Json,
  };
}

function sensitiveRevisionValues(input: BindRevisionInput): string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length >= 12) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
  };
  visit(input.binding);
  visit(input.artifact.sourceLineage);
  return [...new Set(values)];
}

export type HumanReviewDecision = "APPROVE" | "HOLD" | "REJECT";
export type HumanReviewChecks = {
  factsAcceptable: boolean;
  attributionAcceptable: boolean;
  uncertaintyPreserved: boolean;
  headlineAcceptable: boolean;
  summaryAcceptable: boolean;
  noUnsupportedMaterialClaims: boolean;
  sourceChainAcceptable: boolean;
};

function record(value: Json, code: string): Record<string, Json | undefined> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, Json | undefined>;
}

export class SupabaseHumanReviewRepository {
  private readonly supabase: Client;
  constructor(supabase: Client = createSupabaseServerClient()) { this.supabase = supabase; }

  async create(input: {
    artifact: HumanReviewArtifact;
    manifest: HumanReviewManifest;
  }): Promise<{ reviewId: string; status: string }> {
    const a = input.artifact;
    const response = await this.supabase.rpc("create_pipeline_human_review", {
      p_event_key: a.eventKey,
      p_attempt_id: a.attemptId,
      p_pipeline_run_id: a.pipelineRunId,
      p_draft_id: a.draftId,
      p_draft_sha256: a.draftSha256,
      p_source_lineage: a.sourceLineage as unknown as Json,
      p_review_manifest: input.manifest as unknown as Json,
      p_publication_payload: a.publicationPayload as unknown as Json,
    });
    if (response.error) throw new Error(response.error.message.match(/human_review_[a-z_]+/)?.[0] ?? "HUMAN_REVIEW_CREATE_FAILED");
    const result = record(response.data as Json, "HUMAN_REVIEW_CREATE_INVALID_RESPONSE");
    if (typeof result.reviewId !== "string" || typeof result.status !== "string" || result.draftSha256 !== a.draftSha256) throw new Error("HUMAN_REVIEW_CREATE_INVALID_RESPONSE");
    return { reviewId: result.reviewId, status: result.status };
  }

  async bindRevision(input: { reviewId: string; artifact: HumanReviewArtifact; binding: HumanRevisionBinding }): Promise<{
    revisionId: string; revisionVersion: number; revisionSha256: string; originalDraftSha256: string; sourceLineageSha256: string; reused: boolean;
  }> {
    const { binding } = input;
    const args = buildHumanReviewRevisionBindRpcArgs(input);
    const sensitiveValues = sensitiveRevisionValues(input);
    let response;
    try {
      response = await this.supabase.rpc("bind_pipeline_human_review_revision", args);
    } catch (error) {
      throw new SafeRpcFailureError(normalizeSafeRpcFailure("bind_pipeline_human_review_revision", error, { sensitiveValues }));
    }
    if (response.error) {
      throw new SafeRpcFailureError(normalizeSafeRpcFailure("bind_pipeline_human_review_revision", response.error, {
        httpStatus: response.status,
        sensitiveValues,
      }));
    }
    const result = record(response.data as Json, "HUMAN_REVIEW_REVISION_BIND_INVALID_RESPONSE");
    if (result.reviewId !== input.reviewId || typeof result.revisionId !== "string" || result.revisionVersion !== 1
      || result.revisionSha256 !== binding.correctedRevisionSha256 || result.originalDraftSha256 !== binding.originalDraftSha256
      || result.sourceLineageSha256 !== binding.sourceLineageSha256 || result.approvalTargetKind !== "HUMAN_REVISION"
      || typeof result.reused !== "boolean" || (result.status !== "WAITING_FOR_HUMAN_REVIEW" && result.status !== "WAITING")) {
      throw new Error("HUMAN_REVIEW_REVISION_BIND_INVALID_RESPONSE");
    }
    return { revisionId: result.revisionId, revisionVersion: 1, revisionSha256: binding.correctedRevisionSha256,
      originalDraftSha256: binding.originalDraftSha256, sourceLineageSha256: binding.sourceLineageSha256, reused: result.reused };
  }

  async getRevision(reviewId: string) {
    const response = await this.supabase.rpc("get_pipeline_human_review_revision", { p_review_id: reviewId });
    if (response.error) throw new Error(response.error.message.match(/human_review_[a-z_]+/)?.[0] ?? "HUMAN_REVIEW_REVISION_READ_FAILED");
    const result = record(response.data as Json, "HUMAN_REVIEW_REVISION_READ_INVALID_RESPONSE");
    if (result.found !== true) throw new Error("HUMAN_REVIEW_REVISION_NOT_FOUND");
    const parsed = humanReviewRevisionRecordSchema.safeParse(result.revision);
    if (!parsed.success || parsed.data.review_id !== reviewId || !verifyHumanReviewRevisionRecord(parsed.data)) throw new Error("HUMAN_REVIEW_REVISION_READ_INVALID_RESPONSE");
    return parsed.data;
  }

  async decide(input: { reviewId: string; decision: HumanReviewDecision; reviewerId: string; checks: HumanReviewChecks; approvalTargetRevisionSha256?: string | null }): Promise<{ reviewId: string; status: string; reviewedAt?: string }> {
    const c = input.checks;
    const revisionApproval = input.decision === "APPROVE" && input.approvalTargetRevisionSha256 != null;
    if (input.decision === "APPROVE" && input.approvalTargetRevisionSha256 === null) throw new Error("HUMAN_REVIEW_REVISION_HASH_REQUIRED");
    const response = revisionApproval
      ? await this.supabase.rpc("decide_pipeline_human_review_revision", {
        p_review_id: input.reviewId,
        p_approval_target_revision_sha256: input.approvalTargetRevisionSha256!,
        p_reviewer_id: input.reviewerId,
        p_facts_acceptable: c.factsAcceptable,
        p_attribution_acceptable: c.attributionAcceptable,
        p_uncertainty_preserved: c.uncertaintyPreserved,
        p_headline_acceptable: c.headlineAcceptable,
        p_summary_acceptable: c.summaryAcceptable,
        p_no_unsupported_material_claims: c.noUnsupportedMaterialClaims,
        p_source_chain_acceptable: c.sourceChainAcceptable,
      })
      : await this.supabase.rpc("decide_pipeline_human_review", {
      p_review_id: input.reviewId,
      p_decision: input.decision,
      p_reviewer_id: input.reviewerId,
      p_facts_acceptable: c.factsAcceptable,
      p_attribution_acceptable: c.attributionAcceptable,
      p_uncertainty_preserved: c.uncertaintyPreserved,
      p_headline_acceptable: c.headlineAcceptable,
      p_summary_acceptable: c.summaryAcceptable,
      p_no_unsupported_material_claims: c.noUnsupportedMaterialClaims,
      p_source_chain_acceptable: c.sourceChainAcceptable,
      });
    if (response.error) throw new Error(response.error.message.match(/human_review_[a-z_]+/)?.[0] ?? "HUMAN_REVIEW_DECISION_FAILED");
    const result = record(response.data as Json, "HUMAN_REVIEW_DECISION_INVALID_RESPONSE");
    if (result.reviewId !== input.reviewId || typeof result.status !== "string") throw new Error("HUMAN_REVIEW_DECISION_INVALID_RESPONSE");
    return { reviewId: result.reviewId, status: result.status, ...(typeof result.reviewedAt === "string" ? { reviewedAt: result.reviewedAt } : {}) };
  }

  async publishReviewed(input: {
    reviewId: string;
    artifact: HumanReviewArtifact;
    authorization: HumanReviewPublicationAuthorization;
  }): Promise<AtomicPublicationResult> {
    const a = input.artifact;
    if (a.reviewId !== input.reviewId) throw new Error("HUMAN_REVIEW_ARTIFACT_ID_MISMATCH");
    assertHumanReviewPublicationTarget({
      eventKey: a.eventKey, attemptId: a.attemptId, pipelineRunId: a.pipelineRunId,
      draftId: a.draftId, draftSha256: a.draftSha256, packageSha256: a.packageSha256,
      checkpoints: a.checkpoints, sourceLineage: a.sourceLineage,
      approvalTargetRevisionSha256: input.authorization.approvalTargetRevisionSha256,
      authorization: input.authorization,
    });
    let publicationPayload = a.publicationPayload;
    if (input.authorization.approvalTargetKind === "HUMAN_REVISION") {
      const revision = await this.getRevision(input.reviewId);
      const revisionOther = Object.fromEntries(Object.entries(revision.corrected_publication_payload).filter(([key]) => key !== "article"));
      const originalOther = Object.fromEntries(Object.entries(a.publicationPayload).filter(([key]) => key !== "article"));
      if (revision.corrected_revision_sha256 !== input.authorization.approvalTargetRevisionSha256
        || revision.corrected_revision_sha256 !== input.authorization.approvedRevisionSha256
        || revision.attempt_id !== a.attemptId || revision.pipeline_run_id !== a.pipelineRunId
        || revision.original_draft_sha256 !== a.draftSha256
        || revision.automated_critic_draft_sha256 !== a.draftSha256
        || revision.source_lineage_sha256 !== humanReviewSourceLineageSha256(a.sourceLineage)
        || canonicalJsonString(revision.original_draft) !== canonicalJsonString(a.draft)
        || canonicalJsonString(revision.original_publication_payload) !== canonicalJsonString(a.publicationPayload)
        || canonicalJsonString(revision.corrected_draft) !== canonicalJsonString({
          headlineEs: revision.corrected_publication_payload.article.headlineEs,
          dekEs: revision.corrected_publication_payload.article.dekEs,
          summaryEs: revision.corrected_publication_payload.article.summaryEs,
          whyItMattersEs: revision.corrected_publication_payload.article.whyItMattersEs,
          bodyEs: revision.corrected_publication_payload.article.bodyEs,
          keyPoints: revision.corrected_publication_payload.article.keyPoints,
        })
        || canonicalJsonString(revisionOther) !== canonicalJsonString(originalOther)) {
        throw new Error("HUMAN_REVIEW_APPROVED_REVISION_STALE");
      }
      publicationPayload = revision.corrected_publication_payload;
    }
    const response = await this.supabase.rpc("publish_reviewed_article_atomic", {
      p_review_id: input.reviewId,
      p_event_key: a.eventKey,
      p_attempt_id: a.attemptId,
      p_pipeline_run_id: a.pipelineRunId,
      p_draft_id: a.draftId,
      p_draft_sha256: a.draftSha256,
      p_checkpoint_hashes: a.checkpoints as unknown as Json,
      p_source_lineage: a.sourceLineage as unknown as Json,
      p_publication_payload: publicationPayload as unknown as Json,
    });
    if (response.error) throw new Error(response.error.message.match(/(?:human_review|publication)_[a-z_]+/)?.[0] ?? "HUMAN_REVIEW_PUBLISH_FAILED");
    const result = record(response.data as Json, "HUMAN_REVIEW_PUBLISH_INVALID_RESPONSE");
    if (result.humanReviewId !== input.reviewId || result.humanReviewStatus !== "PUBLISHED"
      || typeof result.eventId !== "string" || typeof result.articleId !== "string"
      || !["created", "reused"].includes(String(result.eventAction))
      || !["created", "reused", "updated"].includes(String(result.articleAction))
      || result.articleOperation !== "upsert_by_event_id"
      || typeof result.categoriesLinkedCount !== "number" || typeof result.entitiesLinkedCount !== "number"
      || typeof result.entitiesCreated !== "number" || typeof result.entitiesReused !== "number"
      || typeof result.sourcesLinkedCount !== "number" || typeof result.relationsCreated !== "number"
      || typeof result.activityRowsCreated !== "number") throw new Error("HUMAN_REVIEW_PUBLISH_INVALID_RESPONSE");
    return {
      eventId: result.eventId, articleId: result.articleId,
      eventAction: result.eventAction as AtomicPublicationResult["eventAction"],
      articleAction: result.articleAction as AtomicPublicationResult["articleAction"],
      articleOperation: "upsert_by_event_id",
      categoriesLinkedCount: result.categoriesLinkedCount, entitiesLinkedCount: result.entitiesLinkedCount,
      entitiesCreated: result.entitiesCreated, entitiesReused: result.entitiesReused,
      sourcesLinkedCount: result.sourcesLinkedCount, relationsCreated: result.relationsCreated,
      activityRowsCreated: result.activityRowsCreated,
    };
  }
}
