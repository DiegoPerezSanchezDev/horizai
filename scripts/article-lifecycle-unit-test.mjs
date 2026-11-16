import assert from "node:assert/strict";
import { archivePublishedFactualIncident12C2A, publishedFactualIncident12C2A } from "../lib/agents/publisher/article-lifecycle.ts";
import { SupabaseIncidentArticleLifecycleRepository } from "../lib/agents/publisher/supabase-incident-article-lifecycle-repository.ts";

const expected = { ...publishedFactualIncident12C2A, publication_status: "published" };
const calls = [];
let row = { id: expected.articleId, event_id: expected.eventId, slug: expected.slug, publication_status: "published" };
const repository = new SupabaseIncidentArticleLifecycleRepository({
  baseUrl: "https://supabase.example",
  serviceKey: "test-service-key",
  fetchImpl: async (input, init) => {
    const url = new URL(input);
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    if (init.method === "GET") return new Response(JSON.stringify([row]), { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(init.method, "PATCH");
    row = { ...row, publication_status: "archived" };
    return new Response(JSON.stringify([row]), { status: 200, headers: { "content-type": "application/json" } });
  },
});

const result = await archivePublishedFactualIncident12C2A(repository);
assert.equal(result.changed, true);
assert.equal(result.publicationStatus, "archived");
assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
const update = calls.find((call) => call.method === "PATCH");
assert.deepEqual(update.body, { publication_status: "archived" });
assert.equal(update.url.searchParams.get("id"), `eq.${expected.articleId}`);
assert.equal(update.url.searchParams.get("event_id"), `eq.${expected.eventId}`);
assert.equal(update.url.searchParams.get("slug"), `eq.${expected.slug}`);
assert.equal(update.url.searchParams.get("publication_status"), "eq.published");
assert.equal(update.headers.Prefer, "return=representation");
assert.equal(update.headers.Authorization, "Bearer test-service-key");

const idempotentCalls = [];
const idempotentRepo = {
  async readIncidentArticle() { idempotentCalls.push("read"); return { id: expected.articleId, event_id: expected.eventId, slug: expected.slug, publication_status: "archived" }; },
  async archivePublishedIncidentArticle() { idempotentCalls.push("patch"); return []; },
};
const idempotentResult = await archivePublishedFactualIncident12C2A(idempotentRepo);
assert.equal(idempotentResult.changed, false);
assert.deepEqual(idempotentCalls, ["read"]);

let mismatchedPatchCalls = 0;
await assert.rejects(() => archivePublishedFactualIncident12C2A({
  async readIncidentArticle() { return { id: "other-id", event_id: expected.eventId, slug: expected.slug, publication_status: "published" }; },
  async archivePublishedIncidentArticle() { mismatchedPatchCalls += 1; return []; },
}), /IDENTITY_MISMATCH/);
assert.equal(mismatchedPatchCalls, 0);

console.log("Incident lifecycle unit checks passed (exact identity, conditional single-field update, idempotency)");
