import { z } from "zod";
import { AgentError } from "./agent-errors.ts";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictNode(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw new AgentError("cost_guard_violation", `Invalid JSON Schema at ${path}`);
  const combinators = ["anyOf", "oneOf", "allOf"] as const;
  const presentCombinators = combinators.filter((name) => name in value);
  if (presentCombinators.length > 0) {
    if (value.type !== undefined) throw new AgentError("cost_guard_violation", `JSON Schema combinator at ${path} cannot also define type`);
    if (presentCombinators.length !== 1) throw new AgentError("cost_guard_violation", `JSON Schema node at ${path} must use one combinator`);
    const name = presentCombinators[0];
    const branches = value[name];
    if (!Array.isArray(branches) || branches.length === 0) throw new AgentError("cost_guard_violation", `JSON Schema ${name} at ${path} must contain at least one branch`);
    return { [name]: branches.map((entry, index) => strictNode(entry, `${path}.${name}[${index}]`)) };
  }
  if (value.type === "object") {
    if (!isObject(value.properties) || value.additionalProperties !== false || !Array.isArray(value.required)) {
      throw new AgentError("cost_guard_violation", `JSON Schema object at ${path} is not strict-compatible`);
    }
    const propertyNames = Object.keys(value.properties);
    const required = value.required.filter((entry): entry is string => typeof entry === "string");
    if (required.length !== propertyNames.length || required.some((name) => !propertyNames.includes(name))) {
      throw new AgentError("cost_guard_violation", `JSON Schema object at ${path} must require every property`);
    }
    const properties: JsonObject = {};
    for (const [name, property] of Object.entries(value.properties)) properties[name] = strictNode(property, `${path}.properties.${name}`);
    return { type: "object", properties, required, additionalProperties: false };
  }
  if (value.type === "array") {
    return { type: "array", items: strictNode(value.items, `${path}.items`) };
  }
  if ("const" in value) return { const: value.const };
  if (value.enum !== undefined) return { type: value.type, enum: value.enum };
  if (value.type === undefined) throw new AgentError("cost_guard_violation", `JSON Schema node at ${path} has no type`);
  return { type: value.type };
}

/**
 * Converts Zod's complete JSON Schema to the conservative strict subset accepted
 * by OpenAI-compatible providers. Zod remains authoritative for all constraints.
 */
export function toStrictProviderJsonSchema<T>(schema: z.ZodType<T>): JsonObject {
  const generated = z.toJSONSchema(schema);
  return strictNode(generated, "schema");
}

/** Validates an already-generated JSON Schema against the provider subset. */
export function validateStrictProviderJsonSchema(value: unknown): JsonObject {
  return strictNode(value, "schema");
}
