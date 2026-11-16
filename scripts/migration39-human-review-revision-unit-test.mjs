import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const m38 = readFileSync('supabase/migrations/20261020130000_human_review_revision_binding.sql','utf8');
const m39 = readFileSync('supabase/migrations/20261021120000_human_review_revision_bind_operator_precedence_fix.sql','utf8');
const failedFixture = readFileSync('scripts/m38-bind-synthetic-repro.sql','utf8');
const isolation = readFileSync('scripts/m38-bind-expression-isolation.sql','utf8');
const fixedFixture = readFileSync('scripts/migration39-human-review-revision-fixture.sql','utf8');
const runner = readFileSync('scripts/supervised-cycle-12f12o-bind-human-revision.ts','utf8');
const signature = /create (?:or replace )?function public\.bind_pipeline_human_review_revision\([\s\S]*?\$function\$;/i;
const oldFunction = m38.match(signature)?.[0];
const newFunction = m39.match(signature)?.[0];
assert.ok(oldFunction && newFunction, 'M38 and M39 both define the same RPC');
assert.match(oldFunction, /p_corrected_publication_payload->'article' - 'slug'/);
assert.match(newFunction, /\(\(p_corrected_publication_payload->'article'\) - 'slug'::text\)/);
const normalizedNewFunction = newFunction
  .replace('create or replace function', 'create function')
  .replace("((p_corrected_publication_payload->'article') - 'slug'::text)", "(p_corrected_publication_payload->'article' - 'slug')");
assert.equal(normalizedNewFunction, oldFunction,
  'M39 changes only the grouped, typed JSONB subtraction expression');
assert.match(newFunction, /security definer set search_path = pg_catalog, public, pg_temp/i);
assert.match(m39, /revoke all on function public\.bind_pipeline_human_review_revision[\s\S]*?from public, anon, authenticated, service_role;/i);
assert.match(m39, /grant execute on function public\.bind_pipeline_human_review_revision[\s\S]*?to service_role;/i);
assert.equal((m39.match(/create or replace function/gi) ?? []).length, 1);
assert.doesNotMatch(m39, /\b(create|alter|drop|truncate)\s+(table|policy|schema|type|extension)\b/i);
assert.match(failedFixture, /M38_SYNTHETIC_BIND_RESULT/);
assert.match(failedFixture, /v_state = returned_sqlstate/);
assert.match(failedFixture, /M38_SYNTHETIC_BIND_RESULT:' \|\| v_state/);
assert.match(failedFixture, /rollback/i);
assert.match(isolation, /v_corrected->'article' - 'slug'/);
assert.match(isolation, /'article_minus_slug=' \|\| v_state/);
assert.match(isolation, /M39_grouped_typed_article_minus_slug=PASS/);
for (const marker of ['original_hash','corrected_hash','source_lineage','M39_NON_WAITING_REVIEW_NOT_REJECTED','M39_CONSUMED_REVIEW_NOT_REJECTED','M39_DUPLICATE_REVISION_NOT_REJECTED','M39_IMMUTABLE_REVISION_UPDATE_NOT_REJECTED','M39_STALE_APPROVAL_NOT_REJECTED','M39_FIXTURE_PASS']) assert.ok(fixedFixture.includes(marker), `rollback fixture includes ${marker}`);
assert.match(fixedFixture, /M39_APPROVAL_DRY_RUN_FORCE_ROLLBACK/);
assert.match(runner, /bindAttemptCount: 1/);
assert.match(runner, /M39/);
assert.match(runner, /approvalOrPublicationExecuted: false/);
console.log('M39 root-cause, single-expression migration, privilege, rollback-fixture, and one-bind runner checks passed');
