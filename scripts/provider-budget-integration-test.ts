import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import type { AgentRunMetadata } from "../lib/agents/runtime/runtime-types.ts";
import { buildAgentTelemetry } from "../lib/agents/runtime/telemetry.ts";

const db = createSupabaseServerClient();
const logger = new SupabaseAgentLogger(db);
const day = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.parse(`${day}T00:00:00Z`) - 60_000).toISOString();
const fixtureIds: string[] = [];
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
const metadata = (provider: "groq" | "cerebras"): AgentRunMetadata => ({ agentName: "provider-budget-integration", agentVersion: "fixture-v1", eventKey: null, provider, model: provider === "groq" ? "openai/gpt-oss-20b" : "gpt-oss-120b", dryRun: true });

async function fixtureRun(provider: "groq" | "cerebras"): Promise<{ id: string; meta: AgentRunMetadata }> {
  const meta = metadata(provider);
  const id = await logger.startRun(meta, new Date().toISOString());
  check(id, "FIXTURE_RUN_CREATE_FAILED");
  fixtureIds.push(id);
  return { id, meta };
}

const beforeGroq = await logger.getProviderDailyUsage("groq", day);
const beforeCerebras = await logger.getProviderDailyUsage("cerebras", day);
const beforeYesterday = await logger.getProviderDailyUsage("groq", yesterday.slice(0, 10));
try {
  const groqRun = await fixtureRun("groq");
  const cerebrasRun = await fixtureRun("cerebras");
  const groqReservation = await logger.reserveProviderRequest(groqRun.id, groqRun.meta, 1, beforeGroq.requestsReserved + 2, day, "groq");
  check(groqReservation.allowed && groqReservation.reservationId, "GROQ_RESERVE_FAILED");
  check(await logger.markRequestDispatched(groqRun.id, groqReservation.reservationId, day), "GROQ_DISPATCH_MARK_FAILED");
  check(!(await logger.releaseRequest(groqRun.id, groqReservation.reservationId, day)), "POST_DISPATCH_RELEASE_ALLOWED");
  const groqStats = await db.from("agent_runs").update({ stats: { telemetry: { provider: "groq", providerRequestsUsed: 1, inputTokens: 20, outputTokens: 4, totalTokens: 24, providerHttpStatus: 200 } } }).eq("id", groqRun.id);
  check(!groqStats.error, "GROQ_TELEMETRY_FIXTURE_FAILED");

  const cerebrasPreDispatch = await logger.reserveProviderRequest(cerebrasRun.id, cerebrasRun.meta, 1, beforeCerebras.requestsReserved + 1, day, "cerebras");
  check(cerebrasPreDispatch.allowed && cerebrasPreDispatch.reservationId, "CEREBRAS_RESERVE_FAILED");
  check(await logger.releaseRequest(cerebrasRun.id, cerebrasPreDispatch.reservationId, day), "PRE_DISPATCH_RELEASE_FAILED");
  const cerebrasReservation = await logger.reserveProviderRequest(cerebrasRun.id, cerebrasRun.meta, 1, beforeCerebras.requestsReserved + 1, day, "cerebras");
  check(cerebrasReservation.allowed && cerebrasReservation.reservationId, "CEREBRAS_RE_RESERVE_FAILED");
  check(await logger.markRequestDispatched(cerebrasRun.id, cerebrasReservation.reservationId, day), "CEREBRAS_DISPATCH_MARK_FAILED");
  const cerebrasStats = await db.from("agent_runs").update({ stats: { telemetry: { provider: "cerebras", providerRequestsUsed: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15, providerHttpStatus: 200 } } }).eq("id", cerebrasRun.id);
  check(!cerebrasStats.error, "CEREBRAS_TELEMETRY_FIXTURE_FAILED");

  const contenders = await Promise.all([fixtureRun("groq"), fixtureRun("groq")]);
  const races = await Promise.all(contenders.map((run) => logger.reserveProviderRequest(run.id, run.meta, 1, beforeGroq.requestsReserved + 2, day, "groq")));
  check(races.filter((result) => result.allowed).length === 1, "CONCURRENT_GROQ_HARD_CAP_FAILED");
  const accepted = races.findIndex((result) => result.allowed);
  check(accepted >= 0 && races[accepted].reservationId, "CONCURRENT_GROQ_RESERVATION_MISSING");
  check(await logger.markRequestDispatched(contenders[accepted].id, races[accepted].reservationId!, day), "CONCURRENT_GROQ_DISPATCH_FAILED");

  const legacyRun = await fixtureRun("groq");
  const scopedRun = await fixtureRun("groq");
  const mixed = await Promise.all([
    logger.reserveRequest(legacyRun.id, legacyRun.meta, 1, beforeGroq.requestsReserved + 3, day),
    logger.reserveProviderRequest(scopedRun.id, scopedRun.meta, 1, beforeGroq.requestsReserved + 3, day, "groq"),
  ]);
  check(mixed.filter((result) => result.allowed).length === 1, "MIXED_GROQ_RPC_HARD_CAP_FAILED");
  const mixedWinner = mixed[0].allowed ? legacyRun : scopedRun;
  const mixedReservation = mixed[0].allowed ? mixed[0] : mixed[1];
  check(mixedReservation.reservationId, "MIXED_GROQ_RESERVATION_MISSING");
  const mixedLog = await db.from("agent_logs").select("provider").eq("id", mixedReservation.reservationId).single();
  check(!mixedLog.error && mixedLog.data?.provider === "groq", "LEGACY_GROQ_RESERVATION_UNLABELED");
  check(await logger.markRequestDispatched(mixedWinner.id, mixedReservation.reservationId, day), "MIXED_GROQ_DISPATCH_FAILED");

  const cerebrasContenders = await Promise.all([fixtureRun("cerebras"), fixtureRun("cerebras")]);
  const cerebrasRaces = await Promise.all(cerebrasContenders.map((run) => logger.reserveProviderRequest(run.id, run.meta, 1, beforeCerebras.requestsReserved + 2, day, "cerebras")));
  check(cerebrasRaces.filter((result) => result.allowed).length === 1, "CONCURRENT_CEREBRAS_HARD_CAP_FAILED");
  const cerebrasAccepted = cerebrasRaces.findIndex((result) => result.allowed);
  check(cerebrasAccepted >= 0 && cerebrasRaces[cerebrasAccepted].reservationId, "CONCURRENT_CEREBRAS_RESERVATION_MISSING");
  check(await logger.markRequestDispatched(cerebrasContenders[cerebrasAccepted].id, cerebrasRaces[cerebrasAccepted].reservationId!, day), "CONCURRENT_CEREBRAS_DISPATCH_FAILED");

  const yesterdayLog = await db.from("agent_logs").insert({ run_id: groqRun.id, agent_name: "provider-budget-integration", step: "provider_request_reserved", level: "info", message: "UTC boundary fixture", provider: "groq", payload: { provider: "groq", providerRequestDispatched: false }, created_at: yesterday });
  check(!yesterdayLog.error, "UTC_BOUNDARY_INSERT_FAILED");
  const duringGroq = await logger.getProviderDailyUsage("groq", day);
  const duringCerebras = await logger.getProviderDailyUsage("cerebras", day);
  const duringYesterday = await logger.getProviderDailyUsage("groq", yesterday.slice(0, 10));
  check(duringGroq.requestsReserved === beforeGroq.requestsReserved + 3, "GROQ_SCOPE_COUNT_FAILED");
  check(duringCerebras.requestsReserved === beforeCerebras.requestsReserved + 2, "CEREBRAS_SCOPE_COUNT_FAILED");
  check(duringYesterday.requestsReserved === beforeYesterday.requestsReserved + 1, "UTC_RESET_SCOPE_FAILED");
  check(duringGroq.inputTokens >= beforeGroq.inputTokens + 20 && duringGroq.outputTokens >= beforeGroq.outputTokens + 4 && duringGroq.totalTokens >= beforeGroq.totalTokens + 24, "GROQ_DAILY_TOKEN_ACCOUNTING_FAILED");
  check(duringCerebras.inputTokens === beforeCerebras.inputTokens + 10 && duringCerebras.outputTokens === beforeCerebras.outputTokens + 5 && duringCerebras.totalTokens === beforeCerebras.totalTokens + 15, "CEREBRAS_DAILY_TOKEN_ACCOUNTING_FAILED");
  check(duringGroq.unknownTokenRequests >= 2 && !duringGroq.tokenUsageKnown, "UNKNOWN_TOKEN_CONSERVATISM_FAILED");
  const rateRun = await fixtureRun("groq");
  const observedAt = new Date().toISOString();
  const telemetry = buildAgentTelemetry({ status: "FREE_TIER_LIMIT_REACHED", model: "openai/gpt-oss-20b", agentVersion: "fixture-v1", config: { model: "openai/gpt-oss-20b", timeoutMs: 100, maxRetries: 0, retryBackoffMs: 0, maxOutputTokens: 1200, dailyRequestLimit: 20, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "strict_schema" }, diagnostics: { provider: "groq", httpStatus: 429, providerRequestDispatched: true, rateLimitHeaders: { retryAfter: "15", retryAfterSeconds: 15, limitRequests: null, remainingRequests: null, resetRequests: null, resetRequestsSeconds: null, limitTokens: null, remainingTokens: null, resetTokens: null, resetTokensSeconds: null } }, attempts: 1, providerRequestsUsed: 1, latencyMs: 1, startedAt: observedAt, finishedAt: observedAt });
  const rateUpdate = await db.from("agent_runs").update({ status: "failed", finished_at: observedAt, stats: { telemetry } }).eq("id", rateRun.id);
  check(!rateUpdate.error, "RATE_LIMIT_FIXTURE_FAILED");
  const state = await logger.getProviderRateLimitState("groq");
  check(state?.blockedUntil !== null && state?.blockedUntil !== undefined && Date.parse(state.blockedUntil) > Date.parse(observedAt), "PERSISTED_RATE_LIMIT_STATE_FAILED");
  console.log(JSON.stringify({ status: "PASS", groqIndependent: true, cerebrasIndependent: true, concurrentHardCap: true, mixedLegacyConcurrency: true, legacyGroqTagged: true, dispatchMarker: true, preDispatchRelease: true, postDispatchReleaseDenied: true, utcDaySeparated: true, dailyTokenTelemetry: true, unknownTokensConservative: true, persistedTemporaryBlock: true, providerCalls: 0 }));
} finally {
  for (const id of fixtureIds) {
    const deletion = await db.from("agent_runs").delete().eq("id", id);
    if (deletion.error) throw new Error("FIXTURE_CLEANUP_FAILED");
  }
  const afterGroq = await logger.getProviderDailyUsage("groq", day);
  const afterCerebras = await logger.getProviderDailyUsage("cerebras", day);
  const afterYesterday = await logger.getProviderDailyUsage("groq", yesterday.slice(0, 10));
  check(afterGroq.requestsReserved === beforeGroq.requestsReserved && afterCerebras.requestsReserved === beforeCerebras.requestsReserved && afterYesterday.requestsReserved === beforeYesterday.requestsReserved, "FIXTURE_RESERVATIONS_REMAIN");
}
