import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../../types/database.ts";
import { createSupabaseServerClient } from "../../../supabase/server-client.ts";
import { SCHEDULER_WORKER_LEASE_TTL_SECONDS, type OpenSupervisedAttempt, type SchedulerKickoffMetadata } from "./scheduler-control-policy.ts";

const claimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ACQUIRED"), invocationId: z.string(), triggerId: z.string(), ownerId: z.string().uuid(), fencingToken: z.number().int().positive(), expiresAt: z.string() }),
  z.object({ status: z.literal("ALREADY_RUNNING"), invocationId: z.string().optional(), fencingToken: z.number().int().nonnegative().optional(), expiresAt: z.string().optional() }),
  z.object({ status: z.literal("DAILY_TRIGGER_ALREADY_CLAIMED"), invocationId: z.string(), triggerId: z.string(), runStatus: z.string() }),
]);

const openAttemptSchema = z.object({
  attemptId: z.string().uuid(), eventKey: z.string().min(1), pipelineRunId: z.string().uuid(), attemptNumber: z.number().int().positive(),
  startedAt: z.string(), completedAt: z.string().nullable(), finalState: z.string().nullable(), stopStage: z.string().nullable(),
  stopReason: z.string().nullable(), retryClass: z.string().nullable(), countsTowardRetryLimit: z.boolean(), nextEligibleAt: z.string().nullable(),
  capacityResumeSnapshot: z.unknown().nullable(), resumeDispatchCount: z.number().int().nonnegative(), resumeCheckpointPresent: z.boolean().nullable(),
});

export type SchedulerControlClaim = z.infer<typeof claimSchema>;
export type SchedulerControlFinish = {
  invocationId: string; ownerId: string; fencingToken: number; status: "COMPLETED" | "STOPPED" | "FAILED"; outcomeCode: string;
  workMode: "RESUME_SAME_ATTEMPT" | "NEW_CANDIDATE" | null; attemptId: string | null; currentStage: string | null;
  resumeGeneration: number | null; requestsUsed: number; requestsRemaining: number | null; durationMs: number; now?: Date;
};

export class SupabaseSchedulerControlRepository {
  private readonly supabase: SupabaseClient<Database>;
  constructor(supabase: SupabaseClient<Database> = createSupabaseServerClient()) { this.supabase = supabase; }

  async claim(input: { metadata: SchedulerKickoffMetadata; ownerId: string; now: Date }): Promise<SchedulerControlClaim> {
    const { data, error } = await this.supabase.rpc("claim_supervised_scheduler_invocation_m40", {
      p_utc_day: input.metadata.utcDate, p_trigger_id: input.metadata.triggerId, p_invocation_id: input.metadata.invocationId,
      p_owner_id: input.ownerId, p_now: input.now.toISOString(), p_lease_ttl_seconds: SCHEDULER_WORKER_LEASE_TTL_SECONDS,
    });
    if (error) throw new Error("SCHEDULER_CONTROL_CLAIM_FAILED");
    const parsed = claimSchema.safeParse(data);
    if (!parsed.success) throw new Error("SCHEDULER_CONTROL_CLAIM_RESPONSE_INVALID");
    return parsed.data;
  }

  async listOpenAttempts(): Promise<OpenSupervisedAttempt[]> {
    const { data, error } = await this.supabase.rpc("list_open_supervised_scheduler_attempts_m40");
    if (error) throw new Error("SCHEDULER_OPEN_ATTEMPT_READ_FAILED");
    const parsed = z.array(openAttemptSchema).safeParse(data);
    if (!parsed.success) throw new Error("SCHEDULER_OPEN_ATTEMPT_RESPONSE_INVALID");
    return parsed.data;
  }

  async finish(input: SchedulerControlFinish): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("finish_supervised_scheduler_invocation_m40", {
      p_invocation_id: input.invocationId, p_owner_id: input.ownerId, p_fencing_token: input.fencingToken,
      p_status: input.status, p_outcome_code: input.outcomeCode, p_work_mode: input.workMode,
      p_attempt_id: input.attemptId, p_current_stage: input.currentStage, p_resume_generation: input.resumeGeneration,
      p_requests_used: input.requestsUsed, p_requests_remaining: input.requestsRemaining, p_duration_ms: input.durationMs,
      p_now: (input.now ?? new Date()).toISOString(),
    });
    if (error) throw new Error("SCHEDULER_CONTROL_FINALIZE_FAILED");
    return data === true;
  }

  async heartbeat(input: { invocationId: string; ownerId: string; fencingToken: number; now?: Date }): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("heartbeat_supervised_scheduler_lease_m40", {
      p_invocation_id: input.invocationId, p_owner_id: input.ownerId, p_fencing_token: input.fencingToken,
      p_now: (input.now ?? new Date()).toISOString(), p_lease_ttl_seconds: SCHEDULER_WORKER_LEASE_TTL_SECONDS,
    });
    if (error) throw new Error("SCHEDULER_CONTROL_HEARTBEAT_FAILED");
    return data === true;
  }
}
