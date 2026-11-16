import assert from "node:assert/strict";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { createReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { projectClassificationGeo, resolveGeo } from "../lib/agents/classifier/geo-resolver.ts";
import { PublisherError } from "../lib/agents/publisher/publisher-errors.ts";
import { buildPublisherWritePlan } from "../lib/agents/publisher/publisher-write-plan.ts";

const registry = createReferenceRegistry([
  { code: "GLOBAL", name: "Global", latitude: 20, longitude: 0 },
  { code: "US", name: "EE. UU.", latitude: 39.8283, longitude: -98.5795 },
  { code: "EUROPE", name: "Europa", latitude: 54.526, longitude: 15.2551 },
], []);

// Minimized structural reproduction of EVENT 1. It contains no article text.
const failedEventGeo = {
  primaryRegionCode: "GLOBAL",
  countryCodes: ["US"],
  latitude: 39.8283,
  longitude: -98.5795,
};
const projected = projectClassificationGeo(failedEventGeo, registry);
assert.deepEqual(projected.classification, {
  primaryRegionCode: "GLOBAL",
  countryCodes: ["US"],
  latitude: 20,
  longitude: 0,
});
assert.deepEqual(projected.geo, {
  latitude: 20,
  longitude: 0,
  resolutionLevel: "global",
  resolvedFrom: "region_registry",
});
assert.deepEqual(failedEventGeo, {
  primaryRegionCode: "GLOBAL",
  countryCodes: ["US"],
  latitude: 39.8283,
  longitude: -98.5795,
}, "checkpoint projection must not mutate persisted input");

const europe = projectClassificationGeo({
  primaryRegionCode: "EUROPE",
  countryCodes: ["FR", "US"],
  latitude: null,
  longitude: null,
}, registry);
assert.deepEqual({ latitude: europe.geo.latitude, longitude: europe.geo.longitude }, { latitude: 54.526, longitude: 15.2551 });
assert.equal(europe.geo.resolutionLevel, "region");
assert.equal(europe.geo.resolvedFrom, "region_registry");

const unresolvedCountryOnly = projectClassificationGeo({
  primaryRegionCode: null,
  countryCodes: ["US"],
  latitude: 39.8283,
  longitude: -98.5795,
}, registry);
assert.deepEqual({ latitude: unresolvedCountryOnly.geo.latitude, longitude: unresolvedCountryOnly.geo.longitude }, { latitude: null, longitude: null });
assert.equal(unresolvedCountryOnly.geo.resolutionLevel, "unresolved");
assert.equal(unresolvedCountryOnly.geo.resolvedFrom, null);
assert.equal(resolveGeo({ regionCode: "USA" }, registry).resolutionLevel, "unresolved");
assert.equal(resolveGeo({ regionCode: "NORTH-AMERICA" }, registry).resolutionLevel, "unresolved");

const noCoordinatesRegistry = createReferenceRegistry([
  { code: "GLOBAL", name: "Global", latitude: null, longitude: null },
], []);
assert.deepEqual(resolveGeo({ regionCode: "GLOBAL" }, noCoordinatesRegistry), {
  latitude: null,
  longitude: null,
  resolutionLevel: "unresolved",
  resolvedFrom: null,
});

const eventKey = validFixtures.PublicationPayload.eventKey;
const payload = structuredClone(validFixtures.PublicationPayload);
payload.eventKey = eventKey;
payload.verification.eventKey = eventKey;
payload.critic.eventKey = eventKey;
payload.event.probableCountryCode = "US";
payload.event.probableRegionCode = "GLOBAL";
payload.region = { code: "GLOBAL", latitude: failedEventGeo.latitude, longitude: failedEventGeo.longitude };
payload.sources = payload.sources.map((source) => ({ ...source, rawItemId: "44444444-4444-4444-8444-444444444444" }));

const lookup = {
  event: null,
  region: { id: "global-row", code: "GLOBAL", latitude: 20, longitude: 0, is_active: true },
  categories: new Map(payload.categories.map((category, index) => [category.categorySlug, { id: `category-${index}`, slug: category.categorySlug, is_active: true }])),
  sources: new Map(payload.sources.map((source) => [source.sourceId, { id: source.sourceId, name: source.sourceName, url: source.url, is_active: true }])),
  eventSourceIds: new Set(),
  articleByEvent: null,
  articleBySlug: null,
  entities: new Map(),
};

assert.throws(
  () => buildPublisherWritePlan(payload, lookup),
  (error) => error instanceof PublisherError && error.code === "publication_invalid_geo",
  "GLOBAL paired with the US centroid must remain rejected",
);

const correctedPayload = structuredClone(payload);
correctedPayload.region = { code: "GLOBAL", latitude: projected.geo.latitude, longitude: projected.geo.longitude };
const plan = buildPublisherWritePlan(correctedPayload, lookup);
assert.equal(plan.event.operation, "insert");
assert.equal(plan.event.regionId, "global-row");
assert.equal(plan.eventSources.operation, "insert_idempotent");

const unresolvedPayload = structuredClone(correctedPayload);
unresolvedPayload.event.probableRegionCode = null;
unresolvedPayload.region = { code: null, latitude: null, longitude: null };
const unresolvedPlan = buildPublisherWritePlan(unresolvedPayload, { ...lookup, region: null });
assert.equal(unresolvedPlan.event.regionId, null);

console.log("geo:consistency:12a1b: PASS (GLOBAL, region centroid, missing, unsupported, mismatched Publisher geography, immutable projection)");
