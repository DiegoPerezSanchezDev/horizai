import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { htmlToText } from "./content-normalizer.ts";

type ReadableDocument = {
  cloneNode(deep: boolean): ReadableDocument;
  querySelector(selector: string): { innerHTML: string; childNodes: ArrayLike<unknown> } | null;
  body: { innerHTML: string; childNodes: ArrayLike<unknown> } | null;
};

type ReadabilityResult = {
  content: string | null;
  textContent: string | null;
};

export type ReadableContent = {
  content: string | null;
  quality: "full" | "partial";
};

function parsedHtmlText(html: string): string {
  const parsedDocument = new JSDOM(`<body>${html}</body>`).window.document;
  return parsedDocument.body ? htmlToText(parsedDocument.body as never) : html.replace(/<[^>]+>/g, " ").trim();
}

export function extractReadableContent(document: ReadableDocument): ReadableContent {
  const readableDocument = document.cloneNode(true);
  const parsed = new Readability(readableDocument as never).parse() as ReadabilityResult | null;
  if (parsed?.content) {
    const text = parsedHtmlText(parsed.content);
    if (text.length >= 200) return { content: text, quality: "full" };
    if (text.length > 0) return { content: text, quality: "partial" };
  }

  const fallbackRoot = document.querySelector("article, main, [role='main'], body");
  if (fallbackRoot) {
    const text = htmlToText(fallbackRoot as never);
    if (text.length > 0) return { content: text, quality: "partial" };
  }
  return { content: null, quality: "partial" };
}
