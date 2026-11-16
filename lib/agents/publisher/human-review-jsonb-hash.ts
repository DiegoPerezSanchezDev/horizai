import { createHash } from "node:crypto";

/**
 * Renders a JSON value the way PostgreSQL renders jsonb::text (", " and ": " separators, object keys ordered by
 * byte length and then bytes) so the application can recompute hashes the database computed over a jsonb value.
 */
export function postgresJsonbText(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(postgresJsonbText).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined);
    entries.sort(([a], [b]) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${postgresJsonbText(entry)}`).join(", ")}}`;
  }
  throw new Error("JSONB_TEXT_UNSUPPORTED_VALUE");
}

export function humanReviewPublicationPayloadSha256(payload: unknown): string {
  return createHash("sha256").update(postgresJsonbText(payload), "utf8").digest("hex");
}
