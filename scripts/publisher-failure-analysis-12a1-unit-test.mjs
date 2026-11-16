import assert from "node:assert/strict";
import { publicationPayloadSchema } from "../lib/agents/contracts/index.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { buildPublicationScores } from "../lib/agents/publisher/publication-payload.ts";
import { PublisherError } from "../lib/agents/publisher/publisher-errors.ts";
import { buildPublisherWritePlan } from "../lib/agents/publisher/publisher-write-plan.ts";

// Minimized from EVENT 1's persisted RankingResult. The rationale is synthetic;
// the regression preserves only the real structural shape and numeric fields.
const ranking = {
  schemaVersion: 1,
  eventKey: "event-cbbf85234317a442f59ece63ef1b40c8",
  impact: 60,
  novelty: 70,
  reach: 22,
  credibility: 57,
  economicImpact: 30,
  momentum: 50,
  importanceScore: 49.3,
  rankReason: "Deterministic ranking rationale.",
};

const payload = structuredClone(validFixtures.PublicationPayload);
payload.eventKey = ranking.eventKey;
payload.verification.eventKey = ranking.eventKey;
payload.critic.eventKey = ranking.eventKey;

const originalAssemblyPayload = { ...payload, scores: { ...ranking, importanceScore: ranking.importanceScore } };
const originalValidation = publicationPayloadSchema.safeParse(originalAssemblyPayload);
assert.equal(originalValidation.success, false);
assert.deepEqual(
  originalValidation.error.issues.map(({ code, path, keys }) => ({ code, path, keys })),
  [{ code: "unrecognized_keys", path: ["scores"], keys: ["schemaVersion", "eventKey", "rankReason"] }],
);

const fixedPayload = { ...payload, scores: buildPublicationScores(ranking) };
assert.deepEqual(fixedPayload.scores, {
  impact: 60,
  novelty: 70,
  reach: 22,
  credibility: 57,
  economicImpact: 30,
  momentum: 50,
  importanceScore: 49.3,
});
assert.deepEqual(Object.keys(fixedPayload.scores).sort(), [
  "economicImpact", "credibility", "impact", "importanceScore", "momentum", "novelty", "reach",
].sort());
assert.equal(publicationPayloadSchema.safeParse(fixedPayload).success, true);

const atomicPayload = {
  ...fixedPayload,
  sources: [{ ...fixedPayload.sources[0], rawItemId: "0436dcb3-8d60-4030-a8c2-b7d9f96e6ccf" }],
};
const lookup = {
  event: null,
  region: { id: "region-global", code: atomicPayload.region.code, latitude: atomicPayload.region.latitude, longitude: atomicPayload.region.longitude, is_active: true },
  categories: new Map(atomicPayload.categories.map((category, index) => [category.categorySlug, { id: `category-${index}`, slug: category.categorySlug, is_active: true }])),
  sources: new Map(atomicPayload.sources.map((source) => [source.sourceId, { id: source.sourceId, name: source.sourceName, url: source.url, is_active: true }])),
  eventSourceIds: new Set(),
  articleByEvent: null,
  articleBySlug: null,
  entities: new Map(),
};
const writePlan = buildPublisherWritePlan(atomicPayload, lookup);
assert.equal(writePlan.event.operation, "insert");
assert.equal(writePlan.eventSources.operation, "insert_idempotent");
assert.equal(writePlan.article.operation, "insert");

assert.throws(
  () => buildPublicationScores({ ...ranking, importanceScore: null }),
  (error) => error instanceof PublisherError && error.code === "publication_ranking_mismatch",
);
assert.throws(
  () => buildPublicationScores({ ...ranking, importanceScore: undefined }),
  (error) => error instanceof PublisherError && error.code === "publication_ranking_mismatch",
);

console.log("publisher:failure-analysis:12a1:unit: PASS (pre-fix rejection, score projection, payload contract, zero-RPC atomic plan)");
