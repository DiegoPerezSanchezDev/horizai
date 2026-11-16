import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VISUAL_QA_ARTICLES, VISUAL_QA_STORIES } from "./frontend-visual-qa-fixtures.ts";
import {
  createMapLocations,
  getAvailableCategories,
  getArticleHref,
  getRelatedArticles,
  getReadingTime,
  mapPublicArticle,
  mapPublicArticleSummary,
  parseArticleBody,
  formatPublishedDate,
} from "../lib/public-content-model.ts";
import { publicContentError, publicContentReady } from "../lib/public-content-result.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const row = (overrides = {}) => ({
  slug: "nueva-ley-de-ia",
  headline_es: "La nueva ley de IA entra en vigor",
  summary_es: "Un resumen del cambio regulatorio.",
  why_it_matters_es: "Afecta a quienes desarrollan estos sistemas.",
  body_es: "## Qué cambia\n\nLa norma define obligaciones nuevas.\n\n- Transparencia\n- Supervisión humana",
  published_at: "2026-09-26T12:00:00.000Z",
  updated_at: "2026-09-26T12:00:00.000Z",
  region_code: "EU",
  region_name: "Europa",
  region_latitude: 50.85,
  region_longitude: 4.35,
  categories: [{ slug: "regulacion", name: "Regulación" }],
  sources: [{ name: "Comisión Europea", url: "https://europa.example/news" }, { name: "Unsafe", url: "javascript:alert(1)" }],
  entities: [{ type: "organization", name: "Comisión Europea", countryCode: "BE" }],
  ...overrides,
});

const article = mapPublicArticle(row());
assert.equal(article.headline, "La nueva ley de IA entra en vigor");
assert.equal(article.summary, "Un resumen del cambio regulatorio.");
assert.equal(article.sources.length, 2);
assert.equal(article.sources[0].url, "https://europa.example/news");
assert.equal(article.sources[1].url, null, "unsafe protocols are not exposed as links");
assert.equal(article.categories[0].name, "Regulación");
assert.equal(article.imageUrl, null, "the current published-view contract has no image field");
assert.equal(mapPublicArticleSummary(row({ summary_es: null })).summary, null);

const samePlace = mapPublicArticleSummary(row({ slug: "otra-historia" }));
const missingCoordinates = mapPublicArticleSummary(row({ slug: "sin-lugar", region_latitude: null, region_longitude: null }));
const invalidCoordinates = mapPublicArticleSummary(row({ slug: "fuera-del-mundo", region_latitude: 95, region_longitude: 220 }));
const locations = createMapLocations([article, samePlace, missingCoordinates, invalidCoordinates]);
assert.equal(locations.length, 1, "same coordinates form one map location");
assert.equal(locations[0].stories.length, 2);
assert.deepEqual(createMapLocations([]), [], "empty public results produce no fabricated locations");
assert.deepEqual(getAvailableCategories([article]).map(({ slug }) => slug), ["regulacion"]);

const related = mapPublicArticleSummary(row({ slug: "contexto" }));
const unrelated = mapPublicArticleSummary(row({ slug: "otra-entidad", entities: [{ type: "organization", name: "Otra entidad", countryCode: "BE" }] }));
assert.deepEqual(getRelatedArticles(article, [article, related, unrelated]).map(({ slug }) => slug), ["contexto"]);

assert.deepEqual(parseArticleBody(article.body).map(({ kind }) => kind), ["heading", "paragraph", "list"]);
assert.equal(getReadingTime(article.body), 1);
assert.equal(getReadingTime(null), null);
assert.equal(formatPublishedDate("2026-09-26T12:00:00.000Z"), "26 sept 2026, 14:00", "published dates render in a deterministic Spanish product timezone during SSR and hydration");

const successfulEmptyRead = publicContentReady([]);
const failedRead = publicContentError([]);
assert.equal(successfulEmptyRead.status, "ready", "a successful zero-row result stays a valid empty state");
assert.deepEqual(successfulEmptyRead.data, []);
assert.equal(failedRead.status, "error", "a read failure stays distinguishable from a valid empty state");
assert.deepEqual(failedRead.data, []);

const qaLead = VISUAL_QA_ARTICLES.find(({ slug }) => slug === "qa-aurora-global-model");
const qaWithoutImage = VISUAL_QA_ARTICLES.find(({ slug }) => slug === "qa-berlin-open-weights");
const qaWithoutGeo = VISUAL_QA_STORIES.find(({ slug }) => slug === "qa-no-geography");
assert.ok(qaLead);
assert.ok(qaLead.imageUrl?.startsWith("data:image/svg+xml"));
assert.ok(qaLead.imageAlt);
assert.equal(qaLead.sources.length, 3);
assert.ok((qaLead.body?.split("\n\n").length ?? 0) >= 8, "the long QA story spans multiple body sections");
assert.ok(qaWithoutImage);
assert.equal(qaWithoutImage.imageUrl, null, "a second QA story exercises the no-image treatment");
assert.ok(qaWithoutGeo);
assert.equal(qaWithoutGeo.categories.length, 0);
assert.equal(qaWithoutGeo.regionName, null);
assert.equal(qaWithoutGeo.latitude, null);
assert.equal(createMapLocations(VISUAL_QA_STORIES).length, 3, "the visual fixture has three map locations");
assert.equal(createMapLocations(VISUAL_QA_STORIES).reduce((sum, location) => sum + location.stories.length, 0), 4);
assert.equal(createMapLocations(VISUAL_QA_STORIES).find(({ regionCode }) => regionCode === "EU")?.stories.length, 2, "same-point stories group safely");
const berlinLocation = createMapLocations(VISUAL_QA_STORIES).find(({ regionCode }) => regionCode === "EU");
assert.equal(berlinLocation?.stories[0].slug, "qa-berlin-open-weights", "the latest Berlin marker story is deterministic");
assert.equal(getArticleHref(berlinLocation?.stories[0].slug ?? ""), "/noticias/qa-berlin-open-weights", "a marker story resolves to its expected production article path");
assert.equal(VISUAL_QA_STORIES.length - createMapLocations(VISUAL_QA_STORIES).reduce((sum, location) => sum + location.stories.length, 0), 1, "missing geography creates no marker");
assert.equal(getArticleHref("qa-aurora-global-model"), "/noticias/qa-aurora-global-model");
assert.equal(getArticleHref("qa-aurora-global-model", "/qa-visual/article"), "/qa-visual/article/qa-aurora-global-model");
assert.equal(getArticleHref("part/a", "/qa-visual/article"), "/qa-visual/article/part%2Fa");

const publicLoaderSource = readFileSync(resolve(projectRoot, "lib/public-content.ts"), "utf8");
assert.match(publicLoaderSource, /from\("public_published_articles"\)/);
assert.match(publicLoaderSource, /\.eq\("slug", slug\)\s*\.maybeSingle\(\)/);
assert.match(publicLoaderSource, /publicContentReady\(data \? mapPublicArticle/);
assert.doesNotMatch(publicLoaderSource, /frontend-visual-qa-fixtures|VISUAL_QA_ARTICLES|VISUAL_QA_STORIES/);
const publicArticleRoute = readFileSync(resolve(projectRoot, "app/noticias/[slug]/page.tsx"), "utf8");
assert.match(publicArticleRoute, /getPublishedArticleBySlug\(slug\)/);
assert.match(publicArticleRoute, /if \(!result\.data\) notFound\(\)/, "a successfully read archived slug becomes a normal 404");
assert.equal(existsSync(resolve(projectRoot, "app/qa-visual/page.tsx")), false, "temporary visual homepage route is removed before delivery/build");
assert.equal(existsSync(resolve(projectRoot, "app/qa-visual/article/[slug]/page.tsx")), false, "temporary visual article route is removed before delivery/build");

console.log("Frontend public content and QA-isolation unit checks passed");
