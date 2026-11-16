import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { publicArticleFingerprintV1 } from "../lib/articles/public-article-fingerprint.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";

const mode = process.argv[2];
if (!["before", "after"].includes(mode)) throw new Error("BASELINE_MODE_REQUIRED");
const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
const originalFetch = globalThis.fetch.bind(globalThis);
const readRpc = new Set(["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator"]);
let requests = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.origin !== origin || !url.pathname.startsWith("/rest/v1/") || !(["GET", "HEAD"].includes(method) || method === "POST" && readRpc.has(url.pathname.split("/").at(-1)))) throw new Error("M36_BASELINE_READONLY_GUARD");
  const response = await originalFetch(input, init);
  requests += 1;
  return response;
};
const supabase = createSupabaseServerClient();
const data = (response, label) => { if (response.error || response.data === null) throw new Error(`${label}:${response.error?.code ?? "NO_DATA"}`); return response.data; };
async function allRows(table) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = data(await supabase.from(table).select("*").order("id").range(offset, offset + 499), `BASELINE_${table}`);
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const [attempts, logs, runs, articles] = await Promise.all([allRows("pipeline_event_attempts"), allRows("agent_logs"), allRows("agent_runs"), allRows("articles")]);
const trigger = data(await supabase.from("scheduler_runs").select("*").eq("trigger_id", "supervised-candidates:2026-10-15"), "CONSUMED_TRIGGER");
const realAttempts = attempts.filter((row) => row.validation_namespace === null);
const pending = realAttempts.filter((row) => row.completed_at === null);
const deferred = pending.filter((row) => row.stop_reason === "PROVIDER_CAPACITY_EXHAUSTED");
const active = pending.filter((row) => row.stop_reason !== "PROVIDER_CAPACITY_EXHAUSTED");
const stuck = active.filter((row) => Date.parse(row.started_at) + 3_600_000 <= Date.now());
const publicRows = articles.filter((row) => row.publication_status === "published");
const fingerprints = publicRows.map((row) => ({ id: row.id, fingerprint: publicArticleFingerprintV1(row) }));
const expected = [
  { id: "6203559f-413a-4f06-9346-1720bbeb0e7a", fingerprint: "73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64" },
  { id: "7415c685-04ed-4956-a77a-4bc372c9b060", fingerprint: "728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b" },
];
const astraArchived = articles.find((row) => row.id === "756b0ee0-b5e6-4153-846f-278a12c9afe3")?.publication_status === "archived";
const reviewRepo = new SupabaseHumanReviewReadRepository(supabase);
const status = await reviewRepo.status();
const list = await reviewRepo.list(500);
const utcDate = new Date().toISOString().slice(0, 10);
const logger = new SupabaseAgentLogger(supabase);
const accounting = {};
for (const provider of ["groq", "cloudflare_workers_ai", "cerebras"]) {
  const usage = await logger.getProviderDailyUsage(provider, utcDate);
  accounting[provider] = { requestsReserved: usage.requestsReserved, requestsDispatched: usage.requestsDispatched, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, unknownTokenRequests: usage.unknownTokenRequests };
}
if (realAttempts.length !== 17 || pending.length || status.totalReviews || status.waitingReviews || list.reviews.length || !astraArchived || JSON.stringify(fingerprints) !== JSON.stringify(expected)) throw new Error("M36_REAL_BASELINE_CHANGED");
if (trigger.length !== 1 || trigger[0].pipeline_run_id !== "f00f75f9-591e-4d29-b6f5-4d3c5b4b9ee0" || trigger[0].lease_status !== "released" || trigger[0].run_status !== "failed") throw new Error("M36_CONSUMED_TRIGGER_CHANGED");
if (Object.values(accounting).some((row) => Object.values(row).some((value) => value !== 0))) throw new Error("M36_CURRENT_ACCOUNTING_CHANGED");
const integrity = { attempts: hash(attempts), agentLogs: hash(logs), agentRuns: hash(runs), allArticles: hash(articles), consumedTrigger: hash(trigger) };
const output = { mode, capturedAtUtc: new Date().toISOString(), utcDate, attempts: realAttempts.length, activeDeferredStuck: [active.length, deferred.length, stuck.length], reviews: status.totalReviews, waiting: status.waitingReviews, publicArticles: publicRows.length, astraArchived, fingerprints, m32: "PASS", accounting, trigger: { id: trigger[0].id, triggerId: trigger[0].trigger_id, status: trigger[0].run_status, consumed: true }, integrity, rowCounts: { attempts: attempts.length, logs: logs.length, runs: runs.length, articles: articles.length }, requests, providerCalls: 0, pipelineRuns: 0, remoteWrites: 0 };
await writeFile(`artifacts/supervised-cycle-12f9b-baseline-${mode}.json`, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
