import { randomUUID } from "node:crypto";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import type { PublicationPayload } from "../lib/agents/contracts/index.ts";
import { Publisher } from "../lib/agents/publisher/publisher-agent.ts";
import { SupabasePublisherRepository } from "../lib/agents/publisher/supabase-publisher-repository.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const suffix = randomUUID().replaceAll("-", "");
const eventKey = `event-${suffix}`;
const existingEventKey = `event-${randomUUID().replaceAll("-", "")}`;
const rollbackEventKey = `event-${randomUUID().replaceAll("-", "")}`;
const invalidCategoryEventKey = `event-${randomUUID().replaceAll("-", "")}`;
const invalidSourceEventKey = `event-${randomUUID().replaceAll("-", "")}`;
const entityName = `HorizAI Publisher Materialization ${suffix}`;
const existingEntityName = `HorizAI Publisher Existing ${suffix}`;
const rollbackEntityName = `HorizAI Publisher Rollback ${suffix}`;

async function countBy(supabase: ReturnType<typeof createSupabaseServerClient>, table: string, column: string, value: string): Promise<number> {
  const response = await supabase.from(table as never).select("*", { count: "exact", head: true }).eq(column, value);
  if (response.error || response.count === null) throw new Error(`count failed for ${table}`);
  return response.count;
}

function inputFor(payload: PublicationPayload, eventKeyValue: string, source: { id: string; name: string; url: string }, rawItemId?: string) {
  const normalizedPayload = structuredClone(payload);
  normalizedPayload.eventKey = eventKeyValue;
  normalizedPayload.verification = { ...normalizedPayload.verification, eventKey: eventKeyValue };
  normalizedPayload.critic = { ...normalizedPayload.critic, eventKey: eventKeyValue };
  return {
    payload: { ...normalizedPayload, sources: [{ sourceId: source.id, rawItemId, sourceName: source.name, url: source.url, isPrimary: true, publishedAt: null }] },
    lineage: { eventKey: eventKeyValue, verificationEventKey: eventKeyValue, translationEventKey: eventKeyValue, editorialEventKey: eventKeyValue, classificationEventKey: eventKeyValue, rankingEventKey: eventKeyValue, criticEventKey: eventKeyValue },
    validationContext: {
      translation: { ...structuredClone(validFixtures.TranslationResult), eventKey: eventKeyValue },
      editorSources: [{ sourceId: source.id, sourceName: source.name, canonicalUrl: source.url, sourceType: "website" }],
    },
  };
}

async function main(): Promise<void> {
  const supabase = createSupabaseServerClient();
  const repository = new SupabasePublisherRepository(supabase);
  const publisher = new Publisher(repository);
  const createdEventIds: string[] = [];
  const rawItemIds: string[] = [];
  const entityIds: string[] = [];

  try {
    const sourceResponse = await supabase.from("sources").select("id,name,url").eq("is_active", true).limit(1).single();
    const regionResponse = await supabase.from("regions").select("id,code,latitude,longitude").eq("code", "US").eq("is_active", true).single();
    const categoryResponse = await supabase.from("categories").select("id,slug").eq("slug", "chips").eq("is_active", true).single();
    if (sourceResponse.error || regionResponse.error || categoryResponse.error) throw new Error("publisher integration reference lookup failed");
    const source = sourceResponse.data;
    const region = regionResponse.data;
    const category = categoryResponse.data;

    const basePayload = structuredClone(validFixtures.PublicationPayload) as PublicationPayload;
    basePayload.event = { canonicalTitle: "HorizAI publisher materialization fixture", probableOccurredAt: "2026-09-16T12:00:00Z", probableCountryCode: "US", probableRegionCode: "US" };
    basePayload.article.slug = `horizai-materialization-${suffix}`;
    basePayload.categories = [{ categorySlug: category.slug, isPrimary: true, confidenceScore: 95 }];
    basePayload.entities = [{ entityType: "organization", canonicalName: entityName, countryCode: "US", role: "subject", confidenceScore: 96 }];
    basePayload.region = { code: "US", latitude: region.latitude, longitude: region.longitude };
    basePayload.verification = { ...basePayload.verification, primarySourceId: source.id, supportingSourceIds: [], verifiedFacts: basePayload.verification.verifiedFacts.map((fact) => ({ ...fact, sourceIds: [source.id] })), uncertainClaims: basePayload.verification.uncertainClaims.map((claim) => ({ ...claim, sourceIds: [source.id] })), contradictions: [] };
    basePayload.critic = { ...basePayload.critic, decision: "pass" };

    const rawResponse = await supabase.from("raw_items").insert({ source_id: source.id, original_url: `https://example.invalid/horizai-publisher/${suffix}`, external_id: `publisher-materialization-${suffix}`, title: "Temporary publisher fixture", raw_content: "Temporary integration content.", content_hash: `publisher-materialization-${suffix}`, processing_status: "processed" }).select("id").single();
    if (rawResponse.error) throw new Error("publisher materialization raw item setup failed");
    rawItemIds.push(rawResponse.data.id);
    const input = inputFor(basePayload, eventKey, source, rawResponse.data.id);

    const beforeEvent = await countBy(supabase, "events", "event_key", eventKey);
    const dryRun = await publisher.publish(input, { dryRun: true });
    assert(dryRun.summary.transactionAttempted === false, "dry-run attempted a transaction");
    assert(dryRun.summary.eventAction === "WOULD_CREATE" && dryRun.summary.eventId === null, "dry-run did not report WOULD_CREATE without a fake id");
    assert(await countBy(supabase, "events", "event_key", eventKey) === beforeEvent, "dry-run created an event");

    const first = await publisher.publish(input, { dryRun: false });
    assert(first.summary.eventAction === "created" && first.summary.articleAction === "created" && first.summary.transactionCommitted, "new event publication did not commit");
    assert(first.summary.eventId && first.summary.articleId, "atomic result did not return database ids");
    createdEventIds.push(first.summary.eventId);
    entityIds.push((await supabase.from("entities").select("id").eq("entity_type", "organization").eq("canonical_name", entityName).single()).data?.id ?? "");

    const second = await publisher.publish(input, { dryRun: false });
    assert(second.summary.eventAction === "reused" && second.summary.articleAction === "updated", "second publication did not reuse the event and update the article");
    const concurrent = await Promise.all([publisher.publish(input, { dryRun: false }), publisher.publish(input, { dryRun: false })]);
    assert(concurrent.every((result) => result.summary.transactionCommitted && result.summary.eventAction === "reused"), "concurrent same-event publication was not coherent");
    const eventCount = await countBy(supabase, "events", "event_key", eventKey);
    const articleCount = await countBy(supabase, "articles", "event_id", first.summary.eventId);
    const sourceRelationCount = await countBy(supabase, "event_sources", "event_id", first.summary.eventId);
    const categoryRelationCount = await countBy(supabase, "article_categories", "article_id", first.summary.articleId);
    const entityRelationCount = await countBy(supabase, "article_entities", "article_id", first.summary.articleId);
    const entityCount = await countBy(supabase, "entities", "canonical_name", entityName);
    assert(eventCount === 1 && articleCount === 1 && sourceRelationCount === 1 && categoryRelationCount === 1 && entityRelationCount === 1 && entityCount === 1, `materialization counts event=${eventCount} article=${articleCount} source=${sourceRelationCount} category=${categoryRelationCount} entityRelation=${entityRelationCount} entity=${entityCount}`);

    const existingRaw = await supabase.from("raw_items").insert({ source_id: source.id, original_url: `https://example.invalid/horizai-publisher/existing-${suffix}`, external_id: `publisher-existing-${suffix}`, title: "Temporary existing event fixture", raw_content: "Temporary integration content.", content_hash: `publisher-existing-${suffix}`, processing_status: "processed" }).select("id").single();
    if (existingRaw.error) throw new Error("existing event raw item setup failed");
    rawItemIds.push(existingRaw.data.id);
    const existingEvent = await supabase.from("events").insert({ event_key: existingEventKey, canonical_title: "Existing publisher event fixture", primary_region_id: region.id, primary_country_code: "US", event_status: "candidate", review_status: "pending" }).select("id").single();
    if (existingEvent.error) throw new Error("existing event setup failed");
    createdEventIds.push(existingEvent.data.id);
    const existingRelation = await supabase.from("event_sources").insert({ event_id: existingEvent.data.id, raw_item_id: existingRaw.data.id, source_id: source.id, is_primary: true });
    if (existingRelation.error) throw new Error("existing event source relation setup failed");
    const existingPayload = structuredClone(basePayload);
    existingPayload.event = { ...existingPayload.event, canonicalTitle: "Existing publisher event fixture" };
    existingPayload.article.slug = `horizai-existing-${suffix}`;
    existingPayload.entities = [{ ...existingPayload.entities[0], canonicalName: existingEntityName }];
    const existingInput = inputFor(existingPayload, existingEventKey, source, existingRaw.data.id);
    const existingPublication = await publisher.publish(existingInput, { dryRun: false });
    assert(existingPublication.summary.eventAction === "reused" && existingPublication.summary.articleAction === "created", "existing event was not reused");
    entityIds.push((await supabase.from("entities").select("id").eq("entity_type", "organization").eq("canonical_name", existingEntityName).single()).data?.id ?? "");

    const rollbackRaw = await supabase.from("raw_items").insert({ source_id: source.id, original_url: `https://example.invalid/horizai-publisher/rollback-${suffix}`, external_id: `publisher-rollback-${suffix}`, title: "Temporary rollback fixture", raw_content: "Temporary integration content.", content_hash: `publisher-rollback-${suffix}`, processing_status: "processed" }).select("id").single();
    if (rollbackRaw.error) throw new Error("rollback raw item setup failed");
    rawItemIds.push(rollbackRaw.data.id);
    const rollbackPayload = structuredClone(basePayload);
    rollbackPayload.event = { ...rollbackPayload.event, canonicalTitle: "Rollback fixture" };
    rollbackPayload.article.slug = `horizai-rollback-${suffix}`;
    rollbackPayload.entities = [{ ...rollbackPayload.entities[0], canonicalName: rollbackEntityName }];
    rollbackPayload.eventKey = rollbackEventKey;
    rollbackPayload.verification = { ...rollbackPayload.verification, eventKey: rollbackEventKey };
    rollbackPayload.critic = { ...rollbackPayload.critic, eventKey: rollbackEventKey };
    const rollbackInput = inputFor(rollbackPayload, rollbackEventKey, source, rollbackRaw.data.id);
    const invalidRolePayload = structuredClone(rollbackInput.payload) as unknown as Record<string, unknown>;
    (invalidRolePayload.entities as Array<Record<string, unknown>>)[0].role = "invalid_role";
    const rollbackRpc = await supabase.rpc("publish_article_atomic", { p_payload: invalidRolePayload as never });
    assert(rollbackRpc.error, "invalid role did not fail inside the transaction");
    assert(await countBy(supabase, "events", "event_key", rollbackEventKey) === 0, "rollback left the event");
    assert(await countBy(supabase, "entities", "canonical_name", rollbackEntityName) === 0, "rollback left the entity");

    const invalidCategoryPayload = structuredClone(basePayload);
    invalidCategoryPayload.eventKey = invalidCategoryEventKey;
    invalidCategoryPayload.article.slug = `horizai-invalid-category-${suffix}`;
    invalidCategoryPayload.categories = [{ categorySlug: "missing-category", isPrimary: true, confidenceScore: 95 }];
    const invalidCategoryInput = inputFor(invalidCategoryPayload, invalidCategoryEventKey, source, rawResponse.data.id);
    const invalidCategoryRpc = await supabase.rpc("publish_article_atomic", { p_payload: invalidCategoryInput.payload as never });
    assert(invalidCategoryRpc.error, "invalid category did not fail closed");
    assert(await countBy(supabase, "events", "event_key", invalidCategoryEventKey) === 0, "invalid category left an event");

    const invalidSourcePayload = structuredClone(basePayload);
    invalidSourcePayload.eventKey = invalidSourceEventKey;
    invalidSourcePayload.article.slug = `horizai-invalid-source-${suffix}`;
    invalidSourcePayload.sources = [{ sourceId: randomUUID(), rawItemId: rawResponse.data.id, sourceName: "Missing source", url: "https://example.invalid/missing-source", isPrimary: true, publishedAt: null }];
    const invalidSourceRpc = await supabase.rpc("publish_article_atomic", { p_payload: invalidSourcePayload as never });
    assert(invalidSourceRpc.error, "invalid source did not fail closed");
    assert(await countBy(supabase, "events", "event_key", invalidSourceEventKey) === 0, "invalid source left an event");

    console.log(JSON.stringify({ status: "SUCCESS", newEventCreated: true, existingEventReused: true, idempotency: "PASS", concurrency: "PASS", oneEvent: eventCount === 1, oneArticle: articleCount === 1, sourceRelations: sourceRelationCount, categoryRelations: categoryRelationCount, entityRelations: entityRelationCount, rollback: "PASS", invalidCategoryRollback: "PASS", invalidSourceRollback: "PASS", dryRunZeroWrites: true, fakeIds: false, groqCalls: 0 }));
  } finally {
    const uniqueEntityIds = [...new Set(entityIds.filter(Boolean))];
    for (const eventId of [...new Set(createdEventIds.filter(Boolean))]) await supabase.from("articles").delete().eq("event_id", eventId);
    for (const eventId of [...new Set(createdEventIds.filter(Boolean))]) await supabase.from("events").delete().eq("id", eventId);
    for (const rawItemId of [...new Set(rawItemIds.filter(Boolean))]) await supabase.from("raw_items").delete().eq("id", rawItemId);
    for (const entityId of uniqueEntityIds) await supabase.from("entities").delete().eq("id", entityId);
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Publisher integration failed"); process.exitCode = 1; });
