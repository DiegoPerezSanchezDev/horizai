import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { validateRealPublicationReadiness } from "../lib/agents/publisher/publication-readiness.ts";
import { SupabasePublisherRepository } from "../lib/agents/publisher/supabase-publisher-repository.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { persistRawItem, rawItemInputFromCandidate } from "../lib/agents/ingestion/raw-item-repository.ts";
import type { PublicationPayload } from "../lib/agents/contracts/index.ts";

function assertNoError<T extends { error: { message: string } | null }>(response: T, operation: string): void {
  if (response.error) throw new Error(`${operation}: ${response.error.message}`);
}

function candidateFor(source: { id: string; name: string; url: string }, externalId: string, suffix: string) {
  return {
    ...structuredClone(validFixtures.DiscoveryCandidate),
    externalId,
    sourceId: source.id,
    sourceName: source.name,
    url: `https://example.invalid/horizai/raw-item/${suffix}`,
    titleOriginal: `Raw item traceability fixture ${suffix}`,
    excerptOriginal: "Temporary traceability fixture.",
    discoveredAt: "2026-09-22T08:00:00Z",
  };
}

function readinessInput(payload: PublicationPayload) {
  const eventKey = payload.eventKey;
  return {
    payload,
    lineage: {
      eventKey,
      verificationEventKey: eventKey,
      translationEventKey: eventKey,
      editorialEventKey: eventKey,
      classificationEventKey: eventKey,
      rankingEventKey: eventKey,
      criticEventKey: eventKey,
    },
    validationContext: {
      translation: { ...structuredClone(validFixtures.TranslationResult), eventKey },
      editorSources: payload.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: source.url, sourceType: "website" })),
    },
  };
}

async function main(): Promise<void> {
  const service = createSupabaseServerClient();
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!publicKey || !url) throw new Error("Missing publishable Supabase configuration");
  const anon = createClient(url, publicKey, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } });

  const sourceResponse = await service.from("sources").select("id,name,url").eq("is_active", true).order("priority", { ascending: false }).limit(2);
  assertNoError(sourceResponse, "read fixture sources");
  if (!sourceResponse.data || sourceResponse.data.length < 2) throw new Error("Need two active source fixtures");
  const [sourceA, sourceB] = sourceResponse.data;
  const suffix = randomUUID();
  const externalId = `traceability-${suffix}`;
  const candidateA = candidateFor(sourceA, externalId, suffix);
  const createdRawItemIds: string[] = [];
  const articleSlug = `traceability-fixture-${suffix}`;

  try {
    const first = await persistRawItem(service, rawItemInputFromCandidate(candidateA, `traceability-hash-${suffix}`));
    createdRawItemIds.push(first.rawItemId);
    assert.equal(first.action, "created");
    assert.match(first.rawItemId, /^[0-9a-f-]{36}$/i);

    const reused = await persistRawItem(service, rawItemInputFromCandidate(candidateA, `traceability-hash-${suffix}`));
    assert.equal(reused.action, "reused");
    assert.equal(reused.rawItemId, first.rawItemId);

    const concurrentCandidate = candidateFor(sourceA, `${externalId}-concurrent`, `${suffix}-concurrent`);
    const concurrent = await Promise.all(Array.from({ length: 6 }, () => persistRawItem(service, rawItemInputFromCandidate(concurrentCandidate, `traceability-concurrent-${suffix}`))));
    const concurrentIds = [...new Set(concurrent.map((item) => item.rawItemId))];
    assert.equal(concurrentIds.length, 1);
    createdRawItemIds.push(concurrentIds[0]);
    const concurrentRows = await service.from("raw_items").select("id", { count: "exact" }).eq("source_id", sourceA.id).eq("external_id", concurrentCandidate.externalId);
    assertNoError(concurrentRows, "check concurrent raw item count");
    assert.equal(concurrentRows.count, 1);

    const candidateB = candidateFor(sourceB, externalId, `${suffix}-other-source`);
    const otherSource = await persistRawItem(service, rawItemInputFromCandidate(candidateB, `traceability-hash-other-${suffix}`));
    createdRawItemIds.push(otherSource.rawItemId);
    assert.notEqual(otherSource.rawItemId, first.rawItemId);

    await assert.rejects(() => persistRawItem(service, { ...rawItemInputFromCandidate(candidateA, `traceability-invalid-${suffix}`), original_url: "not-a-url" }), /persist raw_item failed/);

    const anonRead = await anon.from("raw_items").select("id").eq("id", first.rawItemId);
    assert.ok(anonRead.error || (anonRead.data?.length ?? 0) === 0, "raw_items must remain internal-only");
    if (anonRead.error) assert.ok(["42501", "PGRST301"].includes(anonRead.error.code) || /permission denied|row-level security/i.test(anonRead.error.message));

    const payload = structuredClone(validFixtures.PublicationPayload) as PublicationPayload;
    payload.eventKey = `traceability-readiness-${suffix}`;
    payload.event.canonicalTitle = `Traceability readiness fixture ${suffix}`;
    payload.article.slug = articleSlug;
    payload.sources = [{ sourceId: sourceA.id, rawItemId: first.rawItemId, sourceName: sourceA.name, url: sourceA.url, isPrimary: true, publishedAt: null }];
    payload.categories = [{ categorySlug: "chips", isPrimary: true, confidenceScore: 95 }];
    payload.verification = { ...payload.verification, eventKey: payload.eventKey, primarySourceId: sourceA.id, supportingSourceIds: [], verifiedFacts: [{ ...payload.verification.verifiedFacts[0], sourceIds: [sourceA.id] }] };
    payload.critic = { ...payload.critic, eventKey: payload.eventKey };
    const validReadiness = await validateRealPublicationReadiness(readinessInput(payload), new SupabasePublisherRepository(service));
    assert.equal(validReadiness.ready, true, JSON.stringify(validReadiness.issues));
    assert.equal(validReadiness.rawItemOwnershipChecked, 1);

    const missingRaw = structuredClone(payload);
    delete missingRaw.sources[0].rawItemId;
    const missingReadiness = await validateRealPublicationReadiness(readinessInput(missingRaw), new SupabasePublisherRepository(service));
    assert.equal(missingReadiness.ready, false);
    assert.ok(missingReadiness.issues.some((item) => item.code === "publication_missing_raw_item"));

    const wrongSource = structuredClone(payload);
    wrongSource.sources[0].sourceId = sourceB.id;
    wrongSource.sources[0].sourceName = sourceB.name;
    wrongSource.sources[0].url = sourceB.url;
    const wrongSourceReadiness = await validateRealPublicationReadiness(readinessInput(wrongSource), new SupabasePublisherRepository(service));
    assert.equal(wrongSourceReadiness.ready, false);
    assert.ok(wrongSourceReadiness.issues.some((item) => item.code === "publication_missing_raw_item"));

    const articleBefore = await service.from("articles").select("id", { count: "exact", head: true }).eq("slug", articleSlug);
    assertNoError(articleBefore, "check article before cleanup");
    assert.equal(articleBefore.count, 0);
    console.log(JSON.stringify({ integration: "raw-item-persistence", created: 3, reused: 1, concurrentDistinctIds: concurrentIds.length, sourceIsolation: "passed", ownership: "passed", readinessValid: "passed", readinessMissing: "blocked", readinessWrongSource: "blocked", anonymousRead: "blocked", articleWrites: 0, publishRpc: "not_called", groqCalls: 0 }, null, 2));
  } finally {
    const uniqueIds = [...new Set(createdRawItemIds.filter(Boolean))];
    for (const id of uniqueIds) {
      const deleted = await service.from("raw_items").delete().eq("id", id);
      if (deleted.error) throw new Error(`cleanup raw_item failed: ${deleted.error.message}`);
    }
    const after = await service.from("raw_items").select("id", { count: "exact" }).in("id", uniqueIds.length > 0 ? uniqueIds : ["00000000-0000-4000-8000-000000000000"]);
    assertNoError(after, "verify raw item cleanup");
    if ((after.data?.length ?? 0) !== 0) throw new Error("temporary raw items remain after cleanup");
    const articleAfter = await service.from("articles").select("id", { count: "exact", head: true }).eq("slug", articleSlug);
    assertNoError(articleAfter, "verify article cleanup");
    if (articleAfter.count !== 0) throw new Error("integration created an article unexpectedly");
    console.log("temporary raw item fixtures cleanup: PASS; no article writes");
  }
}

main().catch((error: unknown) => {
  console.error(`raw item persistence integration failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
