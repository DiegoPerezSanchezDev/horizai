import assert from "node:assert/strict";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { clusterExtractedItems } from "../lib/agents/clustering/cluster-runner.ts";
import { applyExtractionFreshness, evaluateContentFreshness, freshExtractionResults } from "../lib/agents/extraction/freshness-policy.ts";
import { assessCandidateEvidence } from "../lib/agents/extraction/evidence-quality.ts";
import { InMemoryPipelineEventAttemptRegistry } from "../lib/agents/pipeline/event-attempt-repository.ts";
import { selectionPreflightContexts } from "../lib/agents/pipeline/selection-preflight.ts";

globalThis.fetch = async () => { throw new Error("OFFLINE_TEST_NETWORK_FORBIDDEN"); };
const now = new Date("2026-10-15T19:00:00.000Z");
const publishedAt = "2026-10-15T10:00:00.000Z";
const entry = (index, title = `Company ${index} announces research result ${index}`) => {
  const candidateId = `synthetic-preflight-${index}`;
  const url = `https://example.test/story/${index}`;
  const candidate = { ...validFixtures.DiscoveryCandidate, externalId: candidateId, url, titleOriginal: title, publishedAt, discoveredAt: now.toISOString() };
  const item = { ...validFixtures.ExtractedItem, candidateId, url, canonicalUrl: url, title, publishedAt, content: `${title} after engineers completed three independent laboratory trials and published their measurement methods for external review.`, metadata: { sourceId: candidate.sourceId, sourceName: candidate.sourceName, sourceCountryCode: "US", sourceRegionCode: "US" } };
  return { candidate, item, status: "success", quality: "full", contentLength: item.content.length, error: null, durationMs: 0, rawItemId: null };
};
const extraction = (results) => applyExtractionFreshness({ startedAt: now.toISOString(), finishedAt: now.toISOString(), hours: 24, limit: results.length, candidatesSelected: results.length, results, full: results.length, partial: 0, metadataOnly: 0, blocked: 0, failed: 0, averageContentLength: 100, persisted: 0, persistSkipped: 0, persistErrors: 0, traceability: [] }, now, 24);
const wrappers = Array.from({ length: 52 }, (_, index) => entry(index));
const snapshot = extraction(wrappers);
// An input-independent reproduction of the exact 12F.8C diagnostic error.
const events = wrappers.map((result, index) => ({ ...structuredClone(validFixtures.ClusteredEvent), eventKey: `synthetic-event-${index}`, canonicalTitle: result.item.title, sourceItems: [{ ...validFixtures.ClusteredEvent.sourceItems[0], candidateId: result.item.candidateId, publishedAt }] }));
const wrong = events.filter((event) => freshExtractionResults(snapshot).some((result) => event.sourceItems.some((source) => source.candidateId === result.candidateId)));
assert.equal(wrong.length, 0);
const contexts = selectionPreflightContexts(snapshot, events);
assert.equal(contexts.length, 52);
assert.ok(contexts.every((context) => context.items.length === 1 && context.items[0].candidateId === context.event.sourceItems[0].candidateId));
assert.throws(() => selectionPreflightContexts(snapshot, [{ ...events[0], sourceItems: [{ ...events[0].sourceItems[0], candidateId: "missing" }] }]), /PREFLIGHT_EVENT_ITEM_LINEAGE_MISSING/);
assert.ok(assessCandidateEvidence(contexts[0].event.canonicalTitle, contexts[0].items).eligible, "read-only missing raw IDs do not fabricate a quality rejection");

const history = (eventKey, finalState, extra = {}) => ({ id: `attempt-${eventKey}`, eventKey, pipelineRunId: `run-${eventKey}`, attemptNumber: 1, startedAt: now.toISOString(), completedAt: now.toISOString(), finalState, stopStage: "verifier", stopReason: "SYNTHETIC", retryClass: "NONE", countsTowardRetryLimit: false, nextEligibleAt: null, createdAt: now.toISOString(), ...extra });
const registry = new InMemoryPipelineEventAttemptRegistry([
  history("same", "REJECTED"), history("published", "READY_FOR_PUBLICATION"),
  history("active", null, { completedAt: null }),
  history("deferred", null, { completedAt: null, stopReason: "PROVIDER_CAPACITY_EXHAUSTED" }),
  history("aborted", "ABORTED"), history("safe-rejected", "REJECTED", { stopReason: "VERIFIER_INPUT_TOO_LARGE" }),
]);
const decisions = await registry.getEligibility(["new", "same", "published", "active", "deferred", "aborted", "safe-rejected", "unrelated-same-source"], now);
assert.equal(decisions.get("new").reason, "NEVER_ATTEMPTED");
for (const key of ["same", "published", "aborted", "safe-rejected"]) assert.equal(decisions.get(key).reason, "PERMANENT_OUTCOME");
assert.equal(decisions.get("active").reason, "ACTIVE");
assert.equal(decisions.get("deferred").reason, "RESUME_REQUIRED");
assert.equal(decisions.get("unrelated-same-source").eligible, true);
const first = entry(100, "Orion releases model version 3 for speech recognition");
const different = entry(101, "Orion opens a research laboratory for speech recognition");
const separate = clusterExtractedItems([first.item, different.item]).events;
assert.equal(separate.length, 2, "a shared topic does not merge materially different events");
assert.notEqual(separate[0].eventKey, separate[1].eventKey);
assert.equal(clusterExtractedItems([first.item]).events[0].eventKey, clusterExtractedItems([structuredClone(first.item)]).events[0].eventKey);
const freshness = (date) => evaluateContentFreshness({ sourceItemId: "synthetic", rawItemId: null, publishedAt: date, discoveredAt: now.toISOString() }, now, 24);
assert.equal(freshness("2026-10-13T10:00:00Z").reason, "OUTSIDE_FRESHNESS_WINDOW");
assert.equal(freshness(publishedAt).eligible, true);
assert.equal(freshness(null).eligible, true, "missing publication date uses the documented discovery timestamp");
assert.equal(freshness("2026-10-16T10:00:00Z").reason, "FUTURE_PUBLISHED_AT");
console.log(JSON.stringify({ status: "PASS", originalWrapperBugReproduced: true, clusteredEvents: 52, oldContexts: 0, correctedContexts: 52, policyAndIdentityCases: "PASS", providerCalls: 0, remoteWrites: 0 }));
