import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../../types/database.ts";
import { continuationCheckpointManifestSchema, continuationCheckpointManifestsEqual, factualRemediationContinuation, type ContinuationCheckpointManifest, type FactualRemediationContinuationAuthorization } from "./factual-remediation-continuation.ts";
import { factualRemediationIncident } from "./factual-remediation.ts";
import type { CriticResult } from "../contracts/index.ts";

type Client = SupabaseClient<Database>;
type ContinuationState = {
  kind: "FACTUAL_REMEDIATION_CONTINUATION";
  attemptId: string;
  pipelineRunId: string;
  resumeStage: "critic";
  status: "RUNNING" | "STOPPED" | "PUBLISHED";
  checkpointManifest: ContinuationCheckpointManifest;
  resumeGeneration?: number;
  resumeExecutionId?: string;
  resumedAt?: string;
  resumeHistory?: unknown[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_RPC_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

function parseState(value: Json | null): ContinuationState {
  const state = object(value);
  if (state.kind !== "FACTUAL_REMEDIATION_CONTINUATION"
    || state.attemptId !== factualRemediationContinuation.attemptId
    || typeof state.pipelineRunId !== "string"
    || state.resumeStage !== "critic"
    || !["RUNNING", "STOPPED", "PUBLISHED"].includes(String(state.status))) {
    throw new Error("FACTUAL_REMEDIATION_CONTINUATION_STATE_INVALID");
  }
  let manifest: ContinuationCheckpointManifest;
  try {
    manifest = continuationCheckpointManifestSchema.parse(state.checkpointManifest);
  } catch {
    throw new Error("FACTUAL_REMEDIATION_CONTINUATION_STATE_INVALID");
  }
  return {
    kind: "FACTUAL_REMEDIATION_CONTINUATION",
    attemptId: state.attemptId,
    pipelineRunId: state.pipelineRunId,
    resumeStage: "critic",
    status: state.status as ContinuationState["status"],
    checkpointManifest: manifest,
    ...(typeof state.resumeGeneration === "number" ? { resumeGeneration: state.resumeGeneration } : {}),
    ...(typeof state.resumeExecutionId === "string" ? { resumeExecutionId: state.resumeExecutionId } : {}),
    ...(typeof state.resumedAt === "string" ? { resumedAt: state.resumedAt } : {}),
    ...(Array.isArray(state.resumeHistory) ? { resumeHistory: state.resumeHistory } : {}),
  };
}

function assertManifestEqual(actual: ContinuationCheckpointManifest, expected: ContinuationCheckpointManifest): void {
  if (!continuationCheckpointManifestsEqual(actual, expected)) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_MANIFEST_CHANGED");
}

export class SupabaseFactualRemediationContinuationRepository {
  private readonly supabase: Client;

  constructor(supabase: Client) { this.supabase = supabase; }

  async authorize(input: {
    attemptId: string;
    continuationPipelineRunId: string;
    authorization: FactualRemediationContinuationAuthorization;
    manifest: ContinuationCheckpointManifest;
  }): Promise<void> {
    const response = await this.supabase.rpc("authorize_incident_factual_remediation_continuation", {
      p_attempt_id: input.attemptId,
      p_pipeline_run_id: input.continuationPipelineRunId,
      p_authorized_by: input.authorization.authorizedBy.trim(),
      p_authorization_reference: input.authorization.authorizationReference.trim(),
      p_reason: input.authorization.reason.trim(),
      p_checkpoint_manifest: input.manifest as unknown as Json,
    });
    if (response.error) throw new Error(`FACTUAL_REMEDIATION_CONTINUATION_AUTHORIZE_FAILED:${response.error.code ?? "unknown"}`);
    const result = object(response.data);
    if (result.status !== "AUTHORIZED" || result.attemptId !== input.attemptId
      || result.pipelineRunId !== input.continuationPipelineRunId || result.resumeStage !== "critic"
      || result.pilotAttemptNumber !== 5) {
      throw new Error(`FACTUAL_REMEDIATION_CONTINUATION_AUTHORIZE_BLOCKED:${String(result.reason ?? result.status ?? "UNKNOWN")}`);
    }
  }

  async resumePreviouslyAuthorized(input: {
    attemptId: string;
    continuationPipelineRunId: string;
    resumeExecutionId: string;
    manifest: ContinuationCheckpointManifest;
  }): Promise<void> {
    const manifest = continuationCheckpointManifestSchema.parse(input.manifest);
    const response = await this.supabase.rpc("resume_incident_factual_remediation_continuation", {
      p_attempt_id: input.attemptId,
      p_pipeline_run_id: input.continuationPipelineRunId,
      p_resume_execution_id: input.resumeExecutionId,
      p_checkpoint_manifest: manifest as unknown as Json,
    });
    if (response.error) throw new Error(`FACTUAL_REMEDIATION_CONTINUATION_RESUME_FAILED:${response.error.code ?? "unknown"}`);
    const result = object(response.data);
    if (result.status !== "RESUMED" || result.attemptId !== input.attemptId
      || result.pipelineRunId !== input.continuationPipelineRunId
      || result.resumeExecutionId !== input.resumeExecutionId || result.resumeGeneration !== 1
      || result.authorizationReused !== true || result.newAuthorizationCreated !== false || result.newAttemptCreated !== false) {
      throw new Error(`FACTUAL_REMEDIATION_CONTINUATION_RESUME_BLOCKED:${String(result.reason ?? result.status ?? "UNKNOWN")}`);
    }
  }

  async assertOwned(attemptId: string, continuationPipelineRunId: string, resumeExecutionId: string, manifest: ContinuationCheckpointManifest): Promise<void> {
    const attemptResult = await this.supabase.from("pipeline_event_attempts")
      .select("id,event_key,pipeline_run_id,attempt_number,purpose,pilot_attempt_number,completed_at,final_state,stop_stage,stop_reason,continuation")
      .eq("id", attemptId).maybeSingle();
    if (attemptResult.error || !attemptResult.data) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_ATTEMPT_READ_FAILED");
    const attempt = attemptResult.data;
    if (attempt.id !== factualRemediationContinuation.attemptId
      || attempt.event_key !== factualRemediationIncident.eventKey
      || attempt.pipeline_run_id !== factualRemediationContinuation.originalPipelineRunId
      || attempt.attempt_number !== factualRemediationIncident.eventAttemptNumber
      || attempt.pilot_attempt_number !== 5
      || attempt.purpose !== "FACTUAL_REMEDIATION"
      || !attempt.completed_at
      || attempt.final_state !== "TECHNICAL_FAILURE"
      || attempt.stop_stage !== "critic"
      || attempt.stop_reason !== "cost_guard_violation") throw new Error("FACTUAL_REMEDIATION_CONTINUATION_TERMINAL_ATTEMPT_CHANGED");
    const state = parseState(attempt.continuation);
    assertManifestEqual(state.checkpointManifest, manifest);
    if (state.status !== "RUNNING" || state.pipelineRunId !== continuationPipelineRunId
      || state.resumeGeneration !== 1 || state.resumeExecutionId !== resumeExecutionId
      || !state.resumedAt || state.resumeHistory?.length !== 1) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_NOT_OWNED");

    const articleResult = await this.supabase.from("articles").select("id,event_id,slug,publication_status")
      .eq("id", factualRemediationIncident.articleId).maybeSingle();
    if (articleResult.error || !articleResult.data
      || articleResult.data.event_id !== factualRemediationIncident.eventId
      || articleResult.data.slug !== factualRemediationIncident.articleSlug
      || articleResult.data.publication_status !== "archived") throw new Error("FACTUAL_REMEDIATION_CONTINUATION_ARTICLE_NOT_ARCHIVED");
    const publicResult = await this.supabase.from("public_published_articles").select("slug")
      .eq("slug", factualRemediationIncident.articleSlug).maybeSingle();
    if (publicResult.error || publicResult.data) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_PUBLIC_READ_FAILED_OR_ARTICLE_VISIBLE");
  }

  async finish(input: {
    attemptId: string;
    continuationPipelineRunId: string;
    criticDecision: CriticResult["decision"] | null;
    stopStage: "critic" | "publisher";
    stopReason: string;
    providerRequestsUsed: number;
  }): Promise<void> {
    const response = await this.supabase.rpc("finish_incident_factual_remediation_continuation", {
      p_attempt_id: input.attemptId,
      p_pipeline_run_id: input.continuationPipelineRunId,
      p_critic_decision: input.criticDecision,
      p_stop_stage: input.stopStage,
      p_stop_reason: input.stopReason.slice(0, 120),
      p_provider_requests_used: Math.max(0, Math.min(1, Math.floor(input.providerRequestsUsed))),
    });
    if (response.error) throw new Error(`FACTUAL_REMEDIATION_CONTINUATION_FINISH_FAILED:${response.error.code ?? "unknown"}`);
    const result = object(response.data);
    if (!(["STOPPED", "ALREADY_STOPPED", "ALREADY_PUBLISHED"] as unknown[]).includes(result.status)
      || result.attemptId !== input.attemptId || result.pipelineRunId !== input.continuationPipelineRunId) {
      throw new Error("FACTUAL_REMEDIATION_CONTINUATION_FINISH_NOT_OWNED");
    }
  }

  async countDispatchedRequests(continuationPipelineRunId: string): Promise<number> {
    const runsResult = await this.supabase.from("agent_runs").select("id")
      .eq("config->>agentName", "critic")
      .eq("config->>agentVersion", "critic-v4")
      .eq("config->>eventKey", factualRemediationIncident.eventKey)
      .eq("config->>attemptId", factualRemediationContinuation.attemptId)
      .eq("config->>pipelineRunId", continuationPipelineRunId)
      .eq("provider", "groq");
    if (runsResult.error) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_RUN_LEDGER_READ_FAILED");
    const runIds = (runsResult.data ?? []).map((row) => row.id);
    if (runIds.length === 0) return 0;
    const logsResult = await this.supabase.from("agent_logs").select("id,payload")
      .in("run_id", runIds).eq("step", "provider_request_reserved");
    if (logsResult.error) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_RESERVATION_LEDGER_READ_FAILED");
    const reservations = logsResult.data ?? [];
    if (reservations.length > 1) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_PROVIDER_REQUEST_LIMIT_EXCEEDED");
    return reservations.filter((row) => object(row.payload).providerRequestDispatched === true).length;
  }
}
