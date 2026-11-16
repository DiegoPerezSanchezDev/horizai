import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { SupabaseHumanReviewRepository, HumanReviewChecks, HumanReviewDecision } from "./human-review-repository.ts";
import type { SupabaseHumanReviewReadRepository, HumanReviewOperatorReadRow, HumanReviewOperatorSummaryRow } from "./human-review-read-repository.ts";
import type { SupabaseSchedulerRepository } from "../pipeline/scheduler/scheduler-repository.ts";
import { attachHumanReviewId, humanReviewCheckpointStages, readHumanReviewArtifact, verifyHumanReviewArtifact, writeHumanReviewArtifact, type HumanReviewArtifact } from "./human-review.ts";
import { canonicalJsonString } from "../pipeline/factual-remediation-continuation.ts";
import { assertDailyHumanReviewPublicationLimit, assertHumanReviewPublishable, assertHumanReviewPublicationAuthorization, type HumanReviewPublicationAuthorization } from "./human-review-policy.ts";
import { buildHumanReviewDecision } from "./human-review-operator.ts";
import { humanReviewSourceLineageSha256 } from "./human-review-source-lineage-hash.ts";

/**
 * Single source of truth for the supervised human-review operations (decide + publish).
 * Used by BOTH the `pipeline:human-review` CLI and the authenticated editorial panel, so every
 * check (package identity/hash, current checkpoints, seven review checks, expected package SHA-256,
 * two-per-UTC-day cap and the daily publication lease) is enforced identically and cannot drift.
 * I/O (Supabase, filesystem roots, clock) is injected so the rules can be tested with doubles.
 */

const reviewIdSchema = z.string().uuid();
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Order is the CLI flag order and the order shown in the panel. */
export const humanReviewCheckNames = ["facts", "attribution", "uncertainty", "headline", "summary", "unsupported-claims", "source-chain"] as const;
export type HumanReviewCheckName = (typeof humanReviewCheckNames)[number];

export function parseHumanReviewId(value: string): string {
  const parsed = reviewIdSchema.safeParse(value);
  if (!parsed.success) throw new Error("HUMAN_REVIEW_ID_MUST_BE_UUID");
  return parsed.data;
}

export function parseExpectedPackageSha256(value: string): string {
  const parsed = shaSchema.safeParse(value);
  if (!parsed.success) throw new Error("EXPECTED_PACKAGE_SHA256_MUST_BE_HEX");
  return parsed.data;
}

/** Maps explicit pass/fail verdicts for each of the seven checks to the repository shape. */
export function humanReviewChecksFromVerdicts(verdicts: Readonly<Record<HumanReviewCheckName, boolean>>): HumanReviewChecks {
  return {
    factsAcceptable: verdicts.facts,
    attributionAcceptable: verdicts.attribution,
    uncertaintyPreserved: verdicts.uncertainty,
    headlineAcceptable: verdicts.headline,
    summaryAcceptable: verdicts.summary,
    noUnsupportedMaterialClaims: verdicts["unsupported-claims"],
    sourceChainAcceptable: verdicts["source-chain"],
  };
}

export function manifestPackageSha(row: Pick<HumanReviewOperatorSummaryRow, "review_manifest">): string {
  const value = row.review_manifest.packageSha256;
  if (typeof value !== "string" || !shaSchema.safeParse(value).success) throw new Error("HUMAN_REVIEW_REMOTE_MANIFEST_INVALID");
  return value;
}

export function assertRowArtifactMatch(row: HumanReviewOperatorSummaryRow, artifact: HumanReviewArtifact, expectedSha: string): void {
  const artifactLineageSha = humanReviewSourceLineageSha256(artifact.sourceLineage);
  if (row.id !== artifact.reviewId || row.attempt_id !== artifact.attemptId || row.pipeline_run_id !== artifact.pipelineRunId
    || row.event_key !== artifact.eventKey || row.draft_id !== artifact.draftId || row.draft_sha256 !== artifact.draftSha256
    || manifestPackageSha(row) !== expectedSha || artifact.packageSha256 !== expectedSha
    || row.source_lineage_sha256 !== artifactLineageSha
    || canonicalJsonString(row.review_manifest.checkpoints) !== canonicalJsonString(artifact.checkpoints)
    || row.review_manifest.eventKey !== artifact.eventKey || row.review_manifest.attemptId !== artifact.attemptId
    || row.review_manifest.pipelineRunId !== artifact.pipelineRunId || row.review_manifest.draftId !== artifact.draftId
    || row.review_manifest.draftSha256 !== artifact.draftSha256
    || row.review_manifest.sourceLineageSha256 !== artifactLineageSha
    || row.review_manifest.publicationPayloadSha256 !== row.publication_payload_sha256
    || row.review_manifest.manifestSha256 !== artifact.reviewManifest.manifestSha256
    || !verifyHumanReviewArtifact(artifact)) {
    throw new Error("HUMAN_REVIEW_PACKAGE_IDENTITY_OR_HASH_STALE");
  }
}

function checkpointPart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180); }

/** Builds the exact publication authorization from an APPROVED row; throws HUMAN_APPROVAL_REQUIRED otherwise. */
export function buildPublicationAuthorization(row: HumanReviewOperatorReadRow, artifact: HumanReviewArtifact, publishedToday: number): HumanReviewPublicationAuthorization {
  if (row.status !== "APPROVED" || row.reviewer_approved !== true || row.critic_pass !== true || row.provider_usage_settled !== true
    || row.facts_acceptable !== true || row.attribution_acceptable !== true || row.uncertainty_preserved !== true
    || row.headline_acceptable !== true || row.summary_acceptable !== true || row.no_unsupported_material_claims !== true
    || row.source_chain_acceptable !== true || row.consumed_at !== null || row.published_article_id !== null) {
    throw new Error("HUMAN_APPROVAL_REQUIRED");
  }
  const lineageCurrent = canonicalJsonString(row.source_lineage) === canonicalJsonString(artifact.sourceLineage);
  const manifestCurrent = canonicalJsonString(row.review_manifest.checkpoints) === canonicalJsonString(artifact.checkpoints)
    && row.review_manifest.manifestSha256 === artifact.reviewManifest.manifestSha256;
  if (!lineageCurrent || !manifestCurrent) throw new Error("HUMAN_APPROVAL_REQUIRED");
  const authorization: HumanReviewPublicationAuthorization = {
    action: "APPROVE", status: "APPROVED", eventKey: row.event_key, attemptId: row.attempt_id,
    pipelineRunId: row.pipeline_run_id, draftId: row.draft_id, draftSha256: row.draft_sha256,
    packageSha256: manifestPackageSha(row), checkpoints: artifact.checkpoints, sourceLineage: artifact.sourceLineage,
    criticPass: true, usageSettled: true, factualReviewPassed: true, attributionReviewPassed: true,
    uncertaintyReviewPassed: true, headlineReviewPassed: true, summaryReviewPassed: true,
    noUnsupportedMaterialClaims: true, sourceChainPassed: true,
    approvalTargetKind: row.approval_target_kind,
    approvalTargetRevisionSha256: row.approval_target_revision_sha256,
    approvedRevisionSha256: row.approved_revision_sha256,
    lineageCurrent: true,
    manifestCurrent: true,
    approvalConsumed: false,
    publishedToday,
  };
  assertHumanReviewPublicationAuthorization(authorization);
  return authorization;
}

export type HumanReviewOperationsDeps = {
  readRepository: Pick<SupabaseHumanReviewReadRepository, "inspect">;
  decisionRepository: Pick<SupabaseHumanReviewRepository, "decide" | "publishReviewed">;
  scheduler: Pick<SupabaseSchedulerRepository, "acquire" | "finish" | "release">;
  artifactRoot: string;
  checkpointRoot: string;
  now?: () => Date;
  newOwnerRunId?: () => string;
};

export type HumanReviewDecisionRequest = {
  reviewId: string;
  decision: HumanReviewDecision;
  reviewerId: string;
  expectedPackageSha256: string;
  checks: HumanReviewChecks;
  /** Required for APPROVE of a HUMAN_REVISION target; forbidden otherwise. */
  expectedRevisionSha256?: string;
};

export function createHumanReviewOperations(deps: HumanReviewOperationsDeps) {
  const now = deps.now ?? (() => new Date());
  const newOwnerRunId = deps.newOwnerRunId ?? randomUUID;

  async function loadArtifactBoundToRow(row: HumanReviewOperatorSummaryRow): Promise<HumanReviewArtifact> {
    let artifact = await readHumanReviewArtifact(deps.artifactRoot, row.attempt_id);
    const exactRowBinding = row.attempt_id === artifact.attemptId && row.pipeline_run_id === artifact.pipelineRunId
      && row.event_key === artifact.eventKey && row.draft_id === artifact.draftId && row.draft_sha256 === artifact.draftSha256
      && row.source_lineage_sha256 === humanReviewSourceLineageSha256(artifact.sourceLineage)
      && row.publication_payload_sha256 === row.review_manifest.publicationPayloadSha256
      && manifestPackageSha(row) === artifact.packageSha256 && verifyHumanReviewArtifact(artifact);
    if (artifact.reviewId === null && exactRowBinding) {
      artifact = attachHumanReviewId(artifact, row.id);
      await writeHumanReviewArtifact(deps.artifactRoot, artifact);
    }
    return artifact;
  }

  async function assertCurrentCheckpoints(artifact: HumanReviewArtifact): Promise<void> {
    const root = resolve(deps.checkpointRoot);
    for (const stage of humanReviewCheckpointStages) {
      const path = join(root, checkpointPart(artifact.pipelineRunId), `${checkpointPart(stage)}-${checkpointPart(artifact.eventKey)}.json`);
      const bytes = await readFile(path);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== artifact.checkpoints[stage].sha256) throw new Error(`HUMAN_REVIEW_CHECKPOINT_STALE:${stage}`);
    }
  }

  async function loadVerifiedReview(reviewId: string, expectedSha: string, requiredStatuses?: readonly string[]): Promise<{ row: HumanReviewOperatorReadRow; artifact: HumanReviewArtifact; publishedToday: number }> {
    const inspection = await deps.readRepository.inspect(reviewId);
    const row = inspection.review;
    if (!inspection.found || !row) throw new Error("HUMAN_REVIEW_NOT_FOUND");
    if (requiredStatuses && !requiredStatuses.includes(row.status)) throw new Error(`HUMAN_REVIEW_STATUS_NOT_ALLOWED:${row.status}`);
    const artifact = await loadArtifactBoundToRow(row);
    assertRowArtifactMatch(row, artifact, expectedSha);
    await assertCurrentCheckpoints(artifact);
    return { row, artifact, publishedToday: inspection.publishedToday };
  }

  async function decide(request: HumanReviewDecisionRequest): Promise<{ reviewId: string; status: string; reviewedAt?: string }> {
    const reviewId = parseHumanReviewId(request.reviewId);
    const expectedSha = parseExpectedPackageSha256(request.expectedPackageSha256);
    const { row } = await loadVerifiedReview(reviewId, expectedSha, ["WAITING_FOR_HUMAN_REVIEW", "HOLD"]);
    let approvalTargetRevisionSha256: string | null | undefined;
    if (request.decision === "APPROVE" && row.approval_target_kind === "HUMAN_REVISION") {
      if (!request.expectedRevisionSha256) throw new Error("HUMAN_REVIEW_EXPECTED_REVISION_SHA256_REQUIRED");
      approvalTargetRevisionSha256 = parseExpectedPackageSha256(request.expectedRevisionSha256);
      if (approvalTargetRevisionSha256 !== row.approval_target_revision_sha256) throw new Error("HUMAN_REVIEW_APPROVAL_REVISION_HASH_STALE");
    } else if (request.expectedRevisionSha256 !== undefined) {
      throw new Error("HUMAN_REVIEW_REVISION_HASH_NOT_EXPECTED");
    }
    const mutation = buildHumanReviewDecision({ reviewId, row, decision: request.decision, reviewerId: request.reviewerId, checks: request.checks });
    return deps.decisionRepository.decide({ ...mutation, approvalTargetRevisionSha256 });
  }

  /** One or two distinct approved reviews under one daily lease. */
  async function publishApproved(
    idsArg: readonly string[],
    hashesArg: readonly string[],
    onPublished?: (published: { reviewId: string; articleId: string }) => void,
  ): Promise<Array<{ reviewId: string; articleId: string }>> {
    const ids = idsArg.map(parseHumanReviewId);
    const hashes = hashesArg.map(parseExpectedPackageSha256);
    if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length || hashes.length !== ids.length) throw new Error("PUBLISH_APPROVED_REQUIRES_ONE_OR_TWO_DISTINCT_ID_HASH_PAIRS");
    const prepared: Array<{ reviewId: string; expectedSha: string }> = [];
    for (let index = 0; index < ids.length; index += 1) {
      const item = await loadVerifiedReview(ids[index]!, hashes[index]!, ["APPROVED"]);
      assertHumanReviewPublishable(item.row.status);
      assertDailyHumanReviewPublicationLimit(item.publishedToday, ids.length);
      prepared.push({ reviewId: ids[index]!, expectedSha: hashes[index]! });
    }

    const scheduler = deps.scheduler;
    const startedAt = now();
    const date = startedAt.toISOString().slice(0, 10);
    const triggerId = `supervised-human-review-publish:${date}`;
    const ownerRunId = newOwnerRunId();
    const endOfDay = new Date(`${date}T23:59:59.999Z`);
    const lease = await scheduler.acquire({
      triggerId, ownerRunId, invocationType: "manual", scheduleDateUtc: date, slot: "morning",
      schedulingTimezone: "UTC", scheduledAt: startedAt.toISOString(), requestDateUtc: date,
      now: startedAt.toISOString(), expiresAt: endOfDay.toISOString(), quotaUsed: 0,
      quotaRemaining: 0, maxEventsPerRun: 2, automaticRevision: false, dryRun: true, publish: false,
    });
    if (lease.status !== "acquired" && lease.status !== "expired") throw new Error(`HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT_OR_MUTEX:${lease.status}`);

    let finished = false;
    const published: Array<{ reviewId: string; articleId: string }> = [];
    try {
      for (const item of prepared) {
        const fresh = await loadVerifiedReview(item.reviewId, item.expectedSha, ["APPROVED"]);
        assertHumanReviewPublishable(fresh.row.status);
        assertDailyHumanReviewPublicationLimit(fresh.publishedToday, prepared.length - published.length);
        const authorization = buildPublicationAuthorization(fresh.row, fresh.artifact, fresh.publishedToday);
        const result = await deps.decisionRepository.publishReviewed({ reviewId: fresh.row.id, artifact: fresh.artifact, authorization });
        const entry = { reviewId: fresh.row.id, articleId: result.articleId };
        published.push(entry);
        onPublished?.(entry);
      }
      const ok = await scheduler.finish({ triggerId, ownerRunId, runStatus: "succeeded", finalDecision: "allowed", stopReason: null, quotaUsed: 0, quotaRemaining: 0, finishedAt: now().toISOString() });
      if (!ok) throw new Error("HUMAN_REVIEW_PUBLICATION_LEASE_FINALIZE_NOT_OWNED");
      finished = true;
    } finally {
      if (!finished) await scheduler.finish({ triggerId, ownerRunId, runStatus: "failed", finalDecision: "failed", stopReason: published.length ? "HUMAN_REVIEW_PUBLICATION_BATCH_PARTIAL" : "HUMAN_REVIEW_PUBLICATION_FAILED", quotaUsed: 0, quotaRemaining: 0, finishedAt: now().toISOString() }).catch(() => false);
      await scheduler.release({ triggerId, ownerRunId, releasedAt: now().toISOString() }).catch(() => false);
    }
    return published;
  }

  return { loadArtifactBoundToRow, assertCurrentCheckpoints, loadVerifiedReview, decide, publishApproved };
}

export type HumanReviewOperations = ReturnType<typeof createHumanReviewOperations>;
