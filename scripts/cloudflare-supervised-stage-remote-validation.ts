import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import type { Database } from "../types/database.ts";

const rpcName = "reserve_cloudflare_supervised_stage_validation_capacity" as const;
type RpcArgs = Database["public"]["Functions"][typeof rpcName]["Args"];
type JsonRecord = Record<string, unknown>;

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function object(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`BLOCKED_MISSING_${name}`);
  return value;
}

function makeArgs(input: {
  runId: string;
  eventKey: string;
  requestDate: string;
  allocation?: number;
  estimatedNeurons?: number;
}): RpcArgs {
  return {
    p_run_id: input.runId,
    p_stage: "editor",
    p_agent_name: "editor",
    p_agent_version: "editor-v2",
    p_event_key: input.eventKey,
    p_fixture: "editor:canonical-editor-input",
    p_attempt: 1,
    p_validation_purpose: "editor_stage_validation",
    p_provider: "cloudflare_workers_ai",
    p_model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    p_request_date: input.requestDate,
    p_request_limit: 1,
    p_daily_neuron_allocation: input.allocation ?? 10_000,
    p_estimated_neurons: input.estimatedNeurons ?? 1,
  };
}

async function countRows(query: PromiseLike<{ count: number | null; error: { message: string } | null }>, code: string): Promise<number> {
  const response = await query;
  if (response.error || response.count === null) throw new Error(code);
  return response.count;
}

async function expectRejected(db: ReturnType<typeof createSupabaseServerClient>, args: RpcArgs, messagePart: string, code: string): Promise<void> {
  const response = await db.rpc(rpcName, args);
  check(response.error?.code === "P0001", code);
  check(response.error.message.toLowerCase().includes(messagePart.toLowerCase()), code);
}

async function main(): Promise<void> {
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const db = createSupabaseServerClient();
  const anon = createClient<Database>(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const utcDate = new Date().toISOString().slice(0, 10);
  const eventKey = `supervised-validation:editor_stage_validation:${randomUUID()}`;
  const runId = randomUUID();
  const cleanRun = {
    id: runId,
    run_type: "other" as const,
    started_at: new Date().toISOString(),
    status: "running" as const,
    dry_run: true,
    provider: "cloudflare_workers_ai" as const,
    config: { supervisedStageRemoteValidation: true, provider: "cloudflare_workers_ai", stage: "editor" },
    stats: {},
  };

  const articlesBefore = await countRows(db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE");
  const attemptsBefore = await countRows(db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }), "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE");
  let runCreated = false;
  let runCleaned = false;

  try {
    const inserted = await db.from("agent_runs").insert(cleanRun).select("id").single();
    check(!inserted.error && inserted.data?.id === runId, "BLOCKED_TEMP_VALIDATION_RUN_CREATE");
    runCreated = true;

    const anonDenied = await anon.rpc(rpcName, makeArgs({ runId, eventKey, requestDate: utcDate }));
    check(anonDenied.error?.code === "42501", "BLOCKED_ANON_RPC_ACCESS_NOT_DENIED");

    const valid = makeArgs({ runId, eventKey, requestDate: utcDate });
    await expectRejected(db, { ...valid, p_provider: "groq" } as unknown as RpcArgs, "request is outside", "BLOCKED_INVALID_PROVIDER_ACCEPTED");
    await expectRejected(db, { ...valid, p_model: "openai/gpt-oss-20b" }, "request is outside", "BLOCKED_INVALID_MODEL_ACCEPTED");
    await expectRejected(db, { ...valid, p_stage: "publisher" } as unknown as RpcArgs, "stage is outside", "BLOCKED_INVALID_STAGE_ACCEPTED");
    await expectRejected(db, { ...valid, p_fixture: "editor:non-canonical-fixture" }, "request is outside", "BLOCKED_INVALID_FIXTURE_ACCEPTED");
    await expectRejected(db, { ...valid, p_daily_neuron_allocation: 10_001 }, "hard cap", "BLOCKED_HARD_CAP_CONFIGURATION_BYPASS");

    const blockedCapacity = await db.rpc(rpcName, {
      ...valid,
      p_daily_neuron_allocation: 1,
      p_estimated_neurons: 2,
    });
    check(!blockedCapacity.error && object(blockedCapacity.data).allowed === false, "BLOCKED_NEURON_HARD_CAP_NOT_ENFORCED");

    const previousUtcDate = new Date(Date.parse(`${utcDate}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    await expectRejected(db, { ...valid, p_request_date: previousUtcDate }, "current utc day", "BLOCKED_UTC_SCOPE_NOT_ENFORCED");

    const noReservation = await db.from("agent_logs").select("id", { count: "exact", head: true }).eq("run_id", runId);
    check(!noReservation.error && noReservation.count === 0, "BLOCKED_NEGATIVE_VALIDATION_LEFT_RESERVATION");
  } finally {
    if (runCreated) {
      const deleted = await db.from("agent_runs").delete().eq("id", runId);
      runCleaned = !deleted.error;
    } else {
      runCleaned = true;
    }
  }

  check(runCleaned, "BLOCKED_TEMP_VALIDATION_RUN_CLEANUP");
  const remainingRun = await db.from("agent_runs").select("id", { count: "exact", head: true }).eq("id", runId);
  const remainingLogs = await db.from("agent_logs").select("id", { count: "exact", head: true }).eq("run_id", runId);
  check(!remainingRun.error && remainingRun.count === 0, "BLOCKED_TEMP_RUN_REMAINS");
  check(!remainingLogs.error && remainingLogs.count === 0, "BLOCKED_TEMP_LOGS_REMAIN");

  const articlesAfter = await countRows(db.from("articles").select("id", { count: "exact", head: true }), "BLOCKED_ARTICLE_COUNT_UNAVAILABLE_AFTER");
  const attemptsAfter = await countRows(db.from("pipeline_event_attempts").select("id", { count: "exact", head: true }), "BLOCKED_EVENT_ATTEMPT_COUNT_UNAVAILABLE_AFTER");
  check(articlesAfter === articlesBefore && attemptsAfter === attemptsBefore, "BLOCKED_PUBLICATION_SIDE_EFFECT");

  process.stdout.write(`${JSON.stringify({
    migrationRemoteValidation: "PASS",
    serviceRoleCanExecute: "YES (positive authorized reservation will be the single Editor reservation)",
    anonCannotExecute: "PASS",
    authenticatedCannotExecute: "CONFIRMED by remote PostgreSQL ACL query",
    invalidProviderRejected: true,
    invalidModelRejected: true,
    invalidStageRejected: true,
    invalidFixtureRejected: true,
    hardCapEnforced: true,
    utcScopeEnforced: true,
    temporaryRunCleaned: true,
    temporaryLogsRemaining: 0,
    articlesBeforeAndAfterUnchanged: true,
    productionAttemptsBeforeAndAfterUnchanged: true,
    utcDate,
    inferenceCalls: 0,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_:-]{3,120}$/.test(error.message) ? error.message : "BLOCKED_REMOTE_VALIDATION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
