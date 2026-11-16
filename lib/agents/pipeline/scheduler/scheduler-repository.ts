import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../../../types/database.ts";
import { createSupabaseServerClient } from "../../../supabase/server-client.ts";
import { persistedSchedulerTerminal } from "./scheduler-terminal-contract.ts";

type SchedulerSupabase = SupabaseClient<Database>;

const rpcResultSchema = z.object({
  status: z.enum(["acquired", "expired", "busy", "duplicate"]),
  runId: z.string().uuid(),
  ownerRunId: z.string().uuid(),
  triggerId: z.string().min(1),
  expiresAt: z.string().optional(),
  runStatus: z.string().optional(),
});

export type PersistentSchedulerAcquireInput = {
  triggerId: string;
  ownerRunId: string;
  invocationType: "scheduled" | "manual" | "preflight";
  scheduleDateUtc: string;
  slot: "morning" | "afternoon" | "night";
  schedulingTimezone: string;
  scheduledAt: string;
  requestDateUtc: string;
  now: string;
  expiresAt: string;
  quotaUsed: number;
  quotaRemaining: number;
  maxEventsPerRun: number;
  automaticRevision: false;
  dryRun: true;
  publish: false;
};

export type PersistentSchedulerAcquireResult = z.infer<typeof rpcResultSchema>;

export class SupabaseSchedulerRepository {
  private readonly supabase: SchedulerSupabase;

  constructor(supabase: SchedulerSupabase = createSupabaseServerClient()) {
    this.supabase = supabase;
  }

  async acquire(input: PersistentSchedulerAcquireInput): Promise<PersistentSchedulerAcquireResult> {
    const { data, error } = await this.supabase.rpc("acquire_scheduler_run", {
      p_trigger_id: input.triggerId,
      p_owner_run_id: input.ownerRunId,
      p_invocation_type: input.invocationType,
      p_schedule_date_utc: input.scheduleDateUtc,
      p_slot: input.slot,
      p_scheduling_timezone: input.schedulingTimezone,
      p_scheduled_at: input.scheduledAt,
      p_request_date_utc: input.requestDateUtc,
      p_now: input.now,
      p_expires_at: input.expiresAt,
      p_quota_used: input.quotaUsed,
      p_quota_remaining: input.quotaRemaining,
      p_max_events_per_run: input.maxEventsPerRun,
      p_automatic_revision: input.automaticRevision,
      p_dry_run: input.dryRun,
      p_publish: input.publish,
    });
    if (error) throw new Error("Scheduler lease acquisition failed");
    const parsed = rpcResultSchema.safeParse(data);
    if (!parsed.success) throw new Error("Scheduler lease acquisition returned an invalid result");
    return parsed.data;
  }

  async finish(input: { triggerId: string; ownerRunId: string; runStatus: "succeeded" | "failed" | "blocked"; finalDecision: "allowed" | "blocked" | "failed"; stopReason: string | null; quotaUsed: number; quotaRemaining: number; finishedAt: string }): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("finish_scheduler_run", {
      p_trigger_id: input.triggerId,
      p_owner_run_id: input.ownerRunId,
      p_run_status: input.runStatus,
      p_final_decision: input.finalDecision,
      p_stop_reason: input.stopReason,
      p_quota_used: input.quotaUsed,
      p_quota_remaining: input.quotaRemaining,
      p_finished_at: input.finishedAt,
    });
    if (error) throw new Error("Scheduler run finalization failed");
    return data === true;
  }

  async finishExecution(input: { triggerId: string; ownerRunId: string; runStatus: "succeeded" | "failed" | "blocked"; finalDecision: "allowed" | "blocked" | "failed"; schedulerDecision: string; stopReason: string | null; pipelineRunId: string | null; eventAttempts: number; eventFinalStates: Json; requestsUsed: number; quotaUsed: number; quotaRemaining: number; durationMs: number; finishedAt: string }): Promise<boolean> {
    const terminal = persistedSchedulerTerminal({ schedulerDecision: input.schedulerDecision, stopReason: input.stopReason });
    const { data, error } = await this.supabase.rpc("finish_scheduler_run_execution", {
      p_trigger_id: input.triggerId,
      p_owner_run_id: input.ownerRunId,
      p_run_status: input.runStatus,
      p_final_decision: input.finalDecision,
      p_scheduler_decision: terminal.schedulerDecision,
      p_stop_reason: terminal.stopReason,
      p_pipeline_run_id: input.pipelineRunId,
      p_event_attempts: input.eventAttempts,
      p_event_final_states: input.eventFinalStates,
      p_requests_used: input.requestsUsed,
      p_quota_used: input.quotaUsed,
      p_quota_remaining: input.quotaRemaining,
      p_duration_ms: input.durationMs,
      p_finished_at: input.finishedAt,
    });
    if (error) throw new Error("Scheduler execution finalization failed");
    return data === true;
  }

  async release(input: { triggerId: string; ownerRunId: string; releasedAt: string }): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("release_scheduler_lease", {
      p_trigger_id: input.triggerId,
      p_owner_run_id: input.ownerRunId,
      p_released_at: input.releasedAt,
    });
    if (error) throw new Error("Scheduler lease release failed");
    return data === true;
  }

  async get(triggerId: string): Promise<Database["public"]["Tables"]["scheduler_runs"]["Row"] | null> {
    const { data, error } = await this.supabase.from("scheduler_runs").select("*").eq("trigger_id", triggerId).maybeSingle();
    if (error) throw new Error("Scheduler run lookup failed");
    return data;
  }

  async deleteTestTrigger(prefix: string): Promise<void> {
    const { error } = await this.supabase.from("scheduler_runs").delete().like("trigger_id", `${prefix}%`);
    if (error) throw new Error("Scheduler test cleanup failed");
  }

  static safePayload(input: PersistentSchedulerAcquireResult): Json {
    return { status: input.status, triggerId: input.triggerId, runId: input.runId, ownerRunId: input.ownerRunId };
  }
}
