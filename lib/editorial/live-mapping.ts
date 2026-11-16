import { canonicalJsonString } from "../agents/pipeline/factual-remediation-continuation.ts";
import type { HumanReviewArtifact } from "../agents/publisher/human-review.ts";
import { humanReviewSourceLineageSha256 } from "../agents/publisher/human-review-source-lineage-hash.ts";
import { humanReviewPublicationPayloadSha256 } from "../agents/publisher/human-review-jsonb-hash.ts";
import { humanReviewRevisionRecordSchema, verifyHumanReviewRevisionRecord } from "../agents/publisher/human-review-revision.ts";
import type { HumanReviewOperatorReadRow, HumanReviewOperatorSummaryRow } from "../agents/publisher/human-review-read-repository.ts";
import { editorialEvidenceSchema, editorialReviewDetailSchema, editorialReviewSchema, isWaitingReview, toReviewSummary, type EditorialEvidence, type EditorialReview, type EditorialReviewDetail } from "./review.ts";

export class EditorialLiveDataError extends Error {
  readonly code: "M32_UNAVAILABLE" | "REVIEW_NOT_FOUND" | "REVIEW_INVALID";
  constructor(code: "M32_UNAVAILABLE" | "REVIEW_NOT_FOUND" | "REVIEW_INVALID") {
    super(code);
    this.code = code;
    this.name = "EditorialLiveDataError";
  }
}

function fail(): never { throw new EditorialLiveDataError("REVIEW_INVALID"); }

function bodyBlocks(markdown: string): EditorialReview["body"] {
  const blocks: EditorialReview["body"] = [];
  for (const chunk of markdown.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean)) {
    const heading = /^#{1,3}\s+(.+)$/.exec(chunk);
    if (heading) blocks.push({ kind: "heading", text: heading[1].trim() });
    else blocks.push({ kind: "paragraph", text: chunk.replace(/\r?\n/g, " ").trim() });
  }
  return blocks;
}

function countryName(code: string | null): string | null {
  if (!code) return null;
  try { return new Intl.DisplayNames(["es"], { type: "region" }).of(code) ?? code; }
  catch { return code; }
}

function bindingIsValid(row: HumanReviewOperatorSummaryRow, artifact: HumanReviewArtifact): boolean {
  const lineageSha = humanReviewSourceLineageSha256(artifact.sourceLineage);
  const publicationSha = humanReviewPublicationPayloadSha256(artifact.publicationPayload);
  return artifact.reviewId === row.id
    && artifact.eventKey === row.event_key
    && artifact.attemptId === row.attempt_id
    && artifact.pipelineRunId === row.pipeline_run_id
    && artifact.draftId === row.draft_id
    && artifact.draftSha256 === row.draft_sha256
    && artifact.packageSha256 === row.review_manifest.packageSha256
    && row.review_manifest.eventKey === row.event_key
    && row.review_manifest.attemptId === row.attempt_id
    && row.review_manifest.pipelineRunId === row.pipeline_run_id
    && row.review_manifest.draftId === row.draft_id
    && row.review_manifest.draftSha256 === row.draft_sha256
    && row.review_manifest.sourceLineageSha256 === row.source_lineage_sha256
    && row.review_manifest.publicationPayloadSha256 === row.publication_payload_sha256
    && artifact.reviewManifest.manifestSha256 === row.review_manifest.manifestSha256
    && canonicalJsonString(artifact.checkpoints) === canonicalJsonString(row.review_manifest.checkpoints)
    && publicationSha === row.publication_payload_sha256
    && lineageSha === row.source_lineage_sha256
    && artifact.reviewManifest.checkpoints.critic.identity === `${row.pipeline_run_id}:${row.attempt_id}:critic:${row.event_key}`;
}

function verifiedRevision(
  row: HumanReviewOperatorSummaryRow,
  artifact: HumanReviewArtifact,
  value: unknown,
) {
  const parsed = humanReviewRevisionRecordSchema.safeParse(value);
  if (!parsed.success) return fail();
  const revision = parsed.data;
  if (!verifyHumanReviewRevisionRecord(revision)
    || revision.id !== row.approval_target_revision_id
    || revision.review_id !== row.id
    || revision.attempt_id !== row.attempt_id
    || revision.pipeline_run_id !== row.pipeline_run_id
    || revision.original_draft_sha256 !== row.draft_sha256
    || revision.automated_critic_draft_sha256 !== row.draft_sha256
    || revision.source_lineage_sha256 !== row.source_lineage_sha256
    || revision.corrected_revision_sha256 !== row.approval_target_revision_sha256
    || revision.human_revision_proof.automatedCriticScope !== "ORIGINAL_DRAFT_ONLY"
    || canonicalJsonString(revision.original_draft) !== canonicalJsonString(artifact.draft)
    || canonicalJsonString(revision.original_publication_payload) !== canonicalJsonString(artifact.publicationPayload)) return fail();
  return revision;
}

function sourceRows(artifact: HumanReviewArtifact): EditorialReview["sources"] {
  return artifact.publicationPayload.sources.map((source) => {
    let url: URL;
    try { url = new URL(source.url); } catch { return fail(); }
    if (url.protocol !== "https:" && url.protocol !== "http:") return fail();
    return {
      publisher: url.hostname,
      title: source.sourceName,
      url: url.toString(),
      publishedAt: source.publishedAt,
      classification: source.isPrimary ? "PRIMARY" : "SECONDARY",
    };
  });
}

/**
 * Copies the real Ranker/Verifier/Critic output from the verified package. Claim sources are resolved to the
 * names of the sources actually attached to the publication payload. If the package lacks any of these blocks
 * the evidence is simply omitted: it is never reconstructed or filled with defaults.
 */
export function buildEditorialEvidence(artifact: HumanReviewArtifact): EditorialEvidence | undefined {
  try {
    const evidence = artifact.reviewEvidence;
    const names = new Map(artifact.publicationPayload.sources.map((source) => [source.sourceId, source.sourceName]));
    const claim = (entry: { claim: string; sourceIds: readonly string[] }) => ({
      claim: entry.claim,
      sources: [...new Set(entry.sourceIds.map((id) => names.get(id)).filter((name): name is string => !!name))],
    });
    const ranking = evidence.ranking;
    const parsed = editorialEvidenceSchema.safeParse({
      ranking: {
        importanceScore: ranking.importanceScore ?? artifact.publicationPayload.scores.importanceScore ?? null,
        impact: ranking.impact, novelty: ranking.novelty, reach: ranking.reach, credibility: ranking.credibility,
        economicImpact: ranking.economicImpact, momentum: ranking.momentum, rankReason: ranking.rankReason,
      },
      verification: {
        status: evidence.verifier.status, confidenceScore: evidence.verifier.confidenceScore, reason: evidence.verifier.reason,
        verifiedFacts: evidence.verifier.verifiedFacts.map(claim),
        uncertainClaims: evidence.verifier.uncertainClaims.map(claim),
        contradictions: evidence.verifier.contradictions.map(claim),
      },
      critic: {
        decision: evidence.critic.decision, severity: evidence.critic.severity, notes: evidence.critic.notes,
        issues: evidence.critic.issues.map((issue) => ({ code: issue.code, severity: issue.severity, message: issue.message })),
        unsupportedClaims: evidence.critic.unsupportedClaims.map((item) => ({ claim: item.claim, reason: item.reason })),
      },
    });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function mapM32Review(
  row: HumanReviewOperatorSummaryRow,
  artifact: HumanReviewArtifact,
  revisionValue?: unknown,
  inspectedLineage?: HumanReviewOperatorReadRow["source_lineage"],
): { review: EditorialReview; detail: EditorialReviewDetail } {
  if (!bindingIsValid(row, artifact)) return fail();
  if (inspectedLineage && canonicalJsonString(inspectedLineage) !== canonicalJsonString(artifact.sourceLineage)) return fail();
  const target = row.approval_target_kind;
  if ((target === "ORIGINAL" && (row.approval_target_revision_id !== null || row.approval_target_revision_sha256 !== null))
    || (target === "HUMAN_REVISION" && (!row.approval_target_revision_id || !row.approval_target_revision_sha256 || !revisionValue))) return fail();
  const revision = target === "HUMAN_REVISION" ? verifiedRevision(row, artifact, revisionValue) : null;
  const currentDraft = revision?.corrected_draft ?? artifact.draft;
  const criticPass = row.critic_pass && artifact.reviewEvidence.critic.decision === "pass"
    && artifact.publicationPayload.critic.decision === "pass"
    && artifact.checkpoints.critic.sha256 === row.review_manifest.checkpoints.critic.sha256;
  const m34Pass = criticPass && row.provider_usage_settled === true;
  const consumed = row.consumed_at !== null;
  const lineageSha = humanReviewSourceLineageSha256(artifact.sourceLineage);
  const warnings: EditorialReview["warnings"] = [];
  if (consumed) warnings.push({ id: "review-consumed", severity: "INFO", title: "Revisión ya consumida", detail: "Esta revisión ya fue utilizada y no aparece como pendiente." });
  if (!criticPass) warnings.push({ id: "critic-proof-missing", severity: "BLOCKER", title: "Prueba de Critic pendiente", detail: "El registro no acredita de forma consistente la validación del borrador original." });
  if (!m34Pass) warnings.push({ id: "m34-proof-missing", severity: "BLOCKER", title: "Verificación M34 pendiente", detail: "No se ha podido confirmar la prueba de Critic ligada al intento y el cierre de uso del proveedor." });
  const review = editorialReviewSchema.parse({
    reviewId: row.id,
    attemptId: row.attempt_id,
    reviewStatus: row.status,
    consumed,
    articleId: row.published_article_id,
    draftId: row.draft_id,
    humanRevisionId: revision?.id ?? null,
    approvalTarget: target,
    approvalTargetSha256: target === "HUMAN_REVISION" ? row.approval_target_revision_sha256 : row.draft_sha256,
    sourceLineageSha256: lineageSha,
    criticProofStatus: criticPass ? "PASS" : "UNKNOWN",
    m34Status: m34Pass ? "PASS" : "UNKNOWN",
    sourceLineageStatus: "PASS",
    headline: currentDraft.headlineEs,
    summary: currentDraft.summaryEs,
    whyItMatters: currentDraft.whyItMattersEs,
    country: countryName(artifact.reviewEvidence.geo.countryCodes[0] ?? null),
    region: artifact.reviewEvidence.classifier.primaryRegionCode,
    category: artifact.publicationPayload.categories.find((category) => category.isPrimary)?.categorySlug ?? null,
    createdAt: row.created_at,
    rankerScore: artifact.reviewEvidence.ranking.importanceScore ?? artifact.publicationPayload.scores.importanceScore,
    packageSha256: row.review_manifest.packageSha256,
    evidence: buildEditorialEvidence(artifact),
    body: bodyBlocks(currentDraft.bodyEs),
    sources: sourceRows(artifact),
    warnings,
  });
  const detail = editorialReviewDetailSchema.parse({
    review,
    originalDraft: {
      headline: artifact.draft.headlineEs,
      summary: artifact.draft.summaryEs,
      whyItMatters: artifact.draft.whyItMattersEs,
      body: bodyBlocks(artifact.draft.bodyEs),
    },
    mode: "LIVE_READ_ONLY",
  });
  return { review, detail };
}

export function isM32Waiting(row: HumanReviewOperatorSummaryRow): boolean {
  return row.status === "WAITING_FOR_HUMAN_REVIEW" && row.consumed_at === null;
}

export function toInboxSummary(review: EditorialReview) {
  if (!isWaitingReview(review)) return null;
  return toReviewSummary(review);
}
