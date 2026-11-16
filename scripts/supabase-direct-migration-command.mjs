import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const directDatabaseUrlVariable = "SUPABASE_DIRECT_DB_URL";
export const migration33Filename = "20261009120000_provider_capacity_attempt_lifecycle_rpc.sql";
export const migration34Filename = "20261012120000_human_review_critic_attempt_proof.sql";
export const migration35Filename = "20261014120000_verifier_first_stage_capacity_resume.sql";
export const migration36Filename = "20261015120000_groq_tpm_accounting_window.sql";
export const migration37Filename = "20261020120000_human_review_inspect_source_lineage_hash.sql";
export const migration38Filename = "20261020130000_human_review_revision_binding.sql";
export const migration39Filename = "20261021120000_human_review_revision_bind_operator_precedence_fix.sql";
export const migration40Filename = "20261022120000_scheduler_safety_repair_m40.sql";
export const migration41Filename = "20261106120000_article_withdrawals.sql";
export const migration38AclReadOnlySqlFile = "scripts/migration38-remote-acl-readonly.sql";
export const migration39AclReadOnlySqlFile = "scripts/migration39-remote-acl-readonly.sql";
export const migration39RollbackFixtureSqlFile = "scripts/migration39-human-review-revision-fixture.sql";
export const migration39ResidualReadOnlySqlFile = "scripts/migration39-residual-readonly.sql";
export const migration39ReviewStateReadOnlySqlFile = "scripts/migration39-review-state-readonly.sql";
export const migration40BaselineReadOnlySqlFile = "scripts/migration40-remote-baseline-readonly.sql";
export const migration40PostApplyReadOnlySqlFile = "scripts/migration40-remote-postapply-readonly.sql";
export const migration40AclReadOnlySqlFile = "scripts/migration40-remote-acl-readonly.sql";
export const migration40RollbackFixtureSqlFile = "scripts/migration40-remote-rollback-fixture.sql";
export const migration37AclReadOnlySqlFile = "scripts/migration37-remote-acl-readonly.sql";
export const migration36AclReadOnlySqlFile = "scripts/migration36-remote-acl-readonly.sql";
export const migration36RollbackFixtureSqlFile = "scripts/migration36-remote-rollback-fixture.sql";
export const migration36PreviewSqlFile = "scripts/migration36-remote-preview-rollback.sql";
export const migration36ResidualSqlFile = "scripts/migration36-remote-residual-readonly.sql";
export const migration32AclReadOnlySqlFile = "scripts/migration32-remote-acl-readonly.sql";
export const migration33AclReadOnlySqlFile = "scripts/migration33-remote-acl-readonly.sql";
export const migration34AclReadOnlySqlFile = "scripts/migration34-remote-acl-readonly.sql";
export const migration34RollbackFixtureSqlFile = "scripts/migration34-remote-rollback-fixture.sql";
export const migration35AclReadOnlySqlFile = "scripts/migration35-remote-acl-readonly.sql";
export const migration35RollbackFixtureSqlFile = "scripts/migration35-remote-rollback-fixture.sql";
export const migration35ResidualReadOnlySqlFile = "scripts/migration35-remote-residual-readonly.sql";
export const migration33RollbackFixtureSqlFile = "scripts/migration33-remote-rollback-fixture.sql";
export const migration33ResidualReadOnlySqlFile = "scripts/migration33-remote-residual-readonly.sql";
const migration35Timestamp = "20261014120000";
const migration40Timestamp = "20261022120000";
const migration41Timestamp = "20261106120000";

export function requireDirectDatabaseUrl(env = process.env) {
  const value = env[directDatabaseUrlVariable];
  if (typeof value !== "string" || !value.trim()) throw new Error("DIRECT_MIGRATION_CONNECTION_REQUIRED");
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new Error("DIRECT_MIGRATION_CONNECTION_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.username || !parsed.password || parsed.pathname.length < 2) {
    throw new Error("DIRECT_MIGRATION_CONNECTION_INVALID");
  }
  return value.trim();
}

export function assertMigration35IsOnlyForwardMigration(migrationDirectory = resolve("supabase/migrations")) {
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{14}_.*\.sql$/i.test(name)).sort();
  if (!files.includes(migration33Filename)) throw new Error("MIGRATION_33_FILE_REQUIRED");
  if (!files.includes(migration34Filename)) throw new Error("MIGRATION_34_FILE_REQUIRED");
  if (!files.includes(migration35Filename)) throw new Error("MIGRATION_35_FILE_REQUIRED");
  if (files.some((name) => name.slice(0, 14) > migration35Timestamp)) throw new Error("MIGRATION_AFTER_35_PRESENT");
  return { migration33Present: true, migration34Present: true, migration35Present: true, laterMigrationPresent: false };
}

export function assertMigration36IsOnlyForwardMigration(migrationDirectory = resolve("supabase/migrations")) {
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{14}_.*\.sql$/i.test(name)).sort();
  for (const [number, filename] of [[33, migration33Filename], [34, migration34Filename], [35, migration35Filename], [36, migration36Filename]]) {
    if (!files.includes(filename)) throw new Error(`MIGRATION_${number}_FILE_REQUIRED`);
  }
  if (files.filter((name) => name.slice(0, 14) > migration35Timestamp).some((name) => name !== migration36Filename)) throw new Error("UNEXPECTED_FORWARD_MIGRATION_AFTER_35");
  return { migration33Present: true, migration34Present: true, migration35Present: true, migration36Present: true, unrelatedForwardMigrationPresent: false };
}

export function assertMigration37IsOnlyForwardMigration(migrationDirectory = resolve("supabase/migrations")) {
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{14}_.*\.sql$/i.test(name)).sort();
  for (const [number, filename] of [[33, migration33Filename], [34, migration34Filename], [35, migration35Filename], [36, migration36Filename], [37, migration37Filename]]) {
    if (!files.includes(filename)) throw new Error(`MIGRATION_${number}_FILE_REQUIRED`);
  }
  if (files.filter((name) => name.slice(0, 14) > migration36Filename.slice(0, 14)).some((name) => name !== migration37Filename)) throw new Error("UNEXPECTED_FORWARD_MIGRATION_AFTER_36");
  return { migration37Present: true, unrelatedForwardMigrationPresent: false };
}

export function assertMigration38IsOnlyForwardMigration(migrationDirectory = resolve("supabase/migrations")) {
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{14}_.*\.sql$/i.test(name)).sort();
  for (const [number, filename] of [[33, migration33Filename], [34, migration34Filename], [35, migration35Filename], [36, migration36Filename], [37, migration37Filename], [38, migration38Filename]]) {
    if (!files.includes(filename)) throw new Error(`MIGRATION_${number}_FILE_REQUIRED`);
  }
  if (files.filter((name) => name.slice(0, 14) > migration37Filename.slice(0, 14)).some((name) => name !== migration38Filename)) {
    throw new Error("UNEXPECTED_FORWARD_MIGRATION_AFTER_37");
  }
  return { migration38Present: true, unrelatedForwardMigrationPresent: false };
}

export function assertMigration39IsOnlyForwardMigration(migrationDirectory = resolve("supabase/migrations")) {
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{14}_.*\.sql$/i.test(name)).sort();
  for (const [number, filename] of [[33, migration33Filename], [34, migration34Filename], [35, migration35Filename], [36, migration36Filename], [37, migration37Filename], [38, migration38Filename], [39, migration39Filename]]) {
    if (!files.includes(filename)) throw new Error(`MIGRATION_${number}_FILE_REQUIRED`);
  }
  if (files.filter((name) => name.slice(0, 14) > migration38Filename.slice(0, 14)).some((name) => name !== migration39Filename)) {
    throw new Error("UNEXPECTED_FORWARD_MIGRATION_AFTER_38");
  }
  return { migration39Present: true, unrelatedForwardMigrationPresent: false };
}

export function assertMigration40IsOnlyForwardMigration(migrationDirectory = resolve("supabase/migrations")) {
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{14}_.*\.sql$/i.test(name)).sort();
  for (const [number, filename] of [[33, migration33Filename], [34, migration34Filename], [35, migration35Filename], [36, migration36Filename], [37, migration37Filename], [38, migration38Filename], [39, migration39Filename], [40, migration40Filename]]) {
    if (!files.includes(filename)) throw new Error(`MIGRATION_${number}_FILE_REQUIRED`);
  }
  if (files.some((name) => name.slice(0, 14) > migration40Timestamp)) throw new Error("UNEXPECTED_FORWARD_MIGRATION_AFTER_40");
  return { migration40Present: true, unrelatedForwardMigrationPresent: false };
}

export function assertMigration41IsOnlyForwardMigration(migrationDirectory = resolve("supabase/migrations")) {
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{14}_.*\.sql$/i.test(name)).sort();
  for (const [number, filename] of [[33, migration33Filename], [34, migration34Filename], [35, migration35Filename], [36, migration36Filename], [37, migration37Filename], [38, migration38Filename], [39, migration39Filename], [40, migration40Filename], [41, migration41Filename]]) {
    if (!files.includes(filename)) throw new Error(`MIGRATION_${number}_FILE_REQUIRED`);
  }
  if (files.some((name) => name.slice(0, 14) > migration41Timestamp)) throw new Error("UNEXPECTED_FORWARD_MIGRATION_AFTER_41");
  return { migration41Present: true, unrelatedForwardMigrationPresent: false };
}

export function buildSupabaseMigrationArguments(operation) {
  if (operation === "m40-baseline") return ["db", "query", "--output-format", "json", "--file", migration40BaselineReadOnlySqlFile];
  if (operation === "m40-postapply") return ["db", "query", "--output-format", "json", "--file", migration40PostApplyReadOnlySqlFile];
  if (operation === "m40-acl") return ["db", "query", "--output-format", "json", "--file", migration40AclReadOnlySqlFile];
  if (operation === "m40-fixture") return ["db", "query", "--output-format", "json", "--file", migration40RollbackFixtureSqlFile];
  if (operation === "m37-acl") return ["db", "query", "--output-format", "json", "--file", migration37AclReadOnlySqlFile];
  if (operation === "m38-acl") return ["db", "query", "--output-format", "json", "--file", migration38AclReadOnlySqlFile];
  if (operation === "m39-acl") return ["db", "query", "--output-format", "json", "--file", migration39AclReadOnlySqlFile];
  if (operation === "m39-fixture") return ["db", "query", "--output-format", "json", "--file", migration39RollbackFixtureSqlFile];
  if (operation === "m39-residual") return ["db", "query", "--output-format", "json", "--file", migration39ResidualReadOnlySqlFile];
  if (operation === "m39-review-state") return ["db", "query", "--output-format", "json", "--file", migration39ReviewStateReadOnlySqlFile];
  if (operation === "history") return ["migration", "list"];
  if (operation === "push") return ["db", "push", "--skip-vault", "--yes"];
  if (operation === "push-dry-run") return ["db", "push", "--dry-run", "--skip-vault"];
  if (operation === "acl") return ["db", "query", "--output-format", "json", "--file", migration32AclReadOnlySqlFile];
  if (operation === "m33-acl") return ["db", "query", "--output-format", "json", "--file", migration33AclReadOnlySqlFile];
  if (operation === "m34-acl") return ["db", "query", "--output-format", "json", "--file", migration34AclReadOnlySqlFile];
  if (operation === "m34-fixture") return ["db", "query", "--output-format", "json", "--file", migration34RollbackFixtureSqlFile];
  if (operation === "m35-acl") return ["db", "query", "--output-format", "json", "--file", migration35AclReadOnlySqlFile];
  if (operation === "m35-fixture") return ["db", "query", "--output-format", "json", "--file", migration35RollbackFixtureSqlFile];
  if (operation === "m35-residual") return ["db", "query", "--output-format", "json", "--file", migration35ResidualReadOnlySqlFile];
  if (operation === "m36-acl") return ["db", "query", "--output-format", "json", "--file", migration36AclReadOnlySqlFile];
  if (operation === "m36-fixture") return ["db", "query", "--output-format", "json", "--file", migration36RollbackFixtureSqlFile];
  if (operation === "m36-preview") return ["db", "query", "--output-format", "json", "--file", migration36PreviewSqlFile];
  if (operation === "m36-residual") return ["db", "query", "--output-format", "json", "--file", migration36ResidualSqlFile];
  if (operation === "m33-fixture") return ["db", "query", "--output-format", "json", "--file", migration33RollbackFixtureSqlFile];
  if (operation === "m33-residual") return ["db", "query", "--output-format", "json", "--file", migration33ResidualReadOnlySqlFile];
  throw new Error("DIRECT_MIGRATION_OPERATION_INVALID");
}

export function findLocalSupabaseCli(cwd = process.cwd(), platform = process.platform) {
  const candidates = platform === "win32"
    ? [
      resolve(cwd, "node_modules/supabase/bin/supabase.exe"),
      resolve(cwd, "node_modules/.bin/supabase.exe"),
      resolve(cwd, "node_modules/@supabase/cli-windows-x64/bin/supabase.exe"),
    ]
    : [resolve(cwd, "node_modules/supabase/bin/supabase"), resolve(cwd, "node_modules/.bin/supabase")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function redactMigrationCliOutput(output, databaseUrl) {
  let redacted = String(output ?? "");
  const url = new URL(databaseUrl);
  const secretVariants = [databaseUrl, url.password, decodeURIComponent(url.password), url.username]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of secretVariants) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[REDACTED_DATABASE_URL]");
}

export function buildMigrationCliEnvironment(env) {
  const childEnv = { ...env };
  for (const name of [
    "SUPABASE_DIRECT_DB_URL",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_DB_PASSWORD",
    "AGENT_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "CLOUDFLARE_AI_API_TOKEN",
  ]) delete childEnv[name];
  return childEnv;
}

export function isExpectedMigration40FixtureRollback(result) {
  return result?.code !== 0 && /M40_FIXTURE_FORCE_ROLLBACK/.test(String(result?.output ?? ""));
}

export async function runDirectMigrationCommand(operation, {
  env = process.env,
  spawnProcess = spawn,
  cwd = process.cwd(),
  cliExecutable = findLocalSupabaseCli(cwd),
} = {}) {
  // This guard runs before npm/CLI process creation. No linked-project fallback is reachable without the direct URL.
  const databaseUrl = requireDirectDatabaseUrl(env);
  const migrationDirectory = resolve(cwd, "supabase/migrations");
  if (existsSync(resolve(migrationDirectory, migration41Filename))) assertMigration41IsOnlyForwardMigration(migrationDirectory);
  else if (existsSync(resolve(migrationDirectory, migration40Filename))) assertMigration40IsOnlyForwardMigration(migrationDirectory);
  else if (existsSync(resolve(migrationDirectory, migration39Filename))) assertMigration39IsOnlyForwardMigration(migrationDirectory);
  else if (existsSync(resolve(migrationDirectory, migration38Filename))) assertMigration38IsOnlyForwardMigration(migrationDirectory);
  else if (existsSync(resolve(migrationDirectory, migration37Filename))) assertMigration37IsOnlyForwardMigration(migrationDirectory);
  else if (existsSync(resolve(migrationDirectory, migration36Filename))) assertMigration36IsOnlyForwardMigration(migrationDirectory);
  else assertMigration35IsOnlyForwardMigration(migrationDirectory);
  if (!cliExecutable) throw new Error("LOCAL_SUPABASE_CLI_EXECUTABLE_REQUIRED");
  const migrationArguments = buildSupabaseMigrationArguments(operation);
  const commandArgs = ["acl", "m33-acl", "m34-acl", "m35-acl", "m33-fixture", "m33-residual", "m34-fixture", "m35-fixture", "m35-residual", "m36-acl", "m36-fixture", "m36-preview", "m36-residual", "m37-acl", "m38-acl", "m39-acl", "m39-fixture", "m39-residual", "m39-review-state", "m40-baseline", "m40-postapply", "m40-acl", "m40-fixture"].includes(operation)
    ? ["db", "query", "--db-url", databaseUrl, ...migrationArguments.slice(2)]
    : [...migrationArguments, "--db-url", databaseUrl];

  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawnProcess(cliExecutable, commandArgs, {
      cwd,
      env: buildMigrationCliEnvironment(env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", () => rejectResult(new Error("DIRECT_MIGRATION_CLI_START_FAILED")));
    child.once("close", (code) => resolveResult({ code: code ?? 1, output: redactMigrationCliOutput(output, databaseUrl) }));
  });
  return result;
}

async function main() {
  const operation = process.argv[2];
  const result = await runDirectMigrationCommand(operation);
  if (operation === "m40-fixture" && isExpectedMigration40FixtureRollback(result)) {
    process.stdout.write("M40_FIXTURE_ROLLBACK_CONFIRMED\n");
    return;
  }
  if (result.output.trim()) process.stdout.write(result.output);
  if (result.code !== 0) throw new Error(`DIRECT_MIGRATION_CLI_FAILED:${result.code}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "DIRECT_MIGRATION_COMMAND_FAILED");
    process.exitCode = 1;
  });
}
