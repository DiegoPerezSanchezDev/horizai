import { canonicalizeUrl } from "../discovery/canonical-url.ts";
import type { DiscoveryCandidate } from "../contracts/index.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type PageMetadata = {
  canonicalUrl: string | null;
  title: string | null;
  description: string | null;
  author: string | null;
  publishedAt: string | null;
  language: string | null;
  publisherName: string | null;
  dateSource: "jsonld" | "opengraph" | "time" | "rss" | null;
  openGraph: Record<string, string>;
  jsonLd: JsonValue | null;
  finalUrl: string;
  contentType: string;
};

type HtmlDocument = {
  querySelector(selector: string): {
    getAttribute(name: string): string | null;
    textContent: string | null;
  } | null;
  querySelectorAll(selector: string): ArrayLike<{
    getAttribute(name: string): string | null;
    textContent: string | null;
  }>;
  documentElement: { getAttribute(name: string): string | null } | null;
  title: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const record = asRecord(value);
  return record !== null && Object.values(record).every(isJsonValue);
}

function text(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function firstText(document: HtmlDocument, selectors: string[]): string | null {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = text(element?.getAttribute("content") ?? element?.textContent);
    if (value) return value;
  }
  return null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function recordString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? text(value) : null;
}

function nestedName(value: unknown): string | null {
  if (typeof value === "string") return text(value);
  return recordString(asRecord(value), "name");
}

function collectJsonLd(value: unknown, records: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLd(entry, records);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  records.push(record);
  collectJsonLd(record["@graph"], records);
}

function jsonLdMetadata(document: HtmlDocument): { value: JsonValue | null; records: Record<string, unknown>[] } {
  const values: JsonValue[] = [];
  const records: Record<string, unknown>[] = [];
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = text(script.textContent);
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isJsonValue(parsed)) {
        values.push(parsed);
        collectJsonLd(parsed, records);
      }
    } catch {
      // Invalid third-party JSON-LD is ignored; it is external data, not an instruction.
    }
  }
  return { value: values.length === 0 ? null : values.length === 1 ? values[0] : values, records };
}

export function extractPageMetadata(
  document: HtmlDocument,
  candidate: DiscoveryCandidate,
  finalUrl: string,
  contentType: string
): PageMetadata {
  const openGraph: Record<string, string> = {};
  for (const element of Array.from(document.querySelectorAll("meta[property^='og:']"))) {
    const property = text(element.getAttribute("property"));
    const content = text(element.getAttribute("content"));
    if (property && content) openGraph[property] = content;
  }

  const jsonLd = jsonLdMetadata(document);
  const articleRecord = jsonLd.records.find((record) => {
    const type = record["@type"];
    return typeof type === "string" && /article|newsarticle|reportage/i.test(type);
  }) ?? jsonLd.records[0] ?? null;
  const canonicalRaw = document.querySelector("link[rel='canonical']")?.getAttribute("href") ??
    firstText(document, ["meta[property='og:url']"]);
  let canonicalUrl: string | null = null;
  try {
    canonicalUrl = canonicalizeUrl(canonicalRaw ? new URL(canonicalRaw, finalUrl).toString() : finalUrl);
  } catch {
    canonicalUrl = candidate.url;
  }

  const jsonLdDate = isoDate(articleRecord?.["datePublished"]);
  const ogDate = isoDate(openGraph["article:published_time"] ?? openGraph["og:published_time"]);
  const timeDate = isoDate(document.querySelector("time[datetime]")?.getAttribute("datetime"));
  const publishedAt = jsonLdDate ?? ogDate ?? timeDate ?? candidate.publishedAt;
  const dateSource = jsonLdDate ? "jsonld" : ogDate ? "opengraph" : timeDate ? "time" : candidate.publishedAt ? "rss" : null;

  const language = text(document.documentElement?.getAttribute("lang")) ??
    firstText(document, ["meta[http-equiv='content-language']", "meta[name='language']"]) ??
    candidate.language;
  return {
    canonicalUrl,
    title: recordString(articleRecord, "headline") ?? openGraph["og:title"] ?? text(document.title) ?? candidate.titleOriginal,
    description: recordString(articleRecord, "description") ?? openGraph["og:description"] ?? firstText(document, ["meta[name='description']"]) ?? candidate.excerptOriginal,
    author: nestedName(articleRecord?.["author"]) ?? firstText(document, ["meta[name='author']", "meta[property='article:author']"]),
    publishedAt,
    language,
    publisherName: nestedName(articleRecord?.["publisher"]) ?? openGraph["og:site_name"] ?? null,
    dateSource,
    openGraph,
    jsonLd: jsonLd.value,
    finalUrl,
    contentType,
  };
}
