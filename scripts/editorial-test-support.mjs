// Shared helpers for the editorial panel / digest / shared-operations unit tests. Entirely synthetic: it builds a
// schema-valid human-review package (real hashes, real checkpoint files in a temp dir) from the contract fixtures.
// No network, no database, no real review data.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJsonString } from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { humanReviewArtifactSchema, humanReviewCheckpointStages, sha256, writeHumanReviewArtifact } from "../lib/agents/publisher/human-review.ts";
import { humanReviewSourceLineageSha256 } from "../lib/agents/publisher/human-review-source-lineage-hash.ts";
import { humanReviewPublicationPayloadSha256 } from "../lib/agents/publisher/human-review-jsonb-hash.ts";

export const ids = {
  review: "11111111-1111-4111-8111-111111111111",
  attempt: "22222222-2222-4222-8222-222222222222",
  run: "33333333-3333-4333-8333-333333333333",
  revision: "44444444-4444-4444-8444-444444444444",
  rawItem: "66666666-6666-4666-8666-666666666666",
};
export const eventKey = validFixtures.PublicationPayload.eventKey;

const payload = structuredClone(validFixtures.PublicationPayload);
payload.sources = [
  { ...payload.sources[0], rawItemId: ids.rawItem },
  { sourceId: "22222222-2222-4222-8222-222222222222", rawItemId: "88888888-8888-4888-8888-888888888888", sourceName: "Second Source Weekly", url: "https://example.org/report", isPrimary: false, publishedAt: null },
];
payload.verification = {
  ...payload.verification,
  verifiedFacts: [{ claim: "The accelerator entered production in September 2026.", sourceIds: [payload.sources[0].sourceId] }],
  uncertainClaims: [{ claim: "Market share impact is not yet measurable.", sourceIds: [payload.sources[1].sourceId] }],
  contradictions: [{ claim: "One outlet reports a later production date.", sourceIds: [payload.sources[1].sourceId] }],
};
export const publicationPayload = payload;

const draft = {
  headlineEs: payload.article.headlineEs, dekEs: payload.article.dekEs, summaryEs: payload.article.summaryEs,
  whyItMattersEs: payload.article.whyItMattersEs, bodyEs: payload.article.bodyEs, keyPoints: payload.article.keyPoints,
};
const sourceLineage = payload.sources.map((source, index) => ({
  source_id: source.sourceId, raw_item_id: source.rawItemId, content_hash: `content-hash-${index}`,
  canonical_url: source.url, source_url: source.url,
}));
const accounting = { provider: "groq", model: "synthetic-model", requestCount: 1, attempts: 1, retries: 0, providerRequestDispatched: true,
  providerUnit: "tokens", providerUnitUsageKnown: true, actualProviderUnitUsage: 10, inputTokens: 6, outputTokens: 4, totalTokens: 10, settlement: "SETTLED" };

export const rankingFixture = { ...validFixtures.RankingResult, importanceScore: 74.45 };

/**
 * Writes the review package and the six checkpoint files, then returns the matching M32 row.
 * `reviewIdAttached: false` leaves `artifact.reviewId` null on disk (the CLI/panel attach it on first load).
 */
export async function buildReviewScenario({ reviewIdAttached = true, status = "WAITING_FOR_HUMAN_REVIEW", criticPassOnRow = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), "horizai-editorial-"));
  const artifactRoot = join(base, "packages");
  const checkpointRoot = join(base, "checkpoints");
  await mkdir(join(checkpointRoot, ids.run), { recursive: true });
  const checkpoints = {};
  for (const stage of humanReviewCheckpointStages) {
    const bytes = Buffer.from(JSON.stringify({ stage, synthetic: true }));
    await writeFile(join(checkpointRoot, ids.run, `${stage}-${eventKey}.json`), bytes);
    checkpoints[stage] = { identity: `${ids.run}:${ids.attempt}:${stage}:${eventKey}`, sha256: sha256(bytes) };
  }
  const reviewEvidence = {
    eventId: eventKey,
    verifier: payload.verification,
    translation: validFixtures.TranslationResult,
    attributionStatus: "LINEAGE_VERIFIED_REQUIRES_HUMAN_CONFIRMATION",
    uncertaintyStatus: "REQUIRES_HUMAN_CONFIRMATION",
    classifier: validFixtures.ClassificationResult,
    geo: { eventKey, primaryRegionCode: "US", countryCodes: ["US"], latitude: 39.8283, longitude: -98.5795, resolutionLevel: "country", resolvedFrom: "country_registry", provenance: "classifier" },
    ranking: rankingFixture,
    critic: payload.critic,
    providerAccounting: Object.fromEntries(humanReviewCheckpointStages.map((stage) => [stage, accounting])),
  };
  const draftId = `${ids.run}:${eventKey}`;
  const core = { schemaVersion: 1, eventKey, attemptId: ids.attempt, pipelineRunId: ids.run, draftId, draftSha256: sha256(canonicalJsonString(draft)),
    draft, sourceLineage, checkpoints, reviewEvidence, publicationPayload: payload, createdAt: "2026-10-21T08:00:00Z" };
  const packageSha256 = sha256(canonicalJsonString(core));
  const manifestCore = { schemaVersion: "1", packageSha256, checkpoints };
  const reviewManifest = { ...manifestCore, manifestSha256: sha256(canonicalJsonString(manifestCore)) };
  const artifact = humanReviewArtifactSchema.parse({ ...core, reviewId: reviewIdAttached ? ids.review : null, packageSha256, reviewManifest });
  await writeHumanReviewArtifact(artifactRoot, artifact);

  const lineageSha = humanReviewSourceLineageSha256(sourceLineage);
  const row = {
    id: ids.review, eventId: eventKey, event_key: eventKey, attempt_id: ids.attempt, pipeline_run_id: ids.run, draft_id: draftId,
    draft_sha256: core.draftSha256, source_lineage_sha256: lineageSha, publication_payload_sha256: humanReviewPublicationPayloadSha256(payload),
    approval_target_kind: "ORIGINAL", approval_target_revision_id: null, approval_target_revision_sha256: null, approved_revision_sha256: null,
    review_manifest: { ...reviewManifest, eventKey, attemptId: ids.attempt, pipelineRunId: ids.run, draftId, draftSha256: core.draftSha256,
      sourceLineageSha256: lineageSha, publicationPayloadSha256: humanReviewPublicationPayloadSha256(payload) },
    critic_pass: criticPassOnRow, provider_usage_settled: true, status, action: null, reviewer_approved: null,
    facts_acceptable: null, attribution_acceptable: null, reviewed_at: null, consumed_at: null, published_article_id: null,
    created_at: "2026-10-21T08:00:00Z", updated_at: "2026-10-21T08:00:00Z",
    source_lineage: sourceLineage, reviewer_id: null, uncertainty_preserved: null, headline_acceptable: null, summary_acceptable: null,
    no_unsupported_material_claims: null, source_chain_acceptable: null, decision_history: [],
  };
  return { base, artifactRoot, checkpointRoot, artifact, row, packageSha256, checkpointPath: (stage) => join(checkpointRoot, ids.run, `${stage}-${eventKey}.json`) };
}

/** Marks a row as a fully approved review, ready for publication. */
export function approvedRow(row) {
  return { ...row, status: "APPROVED", action: "APPROVE", reviewer_approved: true, facts_acceptable: true, attribution_acceptable: true,
    uncertainty_preserved: true, headline_acceptable: true, summary_acceptable: true, no_unsupported_material_claims: true,
    source_chain_acceptable: true, reviewed_at: "2026-10-21T09:00:00Z" };
}

export const allChecksPass = { facts: true, attribution: true, uncertainty: true, headline: true, summary: true, "unsupported-claims": true, "source-chain": true };
