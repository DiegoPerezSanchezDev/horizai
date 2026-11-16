import assert from "node:assert/strict";
import { captureConstructionFailure, runWithConstructionDiagnostics } from "../lib/agents/pipeline/construction-diagnostics.ts";

const cause = new Error(["cause detail; ", "AGENT_API_KEY=", "synthetic-groq-secret-123"].join(""));
cause.code = "ECAUSE";
const syntheticDbPassword = "synthetic-db-password-123";
const syntheticDbCredential = ["post", "gres://", "dbuser:", syntheticDbPassword, "@db.invalid/app"].join("");
const errorMessage = ["failed with ", "SUPABASE_SECRET_KEY=", "synthetic-supabase-secret-123", "; Authorization: Bearer ", "synthetic-bearer-secret-123", "; ", syntheticDbCredential].join("");
const error = new Error(errorMessage, { cause });
error.name = "PipelineSetupError";
error.code = "EPIPELINE";
const diagnostic = captureConstructionFailure({
  error,
  componentStep: "provider.client",
  timestamp: "2026-10-20T12:00:00.000Z",
  entrypoint: "probe.mjs",
  secretValues: ["synthetic-supabase-secret-123", "synthetic-bearer-secret-123", "synthetic-groq-secret-123", syntheticDbPassword],
});
const serialized = JSON.stringify(diagnostic);
assert.equal(diagnostic.phase, "PIPELINE_CONSTRUCTION");
assert.equal(diagnostic.componentStep, "provider.client");
assert.equal(diagnostic.error.name, "PipelineSetupError");
assert.match(diagnostic.error.message, /EPIPELINE|failed with/);
assert.equal(diagnostic.error.code, "EPIPELINE");
assert.equal(diagnostic.error.causeChain[0].name, "Error");
assert.equal(diagnostic.error.causeChain[0].code, "ECAUSE");
assert.equal(diagnostic.timestamp, "2026-10-20T12:00:00.000Z");
assert.equal(diagnostic.runtime.nodeVersion.startsWith("v"), true);
assert.equal(diagnostic.runtime.entrypoint, "probe.mjs");
assert.match(diagnostic.error.stackFingerprint, /^[a-f0-9]{64}$/);
for (const secret of ["synthetic-supabase-secret-123", "synthetic-bearer-secret-123", "synthetic-groq-secret-123", syntheticDbPassword]) assert.equal(serialized.includes(secret), false, `secret leaked: ${secret}`);
assert.match(diagnostic.error.message, /Authorization: Bearer \[REDACTED\]/);
assert.match(diagnostic.error.message, /postgres:\/\/\[REDACTED\]@/);

const thrown = captureConstructionFailure({ error: { token: "object-secret-456" }, secretValues: ["object-secret-456"] });
assert.equal(thrown.error.name, "NonErrorThrow");
assert.equal(JSON.stringify(thrown).includes("object-secret-456"), false);

let failureCalled = false;
const expected = { constructed: true };
const result = runWithConstructionDiagnostics({
  componentStep: () => "pipeline.factory",
  action: () => expected,
  onFailure: () => { failureCalled = true; },
});
assert.equal(result, expected, "successful construction return value must pass through unchanged");
assert.equal(failureCalled, false, "successful construction must not invoke diagnostic failure handling");

console.log("construction-diagnostics-unit-test: PASS");
