import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/database.ts";

type SmokeSupabaseClient = SupabaseClient<Database>;

/** Removes only rows belonging to the run created by the current smoke test. */
export async function cleanupSmokeRun(supabase: SmokeSupabaseClient, runId: string): Promise<string[]> {
  const errors: string[] = [];

  const logsDelete = await supabase.from("agent_logs").delete().eq("run_id", runId);
  if (logsDelete.error) errors.push(`delete temporary agent_logs: ${logsDelete.error.message}`);

  const runDelete = await supabase.from("agent_runs").delete().eq("id", runId);
  if (runDelete.error) errors.push(`delete temporary agent_run: ${runDelete.error.message}`);

  const remainingLogs = await supabase.from("agent_logs").select("id").eq("run_id", runId);
  if (remainingLogs.error) errors.push(`verify temporary agent_logs cleanup: ${remainingLogs.error.message}`);
  else if ((remainingLogs.data ?? []).length !== 0) errors.push("temporary agent_logs remain after cleanup");

  const remainingRuns = await supabase.from("agent_runs").select("id").eq("id", runId);
  if (remainingRuns.error) errors.push(`verify temporary agent_run cleanup: ${remainingRuns.error.message}`);
  else if ((remainingRuns.data ?? []).length !== 0) errors.push("temporary agent_run remains after cleanup");

  return errors;
}
