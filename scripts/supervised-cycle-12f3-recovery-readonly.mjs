import { readFile } from "node:fs/promises";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";

const attemptId = "dfada4fd-d9c6-4aa8-bfef-6d9447267e06";
const pipelineRunId = "3aa65ec9-448f-42ea-b53c-39bc24c70fb8";
const astraArticleId = "756b0ee0-b5e6-4153-846f-278a12c9afe3";
const baseline = JSON.parse(await readFile("artifacts/supervised-cycle-12f3.json", "utf8"));
const allowedReadRpc = new Set([
  "/rest/v1/rpc/get_pipeline_human_review_operator_status",
  "/rest/v1/rpc/list_pipeline_human_reviews_operator",
]);
const originalFetch = globalThis.fetch.bind(globalThis);
const diagnostics = [];
let deniedRequest = false;

globalThis.fetch = async (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(requestUrl);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const expectedOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin : "";
  const isPostgrestRead = url.origin === expectedOrigin
    && url.pathname.startsWith("/rest/v1/")
    && ["GET", "HEAD"].includes(method);
  const isReadOnlyRpc = url.origin === expectedOrigin && method === "POST" && allowedReadRpc.has(url.pathname);
  if (!isPostgrestRead && !isReadOnlyRpc) {
    deniedRequest = true;
    throw new Error("RECOVERY_READ_ONLY_FETCH_GUARD_BLOCKED_REQUEST");
  }
  const response = await originalFetch(input, init);
  diagnostics.push({ method, path: url.pathname, status: response.status });
  return response;
};

function expectRead(result, label) {
  if (result.error) throw new Error(`${label}:${result.error.code ?? "POSTGREST_ERROR"}`);
  if (result.data === null) throw new Error(`${label}:NO_DATA`);
  return result.data;
}

async function main() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error("RECOVERY_PRIVATE_READ_ENV_MISSING");
  const supabase = createSupabaseServerClient();

  const attemptResult = await supabase.from("pipeline_event_attempts")
    .select("id,event_key,pipeline_run_id,attempt_number,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit")
    .eq("id", attemptId)
    .maybeSingle();
  if (attemptResult.error) throw new Error(`ATTEMPT_READ:${attemptResult.error.code ?? "POSTGREST_ERROR"}`);
  const attempt = attemptResult.data;

  const attemptCountResult = await supabase.from("pipeline_event_attempts")
    .select("id", { count: "exact", head: true })
    .is("validation_namespace", null);
  if (attemptCountResult.error || attemptCountResult.count === null) throw new Error(`REAL_ATTEMPT_COUNT_READ:${attemptCountResult.error?.code ?? "NO_COUNT"}`);

  const articleResult = await supabase.from("articles")
    .select("id,slug,headline_es,summary_es,why_it_matters_es,body_es,metadata,publication_status")
    .eq("publication_status", "published")
    .order("id", { ascending: true });
  const articles = expectRead(articleResult, "PUBLIC_ARTICLE_READ");
  const fingerprints = articles.map((article) => ({ id: article.id, fingerprint: publicArticleFingerprintV1(article) }));
  const baselineFingerprints = baseline.publicFingerprints.articles.map(({ id, fingerprint }) => ({ id, fingerprint }));

  const astraResult = await supabase.from("articles").select("id,publication_status").eq("id", astraArticleId).maybeSingle();
  if (astraResult.error) throw new Error(`ASTRA_READ:${astraResult.error.code ?? "POSTGREST_ERROR"}`);

  const pipelineRunsResult = await supabase.from("agent_runs").select("config,stats,provider,finished_at").contains("config", { pipelineRunId });
  const pipelineRuns = expectRead(pipelineRunsResult, "PIPELINE_RUNS_READ");
  const stageAccounting = pipelineRuns.map((row) => {
    const config = row.config && typeof row.config === "object" && !Array.isArray(row.config) ? row.config : {};
    const stats = row.stats && typeof row.stats === "object" && !Array.isArray(row.stats) ? row.stats : {};
    const telemetry = stats.telemetry && typeof stats.telemetry === "object" && !Array.isArray(stats.telemetry) ? stats.telemetry : {};
    return {
      stage: typeof config.agentName === "string" ? config.agentName : "unknown",
      provider: row.provider,
      requestDispatched: telemetry.providerRequestDispatched === true,
      providerRequestsUsed: Number.isSafeInteger(telemetry.providerRequestsUsed) ? telemetry.providerRequestsUsed : 0,
      status: typeof telemetry.status === "string" ? telemetry.status : "unknown",
      inputTokens: Number.isSafeInteger(telemetry.inputTokens) ? telemetry.inputTokens : null,
      outputTokens: Number.isSafeInteger(telemetry.outputTokens) ? telemetry.outputTokens : null,
      totalTokens: Number.isSafeInteger(telemetry.totalTokens) ? telemetry.totalTokens : null,
    };
  });

  const reviewRead = new SupabaseHumanReviewReadRepository(supabase);
  const [reviewStatus, reviewList] = await Promise.all([reviewRead.status(), reviewRead.list(500)]);

  const utcDay = new Date().toISOString().slice(0, 10);
  const logger = new SupabaseAgentLogger(supabase);
  const providerAccounting = Object.fromEntries(await Promise.all(["groq", "cloudflare_workers_ai", "cerebras"].map(async (provider) => {
    const usage = await logger.getProviderDailyUsage(provider, utcDay);
    return [provider, {
      requestsReserved: usage.requestsReserved,
      requestsDispatched: usage.requestsDispatched,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      unknownTokenRequests: usage.unknownTokenRequests,
    }];
  })));
  const expectedAccounting = {
    groq: baseline.providerDelta.groq,
    cloudflare_workers_ai: { requests: baseline.providerDelta.cloudflare.requests, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cerebras: { requests: baseline.providerDelta.cerebras.requests, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  const recoveryAccountingDelta = Object.fromEntries(Object.entries(providerAccounting).map(([provider, usage]) => {
    const expected = expectedAccounting[provider];
    return [provider, {
      requestsReserved: usage.requestsReserved - expected.requests,
      requestsDispatched: usage.requestsDispatched - expected.requests,
      inputTokens: usage.inputTokens - expected.inputTokens,
      outputTokens: usage.outputTokens - expected.outputTokens,
      totalTokens: usage.totalTokens - expected.totalTokens,
      unknownTokenRequests: usage.unknownTokenRequests - (baseline.providerDelta.unknownDispatchedReservations ?? 0),
    }];
  }));

  if (deniedRequest) throw new Error("RECOVERY_READ_ONLY_FETCH_GUARD_FAILED");
  if (attemptCountResult.count !== baseline.productBaseline.postRun.realAttemptCount) throw new Error("REAL_ATTEMPT_COUNT_CHANGED_FROM_POST_CYCLE_BASELINE");
  if (JSON.stringify(fingerprints) !== JSON.stringify(baselineFingerprints)) throw new Error("PUBLIC_ARTICLE_FINGERPRINTS_CHANGED_FROM_12F3_BASELINE");
  if (!attempt || attempt.id !== attemptId || attempt.pipeline_run_id !== pipelineRunId || attempt.completed_at !== null || attempt.final_state !== null) throw new Error("REAL_ATTEMPT_STATE_CHANGED_FROM_ACTIVE_INCOMPLETE");
  if (attempt.stop_stage !== null || attempt.stop_reason !== null) throw new Error("REAL_ATTEMPT_IS_NOT_CAPACITY_DEFERRED");
  if (astraResult.data?.publication_status !== "archived") throw new Error("ASTRA_NOT_ARCHIVED");
  if (stageAccounting.filter((row) => row.stage === "editor").some((row) => row.requestDispatched || row.providerRequestsUsed !== 0)) throw new Error("EDITOR_DISPATCH_EVIDENCE_CONFLICT");
  if (reviewList.reviews.length !== 0 || reviewStatus.totalReviews !== 0 || reviewStatus.waitingReviews !== 0) throw new Error("HUMAN_REVIEW_BASELINE_NOT_EMPTY");
  if (Object.values(recoveryAccountingDelta).some((delta) => Object.values(delta).some((value) => value !== 0))) throw new Error("PROVIDER_ACCOUNTING_CHANGED_SINCE_12F3_BASELINE");

  console.log(JSON.stringify({
    capturedAtUtc: new Date().toISOString(),
    mechanism: "createSupabaseServerClient / PostgREST GET/HEAD plus the two read-only human-review RPCs",
    allowedHttpMethods: [...new Set(diagnostics.map((request) => request.method))].sort(),
    requestCount: diagnostics.length,
    allRemoteRequestsReadOnly: !deniedRequest,
    attempt: {
      id: attempt.id,
      active: attempt.completed_at === null && attempt.final_state === null,
      finalState: attempt.final_state,
      stopStage: attempt.stop_stage,
      stopReason: attempt.stop_reason,
      attemptNumber: attempt.attempt_number,
      realAttemptCount: attemptCountResult.count,
      unchangedFromPostCycleBaseline: attemptCountResult.count === baseline.productBaseline.postRun.realAttemptCount,
    },
    stageAccounting,
    publicArticleCount: articles.length,
    publicFingerprints: fingerprints,
    publicFingerprintsUnchanged: true,
    astraPublicationStatus: astraResult.data?.publication_status ?? null,
    astraStillArchived: astraResult.data?.publication_status === "archived",
    reviews: { total: reviewStatus.totalReviews, waiting: reviewStatus.waitingReviews, listed: reviewList.reviews.length },
    providerAccounting,
    recoveryAccountingDelta,
    providerCallsDuringRecovery: 0,
    remoteWrites: 0,
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[url]").replace(/(?:secret|api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, "[redacted]") : "RECOVERY_PRIVATE_READ_FAILED";
  console.error(message);
  process.exitCode = 1;
});
