import type { z } from "zod";
import { AgentError } from "./agent-errors.ts";
import { toStrictProviderJsonSchema } from "./strict-json-schema.ts";

type JsonObject = Record<string, unknown>;

/**
 * Keywords Gemini documents for structured output (https://ai.google.dev/gemini-api/docs/structured-output):
 * type (incl. type arrays with "null"), properties, required, additionalProperties, items, enum, anyOf, title,
 * description. `const`, `oneOf`, `allOf`, `$ref`, `pattern` and `format` are not in that list.
 * Length/property-count/uniqueness constraints are ignored server-side, so Zod stays the authority.
 */
const ALLOWED_KEYS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "title", "description"]);
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean"]);
const ALL_TYPES = new Set([...SCALAR_TYPES, "object", "array", "null"]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, message: string): never {
  throw new AgentError("cost_guard_violation", `Gemini JSON Schema conversion failed at ${path}: ${message}`);
}

function literalType(value: unknown, path: string): "string" | "number" | "boolean" {
  if (typeof value === "string") return "string";
  if (typeof value === "number" && Number.isFinite(value)) return "number";
  if (typeof value === "boolean") return "boolean";
  return fail(path, "const/enum values must be string, number or boolean");
}

function enumNode(node: JsonObject, values: unknown[], path: string): JsonObject {
  if (values.length === 0) fail(path, "enum must not be empty");
  const inferred = new Set(values.map((value) => literalType(value, path)));
  if (inferred.size !== 1) fail(path, "enum values must share one type");
  const inferredType = [...inferred][0];
  const declared = node.type;
  if (declared !== undefined && declared !== inferredType && !(declared === "integer" && inferredType === "number")) fail(path, "enum type does not match its values");
  return { type: declared ?? inferredType, enum: values };
}

function convertNode(value: unknown, path: string): JsonObject {
  if (!isObject(value)) return fail(path, "schema node must be an object");
  if (value.$ref !== undefined || value.$defs !== undefined) return fail(path, "$ref/$defs are not supported; inline the schema");
  if ("allOf" in value) {
    const branches = value.allOf;
    if (!Array.isArray(branches) || branches.length !== 1) return fail(path, "allOf with more than one branch cannot be represented");
    return convertNode(branches[0], `${path}.allOf[0]`);
  }
  const unionKey = "anyOf" in value ? "anyOf" : "oneOf" in value ? "oneOf" : null;
  if (unionKey) {
    const branches = value[unionKey];
    if (!Array.isArray(branches) || branches.length === 0) return fail(path, `${unionKey} must contain at least one branch`);
    const converted = branches.map((branch, index) => convertNode(branch, `${path}.${unionKey}[${index}]`));
    if (converted.length === 1) return converted[0];
    const nulls = converted.filter((branch) => branch.type === "null");
    const rest = converted.filter((branch) => branch.type !== "null");
    // Nullable value: Gemini documents null through a type array, not through a `null` branch.
    if (nulls.length === 1 && rest.length === 1 && typeof rest[0].type === "string" && !("anyOf" in rest[0])) {
      const inner = rest[0];
      return { ...inner, type: [inner.type, "null"], ...(Array.isArray(inner.enum) ? { enum: [...inner.enum, null] } : {}) };
    }
    // Several literals of one type collapse into one enum: fewer branches, smaller output grammar.
    const scalarType = rest[0]?.type;
    if (nulls.length === 0 && typeof scalarType === "string" && SCALAR_TYPES.has(scalarType)
      && converted.every((branch) => branch.type === scalarType && Array.isArray(branch.enum))) {
      return { type: scalarType, enum: converted.flatMap((branch) => branch.enum as unknown[]) };
    }
    return { anyOf: converted };
  }
  if ("const" in value) {
    if (value.const === null) return { type: "null" };
    return enumNode({}, [value.const], path);
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum)) return fail(path, "enum must be an array");
    return enumNode(value, value.enum, path);
  }
  const type = value.type;
  if (typeof type !== "string" || !ALL_TYPES.has(type)) return fail(path, "node needs a single supported type");
  if (type === "object") {
    if (!isObject(value.properties) || !Array.isArray(value.required)) return fail(path, "object needs properties and required");
    const properties: JsonObject = {};
    for (const [name, property] of Object.entries(value.properties)) properties[name] = convertNode(property, `${path}.properties.${name}`);
    return { type: "object", properties, required: value.required, additionalProperties: false };
  }
  if (type === "array") return { type: "array", items: convertNode(value.items, `${path}.items`) };
  return { type };
}

/** Rejects anything outside the documented subset; used on the converter's own output as a last gate. */
export function assertGeminiSchemaSubset(value: unknown, path = "schema"): void {
  if (!isObject(value)) return fail(path, "schema node must be an object");
  for (const key of Object.keys(value)) if (!ALLOWED_KEYS.has(key)) fail(path, `keyword "${key}" is outside the Gemini subset`);
  const type = value.type;
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  if (types.some((entry) => typeof entry !== "string" || !ALL_TYPES.has(entry))) fail(path, "unsupported type");
  if (type === undefined && value.anyOf === undefined) fail(path, "node has neither type nor anyOf");
  if (isObject(value.properties)) for (const [name, property] of Object.entries(value.properties)) assertGeminiSchemaSubset(property, `${path}.properties.${name}`);
  if (value.items !== undefined) assertGeminiSchemaSubset(value.items, `${path}.items`);
  if (Array.isArray(value.anyOf)) value.anyOf.forEach((branch, index) => assertGeminiSchemaSubset(branch, `${path}.anyOf[${index}]`));
}

/** Converts an already-built provider-strict JSON Schema to the Gemini-documented subset. */
export function strictSchemaToGeminiSchema(strictSchema: JsonObject): JsonObject {
  const converted = convertNode(strictSchema, "schema");
  assertGeminiSchemaSubset(converted);
  return converted;
}

/** Zod → strict provider schema (no pattern/format/length) → Gemini subset. Zod remains authoritative after the call. */
export function toGeminiJsonSchema<T>(schema: z.ZodType<T>): JsonObject {
  return strictSchemaToGeminiSchema(toStrictProviderJsonSchema(schema));
}
