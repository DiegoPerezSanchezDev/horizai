import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runDirectMigrationCommand, migration37Filename } from "./supabase-direct-migration-command.mjs";
import { parseCliJson } from "./migration36-validation-runner.mjs";

const prefix = "artifacts/supervised-cycle-12f12i-";
const migrationPath = `supabase/migrations/${migration37Filename}`;
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const read = (name) => JSON.parse(readFileSync(`${prefix}${name}.json`, "utf8"));
const save = (name, data, flag) => writeFileSync(`${prefix}${name}.json`, JSON.stringify(data, null, 2) + "\n", flag ? { flag } : undefined);
export function assertOnlyM37DryRun(output) {
  const files = [...new Set(output.match(/\b\d{14}_[a-zA-Z0-9_]+\.sql\b/g) ?? [])];
  assert.deepEqual(files, [migration37Filename], "M37_DRY_RUN_NOT_EXACTLY_ONE_MIGRATION");
  return files;
}
async function command(operation, name) {
  const result = await runDirectMigrationCommand(operation);
  writeFileSync(`${prefix}${name}.txt`, result.output);
  assert.equal(result.code, 0, `M37_${name}_FAILED`);
  return result.output;
}
export async function captureAcl(action) {
  const proof = parseCliJson(await command("m37-acl", action)).rows?.[0]?.migration37_evidence;
  assert.ok(proof); assert.equal(proof.functions.length, 3);
  for (const f of proof.functions) {
    assert.equal(f.securityDefiner, true); assert.deepEqual(f.settings, ["search_path=pg_catalog, public"]);
    assert.deepEqual([f.serviceRoleExecute, f.publicExecute, f.anonExecute, f.authenticatedExecute], [true, false, false, false]);
  }
  assert.ok(Object.values(proof.reviewTableSelect).every((value) => value === false));
  assert.equal(proof.storedLineageProof.digestMatches, true); assert.equal(proof.storedLineageProof.manifestMatches, true);
  const inspect = proof.functions.find((f) => f.signature.includes("_inspect("));
  if (action === "acl-before") {
    assert.deepEqual([proof.head, proof.m36Count, proof.m37Count, inspect.sourceLineageProjection], ["20261015120000", 1, 0, false]);
  } else {
    assert.deepEqual([proof.head, proof.m36Count, proof.m37Count, inspect.sourceLineageProjection], ["20261020120000", 1, 1, true]);
    const before = read("acl-before");
    for (const field of ["tableAclsHash", "otherFunctionsHash", "editorialHashes", "storedLineageProof"]) assert.deepEqual(proof[field], before[field], `M37_UNEXPECTED_CHANGE:${field}`);
    for (const f of before.functions.filter((f) => !f.signature.includes("_inspect("))) assert.deepEqual(proof.functions.find((other) => other.signature === f.signature), f);
    const body = readFileSync(migrationPath, "utf8").split("as $function$")[1]?.split("$function$;")[0];
    assert.ok(body); assert.equal(inspect.bodyHashLfMd5, createHash("md5").update(body.replaceAll("\r", "")).digest("hex"));
  }
  save(action, proof);
  return proof;
}
async function main(action) {
  if (action === "acl-before" || action === "acl-after" || action === "acl-final") {
    const proof = await captureAcl(action); console.log(JSON.stringify({ action, head: proof.head, acl: "PASS", editorialHashes: proof.editorialHashes })); return;
  }
  if (action === "dry-run") {
    const files = assertOnlyM37DryRun(await command("push-dry-run", "dry-run"));
    save("dry-run", { status: "PASS", files, migrationSha256: sha(migrationPath) }); console.log("M37_ONLY_PENDING"); return;
  }
  if (action === "apply") {
    const gates = read("local-gates"); assert.equal(gates.status, "PASS", "LOCAL_GATES_REQUIRED");
    for (const [path, hash] of Object.entries(gates.sourceHashes)) assert.equal(sha(path), hash, `GATED_SOURCE_CHANGED:${path}`);
    assert.equal(read("dry-run").migrationSha256, sha(migrationPath));
    await captureAcl("acl-before");
    assertOnlyM37DryRun(await command("push-dry-run", "apply-dry-run"));
    save("apply-attempt", { invocations: 1, migrationSha256: sha(migrationPath), startedAtUtc: new Date().toISOString() }, "wx");
    await command("push", "apply");
    save("apply", { status: "PASS", invocations: 1, migration: migration37Filename, migrationSha256: sha(migrationPath), completedAtUtc: new Date().toISOString() });
    console.log("M37_APPLIED_ONCE"); return;
  }
  throw new Error("M37_INVALID_ACTION");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]).catch((error) => { console.error(error instanceof Error ? error.message : "M37_VALIDATION_FAILED"); process.exitCode = 1; });
