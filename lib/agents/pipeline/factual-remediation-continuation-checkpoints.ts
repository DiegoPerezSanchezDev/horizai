import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSafeTranslatorCheckpoint } from "../translator/translator-checkpoint.ts";
import { readSafeTranslatorEditorCheckpoint } from "../editor/translator-editor-checkpoint.ts";
import { readSafeClassifierPipelineCheckpoint } from "../classifier/classifier-pipeline-checkpoint.ts";
import { readSafeRankerPipelineCheckpoint } from "../critic/ranker-pipeline-checkpoint.ts";
import { criticInputSchema } from "../critic/critic-types.ts";
import { runCriticPrechecks } from "../critic/critic-prechecks.ts";
import { createReferenceRegistry } from "../classifier/geo-registry.ts";
import type { PipelineEventContext } from "./pipeline-types.ts";
import { factualRemediationIncident } from "./factual-remediation.ts";
import { continuationCheckpointManifestSchema, factualRemediationContinuation, type ContinuationCheckpointManifest } from "./factual-remediation-continuation.ts";

const EVENT_SUFFIX = "event-30f226d1b8ba5c9eb8af2b65c46db512.json";
const RUN_ARTIFACT = "artifacts/factual-remediation-result-db368f10-d9c1-4897-b752-b3d2cb156e09.json";
const EXECUTION_ARTIFACT = "artifacts/factual-remediation-execution-12c2b2.json";
const CHECKPOINT_STAGES = ["verifier", "translator", "editor", "classifier", "ranker"] as const;

export type FactualRemediationContinuationCheckpointBundle = {
  manifest: ContinuationCheckpointManifest;
  checkpointHashes: Record<(typeof CHECKPOINT_STAGES)[number], string>;
  criticInput: ReturnType<typeof criticInputSchema.parse>;
  initial: PipelineEventContext;
  priorDispatchProven: true;
  criticCheckpointAbsent: true;
  providerCallsSoFar: 24;
};

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireIdentity(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_ARTIFACT_INVALID");
  return parsed as Record<string, unknown>;
}

export async function loadFactualRemediationContinuationCheckpoints(
  root = "artifacts/pipeline-checkpoints",
): Promise<FactualRemediationContinuationCheckpointBundle> {
  const sourceRunPath = join(root, factualRemediationContinuation.originalPipelineRunId);
  const paths = Object.fromEntries(CHECKPOINT_STAGES.map((stage) => [stage, join(sourceRunPath, `${stage}-${EVENT_SUFFIX}`)])) as Record<(typeof CHECKPOINT_STAGES)[number], string>;
  const raw = Object.fromEntries(await Promise.all(CHECKPOINT_STAGES.map(async (stage) => [stage, await readFile(paths[stage], "utf8")] as const))) as Record<(typeof CHECKPOINT_STAGES)[number], string>;
  const hashes = Object.fromEntries(CHECKPOINT_STAGES.map((stage) => [stage, sha256(raw[stage])])) as Record<(typeof CHECKPOINT_STAGES)[number], string>;
  for (const stage of CHECKPOINT_STAGES) {
    requireIdentity(hashes[stage] === factualRemediationContinuation.checkpointHashes[stage], `FACTUAL_REMEDIATION_CONTINUATION_${stage.toUpperCase()}_HASH_MISMATCH`);
  }

  const criticCheckpointPath = join(sourceRunPath, `critic-${EVENT_SUFFIX}`);
  try {
    await access(criticCheckpointPath);
    throw new Error("FACTUAL_REMEDIATION_CONTINUATION_CRITIC_CHECKPOINT_EXISTS");
  } catch (error) {
    if (error instanceof Error && error.message === "FACTUAL_REMEDIATION_CONTINUATION_CRITIC_CHECKPOINT_EXISTS") throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const verifier = await readSafeTranslatorCheckpoint(paths.verifier);
  const translator = await readSafeTranslatorCheckpoint(paths.translator);
  const editor = await readSafeTranslatorEditorCheckpoint(join(sourceRunPath, `editor-${EVENT_SUFFIX}`));
  const classifier = await readSafeClassifierPipelineCheckpoint(paths.classifier);
  const ranker = await readSafeRankerPipelineCheckpoint(paths.ranker);
  const eventKey = factualRemediationIncident.eventKey;
  requireIdentity([verifier, translator, editor, classifier, ranker].every((checkpoint) => checkpoint.eventKey === eventKey), "FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_EVENT_MISMATCH");
  requireIdentity(verifier.event.eventKey === eventKey && verifier.event.sourceItems.length === 1, "FACTUAL_REMEDIATION_CONTINUATION_EVENT_CHECKPOINT_INVALID");
  requireIdentity(same(verifier.verification, ranker.verification) && same(translator.verification, ranker.verification)
    && same(editor.verification, ranker.verification) && same(classifier.verification, ranker.verification), "FACTUAL_REMEDIATION_CONTINUATION_VERIFIER_LINEAGE_MISMATCH");
  requireIdentity(same(editor.translation, ranker.translation), "FACTUAL_REMEDIATION_CONTINUATION_TRANSLATION_LINEAGE_MISMATCH");
  requireIdentity(same(classifier.classification, ranker.classification), "FACTUAL_REMEDIATION_CONTINUATION_CLASSIFICATION_LINEAGE_MISMATCH");
  requireIdentity(classifier.editorial.headlineEs === ranker.editorial.headlineEs
    && classifier.editorial.summaryEs === ranker.editorial.summaryEs
    && classifier.editorial.whyItMattersEs === ranker.editorial.whyItMattersEs
    && same(classifier.editorial.keyPoints, ranker.editorial.keyPoints), "FACTUAL_REMEDIATION_CONTINUATION_EDITORIAL_LINEAGE_MISMATCH");

  const source = ranker.sources[0];
  const sourceEvidence = ranker.sourceEvidence[0];
  requireIdentity(ranker.sources.length === 1 && source && sourceEvidence
    && source.sourceId === factualRemediationIncident.sourceId
    && source.sourceName === "TechCrunch AI"
    && source.sourceItemId === sourceEvidence.sourceItemId
    && sourceEvidence.sourceId === factualRemediationIncident.sourceId
    && sourceEvidence.contentHash === factualRemediationIncident.rawContentHash
    && sourceEvidence.contentExcerpt.length <= 1_000
    && sourceEvidence.contentExcerpt.includes("The Wall Street Journal reports")
    && sourceEvidence.contentExcerpt.includes("the Journal writes")
    && sourceEvidence.contentExcerpt.includes("TechCrunch reached out to OpenAI"), "FACTUAL_REMEDIATION_CONTINUATION_ATTRIBUTION_EVIDENCE_INVALID");
  requireIdentity(ranker.verification.status === "single_source"
    && ranker.verification.uncertainClaims.length > 0
    && ranker.verification.verifiedFacts.length === 2, "FACTUAL_REMEDIATION_CONTINUATION_VERIFIED_ENVELOPE_INVALID");
  requireIdentity(ranker.editorial.bodyEs.includes("estándares de evaluación interna")
    && ranker.editorial.summaryEs.includes("Según TechCrunch"), "FACTUAL_REMEDIATION_CONTINUATION_EDITORIAL_RISK_SIGNAL_MISSING");

  const attemptArtifact = await readJson(RUN_ARTIFACT);
  const executionArtifact = await readJson(EXECUTION_ARTIFACT);
  const failure = attemptArtifact.eventResult as Record<string, unknown>;
  const failureDetails = failure.failure as Record<string, unknown>;
  const failureTelemetry = failureDetails.telemetry as Record<string, unknown>;
  const capacity = executionArtifact.capacityAfter as Record<string, unknown>;
  const stopReason = executionArtifact.stopReason as Record<string, unknown>;
  const stageCalls = executionArtifact.stageCalls as Record<string, unknown>;
  const criticResult = executionArtifact.criticResult as Record<string, unknown>;
  requireIdentity(attemptArtifact.attemptId === factualRemediationContinuation.attemptId
    && attemptArtifact.pipelineRunId === factualRemediationContinuation.originalPipelineRunId
    && failure.stopStage === "critic" && failure.stopReason === "cost_guard_violation"
    && failureDetails.errorCode === "cost_guard_violation"
    && failureDetails.providerRequestDispatched === false
    && failureDetails.providerRequestsUsed === 0
    && failureTelemetry.providerRequestsUsed === 0
    && stopReason.stage === "critic"
    && stopReason.stageReason === "GROQ_TPM_STAGE_EXCEEDS_TPM"
    && stopReason.estimatedStageTokens === 9_005
    && stopReason.providerRequestDispatched === false, "FACTUAL_REMEDIATION_CONTINUATION_FAILURE_ARTIFACT_MISMATCH");
  requireIdentity(capacity.groqRequestsReserved === 5 && capacity.groqRequestsDispatched === 5
    && capacity.groqUnknownTokenReservations === 0
    && stageCalls.critic === 0
    && criticResult.providerRequestReserved === false
    && criticResult.providerRequestDispatched === false
    && criticResult.providerRequestsUsed === 0, "FACTUAL_REMEDIATION_CONTINUATION_CANONICAL_LEDGER_SNAPSHOT_MISMATCH");

  const criticInput = criticInputSchema.parse({
    schemaVersion: 1,
    event: ranker.event,
    verification: ranker.verification,
    translation: ranker.translation,
    editorial: ranker.editorial,
    classification: ranker.classification,
    ranking: ranker.ranking,
    sources: ranker.sources,
    sourceEvidence: ranker.sourceEvidence,
    geo: ranker.geo,
  });
  const registry = createReferenceRegistry(
    [{ code: "US", name: "United States", latitude: 39.8283, longitude: -98.5795 }],
    ranker.classification.categorySlugs.map((slug) => ({ slug, name: slug })),
  );
  const prechecks = runCriticPrechecks(criticInput, { registry });
  requireIdentity(prechecks.passed, "FACTUAL_REMEDIATION_CONTINUATION_CRITIC_PRECHECK_FAILED");

  const initial: PipelineEventContext = {
    event: verifier.event,
    items: [],
    sources: ranker.sources.map((metadata) => ({
      ...metadata,
      rawItemId: factualRemediationIncident.rawItemId,
      sourceUrl: sourceEvidence.canonicalUrl,
    })),
    verification: ranker.verification,
    translation: ranker.translation,
    editorial: ranker.editorial,
    classification: ranker.classification,
    geo: {
      eventKey,
      primaryRegionCode: ranker.classification.primaryRegionCode,
      countryCodes: ranker.classification.countryCodes,
      latitude: ranker.geo.latitude,
      longitude: ranker.geo.longitude,
      resolutionLevel: ranker.geo.resolutionLevel,
      resolvedFrom: ranker.geo.resolvedFrom,
      provenance: ranker.geo.resolvedFrom ? "reference_registry" : "unresolved",
    },
    ranking: ranker.ranking.result,
    criticInputOverride: criticInput,
  };
  const manifest: ContinuationCheckpointManifest = continuationCheckpointManifestSchema.parse({
    schemaVersion: 1,
    eventKey,
    sourceRunId: factualRemediationContinuation.originalPipelineRunId,
    resumeStage: "critic",
    criticCheckpoint: "absent",
    checkpoints: hashes as ContinuationCheckpointManifest["checkpoints"],
  });
  return { manifest, checkpointHashes: hashes, criticInput, initial, priorDispatchProven: true, criticCheckpointAbsent: true, providerCallsSoFar: 24 };
}
