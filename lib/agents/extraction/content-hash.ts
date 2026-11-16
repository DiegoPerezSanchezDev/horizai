import { createHash } from "node:crypto";
import { normalizeContentText } from "./content-normalizer.ts";

export function normalizeContentForHash(content: string): string {
  return normalizeContentText(content).replace(/\s+/g, " ").trim();
}

export function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(normalizeContentForHash(content), "utf8").digest("hex")}`;
}
