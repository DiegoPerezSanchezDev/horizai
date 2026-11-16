import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { nextUtcPeriodStart } from "../lib/agents/pipeline/event-attempt-policy.ts";

function arg(name: string): string {
  const prefix = `--${name}=`;
  const npmArgs = (() => { try { const raw = process.env.npm_config_argv; return raw ? (JSON.parse(raw) as { original?: string[] }).original ?? [] : []; } catch { return []; } })();
  const value = [...process.argv, ...npmArgs].find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

const pipelineRunId = arg("run-id");
const eventKey = arg("event-key");
const supabase = createSupabaseServerClient();
const registry = new SupabasePipelineEventAttemptRepository(supabase);

const existing = await supabase.from("pipeline_event_attempts").select("*").eq("event_key", eventKey).eq("pipeline_run_id", pipelineRunId).maybeSingle();
if (existing.error) throw new Error("Unable to inspect existing event attempt");
if (existing.data) {
  if (existing.data.final_state !== "TECHNICAL_FAILURE" || existing.data.stop_reason !== "EDITOR_OUTPUT_REJECTED" || !existing.data.counts_toward_retry_limit) throw new Error("Existing attempt does not match the verified historical failure");
  console.log(JSON.stringify({ status: "ALREADY_REGISTERED", eventKey, pipelineRunId, attemptNumber: existing.data.attempt_number, finalState: existing.data.final_state, stopReason: existing.data.stop_reason, groqCalls: 0 }, null, 2));
  process.exit(0);
}

const runsResponse = await supabase.from("agent_runs").select("id,started_at,finished_at,status,config,stats,error_message").filter("config->>eventKey", "eq", eventKey);
if (runsResponse.error) throw new Error("Unable to inspect historical agent runs");
const runs = runsResponse.data ?? [];
const verifier = runs.find((run) => typeof run.config === "object" && run.config !== null && !Array.isArray(run.config) && (run.config as Record<string, unknown>).agentName === "verifier");
const translator = runs.find((run) => typeof run.config === "object" && run.config !== null && !Array.isArray(run.config) && (run.config as Record<string, unknown>).agentName === "translator");
const editor = runs.find((run) => typeof run.config === "object" && run.config !== null && !Array.isArray(run.config) && (run.config as Record<string, unknown>).agentName === "editor");
if (!verifier || !translator || !editor || verifier.status !== "succeeded" || translator.status !== "succeeded" || editor.status !== "failed") throw new Error("Historical verifier/translator/editor evidence is incomplete; no backfill performed");
const errorText = `${editor.error_message ?? ""} ${JSON.stringify(editor.stats)}`;
if (!/numeric|unsupported/i.test(errorText)) throw new Error("Historical editor failure is not the verified numeric-output rejection; no backfill performed");
const startedAt = [verifier.started_at, translator.started_at, editor.started_at].sort()[0];
const claim = await registry.claim({ eventKey, pipelineRunId, startedAt, now: new Date().toISOString() });
if (claim.status !== "ACQUIRED") throw new Error(`Historical attempt could not be claimed: ${claim.status}`);
await registry.finalize({ attemptId: claim.attempt.id, pipelineRunId, completedAt: editor.finished_at ?? new Date().toISOString(), finalState: "TECHNICAL_FAILURE", stopStage: "editor", stopReason: "EDITOR_OUTPUT_REJECTED", retryClass: "TECHNICAL_FAILURE", countsTowardRetryLimit: true, nextEligibleAt: nextUtcPeriodStart(new Date(startedAt)) });
console.log(JSON.stringify({ status: "REGISTERED", eventKey, pipelineRunId, attemptNumber: claim.attempt.attemptNumber, finalState: "TECHNICAL_FAILURE", stopStage: "editor", stopReason: "EDITOR_OUTPUT_REJECTED", retryClass: "TECHNICAL_FAILURE", countsTowardRetryLimit: true, nextEligibleAt: nextUtcPeriodStart(new Date(startedAt)), evidence: { verifier: verifier.id, translator: translator.id, editor: editor.id }, groqCalls: 0 }, null, 2));
