import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration28 = readFileSync(
  "supabase/migrations/20261002105220_factual_remediation_continuation.sql",
  "utf8",
);
const migration29Path =
  "supabase/migrations/20261002150747_factual_remediation_continuation_fix.sql";
const migration29 = readFileSync(migration29Path, "utf8");

function functionDefinition(sql) {
  const match = sql.match(
    /create or replace function public\.authorize_incident_factual_remediation_continuation\([\s\S]*?\n\$\$;/i,
  );
  assert.ok(match, "authorization function definition exists");
  return match[0];
}

const oldFunction = functionDefinition(migration28);
const repairedFunction = functionDefinition(migration29);
assert.equal(
  (migration28.match(/jsonb_object_length\s*\(/g) ?? []).length,
  2,
  "migration 28 has the two defective key-count calls described by the incident",
);
assert.doesNotMatch(
  repairedFunction,
  /jsonb_object_length\s*\(/i,
  "the executable repaired function does not depend on jsonb_object_length",
);
assert.match(
  repairedFunction,
  /\(select count\(\*\) from jsonb_object_keys\(p_checkpoint_manifest\)\) <> 6/i,
  "the repaired function counts exactly six root keys",
);
assert.match(
  repairedFunction,
  /\(select count\(\*\) from jsonb_object_keys\(p_checkpoint_manifest -> 'checkpoints'\)\) <> 5/i,
  "the repaired function counts exactly five checkpoint keys",
);
assert.match(repairedFunction, /jsonb_typeof\(p_checkpoint_manifest\) is distinct from 'object'/i);
assert.match(repairedFunction, /jsonb_typeof\(p_checkpoint_manifest -> 'checkpoints'\) is distinct from 'object'/i);
for (const stage of ["verifier", "translator", "editor", "classifier", "ranker"]) {
  assert.match(
    repairedFunction,
    new RegExp(`checkpoints,${stage}\\}', ''\\) !~ '\\^\\[0-9a-f\\]\\{64\\}\\$'`, "i"),
    `${stage} remains required as a lowercase SHA-256 digest`,
  );
}
assert.match(repairedFunction, /returns jsonb\s+language plpgsql security definer set search_path = pg_catalog, public/i);
assert.match(repairedFunction, /if auth\.role\(\) is distinct from 'service_role'/i);
assert.match(repairedFunction, /pg_advisory_xact_lock\(hashtextextended\(v_event_key, 0\)\)/i);
assert.match(repairedFunction, /for update/i);
assert.match(repairedFunction, /v_attempt\.continuation is not null/i);
assert.match(repairedFunction, /p_checkpoint_manifest ->> 'resumeStage' is distinct from 'critic'/i);
assert.match(repairedFunction, /p_checkpoint_manifest ->> 'criticCheckpoint' is distinct from 'absent'/i);
assert.equal(
  (migration29.match(/create or replace function/gi) ?? []).length,
  1,
  "migration 29 replaces only the affected function",
);
assert.match(migration29, /revoke all on function public\.authorize_incident_factual_remediation_continuation[\s\S]*?from public, anon, authenticated/i);
assert.match(migration29, /grant execute on function public\.authorize_incident_factual_remediation_continuation[\s\S]*?to service_role/i);
assert.match(migration29, /validation_namespace ~ '\^12c2b2d1\?:\[0-9a-f\]/i);
assert.match(repairedFunction, /\^12c2b2d1\?:\[0-9a-f\]/i);
assert.doesNotMatch(migration29.replace(repairedFunction, ""), /create table|insert into|update public\./i);

// Confirm that the forward function differs from migration 28 only in the two
// PostgreSQL-valid cardinality expressions and the phase-scoped test namespace.
const normalizedRepair = repairedFunction
  .replace(
    "(select count(*) from jsonb_object_keys(p_checkpoint_manifest))",
    "jsonb_object_length(p_checkpoint_manifest)",
  )
  .replace(
    "(select count(*) from jsonb_object_keys(p_checkpoint_manifest -> 'checkpoints'))",
    "jsonb_object_length(p_checkpoint_manifest -> 'checkpoints')",
  )
  .replaceAll("^12c2b2d1?:", "^12c2b2d:");
assert.equal(normalizedRepair, oldFunction, "all M28 function guards and behavior remain intact");

const stages = ["verifier", "translator", "editor", "classifier", "ranker"];
const validManifest = {
  schemaVersion: "1",
  eventKey: "event-synthetic",
  sourceRunId: "00000000-0000-4000-8000-000000000001",
  resumeStage: "critic",
  criticCheckpoint: "absent",
  checkpoints: Object.fromEntries(stages.map((stage) => [stage, "a".repeat(64)])),
};

function manifestPassesSqlContract(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).length !== 6) return false;
  if (
    value.schemaVersion !== "1" ||
    value.eventKey !== "event-synthetic" ||
    value.sourceRunId !== "00000000-0000-4000-8000-000000000001" ||
    value.resumeStage !== "critic" ||
    value.criticCheckpoint !== "absent"
  ) return false;
  const checkpoints = value.checkpoints;
  if (!checkpoints || typeof checkpoints !== "object" || Array.isArray(checkpoints)) return false;
  if (Object.keys(checkpoints).length !== 5) return false;
  return stages.every((stage) => typeof checkpoints[stage] === "string" && /^[0-9a-f]{64}$/.test(checkpoints[stage]));
}

assert.equal(manifestPassesSqlContract(validManifest), true, "valid six-key authorization manifest passes");
assert.equal(manifestPassesSqlContract({}), false, "empty authorization object is rejected");
assert.equal(manifestPassesSqlContract(null), false, "null authorization JSON is rejected");
assert.equal(manifestPassesSqlContract([]), false, "non-object authorization JSON is rejected");
assert.equal(manifestPassesSqlContract({ ...validManifest, unexpected: true }), false, "extra root key is rejected");
assert.equal(manifestPassesSqlContract({ ...validManifest, schemaVersion: undefined }), false, "missing required field is rejected");
assert.equal(manifestPassesSqlContract({ ...validManifest, checkpoints: [] }), false, "non-object checkpoint metadata is rejected");
assert.equal(manifestPassesSqlContract({ ...validManifest, checkpoints: { ...validManifest.checkpoints, extra: "b".repeat(64) } }), false, "extra checkpoint is rejected");
for (const stage of stages) {
  const checkpoints = { ...validManifest.checkpoints };
  delete checkpoints[stage];
  assert.equal(manifestPassesSqlContract({ ...validManifest, checkpoints }), false, `missing ${stage} checkpoint is rejected`);
  assert.equal(
    manifestPassesSqlContract({ ...validManifest, checkpoints: { ...validManifest.checkpoints, [stage]: "not-a-sha256" } }),
    false,
    `malformed ${stage} hash is rejected`,
  );
}

console.log("Migration 29 continuation authorization regression checks passed");
