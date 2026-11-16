import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { calculateGuardedImportanceScore } from "../lib/agents/ranker/rank-score.ts";
import { rankerFormulaVersion } from "../lib/agents/ranker/ranker-prompt.ts";
import { readSafeRankerPipelineCheckpoint } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";
import { validateSupervisedCandidateSnapshotForResume, readSupervisedCandidateSnapshot, type SnapshotAttemptState, type SnapshotRawItem, type SnapshotSource, type SnapshotValidationStore } from "../lib/agents/pipeline/supervised-candidate-snapshot.ts";
import { evaluateNormalEligibility } from "../lib/agents/pipeline/event-attempt-policy.ts";
import type { Tables } from "../types/database.ts";

const snapshotId = "b6f66b19-1281-406c-9bdd-0fdb18b46d08";
const eventKey = "event-5c80fcd1a4e5b0d010308f37d646625a";
const pipelineRunId = "13e5e2fd-1de8-4386-b4c5-43eec39b0532";
const attemptId = "097fc5e5-0a04-492c-a4c8-b8d9db4f1ff9";
type RawRow = Tables<"raw_items">;
type SourceRow = Tables<"sources">;
type AttemptRow = Tables<"pipeline_event_attempts">;

function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function rawItem(row: RawRow): SnapshotRawItem { return { id: row.id, sourceId: row.source_id, externalId: row.external_id, originalUrl: row.original_url, canonicalUrl: row.canonical_url, title: row.title, excerpt: row.excerpt, language: row.language, publishedAt: row.published_at, discoveredAt: row.discovered_at, contentHash: row.content_hash, processingStatus: row.processing_status, extractionQuality: row.extraction_quality, rawContent: row.raw_content, normalizedPayload: row.normalized_payload }; }
function sourceRow(row: SourceRow): SnapshotSource { return { id: row.id, name: row.name, url: row.url, feedUrl: row.feed_url, sourceType: row.source_type, countryCode: row.country_code, language: row.language, isActive: row.is_active }; }
function attemptState(rows: AttemptRow[], now: Date): SnapshotAttemptState {
  const attempts = rows.map((row) => ({ id: row.id, eventKey: row.event_key, pipelineRunId: row.pipeline_run_id, attemptNumber: row.attempt_number, startedAt: row.started_at, completedAt: row.completed_at, finalState: row.final_state, stopStage: row.stop_stage, stopReason: row.stop_reason, retryClass: row.retry_class, countsTowardRetryLimit: row.counts_toward_retry_limit, nextEligibleAt: row.next_eligible_at, createdAt: row.created_at }));
  const eligibility = evaluateNormalEligibility(attempts, now);
  const latestTechnical = rows.filter((row) => row.final_state === "TECHNICAL_FAILURE" && row.counts_toward_retry_limit).sort((a, b) => b.attempt_number - a.attempt_number)[0];
  return { attempts: rows.length, eligible: eligibility.eligible, activeClaim: rows.some((row) => row.completed_at === null), quarantined: !eligibility.eligible && eligibility.reason === "QUARANTINED", nextEligibleAt: latestTechnical?.next_eligible_at ?? null };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--audit", "--apply"].includes(mode)) fail("USE_EXACTLY_ONE_OF_--audit_OR_--apply");
  const supabase = createSupabaseServerClient();
  const snapshotPath = resolve("artifacts/supervised-candidates", `${snapshotId}.json`);
  const snapshot = await readSupervisedCandidateSnapshot(snapshotPath);
  if (snapshot.snapshotId !== snapshotId || snapshot.eventKey !== eventKey) fail("REPAIR_SNAPSHOT_IDENTITY_MISMATCH");

  const [attemptResult, historyResult, logsResult, runResult, eventResult] = await Promise.all([
    supabase.from("pipeline_event_attempts").select("*").eq("id", attemptId).maybeSingle(),
    supabase.from("pipeline_event_attempts").select("*").eq("event_key", eventKey).order("attempt_number", { ascending: true }),
    supabase.from("agent_logs").select("agent_name,step,level,payload,created_at").filter("payload->>eventKey", "eq", eventKey).gte("created_at", "2026-09-23T19:44:59.000Z").lte("created_at", "2026-09-23T19:47:08.000Z"),
    supabase.from("agent_runs").select("id,started_at,finished_at,status,dry_run,config").gte("started_at", "2026-09-23T19:44:59.000Z").lte("started_at", "2026-09-23T19:47:08.000Z"),
    supabase.from("events").select("id").eq("event_key", eventKey).maybeSingle(),
  ]);
  if (attemptResult.error || !attemptResult.data || historyResult.error || logsResult.error || runResult.error || eventResult.error) fail("REPAIR_EVIDENCE_READ_FAILED");
  const attempt = attemptResult.data;
  if (attempt.event_key !== eventKey || attempt.pipeline_run_id !== pipelineRunId || attempt.stop_stage !== "critic" || attempt.attempt_number !== 1 || !attempt.completed_at) fail("REPAIR_ATTEMPT_IDENTITY_MISMATCH");
  const alreadyRepaired = attempt.final_state === "PROVIDER_RATE_LIMIT" && attempt.retry_class === "PROVIDER_RATE_LIMIT" && attempt.counts_toward_retry_limit === false && attempt.stop_reason === "PROVIDER_RATE_LIMIT" && attempt.next_eligible_at === null;
  const isTargetMisclassification = attempt.final_state === "TECHNICAL_FAILURE" && attempt.retry_class === "TECHNICAL_FAILURE" && attempt.counts_toward_retry_limit === true && attempt.stop_reason === "PROVIDER_HTTP_ERROR";
  if (!alreadyRepaired && !isTargetMisclassification) fail("REPAIR_ATTEMPT_STATE_NOT_EXPECTED");

  const logs = logsResult.data ?? [];
  const criticFailure = logs.find((row) => row.agent_name === "critic" && row.step === "failed");
  const criticFailurePayload = object(object(criticFailure?.payload).details);
  const criticTelemetry = object(criticFailurePayload.telemetry);
  if (criticTelemetry.providerHttpStatus !== 429 || criticTelemetry.status !== "FREE_TIER_LIMIT_REACHED" || criticFailurePayload.errorCode !== "FREE_TIER_LIMIT_REACHED" || criticTelemetry.attempts !== 1 || criticTelemetry.retries !== 0) fail("REPAIR_PROVIDER_429_EVIDENCE_MISMATCH");
  const criticReservation = logs.find((row) => row.agent_name === "critic" && row.step === "provider_request_reserved");
  const reservationPayload = object(criticReservation?.payload);
  if (object(reservationPayload.details).providerRequestDispatched !== true && reservationPayload.providerRequestDispatched !== true) fail("REPAIR_CRITIC_REQUEST_NOT_DISPATCHED");
  const rankerSuccess = logs.find((row) => row.agent_name === "ranker" && row.step === "completed");
  if (!rankerSuccess || object(object(rankerSuccess.payload).details).telemetry === undefined) fail("REPAIR_RANKER_COMPLETION_MISSING");
  const criticDiagnostics = object(criticFailurePayload.diagnostics);
  const rateHeaders = object(criticDiagnostics.rateLimitHeaders);
  const noRateResetHeaders = Object.values(rateHeaders).every((value) => value === null || value === undefined);

  const rankerPath = resolve("artifacts/pipeline-checkpoints", pipelineRunId, `ranker-${eventKey}.json`);
  const criticPath = resolve("artifacts/pipeline-checkpoints", pipelineRunId, `critic-${eventKey}.json`);
  if (!existsSync(rankerPath) || existsSync(criticPath)) fail("REPAIR_CHECKPOINT_SET_INVALID");
  const rankerCheckpoint = await readSafeRankerPipelineCheckpoint(rankerPath);
  if (rankerCheckpoint.eventKey !== eventKey || rankerCheckpoint.event.canonicalTitle !== snapshot.title || rankerCheckpoint.event.sourceCount !== snapshot.items.length || rankerCheckpoint.sources.length !== snapshot.items.length || rankerCheckpoint.sources.some((source) => !snapshot.items.some((item) => item.sourceItemId === source.sourceItemId && item.sourceId === source.sourceId && item.sourceName === source.sourceName))) fail("REPAIR_RANKER_LINEAGE_MISMATCH");
  const rankerRun = (runResult.data ?? []).find((row) => { const config = object(row.config); return config.agentName === "ranker" && config.agentVersion === "ranker-v1" && config.eventKey === eventKey && row.status === "succeeded"; });
  const criticRun = (runResult.data ?? []).find((row) => { const config = object(row.config); return config.agentName === "critic" && config.agentVersion === "critic-v3" && config.eventKey === eventKey && row.status === "failed"; });
  const publisherRun = (runResult.data ?? []).some((row) => object(row.config).agentName === "publisher");
  if (!rankerRun || !criticRun || publisherRun) fail("REPAIR_AGENT_RUN_LINEAGE_MISMATCH");
  const recomputedScore = calculateGuardedImportanceScore(rankerCheckpoint.verification.status, {
    impact: rankerCheckpoint.ranking.result.impact,
    novelty: rankerCheckpoint.ranking.result.novelty,
    reach: rankerCheckpoint.ranking.result.reach,
    credibility: rankerCheckpoint.ranking.result.credibility,
    economicImpact: rankerCheckpoint.ranking.result.economicImpact,
    momentum: rankerCheckpoint.ranking.result.momentum,
  });
  if (rankerCheckpoint.ranking.formulaVersion !== rankerFormulaVersion || rankerCheckpoint.ranking.result.importanceScore !== recomputedScore) fail("REPAIR_RANKING_RECOMPUTATION_FAILED");
  const store: SnapshotValidationStore = {
    async getRawItem(id) { const result = await supabase.from("raw_items").select("*").eq("id", id).maybeSingle(); if (result.error) fail("RESUME_RAW_ITEM_READ_FAILED"); return result.data ? rawItem(result.data) : null; },
    async getSource(id) { const result = await supabase.from("sources").select("*").eq("id", id).maybeSingle(); if (result.error) fail("RESUME_SOURCE_READ_FAILED"); return result.data ? sourceRow(result.data) : null; },
    async getAttemptState(key, now) { const result = await supabase.from("pipeline_event_attempts").select("*").eq("event_key", key); if (result.error) fail("RESUME_ATTEMPT_READ_FAILED"); return attemptState(result.data ?? [], now); },
    async hasArticle(key) { const event = await supabase.from("events").select("id").eq("event_key", key).maybeSingle(); if (event.error) fail("RESUME_EVENT_READ_FAILED"); if (!event.data) return false; const articles = await supabase.from("articles").select("id").eq("event_id", event.data.id).limit(1); if (articles.error) fail("RESUME_ARTICLE_READ_FAILED"); return (articles.data ?? []).length > 0; },
  };
  const resumeValidation = await validateSupervisedCandidateSnapshotForResume(snapshot, store, new Date(attempt.started_at));
  if (!resumeValidation.valid) fail("REPAIR_SNAPSHOT_RESUME_VALIDATION_FAILED:" + resumeValidation.reasons.join(","));
  if (Date.parse(snapshot.createdAt) > Date.parse(attempt.started_at) || Date.parse(attempt.started_at) < Date.parse(snapshot.items[0].effectiveFreshnessAt) || Date.parse(attempt.started_at) > Date.parse(snapshot.items[0].freshnessExpiresAt)) fail("REPAIR_ORIGINAL_CLAIM_WAS_NOT_FRESH");
  if (eventResult.data) fail("REPAIR_EVENT_ALREADY_EXISTS");
  const articleCheck = await supabase.from("articles").select("id").eq("slug", rankerCheckpoint.editorial.suggestedSlug).limit(1);
  if (articleCheck.error || (articleCheck.data ?? []).length > 0) fail("REPAIR_ARTICLE_OR_SLUG_EXISTS");
  const reservationCount = logs.filter((row) => { const payload = object(row.payload); return row.step === "provider_request_reserved" && (object(payload.details).providerRequestDispatched === true || payload.providerRequestDispatched === true); }).length;
  if (reservationCount !== 6) fail("REPAIR_HISTORICAL_REQUEST_ACCOUNTING_MISMATCH");
  const technicalCountBefore = (historyResult.data ?? []).filter((row) => row.final_state === "TECHNICAL_FAILURE" && row.counts_toward_retry_limit).length;
  const rateLimitHeaderNames = Object.keys(rateHeaders).filter((key) => rateHeaders[key] !== null && rateHeaders[key] !== undefined);
  const auditReport = {
    snapshotId, eventKey, pipelineRunId, attemptId,
    evidence: { criticDispatched: true, providerHttpStatus: 429, providerError: "FREE_TIER_LIMIT_REACHED", criticAttempts: 1, criticRetries: 0, stopStage: attempt.stop_stage, upstreamRankerCompleted: true, rankerVersion: "ranker-v1", criticCheckpointExists: false, publisherExecution: false, rateLimitHeaders: Object.fromEntries(["retryAfter", "limitTokens", "remainingTokens", "resetTokens", "limitRequests", "remainingRequests", "resetRequests", "retryAfterSeconds", "resetTokensSeconds", "resetRequestsSeconds"].map((key) => [key, rateHeaders[key] ?? null])), rateLimitHeaderNames, noRateResetHeaders, originalSnapshotFreshAtClaim: true, currentSnapshotContentIdentityAndOwnership: true },
    rankerCheckpoint: { usable: true, eventKeyMatches: true, upstreamContractsValid: true, geoProvenance: rankerCheckpoint.geo.resolvedFrom, rankingFormulaVersion: rankerCheckpoint.ranking.formulaVersion, importanceScore: rankerCheckpoint.ranking.result.importanceScore, recomputedImportanceScore: recomputedScore },
    currentAttempt: { state: attempt.final_state, retryClass: attempt.retry_class, countsTowardRetryLimit: attempt.counts_toward_retry_limit, technicalAttemptsCounted: technicalCountBefore, alreadyRepaired },
  };
  if (mode === "--audit") { console.log(JSON.stringify({ ...auditReport, repairApplied: false }, null, 2)); return; }

  if (alreadyRepaired) { console.log(JSON.stringify({ ...auditReport, repairApplied: true, idempotentNoOp: true }, null, 2)); return; }
  const auditRun = await supabase.from("agent_runs").insert({ run_type: "other", started_at: new Date().toISOString(), status: "running", dry_run: true, stats: {}, config: { operation: "historical_provider_rate_limit_repair", snapshotId, eventKey, pipelineRunId, attemptId } }).select("id").single();
  if (auditRun.error || !auditRun.data) fail("REPAIR_AUDIT_RUN_CREATE_FAILED");
  const auditId = auditRun.data.id;
  const auditEntry = await supabase.from("agent_logs").insert({ run_id: auditId, agent_name: "pipeline-admin", step: "attempt_repair_evidence_verified", level: "info", message: "Evidence-bound historical provider-rate-limit attempt repair authorized", payload: { snapshotId, eventKey, pipelineRunId, attemptId, providerHttpStatus: 429, providerError: "FREE_TIER_LIMIT_REACHED", priorFinalState: attempt.final_state } });
  if (auditEntry.error) fail("REPAIR_AUDIT_EVIDENCE_LOG_FAILED");
  const update = await supabase.from("pipeline_event_attempts").update({ final_state: "PROVIDER_RATE_LIMIT", retry_class: "PROVIDER_RATE_LIMIT", counts_toward_retry_limit: false, stop_reason: "PROVIDER_RATE_LIMIT", next_eligible_at: null }).eq("id", attemptId).eq("event_key", eventKey).eq("pipeline_run_id", pipelineRunId).eq("attempt_number", 1).eq("stop_stage", "critic").eq("stop_reason", "PROVIDER_HTTP_ERROR").eq("final_state", "TECHNICAL_FAILURE").eq("retry_class", "TECHNICAL_FAILURE").eq("counts_toward_retry_limit", true).select("id").maybeSingle();
  if (update.error || !update.data) fail("REPAIR_CONDITIONAL_UPDATE_NOT_APPLIED");
  const after = await supabase.from("pipeline_event_attempts").select("final_state,retry_class,counts_toward_retry_limit,stop_stage,stop_reason,next_eligible_at,started_at,completed_at,pipeline_run_id,event_key").eq("id", attemptId).maybeSingle();
  if (after.error || !after.data || after.data.final_state !== "PROVIDER_RATE_LIMIT" || after.data.retry_class !== "PROVIDER_RATE_LIMIT" || after.data.counts_toward_retry_limit || after.data.stop_stage !== "critic" || after.data.stop_reason !== "PROVIDER_RATE_LIMIT" || after.data.next_eligible_at !== null || after.data.started_at !== attempt.started_at || after.data.completed_at !== attempt.completed_at || after.data.pipeline_run_id !== pipelineRunId || after.data.event_key !== eventKey) fail("REPAIR_POSTCONDITION_FAILED");
  const historyAfterResult = await supabase.from("pipeline_event_attempts").select("*").eq("event_key", eventKey).order("attempt_number", { ascending: true });
  if (historyAfterResult.error) fail("REPAIR_POST_HISTORY_READ_FAILED");
  const postRows = historyAfterResult.data ?? [];
  const postEligibility = evaluateNormalEligibility(postRows.map((row) => ({ id: row.id, eventKey: row.event_key, pipelineRunId: row.pipeline_run_id, attemptNumber: row.attempt_number, startedAt: row.started_at, completedAt: row.completed_at, finalState: row.final_state, stopStage: row.stop_stage, stopReason: row.stop_reason, retryClass: row.retry_class, countsTowardRetryLimit: row.counts_toward_retry_limit, nextEligibleAt: row.next_eligible_at, createdAt: row.created_at })), new Date());
  const technicalCountAfter = postRows.filter((row) => row.final_state === "TECHNICAL_FAILURE" && row.counts_toward_retry_limit).length;
  if (technicalCountAfter !== 0) fail("REPAIR_TECHNICAL_RETRY_COUNT_POSTCONDITION_FAILED");
  if (!postEligibility.eligible || postEligibility.reason !== "RATE_LIMIT_RETRY_ELIGIBLE") fail("REPAIR_POST_ELIGIBILITY_FAILED");
  const successLog = await supabase.from("agent_logs").insert({ run_id: auditId, agent_name: "pipeline-admin", step: "attempt_repaired", level: "info", message: "Historical event attempt reclassified from technical failure to provider rate limit", payload: { snapshotId, eventKey, pipelineRunId, attemptId, finalState: "PROVIDER_RATE_LIMIT", retryClass: "PROVIDER_RATE_LIMIT", countsTowardRetryLimit: false, stopStage: "critic", stopReason: "PROVIDER_RATE_LIMIT", technicalAttemptsCounted: technicalCountBefore, eligibility: postEligibility.reason } });
  if (successLog.error) fail("REPAIR_AUDIT_RESULT_LOG_FAILED");
  const finishRun = await supabase.from("agent_runs").update({ status: "succeeded", finished_at: new Date().toISOString(), stats: { repaired: true, evidenceBound: true }, error_message: null }).eq("id", auditId);
  if (finishRun.error) fail("REPAIR_AUDIT_RUN_FINISH_FAILED");
  console.log(JSON.stringify({ ...auditReport, repairApplied: true, idempotentNoOp: false, repaired: { finalState: after.data.final_state, retryClass: after.data.retry_class, countsTowardRetryLimit: after.data.counts_toward_retry_limit, stopStage: after.data.stop_stage, stopReason: after.data.stop_reason, startedAtUnchanged: true, pipelineRunIdUnchanged: true, eventKeyUnchanged: true }, technicalAttemptsCountedAfter: 0, normalEligibility: postEligibility }, null, 2));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message.replace(/(?:api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, "[redacted]").slice(0, 300) : "ATTEMPT_REPAIR_FAILED"); process.exitCode = 1; });
