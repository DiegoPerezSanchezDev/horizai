import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";

const attemptId = "dfada4fd-d9c6-4aa8-bfef-6d9447267e06";
const pipelineRunId = "3aa65ec9-448f-42ea-b53c-39bc24c70fb8";
const eventKey = "event-0c4ed88cddcd4f96c3d6f2983ced7de7";
const astraArticleId = "756b0ee0-b5e6-4153-846f-278a12c9afe3";
const terminalReason = "CAPACITY_RESUME_EVIDENCE_UNAVAILABLE";
const artifactPath = resolve("artifacts/supervised-cycle-12f3-reconciliation.json");
const checkpointDirectory = resolve(`artifacts/pipeline-checkpoints/${pipelineRunId}`);
const expectedFingerprints = [
  { id: "6203559f-413a-4f06-9346-1720bbeb0e7a", fingerprint: "73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64" },
  { id: "7415c685-04ed-4956-a77a-4bc372c9b060", fingerprint: "728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b" },
];
const checkpointFiles = [
  "verifier-event-0c4ed88cddcd4f96c3d6f2983ced7de7.json",
  "translator-event-0c4ed88cddcd4f96c3d6f2983ced7de7.json",
];
const readRpcPaths = new Set([
  "/rest/v1/rpc/get_pipeline_human_review_operator_status",
  "/rest/v1/rpc/list_pipeline_human_reviews_operator",
]);

const originalFetch = globalThis.fetch.bind(globalThis);
const expectedOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin : "";
const diagnostics = [];
let allowFinalize = false;
let finalizeHttpRequests = 0;

globalThis.fetch = async (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(requestUrl);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const sameProject = url.origin === expectedOrigin && url.pathname.startsWith("/rest/v1/");
  const ordinaryRead = sameProject && ["GET", "HEAD"].includes(method);
  const readRpc = sameProject && method === "POST" && readRpcPaths.has(url.pathname);
  const finalizePath = sameProject && url.pathname === "/rest/v1/rpc/finalize_pipeline_event_attempt";

  if (finalizePath) {
    if (!allowFinalize || method !== "POST" || finalizeHttpRequests !== 0) {
      throw new Error("RECONCILIATION_FINALIZE_FETCH_GUARD_BLOCKED");
    }
    finalizeHttpRequests += 1;
  } else if (!ordinaryRead && !readRpc) {
    throw new Error("RECONCILIATION_READ_ONLY_FETCH_GUARD_BLOCKED");
  }

  const response = await originalFetch(input, init);
  diagnostics.push({ method, path: url.pathname, status: response.status });
  return response;
};

function expectRead(response, label) {
  if (response.error) throw new Error(`${label}:${response.error.code ?? "POSTGREST_ERROR"}`);
  if (response.data === null) throw new Error(`${label}:NO_DATA`);
  return response.data;
}

function safeRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function checkpointEvidence() {
  const checkpoints = checkpointFiles.map((name) => {
    const path = resolve(checkpointDirectory, name);
    if (!existsSync(path)) throw new Error("RECONCILIATION_REQUIRED_CHECKPOINT_MISSING");
    const checkpoint = JSON.parse(readFileSync(path, "utf8"));
    const sourceRows = Array.isArray(checkpoint.sources) ? checkpoint.sources : [];
    return {
      file: name,
      exists: true,
      eventKeyMatches: checkpoint.eventKey === eventKey,
      fullItemsPresent: Array.isArray(checkpoint.items),
      rawItemIdPresent: sourceRows.some((source) => typeof source.rawItemId === "string" && source.rawItemId.length > 0),
      capacityResumeSnapshotPresent: Object.hasOwn(checkpoint, "capacityResumeSnapshot"),
    };
  });
  if (checkpoints.some((checkpoint) => !checkpoint.eventKeyMatches)) throw new Error("RECONCILIATION_CHECKPOINT_EVENT_MISMATCH");
  return checkpoints;
}

function compactUsage(usage) {
  return {
    requestsReserved: usage.requestsReserved,
    requestsDispatched: usage.requestsDispatched,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    unknownTokenRequests: usage.unknownTokenRequests,
  };
}

async function readEvidence(supabase) {
  const attemptResponse = await supabase.from("pipeline_event_attempts")
    .select("id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,next_eligible_at,capacity_resume_snapshot,validation_namespace")
    .eq("id", attemptId)
    .maybeSingle();
  if (attemptResponse.error) throw new Error(`RECONCILIATION_ATTEMPT_READ:${attemptResponse.error.code ?? "POSTGREST_ERROR"}`);
  const attempt = attemptResponse.data;

  const attemptsResponse = await supabase.from("pipeline_event_attempts")
    .select("id,started_at,completed_at,final_state,stop_stage,stop_reason,validation_namespace")
    .is("validation_namespace", null);
  const attempts = expectRead(attemptsResponse, "RECONCILIATION_ATTEMPTS_READ");
  const now = Date.now();
  const activeAttempts = attempts.filter((row) => row.completed_at === null && row.final_state === null);
  const deferredAttempts = activeAttempts.filter((row) => row.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED" || row.stop_reason?.startsWith("CAPACITY_RESUME_CLAIMED:") === true);
  const stuckAttempts = activeAttempts.filter((row) => Date.parse(row.started_at) + 60 * 60 * 1000 <= now);

  const articleResponse = await supabase.from("articles")
    .select("id,slug,headline_es,summary_es,why_it_matters_es,body_es,metadata,publication_status")
    .eq("publication_status", "published")
    .order("id", { ascending: true });
  const articles = expectRead(articleResponse, "RECONCILIATION_PUBLIC_ARTICLES_READ");
  const fingerprints = articles.map((article) => ({ id: article.id, fingerprint: publicArticleFingerprintV1(article) }));

  const astraResponse = await supabase.from("articles").select("id,publication_status").eq("id", astraArticleId).maybeSingle();
  if (astraResponse.error) throw new Error(`RECONCILIATION_ASTRA_READ:${astraResponse.error.code ?? "POSTGREST_ERROR"}`);

  const runsResponse = await supabase.from("agent_runs").select("config,stats,provider").contains("config", { pipelineRunId });
  const runs = expectRead(runsResponse, "RECONCILIATION_STAGE_RUNS_READ");
  const stageRuns = runs.map((row) => {
    const config = safeRecord(row.config);
    const telemetry = safeRecord(safeRecord(row.stats).telemetry);
    return {
      stage: typeof config.agentName === "string" ? config.agentName : "unknown",
      requestDispatched: telemetry.providerRequestDispatched === true,
      providerRequestsUsed: Number.isSafeInteger(telemetry.providerRequestsUsed) ? telemetry.providerRequestsUsed : 0,
    };
  });

  const reviewRepository = new SupabaseHumanReviewReadRepository(supabase);
  const [reviewStatus, reviewList] = await Promise.all([reviewRepository.status(), reviewRepository.list(500)]);

  const utcDay = new Date().toISOString().slice(0, 10);
  const logger = new SupabaseAgentLogger(supabase);
  const providerAccounting = Object.fromEntries(await Promise.all(["groq", "cloudflare_workers_ai", "cerebras"].map(async (provider) => {
    return [provider, compactUsage(await logger.getProviderDailyUsage(provider, utcDay))];
  })));

  return {
    capturedAtUtc: new Date().toISOString(),
    attempt: attempt ? {
      id: attempt.id,
      eventKey: attempt.event_key,
      pipelineRunId: attempt.pipeline_run_id,
      attemptNumber: attempt.attempt_number,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
      finalState: attempt.final_state,
      stopStage: attempt.stop_stage,
      stopReason: attempt.stop_reason,
      retryClass: attempt.retry_class,
      countsTowardRetryLimit: attempt.counts_toward_retry_limit,
      nextEligibleAt: attempt.next_eligible_at,
      capacityResumeSnapshotPresent: attempt.capacity_resume_snapshot !== null,
      validationNamespace: attempt.validation_namespace,
    } : null,
    attemptsTotal: attempts.length,
    activeAttemptIds: activeAttempts.map((row) => row.id),
    deferredAttemptIds: deferredAttempts.map((row) => row.id),
    stuckAttemptIds: stuckAttempts.map((row) => row.id),
    publicArticleCount: articles.length,
    publicFingerprints: fingerprints,
    astraPublicationStatus: astraResponse.data?.publication_status ?? null,
    reviewCount: reviewStatus.totalReviews,
    waitingReviewCount: reviewStatus.waitingReviews,
    listedReviewCount: reviewList.reviews.length,
    editorRuns: stageRuns.filter((row) => row.stage === "editor"),
    publisherRunCount: stageRuns.filter((row) => row.stage === "publisher" || row.stage === "publish").length,
    checkpoints: checkpointEvidence(),
    providerAccounting,
  };
}

function assertCommonBaseline(evidence) {
  if (!evidence.attempt || evidence.attempt.id !== attemptId || evidence.attempt.pipelineRunId !== pipelineRunId || evidence.attempt.eventKey !== eventKey) {
    throw new Error("RECONCILIATION_ATTEMPT_IDENTITY_MISMATCH");
  }
  if (evidence.attempt.attemptNumber !== 1 || evidence.attempt.validationNamespace !== null) throw new Error("RECONCILIATION_ATTEMPT_NOT_REAL_TARGET");
  if (evidence.attemptsTotal !== 11) throw new Error("RECONCILIATION_REAL_ATTEMPT_COUNT_CHANGED");
  if (evidence.publicArticleCount !== 2 || JSON.stringify(evidence.publicFingerprints) !== JSON.stringify(expectedFingerprints)) throw new Error("RECONCILIATION_PUBLIC_BASELINE_CHANGED");
  if (evidence.astraPublicationStatus !== "archived") throw new Error("RECONCILIATION_ASTRA_NOT_ARCHIVED");
  if (evidence.reviewCount !== 0 || evidence.waitingReviewCount !== 0 || evidence.listedReviewCount !== 0) throw new Error("RECONCILIATION_REVIEWS_NOT_EMPTY");
  if (evidence.publisherRunCount !== 0) throw new Error("RECONCILIATION_PUBLISHER_RUN_FOUND");
  const editorRuns = evidence.editorRuns;
  if (editorRuns.length === 0 || editorRuns.some((row) => row.requestDispatched || row.providerRequestsUsed !== 0)) throw new Error("RECONCILIATION_EDITOR_DISPATCH_EVIDENCE_CONFLICT");
  if (evidence.checkpoints.length !== 2 || evidence.checkpoints.some((checkpoint) => !checkpoint.exists || !checkpoint.eventKeyMatches)) throw new Error("RECONCILIATION_CHECKPOINT_BASELINE_INVALID");
  if (evidence.checkpoints.some((checkpoint) => checkpoint.fullItemsPresent || checkpoint.rawItemIdPresent || checkpoint.capacityResumeSnapshotPresent)) {
    throw new Error("RECONCILIATION_UNEXPECTED_RESUME_LINEAGE_EVIDENCE");
  }
  const expectedUsage = {
    groq: { requestsReserved: 2, requestsDispatched: 2, inputTokens: 3663, outputTokens: 2115, totalTokens: 5778, unknownTokenRequests: 0 },
    cloudflare_workers_ai: { requestsReserved: 0, requestsDispatched: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownTokenRequests: 0 },
    cerebras: { requestsReserved: 0, requestsDispatched: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownTokenRequests: 0 },
  };
  if (JSON.stringify(evidence.providerAccounting) !== JSON.stringify(expectedUsage)) throw new Error("RECONCILIATION_PROVIDER_BASELINE_CHANGED");
}

function assertPrecheck(evidence) {
  assertCommonBaseline(evidence);
  if (evidence.attempt.completedAt !== null || evidence.attempt.finalState !== null
    || evidence.attempt.stopStage !== null || evidence.attempt.stopReason !== null
    || evidence.attempt.retryClass !== "NONE" || evidence.attempt.countsTowardRetryLimit !== false
    || evidence.attempt.nextEligibleAt !== null || evidence.attempt.capacityResumeSnapshotPresent) {
    throw new Error("RECONCILIATION_ATTEMPT_NOT_ACTIVE_OR_HAS_CONFLICTING_STATE");
  }
  if (evidence.activeAttemptIds.length !== 1 || evidence.activeAttemptIds[0] !== attemptId || evidence.deferredAttemptIds.length !== 0) {
    throw new Error("RECONCILIATION_ACTIVE_OR_DEFERRED_ATTEMPT_CONFLICT");
  }
}

function assertPostcheck(before, after) {
  assertCommonBaseline(after);
  if (JSON.stringify(after.providerAccounting) !== JSON.stringify(before.providerAccounting)) throw new Error("RECONCILIATION_PROVIDER_ACCOUNTING_CHANGED");
  if (after.attempt.completedAt === null || after.attempt.finalState !== "ABORTED" || after.attempt.stopStage !== "editor"
    || after.attempt.stopReason !== terminalReason || after.attempt.retryClass !== "NONE"
    || after.attempt.countsTowardRetryLimit !== false || after.attempt.nextEligibleAt !== null
    || after.attempt.capacityResumeSnapshotPresent) throw new Error("RECONCILIATION_FINAL_ATTEMPT_STATE_INVALID");
  if (after.activeAttemptIds.length !== 0 || after.deferredAttemptIds.length !== 0 || after.stuckAttemptIds.length !== 0) {
    throw new Error("RECONCILIATION_OPEN_ATTEMPT_RESIDUAL");
  }
}

function saveStartedArtifact(before) {
  const started = {
    phase: "12F.3R",
    status: "RPC_INVOCATION_STARTED_NO_RETRY",
    attemptId,
    pipelineRunId,
    previousState: "ACTIVE",
    terminalRpc: "finalize_pipeline_event_attempt",
    rpcInvocationCount: 0,
    precheck: before,
  };
  const fd = openSync(artifactPath, "wx");
  try { writeFileSync(fd, `${JSON.stringify(started, null, 2)}\n`); } finally { closeSync(fd); }
  return started;
}

function replaceArtifact(value) {
  writeFileSync(artifactPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const operation = process.argv[2];
  if (!new Set(["--precheck", "--execute-once"]).has(operation)) throw new Error("RECONCILIATION_OPERATION_INVALID");
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error("RECONCILIATION_SERVER_ENV_MISSING");
  const supabase = createSupabaseServerClient();
  const before = await readEvidence(supabase);
  assertPrecheck(before);

  if (operation === "--precheck") {
    console.log(JSON.stringify({ phase: "12F.3R", precheck: "PASS", reconciliationSafe: false, safeTerminalRpc: "finalize_pipeline_event_attempt", terminalRpcCanCompareAndSetActiveAttempt: true, readEvidence: before, remoteWrites: 0, providerCalls: 0 }, null, 2));
    return;
  }

  if (existsSync(artifactPath)) throw new Error("RECONCILIATION_RPC_ALREADY_ATTEMPTED_NO_RETRY");
  const artifact = saveStartedArtifact(before);
  const rpcArguments = {
    p_attempt_id: attemptId,
    p_pipeline_run_id: pipelineRunId,
    p_completed_at: new Date().toISOString(),
    p_final_state: "ABORTED",
    p_stop_stage: "editor",
    p_stop_reason: terminalReason,
    p_retry_class: "NONE",
    p_counts_toward_retry_limit: false,
    p_next_eligible_at: null,
  };

  let response;
  allowFinalize = true;
  try {
    response = await supabase.rpc("finalize_pipeline_event_attempt", rpcArguments);
  } catch (error) {
    allowFinalize = false;
    replaceArtifact({
      ...artifact,
      status: "RPC_OUTCOME_UNKNOWN_STOP_NO_RETRY",
      rpcInvocationCount: finalizeHttpRequests,
      rpcHttpDiagnostics: diagnostics.filter((entry) => entry.path.endsWith("/finalize_pipeline_event_attempt")),
      safeError: error instanceof Error ? error.message.split(":")[0] : "UNKNOWN",
    });
    throw new Error("RECONCILIATION_RPC_OUTCOME_UNKNOWN_NO_RETRY");
  } finally {
    allowFinalize = false;
  }

  if (finalizeHttpRequests !== 1) {
    replaceArtifact({ ...artifact, status: "RPC_REQUEST_COUNT_INVALID_NO_RETRY", rpcInvocationCount: finalizeHttpRequests });
    throw new Error("RECONCILIATION_RPC_REQUEST_COUNT_INVALID_NO_RETRY");
  }
  if (response.error) {
    replaceArtifact({
      ...artifact,
      status: "RPC_RETURNED_ERROR_NO_RETRY",
      rpcInvocationCount: finalizeHttpRequests,
      rpcHttpDiagnostics: diagnostics.filter((entry) => entry.path.endsWith("/finalize_pipeline_event_attempt")),
      errorCode: response.error.code ?? "UNKNOWN",
    });
    throw new Error(`RECONCILIATION_FINALIZE_RPC_FAILED:${response.error.code ?? "UNKNOWN"}`);
  }
  if (!response.data || response.data.finalized !== true) {
    replaceArtifact({ ...artifact, status: "RPC_RETURNED_UNEXPECTED_RESULT_NO_RETRY", rpcInvocationCount: finalizeHttpRequests });
    throw new Error("RECONCILIATION_FINALIZE_RPC_RESULT_INVALID_NO_RETRY");
  }

  const rpcSucceeded = {
    ...artifact,
    status: "RPC_RETURNED_SUCCESS_POSTCHECK_PENDING",
    rpcInvocationCount: finalizeHttpRequests,
    rpcResponse: { finalized: true },
    rpcHttpDiagnostics: diagnostics.filter((entry) => entry.path.endsWith("/finalize_pipeline_event_attempt")),
    abortReasonClass: terminalReason,
    retryConsumed: false,
    providerCalls: 0,
  };
  replaceArtifact(rpcSucceeded);

  try {
    const after = await readEvidence(supabase);
    assertPostcheck(before, after);
    const finalArtifact = {
      ...rpcSucceeded,
      status: "PASS",
      finalState: "ABORTED",
      active: false,
      newAttempts: 0,
      attemptsTotal: after.attemptsTotal,
      activeAttempts: after.activeAttemptIds.length,
      deferredAttempts: after.deferredAttemptIds.length,
      stuckAttempts: after.stuckAttemptIds.length,
      reviewCreated: false,
      publisherCalls: 0,
      publicationDelta: 0,
      publicArticleCount: after.publicArticleCount,
      publicFingerprintsUnchanged: true,
      astraArchived: after.astraPublicationStatus === "archived",
      providerAccountingDelta: { requests: 0, tokens: 0, calls: 0 },
      postcheck: after,
      remoteNonLifecycleWrites: 0,
      migrationsApplied: 0,
      ready: "YES",
    };
    replaceArtifact(finalArtifact);
    console.log(JSON.stringify({
      phase: "12F.3R",
      ready: "YES",
      attemptId,
      previousState: "ACTIVE",
      finalState: finalArtifact.finalState,
      terminalRpc: "finalize_pipeline_event_attempt",
      rpcInvocationCount: finalizeHttpRequests,
      retryConsumed: false,
      directTableUpdate: false,
      providerCalls: 0,
      newAttempts: 0,
      reviews: after.reviewCount,
      publisherCalls: 0,
      publicationDelta: 0,
      attemptsTotal: after.attemptsTotal,
      activeAttempts: after.activeAttemptIds.length,
      deferredAttempts: after.deferredAttemptIds.length,
      stuckAttempts: after.stuckAttemptIds.length,
      publicArticleCount: after.publicArticleCount,
      astraArchived: after.astraPublicationStatus === "archived",
      publicFingerprintsUnchanged: true,
      providerAccountingDelta: { requests: 0, tokens: 0, calls: 0 },
      remoteWrites: 1,
      remoteWriteType: "existing lifecycle RPC finalization only",
    }, null, 2));
  } catch (error) {
    replaceArtifact({ ...rpcSucceeded, status: "RPC_RETURNED_SUCCESS_POSTCHECK_FAILED_STOP", postcheckError: error instanceof Error ? error.message.split(":")[0] : "UNKNOWN", ready: "NO" });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "RECONCILIATION_FAILED");
  process.exitCode = 1;
});
