import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { assertPilotAttemptBaseline, createFactualRemediationPlan, factualRemediationIncident, parseFactualRemediationCommand } from "../lib/agents/pipeline/factual-remediation.ts";
import { loadFactualRemediationInput } from "../lib/agents/pipeline/factual-remediation-input.ts";
import { buildFactualRemediationPublicationPayload } from "../lib/agents/pipeline/factual-remediation-publication.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { SupabaseFactualRemediationRepository } from "../lib/agents/pipeline/factual-remediation-repository.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

const evidencePath = "artifacts/published-factual-incident-12c1.json";
const usage = "node --env-file-if-exists=.env.local --conditions=react-server --experimental-strip-types scripts/factual-remediation-12c2b0.ts [--preflight-only | --execute-factual-remediation --authorized-by=NAME --authorization-reference=REF --reason=TEXT]";

async function evidenceArtifactHash(): Promise<string> {
  const bytes = await readFile(evidencePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function conciseError(error: unknown): string {
  return (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/\s+/g, " ").slice(0, 240);
}

async function run(): Promise<void> {
  const command = parseFactualRemediationCommand(process.argv.slice(2));
  if (command.mode === "help") {
    console.log(usage);
    return;
  }

  const plan = createFactualRemediationPlan();
  const supabase = createSupabaseServerClient();
  const normalAttempts = new SupabasePipelineEventAttemptRepository(supabase);
  const remediationAttempts = new SupabaseFactualRemediationRepository(supabase);
  const baselineResult = await supabase.from("pipeline_event_attempts").select("event_key,pipeline_run_id,attempt_number,final_state");
  if (baselineResult.error) throw new Error("FACTUAL_REMEDIATION_ATTEMPT_AUDIT_READ_FAILED");
  const baseline = (baselineResult.data ?? []).map((attempt) => ({ eventKey: attempt.event_key, pipelineRunId: attempt.pipeline_run_id, attemptNumber: attempt.attempt_number, finalState: attempt.final_state }));
  assertPilotAttemptBaseline(baseline);
  await loadFactualRemediationInput(supabase);
  const publicBefore = await supabase.from("public_published_articles").select("slug").eq("slug", factualRemediationIncident.articleSlug).maybeSingle();
  if (publicBefore.error) throw new Error("FACTUAL_REMEDIATION_PUBLIC_CONTRACT_READ_FAILED");
  if (publicBefore.data) throw new Error("FACTUAL_REMEDIATION_TARGET_STILL_PUBLIC");

  const pipeline = createProductionPipeline({
    supabase,
    factualRemediationAttemptGuard: remediationAttempts,
    config: { dryRun: false, publish: true, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1, hours: 24, limit: 1 },
    publicationPayloadFactory: buildFactualRemediationPublicationPayload,
  });
  const preflight = await pipeline.preflight();
  if (preflight.provider.toLowerCase() !== "groq" || preflight.quotaProvider !== "groq") throw new Error("FACTUAL_REMEDIATION_PROVIDER_MUST_BE_GROQ");
  if (Object.values(preflight.maxRetries).some((retries) => retries !== 0)) throw new Error("FACTUAL_REMEDIATION_RETRIES_MUST_BE_ZERO");
  if (preflight.allowPaidFallback || !preflight.failOnRateLimit || preflight.requiredRequests !== plan.maxGroqCalls) throw new Error("FACTUAL_REMEDIATION_PROVIDER_GUARDS_INVALID");
  if (preflight.quotaRemaining < plan.maxGroqCalls) throw new Error("FACTUAL_REMEDIATION_INSUFFICIENT_GROQ_CAPACITY");

  console.log(JSON.stringify({
    mode: command.mode,
    incident: { eventId: plan.eventId, eventKey: plan.eventKey, articleId: plan.articleId, slug: plan.articleSlug, rawItemId: plan.rawItemId },
    purpose: plan.purpose,
    startStage: plan.startStage,
    stages: plan.stages,
    storedExtraction: "validated-and-reused",
    oldCheckpointsFromVerifierOnward: "ignored",
    attemptAccounting: `${plan.pilotAttemptBefore} -> ${command.mode === "execute" ? plan.pilotAttemptAfterClaim : "unchanged"}`,
    maxGroqCalls: plan.maxGroqCalls,
    maxRetries: 0,
    quotaRemaining: preflight.quotaRemaining,
    providerCallsSoFar: 0,
    remoteWritesSoFar: 0,
    modeNote: command.mode === "preflight" ? "PREFLIGHT ONLY: no claim, provider call, publication, or write" : "EXECUTION EXPLICITLY REQUESTED",
  }, null, 2));
  if (command.mode === "preflight") return;

  const pipelineRunId = randomUUID();
  const lease = await remediationAttempts.claim(pipelineRunId, command);
  let finalized = false;
  try {
    const beforeEvidenceHash = await evidenceArtifactHash();
    const auditPath = `artifacts/factual-remediation-${pipelineRunId}.json`;
    await writeFile(auditPath, JSON.stringify({
      phase: "12C.2B.2",
      pipelineRunId,
      attemptId: lease.attempt.id,
      pilotAttemptNumber: lease.pilotAttemptNumber,
      purpose: lease.purpose,
      startStage: lease.startStage,
      eventId: plan.eventId,
      eventKey: plan.eventKey,
      articleId: lease.articleId,
      articleSlug: lease.articleSlug,
      rawItemId: lease.rawItemId,
      rawContentLength: factualRemediationIncident.rawContentLength,
      rawContentSha256: factualRemediationIncident.rawContentSha256,
      rawContentHash: factualRemediationIncident.rawContentHash,
      priorSnapshotArtifact: evidencePath,
      priorSnapshotArtifactSha256: beforeEvidenceHash,
      authorizedBy: command.authorizedBy,
      authorizationReference: command.authorizationReference,
      reason: command.reason,
      stages: plan.stages,
      maxGroqCalls: plan.maxGroqCalls,
      maxRetries: 0,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });

    // Re-read and re-hash immediately after the atomic claim, still before any provider call.
    const executionInput = await loadFactualRemediationInput(supabase);
    const result = await pipeline.orchestrator.runFactualRemediation({ lease, initial: executionInput });
    finalized = true;
    const articleAfter = await supabase.from("articles").select("id,event_id,slug,publication_status").eq("id", lease.articleId).maybeSingle();
    const publicAfter = await supabase.from("public_published_articles").select("slug,headline_es,summary_es,body_es,published_at").eq("slug", lease.articleSlug).maybeSingle();
    if (articleAfter.error || publicAfter.error) throw new Error("FACTUAL_REMEDIATION_PUBLICATION_READBACK_FAILED");
    if (result.finalState === "SUCCESS" && (!articleAfter.data || articleAfter.data.id !== lease.articleId || articleAfter.data.slug !== lease.articleSlug || articleAfter.data.publication_status !== "published" || !publicAfter.data)) {
      throw new Error("FACTUAL_REMEDIATION_PUBLICATION_READBACK_MISMATCH");
    }
    const auditResultPath = `artifacts/factual-remediation-result-${pipelineRunId}.json`;
    await writeFile(auditResultPath, JSON.stringify({
      phase: "12C.2B.2",
      pipelineRunId,
      attemptId: lease.attempt.id,
      pipelineFinalState: result.finalState,
      eventResult: result,
      articleAfter: articleAfter.data,
      publicAfter: publicAfter.data,
      articleRemainsArchived: articleAfter.data?.publication_status === "archived",
      publishedSameArticleAndSlug: articleAfter.data?.id === lease.articleId && articleAfter.data.slug === lease.articleSlug && Boolean(publicAfter.data),
      recordedAt: new Date().toISOString(),
    }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    console.log(JSON.stringify({ result: result.finalState, providerRequestsUsed: result.requestsUsed, articleId: articleAfter.data?.id ?? null, slug: articleAfter.data?.slug ?? null, public: Boolean(publicAfter.data), auditResultPath }, null, 2));
  } catch (error) {
    if (!finalized) {
      await normalAttempts.finalize({
        attemptId: lease.attempt.id,
        pipelineRunId,
        completedAt: new Date().toISOString(),
        finalState: "ABORTED",
        stopStage: "verifier",
        stopReason: "FACTUAL_REMEDIATION_RUNNER_ABORTED",
        retryClass: "NONE",
        countsTowardRetryLimit: false,
        nextEligibleAt: null,
      });
    }
    throw new Error(`FACTUAL_REMEDIATION_FAILED:${conciseError(error)}`);
  }
}

run().catch((error: unknown) => {
  console.error(`${conciseError(error)}\n${usage}`);
  process.exitCode = 1;
});
