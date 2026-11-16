import assert from "node:assert/strict";
import { z } from "zod";
import { toStrictProviderJsonSchema, validateStrictProviderJsonSchema } from "../lib/agents/runtime/strict-json-schema.ts";

const issue = z.object({ kind: z.literal("issue"), message: z.string() }).strict();
const unsupported = z.object({ kind: z.literal("unsupported_claim"), claim: z.string() }).strict();
const unionSchema = z.object({ findings: z.array(z.discriminatedUnion("kind", [issue, unsupported])) }).strict();
const generated = toStrictProviderJsonSchema(unionSchema);
const items = generated.properties?.findings?.items;
assert.ok(items && typeof items === "object" && !Array.isArray(items));
const unionBranches = items.anyOf ?? items.oneOf;
assert.ok(Array.isArray(unionBranches));
assert.equal(unionBranches.length, 2);
for (const branch of unionBranches) {
  assert.equal(branch.type, "object");
  assert.equal(branch.additionalProperties, false);
  assert.ok(Array.isArray(branch.required));
  assert.ok(branch.properties.kind.const === "issue" || branch.properties.kind.const === "unsupported_claim");
}

assert.throws(() => toStrictProviderJsonSchema(z.object({ values: z.array(z.any()) }).strict()), /no type|Invalid JSON Schema/);
assert.throws(() => validateStrictProviderJsonSchema({ type: "array", items: { anyOf: [] } }), /at least one branch/);
assert.throws(() => validateStrictProviderJsonSchema({ type: "array", items: { anyOf: [{ type: "object" }] } }), /strict-compatible/);
assert.throws(() => validateStrictProviderJsonSchema({ type: "array", items: { anyOf: [{ type: "object", properties: {}, required: [], additionalProperties: true }] } }), /strict-compatible/);
assert.throws(() => validateStrictProviderJsonSchema({ type: "array", items: { anyOf: [{ type: "object", properties: { kind: { const: "issue" } }, required: [], additionalProperties: false }] } }), /require every property/);
assert.throws(() => validateStrictProviderJsonSchema({ type: "array", items: {} }), /no type/);
assert.deepEqual(validateStrictProviderJsonSchema({ type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } }), { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }] } });
assert.deepEqual(validateStrictProviderJsonSchema({ allOf: [{ type: "string" }, { type: "string" }] }), { allOf: [{ type: "string" }, { type: "string" }] });
assert.deepEqual(validateStrictProviderJsonSchema({ type: "array", items: { anyOf: [{ type: "object", properties: { kind: { const: "issue" } }, required: ["kind"], additionalProperties: false }, { type: "object", properties: { kind: { const: "unsupported_claim" } }, required: ["kind"], additionalProperties: false }] } }), { type: "array", items: { anyOf: [{ type: "object", properties: { kind: { const: "issue" } }, required: ["kind"], additionalProperties: false }, { type: "object", properties: { kind: { const: "unsupported_claim" } }, required: ["kind"], additionalProperties: false }] } });

console.log("Strict JSON Schema combinator fixtures passed");
