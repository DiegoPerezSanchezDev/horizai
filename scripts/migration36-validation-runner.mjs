import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { runDirectMigrationCommand, migration36Filename } from "./supabase-direct-migration-command.mjs";

const migrationPath = `supabase/migrations/${migration36Filename}`;
const fixturePath = "scripts/migration36-remote-rollback-fixture.sql";
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = async (name, value, flag) => writeFile(`artifacts/supervised-cycle-12f9b-${name}.json`, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", ...(flag ? { flag } : {}) });

/** The CLI surrounds its JSON with connection/version messages. Parse one complete object, never evaluate it. */
export function parseCliJson(output) {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("M36_CLI_JSON_MISSING");
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return JSON.parse(output.slice(start, index + 1));
  }
  throw new Error("M36_CLI_JSON_INCOMPLETE");
}

export function assertOnlyM36DryRun(output) {
  const files = [...new Set(output.match(/\b\d{14}_[a-zA-Z0-9_]+\.sql\b/g) ?? [])];
  if (files.length !== 1 || files[0] !== migration36Filename) throw new Error("M36_DRY_RUN_NOT_EXACTLY_ONE_MIGRATION");
  return files;
}

async function checkedCommand(operation, name) {
  const result = await runDirectMigrationCommand(operation);
  await writeFile(`artifacts/supervised-cycle-12f9b-${name}.txt`, result.output);
  if (result.code !== 0) { process.stderr.write(result.output); throw new Error(`M36_${name.toUpperCase()}_FAILED:${result.code}`); }
  return result.output;
}

async function verifyDryRun() {
  const output = await checkedCommand("push-dry-run", "dry-run");
  const files = assertOnlyM36DryRun(output);
  const proof = { status: "PASS", files, onlyM36Pending: true, migrationSha256: await digest(migrationPath), capturedAtUtc: new Date().toISOString() };
  await save("dry-run", proof);
  return proof;
}

async function assertDryRunProof() {
  const proof = await readJson("artifacts/supervised-cycle-12f9b-dry-run.json");
  if (proof.status !== "PASS" || !proof.onlyM36Pending || proof.migrationSha256 !== await digest(migrationPath)) throw new Error("M36_DRY_RUN_PROOF_STALE");
}

async function main() {
  const action = process.argv[2];
  if (action === "dry-run") { console.log(JSON.stringify(await verifyDryRun())); return; }
  if (["acl-before", "acl-after"].includes(action)) {
    const output = await checkedCommand("m36-acl", action);
    const proof = parseCliJson(output).rows?.[0]?.migration36_evidence;
    if (!proof?.rpc || proof.rpc.serviceRoleExecute !== true || proof.rpc.publicExecute !== false || proof.rpc.anonExecute !== false || proof.rpc.authenticatedExecute !== false || proof.rpc.securityDefiner !== true || JSON.stringify(proof.rpc.settings) !== JSON.stringify(["search_path=pg_catalog, public, pg_temp"])) throw new Error("M36_ACL_FAILED");
    if (action === "acl-before" && (proof.head !== "20261014120000" || proof.m35Count !== 1 || proof.m36Count !== 0)) throw new Error("M36_UNEXPECTED_PRE_MIGRATION_HEAD");
    if (action === "acl-after" && (proof.head !== "20261015120000" || proof.m35Count !== 1 || proof.m36Count !== 1 || !proof.rpc.m36PredicatePresent)) throw new Error("M36_REMOTE_MIGRATION_NOT_PROVEN");
    if (action === "acl-after") {
      const migration = await readFile(migrationPath, "utf8");
      const body = migration.split("as $function$")[1]?.split("$function$;")[0];
      if (!body || proof.rpc.bodyHashLfMd5 !== createHash("md5").update(body.replaceAll("\r", "")).digest("hex")) throw new Error("M36_REMOTE_FUNCTION_BODY_MISMATCH");
    }
    await save(action, proof);
    console.log(JSON.stringify({ action, head: proof.head, acl: "PASS", legacyRowsObserved: proof.legacyRowsObserved, legacyRowsCountedUnderM36Predicate: proof.legacyRowsCountedAsCurrentPendingUnderM36, predicateDeployed: proof.rpc.m36PredicatePresent }));
    return;
  }
  if (action === "preview") {
    await assertDryRunProof();
    await checkedCommand("m36-preview", "preview");
    const proof = { status: "PASS", validation: "POSTGRESQL_ROLLED_BACK_DDL_AND_14_CASES", migrationSha256: await digest(migrationPath), fixtureSha256: await digest(fixturePath), capturedAtUtc: new Date().toISOString() };
    await save("preview", proof); console.log(JSON.stringify(proof)); return;
  }
  if (action === "apply") {
    await assertDryRunProof();
    const preview = await readJson("artifacts/supervised-cycle-12f9b-preview.json");
    const gates = await readJson("artifacts/supervised-cycle-12f9b-gates.json");
    if (preview.status !== "PASS" || preview.migrationSha256 !== await digest(migrationPath) || preview.fixtureSha256 !== await digest(fixturePath)) throw new Error("M36_PREVIEW_PROOF_STALE");
    if (!gates.allPass || gates.migrationSha256 !== await digest(migrationPath)) throw new Error("M36_LOCAL_GATES_REQUIRED");
    await verifyDryRun();
    await save("apply-attempt", { invocations: 1, startedAtUtc: new Date().toISOString(), migrationSha256: await digest(migrationPath) }, "wx");
    const output = await checkedCommand("push", "apply");
    await save("apply", { status: "PASS", invocations: 1, migration: migration36Filename, migrationSha256: await digest(migrationPath), capturedAtUtc: new Date().toISOString(), output });
    console.log("M36_APPLIED_ONCE"); return;
  }
  if (action === "fixture") {
    const acl = await readJson("artifacts/supervised-cycle-12f9b-acl-after.json");
    if (acl.m36Count !== 1 || !acl.rpc.m36PredicatePresent) throw new Error("M36_DEPLOYMENT_PROOF_REQUIRED");
    const output = await checkedCommand("m36-fixture", "fixture");
    await save("fixture", { status: "PASS", cases: 14, validation: "POSTGRESQL_AFTER_M36_WITH_ROLLBACK", fixtureSha256: await digest(fixturePath), output });
    console.log("M36_REMOTE_FIXTURE_PASS 14 cases; all synthetic writes rolled back"); return;
  }
  if (action === "residual") {
    const output = await checkedCommand("m36-residual", "residual");
    const proof = parseCliJson(output).rows?.[0]?.migration36_residuals;
    if (!proof || Object.values(proof).some((count) => count !== 0)) throw new Error("M36_SYNTHETIC_RESIDUE");
    await save("residual", proof); console.log(JSON.stringify(proof)); return;
  }
  throw new Error("M36_OPERATION_INVALID");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : "M36_VALIDATION_FAILED"); process.exitCode = 1; });
