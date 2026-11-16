import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const migrationName = "20261002211000_factual_remediation_continuation_resume.sql";
const migrationPath = resolve(root, "supabase/migrations", migrationName);
const sql = await readFile(migrationPath, "utf8");
const start = sql.indexOf("create or replace function public.resume_incident_factual_remediation_continuation");
const end = sql.indexOf("$$;", start) + 3;
const body = sql.slice(start, end);
const migrationFiles = await readdir(resolve(root, "supabase/migrations"));

assert.equal(migrationFiles.filter((name) => /factual_remediation_continuation_resume\.sql$/.test(name)).length, 1);
assert.match(migrationName, /^20261002\d{6}_factual_remediation_continuation_resume\.sql$/);
assert.match(sql, /^--[\s\S]*?\bbegin;/i);
assert.match(sql, /commit;\s*$/i);
assert.match(sql, /alter table public\.pipeline_event_attempts[\s\S]*drop constraint pipeline_event_attempts_remediation_metadata_check/i);
assert.match(sql, /validation_namespace\s*~\s*'\^12c2b2f1a:/i);
assert.doesNotMatch(sql, /create\s+table\b/i, "migration 30 creates no tables");
assert.doesNotMatch(sql, /insert\s+into\s+public\.pipeline_event_attempts/i, "migration 30 creates no attempts");
assert.doesNotMatch(sql, /authorize_incident_factual_remediation_continuation\s*\(/i, "migration 30 creates no authorization");
assert.doesNotMatch(sql, /alter table public\.pipeline_event_attempts\s+add column/i, "migration 30 adds no columns");
assert.doesNotMatch(sql, /create\s+(?:unique\s+)?index/i, "migration 30 adds no indexes");

assert.match(body, /p_attempt_id uuid,\s*p_pipeline_run_id uuid,\s*p_resume_execution_id uuid,\s*p_checkpoint_manifest jsonb/i);
assert.match(body, /auth\.role\(\) is distinct from 'service_role'/i);
assert.match(body, /language plpgsql security definer set search_path = pg_catalog, public/i);
assert.match(body, /pg_advisory_xact_lock\(hashtextextended\(v_event_key, 0\)\)/i);
assert.match(body, /for update/i);
assert.match(body, /resumeGeneration/i);
assert.match(body, /resumeExecutionId/i);
assert.match(body, /'resumeHistory', jsonb_build_array\(v_previous_stop\)/i);
assert.match(body, /v_previous_stop := v_continuation/i, "the complete prior STOPPED authorization is retained for audit");
assert.match(body, /'newAuthorizationCreated', false/i);
assert.match(body, /'newAttemptCreated', false/i);
assert.match(body, /'status', 'RUNNING'/i);
assert.match(body, /'status', 'RESUMED'/i);
assert.match(body, /v_continuation \? 'resumeGeneration'/i, "only the first resume is admitted");
assert.match(body, /p_resume_execution_id in \([\s\S]*?v_real_attempt_id/i);
assert.match(body, /v_expected_synthetic_fixture\s*:=\s*v_is_synthetic::text\s*;/i);
assert.match(body, /v_continuation\s*->>\s*'syntheticFixture'\s+is distinct from v_expected_synthetic_fixture/i);
assert.doesNotMatch(body, /->>\s*'syntheticFixture'\s+is distinct from\s+case\b/i, "the invalid inline CASE comparison stays removed");
assert.match(body, /'attemptId', p_attempt_id/i);
assert.match(body, /'pipelineRunId', p_pipeline_run_id/i, "the existing authorized continuation identity remains unchanged");

for (const identity of [
  "a82482be-58d8-4fc6-ac16-946d0906257b",
  "event-30f226d1b8ba5c9eb8af2b65c46db512",
  "db368f10-d9c1-4897-b752-b3d2cb156e09",
  "f140d01b-b7f1-4f05-b8f7-9ad0081e7105",
  "756b0ee0-b5e6-4153-846f-278a12c9afe3",
]) assert.ok(body.includes(identity), `real resume remains pinned to ${identity}`);

assert.match(body, /v_continuation ->> 'status' is distinct from 'STOPPED'/i);
assert.match(body, /v_continuation ->> 'stopReason' is distinct from 'CONTINUATION_RUNNER_ABORTED'/i);
assert.match(body, /v_continuation ->> 'providerRequestsUsed' is distinct from '0'/i);
assert.match(body, /authorizationReference/i);
assert.match(body, /FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_MANIFEST_CHANGED/i, "synthetic eligible stop captures the known serialization failure code");
assert.match(body, /v_attempt\.purpose <> 'FACTUAL_REMEDIATION'/i);
assert.match(body, /v_attempt\.pilot_attempt_number <> 5/i);
assert.match(body, /v_attempt\.retry_class <> 'NONE'/i);
assert.match(body, /v_attempt\.counts_toward_retry_limit/i);
assert.match(body, /attempt_number > 2/i);
assert.match(body, /pilot_attempt_number = 6/i);
assert.match(body, /criticDecision/i);
assert.match(body, /CONTINUATION_PROVIDER_ACTIVITY_EXISTS/i);
assert.match(body, /provider_request_reserved/i);
assert.match(body, /critic-v4/i);
assert.match(body, /publication_status = 'archived'/i);
assert.match(body, /public_published_articles/i);
assert.match(body, /event_sources[\s\S]*raw_items[\s\S]*sources/i);
assert.match(body, /jsonb_object_keys\(p_checkpoint_manifest\)/i);
assert.match(body, /jsonb_object_keys\(p_checkpoint_manifest -> 'checkpoints'\)/i);
assert.match(body, /p_checkpoint_manifest is distinct from \(v_continuation -> 'checkpointManifest'\)/i, "JSONB comparison ignores object key order");
assert.doesNotMatch(body, /jsonb_object_length/i);
assert.doesNotMatch(body, /checkpointManifest[^;]*::text\s*(?:=|<>)/i, "manifest comparison never relies on raw serialized text");
for (const stage of ["verifier", "translator", "editor", "classifier", "ranker"]) assert.match(body, new RegExp(`checkpoints,${stage}`));
for (const hash of [
  "668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378",
  "ac88461328385917a3c9ebd219815b06211b1d0ed64684eea1f0993c4e5cc218",
  "947951b78f3aa39719943d8d916a70c23a796777b33557b8dcb5d67d3b4a345d",
  "17d758b3883239ab7e3dc28141b8449c9b93df43827f56d77b4ef6fe506d5edf",
]) assert.ok(body.includes(hash), "all real checkpoint hashes remain fixed");

assert.match(sql, /revoke all on function public\.resume_incident_factual_remediation_continuation\(uuid, uuid, uuid, jsonb\) from public, anon, authenticated/i);
assert.match(sql, /grant execute on function public\.resume_incident_factual_remediation_continuation\(uuid, uuid, uuid, jsonb\) to service_role/i);
assert.doesNotMatch(sql, /scheduler|netlify|cloudflare|cerebras|router/i);

console.log("Factual remediation continuation migration 30 offline fixtures passed");
