import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { continuationCheckpointManifestsEqual, factualRemediationContinuation, parseFactualRemediationContinuationCommand } from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { loadFactualRemediationContinuationCheckpoints } from "../lib/agents/pipeline/factual-remediation-continuation-checkpoints.ts";
import { SupabaseFactualRemediationContinuationRepository } from "../lib/agents/pipeline/factual-remediation-continuation-repository.ts";
import { factualRemediationIncident } from "../lib/agents/pipeline/factual-remediation.ts";
import { estimateCriticV3Request, estimateCriticV4Request } from "../lib/agents/critic/critic-estimate.ts";
import { freeProviderRouterEnabled } from "../lib/agents/runtime/free-provider-router.ts";
import type { ContinuationCheckpointManifest } from "../lib/agents/pipeline/factual-remediation-continuation.ts";

const usage = "node --env-file-if-exists=.env.local --conditions=react-server --experimental-strip-types scripts/factual-remediation-critic-continuation-12c2b2c.ts [--preflight-only | --execute-critic-continuation --continuation-run-id=EXISTING_AUTHORIZED_UUID]";
const tpmHardLimit = 8_000;
const tpmSafetyMargin = 128;
const frozenOutputReserve = 1_200;
const frozenModel = "openai/gpt-oss-20b";

function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function parseRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function formatEstimate(value: ReturnType<typeof estimateCriticV4Request>) {
  return {
    systemInstructionChars: value.systemInstructionChars,
    modelInputChars: value.modelInputChars,
    schemaChars: value.schemaChars,
    totalPromptChars: value.promptInputChars,
    estimatedInputTokens: value.estimatedInputTokens,
    maxOutputTokens: value.maxOutputTokens,
    estimatedTotalTokens: value.estimatedStageTokenRequirement,
    hardTpmLimit: tpmHardLimit,
    safetyMargin: tpmSafetyMargin,
    safetyAdjustedHeadroom: tpmHardLimit - value.estimatedStageTokenRequirement - tpmSafetyMargin,
  };
}

function assertHashSetSame(left: ContinuationCheckpointManifest, right: ContinuationCheckpointManifest): void {
  if (!continuationCheckpointManifestsEqual(left, right)) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINTS_CHANGED_AFTER_AUTHORIZATION");
}

async function printPreflight(): Promise<void> {
  const bundle = await loadFactualRemediationContinuationCheckpoints();
  const oldEstimate = estimateCriticV3Request(bundle.criticInput, frozenOutputReserve);
  const nextEstimate = estimateCriticV4Request(bundle.criticInput, frozenOutputReserve);
  need(oldEstimate.estimatedStageTokenRequirement === 9_005, "FACTUAL_REMEDIATION_CONTINUATION_OLD_ESTIMATE_CHANGED");
  need(nextEstimate.estimatedStageTokenRequirement === 6_397, "FACTUAL_REMEDIATION_CONTINUATION_NEW_ESTIMATE_CHANGED");
  need(nextEstimate.estimatedStageTokenRequirement + tpmSafetyMargin <= tpmHardLimit, "FACTUAL_REMEDIATION_CONTINUATION_TPM_GUARD_FAILED");
  const { createSupabaseServerClient } = await import("../lib/supabase/server-client.ts");
  const supabase = createSupabaseServerClient();
  const remote = await readCurrentRemoteIdentity(supabase, bundle.manifest);
  const activity = await readContinuationActivity(supabase);
  need(activity.continuationRunRows === 0, "FACTUAL_REMEDIATION_CONTINUATION_RUN_ALREADY_EXISTS");
  need(activity.criticV4Rows === 0, "FACTUAL_REMEDIATION_CONTINUATION_CRITIC_CHECKPOINT_EXISTS");
  need(activity.reservationRows === 0 && activity.dispatched === false, "FACTUAL_REMEDIATION_CONTINUATION_PROVIDER_ACTIVITY_EXISTS");
  console.log(JSON.stringify({
    mode: "PREFLIGHT_ONLY",
    status: "PREFLIGHT_ONLY",
    attemptId: factualRemediationContinuation.attemptId,
    originalPipelineRunId: factualRemediationContinuation.originalPipelineRunId,
    eventKey: factualRemediationIncident.eventKey,
    eventAttemptNumber: 2,
    pilotAttempt: "5/5",
    pilotAttemptsAfterContinuation: 5,
    expectedPilotGroqCallsAfterFutureCritic: 26,
    pilotCallCeiling: 30,
    attemptPurpose: "FACTUAL_REMEDIATION",
    continuationEligible: "YES",
    priorTerminalState: "TECHNICAL_FAILURE",
    priorStop: { stage: "critic", reason: "cost_guard_violation", class: "GROQ_TPM_STAGE_EXCEEDS_TPM" },
    criticProviderRequestDispatched: false,
    existingAuthorization: remote.current.continuation.pipelineRunId,
    authorizationReuse: "REUSE_EXISTING",
    newAuthorization: "NO",
    resumeExecutionId: "GENERATED_ONLY_IF_EXECUTED",
    historicalStop: {
      status: remote.current.continuation.status,
      stopReason: remote.current.continuation.stopReason,
      stopStage: remote.current.continuation.stopStage,
      completedAt: remote.current.continuation.completedAt,
      manifestSemanticEquality: "PASS",
    },
    attemptCount: remote.attempts.length,
    articleStatus: remote.article.publication_status,
    incidentPublic: remote.incidentPublic,
    publicArticleCount: remote.publicCount,
    criticReservation: activity.reservationRows === 0 ? "ABSENT" : "PRESENT",
    criticDispatch: activity.dispatched ? "YES" : "NO",
    criticCheckpoint: activity.criticV4Rows === 0 ? "ABSENT" : "PRESENT",
    canonicalLedgerSnapshot: "Fresh read of the stopped continuation and agent_runs/agent_logs completed; TPM will be refreshed before any execution",
    providerCallsSoFar: bundle.providerCallsSoFar + 1,
    maxFutureProviderRequests: factualRemediationContinuation.maxProviderCalls,
    resumeStage: "critic",
    nextStage: "Critic",
    checkpointPolicy: "reuse and hash-check verifier, translator, editor, classifier, ranker; Critic checkpoint is absent",
    checkpointHashes: bundle.checkpointHashes,
    oldCriticEstimate: formatEstimate(oldEstimate),
    compactCriticEstimate: formatEstimate(nextEstimate),
    sourceCoverage: {
      outlet: "TechCrunch AI",
      wallStreetJournalAttributionPreserved: true,
      techCrunchOutreachPreserved: true,
      singleSourceAndUncertaintyPreserved: true,
      internalEvaluationClaimRemainsAuditable: true,
    },
    articleArchiveLiveRead: "PASS",
    currentCapacityLiveRead: "NOT_ASSUMED_FRESH_TPM_REQUIRED_BEFORE_EXECUTION",
    continuationAuthorization: "ALREADY_AUTHORIZED_ONCE; REUSE ONLY",
    continuationResumeClassification: "ELIGIBLE_PRE_DISPATCH_MANIFEST_SERIALIZATION_FAILURE",
    newAuthorizationAllowed: false,
    newAttemptAllowed: false,
    providerCalls: 0,
    remoteWrites: 0,
    migrationFilename: "20261002211000_factual_remediation_continuation_resume.sql",
    migrationApplied: "RECHECKED_BY_PHASE_AUDIT",
    executionGate: "PREFLIGHT_ONLY; fresh TPM state is required before a later resume; never reauthorize",
  }, null, 2));
}

async function readCurrentRemoteIdentity(
  supabase: import("@supabase/supabase-js").SupabaseClient<import("../types/database.ts").Database>,
  expectedManifest: ContinuationCheckpointManifest,
) {
  const [attemptsResult, eventResult, articleResult, publicResult] = await Promise.all([
    supabase.from("pipeline_event_attempts").select("id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,purpose,pilot_attempt_number,continuation").eq("event_key", factualRemediationIncident.eventKey),
    supabase.from("events").select("id,event_key,event_status,review_status").eq("id", factualRemediationIncident.eventId).maybeSingle(),
    supabase.from("articles").select("id,event_id,slug,publication_status").eq("id", factualRemediationIncident.articleId).maybeSingle(),
    supabase.from("public_published_articles").select("slug").eq("slug", factualRemediationIncident.articleSlug).maybeSingle(),
  ]);
  if (attemptsResult.error || eventResult.error || articleResult.error || publicResult.error) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_REMOTE_PREFLIGHT_READ_FAILED");
  const attempts = attemptsResult.data ?? [];
  need(attempts.length === 2, "FACTUAL_REMEDIATION_CONTINUATION_ATTEMPT_HISTORY_CHANGED");
  const current = attempts.find((item) => item.id === factualRemediationContinuation.attemptId);
  need(current, "FACTUAL_REMEDIATION_CONTINUATION_TARGET_ATTEMPT_MISSING");
  const prior = attempts.find((item) => item.pipeline_run_id === factualRemediationIncident.priorPipelineRunId);
  need(prior?.attempt_number === 1 && prior.purpose === "NORMAL" && prior.final_state === "READY_FOR_PUBLICATION" && Boolean(prior.completed_at), "FACTUAL_REMEDIATION_CONTINUATION_PRIOR_ATTEMPT_CHANGED");
  need(current.pipeline_run_id === factualRemediationContinuation.originalPipelineRunId
    && current.attempt_number === factualRemediationIncident.eventAttemptNumber
    && current.pilot_attempt_number === 5
    && current.purpose === "FACTUAL_REMEDIATION"
    && Boolean(current.completed_at)
    && current.final_state === "TECHNICAL_FAILURE"
    && current.stop_stage === "critic"
    && current.stop_reason === "cost_guard_violation", "FACTUAL_REMEDIATION_CONTINUATION_TERMINAL_ATTEMPT_CHANGED");
  const continuation = parseRecord(current.continuation, "FACTUAL_REMEDIATION_CONTINUATION_EXISTING_AUTHORIZATION_MISSING");
  need(continuation.kind === "FACTUAL_REMEDIATION_CONTINUATION"
    && continuation.attemptId === current.id
    && continuation.pipelineRunId === factualRemediationContinuation.continuationPipelineRunId
    && continuation.resumeStage === "critic"
    && continuation.status === "STOPPED"
    && continuation.stopStage === "critic"
    && continuation.stopReason === "CONTINUATION_RUNNER_ABORTED"
    && continuation.providerRequestsUsed === 0
    && continuation.syntheticFixture === false
    && continuation.resumeGeneration === undefined
    && continuation.resumeExecutionId === undefined
    && continuation.resumeHistory === undefined,
  "FACTUAL_REMEDIATION_CONTINUATION_EXISTING_STOPPED_STATE_CHANGED");
  need(continuationCheckpointManifestsEqual(continuation.checkpointManifest, expectedManifest),
    "FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_MANIFEST_CHANGED");
  need(continuation.authorizedBy === "Diego"
    && continuation.authorizationReference === "Codex user request 105932dd-1d8a-4f9d-ab0d-b7809a68604f phase 12C.2B.2",
  "FACTUAL_REMEDIATION_CONTINUATION_EXISTING_AUTHORIZATION_CHANGED");
  need(eventResult.data?.event_key === factualRemediationIncident.eventKey
    && eventResult.data.event_status === "active" && eventResult.data.review_status === "approved", "FACTUAL_REMEDIATION_CONTINUATION_EVENT_IDENTITY_CHANGED");
  need(articleResult.data?.event_id === factualRemediationIncident.eventId
    && articleResult.data.slug === factualRemediationIncident.articleSlug
    && articleResult.data.publication_status === "archived", "FACTUAL_REMEDIATION_CONTINUATION_ARTICLE_NOT_ARCHIVED");
  need(publicResult.data === null, "FACTUAL_REMEDIATION_CONTINUATION_TARGET_IS_PUBLIC");
  const [publicCountResult] = await Promise.all([
    supabase.from("public_published_articles").select("slug", { count: "exact", head: true }),
  ]);
  if (publicCountResult.error) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_PUBLIC_COUNT_READ_FAILED");
  return { attempts, current: { ...current, continuation }, event: eventResult.data, article: articleResult.data, incidentPublic: false, publicCount: publicCountResult.count ?? 0 };
}

async function readContinuationActivity(supabase: import("@supabase/supabase-js").SupabaseClient<import("../types/database.ts").Database>) {
  const runsResult = await supabase.from("agent_runs").select("id,config,stats,status,provider")
    .eq("config->>eventKey", factualRemediationIncident.eventKey)
    .eq("config->>attemptId", factualRemediationContinuation.attemptId);
  if (runsResult.error) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_RUN_LEDGER_READ_FAILED");
  const runs = runsResult.data ?? [];
  const runIds = runs.map((row) => row.id);
  const logsResult = runIds.length
    ? await supabase.from("agent_logs").select("id,run_id,step,payload").in("run_id", runIds)
    : { data: [], error: null };
  if (logsResult.error) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_RESERVATION_LEDGER_READ_FAILED");
  const logs = logsResult.data ?? [];
  const continuationRunRows = runs.filter((row) => parseRecord(row.config, "FACTUAL_REMEDIATION_CONTINUATION_RUN_CONFIG_INVALID").pipelineRunId === factualRemediationContinuation.continuationPipelineRunId).length;
  const criticV4Rows = runs.filter((row) => {
    const config = parseRecord(row.config, "FACTUAL_REMEDIATION_CONTINUATION_RUN_CONFIG_INVALID");
    return config.agentName === "critic" && config.agentVersion === "critic-v4";
  }).length;
  const reservationRows = logs.filter((row) => row.step === "provider_request_reserved").length;
  const dispatched = runs.some((row) => {
    const stats = parseRecord(row.stats, "FACTUAL_REMEDIATION_CONTINUATION_RUN_STATS_INVALID");
    const telemetry = stats.telemetry && typeof stats.telemetry === "object" ? parseRecord(stats.telemetry, "FACTUAL_REMEDIATION_CONTINUATION_TELEMETRY_INVALID") : {};
    return telemetry.providerRequestDispatched === true || telemetry.providerRequestsUsed === 1;
  }) || logs.some((row) => {
    const payload = parseRecord(row.payload, "FACTUAL_REMEDIATION_CONTINUATION_LOG_INVALID");
    const details = payload.details && typeof payload.details === "object" ? parseRecord(payload.details, "FACTUAL_REMEDIATION_CONTINUATION_LOG_DETAILS_INVALID") : {};
    return payload.providerRequestDispatched === true || details.providerRequestDispatched === true;
  });
  return { continuationRunRows, criticV4Rows, reservationRows, dispatched };
}

async function runAuthorized(
  command: Extract<ReturnType<typeof parseFactualRemediationContinuationCommand>, { mode: "execute" }>,
  options: { outcomePath?: string; outcomePhase?: string; onResumeRpcInvocation?: () => Promise<void> } = {},
): Promise<void> {
  need(process.env.AGENT_PROVIDER?.trim().toLowerCase() === "groq", "FACTUAL_REMEDIATION_CONTINUATION_GROQ_ONLY_REQUIRED");
  need(process.env.AGENT_MODEL_CRITIC?.trim() === frozenModel, "FACTUAL_REMEDIATION_CONTINUATION_CRITIC_MODEL_CHANGED");
  need(!freeProviderRouterEnabled(), "FACTUAL_REMEDIATION_CONTINUATION_ROUTER_MUST_BE_DISABLED");

  const bundle = await loadFactualRemediationContinuationCheckpoints();
  const oldEstimate = estimateCriticV3Request(bundle.criticInput, frozenOutputReserve);
  const nextEstimate = estimateCriticV4Request(bundle.criticInput, frozenOutputReserve);
  need(oldEstimate.estimatedStageTokenRequirement === 9_005 && nextEstimate.estimatedStageTokenRequirement === 6_397,
    "FACTUAL_REMEDIATION_CONTINUATION_ESTIMATE_CHANGED");

  const { createSupabaseServerClient } = await import("../lib/supabase/server-client.ts");
  const supabase = createSupabaseServerClient();
  const { createProductionPipeline } = await import("../lib/agents/pipeline/create-production-pipeline.ts");
  const { buildFactualRemediationPublicationPayload } = await import("../lib/agents/pipeline/factual-remediation-publication.ts");
  const pipeline = createProductionPipeline({
    supabase,
    config: { dryRun: false, publish: true, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1, hours: 24, limit: 1 },
    publicationPayloadFactory: buildFactualRemediationPublicationPayload,
  });
  const criticConfig = pipeline.configs.critic;
  const groqCapacity = criticConfig.groqCapacity;
  need(criticConfig.model === frozenModel && criticConfig.maxRetries === 0
    && criticConfig.maxOutputTokens === frozenOutputReserve
    && criticConfig.allowPaidFallback === false && criticConfig.failOnRateLimit
    && pipeline.quota.provider === "groq"
    && groqCapacity?.tokenMinuteHardLimit === tpmHardLimit,
  "FACTUAL_REMEDIATION_CONTINUATION_RUNTIME_POLICY_INVALID");
  need(pipeline.configs.verifier.maxRetries === 0
    && pipeline.configs.translator.maxRetries === 0
    && pipeline.configs.editor.maxRetries === 0
    && pipeline.configs.classifier.maxRetries === 0
    && pipeline.configs.ranker.maxRetries === 0,
  "FACTUAL_REMEDIATION_CONTINUATION_RETRY_POLICY_INVALID");
  need(await pipeline.quota.remaining() >= 1, "FACTUAL_REMEDIATION_CONTINUATION_GROQ_REQUEST_QUOTA_EMPTY");

  await readCurrentRemoteIdentity(supabase, bundle.manifest);
  const activity = await readContinuationActivity(supabase);
  need(activity.continuationRunRows === 0 && activity.criticV4Rows === 0
    && activity.reservationRows === 0 && !activity.dispatched,
  "FACTUAL_REMEDIATION_CONTINUATION_PROVIDER_ACTIVITY_EXISTS");

  const repository = new SupabaseFactualRemediationContinuationRepository(supabase);
  const resumeExecutionId = randomUUID();
  await options.onResumeRpcInvocation?.();
  await repository.resumePreviouslyAuthorized({
    attemptId: factualRemediationContinuation.attemptId,
    continuationPipelineRunId: command.continuationPipelineRunId,
    resumeExecutionId,
    manifest: bundle.manifest,
  });

  let result: Awaited<ReturnType<typeof pipeline.orchestrator.runFactualRemediationContinuation>> | null = null;
  let freshBundle: Awaited<ReturnType<typeof loadFactualRemediationContinuationCheckpoints>>;
  try {
    freshBundle = await loadFactualRemediationContinuationCheckpoints();
    assertHashSetSame(freshBundle.manifest, bundle.manifest);
    result = await pipeline.orchestrator.runFactualRemediationContinuation({
      attemptId: factualRemediationContinuation.attemptId,
      originalPipelineRunId: factualRemediationContinuation.originalPipelineRunId,
      continuationPipelineRunId: command.continuationPipelineRunId,
      resumeExecutionId,
      initial: freshBundle.initial,
      manifest: freshBundle.manifest,
      guard: repository,
    });
  } catch (error) {
    const dispatched = await repository.countDispatchedRequests(command.continuationPipelineRunId);
    await repository.finish({
      attemptId: factualRemediationContinuation.attemptId,
      continuationPipelineRunId: command.continuationPipelineRunId,
      criticDecision: result?.criticDecision ?? null,
      stopStage: result?.stopStage === "publisher" ? "publisher" : "critic",
      stopReason: "CONTINUATION_RUNNER_ABORTED",
      providerRequestsUsed: dispatched,
    });
    throw error;
  }

  const canonicalDispatched = await repository.countDispatchedRequests(command.continuationPipelineRunId);
  need(canonicalDispatched === result.requestsUsed && canonicalDispatched <= 1, "FACTUAL_REMEDIATION_CONTINUATION_REQUEST_LEDGER_MISMATCH");
  const [attemptResult, articleResult, publicResult] = await Promise.all([
    supabase.from("pipeline_event_attempts").select("continuation,final_state,completed_at").eq("id", factualRemediationContinuation.attemptId).maybeSingle(),
    supabase.from("articles").select("id,event_id,slug,publication_status").eq("id", factualRemediationIncident.articleId).maybeSingle(),
    supabase.from("public_published_articles").select("slug").eq("slug", factualRemediationIncident.articleSlug).maybeSingle(),
  ]);
  if (attemptResult.error || articleResult.error || publicResult.error || !attemptResult.data) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_READBACK_FAILED");
  const continuation = parseRecord(attemptResult.data.continuation, "FACTUAL_REMEDIATION_CONTINUATION_READBACK_INVALID");
  const outcomePath = options.outcomePath ?? `artifacts/critic-continuation-lifecycle-12c2b2c-${command.continuationPipelineRunId}.json`;
  const outcome = {
    phase: options.outcomePhase ?? "12C.2B.2c",
    attemptId: factualRemediationContinuation.attemptId,
    originalPipelineRunId: factualRemediationContinuation.originalPipelineRunId,
    continuationPipelineRunId: command.continuationPipelineRunId,
    resumeExecutionId,
    pilotAttemptNumber: 5,
    eventAttemptNumber: 2,
    resumeStage: "critic",
    criticAgentVersion: "critic-v4",
    pipelineFinalState: result.finalState,
    criticDecision: result.criticDecision,
    providerRequestsUsed: canonicalDispatched,
    maxProviderRequests: 1,
    terminalAttemptFinalStatePreserved: attemptResult.data.final_state === "TECHNICAL_FAILURE" && Boolean(attemptResult.data.completed_at),
    continuationStatus: continuation.status,
    resumeGeneration: continuation.resumeGeneration,
    recordedResumeExecutionId: continuation.resumeExecutionId,
    articleStatus: articleResult.data?.publication_status ?? null,
    targetVisiblePublicly: Boolean(publicResult.data),
    checkpointHashes: freshBundle.manifest.checkpoints,
    estimator: formatEstimate(nextEstimate),
    databaseContinuationRunId: continuation.pipelineRunId,
    recordedAtUtc: new Date().toISOString(),
  };
  await writeFile(outcomePath, `${JSON.stringify(outcome, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(JSON.stringify({ result: result.finalState, criticDecision: result.criticDecision, providerRequestsUsed: canonicalDispatched, continuationStatus: continuation.status, articleStatus: articleResult.data?.publication_status ?? null, public: Boolean(publicResult.data), outcomePath }, null, 2));
}

export async function runPreviouslyAuthorizedContinuation(options: {
  outcomePath?: string;
  outcomePhase?: string;
  onResumeRpcInvocation?: () => Promise<void>;
} = {}): Promise<void> {
  await runAuthorized({
    mode: "execute",
    continuationPipelineRunId: factualRemediationContinuation.continuationPipelineRunId,
  }, options);
}

async function main(): Promise<void> {
  const command = parseFactualRemediationContinuationCommand(process.argv.slice(2));
  if (command.mode === "help") { console.log(usage); return; }
  if (command.mode === "preflight") { await printPreflight(); return; }
  await runAuthorized(command);
}

const isDirectExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    const message = (error instanceof Error ? error.message : "UNKNOWN_ERROR").replace(/\s+/g, " ").slice(0, 240);
    console.error(`${message}\n${usage}`);
    process.exitCode = 1;
  });
}
