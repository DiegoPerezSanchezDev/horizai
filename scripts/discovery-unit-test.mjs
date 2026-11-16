import assert from "node:assert/strict";
import { canonicalizeUrl } from "../lib/agents/discovery/canonical-url.ts";
import { deduplicateCandidates, isWithinDiscoveryWindow } from "../lib/agents/discovery/discovery-runner.ts";
import { parseFeed } from "../lib/agents/discovery/feed-parser.ts";
import { invalidFeedItemFixture, validAtomFixture, validRssFixture } from "../lib/agents/discovery/fixtures.ts";
import { normalizeCandidate } from "../lib/agents/discovery/normalize-candidate.ts";

const source = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fixture source",
  url: "https://example.com",
  feedUrl: "https://example.com/feed.xml",
  discoveryMethod: "rss",
  sourceType: "website",
  countryCode: "US",
  language: "en",
  priority: 80,
};

assert.equal(
  canonicalizeUrl("HTTPS://Example.com/article/?utm_campaign=x&view=full&fbclid=abc#top"),
  "https://example.com/article?view=full"
);
assert.equal(parseFeed(validRssFixture).length, 1);
assert.equal(parseFeed(validAtomFixture)[0]?.url, "https://example.com/news/two");

const first = normalizeCandidate(source, parseFeed(validRssFixture)[0], new Date("2026-09-12T12:00:00Z"));
assert.ok("record" in first);
if (!("record" in first)) throw new Error("expected valid candidate");
assert.equal(first.record.candidate.url, "https://example.com/news/one?page=1");
assert.equal(first.record.candidate.schemaVersion, 1);
assert.equal(isWithinDiscoveryWindow(parseFeed(validRssFixture)[0], Date.parse("2026-09-11T12:00:00Z"), Date.parse("2026-09-12T12:00:00Z")), true);
assert.equal(isWithinDiscoveryWindow(parseFeed(validRssFixture)[0], Date.parse("2026-09-12T10:01:00Z"), Date.parse("2026-09-12T12:00:00Z")), false);

const duplicate = normalizeCandidate(
  source,
  { ...parseFeed(validRssFixture)[0], url: "https://example.com/news/one?page=1&utm_medium=email" },
  new Date("2026-09-12T12:00:00Z")
);
assert.ok("record" in duplicate);
if (!("record" in duplicate)) throw new Error("expected duplicate fixture to be valid");
const deduped = deduplicateCandidates([first.record, duplicate.record]);
assert.equal(deduped.records.length, 1);
assert.equal(deduped.duplicateUrls, 1);

const oldItem = normalizeCandidate(
  source,
  { ...parseFeed(validRssFixture)[0], publishedAt: "2026-09-10T10:00:00.000Z" },
  new Date("2026-09-12T12:00:00Z")
);
assert.ok("record" in oldItem);
assert.equal(Date.parse(oldItem.record.candidate.publishedAt ?? ""), Date.parse("2026-09-10T10:00:00.000Z"));

const invalid = normalizeCandidate(
  source,
  invalidFeedItemFixture,
  new Date("2026-09-12T12:00:00Z")
);
assert.ok("error" in invalid);

console.log("Discovery unit fixtures passed");
