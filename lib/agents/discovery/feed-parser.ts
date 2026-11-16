import { XMLParser } from "fast-xml-parser";
import type { ParsedFeedItem } from "./discovery-types.ts";

type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  attributeNamePrefix: "@_",
  cdataPropName: "#cdata",
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

function asRecord(value: unknown): XmlRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as XmlRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function localName(key: string): string {
  return key.split(":").pop()?.toLowerCase() ?? key.toLowerCase();
}

function valuesByLocalName(record: XmlRecord, expectedName: string): unknown[] {
  return Object.entries(record)
    .filter(([key]) => localName(key) === expectedName.toLowerCase())
    .flatMap(([, value]) => asArray(value));
}

function firstByLocalName(record: XmlRecord, expectedName: string): unknown {
  return valuesByLocalName(record, expectedName)[0];
}

function textValue(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value).trim() || null;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["#text", "#cdata", "text"]) {
    const nested = record[key];
    if (typeof nested === "string" || typeof nested === "number") return String(nested).trim() || null;
  }
  return null;
}

function cleanExcerpt(value: string | null): string | null {
  if (!value) return null;
  const clean = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return clean || null;
}

function linkValue(value: unknown): string | null {
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (!record) {
      const text = textValue(entry);
      if (text) return text;
      continue;
    }
    const rel = textValue(record["@_rel"]);
    const href = textValue(record["@_href"]);
    if (href && (!rel || rel === "alternate" || rel === "self")) return href;
  }
  return null;
}

function parsePublishedAt(value: string | null): { publishedAt: string | null; dateReliable: boolean } {
  if (!value) return { publishedAt: null, dateReliable: false };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return { publishedAt: null, dateReliable: false };
  return { publishedAt: new Date(timestamp).toISOString(), dateReliable: true };
}

function parseItem(record: XmlRecord): ParsedFeedItem {
  const rawDate = textValue(firstByLocalName(record, "pubdate")) ??
    textValue(firstByLocalName(record, "published")) ??
    textValue(firstByLocalName(record, "updated")) ??
    textValue(firstByLocalName(record, "date"));
  const date = parsePublishedAt(rawDate);
  const excerpt = textValue(firstByLocalName(record, "description")) ??
    textValue(firstByLocalName(record, "summary")) ??
    textValue(firstByLocalName(record, "encoded"));

  return {
    externalId: textValue(firstByLocalName(record, "guid")) ?? textValue(firstByLocalName(record, "id")),
    url: linkValue(valuesByLocalName(record, "link")) ?? textValue(firstByLocalName(record, "url")),
    title: textValue(firstByLocalName(record, "title")),
    excerpt: cleanExcerpt(excerpt),
    publishedAt: date.publishedAt,
    dateReliable: date.dateReliable,
  };
}

export function parseFeed(xml: string): ParsedFeedItem[] {
  const document = asRecord(parser.parse(xml));
  if (!document) throw new Error("XML document is not an object");

  const rss = asRecord(firstByLocalName(document, "rss"));
  const rdf = asRecord(firstByLocalName(document, "rdf"));
  const atom = asRecord(firstByLocalName(document, "feed"));
  if (!rss && !rdf && !atom) throw new Error("XML document is not an RSS, Atom, or RDF feed");
  const channel = asRecord(firstByLocalName(rss ?? {}, "channel"));
  const itemRecords = [
    ...valuesByLocalName(channel ?? {}, "item"),
    ...valuesByLocalName(rdf ?? {}, "item"),
    ...valuesByLocalName(atom ?? {}, "entry"),
  ].map(asRecord).filter((item): item is XmlRecord => item !== null);

  return itemRecords.map(parseItem);
}
