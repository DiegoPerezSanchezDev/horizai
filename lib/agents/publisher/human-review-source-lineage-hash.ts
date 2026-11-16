import { createHash } from "node:crypto";
import type { HumanReviewArtifact } from "./human-review.ts";

/** M31 hashes source lineage as PostgreSQL jsonb::text (string fields only). */
export function humanReviewSourceLineageSha256(lineage: HumanReviewArtifact["sourceLineage"]): string {
  const jsonbText = `[${lineage.map((entry) => {
    const keys = Object.keys(entry).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${keys.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(entry[key as keyof typeof entry])}`).join(", ")}}`;
  }).join(", ")}]`;
  return createHash("sha256").update(jsonbText, "utf8").digest("hex");
}
