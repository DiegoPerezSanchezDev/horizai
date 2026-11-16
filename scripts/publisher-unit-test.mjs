import assert from "node:assert/strict";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { Publisher, PublisherError, buildPublisherWritePlan, publisherErrorSummary } from "../lib/agents/publisher/index.ts";

const eventKey = validFixtures.PublicationPayload.eventKey;
const payload = structuredClone(validFixtures.PublicationPayload);
const validationContext = {
  translation: { ...structuredClone(validFixtures.TranslationResult), eventKey },
  editorSources: [{ sourceId: payload.sources[0].sourceId, sourceName: payload.sources[0].sourceName, canonicalUrl: payload.sources[0].url, sourceType: "website" }],
};
const lineage = Object.fromEntries(["eventKey", "verificationEventKey", "translationEventKey", "editorialEventKey", "classificationEventKey", "rankingEventKey", "criticEventKey"].map((key) => [key, eventKey]));
const lookup = {
  event: { id: "event-row", event_key: eventKey, canonical_title: payload.event.canonicalTitle, primary_region_id: "region-row", primary_country_code: "US", occurred_at: payload.event.probableOccurredAt },
  region: { id: "region-row", code: "US", latitude: 39.8283, longitude: -98.5795, is_active: true },
  categories: new Map([[
    "chips", { id: "category-chips", slug: "chips", is_active: true },
  ], ["empresas", { id: "category-companies", slug: "empresas", is_active: true }]]),
  sources: new Map([[payload.sources[0].sourceId, { id: payload.sources[0].sourceId, name: payload.sources[0].sourceName, url: payload.sources[0].url, is_active: true }]]),
  eventSourceIds: new Set([payload.sources[0].sourceId]),
  articleByEvent: null,
  articleBySlug: null,
  entities: new Map(),
};

const input = { payload, lineage, validationContext };
const plan = buildPublisherWritePlan(payload, lookup);
assert.equal(plan.publisherVersion, "publisher-v1");
assert.equal(plan.article.idempotencyKey, "event_id");
assert.equal(plan.article.operation, "insert");
assert.deepEqual(buildPublisherWritePlan(payload, lookup), plan);

let atomicCalls = 0;
const repository = {
  async findEventByKey() { return lookup.event; },
  async findActiveRegion() { return lookup.region; },
  async findActiveCategories() { return [...lookup.categories.values()]; },
  async findSources() { return [...lookup.sources.values()]; },
  async findEventSourceIds() { return [...lookup.eventSourceIds]; },
  async findArticleByEventId() { return lookup.articleByEvent; },
  async findArticleBySlug() { return lookup.articleBySlug; },
  async findExactEntities() { return []; },
  async publishAtomic() { atomicCalls += 1; throw new Error("must not be called in dry-run"); },
};

const publisher = new Publisher(repository);
const dryRun = await publisher.publish(input, { dryRun: true });
assert.equal(dryRun.status, "success");
assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.summary.transactionAttempted, false);
assert.equal(atomicCalls, 0);

const missingEventLookup = { ...lookup, event: null, eventSourceIds: new Set(), articleByEvent: null, articleBySlug: null, entities: new Map() };
let previewAtomicCalls = 0;
const missingEventRepository = {
  async findEventByKey() { return missingEventLookup.event; },
  async findActiveRegion() { return missingEventLookup.region; },
  async findActiveCategories() { return [...missingEventLookup.categories.values()]; },
  async findSources() { return [...missingEventLookup.sources.values()]; },
  async findEventSourceIds() { return []; },
  async findArticleByEventId() { return null; },
  async findArticleBySlug() { return null; },
  async findExactEntities() { return []; },
  async publishAtomic() { previewAtomicCalls += 1; throw new Error("must not be called in dry-run preview"); },
};
const missingEventPreview = await new Publisher(missingEventRepository).preview(input);
assert.equal(missingEventPreview.dryRun, true);
assert.equal(missingEventPreview.summary.transactionAttempted, false);
assert.equal(missingEventPreview.summary.articleId, null);
assert.equal(missingEventPreview.writePlan.event.resolution, "would_create");
assert.equal(missingEventPreview.writePlan.event.databaseId, null);
assert.equal(missingEventPreview.writePlan.article.operation, "would_create");
assert.equal(missingEventPreview.writePlan.article.databaseId, null);
assert.equal(missingEventPreview.writePlan.entities[0].resolution, "would_create");
assert.equal(missingEventPreview.writePlan.relations.eventSources, "would_link");
assert.equal(previewAtomicCalls, 0);
assert.deepEqual((await new Publisher(missingEventRepository).preview(input)).writePlan, missingEventPreview.writePlan);
assert.throws(() => buildPublisherWritePlan(payload, missingEventLookup), (error) => error.code === "publication_missing_raw_item");
const materializationPayload = { ...payload, sources: [{ ...payload.sources[0], rawItemId: "00000000-0000-4000-8000-000000000099" }] };
const materializationPlan = buildPublisherWritePlan(materializationPayload, missingEventLookup);
assert.equal(materializationPlan.event.operation, "insert");
assert.equal(materializationPlan.event.eventId, null);
assert.equal(materializationPlan.eventSources.operation, "insert_idempotent");

const existingEntityKey = "organization\u0000Example Corp\u0000US";
const existingEventPreview = await new Publisher({
  ...missingEventRepository,
  async findEventByKey() { return lookup.event; },
  async findEventSourceIds() { return [...lookup.eventSourceIds]; },
  async findArticleByEventId() { return { id: "article-row", event_id: lookup.event.id, slug: payload.article.slug, publication_status: "published" }; },
  async findExactEntities() { return [{ id: "entity-row", entity_type: "organization", canonical_name: "Example Corp", country_code: "US" }]; },
}).preview(input);
assert.equal(existingEventPreview.writePlan.event.resolution, "reuse_existing");
assert.equal(existingEventPreview.writePlan.event.databaseId, lookup.event.id);
assert.equal(existingEventPreview.writePlan.article.resolution, "reuse_existing");
assert.equal(existingEventPreview.writePlan.article.databaseId, "article-row");
assert.equal(existingEventPreview.writePlan.entities.find((entity) => `${entity.entityType}\u0000${entity.canonicalName}\u0000${entity.countryCode ?? ""}` === existingEntityKey)?.resolution, "reuse_existing");
assert.equal(existingEventPreview.writePlan.relations.eventSources, "already_linked");
assert.equal(previewAtomicCalls, 0);

await assert.rejects(
  () => new Publisher({ ...missingEventRepository, async findActiveCategories() { return []; } }).preview(input),
  (error) => error.code === "publication_invalid_category",
);

for (const decision of ["revise_verification", "revise_translation", "revise_editorial", "revise_classification", "revise_ranking", "reject"]) {
  assert.throws(() => buildPublisherWritePlan({ ...payload, critic: { ...payload.critic, decision } }, lookup), (error) => error instanceof PublisherError && error.code === "publication_not_approved");
}
assert.throws(() => buildPublisherWritePlan({ ...payload, eventKey: "different" }, lookup), /eventKey/);
assert.throws(() => buildPublisherWritePlan({ ...payload, categories: [{ ...payload.categories[0], categorySlug: "missing" }] }, { ...lookup, categories: new Map() }), (error) => error.code === "publication_invalid_category");
assert.throws(() => buildPublisherWritePlan(payload, { ...lookup, region: null }), (error) => error.code === "publication_invalid_region");
assert.throws(() => buildPublisherWritePlan({ ...payload, scores: { ...payload.scores, importanceScore: 1 } }, lookup), (error) => error.code === "publication_ranking_mismatch");
assert.throws(() => buildPublisherWritePlan({ ...payload, sources: [payload.sources[0], payload.sources[0]] }, lookup), (error) => error.code === "publication_idempotency_conflict");
assert.deepEqual(publisherErrorSummary(new PublisherError("publication_transaction_failed", "internal SQL detail")), { code: "publication_transaction_failed", message: "internal SQL detail" });
assert.deepEqual(publisherErrorSummary(new Error("secret SQL detail")), { code: "publication_transaction_failed", message: "Publisher operation failed" });
console.log("Publisher unit fixtures passed: gate, lineage, preconditions, plan, idempotency, dry-run, errors, no LLM budget");
