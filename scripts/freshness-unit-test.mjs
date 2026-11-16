import assert from "node:assert/strict";
import { evaluateContentFreshness, resolveContentFreshnessTimestamp, applyExtractionFreshness, freshExtractionResults } from "../lib/agents/extraction/freshness-policy.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";

const reference = new Date("2026-09-22T21:03:27.228Z");
const base = (overrides = {}) => ({ sourceItemId: "source-item", rawItemId: "00000000-0000-0000-0000-000000000001", publishedAt: "2026-09-22T11:03:27.228Z", discoveredAt: reference.toISOString(), ...overrides });
const decision = (input, hours = 48) => evaluateContentFreshness(base(input), reference, hours);

assert.equal(decision().eligible, true); // fresh published timestamp
assert.equal(decision({ publishedAt: null }).eligible, true); // discoveredAt fallback
assert.equal(decision({ publishedAt: "2026-09-15T21:03:27.228Z" }).eligible, false); // old published/new discovered
assert.equal(decision({ publishedAt: "2026-09-20T21:03:27.228Z" }, 48).eligible, true); // 48h boundary
assert.equal(decision({ publishedAt: "2026-09-20T21:03:27.227Z" }, 48).eligible, false); // boundary - 1ms
assert.equal(decision({ publishedAt: "2026-09-16T17:00:00Z", discoveredAt: "2026-09-22T21:03:27.228Z" }, 48).reason, "OUTSIDE_FRESHNESS_WINDOW"); // current regression
assert.equal(decision({ publishedAt: "not-a-date" }).reason, "INVALID_PUBLISHED_AT");
assert.equal(decision({ publishedAt: "2026-09-23T00:00:00Z" }).reason, "FUTURE_PUBLISHED_AT");
assert.equal(decision({ publishedAt: null, discoveredAt: null }).reason, "MISSING_FRESHNESS_TIMESTAMP");
assert.equal(decision({ publishedAt: "2026-09-21T21:03:27.227Z" }, 24).eligible, false); // 24h policy
assert.equal(decision({ publishedAt: "2026-09-19T21:03:27.228Z" }, 72).eligible, true); // 72h policy
assert.equal(resolveContentFreshnessTimestamp({ publishedAt: "2026-09-16T17:00:00Z", discoveredAt: reference.toISOString() }, reference).timestamp, "2026-09-16T17:00:00.000Z");

const extraction = { startedAt: reference.toISOString(), finishedAt: reference.toISOString(), hours: 48, limit: 1, candidatesSelected: 1, results: [{ candidate: { ...validFixtures.DiscoveryCandidate, externalId: "enrichment-case", publishedAt: "2026-09-22T00:00:00Z", discoveredAt: reference.toISOString() }, status: "success", quality: "full", item: { ...validFixtures.ExtractedItem, candidateId: "enrichment-case", publishedAt: "2026-09-16T17:00:00Z" }, contentLength: 200, error: null, durationMs: 1, rawItemId: "00000000-0000-0000-0000-000000000001" }], full: 1, partial: 0, metadataOnly: 0, blocked: 0, failed: 0, averageContentLength: 200, persisted: 0, persistSkipped: 0, persistErrors: 0, traceability: [] };
const evaluated = applyExtractionFreshness(extraction, reference, 48);
assert.equal(evaluated.freshness.decisions[0].effectiveFreshnessAt, "2026-09-16T17:00:00.000Z");
assert.equal(evaluated.freshness.decisions[0].eligible, false);
assert.equal(freshExtractionResults(evaluated).length, 0);
console.log(JSON.stringify({ status: "SUCCESS", cases: 13, publishedAtPrecedence: true, discoveredAtFallback: true, extractionEnrichmentRegression: true, groqCalls: 0 }));
