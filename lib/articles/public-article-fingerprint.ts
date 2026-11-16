import { createHash } from "node:crypto";
import type { Database, Json } from "../../types/database.ts";

export const publicArticleFingerprintVersion = "publicArticleFingerprintV1" as const;

export type PublicArticleFingerprintInput = Pick<
  Database["public"]["Tables"]["articles"]["Row"],
  "slug" | "headline_es" | "summary_es" | "why_it_matters_es" | "body_es" | "metadata"
>;

function canonicalizeJson(value: Json): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("PUBLIC_ARTICLE_FINGERPRINT_INVALID_JSON_NUMBER");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);

  const canonical: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) throw new TypeError("PUBLIC_ARTICLE_FINGERPRINT_INVALID_JSON_VALUE");
    canonical[key] = canonicalizeJson(entry);
  }
  return canonical;
}

/**
 * Stable application-side fingerprint for the substantive public article fields.
 * IDs, publication state, timestamps, and other read-time fields are deliberately excluded.
 */
export function publicArticleFingerprintV1(article: PublicArticleFingerprintInput): string {
  const canonicalRecord = canonicalizeJson({
    slug: article.slug,
    headline_es: article.headline_es,
    summary_es: article.summary_es,
    why_it_matters_es: article.why_it_matters_es,
    body_es: article.body_es,
    metadata: article.metadata,
  } as Json);
  const serialized = JSON.stringify(canonicalRecord);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}
