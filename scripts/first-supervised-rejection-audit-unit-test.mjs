import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { assessExtractionEvidence, assessCandidateEvidence, extractionEvidenceInsufficient } from "../lib/agents/extraction/evidence-quality.ts";
import { hashContent } from "../lib/agents/extraction/content-hash.ts";
import { createOfflineStages, offlineClusterResult, offlineDiscoveryResult, offlineExtractionResult } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, createStaticPipelineQuota } from "../lib/agents/pipeline/index.ts";
import { mitEvidence, qualityCorpus } from "./discovery-evidence-quality-fixtures.mjs";

for (const fixture of qualityCorpus) {
  const result = assessExtractionEvidence(fixture.item);
  console.log(JSON.stringify({ id: fixture.id, expected: fixture.expected, ...result }));
  if (fixture.expected !== null) assert.equal(result.eligible, fixture.expected, fixture.id);
}
assert.equal(mitEvidence.content.length, 703);
assert.equal(assessExtractionEvidence(mitEvidence).reason, "NO_CANDIDATE_RELATION");
assert.notEqual(hashContent(qualityCorpus.find((f) => f.id === "changed-corporate-block").item.content), hashContent(mitEvidence.content));
assert.deepEqual(assessExtractionEvidence({ ...mitEvidence, canonicalUrl: "https://different.example/changed", contentHash: "different", metadata: { sourceName: "Different source" } }), assessExtractionEvidence(mitEvidence));
assert.equal(assessCandidateEvidence(mitEvidence.title, [mitEvidence, validFixtures.ExtractedItem]).eligible, true);
assert.equal(existsSync(new URL("../lib/agents/extraction/non-editorial-content.ts", import.meta.url)), false);
const productionGate = readFileSync(new URL("../lib/agents/extraction/evidence-quality.ts", import.meta.url), "utf8");
assert.doesNotMatch(productionGate, /technologyreview|MIT Technology|a18068e7055|hashContent|hostname|sourceName|sourceId/);
assert.doesNotMatch(readFileSync(new URL("../lib/agents/pipeline/create-production-pipeline.ts", import.meta.url), "utf8"), /isKnownNonEditorialExtraction|non-editorial-content/);

async function run(item, canonicalTitle, scenario = {}, includeSecond = false, mode = "supervised") {
  const fixture = createOfflineStages(scenario);
  const firstItem = { ...structuredClone(validFixtures.ExtractedItem), ...item };
  const firstEvent = { ...structuredClone(validFixtures.ClusteredEvent), canonicalTitle };
  const secondItem = { ...structuredClone(validFixtures.ExtractedItem), candidateId: "second-candidate", canonicalUrl: "https://example.com/second", url: "https://example.com/second" };
  const secondEvent = { ...structuredClone(validFixtures.ClusteredEvent), eventKey: "second-event", canonicalTitle: "Second distinct event", sourceItems: [{ ...validFixtures.ClusteredEvent.sourceItems[0], candidateId: secondItem.candidateId }] };
  fixture.stages.discovery = async () => ({ ...offlineDiscoveryResult, candidatesDiscovered: includeSecond ? 2 : 1 });
  fixture.stages.extraction = async () => ({ ...offlineExtractionResult, results: [{ ...offlineExtractionResult.results[0], item: firstItem }, ...(includeSecond ? [{ ...offlineExtractionResult.results[0], item: secondItem }] : [])] });
  fixture.stages.clustering = async () => ({ ...offlineClusterResult, events: [firstEvent, ...(includeSecond ? [secondEvent] : [])] });
  const registry = new InMemoryPipelineEventAttemptRegistry();
  let reviews = 0;
  const options = { stages: fixture.stages, quota: createStaticPipelineQuota(6), attemptRegistry: registry, humanReviewGateway: { async createReview() { reviews += 1; throw new Error("review prohibited on rejection"); } }, now: () => new Date("2026-09-16T12:00:00Z"), config: { mode, dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false } };
  const result = await new PipelineOrchestrator({ ...options, runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }).run();
  return { result, fixture, registry, options, reviews };
}
for (const mode of ["supervised", "standard"]) {
  const rejected = await run(mitEvidence, mitEvidence.title, {}, true, mode);
  assert.equal(rejected.result.eventsAttempted, 1, "bad selected candidate consumes this run's slot");
  assert.equal(rejected.result.eventResults[0].stopReason, extractionEvidenceInsufficient);
  assert.equal(rejected.result.eventResults[0].stopStage, "extraction");
  assert.equal(rejected.result.providerRequestsUsed, 0);
  assert.deepEqual(rejected.fixture.calls, [], "no Verifier, downstream, Publisher or replacement");
  assert.equal(rejected.reviews, 0);
  assert.equal(rejected.result.eventsAwaitingHumanReview, 0);
  assert.equal(rejected.registry.snapshot().length, 1);
  assert.equal(rejected.registry.snapshot()[0].finalState, "REJECTED");
  assert.equal(rejected.registry.snapshot()[0].countsTowardRetryLimit, false);
  assert.equal(rejected.registry.snapshot()[0].nextEligibleAt, null);
  assert.equal((await rejected.registry.getEligibility([validFixtures.ClusteredEvent.eventKey], rejected.options.now())).get(validFixtures.ClusteredEvent.eventKey).reason, "PERMANENT_OUTCOME");
}
const verifierRejected = await run(validFixtures.ExtractedItem, validFixtures.ClusteredEvent.canonicalTitle, { verifier: "skip" }, true);
assert.equal(verifierRejected.result.eventsAttempted, 1);
assert.deepEqual(verifierRejected.fixture.calls, ["verifier"]);
assert.equal(verifierRejected.reviews, 0);
assert.equal(verifierRejected.result.eventResults[0].stopReason, "SKIPPED_VERIFICATION_INSUFFICIENT");
assert.equal(verifierRejected.registry.snapshot()[0].finalState, "VERIFICATION_INSUFFICIENT");
console.log(`Generic quality corpus: ${qualityCorpus.length} cases; typed zero-dispatch terminal and no replacement PASS`);
