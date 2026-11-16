import { createClient } from "@supabase/supabase-js";

const config = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(),
  key: process.env.SUPABASE_SECRET_KEY?.trim(),
};
if (!config.url || !config.key) throw new Error("SUPABASE_READONLY_AUDIT_CONFIGURATION_MISSING");

const ids = {
  event: "5138e509-f4c3-4020-9d13-6a6efac99a39",
  eventKey: "event-30f226d1b8ba5c9eb8af2b65c46db512",
  article: "756b0ee0-b5e6-4153-846f-278a12c9afe3",
  slug: "openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad",
  attempt: "a82482be-58d8-4fc6-ac16-946d0906257b",
  rawItem: "d3834944-72f6-4f59-9aca-3f66ae92dc33",
  source: "e8dd0363-f51e-4381-9fb2-c02ee81f4d41",
  contentHash: "sha256:9f053bdbb6d53e5d59baf254201811874992bf7cad444b38431b8f364bfe5caa",
};

const supabase = createClient(config.url, config.key, {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const observedAtUtc = new Date().toISOString();
const [eventsResult, articlesResult, publicIncidentResult, publicCountResult, eventSourcesResult, rawResult, sourceResult, attemptsResult, runsResult] = await Promise.all([
  supabase.from("events").select("id,event_key,event_status,review_status").eq("id", ids.event).maybeSingle(),
  supabase.from("articles").select("id,event_id,slug,publication_status,updated_at").eq("id", ids.article).maybeSingle(),
  supabase.from("public_published_articles").select("slug").eq("slug", ids.slug).maybeSingle(),
  supabase.from("public_published_articles").select("slug", { count: "exact", head: true }),
  supabase.from("event_sources").select("event_id,raw_item_id,source_id", { count: "exact" }).eq("event_id", ids.event),
  supabase.from("raw_items").select("id,source_id,content_hash,raw_content,extraction_quality,processing_status").eq("id", ids.rawItem).maybeSingle(),
  supabase.from("sources").select("id,name").eq("id", ids.source).maybeSingle(),
  supabase.from("pipeline_event_attempts").select("id,event_key,pipeline_run_id,attempt_number,purpose,pilot_attempt_number,final_state,stop_stage,stop_reason,completed_at,remediation_article_id,remediation_raw_item_id,remediation_prior_attempt_id,continuation").eq("event_key", ids.eventKey),
  supabase.from("agent_runs").select("id,config,stats,status,provider").eq("config->>eventKey", ids.eventKey).eq("config->>attemptId", ids.attempt),
]);
const errors = [eventsResult, articlesResult, publicIncidentResult, publicCountResult, eventSourcesResult, rawResult, sourceResult, attemptsResult, runsResult]
  .flatMap((result, index) => result.error ? [`read_${index}:${result.error.code ?? "NO_CODE"}:${result.error.message}`] : []);
if (errors.length) throw new Error(`SUPABASE_READONLY_AUDIT_READ_FAILED:${errors.join(",")}`);

const events = eventsResult.data ? [eventsResult.data] : [];
const articles = articlesResult.data ? [articlesResult.data] : [];
const raw = rawResult.data;
const source = sourceResult.data;
const attempts = attemptsResult.data ?? [];
const runs = runsResult.data ?? [];
const criticRuns = runs.filter((run) => run.config?.agentName === "critic" && run.config?.agentVersion === "critic-v4");
const criticRunIds = criticRuns.map((run) => run.id);
const logsResult = criticRunIds.length
  ? await supabase.from("agent_logs").select("id,run_id,step,payload").in("run_id", criticRunIds)
  : { data: [], error: null };
if (logsResult.error) throw new Error(`SUPABASE_READONLY_AUDIT_LOG_READ_FAILED:${logsResult.error.code ?? "NO_CODE"}`);
const logs = logsResult.data ?? [];
const eventSourceRows = eventSourcesResult.data ?? [];
const eventSourceCount = eventSourcesResult.count ?? eventSourceRows.length;
const lineageMatch = eventSourceCount === 1 && eventSourceRows.length === 1 && eventSourceRows.some((row) => row.raw_item_id === ids.rawItem
  && row.source_id === ids.source
  && raw?.id === row.raw_item_id
  && raw.source_id === row.source_id
  && raw.content_hash === ids.contentHash
  && raw.raw_content !== null
  && raw.raw_content.length === 1756
  && raw.extraction_quality === "full"
  && raw.processing_status === "extracted"
  && source?.id === row.source_id
  && source.name === "TechCrunch AI");
const result = {
  path: "supabase-js-postgrest-service-role-read-only",
  observedAtUtc,
  requests: { tableReads: 9 + (criticRunIds.length ? 1 : 0), writes: 0 },
  guardComponents: {
    eventOk: events.some((row) => row.id === ids.event && row.event_key === ids.eventKey && row.event_status === "active" && row.review_status === "approved"),
    articleArchivedOk: articles.some((row) => row.id === ids.article && row.event_id === ids.event && row.slug === ids.slug && row.publication_status === "archived"),
    incidentPublic: publicIncidentResult.data !== null,
    eventSourceCount,
    sourceRawLineageMatch: lineageMatch,
    guardRejects: !(events.some((row) => row.id === ids.event && row.event_key === ids.eventKey && row.event_status === "active" && row.review_status === "approved"))
      || !(articles.some((row) => row.id === ids.article && row.event_id === ids.event && row.slug === ids.slug && row.publication_status === "archived"))
      || publicIncidentResult.data !== null
      || eventSourceCount !== 1
      || !lineageMatch,
  },
  rawValues: {
    events,
    articles,
    incidentPublicRow: publicIncidentResult.data,
    publicCount: publicCountResult.count ?? 0,
    eventSources: eventSourceRows,
    eventSourceCount,
    rawItem: raw ? {
      id: raw.id,
      source_id: raw.source_id,
      content_hash: raw.content_hash,
      raw_content_is_null: raw.raw_content === null,
      raw_content_length_utf16: raw.raw_content?.length ?? null,
      raw_content_length_code_points: raw.raw_content === null ? null : [...raw.raw_content].length,
      extraction_quality: raw.extraction_quality,
      processing_status: raw.processing_status,
    } : null,
    source,
    attemptCount: attempts.length,
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      pipeline_run_id: attempt.pipeline_run_id,
      attempt_number: attempt.attempt_number,
      purpose: attempt.purpose,
      pilot_attempt_number: attempt.pilot_attempt_number,
      final_state: attempt.final_state,
      stop_stage: attempt.stop_stage,
      stop_reason: attempt.stop_reason,
      completed_at: attempt.completed_at,
      remediation_article_id: attempt.remediation_article_id,
      remediation_raw_item_id: attempt.remediation_raw_item_id,
      remediation_prior_attempt_id: attempt.remediation_prior_attempt_id,
      continuation: attempt.continuation,
    })),
    criticV4RunCount: criticRuns.length,
    criticV4ReservationLogCount: logs.filter((row) => row.step === "provider_request_reserved").length,
    criticDispatched: criticRuns.some((run) => run.stats?.telemetry?.providerRequestDispatched === true || run.stats?.telemetry?.providerRequestsUsed === 1)
      || logs.some((row) => row.payload?.providerRequestDispatched === true || row.payload?.details?.providerRequestDispatched === true),
  },
};
result.overallGuardPass = !result.guardComponents.guardRejects;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
