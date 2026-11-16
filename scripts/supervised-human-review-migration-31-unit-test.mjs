import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const migrationPath = "supabase/migrations/20261005194000_supervised_human_review_gate.sql";
const migration = readFileSync(migrationPath, "utf8");
const normalized = migration.toLowerCase();
const migrationFiles = readdirSync("supabase/migrations")
  .filter((name) => /^\d{14}_.*\.sql$/i.test(name))
  .sort();
const expected27Through32 = [
  "20260930211903_factual_remediation_lifecycle.sql",
  "20261002105220_factual_remediation_continuation.sql",
  "20261002150747_factual_remediation_continuation_fix.sql",
  "20261002211000_factual_remediation_continuation_resume.sql",
  "20261005194000_supervised_human_review_gate.sql",
  "20261007215233_human_review_operator_read_rpc.sql",
];
const expected33 = "20261009120000_provider_capacity_attempt_lifecycle_rpc.sql";
const expected34 = "20261012120000_human_review_critic_attempt_proof.sql";
const expected35 = "20261014120000_verifier_first_stage_capacity_resume.sql";
const expected36 = "20261015120000_groq_tpm_accounting_window.sql";
const expected37 = "20261020120000_human_review_inspect_source_lineage_hash.sql";
const expected38 = "20261020130000_human_review_revision_binding.sql";
const expected39 = "20261021120000_human_review_revision_bind_operator_precedence_fix.sql";
const expected40 = "20261022120000_scheduler_safety_repair_m40.sql";
const expectedWithdrawal = "20261106120000_article_withdrawals.sql";
const afterMigration26 = migrationFiles.filter((name) => name.slice(0, 14) > "20260927000026");
assert.deepEqual(afterMigration26, [...expected27Through32, expected33, expected34, expected35, expected36, expected37, expected38, expected39, expected40, expectedWithdrawal], "historical migrations remain ordered through the article withdrawal migration");
assert.equal(migrationFiles.at(-1), expectedWithdrawal, "article withdrawal is the latest prepared migration; M31 remains unchanged");

function functionBody(name) {
  const pattern = new RegExp(`create(?:\\s+or\\s+replace)?\\s+function\\s+public\\.${name}\\s*\\(`, "i");
  const match = pattern.exec(migration);
  assert.ok(match, `migration 31 creates ${name}`);
  const end = migration.indexOf("$$;", match.index);
  assert.notEqual(end, -1, `${name} has a complete function body`);
  return migration.slice(match.index, end + 3);
}

const functions = [
  "claim_pipeline_event_attempt",
  "finalize_pipeline_event_attempt",
  "assert_pipeline_human_review_evidence",
  "assert_pipeline_human_review_source_lineage",
  "create_pipeline_human_review",
  "decide_pipeline_human_review",
  "publish_reviewed_article_atomic",
];
const functionBodies = Object.fromEntries(functions.map((name) => [name, functionBody(name)]));
for (const [name, body] of Object.entries(functionBodies)) {
  assert.match(body, /language\s+plpgsql[\s\S]*?security\s+definer/i, `${name} is a SECURITY DEFINER RPC`);
  assert.match(body, /set\s+search_path\s*=\s*pg_catalog\s*,\s*public(?:\s*,\s*pg_temp)?/i, `${name} fixes a safe search_path`);
}

assert.equal((normalized.match(/alter\s+table\s+public\.pipeline_event_attempts\b/g) ?? []).length, 2, "only the attempt final-state constraint is altered");
assert.match(normalized, /drop\s+constraint\s+if\s+exists\s+pipeline_event_attempts_final_state_check/);
assert.match(normalized, /add\s+constraint\s+pipeline_event_attempts_final_state_check/);
assert.match(normalized, /'waiting_for_human_review'/);
assert.match(normalized, /create\s+unique\s+index\s+if\s+not\s+exists\s+pipeline_event_attempts_one_human_review_waiting_idx/);
assert.match(normalized, /create\s+table\s+public\.pipeline_human_reviews\s*\(/);
assert.match(normalized, /attempt_id\s+uuid\s+not\s+null\s+unique\s+references\s+public\.pipeline_event_attempts/);
assert.match(normalized, /alter\s+table\s+public\.pipeline_human_reviews\s+enable\s+row\s+level\s+security/);
assert.match(normalized, /revoke\s+all\s+on\s+table\s+public\.pipeline_human_reviews\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/);
assert.equal((normalized.match(/constraint\s+pipeline_human_reviews_status_check\b/g) ?? []).length, 1, "the status lifecycle constraint has one unique name");
const reviewTable = normalized.match(/create\s+table\s+public\.pipeline_human_reviews\s*\(([\s\S]*?)\n\);/)?.[1];
assert.ok(reviewTable, "review table declaration can be inspected for duplicate constraints");
assert.equal((reviewTable.match(/constraint\s+pipeline_human_reviews_review_manifest_check\b/g) ?? []).length, 1, "the review-manifest constraint is declared exactly once in table DDL");
assert.equal((normalized.match(/(?:constraint\s+pipeline_human_reviews_review_manifest_check\b|add\s+constraint\s+pipeline_human_reviews_review_manifest_check\b)/g) ?? []).length, 1, "no equivalent named ALTER TABLE declaration duplicates the canonical constraint");
assert.match(reviewTable, /review_manifest\s+jsonb\s+not\s+null\s*,/i, "the column has no anonymous inline CHECK that generates the canonical constraint name");
assert.match(reviewTable, /constraint\s+pipeline_human_reviews_review_manifest_check\s+check\s*\([\s\S]*?jsonb_typeof\(review_manifest\)\s*=\s*'object'[\s\S]*?schemaVersion[\s\S]*?packageSha256[\s\S]*?checkpoints[\s\S]*?identity[\s\S]*?sha256/i, "the single canonical constraint preserves both object shape and strict checkpoint-manifest invariants");

for (const field of ["verifier", "translator", "editor", "classifier", "ranker", "critic"]) {
  assert.match(normalized, new RegExp(`checkpoints[^;]*'${field}'`), `review manifest binds the ${field} checkpoint`);
}
for (const field of ["identity", "sha256", "packageSha256", "publication_payload_sha256", "source_lineage_sha256", "draft_sha256"]) {
  assert.ok(normalized.includes(field.toLowerCase()), `review storage binds ${field}`);
}
assert.match(normalized, /reviewed_at\s+timestamptz/);
assert.match(normalized, /reviewer_id\s+text/);
assert.match(normalized, /decision_history\s+jsonb/);
assert.match(normalized, /facts_acceptable\s+boolean/);
assert.match(normalized, /attribution_acceptable\s+boolean/);
assert.doesNotMatch(normalized, /review_material\b/, "review content is not duplicated in a second article-like record");
assert.doesNotMatch(normalized, /publication_payload\s+jsonb\s+not\s+null/, "the publication payload is not stored in the review table");
assert.match(functionBodies.create_pipeline_human_review, /extensions\.digest\(convert_to\(p_publication_payload::text,\s*'utf8'\),\s*'sha256'\)/i, "hashing uses the installed pgcrypto schema");
assert.match(functionBodies.publish_reviewed_article_atomic, /extensions\.digest\(convert_to\(p_source_lineage::text,\s*'utf8'\),\s*'sha256'\)/i);
assert.doesNotMatch(normalized, /public\.digest\(/i, "pgcrypto is not incorrectly assumed to live in public");
assert.match(functionBodies.create_pipeline_human_review, /human_review_snapshot_conflict/);

const createReview = functionBodies.create_pipeline_human_review;
const decideReview = functionBodies.decide_pipeline_human_review;
const publishReview = functionBodies.publish_reviewed_article_atomic;
assert.match(createReview, /auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'/i);
assert.match(createReview, /final_state\s*=\s*'waiting_for_human_review'/i);
assert.match(createReview, /stop_stage\s*=\s*'human_review'/i);
assert.match(createReview, /stop_reason\s*=\s*'human_review_pending'/i);
assert.match(createReview, /assert_pipeline_human_review_evidence/i);
assert.match(createReview, /assert_pipeline_human_review_source_lineage/i);

assert.match(decideReview, /auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'/i);
assert.match(decideReview, /'approve'\s*,\s*'reject'\s*,\s*'hold'/i);
assert.match(decideReview, /p_facts_acceptable\s+and\s+p_attribution_acceptable/i);
assert.match(decideReview, /case\s+p_decision\s+when\s+'approve'\s+then\s+'approved'\s+when\s+'reject'\s+then\s+'rejected'\s+else\s+'hold'/i);
assert.doesNotMatch(decideReview, /update\s+public\.pipeline_event_attempts/i, "REJECT and HOLD do not restart or retry model stages");

assert.match(publishReview, /auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'/i);
assert.match(publishReview, /'human_approval_required'/i);
assert.match(publishReview, /'human_review_held'/i);
assert.match(publishReview, /'human_review_rejected'/i);
assert.match(publishReview, /p_event_key\s+is\s+distinct\s+from\s+v_review\.event_key/i);
assert.match(publishReview, /p_attempt_id\s+is\s+distinct\s+from\s+v_review\.attempt_id/i);
assert.match(publishReview, /p_pipeline_run_id\s+is\s+distinct\s+from\s+v_review\.pipeline_run_id/i);
assert.match(publishReview, /p_draft_sha256\s+is\s+distinct\s+from\s+v_review\.draft_sha256/i);
assert.match(publishReview, /p_checkpoint_hashes\s+is\s+distinct\s+from\s+v_review\.review_manifest->'checkpoints'/i);
assert.match(publishReview, /p_source_lineage\s+is\s+distinct\s+from\s+v_review\.source_lineage/i);
assert.match(publishReview, /v_source_lineage_sha256\s+is\s+distinct\s+from\s+v_review\.source_lineage_sha256/i);
assert.match(publishReview, /v_publication_payload_sha256\s+is\s+distinct\s+from\s+v_review\.publication_payload_sha256/i);
assert.match(publishReview, /for\s+update/i, "consumption serializes concurrent use of one approval");
assert.match(publishReview, /status\s*=\s*'approved'\s+and\s+consumed_at\s+is\s+null/i);
assert.match(publishReview, /human_review_approval_already_consumed/i);
assert.match(publishReview, /public\.publish_article_atomic\(p_publication_payload\)/i);
assert.match(publishReview, /status\s*=\s*'published'/i);

for (const name of ["assert_pipeline_human_review_evidence", "assert_pipeline_human_review_source_lineage", "create_pipeline_human_review", "decide_pipeline_human_review", "publish_reviewed_article_atomic"]) {
  assert.match(normalized, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role`), `${name} has no PUBLIC, anon, authenticated, or direct service_role execution`);
}
assert.match(normalized, /grant\s+execute\s+on\s+function\s+public\.create_pipeline_human_review[\s\S]*?to\s+service_role/);
assert.match(normalized, /grant\s+execute\s+on\s+function\s+public\.decide_pipeline_human_review[\s\S]*?to\s+service_role/);
assert.match(normalized, /grant\s+execute\s+on\s+function\s+public\.publish_reviewed_article_atomic[\s\S]*?to\s+service_role/);
assert.match(normalized, /revoke\s+all\s+on\s+function\s+public\.publish_article_atomic\(jsonb\)\s+from\s+service_role/);
assert.doesNotMatch(normalized, /\bexecute\s+(?:immediate|format)\b/i, "migration contains no dynamic SQL");
assert.doesNotMatch(normalized, /create\s+trigger\b/i, "migration creates no automatic Publisher or scheduler trigger");
assert.doesNotMatch(normalized, /create\s+type\b/i, "migration creates no enum/type");
assert.doesNotMatch(normalized, /alter\s+table\s+public\.(?:articles|events)\b/i, "existing article/event visibility contract is not altered");
assert.doesNotMatch(normalized, /create\s+or\s+replace\s+function\s+public\.resume_incident_factual_remediation_continuation/i, "migration 30 continuation authorization remains untouched");
assert.doesNotMatch(normalized, /net\.http|http_(?:get|post)|\bdblink\b/i, "migration performs no provider or network call");

const migration30Sql = readFileSync("supabase/migrations/20261002211000_factual_remediation_continuation_resume.sql", "utf8");
assert.match(migration30Sql, /where id\s*=\s*p_attempt_id\s+and event_key\s*=\s*v_event_key/i, "migration 30 resumes the existing attempt");
assert.match(migration30Sql, /v_continuation\s*->>\s*'pipelineRunId'\s+is distinct from\s+p_pipeline_run_id/i, "migration 30 reuses the same authorization run");
assert.match(migration30Sql, /'newAuthorizationCreated',\s*false/i);
assert.match(migration30Sql, /'newAttemptCreated',\s*false/i);
assert.match(migration30Sql, /resumeStage[\s\S]{0,80}'critic'/i, "migration 30 resumes at Critic only");
assert.match(migration30Sql, /v_continuation\s+\?\s+'resumeGeneration'/i, "migration 30 retains the one-resume guard");
assert.match(migration30Sql, /'resumeHistory',\s*jsonb_build_array\(v_previous_stop\)/i, "migration 30 preserves prior STOP audit");
assert.match(migration30Sql, /auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'/i);
assert.match(migration30Sql, /set\s+search_path\s*=\s*pg_catalog\s*,\s*public/i);
assert.match(migration30Sql, /pilot_attempt_number\s*=\s*6/i, "migration 30 continues to reject attempt 6");
assert.doesNotMatch(migration, /create(?:\s+or\s+replace)?\s+function\s+public\.resume_incident_factual_remediation_continuation/i, "migration 31 leaves every migration 30 resume invariant in its immutable function");

const remoteValidation = readFileSync("scripts/supervised-human-review-migration-12e1-remote-validation.mjs", "utf8");
assert.match(remoteValidation, /--preapply-snapshot/);
assert.match(remoteValidation, /--execute-synthetic-validation/);
assert.match(remoteValidation, /const\s+validationNamespace\s*=\s*`12e1a:\$\{randomUUID\(\)\}`/i, "every remote fixture uses the requested synthetic namespace");
assert.match(remoteValidation, /await cleanup\(refs\.scenarios\)/, "synthetic fixtures are cleaned in finally");
assert.match(remoteValidation, /criticNonPass/, "remote validation covers Critic non-pass evidence");
assert.match(remoteValidation, /usageUnsettled/, "remote validation covers unsettled provider usage");
assert.match(remoteValidation, /successfulConsumes\.length, 1/);
assert.match(remoteValidation, /rejectedConsumes\.length, 1/);
assert.doesNotMatch(remoteValidation, /(?:chat\.completions|generateText|createCompletion)\s*\(|new\s+(?:Groq|Cerebras|CloudflareWorkersAI)\s*\(/i, "remote validation does not invoke provider SDKs");

console.log("Supervised human-review migration 31 static and lifecycle contract fixtures passed");
