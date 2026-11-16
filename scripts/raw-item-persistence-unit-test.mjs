import assert from "node:assert/strict";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { persistRawItem, rawItemInputFromCandidate } from "../lib/agents/ingestion/raw-item-repository.ts";

const sourceA = validFixtures.DiscoveryCandidate.sourceId;
const sourceB = "22222222-2222-4222-8222-222222222222";

function createFakeClient() {
  const sources = new Set([sourceA, sourceB]);
  const rows = new Map();
  let nextId = 1;

  const table = (name) => {
    if (name === "sources") {
      return {
        select() { return this; },
        eq(_column, value) { this.value = value; return this; },
        async maybeSingle() { return { data: sources.has(this.value) ? { id: this.value } : null, error: null }; },
      };
    }
    if (name !== "raw_items") throw new Error(`unexpected table ${name}`);
    return {
      operation: null,
      payload: null,
      filters: [],
      select() { return this; },
      insert(payload) { this.operation = "insert"; this.payload = payload; return this; },
      update(payload) { this.operation = "update"; this.payload = payload; return this; },
      eq(column, value) { this.filters.push([column, value]); return this; },
      async maybeSingle() {
        if (this.operation === "insert") {
          if (!/^https?:\/\//i.test(this.payload.original_url)) return { data: null, error: { code: "23514", message: "invalid original_url" } };
          const duplicate = [...rows.values()].find((row) => row.source_id === this.payload.source_id && row.external_id === this.payload.external_id);
          if (duplicate) return { data: null, error: { code: "23505", message: "duplicate identity" } };
          const row = { ...this.payload, id: `raw-${nextId++}`, processing_status: this.payload.processing_status ?? "pending", processing_attempts: this.payload.processing_attempts ?? 0 };
          rows.set(row.id, row);
          return { data: { id: row.id }, error: null };
        }
        const row = [...rows.values()].find((candidate) => this.filters.every(([column, value]) => candidate[column] === value));
        return { data: row ? { id: row.id, processing_status: row.processing_status, processing_attempts: row.processing_attempts } : null, error: null };
      },
      async then(resolve) {
        if (this.operation !== "update") return resolve({ data: null, error: null });
        const row = [...rows.values()].find((candidate) => this.filters.every(([column, value]) => candidate[column] === value));
        if (!row) return resolve({ data: null, error: { code: "P0001", message: "missing row" } });
        Object.assign(row, this.payload);
        return resolve({ data: null, error: null });
      },
    };
  };

  return { from: table, rows };
}

const candidate = structuredClone(validFixtures.DiscoveryCandidate);
candidate.externalId = "fixture-source-item-1";
candidate.sourceId = sourceA;
candidate.url = "https://example.com/raw-item-1";

const client = createFakeClient();
const first = await persistRawItem(client, rawItemInputFromCandidate(candidate, "candidate-hash-1"));
assert.equal(first.action, "created");
assert.match(first.rawItemId, /^raw-/);

const second = await persistRawItem(client, rawItemInputFromCandidate(candidate, "candidate-hash-1"));
assert.equal(second.action, "reused");
assert.equal(second.rawItemId, first.rawItemId);
assert.equal(client.rows.size, 1);

const updated = await persistRawItem(client, rawItemInputFromCandidate(candidate, "candidate-hash-update"), { updateExisting: true, skipIfProcessed: true });
assert.equal(updated.action, "reused");
assert.equal(updated.updated, true, "the persistence trace distinguishes an actual update from a row reuse");
assert.equal(client.rows.get(first.rawItemId).processing_attempts, 1);
client.rows.get(first.rawItemId).processing_status = "processed";
const skippedProcessed = await persistRawItem(client, rawItemInputFromCandidate(candidate, "candidate-hash-skip"), { updateExisting: true, skipIfProcessed: true });
assert.equal(skippedProcessed.updated, false, "processed raw items are mapped without falsely counting an update");
assert.equal(client.rows.get(first.rawItemId).processing_attempts, 1);

const concurrent = await Promise.all(Array.from({ length: 8 }, () => persistRawItem(client, rawItemInputFromCandidate(candidate, "candidate-hash-1"))));
assert.equal(new Set(concurrent.map((item) => item.rawItemId)).size, 1);
assert.equal(client.rows.size, 1);

const sameExternalOtherSource = { ...rawItemInputFromCandidate(candidate, "candidate-hash-2"), source_id: sourceB };
const otherSource = await persistRawItem(client, sameExternalOtherSource);
assert.notEqual(otherSource.rawItemId, first.rawItemId);
assert.equal(client.rows.size, 2);

await assert.rejects(() => persistRawItem(client, { ...rawItemInputFromCandidate(candidate, "candidate-hash-3"), original_url: "" }), /persist raw_item failed/);

console.log("raw item persistence unit: OK (created, reused, updated, processed-skip, concurrent identity, source isolation, fail-closed input)");
