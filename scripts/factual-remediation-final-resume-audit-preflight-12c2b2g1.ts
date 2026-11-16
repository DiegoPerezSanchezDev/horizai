import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { factualGuardSnapshot, readFreshLiveState } from "./factual-remediation-final-resume-12c2b2g.ts";
import { estimateCriticV4Request } from "../lib/agents/critic/critic-estimate.ts";
import { loadFactualRemediationContinuationCheckpoints } from "../lib/agents/pipeline/factual-remediation-continuation-checkpoints.ts";
import {
  canonicalJsonString,
  continuationCheckpointManifestSchema,
  continuationCheckpointManifestsEqual,
  factualRemediationContinuation,
} from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { factualRemediationIncident } from "../lib/agents/pipeline/factual-remediation.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

const OUTPUT_PATH = resolve("artifacts/incident-lineage-guard-runner-preflight-12c2b2g1.json");
const PRIOR_PHASE_PATH = resolve("artifacts/factual-remediation-final-resume-12c2b2g.json");
const PILOT_BASELINE_PATH = resolve("artifacts/complete-real-content-pilot-12c.json");
const CRITIC_OUTPUT_RESERVE = 1_200;
const TPM_LIMIT = 8_000;
const TPM_SAFETY_MARGIN = 128;

function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, "utf8")));
}

async function writeResult(value: Record<string, unknown>): Promise<void> {
  await mkdir(resolve("artifacts"), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify({ ...value, recordedAtUtc: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const supabase = createSupabaseServerClient();
  const phase = await readJson(PRIOR_PHASE_PATH);
  const pilot = await readJson(PILOT_BASELINE_PATH);
  const priorProbe = object(phase.probe);
  const probeRequestAt = typeof priorProbe.requestDate === "string" ? priorProbe.requestDate : "";
  need(phase.pilotCallsFinal === 26 && phase.pilotCallLimit === 30
    && priorProbe.dispatched === true && priorProbe.runId
    && Number.isFinite(Date.parse(probeRequestAt)), "POST_PROBE_PILOT_BASELINE_INVALID");

  const fresh = await readFreshLiveState(supabase);
  const bundle = await loadFactualRemediationContinuationCheckpoints();
  const remoteManifest = continuationCheckpointManifestSchema.parse(fresh.continuationState.checkpointManifest);
  const localManifest = continuationCheckpointManifestSchema.parse(bundle.manifest);
  const localManifestHash = createHash("sha256").update(canonicalJsonString(localManifest)).digest("hex");
  const remoteManifestHash = createHash("sha256").update(canonicalJsonString(remoteManifest)).digest("hex");
  const manifestPass = continuationCheckpointManifestsEqual(localManifest, remoteManifest)
    && localManifestHash === remoteManifestHash
    && Object.keys(localManifest.checkpoints).length === 5
    && bundle.criticCheckpointAbsent;
  need(manifestPass, "POST_PROBE_MANIFEST_PREFLIGHT_FAILED");

  const pilotEvents = Array.isArray(pilot.perEventResults)
    ? pilot.perEventResults.map((entry) => object(entry).eventKey).filter((value): value is string => typeof value === "string")
    : [];
  need(pilotEvents.length > 0, "PILOT_EVENT_BASELINE_MISSING");
  const newerRuns = (await Promise.all(pilotEvents.map(async (eventKey) => {
    const result = await supabase.from("agent_runs").select("id,provider,stats,started_at")
      .eq("provider", "groq").eq("config->>eventKey", eventKey).gt("started_at", probeRequestAt);
    if (result.error) throw new Error(`POST_PROBE_PILOT_LEDGER_READ_FAILED:${result.error.code ?? "NO_CODE"}`);
    return result.data ?? [];
  }))).flat();
  need(newerRuns.length === 0, "PILOT_CALL_COUNT_CHANGED_AFTER_PHASE2G_PROBE");

  const estimate = estimateCriticV4Request(bundle.criticInput, CRITIC_OUTPUT_RESERVE);
  const factualGuards = factualGuardSnapshot(bundle);
  need(estimate.estimatedStageTokenRequirement === 6_397
    && estimate.estimatedStageTokenRequirement + TPM_SAFETY_MARGIN <= TPM_LIMIT,
  "CRITIC_V4_ESTIMATE_OR_SAFETY_MARGIN_CHANGED");

  const readAtUtc = new Date().toISOString();
  const probeAgeMs = Date.now() - Date.parse(probeRequestAt);
  const result = {
    phase: "12C.2B.2g.1",
    status: "PREFLIGHT_ONLY",
    preflightMode: "READ_ONLY; no probe, no resume RPC, no mutation",
    readAtUtc,
    articleId: factualRemediationIncident.articleId,
    attemptId: factualRemediationContinuation.attemptId,
    continuationId: factualRemediationContinuation.continuationPipelineRunId,
    pilotAttempts: "5/5",
    pilotCalls: { current: 26, limit: 30, newerGroqRunsAfterProbe: newerRuns.length },
    existingAuthorization: "REUSE",
    newAuthorization: false,
    sameAttempt: true,
    resumeConsumed: false,
    resumeExecutionId: null,
    lineageArchive: {
      eventId: fresh.event.id,
      eventKey: fresh.event.event_key,
      eventStatus: fresh.event.event_status,
      reviewStatus: fresh.event.review_status,
      articleId: fresh.article.id,
      articleEventId: fresh.article.event_id,
      slug: fresh.article.slug,
      publicationStatus: fresh.article.publication_status,
      publicCount: fresh.publicRows.length,
      incidentPublic: fresh.publicRows.some((row) => row.slug === factualRemediationIncident.articleSlug),
      sourceLineage: fresh.sourceLineage,
      guardComponentsCurrent: {
        eventOk: true,
        articleArchivedOk: true,
        incidentPublic: false,
        eventSourceCount: fresh.sourceLineage.eventSourceCount,
        sourceRawLineageMatch: fresh.sourceLineage.passed,
      },
    },
    attemptState: {
      count: fresh.attempts.length,
      currentAttemptNumber: fresh.current.attempt_number,
      currentFinalState: fresh.current.final_state,
      currentStopReason: fresh.current.stop_reason,
      continuationStatus: fresh.continuationState.status,
      resumeGeneration: fresh.continuationState.resumeGeneration ?? null,
      resumeHistoryLength: Array.isArray(fresh.continuationState.resumeHistory) ? fresh.continuationState.resumeHistory.length : 0,
    },
    critic: {
      reservation: "ABSENT",
      dispatch: "NO",
      checkpoint: "ABSENT",
      nextStage: "CRITIC",
      futureModelCalls: 1,
    },
    manifest: {
      status: "PASS",
      checkpointCount: Object.keys(localManifest.checkpoints).length,
      checkpointHashes: bundle.checkpointHashes,
      criticCheckpointAbsent: bundle.criticCheckpointAbsent,
      canonicalSha256: localManifestHash,
    },
    criticV4Estimate: {
      inputTokens: estimate.estimatedInputTokens,
      outputReserve: estimate.maxOutputTokens,
      totalPlannedTokens: estimate.estimatedStageTokenRequirement,
      tpmLimit: TPM_LIMIT,
      safetyMargin: TPM_SAFETY_MARGIN,
      safetyAdjustedHeadroom: TPM_LIMIT - estimate.estimatedStageTokenRequirement - TPM_SAFETY_MARGIN,
      factualGuards,
    },
    tpm: {
      state: probeAgeMs > 60_000 ? "STALE / NOT CHECKED" : "FRESHNESS_WINDOW_OPEN; NOT CHECKED",
      previousProbeAtUtc: probeRequestAt,
      previousProbeAgeMs: probeAgeMs,
      providerProbeMade: false,
    },
    historicalResumeGuard: {
      previousResult: "INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED",
      discrepancyReproduced: false,
      rootCauseExplainedFromExactEvidence: false,
      phaseExecutionGate: "BLOCKED_HISTORICAL_GUARD_DISCREPANCY_UNRESOLVED",
      resumeEligible: false,
    },
    calls: { provider: 0, resumeRpc: 0, remoteWrites: 0 },
  };
  await writeResult(result);
  process.stdout.write(`${JSON.stringify({ ...result, artifact: OUTPUT_PATH }, null, 2)}\n`);
}

main().catch(async (error: unknown) => {
  const reason = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 240) : "UNKNOWN_ERROR";
  const result = {
    phase: "12C.2B.2g.1",
    status: "BLOCKED",
    preflightMode: "READ_ONLY; no probe, no resume RPC, no mutation",
    blockReason: reason,
    calls: { provider: 0, resumeRpc: 0, remoteWrites: 0 },
  };
  await writeResult(result);
  process.stdout.write(`${JSON.stringify({ ...result, artifact: OUTPUT_PATH }, null, 2)}\n`);
  process.exitCode = 1;
});
