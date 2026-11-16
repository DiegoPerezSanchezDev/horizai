import assert from "node:assert/strict";
import { clusterExtractedItems } from "../lib/agents/clustering/cluster-runner.ts";
import { clusteringFixtures } from "../lib/agents/clustering/fixtures.ts";
import { comparableItem } from "../lib/agents/clustering/normalize-event-text.ts";
import { scoreCandidatePair } from "../lib/agents/clustering/similarity.ts";

const clusterSize = (items) => Math.max(...clusterExtractedItems(items).events.map((event) => event.sourceItems.length));
const samePair = scoreCandidatePair(comparableItem(clusteringFixtures.sameEventDifferentTitles[0]), comparableItem(clusteringFixtures.sameEventDifferentTitles[1]));
assert.equal(samePair.decision, "merge");
assert.equal(clusterSize(clusteringFixtures.sameEventDifferentTitles), 2);
assert.equal(clusterSize(clusteringFixtures.sameCompanyDifferentEvents), 1);
assert.equal(clusterSize(clusteringFixtures.differentModelVersions), 1);
assert.equal(clusterSize(clusteringFixtures.launchVsFunding), 1);
assert.equal(clusterSize(clusteringFixtures.multilingual), 2);
assert.equal(clusterSize(clusteringFixtures.distantDates), 1);

const exactDuplicate = clusterExtractedItems(clusteringFixtures.exactDuplicates);
assert.equal(exactDuplicate.duplicatesRemoved, 1);
assert.equal(exactDuplicate.events.length, 1);

const threeSource = clusterExtractedItems(clusteringFixtures.threeSources);
assert.equal(threeSource.events.length, 1);
assert.equal(threeSource.events[0].sourceItems.length, 3);
assert.ok(threeSource.events[0].clusterConfidence > 50);
const singleSource = clusterExtractedItems(clusteringFixtures.singleSource);
assert.equal(singleSource.events.length, 1);
assert.equal(singleSource.events[0].sourceItems.length, 1);

const ambiguousPair = scoreCandidatePair(comparableItem(clusteringFixtures.ambiguous[0]), comparableItem(clusteringFixtures.ambiguous[1]));
assert.ok(["needs_review", "separate"].includes(ambiguousPair.decision));
assert.ok(ambiguousPair.score < 0.8);

console.log("Clustering unit fixtures passed");
