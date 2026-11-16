import assert from "node:assert/strict";
import { getDailyBriefingStories } from "../components/news/featured/featured-stories-layout.ts";

const asOf = Date.parse("2026-11-10T12:00:00.000Z");
const hours = (count) => count * 60 * 60 * 1000;
const article = (id, publishedAt) => ({ id, publishedAt });

assert.deepEqual(getDailyBriefingStories([], asOf), [], "empty input stays empty");
assert.deepEqual(
  getDailyBriefingStories([article("old", new Date(asOf - hours(73)).toISOString())], asOf),
  [],
  "stories older than 72 hours do not enter the briefing",
);

const onlyRecent = article("one", new Date(asOf - hours(1)).toISOString());
assert.deepEqual(getDailyBriefingStories([onlyRecent], asOf), [onlyRecent], "one recent story is retained");

const atBoundary = article("boundary", new Date(asOf - hours(72)).toISOString());
const recent = article("recent", new Date(asOf - hours(1)).toISOString());
const newest = article("newest", new Date(asOf - 1000).toISOString());
const mixed = [
  article("old", new Date(asOf - hours(73)).toISOString()),
  recent,
  article("future", new Date(asOf + 1000).toISOString()),
  atBoundary,
  article("invalid", "not-a-date"),
  newest,
];
assert.deepEqual(
  getDailyBriefingStories(mixed, asOf),
  [newest, recent, atBoundary],
  "multiple stories are fresh-filtered and sorted newest first, including the exact boundary",
);

const sixRecent = Array.from({ length: 6 }, (_, index) => article(String(index), new Date(asOf - hours(index)).toISOString()));
assert.equal(getDailyBriefingStories(sixRecent, asOf).length, 5, "briefing respects its five-story cap");

console.log("Daily briefing window checks passed.");
