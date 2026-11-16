import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { buildMinimalTpmProbeBody, classifyProbeCapacity, diagnoseFreshIncidentSourceLineage, matchesDailyUsageDeltaAfterProbe, validateHistoricalMigration30Evidence } from "./factual-remediation-hot-path-12c2b2g3a.ts";
import { factualRemediationIncident } from "../lib/agents/pipeline/factual-remediation.ts";

const body = buildMinimalTpmProbeBody();
assert.deepEqual(Object.keys(body).sort(), ["max_completion_tokens", "messages", "model"]);
assert.equal(body.model, "openai/gpt-oss-20b");
assert.equal(body.max_completion_tokens, 1);
assert.deepEqual(body.messages, [{ role: "user", content: "Reply x." }]);
assert.equal("tools" in body, false);
assert.equal("response_format" in body, false);

const headers = (remainingTokens = "7000", limitTokens = "8000", resetTokens = "2s") => ({
  retryAfter: null,
  limitRequests: "1000",
  remainingRequests: "999",
  limitTokens,
  remainingTokens,
  resetRequests: "1d",
  resetTokens,
  retryAfterSeconds: null,
  resetRequestsSeconds: 86_400,
  resetTokensSeconds: 2,
});
const validProbe = {
  httpStatus: 200,
  returnedModel: "openai/gpt-oss-20b",
  responseFresh: true,
  responseSchemaValid: true,
  usageValid: true,
  headers: headers(),
  plannedCriticTokens: 6_397,
  configuredTpmLimit: 8_000,
};
assert.equal(classifyProbeCapacity(validProbe).decision, "IMMEDIATE");
assert.equal(classifyProbeCapacity({ ...validProbe, headers: headers("100") }).decision, "WAIT_FOR_TOKEN_RESET");
assert.equal(classifyProbeCapacity({ ...validProbe, headers: headers("7000", "16000") }).decision, "BLOCKED_TPM_STATE_UNKNOWN");
assert.equal(classifyProbeCapacity({ ...validProbe, headers: null }).decision, "BLOCKED_TPM_STATE_UNKNOWN");
assert.equal(classifyProbeCapacity({ ...validProbe, responseFresh: false }).decision, "BLOCKED_TPM_STATE_UNKNOWN");
assert.equal(classifyProbeCapacity({ ...validProbe, plannedCriticTokens: 8_000 }).decision, "REQUEST_TOO_LARGE_FOR_TPM");

const dailyBeforeAndAfterProbe = {
  requestsReservedBefore: 1,
  requestsDispatchedBefore: 1,
  tokensBefore: 75,
  requestsReservedAfter: 2,
  requestsDispatchedAfter: 2,
  tokensAfter: 150,
  probeTokens: 75,
  tokenUsageKnown: true,
  unknownTokenRequestsBefore: 0,
  unknownTokenRequests: 0,
};
assert.equal(matchesDailyUsageDeltaAfterProbe(dailyBeforeAndAfterProbe), true, "post-probe ledger validates one-call deltas over existing daily usage");
assert.equal(matchesDailyUsageDeltaAfterProbe({
  ...dailyBeforeAndAfterProbe,
  requestsReservedBefore: 9,
  requestsDispatchedBefore: 8,
  tokensBefore: 4_000,
  requestsReservedAfter: 10,
  requestsDispatchedAfter: 9,
  tokensAfter: 4_075,
}), true, "post-probe ledger validates arbitrary non-zero request and token baselines");
assert.equal(matchesDailyUsageDeltaAfterProbe({ ...dailyBeforeAndAfterProbe, requestsReservedAfter: 1 }), false, "post-probe ledger must add one reservation");
assert.equal(matchesDailyUsageDeltaAfterProbe({ ...dailyBeforeAndAfterProbe, tokensAfter: 75 }), false, "post-probe token total includes the pre-existing daily baseline");
assert.equal(matchesDailyUsageDeltaAfterProbe({ ...dailyBeforeAndAfterProbe, unknownTokenRequests: 1 }), false, "unknown token usage blocks continuation");
assert.equal(matchesDailyUsageDeltaAfterProbe({ ...dailyBeforeAndAfterProbe, unknownTokenRequestsBefore: 1, unknownTokenRequests: 0 }), false, "unknown dispatched reservations must remain unchanged");

const priorMigration30 = JSON.parse(readFileSync("artifacts/checkpoint-manifest-resume-remote-12c2b2f1a.json", "utf8"));
const migrationFiles = readdirSync("supabase/migrations").filter((name) => /^\d{14}_.*\.sql$/i.test(name));
const evidenceTime = statSync("artifacts/checkpoint-manifest-resume-remote-12c2b2f1a.json").mtimeMs;
const historicalMigrationNames = [
  "20260930211903_factual_remediation_lifecycle.sql",
  "20261002105220_factual_remediation_continuation.sql",
  "20261002150747_factual_remediation_continuation_fix.sql",
  "20261002211000_factual_remediation_continuation_resume.sql",
];
const historicalMigrationFilesPredateEvidence = historicalMigrationNames.every((name) =>
  migrationFiles.includes(name) && statSync(`supabase/migrations/${name}`).mtimeMs <= evidenceTime,
);
const historicEvidence = validateHistoricalMigration30Evidence(priorMigration30, migrationFiles, historicalMigrationFilesPredateEvidence);
assert.equal(historicEvidence.status, "PASS", "historic migration 30 evidence remains valid when a later migration is added");
assert.equal(historicEvidence.migration30InvariantsPreserved, true, "the historical migration 30 lifecycle and security invariants remain proven");
assert.deepEqual(historicEvidence.migration30Invariants, {
  sameAttemptResume: true,
  sameAuthorizationReuse: true,
  criticOnlyRestart: true,
  oneResumeProtection: true,
  serviceRoleIsolation: true,
  historicalStopAudit: true,
  noAttemptSix: true,
});
assert.equal(validateHistoricalMigration30Evidence({ ...priorMigration30, migration31Exists: true }, migrationFiles, historicalMigrationFilesPredateEvidence).status, "FAIL", "a historical artifact claiming migration 31 existed at capture time is inconsistent");
assert.equal(validateHistoricalMigration30Evidence(priorMigration30, migrationFiles.filter((name) => !name.includes("20261002211000")), historicalMigrationFilesPredateEvidence).status, "FAIL", "missing local migration 30 blocks execution");
assert.equal(validateHistoricalMigration30Evidence(priorMigration30, migrationFiles, false).status, "FAIL", "edits to historical migration SQL after evidence capture invalidate its chain");

const migration30Sql = readFileSync("supabase/migrations/20261002211000_factual_remediation_continuation_resume.sql", "utf8");
assert.match(migration30Sql, /create or replace function public\.resume_incident_factual_remediation_continuation[\s\S]*?security definer set search_path = pg_catalog, public/i, "migration 30 resume RPC keeps a fixed safe search_path");
const migration31Sql = readFileSync("supabase/migrations/20261005194000_supervised_human_review_gate.sql", "utf8");
assert.doesNotMatch(migration31Sql, /create(?:\s+or\s+replace)?\s+function\s+public\.resume_incident_factual_remediation_continuation\s*\(/i, "migration 31 does not replace the migration 30 continuation authorization RPC");

const expectedEventSource = {
  event_id: factualRemediationIncident.eventId,
  raw_item_id: factualRemediationIncident.rawItemId,
  source_id: factualRemediationIncident.sourceId,
};
const expectedRawItem = {
  id: factualRemediationIncident.rawItemId,
  source_id: factualRemediationIncident.sourceId,
  content_hash: factualRemediationIncident.rawContentHash,
  raw_content: "x".repeat(factualRemediationIncident.rawContentLength),
  extraction_quality: "full",
  processing_status: "extracted",
};
const expectedSource = { id: factualRemediationIncident.sourceId, name: "TechCrunch AI" };
const diagnoseLineage = (overrides = {}) => diagnoseFreshIncidentSourceLineage({
  eventSourceCount: 1,
  eventSources: [expectedEventSource],
  rawItem: expectedRawItem,
  source: expectedSource,
  ...overrides,
});
assert.deepEqual(diagnoseLineage(), {
  passed: true,
  eventSourceCount: 1,
  eventSourceIdentityMatches: true,
  rawItemMatches: true,
  sourceMatches: true,
  rawContentLengthCodePoints: factualRemediationIncident.rawContentLength,
});
assert.equal(diagnoseLineage({ eventSourceCount: 0, eventSources: [] }).passed, false, "zero lineage rows block preflight");
assert.equal(diagnoseLineage({ eventSourceCount: 2, eventSources: [expectedEventSource, expectedEventSource] }).passed, false, "duplicate lineage rows block preflight");
assert.equal(diagnoseLineage({ eventSources: [{ ...expectedEventSource, source_id: "different-source" }] }).passed, false);
assert.equal(diagnoseLineage({ rawItem: { ...expectedRawItem, source_id: "different-source" } }).passed, false);
assert.equal(diagnoseLineage({ rawItem: { ...expectedRawItem, content_hash: "sha256:changed" } }).passed, false);
assert.equal(diagnoseLineage({ rawItem: { ...expectedRawItem, raw_content: null } }).passed, false);
assert.equal(diagnoseLineage({ rawItem: { ...expectedRawItem, raw_content: "x".repeat(1755) } }).passed, false);
assert.equal(diagnoseLineage({ rawItem: { ...expectedRawItem, extraction_quality: "partial" } }).passed, false);
assert.equal(diagnoseLineage({ rawItem: { ...expectedRawItem, processing_status: "pending" } }).passed, false);
assert.equal(diagnoseLineage({ source: { ...expectedSource, name: "Different Source" } }).passed, false);

console.log("Final factual remediation capacity and incident lineage preflight fixtures passed");
