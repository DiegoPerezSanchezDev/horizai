import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/20261012120000_human_review_critic_attempt_proof.sql", "utf8").toLowerCase();
const runner = readFileSync("lib/agents/runtime/agent-runner.ts", "utf8");
const production = readFileSync("lib/agents/pipeline/create-production-pipeline.ts", "utf8");
const snapshot = readFileSync("lib/agents/publisher/human-review.ts", "utf8");

assert.match(migration, /create or replace function public\.assert_pipeline_human_review_attempt_critic_pass\(\)[\s\S]*?returns trigger[\s\S]*?security definer[\s\S]*?set search_path = pg_catalog, public, pg_temp/);
for (const predicate of [
  "ar.config->>'agentname' = 'critic'",
  "ar.config->>'eventkey' = new.event_key",
  "ar.config->>'pipelinerunid' = new.pipeline_run_id::text",
  "ar.config->>'attemptid' = new.attempt_id::text",
  "ar.status = 'succeeded'",
  "ar.stats #>> '{telemetry,zodvalid}' = 'true'",
  "ar.stats #>> '{telemetry,finalcriticresultvalid}' = 'true'",
  "ar.stats #>> '{telemetry,deterministicprecheckspassed}' = 'true'",
  "ar.stats #>> '{telemetry,finaldecision}' = 'pass'",
]) assert.ok(migration.includes(predicate), `migration 34 requires ${predicate}`);
assert.match(migration, /v_critic_count <> 1[\s\S]*?human_review_critic_pass_not_proven/);
assert.match(migration, /v_expected_checkpoint_identity := concat_ws\(':', new\.pipeline_run_id::text, new\.attempt_id::text, 'critic', new\.event_key\)/);
assert.match(migration, /new\.review_manifest #>> '\{checkpoints,critic,identity\}' is distinct from v_expected_checkpoint_identity/);
assert.match(migration, /before insert on public\.pipeline_human_reviews[\s\S]*?execute function public\.assert_pipeline_human_review_attempt_critic_pass\(\)/);
assert.match(migration, /revoke all on function public\.assert_pipeline_human_review_attempt_critic_pass\(\) from public, anon, authenticated, service_role/);
assert.doesNotMatch(migration, /\b(?:insert into|update|delete from) public\.(?:pipeline_human_reviews|pipeline_event_attempts|articles|agent_runs)\b/);
assert.doesNotMatch(migration, /net\.http|http_(?:get|post)|\bdblink\b/);

assert.match(runner, /options\.agentName === "critic"[\s\S]*?finalCriticResultValid: diagnostics\.finalCriticResultValid[\s\S]*?deterministicPrechecksPassed: diagnostics\.deterministicPrechecksPassed[\s\S]*?finalDecision: diagnostics\.finalDecision/);
assert.match(production, /context\.eventAttemptId \?\? context\.factualRemediationTarget\?\.attemptId/);
assert.match(production, /durableCritic\.attemptId !== input\.attemptId/);
assert.match(snapshot, /readSafeCriticPipelineCheckpoint\(path\)/);
assert.match(snapshot, /durableCritic\.attemptId !== input\.attemptId[\s\S]*?durableCritic\.critic\.decision !== "pass"/);
assert.match(snapshot, /\$\{input\.run\.runId\}:\$\{input\.attemptId\}:\$\{stage\}:\$\{eventKey\}/);

console.log("Supervised human-review Critic attempt-proof migration 34 fixtures passed");
