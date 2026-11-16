import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { classificationResultSchema, criticResultSchema, publicationPayloadSchema, rankingResultSchema, translationResultSchema, verificationResultSchema, type PublicationPayload } from "../contracts/index.ts";
import { canonicalJsonString } from "../pipeline/factual-remediation-continuation.ts";
import { readSafeCriticPipelineCheckpoint } from "./critic-pipeline-checkpoint.ts";
import { buildPipelinePublicationPayload } from "./publication-payload.ts";
import type { PipelineEventContext, PipelineEventResult, PipelineRunContext } from "../pipeline/pipeline-types.ts";
import type { AgentTelemetry } from "../runtime/runtime-types.ts";

export const humanReviewCheckpointStages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
export type HumanReviewCheckpointStage = (typeof humanReviewCheckpointStages)[number];

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const checkpointHashSchema = z.object({ identity: z.string().trim().min(1), sha256: digestSchema }).strict();
const checkpointSetSchema = z.object(Object.fromEntries(humanReviewCheckpointStages.map((stage) => [stage, checkpointHashSchema])) as Record<HumanReviewCheckpointStage, typeof checkpointHashSchema>).strict();
export const humanReviewManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  packageSha256: digestSchema,
  checkpoints: checkpointSetSchema,
  manifestSha256: digestSchema,
}).strict();

const sourceLineageEntrySchema = z.object({
  source_id: z.string().uuid(),
  raw_item_id: z.string().uuid(),
  content_hash: z.string().min(8),
  canonical_url: z.string().url(),
  source_url: z.string().url(),
}).strict();

const providerAccountingStageSchema = z.object({
  provider: z.enum(["groq", "cerebras", "cloudflare_workers_ai"]),
  model: z.string().trim().min(1),
  requestCount: z.number().int().positive(),
  attempts: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
  providerRequestDispatched: z.literal(true),
  providerUnit: z.enum(["requests", "tokens", "neurons"]).nullable(),
  providerUnitUsageKnown: z.literal(true),
  actualProviderUnitUsage: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().positive().nullable(),
  settlement: z.literal("SETTLED"),
}).strict();

const providerAccountingSchema = z.object(Object.fromEntries(humanReviewCheckpointStages.map((stage) => [stage, providerAccountingStageSchema])) as Record<HumanReviewCheckpointStage, typeof providerAccountingStageSchema>).strict();
const geoEvidenceSchema = z.object({
  eventKey: z.string().trim().min(1),
  primaryRegionCode: z.string().nullable(),
  countryCodes: z.array(z.string()),
  latitude: z.number().finite().nullable(),
  longitude: z.number().finite().nullable(),
  resolutionLevel: z.enum(["global", "region", "country", "unresolved"]),
  resolvedFrom: z.enum(["country_registry", "region_registry"]).nullable(),
  provenance: z.enum(["classifier", "reference_registry", "unresolved"]),
}).strict();

const reviewEvidenceSchema = z.object({
  eventId: z.string().trim().min(1),
  verifier: verificationResultSchema,
  translation: translationResultSchema,
  attributionStatus: z.enum(["LINEAGE_VERIFIED_REQUIRES_HUMAN_CONFIRMATION"]),
  uncertaintyStatus: z.enum(["REQUIRES_HUMAN_CONFIRMATION"]),
  classifier: classificationResultSchema,
  geo: geoEvidenceSchema,
  ranking: rankingResultSchema,
  critic: criticResultSchema,
  providerAccounting: providerAccountingSchema,
}).strict();

export const humanReviewArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  reviewId: z.string().uuid().nullable(),
  eventKey: z.string().trim().min(1),
  attemptId: z.string().uuid(),
  pipelineRunId: z.string().uuid(),
  draftId: z.string().trim().min(1),
  draftSha256: digestSchema,
  draft: z.object({
    headlineEs: z.string(),
    dekEs: z.string(),
    summaryEs: z.string(),
    whyItMattersEs: z.string(),
    bodyEs: z.string(),
    keyPoints: z.array(z.string()),
  }).strict(),
  sourceLineage: z.array(sourceLineageEntrySchema).min(1).max(100),
  checkpoints: humanReviewManifestSchema.shape.checkpoints,
  reviewEvidence: reviewEvidenceSchema,
  publicationPayload: publicationPayloadSchema,
  packageSha256: digestSchema,
  reviewManifest: humanReviewManifestSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type HumanReviewArtifact = z.infer<typeof humanReviewArtifactSchema>;
export type HumanReviewManifest = z.infer<typeof humanReviewManifestSchema>;

export type HumanReviewCreateInput = {
  context: PipelineEventContext;
  run: PipelineRunContext;
  attemptId: string;
  checkpoints: PipelineEventResult["checkpoints"];
  providerAccounting: Partial<Record<HumanReviewCheckpointStage, AgentTelemetry>>;
};

export type HumanReviewGateway = {
  /** Success means the review RPC atomically created WAITING and terminalized
   * the same attempt. Callers must not finalize that successful transition again.
   */
  createReview(input: HumanReviewCreateInput): Promise<{ reviewId: string; packageSha256: string }>;
};

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeUuid(value: string): boolean { return z.string().uuid().safeParse(value).success; }

export async function buildHumanReviewSnapshot(input: {
  context: PipelineEventContext;
  run: PipelineRunContext;
  attemptId: string;
  checkpoints: PipelineEventResult["checkpoints"];
  providerAccounting: Partial<Record<HumanReviewCheckpointStage, AgentTelemetry>>;
  durableProviderAccounting?: Partial<Record<HumanReviewCheckpointStage, z.infer<typeof providerAccountingStageSchema>>>;
  durableSourceLineage?: Array<{ sourceId: string; sourceItemId: string; rawItemId: string; contentHash: string; canonicalUrl: string }>;
  publicationPayload: PublicationPayload;
  sourceRegistryUrls: ReadonlyMap<string, string>;
  checkpointRoot: string;
  createdAt?: string;
}): Promise<{ artifact: HumanReviewArtifact; manifest: HumanReviewManifest }> {
  if (!safeUuid(input.attemptId) || !safeUuid(input.run.runId)) throw new Error("HUMAN_REVIEW_UUID_IDENTITY_REQUIRED");
  const publicationPayload = publicationPayloadSchema.parse(input.publicationPayload);
  const eventKey = input.context.event.eventKey;
  if (publicationPayload.eventKey !== eventKey) throw new Error("HUMAN_REVIEW_CRITIC_OR_EVENT_MISMATCH");

  const checkpoints = {} as Record<HumanReviewCheckpointStage, z.infer<typeof checkpointHashSchema>>;
  let durableCritic: Awaited<ReturnType<typeof readSafeCriticPipelineCheckpoint>> | null = null;
  const root = resolve(input.checkpointRoot);
  for (const stage of humanReviewCheckpointStages) {
    const checkpoint = input.checkpoints[stage];
    if (!checkpoint || checkpoint.stage !== stage || checkpoint.eventKey !== eventKey || !checkpoint.written || !checkpoint.readable || !checkpoint.valid || !checkpoint.path) throw new Error(`HUMAN_REVIEW_CHECKPOINT_INVALID:${stage}`);
    const path = resolve(checkpoint.path);
    const rel = relative(root, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`HUMAN_REVIEW_CHECKPOINT_OUTSIDE_ROOT:${stage}`);
    if (stage === "critic") {
      durableCritic = await readSafeCriticPipelineCheckpoint(path);
      if (durableCritic.eventKey !== eventKey || durableCritic.attemptId !== input.attemptId || durableCritic.critic.decision !== "pass") {
        throw new Error("HUMAN_REVIEW_DURABLE_CRITIC_PASS_NOT_PROVEN");
      }
      if (input.context.critic && canonicalJsonString(input.context.critic) !== canonicalJsonString(durableCritic.critic)) {
        throw new Error("HUMAN_REVIEW_CRITIC_CHECKPOINT_CONTEXT_MISMATCH");
      }
    }
    const bytes = await readFile(path);
    checkpoints[stage] = { identity: `${input.run.runId}:${input.attemptId}:${stage}:${eventKey}`, sha256: sha256(bytes) };
  }

  if (!durableCritic || publicationPayload.critic.decision !== "pass"
    || canonicalJsonString(publicationPayload.critic) !== canonicalJsonString(durableCritic.critic)) {
    throw new Error("HUMAN_REVIEW_DURABLE_CRITIC_PASS_NOT_PROVEN");
  }
  const context: PipelineEventContext = { ...input.context, critic: durableCritic.critic };

  const extractedByCandidate = new Map(context.items.map((item) => [item.candidateId, item]));
  if (input.durableSourceLineage && (input.durableSourceLineage.length !== context.sources.length
    || new Set(input.durableSourceLineage.map((entry) => entry.sourceItemId)).size !== input.durableSourceLineage.length)) {
    throw new Error("HUMAN_REVIEW_SOURCE_LINEAGE_INCOMPLETE");
  }
  const sourceLineage = context.sources.map((source) => {
    const item = extractedByCandidate.get(source.sourceItemId);
    const durable = input.durableSourceLineage?.find((entry) => entry.sourceItemId === source.sourceItemId);
    const sourceUrl = input.sourceRegistryUrls.get(source.sourceId);
    const rawItemId = durable?.rawItemId ?? source.rawItemId;
    const contentHash = durable?.contentHash ?? item?.contentHash;
    const canonicalUrl = durable?.canonicalUrl ?? item?.canonicalUrl;
    if (!rawItemId || !contentHash || !canonicalUrl || !sourceUrl
      || (durable && (durable.sourceId !== source.sourceId || durable.rawItemId !== source.rawItemId || durable.canonicalUrl !== source.sourceUrl))) {
      throw new Error("HUMAN_REVIEW_SOURCE_LINEAGE_INCOMPLETE");
    }
    return sourceLineageEntrySchema.parse({
      source_id: source.sourceId,
      raw_item_id: rawItemId,
      content_hash: contentHash,
      canonical_url: canonicalUrl,
      source_url: sourceUrl,
    });
  });
  if (sourceLineage.length !== context.sources.length || sourceLineage.length === 0) throw new Error("HUMAN_REVIEW_SOURCE_LINEAGE_INCOMPLETE");
  const derivedPayload = buildPipelinePublicationPayload(context);
  if (canonicalJsonString(publicationPayload) !== canonicalJsonString(derivedPayload)) throw new Error("HUMAN_REVIEW_PUBLICATION_PAYLOAD_CONTEXT_MISMATCH");

  const providerAccounting = {} as Record<HumanReviewCheckpointStage, z.infer<typeof providerAccountingStageSchema>>;
  for (const stage of humanReviewCheckpointStages) {
    const durable = input.durableProviderAccounting?.[stage];
    if (durable) {
      const parsed = providerAccountingStageSchema.parse(durable);
      if (parsed.provider === "groq" && (parsed.providerUnit !== "tokens" || parsed.totalTokens === null
        || parsed.inputTokens === null || parsed.outputTokens === null || parsed.inputTokens + parsed.outputTokens !== parsed.totalTokens
        || parsed.actualProviderUnitUsage !== parsed.totalTokens)) throw new Error(`HUMAN_REVIEW_PROVIDER_USAGE_UNSETTLED:${stage}`);
      if (parsed.provider === "cloudflare_workers_ai" && parsed.providerUnit !== "neurons") throw new Error(`HUMAN_REVIEW_PROVIDER_USAGE_UNSETTLED:${stage}`);
      if (parsed.provider === "cerebras" && (parsed.inputTokens === null || parsed.outputTokens === null || parsed.totalTokens === null
        || parsed.inputTokens + parsed.outputTokens > parsed.totalTokens)) throw new Error(`HUMAN_REVIEW_PROVIDER_USAGE_UNSETTLED:${stage}`);
      providerAccounting[stage] = parsed;
      continue;
    }
    const telemetry = input.providerAccounting[stage];
    if (!telemetry || telemetry.status !== "SUCCESS" || telemetry.providerRequestsUsed < 1 || telemetry.providerRequestsUsed !== telemetry.attempts
      || telemetry.retries !== 0 || !telemetry.providerRequestDispatched || telemetry.providerUnitUsageKnown !== true
      || !Number.isSafeInteger(telemetry.actualProviderUnitUsage) || (telemetry.actualProviderUnitUsage ?? 0) < 1) {
      throw new Error(`HUMAN_REVIEW_PROVIDER_USAGE_UNSETTLED:${stage}`);
    }
    const common = {
      provider: telemetry.provider,
      model: telemetry.model,
      requestCount: telemetry.providerRequestsUsed,
      attempts: telemetry.attempts,
      retries: telemetry.retries,
      providerRequestDispatched: true as const,
      providerUnit: telemetry.providerUnit ?? null,
      providerUnitUsageKnown: true as const,
      actualProviderUnitUsage: telemetry.actualProviderUnitUsage!,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      totalTokens: telemetry.totalTokens,
      settlement: "SETTLED" as const,
    };
    if (telemetry.provider === "groq" && (telemetry.providerUnit !== "tokens" || telemetry.totalTokens === null
      || telemetry.inputTokens === null || telemetry.outputTokens === null
      || telemetry.inputTokens + telemetry.outputTokens !== telemetry.totalTokens
      || telemetry.actualProviderUnitUsage !== telemetry.totalTokens)) throw new Error(`HUMAN_REVIEW_PROVIDER_USAGE_UNSETTLED:${stage}`);
    if (telemetry.provider === "cloudflare_workers_ai" && telemetry.providerUnit !== "neurons") throw new Error(`HUMAN_REVIEW_PROVIDER_USAGE_UNSETTLED:${stage}`);
    if (telemetry.provider === "cerebras" && (telemetry.inputTokens === null || telemetry.outputTokens === null || telemetry.totalTokens === null
      || telemetry.inputTokens + telemetry.outputTokens > telemetry.totalTokens)) throw new Error(`HUMAN_REVIEW_PROVIDER_USAGE_UNSETTLED:${stage}`);
    providerAccounting[stage] = providerAccountingStageSchema.parse(common);
  }

  if (!context.verification || !context.translation || !context.classification || !context.geo || !context.ranking || !context.critic) {
    throw new Error("HUMAN_REVIEW_EVIDENCE_INCOMPLETE");
  }
  const sourceIds = new Set(sourceLineage.map((source) => source.source_id));
  const citedSourceIds = [
    ...context.verification.verifiedFacts,
    ...context.verification.uncertainClaims,
    ...context.verification.contradictions,
  ].flatMap((claim) => claim.sourceIds);
  if (citedSourceIds.some((sourceId) => !sourceIds.has(sourceId))) throw new Error("HUMAN_REVIEW_ATTRIBUTION_LINEAGE_MISMATCH");
  const reviewEvidence = reviewEvidenceSchema.parse({
    eventId: eventKey,
    verifier: context.verification,
    translation: context.translation,
    attributionStatus: "LINEAGE_VERIFIED_REQUIRES_HUMAN_CONFIRMATION",
    uncertaintyStatus: "REQUIRES_HUMAN_CONFIRMATION",
    classifier: context.classification,
    geo: context.geo,
    ranking: context.ranking,
    critic: context.critic,
    providerAccounting,
  });

  const draft = {
    headlineEs: publicationPayload.article.headlineEs,
    dekEs: publicationPayload.article.dekEs,
    summaryEs: publicationPayload.article.summaryEs,
    whyItMattersEs: publicationPayload.article.whyItMattersEs,
    bodyEs: publicationPayload.article.bodyEs,
    keyPoints: publicationPayload.article.keyPoints,
  };
  const draftSha256 = sha256(canonicalJsonString(draft));
  const draftId = `${input.run.runId}:${eventKey}`;
  const createdAt = input.createdAt ?? new Date().toISOString();
  const core = { schemaVersion: 1 as const, eventKey, attemptId: input.attemptId, pipelineRunId: input.run.runId, draftId, draftSha256, draft, sourceLineage, checkpoints, reviewEvidence, publicationPayload, createdAt };
  const packageSha256 = sha256(canonicalJsonString(core));
  const manifestCore = { schemaVersion: "1" as const, packageSha256, checkpoints };
  const manifest = humanReviewManifestSchema.parse({ ...manifestCore, manifestSha256: sha256(canonicalJsonString(manifestCore)) });
  const artifact = humanReviewArtifactSchema.parse({ ...core, reviewId: null, packageSha256, reviewManifest: manifest });
  return { artifact, manifest };
}

export function humanReviewArtifactPath(root: string, attemptId: string): string {
  if (!safeUuid(attemptId)) throw new Error("HUMAN_REVIEW_ATTEMPT_ID_INVALID");
  return resolve(root, `${attemptId}.json`);
}

export async function writeHumanReviewArtifact(root: string, artifact: HumanReviewArtifact): Promise<string> {
  const parsed = humanReviewArtifactSchema.parse(artifact);
  const path = humanReviewArtifactPath(root, parsed.attemptId);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { await rename(temporary, path); } catch (error) {
    try { await import("node:fs/promises").then(({ unlink }) => unlink(temporary)); } catch { /* retain the original error */ }
    throw error;
  }
  return path;
}

export async function readHumanReviewArtifact(root: string, attemptId: string): Promise<HumanReviewArtifact> {
  return humanReviewArtifactSchema.parse(JSON.parse(await readFile(humanReviewArtifactPath(root, attemptId), "utf8")) as unknown);
}

export function attachHumanReviewId(artifact: HumanReviewArtifact, reviewId: string): HumanReviewArtifact {
  return humanReviewArtifactSchema.parse({ ...artifact, reviewId });
}

export function verifyHumanReviewArtifact(artifact: HumanReviewArtifact): boolean {
  const packageSha256 = artifact.packageSha256;
  const core = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "reviewId" && key !== "packageSha256" && key !== "reviewManifest"));
  const manifestCore = { schemaVersion: artifact.reviewManifest.schemaVersion, packageSha256: artifact.reviewManifest.packageSha256, checkpoints: artifact.reviewManifest.checkpoints };
  return sha256(canonicalJsonString(core)) === packageSha256
    && artifact.reviewManifest.packageSha256 === packageSha256
    && sha256(canonicalJsonString(manifestCore)) === artifact.reviewManifest.manifestSha256
    && sha256(canonicalJsonString(artifact.draft)) === artifact.draftSha256;
}
