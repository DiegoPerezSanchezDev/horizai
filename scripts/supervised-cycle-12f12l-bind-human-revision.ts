import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { SupabaseHumanReviewRepository } from "../lib/agents/publisher/human-review-repository.ts";
import { readSafeCriticPipelineCheckpoint } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { humanReviewSourceLineageSha256 } from "../lib/agents/publisher/human-review-source-lineage-hash.ts";
import { readHumanReviewArtifact, humanReviewCheckpointStages, verifyHumanReviewArtifact } from "../lib/agents/publisher/human-review.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { buildHumanRevisionBinding, verifyHumanRevisionBinding } from "../lib/agents/publisher/human-review-revision.ts";
import { canonicalJsonString } from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { assertRowArtifactMatch } from "./pipeline-human-review.ts";
import { isSafeRpcFailureError, normalizeSafeRpcFailure } from "../lib/supabase/safe-rpc-error.ts";

const target = {
  reviewId: "ebd8acc0-76a2-4977-81d9-60a7f6240084",
  attemptId: "4658d5c0-857c-4ed5-b97f-afb133b2bf22",
  pipelineRunId: "f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d",
  eventKey: "event-5c7d0ef5ea6f72bec96704aded750851",
};
const auditPath = "artifacts/supervised-cycle-12f12k-editorial-remediation.json";
const draftPath = "artifacts/supervised-cycle-12f12k-corrected-draft.md";
const artifactPath = `artifacts/human-review-packages/${target.attemptId}.json`;
const checkpointRoot = `artifacts/pipeline-checkpoints/${target.pipelineRunId}`;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  const auditBytes = readFileSync(auditPath);
  const audit = JSON.parse(auditBytes.toString("utf8")) as Record<string, unknown>;
  const markdown = readFileSync(draftPath, "utf8");
  const artifact = await readHumanReviewArtifact("artifacts/human-review-packages", target.attemptId);
  assert.equal(artifact.reviewId, target.reviewId);
  assert.equal(artifact.attemptId, target.attemptId);
  assert.equal(artifact.pipelineRunId, target.pipelineRunId);
  assert.equal(artifact.eventKey, target.eventKey);
  assert.equal(verifyHumanReviewArtifact(artifact), true);
  const binding = buildHumanRevisionBinding({ markdown, audit, auditBytes, artifact, auditedAt: new Date().toISOString() });
  assert.equal(verifyHumanRevisionBinding(binding), true);
  assert.equal(binding.sourceLineageSha256, humanReviewSourceLineageSha256(artifact.sourceLineage));
  const originalArtifactBytesSha256 = sha(readFileSync(artifactPath));

  const supabase = createSupabaseServerClient();
  const originalFetch = globalThis.fetch;
  const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;
  const calls: Array<{ method: string; endpoint: string; httpStatus: number }> = [];
  const requestAttempts: Array<{ method: string; endpoint: string }> = [];
  const readRpcs = new Set([
    "get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator",
    "get_pipeline_human_review_operator_inspect", "get_pipeline_human_review_revision",
  ]);
  const readTables = new Set(["articles", "agent_logs", "agent_runs"]);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, origin, "SUPABASE_ORIGIN_REQUIRED");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "rest" || parts[1] !== "v1") throw new Error("SUPABASE_REST_ONLY");
    let allowedWrite = false;
    if (parts[2] === "rpc") {
      const rpc = parts[3];
      if (rpc === "bind_pipeline_human_review_revision") {
        assert.equal(request.method, "POST");
        const body = await request.clone().json() as Record<string, unknown>;
        assert.equal(body.p_review_id, target.reviewId);
        allowedWrite = true;
      } else {
        assert.equal(parts.length, 4);
        assert.equal(request.method, "POST");
        assert.ok(readRpcs.has(rpc), "READ_ONLY_RPC_ALLOWLIST");
        if (rpc === "get_pipeline_human_review_operator_inspect" || rpc === "get_pipeline_human_review_revision") {
          assert.equal((await request.clone().json() as Record<string, unknown>).p_review_id, target.reviewId);
        }
      }
    } else {
      assert.equal(parts.length, 3);
      assert.ok(readTables.has(parts[2]!), "READ_ONLY_TABLE_ALLOWLIST");
      assert.ok(["GET", "HEAD"].includes(request.method), "REMOTE_TABLE_READ_ONLY");
    }
    if (allowedWrite) assert.equal(calls.filter((call) => call.endpoint.endsWith("/bind_pipeline_human_review_revision")).length, 0, "ONE_REVISION_WRITE_ONLY");
    requestAttempts.push({ method: request.method, endpoint: url.pathname });
    const response = await originalFetch(request);
    calls.push({ method: request.method, endpoint: url.pathname, httpStatus: response.status });
    return response;
  };

  try {
    const readRepository = new SupabaseHumanReviewReadRepository(supabase);
    const beforeInspection = await readRepository.inspect(target.reviewId);
    assert.equal(beforeInspection.found, true);
    const before = beforeInspection.review!;
    assertRowArtifactMatch(before, artifact, artifact.packageSha256);
    assert.deepEqual([before.id, before.status, before.consumed_at, before.approval_target_kind, before.approval_target_revision_id],
      [target.reviewId, "WAITING_FOR_HUMAN_REVIEW", null, "ORIGINAL", null]);
    assert.equal(before.source_lineage_sha256, binding.sourceLineageSha256);
    const statusBefore = await readRepository.status();
    const listBefore = await readRepository.list(500);
    assert.deepEqual([statusBefore.totalReviews, statusBefore.waitingReviews, statusBefore.consumedReviews, listBefore.reviews.length], [1, 1, 0, 1]);
    const revisionBeforeResponse = await supabase.rpc("get_pipeline_human_review_revision", { p_review_id: target.reviewId });
    assert.equal(revisionBeforeResponse.error, null);
    assert.equal(typeof revisionBeforeResponse.data, "object");
    assert.equal((revisionBeforeResponse.data as Record<string, unknown>).found, false, "HUMAN_REVISION_MUST_BE_ABSENT_BEFORE_BIND");

    humanReviewCheckpointStages.forEach((stage) => {
      const path = `${checkpointRoot}/${stage}-${target.eventKey}.json`;
      const hash = sha(readFileSync(path));
      assert.equal(hash, artifact.checkpoints[stage].sha256, `CHECKPOINT_CHANGED:${stage}`);
    });
    const criticPath = `${checkpointRoot}/critic-${target.eventKey}.json`;
    const critic = await readSafeCriticPipelineCheckpoint(criticPath);
    assert.deepEqual([critic.attemptId, critic.eventKey, critic.critic.decision], [target.attemptId, target.eventKey, "pass"]);
    const criticCheckpointSha256 = sha(readFileSync(criticPath));
    assert.equal(criticCheckpointSha256, artifact.checkpoints.critic.sha256);

    const publicBefore = await supabase.from("articles").select("*").eq("publication_status", "published");
    assert.equal(publicBefore.error, null);
    const publicBeforeRows = publicBefore.data ?? [];
    assert.equal(publicBeforeRows.length, 2);
    const fingerprintsBefore = publicBeforeRows.map((row) => ({ id: row.id, sha256: publicArticleFingerprintV1(row) })).sort((a, b) => a.id.localeCompare(b.id));
    const previous = JSON.parse(readFileSync("artifacts/supervised-cycle-12f12j-after.json", "utf8")) as { fingerprints: typeof fingerprintsBefore; providerDailyUsage: Record<string, unknown> };
    assert.deepEqual(fingerprintsBefore, previous.fingerprints);
    const logger = new SupabaseAgentLogger(supabase);
    const providers = ["groq", "cerebras", "cloudflare_workers_ai"] as const;
    const usageBefore = Object.fromEntries(await Promise.all(providers.map(async (provider) => [provider, await logger.getProviderDailyUsage(provider, "2026-10-20")])));
    assert.deepEqual(usageBefore, previous.providerDailyUsage);

    if (process.argv.includes("--preflight-only")) {
      console.log(JSON.stringify({
        status: "PREFLIGHT_PASS",
        review: { id: before.id, status: before.status, consumed: before.consumed_at !== null, approvalTargetKind: before.approval_target_kind },
        originalDraftSha256: artifact.draftSha256,
        correctedRevisionSha256: binding.correctedRevisionSha256,
        sourceLineageSha256: binding.sourceLineageSha256,
        criticM34OriginalProof: { pass: critic.critic.decision === "pass", checkpointSha256: criticCheckpointSha256 },
        publicCount: publicBeforeRows.length,
        providerUsageUnchanged: JSON.stringify(usageBefore) === JSON.stringify(previous.providerDailyUsage),
        revisionAbsent: (revisionBeforeResponse.data as Record<string, unknown>).found === false,
        remoteWrites: 0,
      }, null, 2));
      return;
    }

    let revisionWrite;
    try {
      revisionWrite = await new SupabaseHumanReviewRepository(supabase).bindRevision({ reviewId: target.reviewId, artifact, binding });
    } catch (error) {
      const exactSafeRpcFailure = isSafeRpcFailureError(error)
        ? error.rpcFailure
        : normalizeSafeRpcFailure("bind_pipeline_human_review_revision", error);
      const postFailure: Record<string, unknown> = {};
      let afterFailureReview: Awaited<ReturnType<typeof readRepository.inspect>>["review"] | null = null;
      let afterFailureRevision: Record<string, unknown> | null = null;
      try {
        const inspection = await readRepository.inspect(target.reviewId);
        const review = inspection.review;
        afterFailureReview = review;
        postFailure.review = review ? {
          id: review.id,
          status: review.status,
          consumed: review.consumed_at !== null,
          approvalTargetKind: review.approval_target_kind,
          approvalTargetRevisionId: review.approval_target_revision_id,
          approvalTargetRevisionSha256: review.approval_target_revision_sha256,
          originalDraftSha256: review.draft_sha256,
          sourceLineageSha256: review.source_lineage_sha256,
          unchangedFromOriginalApprovalState: review.status === "WAITING_FOR_HUMAN_REVIEW"
            && review.consumed_at === null && review.approval_target_kind === "ORIGINAL"
            && review.approval_target_revision_id === null && review.approval_target_revision_sha256 === null
            && review.draft_sha256 === artifact.draftSha256
            && review.source_lineage_sha256 === binding.sourceLineageSha256,
        } : null;
      } catch (readError) {
        postFailure.reviewReadError = normalizeSafeRpcFailure("get_pipeline_human_review_operator_inspect", readError);
      }
      try {
        const revisionRead = await supabase.rpc("get_pipeline_human_review_revision", { p_review_id: target.reviewId });
        if (revisionRead.error) {
          postFailure.revisionRead = { error: normalizeSafeRpcFailure("get_pipeline_human_review_revision", revisionRead.error, { httpStatus: revisionRead.status }) };
        } else {
          const readData = typeof revisionRead.data === "object" && revisionRead.data !== null && !Array.isArray(revisionRead.data)
            ? revisionRead.data as Record<string, unknown> : null;
          const revisionFound = readData?.found === true;
          afterFailureRevision = revisionFound && typeof readData?.revision === "object" && readData.revision !== null
            && !Array.isArray(readData.revision) ? readData.revision as Record<string, unknown> : null;
          const revision = afterFailureRevision;
          postFailure.revisionRead = {
            found: revisionFound,
            revisionCount: revisionFound ? 1 : 0,
            revisionId: typeof revision?.id === "string" ? revision.id : null,
            revisionVersion: revision?.revision_version ?? null,
            originalDraftSha256: revision?.original_draft_sha256 ?? null,
            correctedRevisionSha256: revision?.corrected_revision_sha256 ?? null,
            sourceLineageSha256: revision?.source_lineage_sha256 ?? null,
            automatedCriticDraftSha256: revision?.automated_critic_draft_sha256 ?? null,
            attemptId: revision?.attempt_id ?? null,
            pipelineRunId: revision?.pipeline_run_id ?? null,
          };
        }
      } catch (readError) {
        postFailure.revisionReadError = normalizeSafeRpcFailure("get_pipeline_human_review_revision", readError);
      }
      try {
        const publicAfterFailure = await supabase.from("articles").select("*").eq("publication_status", "published");
        if (publicAfterFailure.error) {
          postFailure.publicReadError = normalizeSafeRpcFailure("published_articles_read", publicAfterFailure.error, { httpStatus: publicAfterFailure.status });
        } else {
          const rows = publicAfterFailure.data ?? [];
          const fingerprints = rows.map((row) => ({ id: row.id, sha256: publicArticleFingerprintV1(row) }))
            .sort((a, b) => a.id.localeCompare(b.id));
          postFailure.publicCount = rows.length;
          postFailure.publicFingerprintsUnchanged = JSON.stringify(fingerprints) === JSON.stringify(fingerprintsBefore);
        }
      } catch (readError) {
        postFailure.publicReadError = normalizeSafeRpcFailure("published_articles_read", readError);
      }
      try {
        const usageAfterFailure = Object.fromEntries(await Promise.all(providers.map(async (provider) => [
          provider, await logger.getProviderDailyUsage(provider, "2026-10-20"),
        ])));
        postFailure.providerUsageUnchanged = JSON.stringify(usageAfterFailure) === JSON.stringify(usageBefore);
      } catch {
        postFailure.providerUsageUnchanged = null;
      }

      const committedResponseFailure = Boolean(afterFailureReview && afterFailureRevision
        && afterFailureReview.status === "WAITING_FOR_HUMAN_REVIEW" && afterFailureReview.consumed_at === null
        && afterFailureReview.approval_target_kind === "HUMAN_REVISION"
        && afterFailureReview.approval_target_revision_id === afterFailureRevision.id
        && afterFailureReview.approval_target_revision_sha256 === binding.correctedRevisionSha256
        && afterFailureReview.draft_sha256 === artifact.draftSha256
        && afterFailureReview.source_lineage_sha256 === binding.sourceLineageSha256
        && afterFailureRevision.revision_version === 1
        && afterFailureRevision.review_id === target.reviewId
        && afterFailureRevision.attempt_id === target.attemptId
        && afterFailureRevision.pipeline_run_id === target.pipelineRunId
        && afterFailureRevision.original_draft_sha256 === artifact.draftSha256
        && afterFailureRevision.corrected_revision_sha256 === binding.correctedRevisionSha256
        && afterFailureRevision.source_lineage_sha256 === binding.sourceLineageSha256
        && afterFailureRevision.automated_critic_draft_sha256 === artifact.draftSha256);

      if (committedResponseFailure) {
        let revisionValidated = false;
        let publisherTargetProof: Record<string, unknown> | null = null;
        try {
          const revision = await new SupabaseHumanReviewRepository(supabase).getRevision(target.reviewId);
          assert.deepEqual(revision.original_draft, artifact.draft);
          assert.deepEqual(revision.original_publication_payload, artifact.publicationPayload);
          assert.deepEqual(revision.corrected_draft, binding.correctedDraft);
          assert.deepEqual(revision.corrected_publication_payload, binding.correctedPublicationPayload);
          revisionValidated = true;
          publisherTargetProof = {
            approvalTargetKind: afterFailureReview!.approval_target_kind,
            approvalTargetRevisionSha256: afterFailureReview!.approval_target_revision_sha256,
            boundRevisionSha256: revision.corrected_revision_sha256,
            correctedPublicationPayloadMatchesBinding: canonicalJsonString(revision.corrected_publication_payload) === canonicalJsonString(binding.correctedPublicationPayload),
            publisherSelection: "SupabaseHumanReviewRepository.publishAtomic reads getRevision and selects corrected_publication_payload for HUMAN_REVISION authorization",
            approvalOrPublicationExecuted: false,
          };
        } catch (revisionValidationError) {
          postFailure.revisionValidationError = normalizeSafeRpcFailure("get_pipeline_human_review_revision_final_validation", revisionValidationError);
        }
        const finalValidation = {
          revisionValidated,
          publicCount: postFailure.publicCount ?? null,
          publicFingerprintsUnchanged: postFailure.publicFingerprintsUnchanged === true,
          providerUsageUnchanged: postFailure.providerUsageUnchanged === true,
          publisherTargetProof,
        };
        const committedResult = {
          phase: "12F.12N",
          capturedAtUtc: new Date().toISOString(),
          target,
          migration: "M38",
          bindAttemptCount: 1,
          bindResult: "BIND_COMMITTED_RESPONSE_FAILED",
          exactSafeRpcFailure,
          revisionWrite: { rpcCalls: requestAttempts.filter((request) => request.endpoint.endsWith("/bind_pipeline_human_review_revision")).length,
            revisionId: afterFailureRevision!.id, revisionVersion: afterFailureRevision!.revision_version, reused: null },
          originalDraftSha256: artifact.draftSha256,
          correctedRevisionSha256: binding.correctedRevisionSha256,
          sourceLineageSha256: binding.sourceLineageSha256,
          reviewValidation: postFailure.review,
          finalValidation,
          postFailureRead: postFailure,
          providerCalls: 0,
          pipelineRuns: 0,
          publisher: "NOT RUN",
          decisions: { approve: 0, hold: 0, reject: 0 },
          remoteWriteAttempts: requestAttempts.filter((request) => request.endpoint.endsWith("/bind_pipeline_human_review_revision")).length,
          committed: true,
          requestAttempts,
          requests: calls,
        };
        writeFileSync("artifacts/supervised-cycle-12f12n-dns-bind.json", `${JSON.stringify(committedResult, null, 2)}\n`, "utf8");
        console.log(JSON.stringify(committedResult, null, 2));
        return;
      }

      const failureResult = {
        phase: "12F.12N",
        capturedAtUtc: new Date().toISOString(),
        target,
        bindAttemptCount: 1,
        bindResult: "FAIL",
        exactSafeRpcFailure,
        postFailureRead: postFailure,
        providerCalls: 0,
        pipelineRuns: 0,
        publisher: "NOT RUN",
        decisions: { approve: 0, hold: 0, reject: 0 },
        remoteWriteAttempts: requestAttempts.filter((request) => request.endpoint.endsWith("/bind_pipeline_human_review_revision")).length,
        committed: false,
        requestAttempts,
        requests: calls,
      };
      writeFileSync("artifacts/supervised-cycle-12f12n-dns-bind.json", `${JSON.stringify(failureResult, null, 2)}\n`, "utf8");
      console.log(JSON.stringify(failureResult, null, 2));
      process.exitCode = 1;
      return;
    }
    assert.equal(revisionWrite.reused, false);
    assert.equal(revisionWrite.revisionSha256, binding.correctedRevisionSha256);

    const afterInspection = await readRepository.inspect(target.reviewId);
    assert.equal(afterInspection.found, true);
    const after = afterInspection.review!;
    assert.deepEqual([after.id, after.status, after.consumed_at, after.approval_target_kind, after.approval_target_revision_id, after.approval_target_revision_sha256],
      [target.reviewId, "WAITING_FOR_HUMAN_REVIEW", null, "HUMAN_REVISION", revisionWrite.revisionId, binding.correctedRevisionSha256]);
    assert.equal(after.draft_sha256, artifact.draftSha256);
    assert.equal(after.source_lineage_sha256, binding.sourceLineageSha256);
    assert.equal(after.review_manifest.checkpoints.critic.sha256, criticCheckpointSha256);
    const revision = await new SupabaseHumanReviewRepository(supabase).getRevision(target.reviewId);
    assert.deepEqual([revision.id, revision.review_id, revision.attempt_id, revision.pipeline_run_id,
      revision.original_draft_sha256, revision.corrected_revision_sha256, revision.source_lineage_sha256,
      revision.automated_critic_draft_sha256, revision.human_revision_proof.actorClass,
      revision.human_revision_proof.automatedCriticScope],
    [revisionWrite.revisionId, target.reviewId, target.attemptId, target.pipelineRunId,
      artifact.draftSha256, binding.correctedRevisionSha256, binding.sourceLineageSha256,
      artifact.draftSha256, "HUMAN_OPERATOR", "ORIGINAL_DRAFT_ONLY"]);
    assert.deepEqual(revision.original_draft, artifact.draft);
    assert.deepEqual(revision.original_publication_payload, artifact.publicationPayload);
    assert.deepEqual(revision.corrected_draft, binding.correctedDraft);
    assert.deepEqual(revision.corrected_publication_payload, binding.correctedPublicationPayload);

    const publisherTargetProof = {
      approvalTargetKind: after.approval_target_kind,
      approvalTargetRevisionSha256: after.approval_target_revision_sha256,
      boundRevisionSha256: revision.corrected_revision_sha256,
      correctedPublicationPayloadMatchesBinding: canonicalJsonString(revision.corrected_publication_payload) === canonicalJsonString(binding.correctedPublicationPayload),
      publisherSelection: "SupabaseHumanReviewRepository.publishAtomic reads getRevision and selects corrected_publication_payload for HUMAN_REVISION authorization",
      approvalOrPublicationExecuted: false,
    };
    assert.deepEqual([publisherTargetProof.approvalTargetKind, publisherTargetProof.approvalTargetRevisionSha256,
      publisherTargetProof.boundRevisionSha256, publisherTargetProof.correctedPublicationPayloadMatchesBinding],
    ["HUMAN_REVISION", binding.correctedRevisionSha256, binding.correctedRevisionSha256, true]);

    const publicAfter = await supabase.from("articles").select("*").eq("publication_status", "published");
    assert.equal(publicAfter.error, null);
    const publicAfterRows = publicAfter.data ?? [];
    const fingerprintsAfter = publicAfterRows.map((row) => ({ id: row.id, sha256: publicArticleFingerprintV1(row) })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(fingerprintsAfter, fingerprintsBefore);
    const usageAfter = Object.fromEntries(await Promise.all(providers.map(async (provider) => [provider, await logger.getProviderDailyUsage(provider, "2026-10-20")])));
    assert.deepEqual(usageAfter, usageBefore);
    assert.equal(requestAttempts.filter((request) => request.endpoint.endsWith("/bind_pipeline_human_review_revision")).length, 1);
    assert.equal(calls.filter((call) => call.endpoint.endsWith("/bind_pipeline_human_review_revision")).length, 1);
    const result = {
      phase: "12F.12N",
      capturedAtUtc: new Date().toISOString(),
      target,
      migration: "M38",
      revisionWrite: { rpcCalls: 1, revisionId: revisionWrite.revisionId, revisionVersion: 1, reused: false },
      originalDraftSha256: artifact.draftSha256,
      correctedRevisionSha256: binding.correctedRevisionSha256,
      sourceLineageSha256: binding.sourceLineageSha256,
      humanRevisionProof: revision.human_revision_proof,
      reviewValidation: { id: after.id, status: after.status, consumed: after.consumed_at !== null, approvalTargetKind: after.approval_target_kind, approvalTargetRevisionId: after.approval_target_revision_id, approvalTargetRevisionSha256: after.approval_target_revision_sha256 },
      originalDraftPreserved: sha(readFileSync(artifactPath)) === originalArtifactBytesSha256 && revision.original_draft_sha256 === artifact.draftSha256,
      correctedRevisionPreserved: sha(canonicalJsonString(revision.corrected_draft)) === binding.correctedRevisionSha256,
      sourceLineageUnchanged: after.source_lineage_sha256 === before.source_lineage_sha256,
      criticM34OriginalProof: { pass: critic.critic.decision === "pass", draftSha256: revision.automated_critic_draft_sha256, checkpointSha256: criticCheckpointSha256 },
      publisherTargetProof,
      public: publicAfterRows.length,
      publicFingerprintsUnchanged: JSON.stringify(fingerprintsAfter) === JSON.stringify(fingerprintsBefore),
      providerCalls: 0,
      providerUsageUnchanged: JSON.stringify(usageAfter) === JSON.stringify(usageBefore),
      publisher: "NOT RUN",
      decisions: { approve: 0, hold: 0, reject: 0 },
      remoteWrites: 1,
      requestAttempts,
      requests: calls,
    };
    writeFileSync("artifacts/supervised-cycle-12f12n-dns-bind.json", `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch((error: unknown) => {
  if (isSafeRpcFailureError(error)) {
    console.error(JSON.stringify({ status: "RPC_FAILED", rpcFailure: error.rpcFailure }, null, 2));
  } else {
    const safe = normalizeSafeRpcFailure("supervised-cycle-12f12n", error);
    console.error(JSON.stringify({ status: "RUNNER_FAILED", rpcFailure: safe }, null, 2));
  }
  process.exitCode = 1;
});
