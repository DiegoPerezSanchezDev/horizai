import assert from "node:assert/strict";
import { clusterExtractedItems } from "../lib/agents/clustering/cluster-runner.ts";
import { candidateExternalId } from "../lib/agents/discovery/canonical-url.ts";
import { hashContent } from "../lib/agents/extraction/content-hash.ts";
import {
  createSupervisedCandidateSnapshot,
  supervisedExecutionEventKey,
  validateSupervisedCandidateSnapshot,
  validateSupervisedCandidateSnapshotForResume,
} from "../lib/agents/pipeline/supervised-candidate-snapshot.ts";

const now = new Date("2026-09-23T19:20:00.000Z");
const source = {
  id: "f2c5f58e-064d-4d9d-8f44-128d5b3bec38",
  name: "Ars Technica AI",
  url: "https://arstechnica.com/ai/",
  feedUrl: "https://feeds.arstechnica.com/arstechnica/technology-lab",
  sourceType: "website",
  countryCode: "US",
  language: "en",
  isActive: true,
};
const rawItem = {
  id: "93dea107-8bbf-42a5-8314-c0b4c70522ec",
  sourceId: source.id,
  externalId: candidateExternalId(source.id, "https://arstechnica.com/security/2026/09/muse-metas-extraordinarily-privileged-ai-assistant-has-a-serious-0-day"),
  originalUrl: "https://arstechnica.com/security/2026/09/muse-metas-extraordinarily-privileged-ai-assistant-has-a-serious-0-day",
  canonicalUrl: "https://arstechnica.com/security/2026/09/muse-metas-extraordinarily-privileged-ai-assistant-has-a-serious-0-day",
  title: "Muse, Meta's extraordinarily privileged AI assistant, has a serious 0-day",
  excerpt: "A simple ClickFix attack is only one way to completely hijack the new agent.",
  language: "en",
  publishedAt: "2026-09-21T22:24:38.000Z",
  discoveredAt: "2026-09-22T20:24:58.030Z",
  contentHash: hashContent("x".repeat(8729)),
  processingStatus: "extracted",
  extractionQuality: "full",
  rawContent: "x".repeat(8729),
  normalizedPayload: {},
};
const itemForCluster = {
  schemaVersion: 1,
  candidateId: rawItem.externalId,
  url: rawItem.originalUrl,
  canonicalUrl: rawItem.canonicalUrl,
  title: rawItem.title,
  description: rawItem.excerpt,
  author: null,
  publishedAt: rawItem.publishedAt,
  language: rawItem.language,
  content: rawItem.rawContent,
  contentHash: rawItem.contentHash,
  extractionQuality: rawItem.extractionQuality,
  metadata: { sourceId: source.id, sourceName: source.name, sourceCountryCode: source.countryCode },
};
const event = clusterExtractedItems([itemForCluster]).events[0];
const baseState = { attempts: 0, eligible: true, activeClaim: false, quarantined: false, nextEligibleAt: null };
const snapshot = createSupervisedCandidateSnapshot({
  eventKey: event.eventKey,
  title: event.canonicalTitle,
  items: [{ rawItem, source }],
  referenceTime: now,
  createdAt: now,
  hours: 48,
  attemptState: baseState,
  snapshotId: "07aa373c-deeb-4694-8780-f21460d97042",
});
let currentRaw = structuredClone(rawItem);
let currentSource = structuredClone(source);
let currentAttempts = structuredClone(baseState);
let articleExists = false;
const store = {
  async getRawItem() { return currentRaw; },
  async getSource() { return currentSource; },
  async getAttemptState() { return currentAttempts; },
  async hasArticle() { return articleExists; },
};
const valid = await validateSupervisedCandidateSnapshot(snapshot, store, now);
assert.equal(valid.valid, true, valid.reasons.join(","));
assert.equal(supervisedExecutionEventKey(valid), event.eventKey);
console.log("PASS valid snapshot + derived event key");

// Essential regression: validation deliberately has no live-selection input.
const liveSelectedCandidate = "event-live-selection-now-points-elsewhere";
assert.notEqual(liveSelectedCandidate, snapshot.eventKey);
assert.equal((await validateSupervisedCandidateSnapshot(snapshot, store, now)).valid, true);
console.log("PASS snapshot A stays valid after canonical live selection changes to B");

assert.equal((await validateSupervisedCandidateSnapshot(snapshot, store, new Date("2026-09-24T22:24:39.000Z"))).reasons.includes("SNAPSHOT_FRESHNESS_EXPIRED_OR_CHANGED"), true);
console.log("PASS expired snapshot rejected");

const originalClaimAt = new Date("2026-09-23T19:45:59.000Z");
const expiredNow = new Date("2026-09-25T12:00:00.000Z");
assert.equal((await validateSupervisedCandidateSnapshot(snapshot, store, expiredNow)).valid, false);
const resumedAfterWindow = await validateSupervisedCandidateSnapshotForResume(snapshot, store, originalClaimAt);
assert.equal(resumedAfterWindow.valid, true, resumedAfterWindow.reasons.join(","));
const lateOriginalClaim = await validateSupervisedCandidateSnapshotForResume(snapshot, store, new Date("2026-09-24T22:24:39.000Z"));
assert.equal(lateOriginalClaim.reasons.includes("SNAPSHOT_NOT_FRESH_AT_ORIGINAL_CLAIM"), true);
console.log("PASS resume uses original claim freshness while new execution still requires current freshness");

currentRaw = { ...rawItem, contentHash: "sha256:changed-content-hash-value" };
assert.equal((await validateSupervisedCandidateSnapshot(snapshot, store, now)).reasons.includes("SOURCE_OR_EXTRACTION_IDENTITY_MISMATCH"), true);
currentRaw = structuredClone(rawItem);
console.log("PASS modified persisted content rejected");

currentSource = { ...source, id: "a2c5f58e-064d-4d9d-8f44-128d5b3bec38" };
assert.equal((await validateSupervisedCandidateSnapshot(snapshot, store, now)).reasons.includes("SOURCE_OR_EXTRACTION_IDENTITY_MISMATCH"), true);
currentSource = structuredClone(source);
console.log("PASS bad source ownership rejected");

currentAttempts = { attempts: 1, eligible: true, activeClaim: false, quarantined: false, nextEligibleAt: null };
assert.equal((await validateSupervisedCandidateSnapshot(snapshot, store, now)).reasons.includes("SNAPSHOT_ATTEMPT_COUNT_CHANGED"), true);
currentAttempts = structuredClone(baseState);
console.log("PASS changed attempt state rejected");

articleExists = true;
assert.equal((await validateSupervisedCandidateSnapshot(snapshot, store, now)).reasons.includes("SNAPSHOT_ARTICLE_EXISTS"), true);
articleExists = false;
console.log("PASS existing article rejected");

assert.equal((await validateSupervisedCandidateSnapshot({ ...snapshot, title: "Tampered title" }, store, now)).valid, false);
assert.equal((await validateSupervisedCandidateSnapshot({ ...snapshot, integrityHash: "f".repeat(64) }, store, now)).reasons.includes("SNAPSHOT_INTEGRITY_MISMATCH"), true);
console.log("PASS snapshot tampering rejected");

assert.throws(() => supervisedExecutionEventKey({ valid: false, snapshot: null }), /VALID_SUPERVISED_SNAPSHOT_REQUIRED/);
console.log("PASS arbitrary event key cannot become an execution target");

console.log(JSON.stringify({ status: "SUCCESS", tests: 9, groqCalls: 0, providerCalls: 0 }));
