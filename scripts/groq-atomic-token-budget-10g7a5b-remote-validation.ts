import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../types/database.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";

type Client = SupabaseClient<Database>;
type RpcObject = Record<string, unknown>;
type Snapshot = {
  utcPeriod: string;
  allAgentLogRows: number;
  providerReservationRows: number;
  groqRequests: number;
  groqDispatched: number;
  groqTokens: number;
  groqInputTokens: number;
  groqOutputTokens: number;
  groqTokenUsageKnown: boolean;
  groqUnknownTokenRequests: number;
  cloudflareRequests: number;
  cloudflareDispatched: number;
  cloudflareNeurons: number;
};

const expectedProjectRef = getArgument("expected-project-ref");
const preflightOnly = process.argv.includes("--preflight-only");
const requestDate = new Date().toISOString().slice(0, 10);
const validationNamespace = `10g7a5b:${randomUUID()}`;
const fixtureRunIds = new Set<string>();
const scenarioResults: Record<string, string> = {};
let admin: Client | null = null;
let logger: SupabaseAgentLogger | null = null;
let preFixture: Snapshot | null = null;
let cleanupStatus = "NOT_STARTED";
let projectMatches = false;

function getArgument(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function requiredEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_SECRET_KEY" | "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`PREFLIGHT_MISSING_${name}`);
  return value;
}

function assert(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

function object(value: unknown, label: string): RpcObject {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label}_NOT_OBJECT`);
  return value as RpcObject;
}

function integer(value: unknown, label: string): number {
  assert(typeof value === "number" && Number.isSafeInteger(value), `${label}_NOT_SAFE_INTEGER`);
  return value;
}

function rpcErrorCode(error: { code?: string; message?: string }): string {
  if (error.code === "42501" || /permission denied/i.test(error.message ?? "")) return "42501_PERMISSION_DENIED";
  if ((error.message ?? "").includes("provider_token_settlement_conflict")) return "PROVIDER_TOKEN_SETTLEMENT_CONFLICT";
  return /^[A-Z0-9]{4,8}$/.test(error.code ?? "") ? error.code! : "REMOTE_RPC_ERROR";
}

function plus(value: number, amount: number): number {
  const result = value + amount;
  assert(Number.isSafeInteger(result) && result > 0, "DYNAMIC_TEST_LIMIT_OUT_OF_RANGE");
  return result;
}

async function makeSnapshot(date: string): Promise<Snapshot> {
  assert(admin && logger, "SERVICE_CLIENT_NOT_READY");
  const start = `${date}T00:00:00.000Z`;
  const end = new Date(Date.parse(start) + 86_400_000).toISOString();
  const groq = await logger.getProviderDailyUsage("groq", date);
  const cloudflare = await logger.getProviderDailyUsage("cloudflare_workers_ai", date);
  const allLogs = await admin.from("agent_logs").select("id", { count: "exact", head: true }).gte("created_at", start).lt("created_at", end);
  if (allLogs.error) throw new Error(`AGENT_LOG_BASELINE_READ_FAILED_${rpcErrorCode(allLogs.error)}`);
  assert(typeof allLogs.count === "number", "AGENT_LOG_BASELINE_COUNT_MISSING");
  const reservations = await admin.from("agent_logs").select("id", { count: "exact", head: true }).eq("step", "provider_request_reserved").gte("created_at", start).lt("created_at", end);
  if (reservations.error) throw new Error(`RESERVATION_BASELINE_READ_FAILED_${rpcErrorCode(reservations.error)}`);
  assert(typeof reservations.count === "number", "RESERVATION_BASELINE_COUNT_MISSING");
  const cloudflareNeurons = cloudflare.neuronsUsed;
  assert(cloudflare.neuronUsageKnown && typeof cloudflareNeurons === "number" && Number.isSafeInteger(cloudflareNeurons), "CLOUDFLARE_NEURON_BASELINE_UNKNOWN");
  return {
    utcPeriod: date,
    allAgentLogRows: allLogs.count,
    providerReservationRows: reservations.count,
    groqRequests: groq.requestsReserved,
    groqDispatched: groq.requestsDispatched,
    groqTokens: groq.totalTokens,
    groqInputTokens: groq.inputTokens,
    groqOutputTokens: groq.outputTokens,
    groqTokenUsageKnown: groq.tokenUsageKnown,
    groqUnknownTokenRequests: groq.unknownTokenRequests,
    cloudflareRequests: cloudflare.requestsReserved,
    cloudflareDispatched: cloudflare.requestsDispatched,
    cloudflareNeurons,
  };
}

async function createFixtureRun(scenario: string): Promise<string> {
  assert(admin, "SERVICE_CLIENT_NOT_READY");
  const { data, error } = await admin.from("agent_runs").insert({
    run_type: "other",
    started_at: new Date().toISOString(),
    status: "running",
    dry_run: true,
    provider: "groq",
    stats: { validationNamespace, scenario } as Json,
    config: { validationFixture: true, validationNamespace, scenario } as Json,
  }).select("id").single();
  if (error || !data) throw new Error(`FIXTURE_RUN_CREATE_FAILED_${error ? rpcErrorCode(error) : "NO_ROW"}`);
  fixtureRunIds.add(data.id);
  return data.id;
}

function reservationArgs(
  runId: string,
  scenario: string,
  attempt: number,
  limits: { requestHard: number; requestSoft: number; tokenHard: number; tokenSoft: number },
  estimate: number,
) {
  return {
    p_run_id: runId,
    p_agent_name: "groq-capacity-validation-fixture",
    p_agent_version: "10g7a5b-validation-v1",
    p_event_key: `${validationNamespace}:${scenario}`,
    p_attempt: attempt,
    p_model: "openai/gpt-oss-20b",
    p_request_date: requestDate,
    p_request_hard_limit: limits.requestHard,
    p_request_soft_limit: limits.requestSoft,
    p_token_hard_limit: limits.tokenHard,
    p_token_soft_limit: limits.tokenSoft,
    p_estimated_tokens: estimate,
  };
}

async function reserve(args: ReturnType<typeof reservationArgs>): Promise<RpcObject> {
  assert(admin, "SERVICE_CLIENT_NOT_READY");
  const { data, error } = await admin.rpc("reserve_groq_request_and_tokens", args);
  if (error) throw new Error(`RESERVE_RPC_FAILED_${rpcErrorCode(error)}`);
  const result = object(data, "RESERVE_RESULT");
  assert(result.quotaPeriodUtc === requestDate, "RESERVATION_NOT_ASSOCIATED_WITH_CURRENT_UTC_PERIOD");
  return result;
}

async function callBooleanRpc(
  name: "release_agent_request" | "mark_agent_request_dispatched",
  reservationId: number,
  runId: string,
  date: string,
): Promise<boolean> {
  assert(admin, "SERVICE_CLIENT_NOT_READY");
  const { data, error } = await admin.rpc(name, { p_reservation_id: reservationId, p_run_id: runId, p_request_date: date });
  if (error) throw new Error(`${name.toUpperCase()}_FAILED_${rpcErrorCode(error)}`);
  assert(typeof data === "boolean", `${name.toUpperCase()}_NOT_BOOLEAN`);
  return data;
}

async function settle(reservationId: number, runId: string, input: number, output: number): Promise<RpcObject> {
  assert(admin, "SERVICE_CLIENT_NOT_READY");
  const { data, error } = await admin.rpc("settle_groq_token_usage", {
    p_reservation_id: reservationId,
    p_run_id: runId,
    p_request_date: requestDate,
    p_actual_input_tokens: input,
    p_actual_output_tokens: output,
  });
  if (error) throw new Error(`SETTLEMENT_FAILED_${rpcErrorCode(error)}`);
  return object(data, "SETTLEMENT_RESULT");
}

async function reservationRow(id: number, runId: string, scenario: string) {
  assert(admin, "SERVICE_CLIENT_NOT_READY");
  const { data, error } = await admin.from("agent_logs")
    .select("id,run_id,provider,provider_unit,provider_unit_amount,payload")
    .eq("id", id).eq("run_id", runId).eq("step", "provider_request_reserved").single();
  assert(!error && data, "FIXTURE_RESERVATION_ROW_NOT_FOUND");
  const payload = object(data.payload, "FIXTURE_RESERVATION_PAYLOAD");
  assert(data.provider === "groq" && data.provider_unit === "tokens", "FIXTURE_PROVIDER_OR_UNIT_MISMATCH");
  assert(payload.eventKey === `${validationNamespace}:${scenario}`, "FIXTURE_NAMESPACE_MISMATCH");
  return { row: data, payload };
}

async function assertNoReservationForRun(runId: string, label: string): Promise<void> {
  assert(admin, "SERVICE_CLIENT_NOT_READY");
  const { count, error } = await admin.from("agent_logs").select("id", { count: "exact", head: true })
    .eq("run_id", runId).eq("step", "provider_request_reserved");
  assert(!error && count === 0, `${label}_LEFT_LEDGER_ROW`);
}

async function cleanupFixtureRun(runId: string): Promise<void> {
  assert(admin, "SERVICE_CLIENT_NOT_READY");
  const { data: run, error: readError } = await admin.from("agent_runs").select("id,stats").eq("id", runId).maybeSingle();
  if (readError) throw new Error("FIXTURE_CLEANUP_RUN_READ_FAILED");
  if (!run) {
    fixtureRunIds.delete(runId);
    return;
  }
  const stats = object(run.stats, "FIXTURE_CLEANUP_STATS");
  assert(stats.validationNamespace === validationNamespace, "FIXTURE_CLEANUP_NAMESPACE_MISMATCH");
  const { error: logsError } = await admin.from("agent_logs").delete().eq("run_id", runId);
  if (logsError) throw new Error("FIXTURE_CLEANUP_LOG_DELETE_FAILED");
  const { error: runError } = await admin.from("agent_runs").delete().eq("id", runId)
    .contains("stats", { validationNamespace });
  if (runError) throw new Error("FIXTURE_CLEANUP_RUN_DELETE_FAILED");
  const remainingLogs = await admin.from("agent_logs").select("id", { count: "exact", head: true }).eq("run_id", runId);
  const remainingRun = await admin.from("agent_runs").select("id", { count: "exact", head: true }).eq("id", runId);
  assert(!remainingLogs.error && remainingLogs.count === 0, "FIXTURE_CLEANUP_LOG_RESIDUE");
  assert(!remainingRun.error && remainingRun.count === 0, "FIXTURE_CLEANUP_RUN_RESIDUE");
  fixtureRunIds.delete(runId);
}

async function assertBaseline(snapshot: Snapshot, label: string): Promise<void> {
  assert(preFixture, "BASELINE_NOT_CAPTURED");
  assert(JSON.stringify(snapshot) === JSON.stringify(preFixture), `${label}_BASELINE_NOT_RESTORED`);
}

async function cleanup(): Promise<void> {
  if (!admin) return;
  let failed = false;
  const { data: taggedRuns, error: readError } = await admin.from("agent_runs").select("id,stats")
    .contains("stats", { validationNamespace });
  if (readError || !taggedRuns) failed = true;
  const ids = new Set([...fixtureRunIds, ...(taggedRuns ?? []).map((row) => row.id)]);
  for (const id of ids) {
    const { data: run, error: runError } = await admin.from("agent_runs").select("id,stats").eq("id", id).maybeSingle();
    if (runError) { failed = true; continue; }
    if (!run) continue;
    const stats = object(run.stats, "CLEANUP_RUN_STATS");
    if (stats.validationNamespace !== validationNamespace) { failed = true; continue; }
    const { error: logDeleteError } = await admin.from("agent_logs").delete().eq("run_id", id);
    if (logDeleteError) { failed = true; continue; }
    const { error: runDeleteError } = await admin.from("agent_runs").delete().eq("id", id).contains("stats", { validationNamespace });
    if (runDeleteError) failed = true;
  }
  const remainingRuns = await admin.from("agent_runs").select("id", { count: "exact", head: true }).contains("stats", { validationNamespace });
  const remainingLogs = await admin.from("agent_logs").select("id", { count: "exact", head: true }).like("payload->>eventKey", `${validationNamespace}%`);
  if (remainingRuns.error || remainingLogs.error || remainingRuns.count !== 0 || remainingLogs.count !== 0) failed = true;
  cleanupStatus = failed ? "FAILED" : "COMPLETE_ZERO_RESIDUAL_ROWS";
}

async function run(): Promise<void> {
  assert(expectedProjectRef, "PREFLIGHT_EXPECTED_PROJECT_REF_MISSING");
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const secretKey = requiredEnv("SUPABASE_SECRET_KEY");
  const publishableKey = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const actualProjectRef = new URL(url).hostname.split(".")[0];
  assert(actualProjectRef === expectedProjectRef, "PREFLIGHT_REMOTE_PROJECT_MISMATCH");
  projectMatches = true;
  admin = createClient<Database>(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  logger = new SupabaseAgentLogger(admin);
  const anon = createClient(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const before = await makeSnapshot(requestDate);
  assert(before.utcPeriod === requestDate, "PREFLIGHT_UTC_PERIOD_MISMATCH");
  assert(before.groqTokenUsageKnown && before.groqUnknownTokenRequests === 0, "PREFLIGHT_GROQ_TOKEN_BASELINE_UNKNOWN");
  const { count: namespaceCount, error: namespaceError } = await admin.from("agent_runs")
    .select("id", { count: "exact", head: true }).contains("stats", { validationNamespace });
  assert(!namespaceError && namespaceCount === 0, "PREFLIGHT_VALIDATION_NAMESPACE_COLLISION");
  preFixture = before;
  if (preflightOnly) {
    scenarioResults.preflight = "READ_ONLY_BASELINE_PASS";
    return;
  }

  const deniedArgs = reservationArgs(randomUUID(), "anon-negative", 1,
    { requestHard: plus(before.groqRequests, 2), requestSoft: plus(before.groqRequests, 2), tokenHard: plus(before.groqTokens, 2_000), tokenSoft: plus(before.groqTokens, 2_000) }, 10);
  const anonResult = await anon.rpc("reserve_groq_request_and_tokens", deniedArgs);
  assert(anonResult.error && rpcErrorCode(anonResult.error) === "42501_PERMISSION_DENIED", "ANON_RPC_NOT_DENIED_BY_GRANT");
  scenarioResults.anon = "DENIED";
  scenarioResults.authenticated = "DENIAL_PROVEN_BY_PG_GRANTS";

  const generous = (requestExtra: number, tokenExtra: number) => ({
    requestHard: plus(before.groqRequests, requestExtra),
    requestSoft: plus(before.groqRequests, requestExtra),
    tokenHard: plus(before.groqTokens, tokenExtra),
    tokenSoft: plus(before.groqTokens, tokenExtra),
  });

  // Basic atomic admission, identity verification, and pre-dispatch release.
  {
    const scenario = "basic-reserve-release";
    const runId = await createFixtureRun(scenario);
    const estimate = 200;
    const admitted = await reserve(reservationArgs(runId, scenario, 1, generous(5, 1_000), estimate));
    assert(admitted.allowed === true && admitted.admitted === true, "BASIC_RESERVATION_NOT_ADMITTED");
    const reservationId = integer(admitted.reservationId, "BASIC_RESERVATION_ID");
    assert(integer(admitted.requestUsageAfter, "BASIC_REQUEST_AFTER") === before.groqRequests + 1, "BASIC_REQUEST_DELTA_INVALID");
    assert(integer(admitted.tokenUsageAfter, "BASIC_TOKEN_AFTER") === before.groqTokens + estimate, "BASIC_TOKEN_DELTA_INVALID");
    const { row, payload } = await reservationRow(reservationId, runId, scenario);
    assert(row.provider_unit_amount === estimate && payload.providerRequestDispatched === false, "BASIC_ROW_NOT_ATOMIC_ESTIMATE");
    const current = await makeSnapshot(requestDate);
    assert(current.groqRequests === before.groqRequests + 1 && current.groqTokens === before.groqTokens + estimate, "BASIC_CANONICAL_USAGE_DELTA_INVALID");
    assert(await callBooleanRpc("release_agent_request", reservationId, runId, requestDate), "BASIC_PRE_DISPATCH_RELEASE_FAILED");
    await assertBaseline(await makeSnapshot(requestDate), "BASIC_RELEASE");
    await cleanupFixtureRun(runId);
    scenarioResults.basicReserveRelease = "PASS";
  }

  // Request capacity rejection must not write an accompanying token row.
  {
    const scenario = "request-capacity-atomicity";
    const anchorRun = await createFixtureRun(`${scenario}-anchor`);
    const anchor = await reserve(reservationArgs(anchorRun, scenario, 1, generous(1, 1_000), 100));
    assert(anchor.allowed === true, "REQUEST_ATOMICITY_ANCHOR_NOT_ADMITTED");
    const anchorId = integer(anchor.reservationId, "REQUEST_ANCHOR_ID");
    const rejectedRun = await createFixtureRun(`${scenario}-rejected`);
    const rejected = await reserve(reservationArgs(rejectedRun, scenario, 1, generous(1, 2_000), 100));
    assert(rejected.allowed === false && rejected.reason === "GROQ_DAILY_REQUEST_HARD_LIMIT", "REQUEST_CAPACITY_NOT_REJECTED");
    assert(integer(rejected.requestUsageAfter, "REQUEST_REJECT_REQUEST_AFTER") === before.groqRequests + 1, "REQUEST_REJECT_REQUEST_DELTA_INVALID");
    assert(integer(rejected.tokenUsageAfter, "REQUEST_REJECT_TOKEN_AFTER") === before.groqTokens + 100, "REQUEST_REJECT_TOKEN_DELTA_INVALID");
    await assertNoReservationForRun(rejectedRun, "REQUEST_REJECTION");
    assert(await callBooleanRpc("release_agent_request", anchorId, anchorRun, requestDate), "REQUEST_ANCHOR_RELEASE_FAILED");
    await assertBaseline(await makeSnapshot(requestDate), "REQUEST_ATOMICITY");
    await cleanupFixtureRun(anchorRun);
    await cleanupFixtureRun(rejectedRun);
    scenarioResults.requestFailTokenPass = "PASS_NO_TOKEN_ROW";
  }

  // Token capacity rejection must not write an accompanying request row.
  {
    const scenario = "token-capacity-atomicity";
    const anchorRun = await createFixtureRun(`${scenario}-anchor`);
    const anchorLimits = {
      requestHard: plus(before.groqRequests, 2), requestSoft: plus(before.groqRequests, 2),
      tokenHard: plus(before.groqTokens, 200), tokenSoft: plus(before.groqTokens, 100),
    };
    const anchor = await reserve(reservationArgs(anchorRun, scenario, 1, anchorLimits, 100));
    assert(anchor.allowed === true, "TOKEN_ATOMICITY_ANCHOR_NOT_ADMITTED");
    const anchorId = integer(anchor.reservationId, "TOKEN_ANCHOR_ID");
    const rejectedRun = await createFixtureRun(`${scenario}-rejected`);
    const rejected = await reserve(reservationArgs(rejectedRun, scenario, 1, anchorLimits, 1));
    assert(rejected.allowed === false && rejected.reason === "GROQ_DAILY_TOKEN_SOFT_LIMIT", "TOKEN_CAPACITY_NOT_REJECTED");
    assert(integer(rejected.requestUsageAfter, "TOKEN_REJECT_REQUEST_AFTER") === before.groqRequests + 1, "TOKEN_REJECT_REQUEST_DELTA_INVALID");
    assert(integer(rejected.tokenUsageAfter, "TOKEN_REJECT_TOKEN_AFTER") === before.groqTokens + 100, "TOKEN_REJECT_TOKEN_DELTA_INVALID");
    await assertNoReservationForRun(rejectedRun, "TOKEN_REJECTION");
    assert(await callBooleanRpc("release_agent_request", anchorId, anchorRun, requestDate), "TOKEN_ANCHOR_RELEASE_FAILED");
    await assertBaseline(await makeSnapshot(requestDate), "TOKEN_ATOMICITY");
    await cleanupFixtureRun(anchorRun);
    await cleanupFixtureRun(rejectedRun);
    scenarioResults.tokenFailRequestPass = "PASS_NO_REQUEST_ROW";
  }

  // Ownership: a different run cannot release another run's reservation.
  {
    const scenario = "ownership";
    const ownerRun = await createFixtureRun(scenario);
    const admitted = await reserve(reservationArgs(ownerRun, scenario, 1, generous(3, 500), 100));
    assert(admitted.allowed === true, "OWNERSHIP_RESERVATION_NOT_ADMITTED");
    const reservationId = integer(admitted.reservationId, "OWNERSHIP_RESERVATION_ID");
    assert(await callBooleanRpc("release_agent_request", reservationId, randomUUID(), requestDate) === false, "NON_OWNER_RELEASE_WAS_NOT_BLOCKED");
    const held = await makeSnapshot(requestDate);
    assert(held.groqRequests === before.groqRequests + 1 && held.groqTokens === before.groqTokens + 100, "NON_OWNER_CHANGED_ACCOUNTING");
    assert(await callBooleanRpc("release_agent_request", reservationId, ownerRun, requestDate), "OWNER_RELEASE_FAILED");
    await assertBaseline(await makeSnapshot(requestDate), "OWNERSHIP_RELEASE");
    await cleanupFixtureRun(ownerRun);
    scenarioResults.ownership = "PASS";
  }

  // Two independent HTTP RPC calls race at the token soft boundary.
  {
    const scenario = "concurrent-token-boundary";
    const firstRun = await createFixtureRun(`${scenario}-worker-a`);
    const secondRun = await createFixtureRun(`${scenario}-worker-b`);
    const estimate = 100;
    const limits = {
      requestHard: plus(before.groqRequests, 3), requestSoft: plus(before.groqRequests, 3),
      tokenHard: plus(before.groqTokens, estimate * 2), tokenSoft: plus(before.groqTokens, estimate),
    };
    const results = await Promise.all([
      reserve(reservationArgs(firstRun, scenario, 1, limits, estimate)),
      reserve(reservationArgs(secondRun, scenario, 1, limits, estimate)),
    ]);
    const admitted = results.filter((result) => result.allowed === true);
    const rejected = results.filter((result) => result.allowed === false);
    assert(admitted.length === 1 && rejected.length === 1, "CONCURRENCY_NOT_EXACTLY_ONE_ADMITTED");
    assert(rejected[0].reason === "GROQ_DAILY_TOKEN_SOFT_LIMIT", "CONCURRENCY_REJECT_REASON_NOT_TOKEN_BOUNDARY");
    const usage = await makeSnapshot(requestDate);
    assert(usage.groqRequests === before.groqRequests + 1 && usage.groqTokens === before.groqTokens + estimate, "CONCURRENCY_LEDGER_DELTA_INVALID");
    const admittedId = integer(admitted[0].reservationId, "CONCURRENCY_ADMITTED_ID");
    const admittedRun = admitted[0].requestUsageAfter === before.groqRequests + 1
      ? (results[0] === admitted[0] ? firstRun : secondRun)
      : "";
    assert(admittedRun.length > 0, "CONCURRENCY_OWNER_RESOLUTION_FAILED");
    assert(await callBooleanRpc("release_agent_request", admittedId, admittedRun, requestDate), "CONCURRENCY_RELEASE_FAILED");
    await assertBaseline(await makeSnapshot(requestDate), "CONCURRENCY_RELEASE");
    await cleanupFixtureRun(firstRun);
    await cleanupFixtureRun(secondRun);
    scenarioResults.concurrentReservations = "2_REAL_REMOTE_RPC_CALLS";
    scenarioResults.concurrentAdmitted = "1";
    scenarioResults.concurrentRejected = "1_GROQ_DAILY_TOKEN_SOFT_LIMIT";
    scenarioResults.requestDimensionConcurrency = "COVERED_BY_SHARED_ATOMIC_LOCK_PATH";
  }

  // Synthetic dispatched lifecycle: no HTTP was sent to any provider.
  {
    const scenario = "settlement-less-than-reserved";
    const runId = await createFixtureRun(scenario);
    const admitted = await reserve(reservationArgs(runId, scenario, 1, generous(3, 1_000), 200));
    assert(admitted.allowed === true, "LESS_SETTLEMENT_RESERVATION_NOT_ADMITTED");
    const reservationId = integer(admitted.reservationId, "LESS_SETTLEMENT_RESERVATION_ID");
    assert(await callBooleanRpc("mark_agent_request_dispatched", reservationId, runId, requestDate), "DISPATCH_MARKER_FAILED");
    assert(await callBooleanRpc("release_agent_request", reservationId, runId, requestDate) === false, "RELEASE_AFTER_DISPATCH_NOT_BLOCKED");
    const beforeSettle = await makeSnapshot(requestDate);
    assert(beforeSettle.groqRequests === before.groqRequests + 1 && beforeSettle.groqTokens === before.groqTokens + 200, "ESTIMATE_NOT_RETAINED_BEFORE_SETTLEMENT");
    const settlement = await settle(reservationId, runId, 80, 40);
    assert(settlement.settled === true && settlement.changed === true && integer(settlement.accountedTokens, "LESS_SETTLED_ACCOUNTED") === 120, "LESS_SETTLEMENT_FAILED");
    let usage = await makeSnapshot(requestDate);
    assert(usage.groqRequests === before.groqRequests + 1 && usage.groqTokens === before.groqTokens + 120, "LESS_SETTLEMENT_CANONICAL_USAGE_INVALID");
    const duplicate = await settle(reservationId, runId, 80, 40);
    assert(duplicate.settled === true && duplicate.changed === false && integer(duplicate.accountedTokens, "DUPLICATE_ACCOUNTED") === 120, "DUPLICATE_SETTLEMENT_NOT_IDEMPOTENT");
    let conflictSeen = false;
    try { await settle(reservationId, runId, 80, 41); }
    catch (error) { conflictSeen = error instanceof Error && error.message === "SETTLEMENT_FAILED_PROVIDER_TOKEN_SETTLEMENT_CONFLICT"; }
    assert(conflictSeen, "CONFLICTING_SETTLEMENT_NOT_FAIL_CLOSED");
    usage = await makeSnapshot(requestDate);
    assert(usage.groqRequests === before.groqRequests + 1 && usage.groqTokens === before.groqTokens + 120, "CONFLICT_CHANGED_ACCOUNTING");
    scenarioResults.releaseAfterDispatch = "BLOCKED_FALSE_NO_OP";
    scenarioResults.actualLessThanReserved = "PASS_120_FROM_200";
    scenarioResults.duplicateSettlement = "PASS_IDEMPOTENT_NO_CHANGE";
    scenarioResults.conflictingSettlement = "PASS_FAIL_CLOSED";
    await cleanupFixtureRun(runId);
  }

  // Actual usage may exceed the initial estimate; the ledger stores truth.
  {
    const scenario = "settlement-greater-than-reserved";
    const runId = await createFixtureRun(scenario);
    const admitted = await reserve(reservationArgs(runId, scenario, 1, generous(3, 1_000), 100));
    assert(admitted.allowed === true, "GREATER_SETTLEMENT_RESERVATION_NOT_ADMITTED");
    const reservationId = integer(admitted.reservationId, "GREATER_SETTLEMENT_RESERVATION_ID");
    assert(await callBooleanRpc("mark_agent_request_dispatched", reservationId, runId, requestDate), "GREATER_DISPATCH_MARKER_FAILED");
    const settlement = await settle(reservationId, runId, 100, 50);
    assert(settlement.changed === true && integer(settlement.accountedTokens, "GREATER_SETTLED_ACCOUNTED") === 150, "GREATER_SETTLEMENT_FAILED");
    const usage = await makeSnapshot(requestDate);
    assert(usage.groqTokens === before.groqTokens + 150, "GREATER_SETTLEMENT_NOT_CANONICAL");
    scenarioResults.actualGreaterThanReserved = "PASS_150_FROM_100";
    await cleanupFixtureRun(runId);
  }

  // Exact settlement checks sum equality, not a comparison against the estimate.
  {
    const scenario = "settlement-equal-reserved";
    const runId = await createFixtureRun(scenario);
    const admitted = await reserve(reservationArgs(runId, scenario, 1, generous(3, 1_000), 100));
    assert(admitted.allowed === true, "EQUAL_SETTLEMENT_RESERVATION_NOT_ADMITTED");
    const reservationId = integer(admitted.reservationId, "EQUAL_SETTLEMENT_RESERVATION_ID");
    assert(await callBooleanRpc("mark_agent_request_dispatched", reservationId, runId, requestDate), "EQUAL_DISPATCH_MARKER_FAILED");
    const settlement = await settle(reservationId, runId, 60, 40);
    assert(settlement.changed === true && integer(settlement.accountedTokens, "EQUAL_SETTLED_ACCOUNTED") === 100, "EQUAL_SETTLEMENT_FAILED");
    const usage = await makeSnapshot(requestDate);
    assert(usage.groqTokens === before.groqTokens + 100, "EQUAL_SETTLEMENT_NOT_CANONICAL");
    scenarioResults.actualEqualReserved = "PASS_100_FROM_100";
    await cleanupFixtureRun(runId);
  }

  // Unknown post-dispatch usage keeps the estimate fully counted.
  {
    const scenario = "post-dispatch-usage-unknown";
    const runId = await createFixtureRun(scenario);
    const estimate = 100;
    const admitted = await reserve(reservationArgs(runId, scenario, 1, generous(3, 1_000), estimate));
    assert(admitted.allowed === true, "UNKNOWN_USAGE_RESERVATION_NOT_ADMITTED");
    const reservationId = integer(admitted.reservationId, "UNKNOWN_USAGE_RESERVATION_ID");
    assert(await callBooleanRpc("mark_agent_request_dispatched", reservationId, runId, requestDate), "UNKNOWN_USAGE_DISPATCH_MARKER_FAILED");
    const { payload } = await reservationRow(reservationId, runId, scenario);
    assert(payload.tokenUsageState === "reserved_estimate" && payload.providerUnitUsageKnown === false, "UNKNOWN_USAGE_STATE_NOT_RETAINED");
    const usage = await makeSnapshot(requestDate);
    assert(usage.groqRequests === before.groqRequests + 1 && usage.groqTokens === before.groqTokens + estimate, "UNKNOWN_USAGE_ESTIMATE_NOT_ACCOUNTED");
    scenarioResults.unknownUsage = "PASS_ESTIMATE_RETAINED";
    await cleanupFixtureRun(runId);
  }
}

async function main(): Promise<void> {
  let runError: string | null = null;
  try {
    await run();
  } catch (error) {
    runError = error instanceof Error ? error.message.replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 120) : "UNKNOWN_VALIDATION_ERROR";
  } finally {
    try {
      await cleanup();
    } catch {
      cleanupStatus = "FAILED_UNEXPECTEDLY";
    }
  }

  let after: Snapshot | null = null;
  let baselineRestored = false;
  if (cleanupStatus === "COMPLETE_ZERO_RESIDUAL_ROWS" && preFixture) {
    try {
      after = await makeSnapshot(requestDate);
      baselineRestored = JSON.stringify(after) === JSON.stringify(preFixture);
      if (!baselineRestored && !runError) runError = "POST_CLEANUP_BASELINE_MISMATCH";
    } catch {
      if (!runError) runError = "POST_CLEANUP_BASELINE_READ_FAILED";
    }
  }

  const report = {
    projectIdentity: projectMatches ? "MATCH" : "NOT_CONFIRMED",
    utcPeriod: requestDate,
    validationNamespace,
    providerCalls: { groq: 0, cloudflare: 0, cerebras: 0, modelInference: 0 },
    preFixture,
    results: scenarioResults,
    cleanup: cleanupStatus,
    postCleanup: after,
    baselineRestored,
    failure: runError,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (runError || cleanupStatus !== "COMPLETE_ZERO_RESIDUAL_ROWS" || !baselineRestored) process.exitCode = 1;
}

await main();
