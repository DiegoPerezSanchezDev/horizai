import type { ExtractedItem } from "../contracts/index.ts";
import type { ComparableItem } from "./cluster-types.ts";

const stopwords = new Set([
  "about", "after", "also", "and", "are", "con", "del", "desde", "for", "from", "has", "have", "how", "into", "its", "las", "los", "más", "new", "not", "of", "on", "para", "por", "que", "the", "this", "una", "with", "will", "their", "they", "una", "uno", "unos", "unas", "se", "en", "el", "la", "y", "de", "un", "es", "al", "lo", "su", "sus", "ha", "han", "como", "entre", "sobre", "tras", "ya", "at", "to", "in", "a", "an", "is", "it", "its", "be", "by", "or", "as", "that", "than", "was", "were", "has", "had", "will", "would", "can", "could", "may", "might", "after", "before", "over", "under", "says", "said"
]);

const editorialNoise = new Set([
  "breaking", "exclusive", "exclusivo", "última", "hora", "latest", "update", "updated", "watch", "live", "analysis", "opinion", "report", "reports", "according", "reveals", "revealed", "launch", "launches", "launched", "release", "releases", "released", "unveil", "unveils", "unveiled", "announce", "announces", "announced", "anuncia", "anuncian", "anuncio", "lanza", "lanzan", "presenta", "presentan", "publica", "publican"
]);

const entityVocabulary = new Set([
  "openai", "anthropic", "google", "deepmind", "microsoft", "nvidia", "meta", "huggingface", "mistral", "reuters", "gpt", "claude", "gemini", "gemma", "llama", "qwen", "copilot", "chatgpt", "europa", "european", "commission"
]);

const modelPattern = /\b(gpt|claude|gemini|gemma|llama|mistral|qwen|o[1-9]|r[1-9])\s*[-.]?\s*(\d+(?:\.\d+)?)?\b/gi;

export function normalizeEventText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function eventTokens(value: string | null | undefined): Set<string> {
  return new Set(
    normalizeEventText(value)
      .split(" ")
      .filter((token) => token.length >= 2 && !stopwords.has(token) && !editorialNoise.has(token))
  );
}

function modelSignatures(value: string): Set<string> {
  const signatures = new Set<string>();
  for (const match of value.matchAll(modelPattern)) {
    signatures.add(`${match[1].toLowerCase()}${match[2] ? `-${match[2]}` : ""}`);
  }
  return signatures;
}

function numberTokens(value: string): Set<string> {
  return new Set(value.match(/\b\d+(?:\.\d+)?\b/g) ?? []);
}

function metadataString(item: ExtractedItem, key: string): string | null {
  const value = item.metadata[key];
  return typeof value === "string" ? value : null;
}

function sourceIsOfficial(item: ExtractedItem): boolean {
  return /openai|google|deepmind|hugging ?face|nvidia|microsoft|anthropic|mistral|nature|european commission/i.test(
    metadataString(item, "sourceName") ?? ""
  );
}

export function comparableItem(item: ExtractedItem): ComparableItem {
  const titleNormalized = normalizeEventText(item.title);
  const descriptionNormalized = normalizeEventText(item.description);
  const relevantTokens = new Set([...eventTokens(item.title), ...eventTokens(item.description)]);
  const country = metadataString(item, "sourceCountryCode");
  const region = metadataString(item, "sourceRegionCode");
  return {
    item,
    titleNormalized,
    descriptionNormalized,
    titleTokens: eventTokens(item.title),
    descriptionTokens: eventTokens(item.description),
    relevantTokens,
    entityTokens: new Set([...relevantTokens].filter((token) => entityVocabulary.has(token))),
    modelSignatures: modelSignatures(`${item.title} ${item.description}`),
    numberTokens: numberTokens(`${item.title} ${item.description}`),
    sourceId: metadataString(item, "sourceId") ?? "unknown-source",
    sourceName: metadataString(item, "sourceName") ?? "Unknown source",
    sourceCountryCode: country,
    sourceRegionCode: region,
    publishedAtMs: item.publishedAt ? Date.parse(item.publishedAt) : null,
    officialSource: sourceIsOfficial(item),
  };
}
