import assert from "node:assert/strict";
import { CriticAgent } from "../lib/agents/critic/critic-agent.ts";
import { attributedReportInput, canonicalCriticInput, criticScenarioFixtures, directReportInput, passGeneration, promptInjectionInput, secondaryAttributionInput, theVergeDirectReportInput, translationAttributionLossGeneration, translationAttributionLossInput, uncertaintyEscalationGeneration, unsupportedInternalDetailGeneration, unsupportedClaimGeneration, warningGeneration } from "../lib/agents/critic/critic-fixtures.ts";
import { criticGenerationSchema, criticInputSchema } from "../lib/agents/critic/critic-types.ts";
import { runCriticPrechecks } from "../lib/agents/critic/critic-prechecks.ts";
import { routeCritic } from "../lib/agents/critic/critic-router.ts";
import { criticResultSchema } from "../lib/agents/contracts/index.ts";
import { FreeTierLimitReachedError, StructuredOutputError, AgentTimeoutError, TransientProviderError, AgentError } from "../lib/agents/runtime/agent-errors.ts";
import { InMemoryAgentLogger, } from "../lib/agents/runtime/agent-logger.ts";
import { MockModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { createReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { buildCriticEvidenceCatalog, modelEvidenceCatalog, resolveCriticEvidenceRefs } from "../lib/agents/critic/critic-evidence-catalog.ts";
import { buildCriticModelInput } from "../lib/agents/critic/critic-input.ts";
import { estimateCriticV3Request, estimateCriticV4Request } from "../lib/agents/critic/critic-estimate.ts";

const registry = createReferenceRegistry(
  [
    { code: "GLOBAL", name: "Global", latitude: 20, longitude: 0 },
    { code: "US", name: "Estados Unidos", latitude: 39.8283, longitude: -98.5795 },
  ],
  [{ slug: "modelos", name: "Modelos" }],
);
const config = {
  model: "fixture-critic-model",
  timeoutMs: 100,
  maxRetries: 0,
  retryBackoffMs: 0,
  maxOutputTokens: 1200,
  dailyRequestLimit: 20,
  failOnRateLimit: true,
  allowPaidFallback: false,
  structuredOutputMode: "json_object",
  reasoningEffort: "low",
  includeReasoning: false,
};
const options = () => ({ modelConfig: config, registry, dryRun: true, requestBudget: new DailyRequestBudget(() => new Date("2026-09-14T12:00:00Z")) });

assert.equal(criticInputSchema.safeParse(canonicalCriticInput).success, true);
assert.equal(criticGenerationSchema.safeParse(passGeneration).success, true);
const exactCriticModelInput = buildCriticModelInput(canonicalCriticInput).input;
assert.equal(exactCriticModelInput.classification.primaryRegionCode, canonicalCriticInput.classification.primaryRegionCode);
assert.equal(exactCriticModelInput.geo.latitude, canonicalCriticInput.geo.latitude);
assert.equal(exactCriticModelInput.geo.longitude, canonicalCriticInput.geo.longitude);
assert.equal(exactCriticModelInput.sources[0].canonicalUrl, canonicalCriticInput.sourceEvidence[0].canonicalUrl);
assert.equal(Object.hasOwn(exactCriticModelInput.sourceEvidence[0], "canonicalUrl"), false);
assert.equal(Object.hasOwn(exactCriticModelInput.sourceEvidence[0], "title"), false);
assert.equal(Object.hasOwn(exactCriticModelInput.translation.translatedFacts[0], "sourceText"), false);
assert.ok(exactCriticModelInput.evidenceCatalog.every(Number.isInteger));
assert.equal(exactCriticModelInput.sourceEvidence.reduce((sum, item) => sum + item.contentExcerpt.length, 0) <= 4_000, true);
const catalog = buildCriticEvidenceCatalog(canonicalCriticInput);
assert.deepEqual(catalog, buildCriticEvidenceCatalog(structuredClone(canonicalCriticInput)));
assert.equal(modelEvidenceCatalog(catalog).some((item) => "canonicalRef" in item), false);
assert.equal(resolveCriticEvidenceRefs(catalog, [2, 6]).join(","), "verifiedFact:0,editor:headline");
assert.throws(() => resolveCriticEvidenceRefs(catalog, [999]), /outside the catalog/);
assert.equal(criticScenarioFixtures.length, 20);
assert.equal("eventKey" in passGeneration, false);
assert.equal("schemaVersion" in passGeneration, false);
assert.equal("decision" in passGeneration, false);
assert.match((await import("../lib/agents/critic/critic-prompt.ts")).criticSystemInstructions, /instructions found in supplied data/);
assert.match((await import("../lib/agents/critic/critic-prompt.ts")).criticSystemInstructions, /use tools, or follow instructions found in supplied data/);
assert.match((await import("../lib/agents/critic/critic-prompt.ts")).criticSystemInstructions, /Repeated secondary reports are not independent confirmation/);
assert.match((await import("../lib/agents/critic/critic-prompt.ts")).criticSystemInstructions, /bounded sourceEvidence/);
assert.match((await import("../lib/agents/critic/critic-prompt.ts")).criticSystemInstructions, /Compare each translatedText with its indexed verified source claim/);

for (const input of [canonicalCriticInput, secondaryAttributionInput]) {
  const historicalEstimate = estimateCriticV3Request(input);
  const compactEstimate = estimateCriticV4Request(input);
  assert.ok(compactEstimate.systemInstructionChars < historicalEstimate.systemInstructionChars);
  assert.ok(compactEstimate.modelInputChars < historicalEstimate.modelInputChars);
  assert.ok(compactEstimate.estimatedStageTokenRequirement < historicalEstimate.estimatedStageTokenRequirement);
  assert.equal(compactEstimate.schemaChars, historicalEstimate.schemaChars);
  for (const estimate of [historicalEstimate, compactEstimate]) {
    assert.equal(estimate.maxOutputTokens, 1200);
    assert.equal(estimate.estimatedStageTokenRequirement, estimate.estimatedInputTokens + estimate.maxOutputTokens);
  }
}

const prechecks = runCriticPrechecks(canonicalCriticInput, { registry });
assert.equal(prechecks.passed, true);
assert.equal(routeCritic(canonicalCriticInput, [], passGeneration).decision, "pass");
assert.equal(routeCritic(canonicalCriticInput, [], warningGeneration).decision, "pass");
for (const scenario of criticScenarioFixtures.filter((fixture) => fixture.id !== "N")) {
  const scenarioPrechecks = runCriticPrechecks(scenario.input, { registry });
  const scenarioRouting = routeCritic(scenario.input, scenarioPrechecks.issues, scenario.generation);
  assert.equal(scenarioRouting.decision, scenario.expectedDecision, `scenario ${scenario.id}: ${scenario.name}`);
}
assert.equal(routeCritic(canonicalCriticInput, [{ code: "FACTUAL", stage: "verification", severity: "high", message: "Fact needs review", evidenceRefs: [] }], { findings: [] }).decision, "revise_verification");
assert.equal(routeCritic(canonicalCriticInput, [{ code: "TRANSLATION", stage: "translation", severity: "high", message: "Translation drift", evidenceRefs: [] }, { code: "EDITOR", stage: "editorial", severity: "critical", message: "Editorial drift", evidenceRefs: [] }], { findings: [] }).decision, "revise_translation");
assert.equal(routeCritic(canonicalCriticInput, [{ code: "RANKING", stage: "ranking", severity: "critical", message: "Ranking mismatch", evidenceRefs: [] }], { findings: [] }).decision, "revise_ranking");

const runWith = async (input, generation, customConfig = config) => new CriticAgent(new MockModelProvider((request) => {
  assert.match(request.systemInstructions, /Audit pipeline outputs adversarially/);
  assert.ok(request.input.sourceEvidence.length > 0);
  assert.ok(request.input.sources.every((item) => item.canonicalUrl.startsWith("https://")));
  return generation;
}), new InMemoryAgentLogger()).critique(input, { ...options(), modelConfig: customConfig });

const pass = await runWith(canonicalCriticInput, passGeneration);
assert.equal(criticResultSchema.safeParse(pass.output).success, true);
assert.equal(pass.output.eventKey, canonicalCriticInput.event.eventKey);
assert.equal(pass.output.decision, "pass");
assert.equal(pass.output.schemaVersion, 1);
assert.equal(pass.diagnostics?.deterministicPrechecksPassed, true);
assert.equal(pass.diagnostics?.evidenceRefsValidated, true);
assert.equal(pass.attempts, 1);

const durablePassLogger = new InMemoryAgentLogger();
const durablePassAttemptId = "88888888-8888-4888-8888-888888888888";
const durablePass = await new CriticAgent(new MockModelProvider(() => passGeneration), durablePassLogger).critique(
  canonicalCriticInput,
  { ...options(), pipelineRunId: "99999999-9999-4999-8999-999999999999", attemptId: durablePassAttemptId },
);
const durablePassRun = durablePassLogger.runs[0];
assert.equal(durablePass.output.decision, "pass");
assert.equal(durablePassRun?.metadata.attemptId, durablePassAttemptId, "durable Critic run carries the owning event attempt");
assert.equal(durablePassRun?.status, "succeeded");
assert.equal(durablePassRun?.stats.telemetry.finalCriticResultValid, true, "human-review SQL proof is persisted under stats.telemetry");
assert.equal(durablePassRun?.stats.telemetry.deterministicPrechecksPassed, true);
assert.equal(durablePassRun?.stats.telemetry.finalDecision, "pass");

const certaintyEscalation = await runWith(secondaryAttributionInput, uncertaintyEscalationGeneration);
assert.equal(certaintyEscalation.output.decision, "revise_editorial");
assert.equal(certaintyEscalation.output.severity, "critical");
assert.equal(certaintyEscalation.providerRequestsUsed, 1);
const unsupportedInternalDetail = await runWith(secondaryAttributionInput, unsupportedInternalDetailGeneration);
assert.equal(unsupportedInternalDetail.output.decision, "revise_editorial");
assert.equal(unsupportedInternalDetail.output.unsupportedClaims.length, 1);
const translationAttributionLoss = await runWith(translationAttributionLossInput, translationAttributionLossGeneration);
assert.equal(translationAttributionLoss.output.decision, "revise_translation");
const directReport = await runWith(directReportInput, passGeneration);
assert.equal(directReport.output.decision, "pass", "a directly reported single-source fact is not rejected solely for source count");
assert.equal(theVergeDirectReportInput.verification.status, "single_source");
assert.equal(theVergeDirectReportInput.event.sourceCount, 1);
assert.equal(runCriticPrechecks(theVergeDirectReportInput).passed, true, "the reviewed The Verge direct-report case remains eligible with bounded evidence");
const theVergeRegression = await runWith(theVergeDirectReportInput, passGeneration);
assert.equal(theVergeRegression.output.decision, "pass", "The Verge's direct single-source report is not rejected solely for source count");
const attributedReport = await runWith(attributedReportInput, passGeneration);
assert.equal(attributedReport.output.decision, "pass", "a correctly attributed secondary report remains eligible for review");

for (const [stage, dimension, decision] of [
  ["verification", "FACTUAL_ACCURACY", "revise_verification"],
  ["translation", "TRANSLATION_FIDELITY", "revise_translation"],
  ["editorial", "NO_ADDED_FACTS", "revise_editorial"],
  ["classification", "ENTITY_ACCURACY", "revise_classification"],
  ["ranking", "RANKING_REASONABLENESS", "revise_ranking"],
]) {
  const result = await runWith(canonicalCriticInput, { findings: [{ kind: "issue", dimension, stage, severity: "high", message: "Concrete finding", evidenceIndices: [stage === "verification" ? 2 : stage === "translation" ? 4 : stage === "editorial" ? 10 : stage === "classification" ? 15 : 23] }] });
  assert.equal(result.output.decision, decision);
}

const rejectedInput = structuredClone(canonicalCriticInput);
rejectedInput.verification.status = "rejected";
const rejected = await runWith(rejectedInput, passGeneration);
assert.equal(rejected.output.decision, "reject");

const injection = await runWith(promptInjectionInput, passGeneration);
assert.equal(injection.output.decision, "pass");

assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "low", message: "Fact needs review", evidenceIndices: [2] }] }).success, true);
assert.equal(criticGenerationSchema.safeParse(unsupportedClaimGeneration).success, true);
assert.equal(criticGenerationSchema.safeParse({ findings: [
  { kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "high", message: "Fact needs review", evidenceIndices: [2, 3] },
  { kind: "unsupported_claim", claim: "The program will publish results.", reason: "Only a possibility is supported.", stage: "editorial", severity: "high", evidenceIndices: [10, 3] },
] }).success, true);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "unsupported_claim", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "high", message: "Wrong shape", evidenceIndices: [2] }] }).success, false);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "issue", claim: "Wrong field", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "high", message: "Wrong shape", evidenceIndices: [2] }] }).success, false);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "unknown", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "high", message: "Unknown kind", evidenceIndices: [2] }] }).success, false);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "high", message: "Extra field", evidenceIndices: [2], extra: true }] }).success, false);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "unsupported_claim", claim: "A claim", reason: "A reason", stage: "editorial", severity: "high", evidenceIndices: [10] }] }).success, true);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "high", message: "Canonical ref is forbidden", evidenceRefs: ["verifiedFact:0"], evidenceIndices: [2] }] }).success, false);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "high", message: "Duplicate index", evidenceIndices: [2, 2] }] }).success, false);
assert.equal(routeCritic(canonicalCriticInput, [], unsupportedClaimGeneration).decision, "revise_editorial");
assert.equal(criticResultSchema.safeParse({ schemaVersion: 1, eventKey: canonicalCriticInput.event.eventKey, decision: "pass", issues: [], unsupportedClaims: [], severity: "low", notes: "No issues." }).success, true);

const invalidGeneration = { findings: [{ kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "low", message: "bad", evidenceRefs: ["unknown:0"] }] };
assert.equal(criticGenerationSchema.safeParse(invalidGeneration).success, false);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "low", message: "float", evidenceIndices: [0.5] }] }).success, false);
assert.equal(criticGenerationSchema.safeParse({ findings: [{ kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "low", message: "string", evidenceIndices: ["editor:headline"] }] }).success, false);
const unknownEvidenceGeneration = { findings: [{ kind: "issue", dimension: "FACTUAL_ACCURACY", stage: "verification", severity: "low", message: "bad", evidenceIndices: [999] }] };
assert.equal(criticGenerationSchema.safeParse(unknownEvidenceGeneration).success, true);
await assert.rejects(() => runWith(canonicalCriticInput, unknownEvidenceGeneration), /outside the catalog/);

const noFacts = structuredClone(canonicalCriticInput);
noFacts.verification.verifiedFacts = [];
noFacts.translation.translatedFacts = [];
const noFactsPrecheck = runCriticPrechecks(noFacts, { registry });
assert.equal(noFactsPrecheck.passed, false);
assert.ok(noFactsPrecheck.issues.some((item) => item.code === "NO_VERIFIED_FACTS"));
let noFactsCalls = 0;
const noFactsResult = await new CriticAgent(new MockModelProvider(() => { noFactsCalls += 1; return passGeneration; }), new InMemoryAgentLogger()).critique(noFacts, options());
assert.equal(noFactsCalls, 0);
assert.equal(noFactsResult.output.decision, "revise_verification");
assert.equal(noFactsResult.attempts, 0);

const missingSourceEvidence = structuredClone(canonicalCriticInput);
missingSourceEvidence.sourceEvidence = [];
let missingEvidenceCalls = 0;
const missingEvidenceResult = await new CriticAgent(new MockModelProvider(() => { missingEvidenceCalls += 1; return passGeneration; }), new InMemoryAgentLogger()).critique(missingSourceEvidence, options());
assert.equal(missingEvidenceCalls, 0);
assert.equal(missingEvidenceResult.providerRequestsUsed, 0);
assert.equal(missingEvidenceResult.output.decision, "revise_verification");
assert.ok(missingEvidenceResult.prechecks.issues.some((item) => item.code === "SOURCE_EVIDENCE_MISSING"));

const wrongSourceEvidenceLineage = structuredClone(canonicalCriticInput);
wrongSourceEvidenceLineage.sourceEvidence[0].sourceItemId = "wrong-item";
assert.ok(runCriticPrechecks(wrongSourceEvidenceLineage, { registry }).issues.some((item) => item.code === "SOURCE_EVIDENCE_LINEAGE"));

const scoreMismatch = structuredClone(canonicalCriticInput);
scoreMismatch.ranking.result.importanceScore = 99;
assert.ok(runCriticPrechecks(scoreMismatch, { registry }).issues.some((item) => item.code === "RANKING_SCORE_MISMATCH"));
const translatedMismatch = structuredClone(canonicalCriticInput);
translatedMismatch.translation.translatedFacts.pop();
assert.ok(runCriticPrechecks(translatedMismatch, { registry }).issues.some((item) => item.code === "TRANSLATION_FACT_COVERAGE"));
const geoMismatch = structuredClone(canonicalCriticInput);
geoMismatch.classification.latitude = null;
geoMismatch.classification.longitude = null;
assert.ok(runCriticPrechecks(geoMismatch, { registry }).issues.some((item) => item.code === "GEO_PROVENANCE_MISMATCH"));
const globalRegionWithUsCoordinates = structuredClone(canonicalCriticInput);
globalRegionWithUsCoordinates.classification.primaryRegionCode = "GLOBAL";
assert.ok(runCriticPrechecks(globalRegionWithUsCoordinates, { registry }).issues.some((item) => item.code === "GEO_PROVENANCE_MISMATCH"));
const canonicalGlobalCoordinates = structuredClone(globalRegionWithUsCoordinates);
canonicalGlobalCoordinates.classification.latitude = 20;
canonicalGlobalCoordinates.classification.longitude = 0;
canonicalGlobalCoordinates.geo = { latitude: 20, longitude: 0, resolutionLevel: "global", resolvedFrom: "region_registry" };
assert.equal(runCriticPrechecks(canonicalGlobalCoordinates, { registry }).passed, true);
const unknownCategory = structuredClone(canonicalCriticInput);
unknownCategory.classification.categorySlugs = ["inventada"];
assert.ok(runCriticPrechecks(unknownCategory, { registry }).issues.some((item) => item.code === "UNKNOWN_CATEGORY"));
const unknownRegion = structuredClone(canonicalCriticInput);
unknownRegion.classification.primaryRegionCode = "MARS";
assert.ok(runCriticPrechecks(unknownRegion, { registry }).issues.some((item) => item.code === "UNKNOWN_REGION"));
const formulaMismatch = structuredClone(canonicalCriticInput);
formulaMismatch.ranking.formulaVersion = "ranking-v0";
assert.ok(runCriticPrechecks(formulaMismatch, { registry }).issues.some((item) => item.code === "RANKING_FORMULA_VERSION"));
const lineageMismatch = structuredClone(canonicalCriticInput);
lineageMismatch.editorial.eventKey = "different-event";
assert.ok(runCriticPrechecks(lineageMismatch, { registry }).issues.some((item) => item.code === "EVENT_KEY_MISMATCH"));

let rateLimitCalls = 0;
await assert.rejects(() => new CriticAgent(new MockModelProvider(() => { rateLimitCalls += 1; throw new FreeTierLimitReachedError(); }), new InMemoryAgentLogger()).critique(canonicalCriticInput, options()), FreeTierLimitReachedError);
assert.equal(rateLimitCalls, 1);
await assert.rejects(() => new CriticAgent(new MockModelProvider(() => passGeneration), new InMemoryAgentLogger()).critique(canonicalCriticInput, { ...options(), modelConfig: { ...config, allowPaidFallback: true } }), AgentError);

await assert.rejects(() => new CriticAgent(new MockModelProvider(() => new Promise(() => {})), new InMemoryAgentLogger()).critique(canonicalCriticInput, { ...options(), modelConfig: { ...config, timeoutMs: 5 } }), AgentTimeoutError);
let transientCalls = 0;
await assert.rejects(() => new CriticAgent(new MockModelProvider(() => { transientCalls += 1; throw new TransientProviderError("temporary fixture failure"); }), new InMemoryAgentLogger()).critique(canonicalCriticInput, { ...options(), modelConfig: { ...config, maxRetries: 2 } }), TransientProviderError);
assert.equal(transientCalls, 3);
await assert.rejects(() => runWith(canonicalCriticInput, invalidGeneration), StructuredOutputError);

console.log("Critic unit fixtures passed");
