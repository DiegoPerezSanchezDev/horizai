import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../../types/database.ts";
import type { PipelineAttemptFinalState, PipelineEventAttempt, PipelineRetryClass } from "./event-attempt-policy.ts";
import { assertFactualRemediationAuthorization, assertFactualRemediationLease, factualRemediationIncident, type FactualRemediationAuthorization, type FactualRemediationLease } from "./factual-remediation.ts";

type ClaimAttempt = PipelineEventAttempt & {
  purpose: string;
  start_stage: string;
  remediation_article_id: string;
  remediation_raw_item_id: string;
  remediation_prior_attempt_id: string;
  pilot_attempt_number: number;
};

function record(value: Json | undefined): Record<string, Json | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("FACTUAL_REMEDIATION_RPC_INVALID_RESPONSE");
  return value as Record<string, Json | undefined>;
}

function stringField(value: Json | undefined, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`FACTUAL_REMEDIATION_RPC_INVALID_${field.toUpperCase()}`);
  return value;
}

function numberField(value: Json | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`FACTUAL_REMEDIATION_RPC_INVALID_${field.toUpperCase()}`);
  return value;
}

function parseAttempt(value: Json | undefined): ClaimAttempt {
  const row = record(value);
  const finalState = row.final_state == null ? null : stringField(row.final_state, "final_state") as PipelineAttemptFinalState;
  const retryClass = stringField(row.retry_class, "retry_class") as PipelineRetryClass;
  return {
    id: stringField(row.id, "id"),
    eventKey: stringField(row.event_key, "event_key"),
    pipelineRunId: stringField(row.pipeline_run_id, "pipeline_run_id"),
    attemptNumber: numberField(row.attempt_number, "attempt_number"),
    startedAt: stringField(row.started_at, "started_at"),
    completedAt: row.completed_at == null ? null : stringField(row.completed_at, "completed_at"),
    finalState,
    stopStage: row.stop_stage == null ? null : stringField(row.stop_stage, "stop_stage"),
    stopReason: row.stop_reason == null ? null : stringField(row.stop_reason, "stop_reason"),
    retryClass,
    countsTowardRetryLimit: row.counts_toward_retry_limit === true,
    nextEligibleAt: row.next_eligible_at == null ? null : stringField(row.next_eligible_at, "next_eligible_at"),
    createdAt: stringField(row.created_at, "created_at"),
    purpose: stringField(row.purpose, "purpose"),
    start_stage: stringField(row.start_stage, "start_stage"),
    remediation_article_id: stringField(row.remediation_article_id, "remediation_article_id"),
    remediation_raw_item_id: stringField(row.remediation_raw_item_id, "remediation_raw_item_id"),
    remediation_prior_attempt_id: stringField(row.remediation_prior_attempt_id, "remediation_prior_attempt_id"),
    pilot_attempt_number: numberField(row.pilot_attempt_number, "pilot_attempt_number"),
  };
}

export class SupabaseFactualRemediationRepository {
  private readonly supabase: SupabaseClient<Database>;

  constructor(supabase: SupabaseClient<Database>) {
    this.supabase = supabase;
  }

  async claim(pipelineRunId: string, authorization: FactualRemediationAuthorization): Promise<FactualRemediationLease> {
    assertFactualRemediationAuthorization(authorization);
    const response = await this.supabase.rpc("claim_incident_factual_remediation_attempt", {
      p_pipeline_run_id: pipelineRunId,
      p_authorized_by: authorization.authorizedBy.trim(),
      p_authorization_reference: authorization.authorizationReference.trim(),
      p_reason: authorization.reason.trim(),
    });
    if (response.error) throw new Error(`FACTUAL_REMEDIATION_CLAIM_FAILED:${response.error.code ?? "unknown"}`);

    const payload = record(response.data as Json);
    if (payload.status !== "ACQUIRED") {
      const reason = typeof payload.reason === "string" ? payload.reason : "UNKNOWN";
      throw new Error(`FACTUAL_REMEDIATION_CLAIM_BLOCKED:${reason}`);
    }

    const attempt = parseAttempt(payload.attempt);
    if (attempt.purpose !== "FACTUAL_REMEDIATION" || attempt.start_stage !== factualRemediationIncident.startStage) throw new Error("FACTUAL_REMEDIATION_RPC_PURPOSE_OR_STAGE_MISMATCH");
    const lease: FactualRemediationLease = {
      attempt,
      purpose: "FACTUAL_REMEDIATION",
      startStage: "VERIFIER",
      articleId: attempt.remediation_article_id as FactualRemediationLease["articleId"],
      articleSlug: factualRemediationIncident.articleSlug,
      rawItemId: attempt.remediation_raw_item_id as FactualRemediationLease["rawItemId"],
      priorAttemptId: attempt.remediation_prior_attempt_id,
      pilotAttemptNumber: attempt.pilot_attempt_number as 5,
    };
    assertFactualRemediationLease(lease);
    return lease;
  }

  async assertOwned(lease: FactualRemediationLease): Promise<void> {
    assertFactualRemediationLease(lease);
    const response = await this.supabase.from("pipeline_event_attempts")
      .select("id,event_key,pipeline_run_id,attempt_number,completed_at,final_state,purpose,start_stage,remediation_article_id,remediation_raw_item_id,remediation_prior_attempt_id,pilot_attempt_number,counts_toward_retry_limit")
      .eq("id", lease.attempt.id)
      .eq("pipeline_run_id", lease.attempt.pipelineRunId)
      .maybeSingle();
    const row = response.data;
    if (response.error || !row || row.event_key !== factualRemediationIncident.eventKey
      || row.attempt_number !== factualRemediationIncident.eventAttemptNumber
      || row.completed_at !== null || row.final_state !== null
      || row.purpose !== "FACTUAL_REMEDIATION" || row.start_stage !== "VERIFIER"
      || row.remediation_article_id !== factualRemediationIncident.articleId
      || row.remediation_raw_item_id !== factualRemediationIncident.rawItemId
      || row.remediation_prior_attempt_id !== lease.priorAttemptId
      || row.pilot_attempt_number !== 5 || row.counts_toward_retry_limit) {
      throw new Error("FACTUAL_REMEDIATION_ATTEMPT_OWNERSHIP_FAILED");
    }
  }
}
