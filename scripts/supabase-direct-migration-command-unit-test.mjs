import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertMigration35IsOnlyForwardMigration,
  assertMigration36IsOnlyForwardMigration,
  assertMigration37IsOnlyForwardMigration,
  assertMigration38IsOnlyForwardMigration,
  assertMigration39IsOnlyForwardMigration,
  assertMigration40IsOnlyForwardMigration,
  assertMigration41IsOnlyForwardMigration,
  migration41Filename,
  migration37Filename,
  migration37AclReadOnlySqlFile,
  migration38Filename,
  migration38AclReadOnlySqlFile,
  migration39Filename,
  migration39AclReadOnlySqlFile,
  migration39RollbackFixtureSqlFile,
  migration39ResidualReadOnlySqlFile,
  migration39ReviewStateReadOnlySqlFile,
  migration40Filename,
  migration40BaselineReadOnlySqlFile,
  migration40PostApplyReadOnlySqlFile,
  migration40AclReadOnlySqlFile,
  migration40RollbackFixtureSqlFile,
  migration36Filename,
  buildMigrationCliEnvironment,
  buildSupabaseMigrationArguments,
  directDatabaseUrlVariable,
  findLocalSupabaseCli,
  isExpectedMigration40FixtureRollback,
  migration32AclReadOnlySqlFile,
  migration33AclReadOnlySqlFile,
  migration33RollbackFixtureSqlFile,
  migration33ResidualReadOnlySqlFile,
  migration34AclReadOnlySqlFile,
  migration34RollbackFixtureSqlFile,
  migration35AclReadOnlySqlFile,
  migration35RollbackFixtureSqlFile,
  migration35ResidualReadOnlySqlFile,
  redactMigrationCliOutput,
  runDirectMigrationCommand,
} from "./supabase-direct-migration-command.mjs";

const cwd = process.cwd();
const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const wrapper = readFileSync("scripts/supabase-direct-migration-command.mjs", "utf8");
const environmentExample = readFileSync(".env.example", "utf8");
assert.equal(directDatabaseUrlVariable, "SUPABASE_DIRECT_DB_URL");
assert.match(environmentExample, /^SUPABASE_DIRECT_DB_URL=$/m, "the required variable name is discoverable without storing a value");
assert.deepEqual(assertMigration41IsOnlyForwardMigration(), { migration41Present: true, unrelatedForwardMigrationPresent: false });
assert.throws(() => assertMigration40IsOnlyForwardMigration(), /UNEXPECTED_FORWARD_MIGRATION_AFTER_40/, "the historical M40-only guard is not weakened");
assert.throws(() => assertMigration39IsOnlyForwardMigration(), /UNEXPECTED_FORWARD_MIGRATION_AFTER_38/);
assert.throws(() => assertMigration36IsOnlyForwardMigration(), /UNEXPECTED_FORWARD_MIGRATION_AFTER_35/);
assert.throws(() => assertMigration35IsOnlyForwardMigration(), /MIGRATION_AFTER_35_PRESENT/, "the historical M35-only guard is not weakened");
const migrationGuardFixture = mkdtempSync(resolve(tmpdir(), "horizai-migration-guard-"));
try {
  writeFileSync(resolve(migrationGuardFixture, "20261009120000_provider_capacity_attempt_lifecycle_rpc.sql"), "-- fixture\n");
  writeFileSync(resolve(migrationGuardFixture, "20261012120000_human_review_critic_attempt_proof.sql"), "-- fixture\n");
  writeFileSync(resolve(migrationGuardFixture, "20261014120000_verifier_first_stage_capacity_resume.sql"), "-- fixture\n");
  assert.deepEqual(assertMigration35IsOnlyForwardMigration(migrationGuardFixture), { migration33Present: true, migration34Present: true, migration35Present: true, laterMigrationPresent: false });
  writeFileSync(resolve(migrationGuardFixture, "20261015120000_unexpected.sql"), "-- fixture\n");
  assert.throws(() => assertMigration35IsOnlyForwardMigration(migrationGuardFixture), /MIGRATION_AFTER_35_PRESENT/);
  assert.throws(() => assertMigration36IsOnlyForwardMigration(migrationGuardFixture), /MIGRATION_36_FILE_REQUIRED/);
  const unexpectedFile = resolve(migrationGuardFixture, "20261015120000_unexpected.sql");
  writeFileSync(resolve(migrationGuardFixture, migration36Filename), "-- fixture\n");
  assert.throws(() => assertMigration36IsOnlyForwardMigration(migrationGuardFixture), /UNEXPECTED_FORWARD_MIGRATION_AFTER_35/);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(unexpectedFile);
  assert.equal(assertMigration36IsOnlyForwardMigration(migrationGuardFixture).migration36Present, true);
  assert.throws(() => assertMigration37IsOnlyForwardMigration(migrationGuardFixture), /MIGRATION_37_FILE_REQUIRED/);
  writeFileSync(resolve(migrationGuardFixture, migration37Filename), "-- fixture\n");
  assert.equal(assertMigration37IsOnlyForwardMigration(migrationGuardFixture).migration37Present, true);
  assert.throws(() => assertMigration38IsOnlyForwardMigration(migrationGuardFixture), /MIGRATION_38_FILE_REQUIRED/);
  writeFileSync(resolve(migrationGuardFixture, migration38Filename), "-- fixture\n");
  assert.equal(assertMigration38IsOnlyForwardMigration(migrationGuardFixture).migration38Present, true);
  assert.throws(() => assertMigration39IsOnlyForwardMigration(migrationGuardFixture), /MIGRATION_39_FILE_REQUIRED/);
  writeFileSync(resolve(migrationGuardFixture, migration39Filename), "-- fixture\n");
  assert.equal(assertMigration39IsOnlyForwardMigration(migrationGuardFixture).migration39Present, true);
  assert.throws(() => assertMigration40IsOnlyForwardMigration(migrationGuardFixture), /MIGRATION_40_FILE_REQUIRED/);
  writeFileSync(resolve(migrationGuardFixture, migration40Filename), "-- fixture\n");
  assert.deepEqual(assertMigration40IsOnlyForwardMigration(migrationGuardFixture), { migration40Present: true, unrelatedForwardMigrationPresent: false });
  writeFileSync(resolve(migrationGuardFixture, "20261020140000_unexpected.sql"), "-- fixture\n");
  assert.throws(() => assertMigration36IsOnlyForwardMigration(migrationGuardFixture), /UNEXPECTED_FORWARD_MIGRATION_AFTER_35/);
  assert.throws(() => assertMigration37IsOnlyForwardMigration(migrationGuardFixture), /UNEXPECTED_FORWARD_MIGRATION_AFTER_36/);
  assert.throws(() => assertMigration38IsOnlyForwardMigration(migrationGuardFixture), /UNEXPECTED_FORWARD_MIGRATION_AFTER_37/);
  assert.throws(() => assertMigration39IsOnlyForwardMigration(migrationGuardFixture), /UNEXPECTED_FORWARD_MIGRATION_AFTER_38/);
  writeFileSync(resolve(migrationGuardFixture, "20261023120000_unexpected.sql"), "-- fixture\n");
  assert.throws(() => assertMigration40IsOnlyForwardMigration(migrationGuardFixture), /UNEXPECTED_FORWARD_MIGRATION_AFTER_40/);
  // M41 (article withdrawals): required file, then only forward migration.
  assert.throws(() => assertMigration41IsOnlyForwardMigration(migrationGuardFixture), /MIGRATION_41_FILE_REQUIRED/);
  unlinkSync(resolve(migrationGuardFixture, "20261023120000_unexpected.sql"));
  unlinkSync(resolve(migrationGuardFixture, "20261020140000_unexpected.sql"));
  writeFileSync(resolve(migrationGuardFixture, migration41Filename), "-- fixture\n");
  assert.deepEqual(assertMigration41IsOnlyForwardMigration(migrationGuardFixture), { migration41Present: true, unrelatedForwardMigrationPresent: false });
  writeFileSync(resolve(migrationGuardFixture, "20261107120000_unexpected.sql"), "-- fixture\n");
  assert.throws(() => assertMigration41IsOnlyForwardMigration(migrationGuardFixture), /UNEXPECTED_FORWARD_MIGRATION_AFTER_41/);
} finally {
  rmSync(migrationGuardFixture, { recursive: true, force: true });
}
assert.equal(
  findLocalSupabaseCli(cwd, "win32"),
  resolve(cwd, "node_modules/@supabase/cli-windows-x64/bin/supabase.exe"),
  "the official Windows npm package executable is found without using npx",
);
assert.deepEqual(buildSupabaseMigrationArguments("history"), ["migration", "list"]);
assert.deepEqual(buildSupabaseMigrationArguments("push"), ["db", "push", "--skip-vault", "--yes"]);
assert.deepEqual(buildSupabaseMigrationArguments("push-dry-run"), ["db", "push", "--dry-run", "--skip-vault"]);
assert.deepEqual(buildSupabaseMigrationArguments("m38-acl"), ["db", "query", "--output-format", "json", "--file", migration38AclReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m39-acl"), ["db", "query", "--output-format", "json", "--file", migration39AclReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m39-fixture"), ["db", "query", "--output-format", "json", "--file", migration39RollbackFixtureSqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m39-residual"), ["db", "query", "--output-format", "json", "--file", migration39ResidualReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m39-review-state"), ["db", "query", "--output-format", "json", "--file", migration39ReviewStateReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m40-baseline"), ["db", "query", "--output-format", "json", "--file", migration40BaselineReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m40-postapply"), ["db", "query", "--output-format", "json", "--file", migration40PostApplyReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m40-acl"), ["db", "query", "--output-format", "json", "--file", migration40AclReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m40-fixture"), ["db", "query", "--output-format", "json", "--file", migration40RollbackFixtureSqlFile]);
assert.equal(isExpectedMigration40FixtureRollback({ code: 1, output: "ERROR: M40_FIXTURE_FORCE_ROLLBACK" }), true);
assert.equal(isExpectedMigration40FixtureRollback({ code: 0, output: "M40_FIXTURE_FORCE_ROLLBACK" }), false);
assert.equal(isExpectedMigration40FixtureRollback({ code: 1, output: "ERROR: fixture assertion failed" }), false);
assert.deepEqual(buildSupabaseMigrationArguments("acl"), ["db", "query", "--output-format", "json", "--file", migration32AclReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m33-acl"), ["db", "query", "--output-format", "json", "--file", migration33AclReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m33-fixture"), ["db", "query", "--output-format", "json", "--file", migration33RollbackFixtureSqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m33-residual"), ["db", "query", "--output-format", "json", "--file", migration33ResidualReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m34-acl"), ["db", "query", "--output-format", "json", "--file", migration34AclReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m34-fixture"), ["db", "query", "--output-format", "json", "--file", migration34RollbackFixtureSqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m35-acl"), ["db", "query", "--output-format", "json", "--file", migration35AclReadOnlySqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m35-fixture"), ["db", "query", "--output-format", "json", "--file", migration35RollbackFixtureSqlFile]);
assert.deepEqual(buildSupabaseMigrationArguments("m35-residual"), ["db", "query", "--output-format", "json", "--file", migration35ResidualReadOnlySqlFile]);
assert.throws(() => buildSupabaseMigrationArguments("link"), /DIRECT_MIGRATION_OPERATION_INVALID/);
assert.match(readFileSync(migration32AclReadOnlySqlFile, "utf8"), /^with operator_functions/i);
assert.equal((readFileSync(migration32AclReadOnlySqlFile, "utf8").match(/;/g) ?? []).length, 1, "the remote ACL probe is exactly one statement");
assert.doesNotMatch(readFileSync(migration32AclReadOnlySqlFile, "utf8"), /\b(insert|update|delete|truncate|grant|revoke|alter|drop|create)\b/i);
const migration33AclSql = readFileSync(migration33AclReadOnlySqlFile, "utf8");
assert.match(migration33AclSql, /^with function_signatures/i);
assert.equal((migration33AclSql.match(/;/g) ?? []).length, 1, "the M33 ACL probe is exactly one read-only statement");
assert.doesNotMatch(migration33AclSql, /^\s*(insert|update|delete|truncate|grant|revoke|alter|drop|create)\b/im);
const migration34AclSql = readFileSync(migration34AclReadOnlySqlFile, "utf8");
assert.match(migration34AclSql, /^with function_acl/i);
assert.equal((migration34AclSql.match(/;/g) ?? []).length, 1, "the M34 ACL probe is exactly one read-only statement");
assert.doesNotMatch(migration34AclSql, /^\s*(insert|update|delete|truncate|grant|revoke|alter|drop|create)\b/im);
const migration34FixtureSql = readFileSync(migration34RollbackFixtureSqlFile, "utf8");
assert.match(migration34FixtureSql, /^do \$fixture\$/i);
for (const scenario of ["same_attempt_pass", "cross_attempt", "missing_critic", "missing_pass", "critic_reject", "malformed_proof", "stale_lineage"]) {
  assert.ok(migration34FixtureSql.includes(scenario), `M34 rollback fixture covers ${scenario}`);
}
assert.match(migration34FixtureSql, /M34_FIXTURE_FORCE_ROLLBACK/);
assert.match(migration34FixtureSql, /insert into public\.pipeline_human_reviews/);
assert.match(migration34FixtureSql, /m34_fixture_residual_rows_not_zero/);
assert.equal((migration34FixtureSql.match(/\bcommit\s*;/gi) ?? []).length, 0, "the M34 fixture has no commit path");
const rollbackFixtureSql = readFileSync(migration33RollbackFixtureSqlFile, "utf8");
assert.match(rollbackFixtureSql, /^do \$fixture\$/i);
assert.match(rollbackFixtureSql, /M33_FIXTURE_FORCE_ROLLBACK/);
assert.match(rollbackFixtureSql, /m33_fixture_residual_rows_not_zero/);
assert.match(rollbackFixtureSql, /\n\$fixture\$;\s*$/i, "the behavior fixture is one top-level DO statement for the prepared query path");
assert.doesNotMatch(rollbackFixtureSql, /\n(?:begin|rollback);\s*$/i);
assert.equal((readFileSync(migration33ResidualReadOnlySqlFile, "utf8").match(/;/g) ?? []).length, 1, "residual cleanup validation is one read-only statement");
assert.doesNotMatch(rollbackFixtureSql, /dfada4fd-d9c6-4aa8-bfef-6d9447267e06|a82482be-58d8-4fc6-ac16-946d0906257b/i);
assert.equal((rollbackFixtureSql.match(/\bcommit\s*;/gi) ?? []).length, 0, "the ephemeral behavior fixture always rolls back");
const migration40BaselineSql = readFileSync(migration40BaselineReadOnlySqlFile, "utf8");
for (const marker of ["migrationHead", "currentDeferredAttempt", "cycle2Attempt", "humanReviews", "publicArticles", "astra", "providerReservationsToday"]) {
  assert.ok(migration40BaselineSql.includes(marker), `M40 baseline includes ${marker}`);
}
assert.equal((migration40BaselineSql.match(/;/g) ?? []).length, 1, "the M40 pre-apply baseline is one read-only statement");
assert.doesNotMatch(migration40BaselineSql, /^\s*(insert|update|delete|truncate|grant|revoke|alter|drop|create)\b/im);
const migration40PostApplySql = readFileSync(migration40PostApplyReadOnlySqlFile, "utf8");
assert.equal((migration40PostApplySql.match(/;/g) ?? []).length, 1, "the M40 post-apply probe is one read-only statement");
assert.doesNotMatch(migration40PostApplySql, /^\s*(insert|update|delete|truncate|grant|revoke|alter|drop|create)\b/im);
const migration40AclSql = readFileSync(migration40AclReadOnlySqlFile, "utf8");
assert.match(migration40AclSql, /^with function_signatures/i);
assert.equal((migration40AclSql.match(/;/g) ?? []).length, 1, "the M40 ACL probe is one read-only statement");
assert.doesNotMatch(migration40AclSql, /^\s*(insert|update|delete|truncate|grant|revoke|alter|drop|create)\b/im);
const migration40FixtureSql = readFileSync(migration40RollbackFixtureSqlFile, "utf8");
assert.match(migration40FixtureSql, /^do \$fixture\$/i);
for (const marker of ["M40_FIXTURE_FORCE_ROLLBACK", "M40_TEST_NULL_TTL_CLAIM_ACCEPTED", "M40_TEST_TTL_59_CLAIM_ACCEPTED", "M40_TEST_TTL_1021_CLAIM_ACCEPTED", "M40_TEST_NULL_TTL_HEARTBEAT_ACCEPTED", "M40_TEST_EARLY_LEASE_TAKEOVER_ALLOWED", "M40_TEST_STALE_RECOVERY_FAILED", "M40_TEST_WRONG_OWNER_HEARTBEAT_ACCEPTED", "M40_TEST_STALE_FENCE_HEARTBEAT_ACCEPTED", "M40_TEST_STALE_OWNER_HEARTBEAT_ACCEPTED", "M40_TEST_DUPLICATE_INVOCATION_NOT_IDEMPOTENT", "M40_TEST_TTL_1020_BOUNDARY_CLAIM_FAILED"]) {
  assert.ok(migration40FixtureSql.includes(marker), `M40 rollback fixture covers ${marker}`);
}
assert.match(migration40FixtureSql, /set_config\('request\.jwt\.claim\.role', 'service_role', true\)/i);
assert.match(migration40FixtureSql, /date '2099-12-30'/i);
assert.match(migration40FixtureSql, /date '2100-01-01'/i);
assert.doesNotMatch(migration40FixtureSql, /2026-10-26|f794f73c-ce15-4167-beac-cb54bd6312af|65a83559-8522-4162-8e04-6f8a0bde62b3/i);
assert.doesNotMatch(migration40FixtureSql, /\b(insert|update|delete)\s+public\.(articles|pipeline_human_reviews|agent_logs|scheduler_runs)\b/i);
assert.equal((migration40FixtureSql.match(/\bcommit\s*;/gi) ?? []).length, 0, "the M40 fixture always forces a transactional rollback");
assert.equal((migration40FixtureSql.match(/\bdo\s+\$fixture\$/gi) ?? []).length, 1, "the M40 fixture is one atomic SQL statement");
assert.match(packageScripts["supabase:status"], /supabase-direct-migration-command\.mjs history/);
assert.match(packageScripts["supabase:db:push"], /supabase-direct-migration-command\.mjs push/);
assert.match(packageScripts["supabase:db:push:dry-run"], /supabase-direct-migration-command\.mjs push-dry-run/);
assert.match(packageScripts["supabase:migration32:acl"], /supabase-direct-migration-command\.mjs acl/);
assert.match(packageScripts["supabase:migration33:acl"], /supabase-direct-migration-command\.mjs m33-acl/);
assert.match(packageScripts["supabase:migration33:fixture"], /supabase-direct-migration-command\.mjs m33-fixture/);
assert.match(packageScripts["supabase:migration33:residual"], /supabase-direct-migration-command\.mjs m33-residual/);
assert.match(packageScripts["supabase:migration34:acl"], /supabase-direct-migration-command\.mjs m34-acl/);
assert.match(packageScripts["supabase:migration34:fixture"], /supabase-direct-migration-command\.mjs m34-fixture/);
assert.match(packageScripts["supabase:migration35:acl"], /supabase-direct-migration-command\.mjs m35-acl/);
assert.match(packageScripts["supabase:migration35:fixture"], /supabase-direct-migration-command\.mjs m35-fixture/);
assert.match(packageScripts["supabase:migration35:residual"], /supabase-direct-migration-command\.mjs m35-residual/);
assert.doesNotMatch(packageScripts["supabase:status"], /npx|--linked/);
assert.doesNotMatch(packageScripts["supabase:db:push"], /npx|--linked/);
assert.doesNotMatch(packageScripts["supabase:migration32:acl"], /npx|--linked/);
assert.doesNotMatch(wrapper, /npm_execpath|execFileSync\([^\n]*supabase|--linked|--project-ref/);

let spawnCalls = 0;
await assert.rejects(
  runDirectMigrationCommand("push", {
    cwd,
    env: { npm_execpath: "not-used" },
    spawnProcess: () => { spawnCalls += 1; throw new Error("must not spawn"); },
    cliExecutable: "fixture-cli",
  }),
  /DIRECT_MIGRATION_CONNECTION_REQUIRED/,
);
assert.equal(spawnCalls, 0, "missing direct DB URL fails before CLI/fallback invocation");

const password = ["synth", "etic", "-", "only", "-", "credential"].join("");
const databaseUrl = ["postgresql://", "fixture_user:", password, "@127.0.0.1:5432/fixture_db"].join("");
const serverKey = ["server", "-key", "-fixture-only"].join("");
const accessToken = ["access", "-token", "-fixture-only"].join("");
const providerKey = ["provider", "-key", "-fixture-only"].join("");
assert.deepEqual(buildMigrationCliEnvironment({ PATH: "fixture-path", [directDatabaseUrlVariable]: databaseUrl, SUPABASE_SECRET_KEY: serverKey, SUPABASE_ACCESS_TOKEN: accessToken, AGENT_API_KEY: providerKey }), { PATH: "fixture-path" }, "the CLI child does not inherit server/provider credentials or the direct URL environment variable");
await assert.rejects(
  runDirectMigrationCommand("history", {
    cwd,
    env: { [directDatabaseUrlVariable]: databaseUrl },
    spawnProcess: () => { spawnCalls += 1; throw new Error("must not spawn without local CLI"); },
    cliExecutable: null,
  }),
  /LOCAL_SUPABASE_CLI_EXECUTABLE_REQUIRED/,
);
assert.equal(spawnCalls, 0, "missing local CLI fails without npx/download or linked fallback");
let invokedExecutable;
let invokedArgs;
const fakeSpawn = (executable, args, options) => {
  spawnCalls += 1;
  invokedExecutable = executable;
  invokedArgs = args;
  assert.equal(options.shell, false, "no shell interpolation is used");
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  assert.equal(options.env.SUPABASE_SECRET_KEY, undefined);
  assert.equal(options.env.SUPABASE_ACCESS_TOKEN, undefined);
  assert.equal(options.env.AGENT_API_KEY, undefined);
  assert.equal(options.env[directDatabaseUrlVariable], undefined);
  assert.equal(options.env.PATH, undefined, "only the supplied environment is preserved in this fixture");
  setImmediate(() => {
    child.stderr.end(`safe failure marker ${databaseUrl}`);
    child.emit("close", 1);
  });
  return child;
};
const result = await runDirectMigrationCommand("push", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.equal(spawnCalls, 1);
assert.equal(invokedExecutable, "fixture-local-supabase-executable");
assert.deepEqual(invokedArgs.slice(0, 2), ["db", "push"]);
assert.ok(invokedArgs.includes("--skip-vault"), "migration apply never synchronizes Vault secrets");
assert.ok(invokedArgs.includes("--yes"), "approved migration apply is non-interactive");
assert.equal(invokedArgs.at(-2), "--db-url");
assert.equal(invokedArgs.at(-1), databaseUrl, "explicit direct URL is passed only to the isolated child invocation");
assert.equal(invokedArgs.includes("--linked"), false);
assert.equal(invokedArgs.includes("exec"), false, "no npm exec or download path is used");
assert.equal(result.code, 1);
assert.doesNotMatch(result.output, new RegExp(password));
assert.doesNotMatch(result.output, /postgresql:\/\//i);
assert.doesNotMatch(redactMigrationCliOutput(`failed ${databaseUrl}`, databaseUrl), new RegExp(password));

await runDirectMigrationCommand("push-dry-run", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(0, 5), ["db", "push", "--dry-run", "--skip-vault", "--db-url"]);
assert.equal(invokedArgs.at(-1), databaseUrl);

const aclResult = await runDirectMigrationCommand("acl", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.equal(aclResult.code, 1);
assert.deepEqual(invokedArgs.slice(0, 4), ["db", "query", "--db-url", databaseUrl], "the direct URL is parsed before the fixed ACL query file");
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration32AclReadOnlySqlFile]);
assert.doesNotMatch(aclResult.output, new RegExp(password));

await runDirectMigrationCommand("m35-acl", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration35AclReadOnlySqlFile]);

await runDirectMigrationCommand("m35-fixture", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration35RollbackFixtureSqlFile]);

await runDirectMigrationCommand("m35-residual", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration35ResidualReadOnlySqlFile]);


await runDirectMigrationCommand("m33-acl", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(0, 4), ["db", "query", "--db-url", databaseUrl]);
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration33AclReadOnlySqlFile]);

await runDirectMigrationCommand("m33-fixture", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(0, 4), ["db", "query", "--db-url", databaseUrl]);
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration33RollbackFixtureSqlFile]);

await runDirectMigrationCommand("m33-residual", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(0, 4), ["db", "query", "--db-url", databaseUrl]);
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration33ResidualReadOnlySqlFile]);

await runDirectMigrationCommand("m34-acl", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(0, 4), ["db", "query", "--db-url", databaseUrl]);
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration34AclReadOnlySqlFile]);

await runDirectMigrationCommand("m34-fixture", {
  cwd,
  env: { [directDatabaseUrlVariable]: databaseUrl },
  spawnProcess: fakeSpawn,
  cliExecutable: "fixture-local-supabase-executable",
});
assert.deepEqual(invokedArgs.slice(0, 4), ["db", "query", "--db-url", databaseUrl]);
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration34RollbackFixtureSqlFile]);

console.log("Direct migration connection guard, no-fallback path, and output redaction fixtures passed");
await runDirectMigrationCommand("m37-acl", { cwd, env: { [directDatabaseUrlVariable]: databaseUrl }, spawnProcess: fakeSpawn, cliExecutable: "fixture-local-supabase-executable" });
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration37AclReadOnlySqlFile]);
assert.doesNotMatch(readFileSync(migration37AclReadOnlySqlFile, "utf8"), /^\s*(insert|update|delete|truncate|grant|revoke|alter|drop|create)\b/im);
await runDirectMigrationCommand("m38-acl", { cwd, env: { [directDatabaseUrlVariable]: databaseUrl }, spawnProcess: fakeSpawn, cliExecutable: "fixture-local-supabase-executable" });
assert.deepEqual(invokedArgs.slice(4), ["--output-format", "json", "--file", migration38AclReadOnlySqlFile]);
assert.doesNotMatch(readFileSync(migration38AclReadOnlySqlFile, "utf8"), /^\s*(insert|update|delete|truncate|grant|revoke|alter|drop|create)\b/im);
