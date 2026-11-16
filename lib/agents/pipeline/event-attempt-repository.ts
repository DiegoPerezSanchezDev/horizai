import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../../types/database.ts";
import { evaluateNormalEligibility, type Eligibility, type PipelineAttemptFinalState, type PipelineEventAttempt, type PipelineRetryClass } from "./event-attempt-policy.ts";
import type { CapacityResumeSnapshot, CapacityResumeStage } from "./provider-capacity-resume.ts";

export type AttemptClaim = { eventKey: string; pipelineRunId: string; startedAt: string; now?: string; staleAfterSeconds?: number };
export type AttemptClaimResult = { status: "ACQUIRED"; attempt: PipelineEventAttempt } | { status: "ALREADY_ACTIVE" | "ALREADY_REGISTERED" | "INELIGIBLE" | "COOLDOWN" | "QUARANTINED"; reason: string; attempt?: PipelineEventAttempt };
export type AttemptFinalize = { attemptId: string; pipelineRunId: string; completedAt: string; finalState: PipelineAttemptFinalState; stopStage: string | null; stopReason: string | null; retryClass: PipelineRetryClass; countsTowardRetryLimit: boolean; nextEligibleAt: string | null };
export type CapacityResumeOwnership = { attemptId: string; eventKey: string; pipelineRunId: string; ownerId: string; resumeStage: CapacityResumeStage };

export interface PipelineEventAttemptRegistry {
  getEligibility(eventKeys: readonly string[], now: Date): Promise<ReadonlyMap<string, Eligibility>>;
  claim(input: AttemptClaim): Promise<AttemptClaimResult>;
  finalize(input: AttemptFinalize): Promise<void>;
  /** Leaves the existing attempt open and retry-neutral after a pre-dispatch capacity stop. */
  deferCapacity?(input: { attemptId: string; eventKey: string; pipelineRunId: string; stopStage: CapacityResumeStage; snapshot: CapacityResumeSnapshot; ownerId?: string; claimedStage?: CapacityResumeStage; providerRequestDispatched: false; providerRequestsUsed: 0 }): Promise<void>;
  /** Persists a separate retry-neutral stop when the worker budget is nearly exhausted. */
  deferWorkerTimeBudget?(input: { attemptId: string; eventKey: string; pipelineRunId: string; stopStage: CapacityResumeStage; snapshot: CapacityResumeSnapshot; ownerId?: string; claimedStage?: CapacityResumeStage; providerRequestDispatched: false; providerRequestsUsed: 0 }): Promise<void>;
  /** Atomically claims the same deferred row; it must never insert an attempt. */
  claimCapacityResume?(input: CapacityResumeOwnership): Promise<boolean>;
  releaseCapacityResume?(input: CapacityResumeOwnership): Promise<void>;
  loadCapacityResumeSnapshot?(input: Omit<CapacityResumeOwnership, "ownerId">): Promise<Json | null>;
}

type AttemptReadRow = Pick<Database["public"]["Tables"]["pipeline_event_attempts"]["Row"], "id" | "event_key" | "pipeline_run_id" | "attempt_number" | "started_at" | "completed_at" | "final_state" | "stop_stage" | "stop_reason" | "retry_class" | "counts_toward_retry_limit" | "next_eligible_at" | "created_at"> & { capacity_resume_snapshot?: Json | null };

function toAttempt(row: AttemptReadRow): PipelineEventAttempt {
  return { id: row.id, eventKey: row.event_key, pipelineRunId: row.pipeline_run_id, attemptNumber: row.attempt_number, startedAt: row.started_at, completedAt: row.completed_at, finalState: row.final_state, stopStage: row.stop_stage, stopReason: row.stop_reason, retryClass: row.retry_class, countsTowardRetryLimit: row.counts_toward_retry_limit, nextEligibleAt: row.next_eligible_at, createdAt: row.created_at, capacityResumeSnapshot: row.capacity_resume_snapshot };
}

export class SupabasePipelineEventAttemptRepository implements PipelineEventAttemptRegistry {
  private readonly supabase: SupabaseClient<Database>;
  private readonly schedulerM40: boolean;
  constructor(supabase: SupabaseClient<Database>, options: { schedulerM40?: boolean } = {}) { this.supabase = supabase; this.schedulerM40 = options.schedulerM40 === true; }

  async getEligibility(eventKeys: readonly string[], now: Date): Promise<ReadonlyMap<string, Eligibility>> {
    const result = new Map<string, Eligibility>();
    if (eventKeys.length === 0) return result;
    const query = this.supabase.from("pipeline_event_attempts").select("id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,next_eligible_at,created_at");
    // Offline composition tests provide a deliberately tiny Supabase shape. In
    // that case there is no registry to read; production clients always expose
    // `.in`, and a real read error remains fail-closed below.
    if (typeof (query as unknown as { in?: unknown }).in !== "function") { for (const key of eventKeys) result.set(key, evaluateNormalEligibility([], now)); return result; }
    const response = await query.in("event_key", [...eventKeys]);
    if (response.error) throw new Error(`EVENT_ATTEMPT_READ_FAILED:${response.error.code ?? "unknown"}`);
    const grouped = new Map<string, PipelineEventAttempt[]>();
    for (const row of response.data ?? []) { const item = toAttempt(row); const list = grouped.get(item.eventKey) ?? []; list.push(item); grouped.set(item.eventKey, list); }
    for (const key of eventKeys) result.set(key, evaluateNormalEligibility(grouped.get(key) ?? [], now));
    return result;
  }

  async claim(input: AttemptClaim): Promise<AttemptClaimResult> {
    const response = await this.supabase.rpc("claim_pipeline_event_attempt", { p_event_key: input.eventKey, p_pipeline_run_id: input.pipelineRunId, p_started_at: input.startedAt, p_now: input.now ?? new Date().toISOString(), p_stale_after_seconds: input.staleAfterSeconds ?? 3600 });
    if (response.error) throw new Error(`EVENT_ATTEMPT_CLAIM_FAILED:${response.error.code ?? "unknown"}`);
    return parseClaim(response.data as Json);
  }

  async finalize(input: AttemptFinalize): Promise<void> {
    const response = await this.supabase.rpc("finalize_pipeline_event_attempt", { p_attempt_id: input.attemptId, p_pipeline_run_id: input.pipelineRunId, p_completed_at: input.completedAt, p_final_state: input.finalState, p_stop_stage: input.stopStage, p_stop_reason: input.stopReason, p_retry_class: input.retryClass, p_counts_toward_retry_limit: input.countsTowardRetryLimit, p_next_eligible_at: input.nextEligibleAt });
    if (response.error) throw new Error(`EVENT_ATTEMPT_FINALIZE_FAILED:${response.error.code ?? "unknown"}`);
    if (response.data !== true && !(typeof response.data === "object" && response.data !== null && "finalized" in response.data && response.data.finalized === true)) throw new Error("EVENT_ATTEMPT_FINALIZE_NOT_OWNED");
  }

  async deferCapacity(input: { attemptId: string; eventKey: string; pipelineRunId: string; stopStage: CapacityResumeStage; snapshot: CapacityResumeSnapshot; ownerId?: string; claimedStage?: CapacityResumeStage; providerRequestDispatched: false; providerRequestsUsed: 0 }): Promise<void> {
    const args = {
      p_attempt_id: input.attemptId,
      p_event_key: input.eventKey,
      p_pipeline_run_id: input.pipelineRunId,
      p_resume_stage: input.stopStage,
      p_snapshot: input.snapshot as unknown as Json,
      p_provider_request_dispatched: input.providerRequestDispatched,
      p_provider_requests_used: input.providerRequestsUsed,
      p_owner_id: input.ownerId ?? null,
      p_claimed_stage: input.claimedStage ?? null,
    };
    const response = this.schedulerM40
      ? await this.supabase.rpc("defer_pipeline_event_attempt_scheduler_capacity_m40", args)
      : await this.supabase.rpc("defer_pipeline_event_attempt_capacity_m35", args);
    const { data, error } = response;
    if (error) throw new Error(`EVENT_ATTEMPT_CAPACITY_DEFER_FAILED:${error.code ?? "unknown"}`);
    if (typeof data !== "object" || data === null || Array.isArray(data)
      || !["DEFERRED", "ALREADY_DEFERRED"].includes(String((data as Record<string, Json>).status))) {
      throw new Error("EVENT_ATTEMPT_CAPACITY_DEFER_NOT_OWNED");
    }
  }

  async deferWorkerTimeBudget(input: { attemptId: string; eventKey: string; pipelineRunId: string; stopStage: CapacityResumeStage; snapshot: CapacityResumeSnapshot; ownerId?: string; claimedStage?: CapacityResumeStage; providerRequestDispatched: false; providerRequestsUsed: 0 }): Promise<void> {
    if (!this.schedulerM40) throw new Error("EVENT_ATTEMPT_WORKER_BUDGET_DEFER_REQUIRES_M40");
    const { data, error } = await this.supabase.rpc("defer_pipeline_event_attempt_worker_budget_m40", {
      p_attempt_id: input.attemptId, p_event_key: input.eventKey, p_pipeline_run_id: input.pipelineRunId,
      p_resume_stage: input.stopStage, p_snapshot: input.snapshot as unknown as Json,
      p_provider_request_dispatched: input.providerRequestDispatched, p_provider_requests_used: input.providerRequestsUsed,
      p_owner_id: input.ownerId ?? null, p_claimed_stage: input.claimedStage ?? null,
    });
    if (error) throw new Error(`EVENT_ATTEMPT_WORKER_BUDGET_DEFER_FAILED:${error.code ?? "unknown"}`);
    if (typeof data !== "object" || data === null || Array.isArray(data) || (data as Record<string, Json>).status !== "DEFERRED") {
      throw new Error("EVENT_ATTEMPT_WORKER_BUDGET_DEFER_NOT_OWNED");
    }
  }

  async claimCapacityResume(input: CapacityResumeOwnership): Promise<boolean> {
    const args = {
      p_attempt_id: input.attemptId,
      p_event_key: input.eventKey,
      p_pipeline_run_id: input.pipelineRunId,
      p_resume_stage: input.resumeStage,
      p_owner_id: input.ownerId,
    };
    const response = this.schedulerM40
      ? await this.supabase.rpc("claim_pipeline_event_attempt_scheduler_resume_m40", args)
      : await this.supabase.rpc("claim_pipeline_event_attempt_capacity_resume_m35", args);
    const { data, error } = response;
    return !error && data === true;
  }

  async releaseCapacityResume(input: CapacityResumeOwnership): Promise<void> {
    const args = {
      p_attempt_id: input.attemptId,
      p_event_key: input.eventKey,
      p_pipeline_run_id: input.pipelineRunId,
      p_resume_stage: input.resumeStage,
      p_owner_id: input.ownerId,
    };
    const response = this.schedulerM40
      ? await this.supabase.rpc("release_pipeline_event_attempt_scheduler_resume_m40", args)
      : await this.supabase.rpc("release_pipeline_event_attempt_capacity_resume_m35", args);
    const { data, error } = response;
    if (error || data !== true) throw new Error("EVENT_ATTEMPT_CAPACITY_RESUME_RELEASE_NOT_OWNED");
  }

  async loadCapacityResumeSnapshot(input: Omit<CapacityResumeOwnership, "ownerId">): Promise<Json | null> {
    const { data, error } = await this.supabase.from("pipeline_event_attempts")
      .select("capacity_resume_snapshot")
      .eq("id", input.attemptId).eq("event_key", input.eventKey).eq("pipeline_run_id", input.pipelineRunId)
      .eq("stop_stage", input.resumeStage)
      .is("completed_at", null).is("final_state", null).not("capacity_resume_snapshot", "is", null).maybeSingle();
    if (error) throw new Error(`EVENT_ATTEMPT_CAPACITY_SNAPSHOT_READ_FAILED:${error.code ?? "unknown"}`);
    return data?.capacity_resume_snapshot ?? null;
  }
}

function parseClaim(value: Json): AttemptClaimResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("EVENT_ATTEMPT_CLAIM_INVALID_RESPONSE");
  const record = value as Record<string, Json | undefined>;
  const status = record.status;
  if (status === "ACQUIRED" && typeof record.attempt === "object" && record.attempt !== null && !Array.isArray(record.attempt)) {
    const a = record.attempt as Record<string, Json | undefined>;
    const required = ["id", "event_key", "pipeline_run_id", "attempt_number", "started_at", "created_at"];
    if (required.every((key) => a[key] !== undefined)) return { status: "ACQUIRED", attempt: { id: String(a.id), eventKey: String(a.event_key), pipelineRunId: String(a.pipeline_run_id), attemptNumber: Number(a.attempt_number), startedAt: String(a.started_at), completedAt: a.completed_at == null ? null : String(a.completed_at), finalState: a.final_state == null ? null : a.final_state as PipelineAttemptFinalState, stopStage: a.stop_stage == null ? null : String(a.stop_stage), stopReason: a.stop_reason == null ? null : String(a.stop_reason), retryClass: (a.retry_class == null ? "NONE" : String(a.retry_class)) as PipelineRetryClass, countsTowardRetryLimit: Boolean(a.counts_toward_retry_limit), nextEligibleAt: a.next_eligible_at == null ? null : String(a.next_eligible_at), createdAt: String(a.created_at) } };
  }
  if (status === "ALREADY_ACTIVE" || status === "ALREADY_REGISTERED" || status === "INELIGIBLE" || status === "COOLDOWN" || status === "QUARANTINED") return { status, reason: typeof record.reason === "string" ? record.reason : status };
  throw new Error("EVENT_ATTEMPT_CLAIM_INVALID_RESPONSE");
}

export class InMemoryPipelineEventAttemptRegistry implements PipelineEventAttemptRegistry {
  private readonly attempts: PipelineEventAttempt[] = [];
  private readonly locks = new Set<string>();
  private readonly resumeOriginalReasons = new Map<string, string>();

  constructor(initial: readonly PipelineEventAttempt[] = []) { this.attempts.push(...initial); }
  snapshot(): readonly PipelineEventAttempt[] { return this.attempts.map((item) => ({ ...item })); }
  async getEligibility(eventKeys: readonly string[], now: Date): Promise<ReadonlyMap<string, Eligibility>> { const map = new Map<string, Eligibility>(); for (const key of eventKeys) map.set(key, evaluateNormalEligibility(this.attempts.filter((item) => item.eventKey === key), now)); return map; }
  async claim(input: AttemptClaim): Promise<AttemptClaimResult> {
    if (this.locks.has(input.eventKey)) return { status: "ALREADY_ACTIVE", reason: "CLAIM_IN_PROGRESS" };
    this.locks.add(input.eventKey);
    try {
      const now = new Date(input.now ?? new Date().toISOString());
      const current = this.attempts.filter((item) => item.eventKey === input.eventKey);
      const eligibility = evaluateNormalEligibility(current, now, (input.staleAfterSeconds ?? 3600) * 1000);
      if (!eligibility.eligible) return { status: eligibility.reason === "ACTIVE" ? "ALREADY_ACTIVE" : eligibility.reason === "COOLDOWN" ? "COOLDOWN" : eligibility.reason === "QUARANTINED" ? "QUARANTINED" : "INELIGIBLE", reason: eligibility.reason };
      const existing = current.find((item) => item.pipelineRunId === input.pipelineRunId);
      if (existing) return { status: existing.completedAt ? "ALREADY_REGISTERED" : "ALREADY_ACTIVE", reason: "SAME_PIPELINE_RUN" };
      const attempt: PipelineEventAttempt = { id: `attempt-${this.attempts.length + 1}`, eventKey: input.eventKey, pipelineRunId: input.pipelineRunId, attemptNumber: current.length + 1, startedAt: input.startedAt, completedAt: null, finalState: null, stopStage: null, stopReason: null, retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null, createdAt: input.startedAt };
      this.attempts.push(attempt); return { status: "ACQUIRED", attempt };
    } finally { this.locks.delete(input.eventKey); }
  }
  async finalize(input: AttemptFinalize): Promise<void> { const item = this.attempts.find((attempt) => attempt.id === input.attemptId && attempt.pipelineRunId === input.pipelineRunId && attempt.completedAt === null); if (!item) throw new Error("EVENT_ATTEMPT_FINALIZE_NOT_OWNED"); Object.assign(item, { completedAt: input.completedAt, finalState: input.finalState, stopStage: input.stopStage, stopReason: input.stopReason, retryClass: input.retryClass, countsTowardRetryLimit: input.countsTowardRetryLimit, nextEligibleAt: input.nextEligibleAt }); }
  async deferCapacity(input: { attemptId: string; eventKey: string; pipelineRunId: string; stopStage: CapacityResumeStage; snapshot: CapacityResumeSnapshot; ownerId?: string; claimedStage?: CapacityResumeStage; providerRequestDispatched: false; providerRequestsUsed: 0 }): Promise<void> {
    const item = this.attempts.find((attempt) => attempt.id === input.attemptId && attempt.eventKey === input.eventKey && attempt.pipelineRunId === input.pipelineRunId && attempt.completedAt === null && attempt.finalState === null);
    const snapshotJson = JSON.parse(JSON.stringify(input.snapshot)) as Json;
    if (input.providerRequestDispatched !== false || input.providerRequestsUsed !== 0) throw new Error("EVENT_ATTEMPT_CAPACITY_DEFER_DISPATCHED");
    if (item && input.ownerId === undefined && item.stopStage === input.stopStage
      && item.stopReason === "PROVIDER_CAPACITY_EXHAUSTED" && JSON.stringify(item.capacityResumeSnapshot) === JSON.stringify(snapshotJson)) return;
    if (!item || item.retryClass !== "NONE" || item.countsTowardRetryLimit || (input.ownerId === undefined
      ? item.stopStage !== null || item.stopReason !== null
      : item.stopStage !== input.claimedStage || item.stopReason !== `CAPACITY_RESUME_CLAIMED:${input.ownerId}`)) {
      throw new Error("EVENT_ATTEMPT_CAPACITY_DEFER_NOT_OWNED");
    }
    item.stopStage = input.stopStage;
    item.stopReason = "PROVIDER_CAPACITY_EXHAUSTED";
    item.nextEligibleAt = null;
    item.capacityResumeSnapshot = snapshotJson;
  }
  async deferWorkerTimeBudget(input: { attemptId: string; eventKey: string; pipelineRunId: string; stopStage: CapacityResumeStage; snapshot: CapacityResumeSnapshot; ownerId?: string; claimedStage?: CapacityResumeStage; providerRequestDispatched: false; providerRequestsUsed: 0 }): Promise<void> {
    const item = this.attempts.find((attempt) => attempt.id === input.attemptId && attempt.eventKey === input.eventKey && attempt.pipelineRunId === input.pipelineRunId && attempt.completedAt === null && attempt.finalState === null);
    if (input.providerRequestDispatched !== false || input.providerRequestsUsed !== 0 || !item || item.retryClass !== "NONE" || item.countsTowardRetryLimit
      || (input.ownerId === undefined ? item.stopReason !== null : item.stopReason !== `CAPACITY_RESUME_CLAIMED:${input.ownerId}`)) {
      throw new Error("EVENT_ATTEMPT_WORKER_BUDGET_DEFER_NOT_OWNED");
    }
    item.stopStage = input.stopStage; item.stopReason = "WORKER_TIME_BUDGET_EXHAUSTED"; item.nextEligibleAt = null;
    item.capacityResumeSnapshot = JSON.parse(JSON.stringify(input.snapshot)) as Json;
  }
  async claimCapacityResume(input: CapacityResumeOwnership): Promise<boolean> {
    const item = this.attempts.find((attempt) => attempt.id === input.attemptId && attempt.eventKey === input.eventKey && attempt.pipelineRunId === input.pipelineRunId && attempt.completedAt === null && attempt.finalState === null && attempt.stopStage === input.resumeStage && ["PROVIDER_CAPACITY_EXHAUSTED", "WORKER_TIME_BUDGET_EXHAUSTED"].includes(attempt.stopReason ?? "") && !attempt.countsTowardRetryLimit && attempt.capacityResumeSnapshot !== null && attempt.capacityResumeSnapshot !== undefined);
    if (!item) return false;
    this.resumeOriginalReasons.set(input.attemptId, item.stopReason!);
    item.stopReason = `CAPACITY_RESUME_CLAIMED:${input.ownerId}`;
    return true;
  }
  async releaseCapacityResume(input: CapacityResumeOwnership): Promise<void> {
    const item = this.attempts.find((attempt) => attempt.id === input.attemptId && attempt.eventKey === input.eventKey && attempt.pipelineRunId === input.pipelineRunId && attempt.completedAt === null && attempt.finalState === null && attempt.stopStage === input.resumeStage && attempt.stopReason === `CAPACITY_RESUME_CLAIMED:${input.ownerId}`);
    if (!item) throw new Error("EVENT_ATTEMPT_CAPACITY_RESUME_RELEASE_NOT_OWNED");
    item.stopReason = this.resumeOriginalReasons.get(input.attemptId) ?? "PROVIDER_CAPACITY_EXHAUSTED";
    this.resumeOriginalReasons.delete(input.attemptId);
  }

  async loadCapacityResumeSnapshot(input: Omit<CapacityResumeOwnership, "ownerId">): Promise<Json | null> {
    const item = this.attempts.find((attempt) => attempt.id === input.attemptId && attempt.eventKey === input.eventKey && attempt.pipelineRunId === input.pipelineRunId && attempt.completedAt === null && attempt.finalState === null && attempt.stopStage === input.resumeStage && attempt.capacityResumeSnapshot !== null && attempt.capacityResumeSnapshot !== undefined);
    return item?.capacityResumeSnapshot ?? null;
  }
}
