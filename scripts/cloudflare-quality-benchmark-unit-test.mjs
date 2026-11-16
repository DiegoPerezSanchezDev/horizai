import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractedItemSchema } from "../lib/agents/contracts/index.ts";
import { canonicalCriticInput } from "../lib/agents/critic/critic-fixtures.ts";
import { buildCriticSourceEvidence } from "../lib/agents/critic/critic-input.ts";
import { hashContent } from "../lib/agents/extraction/content-hash.ts";
import {
  authorizeQualityBenchmarkCall,
  assertQualityBenchmarkCallCeiling,
  invokeExactlyOneQualityBenchmarkStage,
  parseQualityBenchmarkCliArgs,
  plannedQualityBenchmarkCalls,
  qualityBenchmarkFailureDispatchCount,
  qualityBenchmarkAccountingEventKey,
  qualityBenchmarkCases,
  qualityBenchmarkInputSha256,
  QUALITY_BENCHMARK_CASE_IDS,
  QUALITY_BENCHMARK_MODEL,
  QUALITY_BENCHMARK_PROVIDER,
  QUALITY_BENCHMARK_PURPOSE,
} from "../lib/agents/runtime/cloudflare-quality-benchmark.ts";
import {
  normalEventStages,
  supervisedValidationFixtureAllowlist,
  supervisedValidationAgentVersionAllowlist,
  validateSupervisedCloudflareStageValidation,
} from "../lib/agents/runtime/cloudflare-stage-validation.ts";
import { caseProvenanceManifest, prepareCurrentContractCriticStage, prepareStoredBenchmarkStage } from "./cloudflare-quality-benchmark-fixtures.ts";

const migration = readFileSync(new URL("../supabase/migrations/20260927000026_cloudflare_quality_benchmark_authorization.sql", import.meta.url), "utf8").toLowerCase();
const executor = readFileSync(new URL("./cloudflare-quality-benchmark.ts", import.meta.url), "utf8").toLowerCase();
const fixturesSource = readFileSync(new URL("./cloudflare-quality-benchmark-fixtures.ts", import.meta.url), "utf8").toLowerCase();
const remoteValidator = readFileSync(new URL("./cloudflare-quality-benchmark-authorization-remote-validation.ts", import.meta.url), "utf8").toLowerCase();

assert.deepEqual(parseQualityBenchmarkCliArgs([]), "PREFLIGHT_ONLY");
assert.deepEqual(parseQualityBenchmarkCliArgs(["--preflight"]), "PREFLIGHT_ONLY");
assert.deepEqual(parseQualityBenchmarkCliArgs(["--execute-quality-benchmark"]), "EXECUTE");
assert.throws(() => parseQualityBenchmarkCliArgs(["--execute-one-shot"]), /BLOCKED_UNKNOWN_OR_CONFLICTING_QUALITY_BENCHMARK_FLAGS/);
assert.throws(() => parseQualityBenchmarkCliArgs(["--execute-quality-benchmark", "--preflight"]), /BLOCKED_UNKNOWN_OR_CONFLICTING_QUALITY_BENCHMARK_FLAGS/);

assert.equal(plannedQualityBenchmarkCalls.length, 6);
assert.equal(plannedQualityBenchmarkCalls.some((call) => call.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.mitControl && call.stage === "critic"), false, "MIT remains historical only because it has no source-evidence lineage");
assertQualityBenchmarkCallCeiling(plannedQualityBenchmarkCalls);
assert.throws(() => assertQualityBenchmarkCallCeiling(Array(9).fill(null)), /BLOCKED_QUALITY_BENCHMARK_CALL_CEILING/);
assert.throws(() => assertQualityBenchmarkCallCeiling([], 9), /BLOCKED_QUALITY_BENCHMARK_CALL_CEILING/);
assert.equal(qualityBenchmarkFailureDispatchCount(undefined), 0);
assert.equal(qualityBenchmarkFailureDispatchCount(0), 0);
assert.equal(qualityBenchmarkFailureDispatchCount(1), 1);
assert.throws(() => qualityBenchmarkFailureDispatchCount(2), /BLOCKED_QUALITY_BENCHMARK_FAILURE_DISPATCH_COUNT/);
assert.equal(plannedQualityBenchmarkCalls.some((call) => call.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.mitControl && call.stage === "verifier"), false);

for (const call of plannedQualityBenchmarkCalls) {
  assert.equal(authorizeQualityBenchmarkCall({
    benchmarkCaseId: call.benchmarkCaseId,
    stage: call.stage,
    agentVersion: call.agentVersion,
    eventKey: qualityBenchmarkAccountingEventKey(call.benchmarkCaseId, call.stage),
    purpose: QUALITY_BENCHMARK_PURPOSE,
    provider: QUALITY_BENCHMARK_PROVIDER,
    model: QUALITY_BENCHMARK_MODEL,
    attempt: 1,
    maxRetries: 0,
    inputSha256: "sha256:" + "a".repeat(64),
  }).stage, call.stage);
}
const validArsCritic = plannedQualityBenchmarkCalls.find((call) => call.benchmarkCaseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem && call.stage === "critic");
assert.ok(validArsCritic);
const request = {
  benchmarkCaseId: validArsCritic.benchmarkCaseId,
  stage: validArsCritic.stage,
  agentVersion: validArsCritic.agentVersion,
  eventKey: qualityBenchmarkAccountingEventKey(validArsCritic.benchmarkCaseId, validArsCritic.stage),
  purpose: QUALITY_BENCHMARK_PURPOSE,
  provider: QUALITY_BENCHMARK_PROVIDER,
  model: QUALITY_BENCHMARK_MODEL,
  attempt: 1,
  maxRetries: 0,
};
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, benchmarkCaseId: "quality:unknown-v1" }), /CASE_STAGE_NOT_ALLOWLISTED/);
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, benchmarkCaseId: QUALITY_BENCHMARK_CASE_IDS.mitControl, stage: "verifier" }), /CASE_STAGE_NOT_ALLOWLISTED/);
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, provider: "groq" }), /PROVIDER_NOT_ALLOWLISTED/);
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, model: "@cf/openai/gpt-oss-20b" }), /MODEL_NOT_ALLOWLISTED/);
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, purpose: "critic_stage_validation" }), /PURPOSE_MISMATCH/);
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, agentVersion: "critic-v2" }), /AGENT_VERSION_MISMATCH/);
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, attempt: 2 }), /RETRY_POLICY/);
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, maxRetries: 1 }), /RETRY_POLICY/);
assert.throws(() => authorizeQualityBenchmarkCall({ ...request, inputSha256: "not-a-hash" }), /INPUT_HASH_INVALID/);

for (const stage of normalEventStages) {
  assert.equal(validateSupervisedCloudflareStageValidation({
    stage,
    fixture: supervisedValidationFixtureAllowlist[stage],
    provider: QUALITY_BENCHMARK_PROVIDER,
    model: QUALITY_BENCHMARK_MODEL,
    agentVersion: supervisedValidationAgentVersionAllowlist[stage],
    maxAttempts: 1,
    maxRetries: 0,
  }).validationPurpose, `${stage}_stage_validation`);
}
assert.throws(() => validateSupervisedCloudflareStageValidation({
  stage: "critic",
  fixture: QUALITY_BENCHMARK_CASE_IDS.arsProblem,
  provider: QUALITY_BENCHMARK_PROVIDER,
  model: QUALITY_BENCHMARK_MODEL,
  agentVersion: "critic-v3",
  maxAttempts: 1,
  maxRetries: 0,
}), /BLOCKED_FIXTURE_NOT_ALLOWLISTED/);

assert.equal(qualityBenchmarkInputSha256({ b: 2, a: { y: true, x: 1 } }), qualityBenchmarkInputSha256({ a: { x: 1, y: true }, b: 2 }));
assert.notEqual(qualityBenchmarkInputSha256({ facts: ["one", "two"] }), qualityBenchmarkInputSha256({ facts: ["two", "one"] }));

const invoked = [];
const stageInput = Object.fromEntries(normalEventStages.map((stage) => [stage, async () => {
  invoked.push(stage);
  return stage;
}]));
assert.equal(await invokeExactlyOneQualityBenchmarkStage("editor", { event: "stored" }, stageInput), "editor");
assert.deepEqual(invoked, ["editor"], "isolated dispatch invokes one production stage only");

assert.equal(qualityBenchmarkCases[QUALITY_BENCHMARK_CASE_IDS.arsProblem].historicalProviderProvenance, "CONFIRMED_GROQ");
assert.equal(qualityBenchmarkCases[QUALITY_BENCHMARK_CASE_IDS.mitControl].historicalProviderProvenance, "CONFIRMED_GROQ");
const arsManifest = caseProvenanceManifest(QUALITY_BENCHMARK_CASE_IDS.arsProblem);
const mitManifest = caseProvenanceManifest(QUALITY_BENCHMARK_CASE_IDS.mitControl);
assert.equal(arsManifest.sourceCount, 1);
assert.equal(mitManifest.sourceCount, 1);
assert.equal(mitManifest.rawItemTraceability, "MISSING");
assert.equal(mitManifest.criticControlUsable, false);
assert.equal(mitManifest.availableStageInputs.critic.readiness, "MISSING");
assert.match(mitManifest.availableStageInputs.critic.blocker, /no linked rawItemId/i);
assert.equal(mitManifest.availableHistoricalOutputs.critic.decision, "pass");
assert.equal(arsManifest.availableStageInputs.critic.readiness, "INPUT_CAN_BE_DETERMINISTICALLY_RECONSTRUCTED");
assert.equal(arsManifest.availableStageInputs.critic.inputSha256, null);
assert.equal(arsManifest.availableStageInputs.critic.hashStatus, "REQUIRES_EXACT_RAW_ITEM_READ");
assert.equal(arsManifest.availableStageInputs.critic.deterministicDiagnostics.sourceEvidenceStoredInCheckpoint, false);
assert.match(arsManifest.availableStageInputs.critic.blocker, /exact raw_items read/i);
assert.equal(arsManifest.availableHistoricalOutputs.critic.decision, "revise_editorial");
assert.equal(arsManifest.knownHistoricalCriticOutcome.decision, "revise_editorial");
assert.deepEqual(arsManifest.knownHistoricalCriticOutcome.findings, [{ code: "UNSUPPORTED_CLAIM_EDITORIAL", severity: "high" }]);
assert.equal(arsManifest.knownHistoricalCriticOutcome.evidenceRole, "HISTORICAL_REFERENCE_NOT_GOLD_LABEL");
assert.equal(arsManifest.copyrightSafeReviewRepresentation.factInventory.length, 2);
assert.equal(mitManifest.knownHistoricalCriticOutcome.decision, "pass");
assert.equal(mitManifest.knownHistoricalCriticOutcome.findingCount, 0);
assert.equal(arsManifest.availableStageInputs.verifier.readiness, "INPUT_CAN_BE_DETERMINISTICALLY_RECONSTRUCTED");
assert.equal(arsManifest.availableStageInputs.verifier.inputSha256, null);
assert.equal(mitManifest.availableStageInputs.verifier.readiness, "MISSING");
for (const stage of ["translator", "editor", "classifier", "ranker"]) {
  const first = prepareStoredBenchmarkStage(QUALITY_BENCHMARK_CASE_IDS.arsProblem, stage);
  const second = prepareStoredBenchmarkStage(QUALITY_BENCHMARK_CASE_IDS.arsProblem, stage);
  assert.equal(first.inputSha256, second.inputSha256, `${stage} input hash is stable`);
  assert.match(first.inputSha256, /^sha256:[a-f0-9]{64}$/);
}

assert.match(migration, /auth\.role\(\) is distinct from 'service_role'/);
assert.match(migration, /revoke all on function public\.reserve_cloudflare_quality_benchmark_capacity[\s\S]*from public, anon, authenticated/);
assert.match(migration, /grant execute on function public\.reserve_cloudflare_quality_benchmark_capacity[\s\S]*to service_role/);
assert.match(migration, /set search_path = pg_catalog, pg_temp/);
const syntheticEvidenceItems = canonicalCriticInput.sources.map((source, index) => {
  const evidence = canonicalCriticInput.sourceEvidence[index];
  return extractedItemSchema.parse({
    schemaVersion: 1,
    candidateId: source.sourceItemId,
    url: evidence.canonicalUrl,
    canonicalUrl: evidence.canonicalUrl,
    title: evidence.title,
    description: null,
    author: null,
    publishedAt: null,
    language: "en",
    content: evidence.contentExcerpt,
    contentHash: hashContent(evidence.contentExcerpt),
    metadata: { sourceId: source.sourceId },
    extractionQuality: "full",
  });
});
const syntheticSourceEvidence = buildCriticSourceEvidence(
  canonicalCriticInput.sources.map((source, index) => ({
    sourceId: source.sourceId,
    sourceItemId: source.sourceItemId,
    sourceUrl: canonicalCriticInput.sourceEvidence[index].canonicalUrl,
  })),
  syntheticEvidenceItems,
);
const syntheticCriticCheckpoint = { ...canonicalCriticInput };
delete syntheticCriticCheckpoint.sourceEvidence;
const syntheticCriticStage = prepareCurrentContractCriticStage(syntheticCriticCheckpoint, syntheticSourceEvidence);
assert.equal(syntheticCriticStage.prechecks.passed, true, "synthetic-only current-contract Critic input passes its deterministic prechecks");
assert.equal(syntheticCriticStage.input.sourceEvidence.length, canonicalCriticInput.sources.length);
assert.equal(syntheticCriticStage.modelInput.sourceEvidence.length, canonicalCriticInput.sources.length, "bounded evidence reaches the Critic model input");
assert.equal(syntheticCriticStage.modelInput.sourceEvidence[0].contentExcerpt, syntheticCriticStage.input.sourceEvidence[0].contentExcerpt, "the bounded source excerpt is carried once in the compact Critic input");
assert.ok(syntheticCriticStage.modelInput.evidenceCatalog.every(Number.isInteger), "the compact evidence catalog contains integer references without repeated previews");

assert.match(migration, /'quality_benchmark'/);
assert.match(migration, /'quality:ars-problematic-lineage-v1'/);
assert.match(migration, /'quality:mit-clean-control-v1'/);
assert.match(migration, /'@cf\/meta\/llama-3\.3-70b-instruct-fp8-fast'/);
assert.match(migration, /global eight-call ceiling/);
assert.doesNotMatch(migration, /create\s+table/i);
assert.doesNotMatch(migration, /execute\s+format/i);
assert.doesNotMatch(migration, /raw_content|article text|translatedsource/i);

const importLines = executor.split(/\r?\n/).filter((line) => line.startsWith("import ")).join("\n");
assert.doesNotMatch(importLines, /pipeline|scheduler|publisher|revision|production-attempt/i);
assert.doesNotMatch(executor, /pipeline_event_attempts|publish_article_atomic|createProductionPipeline|SchedulerExecution/i);
assert.ok(executor.includes("dryrun: true"));
assert.ok(executor.includes("qualitybenchmarkcases"));
assert.doesNotMatch(fixturesSource, /\.insert\(|\.update\(|\.delete\(/);
assert.match(remoteValidator, /p_run_id: null/);
assert.match(remoteValidator, /blocked_remote_validation_requires_exact_readonly_flag/);
assert.doesNotMatch(remoteValidator, /cloudflareworkersaimodelprovider|groqmodelprovider|cerebrasmodelprovider/);

const isolatedPlanDirectory = mkdtempSync(join(tmpdir(), "horizai-quality-benchmark-unit-"));
const isolatedPlanPath = join(isolatedPlanDirectory, "plan.json");
try {
  const defaultCli = spawnSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "scripts/cloudflare-quality-benchmark.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, HORIZAI_CLOUDFLARE_QUALITY_BENCHMARK_PLAN_PATH: isolatedPlanPath },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(defaultCli.status, 0, defaultCli.stderr);
  const defaultOutput = JSON.parse(defaultCli.stdout);
  assert.equal(defaultOutput.status, "PREFLIGHT_ONLY");
  assert.equal(defaultOutput.providerCalls, 0);
  assert.equal(defaultOutput.remoteReads, 0);
  assert.equal(defaultOutput.remoteWrites, 0);
  assert.equal(defaultOutput.planPath, isolatedPlanPath);
  assert.equal(existsSync(isolatedPlanPath), true);
} finally {
  if (existsSync(isolatedPlanPath)) unlinkSync(isolatedPlanPath);
  rmdirSync(isolatedPlanDirectory);
}
const unknownFlagCli = spawnSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "scripts/cloudflare-quality-benchmark.ts", "--execute-one-shot"], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 60_000,
});
assert.equal(unknownFlagCli.status, 1, "unknown CLI flags fail closed before any provider or database work");
assert.match(unknownFlagCli.stderr, /BLOCKED_UNKNOWN_OR_CONFLICTING_QUALITY_BENCHMARK_FLAGS/);
const remoteValidatorWithoutFlag = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/cloudflare-quality-benchmark-authorization-remote-validation.ts"], {
  cwd: process.cwd(),
  encoding: "utf8",
  timeout: 60_000,
});
assert.equal(remoteValidatorWithoutFlag.status, 1, "remote validation requires an explicit read-only flag");
assert.match(remoteValidatorWithoutFlag.stderr, /BLOCKED_REMOTE_VALIDATION_REQUIRES_EXACT_READONLY_FLAG/);
const artifact = JSON.parse(readFileSync(new URL("../artifacts/cloudflare-quality-benchmark-plan-10g7b1.json", import.meta.url), "utf8"));
assert.equal(artifact.migration.requirement, "MIGRATION_REQUIRED");
assert.equal(artifact.migration.applied, false);
assert.equal(artifact.migration.newTableRequired, false);
assert.equal(artifact.providerCallBudget.maximum, 8);
assert.equal(artifact.providerCallBudget.planned, 7);
assert.equal(artifact.plannedCalls.every((call) => call.historicalProviderProvenance === "CONFIRMED_GROQ"), true);
assert.equal(artifact.plannedCalls.every((call) => call.cloudflareOutput === "NOT_RUN" && call.humanDecision === "PENDING_NO_WINNER"), true);
assert.equal(artifact.limitations.realMultiSourceQualityEvidence, "MISSING");
assert.equal(artifact.gates.technicalAllStagesValidated, true);
assert.equal(artifact.gates.semanticQualityGateValidated, false);
assert.equal(artifact.gates.qualityBenchmarkCompleted, false);
assert.equal(artifact.gates.humanQualityDecisionRequired, true);
assert.equal(artifact.gates.productionRoutingEnabled, false);

console.log("cloudflare:quality-benchmark:unit: OK (offline only; default CLI 0 provider calls; no remote DB writes)");
