import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonString } from "../pipeline/factual-remediation-continuation.ts";
import { publicationPayloadSchema, type PublicationPayload } from "../contracts/index.ts";
import { humanReviewSourceLineageSha256 } from "./human-review-source-lineage-hash.ts";
import { type HumanReviewArtifact } from "./human-review.ts";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const humanRevisionDraftSchema = z.object({
  headlineEs: z.string().trim().min(1),
  dekEs: z.string().trim().min(1),
  summaryEs: z.string().trim().min(1),
  whyItMattersEs: z.string().trim().min(1),
  bodyEs: z.string().trim().min(1),
  keyPoints: z.array(z.string().trim().min(1)).min(1).max(10),
}).strict();
export type HumanRevisionDraft = z.infer<typeof humanRevisionDraftSchema>;
export const humanRevisionProofSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("PASS"),
  actorClass: z.literal("HUMAN_OPERATOR"),
  correctedRevisionSha256: digestSchema,
  originalDraftSha256: digestSchema,
  sourceLineageSha256: digestSchema,
  auditSha256: digestSchema,
  auditedAt: z.string().datetime({ offset: true }),
  automatedCriticScope: z.literal("ORIGINAL_DRAFT_ONLY"),
  humanAttestation: z.literal("FACTUAL_ATTRIBUTION_ORIGINALITY_SOURCE_LINEAGE_PASS"),
}).strict();
export const humanReviewRevisionRecordSchema = z.object({
  id: z.string().uuid(),
  review_id: z.string().uuid(),
  revision_version: z.literal(1),
  attempt_id: z.string().uuid(),
  pipeline_run_id: z.string().uuid(),
  original_draft: humanRevisionDraftSchema,
  original_publication_payload: publicationPayloadSchema,
  corrected_draft: humanRevisionDraftSchema,
  corrected_publication_payload: publicationPayloadSchema,
  original_draft_sha256: digestSchema,
  corrected_revision_sha256: digestSchema,
  source_lineage_sha256: digestSchema,
  automated_critic_draft_sha256: digestSchema,
  human_revision_proof: humanRevisionProofSchema,
  created_at: z.string().datetime({ offset: true }),
}).strict();
const phaseAuditSchema = z.object({
  phase: z.literal("12F.12K"),
  review: z.object({ id: z.string().uuid(), statusBefore: z.literal("WAITING"), consumedBefore: z.literal(false) }).passthrough(),
  correctedPassages: z.object({
    headline: z.string(), deck: z.string(), summary: z.string(), whyItMatters: z.string(), body: z.string(), keyPoints: z.array(z.string()),
  }).passthrough(),
  claimRecheck: z.object({
    overall: z.literal("PASS"), headline: z.literal("PASS"), summary: z.literal("PASS"), whyItMatters: z.literal("PASS"),
    body: z.literal("PASS"), numbersDates: z.literal("PASS"), attribution: z.literal("PASS"),
    incidentCategorySeparation: z.literal("PASS"), sourceLineage: z.literal("PASS"), copyrightOriginality: z.literal("PASS"),
  }).passthrough(),
  sources: z.object({ primary: z.object({ url: z.string().url() }).passthrough() }).passthrough(),
}).passthrough();

export type HumanRevisionBinding = {
  originalDraft: HumanReviewArtifact["draft"];
  originalPublicationPayload: PublicationPayload;
  correctedDraft: HumanRevisionDraft;
  correctedPublicationPayload: PublicationPayload;
  originalDraftSha256: string;
  correctedRevisionSha256: string;
  sourceLineageSha256: string;
  humanRevisionProof: z.infer<typeof humanRevisionProofSchema>;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function markdownSection(markdown: string, heading: string, nextHeading: string): string {
  const match = new RegExp(`^## ${heading}\\s*\\r?\\n+([\\s\\S]*?)\\r?\\n+## ${nextHeading}\\s*$`, "m").exec(markdown);
  if (!match?.[1]) throw new Error(`HUMAN_REVISION_MARKDOWN_SECTION_INVALID:${heading}`);
  return match[1].trim();
}

export function parseHumanCorrectedDraft(markdown: string): HumanRevisionDraft {
  const headline = markdownSection(markdown, "Titular", "Bajada");
  const deck = markdownSection(markdown, "Bajada", "Resumen");
  const summary = markdownSection(markdown, "Resumen", "Por qué importa");
  const whyItMatters = markdownSection(markdown, "Por qué importa", "Texto");
  const body = markdownSection(markdown, "Texto", "Puntos clave");
  const keyPointsText = markdownSection(markdown, "Puntos clave", "Fuentes consideradas");
  const keyPoints = keyPointsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    if (!line.startsWith("- ")) throw new Error("HUMAN_REVISION_KEY_POINT_FORMAT_INVALID");
    return line.slice(2).trim();
  });
  return humanRevisionDraftSchema.parse({ headlineEs: headline, dekEs: deck, summaryEs: summary, whyItMattersEs: whyItMatters, bodyEs: body, keyPoints });
}

export function buildHumanRevisionBinding(input: {
  markdown: string;
  audit: Record<string, unknown>;
  auditBytes: Uint8Array;
  artifact: HumanReviewArtifact;
  auditedAt: string;
}): HumanRevisionBinding {
  const auditedAt = z.string().datetime({ offset: true }).parse(input.auditedAt);
  const audit = phaseAuditSchema.safeParse(input.audit);
  if (!audit.success || audit.data.review.id !== input.artifact.reviewId) throw new Error("HUMAN_REVISION_12K_AUDIT_NOT_PASS");
  const correctedDraft = parseHumanCorrectedDraft(input.markdown);
  const expected = audit.data.correctedPassages;
  for (const [key, value] of Object.entries({
    headline: correctedDraft.headlineEs,
    deck: correctedDraft.dekEs,
    summary: correctedDraft.summaryEs,
    whyItMatters: correctedDraft.whyItMattersEs,
    body: correctedDraft.bodyEs,
  })) if (expected?.[key] !== value) throw new Error(`HUMAN_REVISION_12K_AUDIT_CONTENT_MISMATCH:${key}`);
  if (canonicalJsonString(correctedDraft.keyPoints) !== canonicalJsonString(expected?.keyPoints)) throw new Error("HUMAN_REVISION_12K_AUDIT_CONTENT_MISMATCH:keyPoints");

  const sourceLinks = [...input.markdown.matchAll(/https:\/\/[^)\s]+/g)].map((match) => match[0]);
  const allowedUrls = new Set(input.artifact.publicationPayload.sources.map((source) => source.url));
  const supplementalUrls = new Set([audit.data.sources.primary.url]);
  if (new Set(sourceLinks).size !== sourceLinks.length || sourceLinks.some((url) => !allowedUrls.has(url) && !supplementalUrls.has(url))) {
    throw new Error("HUMAN_REVISION_SOURCE_URL_NOT_APPROVED");
  }
  const originalPublicationPayload = publicationPayloadSchema.parse(input.artifact.publicationPayload);
  const correctedPublicationPayload = publicationPayloadSchema.parse({
    ...originalPublicationPayload,
    article: {
      ...originalPublicationPayload.article,
      ...correctedDraft,
    },
  });
  const originalDraft = input.artifact.draft;
  const originalDraftSha256 = input.artifact.draftSha256;
  const correctedRevisionSha256 = sha256(canonicalJsonString(correctedDraft));
  const sourceLineageSha256 = humanReviewSourceLineageSha256(input.artifact.sourceLineage);
  const auditSha256 = sha256(input.auditBytes);
  const humanRevisionProof = {
    schemaVersion: 1 as const,
    status: "PASS" as const,
    actorClass: "HUMAN_OPERATOR" as const,
    correctedRevisionSha256,
    originalDraftSha256,
    sourceLineageSha256,
    auditSha256,
    auditedAt,
    automatedCriticScope: "ORIGINAL_DRAFT_ONLY" as const,
    humanAttestation: "FACTUAL_ATTRIBUTION_ORIGINALITY_SOURCE_LINEAGE_PASS" as const,
  };
  return { originalDraft, originalPublicationPayload, correctedDraft, correctedPublicationPayload, originalDraftSha256, correctedRevisionSha256, sourceLineageSha256, humanRevisionProof };
}

export function verifyHumanRevisionBinding(binding: HumanRevisionBinding): boolean {
  const originalWithoutArticle = Object.fromEntries(Object.entries(binding.originalPublicationPayload).filter(([key]) => key !== "article"));
  const correctedWithoutArticle = Object.fromEntries(Object.entries(binding.correctedPublicationPayload).filter(([key]) => key !== "article"));
  return /^[a-f0-9]{64}$/.test(binding.originalDraftSha256)
    && /^[a-f0-9]{64}$/.test(binding.correctedRevisionSha256)
    && /^[a-f0-9]{64}$/.test(binding.sourceLineageSha256)
    && sha256(canonicalJsonString(binding.correctedDraft)) === binding.correctedRevisionSha256
    && canonicalJsonString(binding.correctedPublicationPayload.article) === canonicalJsonString({
      ...binding.originalPublicationPayload.article,
      ...binding.correctedDraft,
    })
    && canonicalJsonString(correctedWithoutArticle) === canonicalJsonString(originalWithoutArticle);
}

export function verifyHumanReviewRevisionRecord(value: z.infer<typeof humanReviewRevisionRecordSchema>): boolean {
  const correctedFields = {
    headlineEs: value.corrected_publication_payload.article.headlineEs,
    dekEs: value.corrected_publication_payload.article.dekEs,
    summaryEs: value.corrected_publication_payload.article.summaryEs,
    whyItMattersEs: value.corrected_publication_payload.article.whyItMattersEs,
    bodyEs: value.corrected_publication_payload.article.bodyEs,
    keyPoints: value.corrected_publication_payload.article.keyPoints,
  };
  const payloadWithoutArticle = Object.fromEntries(Object.entries(value.corrected_publication_payload).filter(([key]) => key !== "article"));
  const originalPayloadWithoutArticle = Object.fromEntries(Object.entries(value.original_publication_payload).filter(([key]) => key !== "article"));
  return sha256(canonicalJsonString(value.corrected_draft)) === value.corrected_revision_sha256
    && canonicalJsonString(value.corrected_draft) === canonicalJsonString(correctedFields)
    && canonicalJsonString(payloadWithoutArticle) === canonicalJsonString(originalPayloadWithoutArticle)
    && value.human_revision_proof.correctedRevisionSha256 === value.corrected_revision_sha256
    && value.human_revision_proof.originalDraftSha256 === value.original_draft_sha256
    && value.human_revision_proof.sourceLineageSha256 === value.source_lineage_sha256
    && value.automated_critic_draft_sha256 === value.original_draft_sha256;
}
