import { randomUUID } from "node:crypto";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabasePipelineEventAttemptRepository } from "../lib/agents/pipeline/event-attempt-repository.ts";

const supabase = createSupabaseServerClient();
const registry = new SupabasePipelineEventAttemptRepository(supabase);
const eventKey = `integration-attempt-${randomUUID()}`;
const runA = randomUUID();
const runB = randomUUID();
const staleEventKey = `integration-stale-${randomUUID()}`;
const staleRunA = randomUUID();
const staleRunB = randomUUID();
const startedAt = new Date().toISOString();
try {
  const claims = await Promise.all([
    registry.claim({ eventKey, pipelineRunId: runA, startedAt, now: startedAt }),
    registry.claim({ eventKey, pipelineRunId: runB, startedAt, now: startedAt }),
  ]);
  if (claims.filter((claim) => claim.status === "ACQUIRED").length !== 1) throw new Error("Remote atomic claim did not allow exactly one owner");
  const acquired = claims.find((claim) => claim.status === "ACQUIRED");
  if (!acquired || acquired.status !== "ACQUIRED") throw new Error("Remote claim fixture was not acquired");
  await registry.finalize({ attemptId: acquired.attempt.id, pipelineRunId: acquired.attempt.pipelineRunId, completedAt: new Date().toISOString(), finalState: "TECHNICAL_FAILURE", stopStage: "integration", stopReason: "INTEGRATION_FIXTURE", retryClass: "TECHNICAL_FAILURE", countsTowardRetryLimit: true, nextEligibleAt: "2099-01-01T00:00:00Z" });
  const eligibility = await registry.getEligibility([eventKey], new Date());
  if (eligibility.get(eventKey)?.eligible !== false) throw new Error("Finalized cooldown was not enforced");
  const staleClaim = await registry.claim({ eventKey: staleEventKey, pipelineRunId: staleRunA, startedAt: "2026-01-01T00:00:00Z", now: "2026-01-01T00:00:00Z" });
  if (staleClaim.status !== "ACQUIRED") throw new Error("Remote stale fixture was not acquired");
  const recoveredClaim = await registry.claim({ eventKey: staleEventKey, pipelineRunId: staleRunB, startedAt: "2026-01-02T00:00:00Z", now: "2026-01-02T00:00:00Z" });
  if (recoveredClaim.status !== "ACQUIRED") throw new Error("Remote stale active attempt was not recovered");
  await registry.finalize({ attemptId: recoveredClaim.attempt.id, pipelineRunId: staleRunB, completedAt: new Date().toISOString(), finalState: "READY_FOR_PUBLICATION", stopStage: null, stopReason: null, retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null });
  console.log(JSON.stringify({ status: "SUCCESS", atomicClaim: true, finalized: true, cooldownApplied: true, staleActiveRecovered: true, groqCalls: 0 }, null, 2));
} finally {
  await supabase.from("pipeline_event_attempts").delete().eq("event_key", eventKey);
  await supabase.from("pipeline_event_attempts").delete().eq("event_key", staleEventKey);
}
