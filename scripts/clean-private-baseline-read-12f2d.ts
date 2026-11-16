import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";

const historicalAttemptId = "3ebda423-2aa6-4f3a-b119-53982fbf58d9";
const astraArticleId = "756b0ee0-b5e6-4153-846f-278a12c9afe3";
const diagnostics: Array<{ method: string; path: string; status: number; date: string | null }> = [];
const originalFetch = globalThis.fetch.bind(globalThis);
let unsafeRequestObserved = false;

globalThis.fetch = async (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(requestUrl);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (!url.pathname.startsWith("/rest/v1/") || !["GET", "HEAD"].includes(method)) unsafeRequestObserved = true;
  const response = await originalFetch(input, init);
  diagnostics.push({ method, path: url.pathname, status: response.status, date: response.headers.get("date") });
  return response;
};

function assertReadOnlyQuery<T>(result: { data: T | null; error: { code?: string; message: string } | null }, name: string): T {
  if (result.error) throw new Error(`${name}:${result.error.code ?? "NO_POSTGREST_CODE"}:${result.error.message}`);
  if (result.data === null) throw new Error(`${name}:NO_DATA`);
  return result.data;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) throw new Error("PRIVATE_READ_REQUIRED_ENV_MISSING");
  const credentialClass = secretKey.startsWith("sb_secret_") ? "[REDACTED_SUPABASE_PRIVATE_KEY]" : "server-secret-format-unclassified";
  const supabase = createSupabaseServerClient();

  const health = await supabase.from("pipeline_event_attempts").select("id", { count: "exact", head: true });
  if (health.error) throw new Error(`PRIVATE_READ_HEALTH:${health.error.code ?? "NO_POSTGREST_CODE"}:${health.error.message}`);
  const healthRequest = diagnostics.at(-1);
  if (!healthRequest || healthRequest.status !== 200) throw new Error("PRIVATE_READ_HEALTH_HTTP_NOT_200");

  const publicResult = await supabase.from("articles")
    .select("id,slug,headline_es,summary_es,why_it_matters_es,body_es,metadata,publication_status")
    .eq("publication_status", "published")
    .order("id", { ascending: true });
  const publicArticles = assertReadOnlyQuery(publicResult, "PUBLIC_ARTICLES_READ");
  const astraResult = await supabase.from("articles")
    .select("id,slug,publication_status,published_at")
    .eq("id", astraArticleId)
    .maybeSingle();
  if (astraResult.error) throw new Error(`ASTRA_READ:${astraResult.error.code ?? "NO_POSTGREST_CODE"}:${astraResult.error.message}`);

  const attemptResult = await supabase.from("pipeline_event_attempts")
    .select("id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,next_eligible_at,purpose,validation_namespace")
    .is("validation_namespace", null)
    .order("started_at", { ascending: true });
  const attempts = assertReadOnlyQuery(attemptResult, "REAL_ATTEMPTS_READ");
  const historical = attempts.find((attempt) => attempt.id === historicalAttemptId);
  const active = attempts.filter((attempt) => attempt.completed_at === null);
  const deferred = active.filter((attempt) => attempt.final_state === null && attempt.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED" && attempt.counts_toward_retry_limit === false);
  const nowMs = Date.now();
  const stuck = active.filter((attempt) => Date.parse(attempt.started_at) < nowMs - 60 * 60 * 1000);

  const utcDay = new Date().toISOString().slice(0, 10);
  const logger = new SupabaseAgentLogger(supabase);
  const providers = ["groq", "cloudflare_workers_ai", "cerebras"] as const;
  const providerAccounting = Object.fromEntries(await Promise.all(providers.map(async (provider) => [provider, {
    usage: await logger.getProviderDailyUsage(provider, utcDay),
    rateLimitState: await logger.getProviderRateLimitState(provider),
  }] as const)));

  const schedulerResult = await supabase.from("scheduler_runs")
    .select("id,trigger_id,lease_status,run_status,final_decision,dry_run,publish,created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  const latestSchedulerRows = assertReadOnlyQuery(schedulerResult, "SCHEDULER_READ");
  const activeLeasesResult = await supabase.from("scheduler_runs").select("id", { count: "exact", head: true }).is("released_at", null);
  if (activeLeasesResult.error) throw new Error(`ACTIVE_SCHEDULER_LEASE_READ:${activeLeasesResult.error.code ?? "NO_POSTGREST_CODE"}:${activeLeasesResult.error.message}`);

  if (unsafeRequestObserved) throw new Error("NON_READ_OR_NON_POSTGREST_REQUEST_OBSERVED");
  if (publicArticles.length !== 2) throw new Error(`PUBLIC_ARTICLE_COUNT_EXPECTED_2:${publicArticles.length}`);

  const finishedAt = new Date().toISOString();
  console.log(JSON.stringify({
    capturedAtUtc: finishedAt,
    privateRead: {
      status: "PASS",
      localStartUtc: startedAt,
      localFinishUtc: finishedAt,
      httpStatus: healthRequest.status,
      rowCount: health.count,
      postgrestCode: null,
      responseDate: healthRequest.date,
      mechanism: "createSupabaseServerClient() / Supabase JS PostgREST; GET/HEAD only",
      urlEnvironmentVariable: "NEXT_PUBLIC_SUPABASE_URL",
      credentialEnvironmentVariable: "SUPABASE_SECRET_KEY",
      credentialClass,
      credentialValuesPrinted: false,
      requests: diagnostics,
      supabaseCliInvoked: false,
      managementApiProvisioningInitiated: false,
    },
    publicArticleCount: publicArticles.length,
    publicArticles: publicArticles.map((article) => ({
      ...article,
      publicArticleFingerprintV1: publicArticleFingerprintV1(article),
    })),
    astra: astraResult.data,
    attemptState: {
      realAttemptCount: attempts.length,
      activeCount: active.length,
      deferredProviderCapacityCount: deferred.length,
      stuckCount: stuck.length,
      historical12f2Attempt: historical ?? null,
    },
    providerAccounting: { utcDay, byProvider: providerAccounting },
    schedulerState: {
      latestRun: latestSchedulerRows[0] ?? null,
      activeLeaseCount: activeLeasesResult.count ?? null,
    },
    reviewState: {
      status: "UNAVAILABLE_VIA_EXISTING_APPLICATION_READ_PATH",
      reason: "pipeline_human_reviews SELECT is revoked for service_role; the only existing reader is linked Supabase CLI SQL, which is forbidden for this phase.",
      queried: false,
    },
    remoteWrites: 0,
    infrastructureProvisioningInitiated: 0,
    providerCalls: 0,
  }, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[url]") : "PRIVATE_BASELINE_READ_FAILED";
  console.error(message);
  process.exitCode = 1;
});
