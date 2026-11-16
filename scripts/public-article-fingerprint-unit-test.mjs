import assert from "node:assert/strict";
import { publicArticleFingerprintV1, publicArticleFingerprintVersion } from "../lib/articles/public-article-fingerprint.ts";

const article = {
  id: "synthetic-id-1",
  slug: "synthetic-story",
  headline_es: "Titular sintético",
  summary_es: "Resumen breve",
  why_it_matters_es: null,
  body_es: "Cuerpo del artículo.",
  metadata: { publisher: "Synthetic", nested: { z: 2, a: 1 }, tags: ["one", "two"] },
  publication_status: "published",
  updated_at: "2026-10-07T00:00:00Z",
};

assert.equal(publicArticleFingerprintVersion, "publicArticleFingerprintV1");
const baseline = publicArticleFingerprintV1(article);
assert.match(baseline, /^[a-f0-9]{64}$/);
assert.equal(publicArticleFingerprintV1(article), baseline, "same article yields the same fingerprint");

const reordered = {
  ...article,
  metadata: { tags: ["one", "two"], nested: { a: 1, z: 2 }, publisher: "Synthetic" },
};
assert.equal(publicArticleFingerprintV1(reordered), baseline, "object key order does not affect the fingerprint");
const topLevelReordered = {
  metadata: article.metadata,
  body_es: article.body_es,
  why_it_matters_es: article.why_it_matters_es,
  summary_es: article.summary_es,
  headline_es: article.headline_es,
  slug: article.slug,
};
assert.equal(publicArticleFingerprintV1(topLevelReordered), baseline, "top-level field order does not affect the fingerprint");

for (const [field, value] of [
  ["slug", "synthetic-story-changed"],
  ["headline_es", "Titular sintético cambiado"],
  ["summary_es", "Resumen cambiado"],
  ["why_it_matters_es", "Importancia cambiada"],
  ["body_es", "Cuerpo cambiado."],
  ["metadata", { publisher: "Synthetic", nested: { a: 1, z: 3 }, tags: ["one", "two"] }],
]) {
  assert.notEqual(publicArticleFingerprintV1({ ...article, [field]: value }), baseline, `${field} participates in the fingerprint`);
}

assert.equal(publicArticleFingerprintV1({ ...article, id: "synthetic-id-2", publication_status: "archived", updated_at: "2026-10-08T00:00:00Z" }), baseline,
  "IDs, publication state, and timestamps are excluded as volatile/read-time fields");
assert.notEqual(publicArticleFingerprintV1({ ...article, why_it_matters_es: "" }), baseline, "null remains distinct from an empty string");

console.log("Public article fingerprint V1 fixtures passed");
