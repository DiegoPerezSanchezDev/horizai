import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { readSupervisedCandidateSnapshot, validateSupervisedCandidateSnapshotForResume, type SnapshotAttemptState, type SnapshotRawItem, type SnapshotSource, type SnapshotValidationStore } from "../lib/agents/pipeline/supervised-candidate-snapshot.ts";
import { readSafeRankerPipelineCheckpoint, type RankerPipelineCheckpoint } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";
import { buildCriticPipelineCheckpoint, writeCriticPipelineCheckpointAtomic } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { CriticAgent, getCriticModelConfig } from "../lib/agents/critic/critic-agent.ts";
import { criticAgentVersion, criticRoutingVersion } from "../lib/agents/critic/critic-prompt.ts";
import type { CriticInput } from "../lib/agents/critic/critic-types.ts";
import { runCriticPrechecks } from "../lib/agents/critic/critic-prechecks.ts";
import { loadActiveReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { projectClassificationGeo } from "../lib/agents/classifier/geo-resolver.ts";
import { calculateGuardedImportanceScore } from "../lib/agents/ranker/rank-score.ts";
import { rankerFormulaVersion } from "../lib/agents/ranker/ranker-prompt.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { getAgentFailureDetails, errorSummary } from "../lib/agents/runtime/agent-errors.ts";
import { attemptOutcomeFromPipelineResult, evaluateNormalEligibility } from "../lib/agents/pipeline/event-attempt-policy.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { validateRealPublicationReadiness } from "../lib/agents/publisher/publication-readiness.ts";
import { SupabasePublisherRepository } from "../lib/agents/publisher/supabase-publisher-repository.ts";
import { Publisher } from "../lib/agents/publisher/publisher-agent.ts";
import type { PublisherInput } from "../lib/agents/publisher/publisher-types.ts";
import { publicationPayloadSchema } from "../lib/agents/contracts/index.ts";
import { buildPublicationScores } from "../lib/agents/publisher/publication-payload.ts";
import type { Tables } from "../types/database.ts";

const snapshotId = "b6f66b19-1281-406c-9bdd-0fdb18b46d08";
const eventKey = "event-5c80fcd1a4e5b0d010308f37d646625a";
const priorPipelineRunId = "13e5e2fd-1de8-4386-b4c5-43eec39b0532";
const priorAttemptId = "097fc5e5-0a04-492c-a4c8-b8d9db4f1ff9";
type RawRow = Tables<"raw_items">;
type SourceRow = Tables<"sources">;
type AttemptRow = Tables<"pipeline_event_attempts">;

function fail(code: string): never { throw new Error(code); }
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function rawItem(row: RawRow): SnapshotRawItem { return { id: row.id, sourceId: row.source_id, externalId: row.external_id, originalUrl: row.original_url, canonicalUrl: row.canonical_url, title: row.title, excerpt: row.excerpt, language: row.language, publishedAt: row.published_at, discoveredAt: row.discovered_at, contentHash: row.content_hash, processingStatus: row.processing_status, extractionQuality: row.extraction_quality, rawContent: row.raw_content, normalizedPayload: row.normalized_payload }; }
function sourceRow(row: SourceRow): SnapshotSource { return { id: row.id, name: row.name, url: row.url, feedUrl: row.feed_url, sourceType: row.source_type, countryCode: row.country_code, language: row.language, isActive: row.is_active }; }
function attemptsState(rows: AttemptRow[], now: Date): SnapshotAttemptState { const values = rows.map((row) => ({ id: row.id, eventKey: row.event_key, pipelineRunId: row.pipeline_run_id, attemptNumber: row.attempt_number, startedAt: row.started_at, completedAt: row.completed_at, finalState: row.final_state, stopStage: row.stop_stage, stopReason: row.stop_reason, retryClass: row.retry_class, countsTowardRetryLimit: row.counts_toward_retry_limit, nextEligibleAt: row.next_eligible_at, createdAt: row.created_at })); const eligibility = evaluateNormalEligibility(values, now); const lastTechnical = rows.filter((row) => row.final_state === "TECHNICAL_FAILURE" && row.counts_toward_retry_limit).sort((a, b) => b.attempt_number - a.attempt_number)[0]; return { attempts: rows.length, eligible: eligibility.eligible, activeClaim: rows.some((row) => row.completed_at === null), quarantined: !eligibility.eligible && eligibility.reason === "QUARANTINED", nextEligibleAt: lastTechnical?.next_eligible_at ?? null }; }

function criticInput(checkpoint: RankerPipelineCheckpoint): CriticInput {
  return { schemaVersion: 1, event: checkpoint.event, verification: checkpoint.verification, translation: checkpoint.translation, editorial: checkpoint.editorial, classification: checkpoint.classification, ranking: checkpoint.ranking, sources: checkpoint.sources, sourceEvidence: checkpoint.sourceEvidence, geo: checkpoint.geo };
}

function projectCheckpointGeography(checkpoint: RankerPipelineCheckpoint, registry: Awaited<ReturnType<typeof loadActiveReferenceRegistry>>): RankerPipelineCheckpoint {
  const projection = projectClassificationGeo(checkpoint.classification, registry);
  return {
    ...checkpoint,
    classification: projection.classification,
    geo: projection.geo,
  };
}

function assertRanking(checkpoint: RankerPipelineCheckpoint): void {
  const ranking = checkpoint.ranking.result;
  const score = calculateGuardedImportanceScore(checkpoint.verification.status, { impact: ranking.impact, novelty: ranking.novelty, reach: ranking.reach, credibility: ranking.credibility, economicImpact: ranking.economicImpact, momentum: ranking.momentum });
  if (checkpoint.ranking.formulaVersion !== rankerFormulaVersion || ranking.importanceScore !== score) fail("RANKER_CHECKPOINT_SCORE_RECOMPUTATION_FAILED");
}

function parseDuration(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const match = /^(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/.exec(value.trim());
  if (!match || !match.slice(1).some(Boolean)) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function makePublisherInput(checkpoint: RankerPipelineCheckpoint, snapshot: Awaited<ReturnType<typeof readSupervisedCandidateSnapshot>>, critic: Awaited<ReturnType<CriticAgent["critique"]>>["output"]): PublisherInput {
  const rawBySourceItem = new Map(snapshot.items.map((item) => [item.sourceItemId, item]));
  const payload = publicationPayloadSchema.parse({
    schemaVersion: 1,
    eventKey,
    event: { canonicalTitle: checkpoint.event.canonicalTitle, probableOccurredAt: checkpoint.event.occurredAt, probableCountryCode: checkpoint.classification.countryCodes[0] ?? checkpoint.sources[0]?.countryCode ?? null, probableRegionCode: checkpoint.classification.primaryRegionCode },
    article: { slug: checkpoint.editorial.suggestedSlug, headlineEs: checkpoint.editorial.headlineEs, dekEs: checkpoint.editorial.dekEs, summaryEs: checkpoint.editorial.summaryEs, whyItMattersEs: checkpoint.editorial.whyItMattersEs, bodyEs: checkpoint.editorial.bodyEs, keyPoints: checkpoint.editorial.keyPoints },
    sources: checkpoint.sources.map((source) => { const item = rawBySourceItem.get(source.sourceItemId); if (!item) fail("PUBLISHER_SOURCE_SNAPSHOT_MISMATCH"); return { sourceId: source.sourceId, rawItemId: item.rawItemId, sourceName: source.sourceName, url: item.canonicalUrl, isPrimary: source.sourceId === checkpoint.verification.primarySourceId, publishedAt: item.publishedAt }; }),
    categories: checkpoint.classification.categorySlugs.map((categorySlug, index) => ({ categorySlug, isPrimary: index === 0, confidenceScore: 100 })),
    entities: [
      ...checkpoint.classification.companies.map((canonicalName) => ({ entityType: "organization" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...checkpoint.classification.models.map((canonicalName) => ({ entityType: "model" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...checkpoint.classification.people.map((canonicalName) => ({ entityType: "person" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...checkpoint.classification.technologies.map((canonicalName) => ({ entityType: "product" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
    ],
    region: { code: checkpoint.classification.primaryRegionCode, latitude: checkpoint.geo.latitude, longitude: checkpoint.geo.longitude },
    scores: buildPublicationScores(checkpoint.ranking.result),
    verification: checkpoint.verification,
    critic,
  });
  return {
    payload,
    lineage: { eventKey, verificationEventKey: eventKey, translationEventKey: eventKey, editorialEventKey: eventKey, classificationEventKey: eventKey, rankingEventKey: eventKey, criticEventKey: eventKey },
    validationContext: { translation: checkpoint.translation, editorSources: checkpoint.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: rawBySourceItem.get(source.sourceItemId)?.canonicalUrl ?? "", sourceType: source.sourceType ?? "unknown" })) },
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) fail("CRITIC_RESUME_ACCEPTS_NO_TARGET_OVERRIDES");
  const supabase = createSupabaseServerClient();
  const now = new Date();
  const [snapshot, attemptResult, historyResult] = await Promise.all([
    readSupervisedCandidateSnapshot(resolve("artifacts/supervised-candidates", `${snapshotId}.json`)),
    supabase.from("pipeline_event_attempts").select("*").eq("id", priorAttemptId).maybeSingle(),
    supabase.from("pipeline_event_attempts").select("*").eq("event_key", eventKey).order("attempt_number", { ascending: true }),
  ]);
  if (snapshot.snapshotId !== snapshotId || snapshot.eventKey !== eventKey || attemptResult.error || !attemptResult.data || historyResult.error) fail("CRITIC_RESUME_LINEAGE_READ_FAILED");
  const priorAttempt = attemptResult.data;
  if (priorAttempt.pipeline_run_id !== priorPipelineRunId || priorAttempt.event_key !== eventKey || priorAttempt.final_state !== "PROVIDER_RATE_LIMIT" || priorAttempt.retry_class !== "PROVIDER_RATE_LIMIT" || priorAttempt.counts_toward_retry_limit || priorAttempt.stop_stage !== "critic" || priorAttempt.stop_reason !== "PROVIDER_RATE_LIMIT") fail("CRITIC_RESUME_PRIOR_ATTEMPT_NOT_REPAIRED");

  const store: SnapshotValidationStore = {
    async getRawItem(id) { const result = await supabase.from("raw_items").select("*").eq("id", id).maybeSingle(); if (result.error) fail("RESUME_RAW_ITEM_READ_FAILED"); return result.data ? rawItem(result.data) : null; },
    async getSource(id) { const result = await supabase.from("sources").select("*").eq("id", id).maybeSingle(); if (result.error) fail("RESUME_SOURCE_READ_FAILED"); return result.data ? sourceRow(result.data) : null; },
    async getAttemptState(key, at) { const result = await supabase.from("pipeline_event_attempts").select("*").eq("event_key", key); if (result.error) fail("RESUME_ATTEMPT_READ_FAILED"); return attemptsState(result.data ?? [], at); },
    async hasArticle(key) { const event = await supabase.from("events").select("id").eq("event_key", key).maybeSingle(); if (event.error) fail("RESUME_EVENT_READ_FAILED"); if (!event.data) return false; const article = await supabase.from("articles").select("id").eq("event_id", event.data.id).limit(1); if (article.error) fail("RESUME_ARTICLE_READ_FAILED"); return (article.data ?? []).length > 0; },
  };
  const snapshotValidation = await validateSupervisedCandidateSnapshotForResume(snapshot, store, new Date(priorAttempt.started_at));
  if (!snapshotValidation.valid) fail("CRITIC_RESUME_SNAPSHOT_INVALID:" + snapshotValidation.reasons.join(","));

  const rankerPath = resolve("artifacts/pipeline-checkpoints", priorPipelineRunId, `ranker-${eventKey}.json`);
  if (!existsSync(rankerPath)) fail("CRITIC_RESUME_RANKER_CHECKPOINT_MISSING");
  const checkpoint = await readSafeRankerPipelineCheckpoint(rankerPath);
  if (checkpoint.eventKey !== eventKey || checkpoint.event.canonicalTitle !== snapshot.title || checkpoint.event.sourceCount !== snapshot.items.length || checkpoint.sources.length !== snapshot.items.length || checkpoint.sources.some((source) => !snapshot.items.some((item) => item.sourceItemId === source.sourceItemId && item.sourceId === source.sourceId && item.sourceName === source.sourceName))) fail("CRITIC_RESUME_RANKER_LINEAGE_INVALID");
  assertRanking(checkpoint);
  if (checkpoint.verification.eventKey !== eventKey || checkpoint.translation.eventKey !== eventKey || checkpoint.editorial.eventKey !== eventKey || checkpoint.classification.eventKey !== eventKey || checkpoint.ranking.result.eventKey !== eventKey || checkpoint.ranking.formulaVersion !== rankerFormulaVersion) fail("CRITIC_RESUME_UPSTREAM_LINEAGE_INVALID");
  const criticCheckpointPath = resolve("artifacts/pipeline-checkpoints", priorPipelineRunId, `critic-${eventKey}.json`);
  if (existsSync(criticCheckpointPath)) fail("CRITIC_CHECKPOINT_ALREADY_EXISTS");

  const logger = new SupabaseAgentLogger(supabase);
  const modelConfig = { ...getCriticModelConfig(), maxRetries: 0 };
  if (process.env.AGENT_PROVIDER?.trim().toLowerCase() !== "groq" || modelConfig.model !== "openai/gpt-oss-20b" || modelConfig.maxRetries !== 0 || modelConfig.allowPaidFallback || !modelConfig.failOnRateLimit) fail("CRITIC_RESUME_PROVIDER_CONFIG_MISMATCH");

  const logs = await supabase.from("agent_logs").select("step,payload,created_at").eq("agent_name", "critic").eq("step", "failed").filter("payload->>eventKey", "eq", eventKey).gte("created_at", priorAttempt.started_at).lte("created_at", priorAttempt.completed_at ?? now.toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (logs.error || !logs.data) fail("PRIOR_RATE_LIMIT_EVIDENCE_MISSING");
  const failureDetails = object(object(logs.data.payload).details);
  const telemetry = object(failureDetails.telemetry);
  const diagnostics = object(failureDetails.diagnostics);
  const headers = object(diagnostics.rateLimitHeaders);
  if (telemetry.providerHttpStatus !== 429 || telemetry.status !== "FREE_TIER_LIMIT_REACHED") fail("PRIOR_RATE_LIMIT_EVIDENCE_MISMATCH");
  const resetSeconds = [headers.retryAfterSeconds, headers.resetRequestsSeconds, headers.resetTokensSeconds].map(parseDuration);
  const textualResets = [headers.retryAfter, headers.resetRequests, headers.resetTokens].map(parseDuration);
  const allResetSeconds = [...resetSeconds, ...textualResets].filter((value): value is number => value !== null);
  if (allResetSeconds.length === 0) fail("RATE_LIMIT_RESET_TIME_NOT_PERSISTED");
  const latestResetAt = Date.parse(logs.data.created_at) + Math.max(...allResetSeconds) * 1_000;
  if (now.getTime() < latestResetAt) fail("RATE_LIMIT_WINDOW_NOT_YET_RESET");
  const rateLimitWindowResetAt = new Date(latestResetAt).toISOString();

  const registryData = await loadActiveReferenceRegistry(supabase);
  const projectedCheckpoint = projectCheckpointGeography(checkpoint, registryData);
  const input = criticInput(projectedCheckpoint);
  const prechecks = runCriticPrechecks(input, { registry: registryData });
  if (!prechecks.passed) fail("CRITIC_DETERMINISTIC_PRECHECK_FAILED:" + prechecks.issues.map((issue) => issue.code).join(","));

  const requestDate = now.toISOString().slice(0, 10);
  const quotaBefore = await logger.getRemainingRequests(modelConfig.dailyRequestLimit, requestDate);
  if (quotaBefore.remaining < 1) fail("BLOCKED_INSUFFICIENT_PERSISTENT_QUOTA");
  const attemptValues = (historyResult.data ?? []).map((row) => ({ id: row.id, eventKey: row.event_key, pipelineRunId: row.pipeline_run_id, attemptNumber: row.attempt_number, startedAt: row.started_at, completedAt: row.completed_at, finalState: row.final_state, stopStage: row.stop_stage, stopReason: row.stop_reason, retryClass: row.retry_class, countsTowardRetryLimit: row.counts_toward_retry_limit, nextEligibleAt: row.next_eligible_at, createdAt: row.created_at }));
  const eligibility = evaluateNormalEligibility(attemptValues, now);
  if (!eligibility.eligible || eligibility.reason !== "RATE_LIMIT_RETRY_ELIGIBLE" || attemptValues.filter((item) => item.finalState === "TECHNICAL_FAILURE" && item.countsTowardRetryLimit).length !== 0) fail("CRITIC_RESUME_EVENT_NOT_ELIGIBLE");
  const registry = new SupabasePipelineEventAttemptRepository(supabase);
  const resumeRunId = randomUUID();
  const claimTime = new Date();
  const latestSnapshotValidation = await validateSupervisedCandidateSnapshotForResume(snapshot, store, new Date(priorAttempt.started_at));
  if (!latestSnapshotValidation.valid) fail("CRITIC_RESUME_SNAPSHOT_CHANGED_BEFORE_CLAIM:" + latestSnapshotValidation.reasons.join(","));
  if (await logger.getRemainingRequests(modelConfig.dailyRequestLimit, new Date().toISOString().slice(0, 10)).then((quota) => quota.remaining) < 1) fail("BLOCKED_INSUFFICIENT_PERSISTENT_QUOTA");
  const claim = await registry.claim({ eventKey, pipelineRunId: resumeRunId, startedAt: claimTime.toISOString(), now: claimTime.toISOString() });
  if (claim.status !== "ACQUIRED") fail("CRITIC_RESUME_CLAIM_" + claim.status);

  let finalized = false;
  let execution: Awaited<ReturnType<CriticAgent["critique"]>> | null = null;
  let errorValue: unknown = null;
  let criticDecision: string | null = null;
  let readiness: Awaited<ReturnType<typeof validateRealPublicationReadiness>> | null = null;
  let materialization: Awaited<ReturnType<Publisher["preview"]>> | null = null;
  let candidateVisibleToAnon: boolean | null = null;
  let publisherInput: PublisherInput | null = null;
  let finishState: "READY_FOR_PUBLICATION_DRY_RUN" | "BLOCKED_REVISION_REQUIRED" | "BLOCKED_REJECTED" | "FAILED" = "FAILED";
  let stopReason = "CRITIC_RESUME_UNEXPECTED_FAILURE";
  let failureErrorCode = "CRITIC_RESUME_UNEXPECTED_FAILURE";
  const resumeStartedAt = new Date();
  try {
    const critic = new CriticAgent(createConfiguredModelProvider(), logger);
    execution = await critic.critique(input, { dryRun: true, modelConfig, requestBudget: new DailyRequestBudget(), registry: registryData });
    criticDecision = execution.output.decision;
    await logger.log(execution.runId, { agentName: "critic", agentVersion: criticAgentVersion, eventKey, model: modelConfig.model, dryRun: true }, { level: "info", step: "checkpoint_resume_lineage", message: "Critic resumed from validated prior Ranker checkpoint", payload: { snapshotId, priorPipelineRunId, priorAttemptId, resumePipelineRunId: resumeRunId, rankerCheckpointPath: rankerPath, agentVersion: criticAgentVersion, routingVersion: criticRoutingVersion } });
    if (execution.providerRequestsUsed > 1 || execution.attempts > 1) fail("CRITIC_RESUME_REQUEST_LIMIT_EXCEEDED");
    const criticCheckpoint = buildCriticPipelineCheckpoint(projectedCheckpoint, execution.output);
    const resumedCriticCheckpointPath = resolve("artifacts/pipeline-checkpoints", resumeRunId, `critic-${eventKey}.json`);
    await writeCriticPipelineCheckpointAtomic(criticCheckpoint, resumedCriticCheckpointPath);
    if (execution.output.decision === "reject") { finishState = "BLOCKED_REJECTED"; stopReason = "BLOCKED_REJECTED"; }
    else if (execution.output.decision !== "pass") { finishState = "BLOCKED_REVISION_REQUIRED"; stopReason = "BLOCKED_REVISION_REQUIRED"; }
    else {
      publisherInput = makePublisherInput(projectedCheckpoint, snapshot, execution.output);
      readiness = await validateRealPublicationReadiness(publisherInput, new SupabasePublisherRepository(supabase));
      const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      if (!publicUrl || !publishableKey) fail("PUBLIC_SUPABASE_READ_CONFIG_MISSING");
      const publicClient = createClient(publicUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const visible = await publicClient.from("public_published_articles").select("slug").eq("slug", publisherInput.payload.article.slug).maybeSingle();
      if (visible.error) fail("ANON_PUBLIC_VISIBILITY_CHECK_FAILED");
      candidateVisibleToAnon = Boolean(visible.data);
      if (!readiness.ready || candidateVisibleToAnon) fail("PUBLICATION_READINESS_FAILED");
      materialization = await new Publisher(new SupabasePublisherRepository(supabase)).preview(publisherInput);
      if (materialization.summary.transactionAttempted || materialization.summary.transactionCommitted || materialization.summary.articleCreated || materialization.summary.articleUpdated || materialization.summary.articleAction !== "WOULD_CREATE" || materialization.summary.eventAction !== "WOULD_CREATE") fail("PUBLISHER_DRY_RUN_INVARIANT_FAILED");
      finishState = "READY_FOR_PUBLICATION_DRY_RUN";
      stopReason = "READY_FOR_PUBLICATION_DRY_RUN";
    }
  } catch (error) {
    errorValue = error;
    if (execution) {
      const details = getAgentFailureDetails(error);
      const rateLimited = details.diagnostics?.httpStatus === 429 || details.telemetry?.providerHttpStatus === 429 || details.telemetry?.status === "FREE_TIER_LIMIT_REACHED";
      failureErrorCode = rateLimited ? "FREE_TIER_LIMIT_REACHED" : errorSummary(error).code || "CRITIC_RESUME_FAILED";
      stopReason = rateLimited ? "PROVIDER_RATE_LIMIT" : failureErrorCode;
    } else {
      failureErrorCode = error instanceof Error ? error.message.slice(0, 120) : "CRITIC_RESUME_FAILED";
      stopReason = failureErrorCode;
    }
    finishState = "FAILED";
  } finally {
    const attemptOutcome = attemptOutcomeFromPipelineResult({ finalState: finishState, stopStage: "critic", stopReason, ...(finishState === "FAILED" ? { failure: { errorCode: failureErrorCode, httpStatus: getAgentFailureDetails(errorValue).diagnostics?.httpStatus ?? null, telemetry: getAgentFailureDetails(errorValue).telemetry ? { status: getAgentFailureDetails(errorValue).telemetry?.status, providerHttpStatus: getAgentFailureDetails(errorValue).telemetry?.providerHttpStatus } : undefined } } : {}) }, resumeStartedAt);
    await registry.finalize({ attemptId: claim.attempt.id, pipelineRunId: resumeRunId, completedAt: new Date().toISOString(), ...attemptOutcome });
    finalized = true;
  }

  const quotaAfter = await logger.getRemainingRequests(modelConfig.dailyRequestLimit, new Date().toISOString().slice(0, 10));
  const criticRunId = execution?.runId;
  const dispatchedLogs = criticRunId ? await supabase.from("agent_logs").select("payload").eq("run_id", criticRunId).eq("step", "provider_request_reserved") : { data: [], error: null };
  if (dispatchedLogs.error) fail("RESUME_REQUEST_ACCOUNTING_READ_FAILED");
  const dispatched = (dispatchedLogs.data ?? []).filter((row) => object(object(row.payload).details).providerRequestDispatched === true || object(row.payload).providerRequestDispatched === true).length;
  const requestsUsed = execution?.providerRequestsUsed ?? 0;
  const quotaDelta = quotaBefore.remaining - quotaAfter.remaining;
  const requestAccounting = dispatched === requestsUsed && requestsUsed === quotaDelta && dispatched <= 1;
  const report = {
    snapshotId, eventKey, priorPipelineRunId, priorAttemptId, resumePipelineRunId: resumeRunId, snapshotFreshAtOriginalClaim: true,
    snapshotContentIdentityAndOwnership: "PASS", rankerCheckpoint: "PASS", rankerAgentVersion: "ranker-v1", criticAgentVersion, criticRoutingVersion,
    criticHttpStatus: execution?.telemetry?.providerHttpStatus ?? getAgentFailureDetails(errorValue).telemetry?.providerHttpStatus ?? null,
    criticDecision, criticStatus: errorValue ? "FAIL" : "SUCCESS", criticAttempts: execution?.attempts ?? getAgentFailureDetails(errorValue).attempts,
    criticRetries: execution ? Math.max(0, execution.attempts - 1) : Math.max(0, getAgentFailureDetails(errorValue).attempts - 1), model: modelConfig.model,
    deterministicPrechecks: execution?.prechecks.passed ?? (errorValue === null), criticOutputZodValid: execution ? true : null,
    resumeAttemptFinalized: finalized, resumeOutcome: attemptOutcomeFromPipelineResult({ finalState: finishState, stopStage: "critic", stopReason, ...(finishState === "FAILED" ? { failure: { errorCode: failureErrorCode, httpStatus: getAgentFailureDetails(errorValue).diagnostics?.httpStatus ?? null, telemetry: getAgentFailureDetails(errorValue).telemetry ? { status: getAgentFailureDetails(errorValue).telemetry?.status, providerHttpStatus: getAgentFailureDetails(errorValue).telemetry?.providerHttpStatus } : undefined } } : {}) }, resumeStartedAt).finalState,
    publicationReadiness: readiness ? (readiness.ready ? "PASS" : "FAIL") : "NOT_RUN", readinessIssues: readiness?.issues.map((issue) => issue.code) ?? [],
    materializationPreview: materialization ? "PASS" : "NOT_RUN", eventAction: materialization?.summary.eventAction ?? null, articleAction: materialization?.summary.articleAction ?? null,
    candidateVisibleToAnon: candidateVisibleToAnon === null ? "NOT_CHECKED" : candidateVisibleToAnon ? "YES" : "NO",
    publish: false, rpcCalled: false, articleWrites: 0, requestAccounting: requestAccounting ? "PASS" : "FAIL", dispatchedCriticRequests: dispatched, resumeRequestsUsed: requestsUsed, persistentQuotaDelta: quotaDelta,
    quotaBefore: quotaBefore.remaining + "/" + quotaBefore.dailyLimit + " remaining", quotaAfter: quotaAfter.remaining + "/" + quotaAfter.dailyLimit + " remaining",
    rateLimitWindowExpiredAt: rateLimitWindowResetAt,
  };
  console.log(JSON.stringify(report, null, 2));
  if (finishState === "READY_FOR_PUBLICATION_DRY_RUN" && readiness?.ready && materialization && candidateVisibleToAnon === false && requestAccounting && publisherInput) {
    console.log("\n========================\nHUMAN PUBLICATION PREVIEW\n========================");
    console.log("\nHEADLINE\n" + publisherInput.payload.article.headlineEs);
    console.log("\nDEK / SUMMARY\n" + publisherInput.payload.article.dekEs + "\n\n" + publisherInput.payload.article.summaryEs);
    console.log("\nPOR QUÉ IMPORTA\n" + publisherInput.payload.article.whyItMattersEs);
    console.log("\nBODY\n" + publisherInput.payload.article.bodyEs);
    console.log("\nKEY POINTS\n" + publisherInput.payload.article.keyPoints.join("\n"));
    console.log("\nREGIÓN\n" + (publisherInput.payload.region.code ?? "N/A"));
    console.log("\nPAÍSES\n" + (publisherInput.payload.event.probableCountryCode ?? "N/A"));
    console.log("\nCATEGORÍAS\n" + publisherInput.payload.categories.map((category) => category.categorySlug).join(", "));
    console.log("\nENTIDADES\n" + publisherInput.payload.entities.map((entity) => entity.canonicalName).join(", "));
    console.log("\nFUENTES PÚBLICAS\n" + publisherInput.payload.sources.map((source) => source.sourceName + " — " + source.url).join("\n"));
    console.log("\nSLUG\n" + publisherInput.payload.article.slug);
    console.log("\nIMAGE AVAILABLE:\nNO");
    console.log("\nRANKING CONTEXT\n" + JSON.stringify({ importanceScore: publisherInput.payload.scores.importanceScore, impact: publisherInput.payload.scores.impact, novelty: publisherInput.payload.scores.novelty, economicImpact: publisherInput.payload.scores.economicImpact, credibility: publisherInput.payload.scores.credibility, reach: publisherInput.payload.scores.reach, momentum: publisherInput.payload.scores.momentum }, null, 2));
    console.log("\nFINAL STATUS: READY_FOR_HUMAN_PUBLICATION_APPROVAL");
  }
  if (errorValue) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message.replace(/(?:api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, "[redacted]").slice(0, 300) : "CRITIC_RESUME_FAILED"); process.exitCode = 1; });
