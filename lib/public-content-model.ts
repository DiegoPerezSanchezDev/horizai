import type { Json, Database } from "@/types/database";

export type PublicArticleRow = Database["public"]["Views"]["public_published_articles"]["Row"];
export type PublicArticleSummaryRow = Pick<PublicArticleRow,
  | "slug"
  | "headline_es"
  | "summary_es"
  | "published_at"
  | "region_code"
  | "region_name"
  | "region_latitude"
  | "region_longitude"
  | "categories"
  | "sources"
  | "entities"
>;

export interface PublicArticleCategory {
  slug: string;
  name: string;
}

export interface PublicArticleSource {
  name: string;
  url: string | null;
}

export interface PublicArticleEntity {
  type: string;
  name: string;
  countryCode: string | null;
}

interface PublicArticleBase {
  slug: string;
  headline: string;
  summary: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  publishedAt: string;
  regionCode: string | null;
  regionName: string | null;
  latitude: number | null;
  longitude: number | null;
  categories: PublicArticleCategory[];
  sources: PublicArticleSource[];
  entities: PublicArticleEntity[];
}

export type PublicArticleSummary = PublicArticleBase;

export interface PublicArticle extends PublicArticleBase {
  whyItMatters: string | null;
  body: string | null;
  updatedAt: string;
}

export interface MapStory {
  slug: string;
  headline: string;
  summary: string | null;
  publishedAt: string;
  regionCode: string | null;
  regionName: string | null;
  categoryName: string | null;
  latitude: number;
  longitude: number;
}

export interface MapLocation {
  id: string;
  latitude: number;
  longitude: number;
  regionCode: string | null;
  regionName: string | null;
  stories: MapStory[];
}

export function getArticleHref(slug: string, articleBasePath = "/noticias"): string {
  const normalizedBasePath = articleBasePath.startsWith("/") ? articleBasePath : `/${articleBasePath}`;
  return `${normalizedBasePath.replace(/\/+$/, "")}/${encodeURIComponent(slug)}`;
}

export type ArticleBodyBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

function asObject(value: Json): Record<string, Json | undefined> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function asText(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseCategories(value: Json): PublicArticleCategory[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, PublicArticleCategory>();
  for (const entry of value) {
    const object = asObject(entry);
    const slug = asText(object?.slug);
    const name = asText(object?.name);
    if (slug && name && !unique.has(slug)) unique.set(slug, { slug, name });
  }
  return [...unique.values()];
}

function parseSources(value: Json): PublicArticleSource[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, PublicArticleSource>();
  for (const entry of value) {
    const object = asObject(entry);
    const name = asText(object?.name);
    if (!name) continue;
    const url = safeExternalUrl(asText(object?.url));
    const key = `${name.toLocaleLowerCase("es-ES")}\u0000${url ?? ""}`;
    if (!unique.has(key)) unique.set(key, { name, url });
  }
  return [...unique.values()];
}

function parseEntities(value: Json): PublicArticleEntity[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, PublicArticleEntity>();
  for (const entry of value) {
    const object = asObject(entry);
    const type = asText(object?.type);
    const name = asText(object?.name);
    if (!type || !name) continue;
    const countryCode = asText(object?.countryCode);
    const key = `${type.toLocaleLowerCase("es-ES")}\u0000${name.toLocaleLowerCase("es-ES")}`;
    if (!unique.has(key)) unique.set(key, { type, name, countryCode });
  }
  return [...unique.values()];
}

function baseFromRow(row: PublicArticleSummaryRow): PublicArticleBase {
  return {
    slug: row.slug,
    headline: row.headline_es,
    summary: row.summary_es?.trim() || null,
    imageUrl: null,
    imageAlt: null,
    publishedAt: row.published_at,
    regionCode: row.region_code?.trim() || null,
    regionName: row.region_name?.trim() || null,
    latitude: typeof row.region_latitude === "number" ? row.region_latitude : null,
    longitude: typeof row.region_longitude === "number" ? row.region_longitude : null,
    categories: parseCategories(row.categories),
    sources: parseSources(row.sources),
    entities: parseEntities(row.entities),
  };
}

export function mapPublicArticleSummary(row: PublicArticleSummaryRow): PublicArticleSummary {
  return baseFromRow(row);
}

export function mapPublicArticle(row: PublicArticleRow): PublicArticle {
  return {
    ...baseFromRow(row),
    whyItMatters: row.why_it_matters_es?.trim() || null,
    body: row.body_es?.trim() || null,
    updatedAt: row.updated_at,
  };
}

function hasUsableCoordinates(article: PublicArticleSummary): article is PublicArticleSummary & {
  latitude: number;
  longitude: number;
} {
  return article.latitude !== null
    && article.longitude !== null
    && Number.isFinite(article.latitude)
    && Number.isFinite(article.longitude)
    && article.latitude >= -90
    && article.latitude <= 90
    && article.longitude >= -180
    && article.longitude <= 180;
}

export function createMapLocations(articles: readonly PublicArticleSummary[]): MapLocation[] {
  const grouped = new Map<string, MapLocation>();
  for (const article of articles) {
    if (!hasUsableCoordinates(article)) continue;
    const id = `${article.latitude.toFixed(5)},${article.longitude.toFixed(5)}`;
    const location = grouped.get(id) ?? {
      id,
      latitude: article.latitude,
      longitude: article.longitude,
      regionCode: article.regionCode,
      regionName: article.regionName,
      stories: [],
    };
    location.stories.push({
      slug: article.slug,
      headline: article.headline,
      summary: article.summary,
      publishedAt: article.publishedAt,
      regionCode: article.regionCode,
      regionName: article.regionName,
      categoryName: article.categories[0]?.name ?? null,
      latitude: article.latitude,
      longitude: article.longitude,
    });
    grouped.set(id, location);
  }

  return [...grouped.values()].map((location) => ({
    ...location,
    stories: location.stories.toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
  }));
}

export function getAvailableCategories(articles: readonly PublicArticleSummary[]): PublicArticleCategory[] {
  const categories = new Map<string, PublicArticleCategory>();
  for (const article of articles) {
    for (const category of article.categories) categories.set(category.slug, category);
  }
  return [...categories.values()].toSorted((a, b) => a.name.localeCompare(b.name, "es"));
}

export function getAvailableRegions(articles: readonly PublicArticleSummary[]): Array<{ code: string; name: string }> {
  const regions = new Map<string, { code: string; name: string }>();
  for (const article of articles) {
    if (article.regionCode && article.regionName) {
      regions.set(article.regionCode, { code: article.regionCode, name: article.regionName });
    }
  }
  return [...regions.values()].toSorted((a, b) => a.name.localeCompare(b.name, "es"));
}

export function getRelatedArticles(
  article: PublicArticle,
  candidates: readonly PublicArticleSummary[],
  limit = 3,
): PublicArticleSummary[] {
  const entityKeys = new Set(article.entities.map((entity) => `${entity.type.toLocaleLowerCase("es-ES")}\u0000${entity.name.toLocaleLowerCase("es-ES")}`));
  if (entityKeys.size === 0) return [];
  return candidates
    .filter((candidate) => candidate.slug !== article.slug)
    .filter((candidate) => candidate.entities.some((entity) => entityKeys.has(`${entity.type.toLocaleLowerCase("es-ES")}\u0000${entity.name.toLocaleLowerCase("es-ES")}`)))
    .toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, limit);
}

export function parseArticleBody(body: string | null): ArticleBodyBlock[] {
  if (!body?.trim()) return [];
  const chunks = body.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n+/);
  const blocks: ArticleBodyBlock[] = [];

  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const heading = lines.length === 1 ? /^(#{2,3})\s+(.+)$/.exec(lines[0]) : null;
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length === 3 ? 3 : 2, text: heading[2] });
      continue;
    }

    const unordered = lines.every((line) => /^[-*]\s+/.test(line));
    const ordered = lines.every((line) => /^\d+[.)]\s+/.test(line));
    if (unordered || ordered) {
      blocks.push({
        kind: "list",
        ordered,
        items: lines.map((line) => line.replace(ordered ? /^\d+[.)]\s+/ : /^[-*]\s+/, "")),
      });
      continue;
    }

    blocks.push({ kind: "paragraph", text: lines.join(" ") });
  }
  return blocks;
}

export function formatPublishedDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Madrid",
  }).format(date);
}

export function getReadingTime(body: string | null): number | null {
  const wordCount = body?.trim().match(/\S+/g)?.length ?? 0;
  return wordCount ? Math.max(1, Math.ceil(wordCount / 220)) : null;
}
