import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import type { AgentRunMetadata } from "../lib/agents/runtime/runtime-types.ts";

const db = createSupabaseServerClient();
const logger = new SupabaseAgentLogger(db);
const model = "@cf/openai/gpt-oss-20b" as const;
const allocation = Number(process.env.CLOUDFLARE_DAILY_NEURON_LIMIT);
const requestDate = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.parse(`${requestDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const runIds: string[] = [];
const metadata: AgentRunMetadata = {
  agentName: "cloudflare-accounting-fixture",
  agentVersion: "10g3-accounting-v1",
  eventKey: "synthetic-accounting-fixture",
  model,
  provider: "cloudflare_workers_ai",
  dryRun: true,
};

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

async function fixtureRun(): Promise<string> {
  const id = await logger.startRun(metadata, new Date().toISOString());
  check(id, "FIXTURE_RUN_CREATE_FAILED");
  runIds.push(id);
  return id;
}

function reserve(id: string, attempt: number, neurons: number, day = requestDate) {
  return logger.reserveCloudflareNeuronCapacity(id, metadata, attempt, null, day, allocation, neurons);
}

const baselineCloudflare = await logger.getProviderDailyUsage("cloudflare_workers_ai", requestDate);
const baselineGroq = await logger.getProviderDailyUsage("groq", requestDate);
const baselineCerebras = await logger.getProviderDailyUsage("cerebras", requestDate);
let failure: unknown;
let cleanupFailure = false;

try {
  check(Number.isSafeInteger(allocation) && allocation === 10_000, "CLOUDFLARE_DAILY_NEURON_LIMIT_INVALID");
  const remaining = allocation - (baselineCloudflare.neuronsUsed ?? 0);
  check(remaining >= 2, "INSUFFICIENT_CLOUDFLARE_NEURON_HEADROOM_FOR_FIXTURES");

  const firstRun = await fixtureRun();
  const secondRun = await fixtureRun();
  const competingEstimate = Math.floor(remaining / 2) + 1;
  const race = await Promise.all([
    reserve(firstRun, 1, competingEstimate),
    reserve(secondRun, 1, competingEstimate),
  ]);
  check(race.filter((result) => result.allowed).length === 1, "ATOMIC_NEURON_HARD_CAP_FAILED");
  check(race.filter((result) => !result.allowed).length === 1, "NEURON_CAP_DID_NOT_BLOCK_COMPETING_RESERVATION");
  const winnerIndex = race[0].allowed ? 0 : 1;
  const winnerRun = winnerIndex === 0 ? firstRun : secondRun;
  const reservation = race[winnerIndex];
  check(reservation.reservationId, "WINNING_RESERVATION_ID_MISSING");
  const duringRace = await logger.getProviderDailyUsage("cloudflare_workers_ai", requestDate);
  check(duringRace.requestsReserved === baselineCloudflare.requestsReserved + 1, "RACE_REQUEST_ACCOUNTING_FAILED");
  check(duringRace.neuronsUsed === (baselineCloudflare.neuronsUsed ?? 0) + competingEstimate, "RACE_NEURON_ACCOUNTING_FAILED");
  check((await logger.getProviderDailyUsage("groq", requestDate)).requestsReserved === baselineGroq.requestsReserved, "GROQ_ACCOUNTING_ISOLATION_FAILED");
  check((await logger.getProviderDailyUsage("cerebras", requestDate)).requestsReserved === baselineCerebras.requestsReserved, "CEREBRAS_ACCOUNTING_ISOLATION_FAILED");

  check(await logger.releaseRequest(winnerRun, reservation.reservationId, requestDate), "PRE_DISPATCH_RELEASE_FAILED");
  const afterRelease = await logger.getProviderDailyUsage("cloudflare_workers_ai", requestDate);
  check(afterRelease.requestsReserved === baselineCloudflare.requestsReserved, "PRE_DISPATCH_RELEASE_LEFT_REQUEST");
  check(afterRelease.neuronsUsed === baselineCloudflare.neuronsUsed, "PRE_DISPATCH_RELEASE_LEFT_NEURONS");

  const dispatched = await reserve(winnerRun, 2, 1);
  check(dispatched.allowed && dispatched.reservationId, "POST_DISPATCH_FIXTURE_RESERVATION_FAILED");
  check(await logger.markRequestDispatched(winnerRun, dispatched.reservationId, requestDate), "DISPATCH_MARK_FAILED");
  check(!(await logger.releaseRequest(winnerRun, dispatched.reservationId, requestDate)), "POST_DISPATCH_RESERVATION_WAS_RELEASED");

  let staleUtcRejected = false;
  try {
    await reserve(secondRun, 3, 1, yesterday);
  } catch {
    staleUtcRejected = true;
  }
  check(staleUtcRejected, "NON_CURRENT_UTC_DAY_RESERVATION_WAS_ACCEPTED");

  const afterDispatch = await logger.getProviderDailyUsage("cloudflare_workers_ai", requestDate);
  check(afterDispatch.requestsReserved === baselineCloudflare.requestsReserved + 1, "DISPATCHED_REQUEST_NOT_PERSISTED");
  check(afterDispatch.requestsDispatched === baselineCloudflare.requestsDispatched + 1, "DISPATCH_STATE_NOT_PERSISTED");
  check(afterDispatch.neuronsUsed === (baselineCloudflare.neuronsUsed ?? 0) + 1, "DISPATCHED_NEURON_RESERVATION_NOT_PERSISTED");

  console.log(JSON.stringify({
    status: "PASS",
    provider: "cloudflare_workers_ai",
    migrationBackedRpc: true,
    atomicNeuronHardCap: "PASS",
    providerIsolation: "PASS",
    preDispatchRelease: "PASS",
    postDispatchReleaseBlocked: "PASS",
    currentUtcDayAccepted: "PASS",
    nonCurrentUtcDayRejected: "PASS",
    concurrency: "PASS",
    fixtureRowsCleaned: true,
  }, null, 2));
} catch (error) {
  failure = error;
} finally {
  if (runIds.length > 0) {
    const logs = await db.from("agent_logs").delete().in("run_id", runIds);
    const runs = await db.from("agent_runs").delete().in("id", runIds);
    cleanupFailure = Boolean(logs.error || runs.error);
  }
}

if (cleanupFailure) throw new Error("CLOUDFLARE_ACCOUNTING_FIXTURE_CLEANUP_FAILED");
if (failure) throw failure;

const [finalCloudflare, finalGroq, finalCerebras] = await Promise.all([
  logger.getProviderDailyUsage("cloudflare_workers_ai", requestDate),
  logger.getProviderDailyUsage("groq", requestDate),
  logger.getProviderDailyUsage("cerebras", requestDate),
]);
check(finalCloudflare.requestsReserved === baselineCloudflare.requestsReserved, "CLOUDFLARE_FIXTURE_ROWS_REMAIN");
check(finalCloudflare.neuronsUsed === baselineCloudflare.neuronsUsed, "CLOUDFLARE_FIXTURE_NEURONS_REMAIN");
check(finalGroq.requestsReserved === baselineGroq.requestsReserved, "GROQ_FIXTURE_ROWS_REMAIN");
check(finalCerebras.requestsReserved === baselineCerebras.requestsReserved, "CEREBRAS_FIXTURE_ROWS_REMAIN");
