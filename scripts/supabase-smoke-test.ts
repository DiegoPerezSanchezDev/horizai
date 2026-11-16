import nextEnv from "@next/env";
import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { cleanupSmokeRun } from "../lib/agents/runtime/smoke-cleanup.ts";
import type { Database } from "../types/database";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const expectedCounts = {
  regions: 11,
  categories: 8,
  sources: 15,
} as const;

type QueryResult<T> = {
  data: T | null;
  error: PostgrestError | null;
};

type AgentRunRow = Database["public"]["Tables"]["agent_runs"]["Row"];
type AgentLogRow = Database["public"]["Tables"]["agent_logs"]["Row"];

const requestReservationSchema = z.object({
  allowed: z.boolean(),
  dailyCount: z.number().int().nonnegative(),
  dailyLimit: z.number().int().positive(),
  requestDate: z.string().date(),
  reservationId: z.number().int().positive(),
});

function getData<T>(result: QueryResult<T>, operation: string): NonNullable<T> {
  if (result.error) {
    throw new Error(`${operation}: ${result.error.message}`);
  }

  if (result.data === null) {
    throw new Error(`${operation}: no data returned`);
  }

  return result.data as NonNullable<T>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown smoke test error";
}

async function runSmokeTest() {
  const supabase = createSupabaseServerClient();
  const requestDate = new Date().toISOString().slice(0, 10);
  const dayStart = `${requestDate}T00:00:00.000Z`;
  const dayEnd = new Date(Date.parse(dayStart) + 86_400_000).toISOString();
  const beforeQuota = await supabase.from("agent_logs").select("id", { count: "exact", head: true }).eq("step", "provider_request_reserved").gte("created_at", dayStart).lt("created_at", dayEnd);
  if (beforeQuota.error || beforeQuota.count === null) throw new Error(`read quota before smoke: ${beforeQuota.error?.message ?? "unknown error"}`);
  let runId: string | null = null;
  let testError: unknown = null;
  const cleanupErrors: string[] = [];

  try {
    const regions = getData(
      await supabase.from("regions").select("*").order("code"),
      "read regions"
    );
    assert(regions.length === expectedCounts.regions, `expected ${expectedCounts.regions} regions, found ${regions.length}`);
    console.log(`PASS regions: ${regions.length}`);

    const categories = getData(
      await supabase.from("categories").select("*").order("slug"),
      "read categories"
    );
    assert(
      categories.length === expectedCounts.categories,
      `expected ${expectedCounts.categories} categories, found ${categories.length}`
    );
    console.log(`PASS categories: ${categories.length}`);

    const sources = getData(
      await supabase.from("sources").select("*").order("priority", { ascending: false }),
      "read sources"
    );
    assert(sources.length === expectedCounts.sources, `expected ${expectedCounts.sources} sources, found ${sources.length}`);
    console.log(`PASS sources: ${sources.length}`);

    const insertedRun = getData<AgentRunRow>(
      (await supabase
        .from("agent_runs")
        .insert({
          run_type: "other",
          status: "running",
          dry_run: true,
          config: { purpose: "supabase-smoke-test" },
          stats: {},
        })
        .select("*")
        .single()) as unknown as QueryResult<AgentRunRow>,
      "create temporary agent_run"
    );
    const activeRunId = insertedRun.id;
    runId = activeRunId;
    assert(insertedRun.run_type === "other", "temporary agent_run has an unexpected run_type");
    assert(insertedRun.status === "running", "temporary agent_run has an unexpected status");
    assert(insertedRun.dry_run === true, "temporary agent_run must be a dry run");
    console.log("PASS temporary agent_run created");

    const reservationResponse = await supabase.rpc("reserve_agent_request", {
      p_run_id: activeRunId,
      p_agent_name: "supabase-smoke-test",
      p_agent_version: "smoke-v1",
      p_event_key: "smoke-event",
      p_attempt: 1,
      p_model: "smoke-model",
      p_request_date: requestDate,
      p_limit: 20,
    });
    if (reservationResponse.error) throw new Error(`reserve temporary provider request: ${reservationResponse.error.message}`);
    const reservation = requestReservationSchema.parse(reservationResponse.data);
    assert(reservation.allowed, "temporary provider request should be allowed");
    console.log(`PASS persistent request reservation: ${reservation.dailyCount}/${reservation.dailyLimit}`);

    const insertedLog = getData<AgentLogRow>(
      (await supabase
        .from("agent_logs")
        .insert({
          run_id: activeRunId,
          agent_name: "supabase-smoke-test",
          step: "relationship-check",
          level: "info",
          message: "Temporary relationship check",
          payload: { smokeTest: true },
        })
        .select("*")
        .single()) as unknown as QueryResult<AgentLogRow>,
      "create temporary agent_log"
    );
    const activeLogId = insertedLog.id;
    assert(insertedLog.run_id === activeRunId, "agent_log is not associated with the temporary agent_run");
    assert(insertedLog.agent_name === "supabase-smoke-test", "agent_log has an unexpected agent_name");
    console.log("PASS temporary agent_log created and associated");

    const readRun = getData<AgentRunRow>(
      (await supabase.from("agent_runs").select("*").eq("id", activeRunId).single()) as unknown as QueryResult<AgentRunRow>,
      "read temporary agent_run"
    );
    assert(readRun.id === activeRunId, "read agent_run ID does not match");

    const readLog = getData<AgentLogRow>(
      (await supabase.from("agent_logs").select("*").eq("id", activeLogId).single()) as unknown as QueryResult<AgentLogRow>,
      "read temporary agent_log"
    );
    assert(readLog.run_id === readRun.id, "read agent_log relation does not match agent_run");
    console.log("PASS temporary records readable with valid relation");
  } catch (error) {
    testError = error;
  } finally {
    if (runId !== null) {
      cleanupErrors.push(...await cleanupSmokeRun(supabase, runId));
    }
  }

  if (testError) throw testError;
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));

  const afterQuota = await supabase.from("agent_logs").select("id", { count: "exact", head: true }).eq("step", "provider_request_reserved").gte("created_at", dayStart).lt("created_at", dayEnd);
  if (afterQuota.error || afterQuota.count === null) throw new Error(`read quota after smoke: ${afterQuota.error?.message ?? "unknown error"}`);
  assert(afterQuota.count === beforeQuota.count, `smoke test changed persisted quota (${beforeQuota.count} -> ${afterQuota.count})`);
  console.log(`PASS quota unchanged: ${beforeQuota.count}/${20}`);

  console.log("PASS temporary records removed; no smoke-test data remains");
  console.log("Supabase smoke test completed successfully");
}

runSmokeTest().catch((error: unknown) => {
  console.error(`Supabase smoke test failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});
