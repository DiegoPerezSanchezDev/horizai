import assert from "node:assert/strict";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { validateRealPublicationReadiness } from "../lib/agents/publisher/publication-readiness.ts";

const sourceId = validFixtures.PublicationPayload.sources[0].sourceId;
const rawItemId = "44444444-4444-4444-8444-444444444444";

function inputFor(overrides = {}) {
  const eventKey = overrides.eventKey ?? validFixtures.PublicationPayload.eventKey;
  const payload = structuredClone(validFixtures.PublicationPayload);
  payload.eventKey = eventKey;
  payload.verification.eventKey = eventKey;
  payload.critic.eventKey = eventKey;
  payload.sources[0].rawItemId = rawItemId;
  return {
    payload: { ...payload, ...overrides.payload },
    lineage: Object.fromEntries([
      ["eventKey", eventKey],
      ["verificationEventKey", eventKey],
      ["translationEventKey", eventKey],
      ["editorialEventKey", eventKey],
      ["classificationEventKey", eventKey],
      ["rankingEventKey", eventKey],
      ["criticEventKey", eventKey],
    ]),
    validationContext: {
      translation: { ...structuredClone(validFixtures.TranslationResult), eventKey },
      editorSources: [{ sourceId, sourceName: "Example Tech Journal", canonicalUrl: "https://example.com/news/ai-chip", sourceType: "official" }],
    },
  };
}

function repository({ event = null, ownsRawItem = true } = {}) {
  return {
    async findEventByKey() { return event; },
    async findActiveRegion() { return { id: "region-us", code: "US", latitude: 39.8283, longitude: -98.5795, is_active: true }; },
    async findActiveCategories(slugs) { return slugs.map((slug, index) => ({ id: `category-${index}`, slug, is_active: true })); },
    async findSources() { return [{ id: sourceId, name: "Example Tech Journal", url: "https://example.com/news/ai-chip", is_active: true }]; },
    async findEventSourceIds() { return [sourceId]; },
    async findArticleByEventId() { return null; },
    async findArticleBySlug() { return null; },
    async findExactEntities() { return []; },
    async findRawItemOwnership() { return ownsRawItem; },
  };
}

const valid = await validateRealPublicationReadiness(inputFor(), repository());
assert.equal(valid.ready, true, `valid input must be ready: ${JSON.stringify(valid.issues)}`);
assert.equal(valid.rawItemOwnershipChecked, 1);
assert.equal(valid.eventResolution, "would_create");

const missingRaw = inputFor();
missingRaw.payload.sources[0].rawItemId = undefined;
const missingRawResult = await validateRealPublicationReadiness(missingRaw, repository());
assert.equal(missingRawResult.ready, false);
assert.ok(missingRawResult.issues.some((item) => item.code === "publication_missing_raw_item"));

const wrongOwner = await validateRealPublicationReadiness(inputFor(), repository({ ownsRawItem: false }));
assert.equal(wrongOwner.ready, false);
assert.ok(wrongOwner.issues.some((item) => item.code === "publication_missing_raw_item"));

const rejected = inputFor({ payload: { critic: { ...structuredClone(validFixtures.PublicationPayload.critic), decision: "reject" } } });
const rejectedResult = await validateRealPublicationReadiness(rejected, repository());
assert.equal(rejectedResult.ready, false);
assert.ok(rejectedResult.issues.some((item) => item.code === "publication_not_approved"));

const existingEvent = {
  id: "55555555-5555-4555-8555-555555555555",
  event_key: validFixtures.PublicationPayload.eventKey,
  canonical_title: validFixtures.PublicationPayload.event.canonicalTitle,
  primary_region_id: "region-us",
  primary_country_code: "US",
  occurred_at: validFixtures.PublicationPayload.event.probableOccurredAt,
};
const existing = inputFor();
existing.payload.sources[0].rawItemId = undefined;
const existingResult = await validateRealPublicationReadiness(existing, repository({ event: existingEvent }));
assert.equal(existingResult.ready, true, `existing event may rely on its stored relation: ${JSON.stringify(existingResult.issues)}`);
assert.equal(existingResult.eventResolution, "reuse_existing");
assert.equal(existingResult.rawItemOwnershipChecked, 0);

console.log("publication readiness unit: OK (critic, lineage, active registries, rawItem ownership, existing-event traceability, zero writes)");
