import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";
import { normalArticleHtml, articleWithoutArticleTagHtml } from "../lib/agents/extraction/fixtures.ts";
import { extractReadableContent } from "../lib/agents/extraction/readability-extractor.ts";
import { createSecondaryAttributionVerifierInputFixture } from "../lib/agents/verifier/verifier-fixtures.ts";

const stored = JSON.parse(readFileSync(new URL("./fixtures/stored-discovery-evidence-12f1b.json", import.meta.url), "utf8"));
const row = (id) => stored.find((item) => item.id === id);
const asItem = (raw) => ({ title: raw.title, description: raw.excerpt, content: raw.raw_content ?? "", extractionQuality: raw.extraction_quality ?? "partial" });
export const mitStored = row("bf446840-8bf9-44d0-8ad0-8315bc174d45");
export const mitEvidence = asItem(mitStored);
const entry = (id, kind, item, expected, provenance) => ({ id, kind, item, expected, provenance });
const short = validFixtures.ExtractedItem.content.split(". ")[1];
const normal = extractReadableContent(new JSDOM(normalArticleHtml).window.document);
const spanish = extractReadableContent(new JSDOM(articleWithoutArticleTagHtml).window.document);
const attribution = createSecondaryAttributionVerifierInputFixture();

export const qualityCorpus = [
  entry("public-un-agents", "known-public-story", asItem(row("0436dcb3-8d60-4030-a8c2-b7d9f96e6ccf")), true, "Stored raw item linked to public article 6203559f-413a-4f06-9346-1720bbeb0e7a"),
  entry("public-border-towers", "known-public-story", asItem(row("23550f1e-cfc2-47ed-b6c5-dd90d16736c7")), true, "Stored raw item linked to public article 7415c685-04ed-4956-a77a-4bc372c9b060"),
  entry("historical-meta-muse", "historical-substantive-report", asItem(row("80f95702-7417-4abb-97ad-e0ff7e2cb7f9")), true, "Stored 12A source snapshot; not a factual verification label"),
  entry("historical-engram", "historical-substantive-report", asItem(row("3438557b-1f08-4c78-8ed8-49e69e17c02f")), true, "Stored 12A source snapshot; not a factual verification label"),
  entry("historical-microrobot-references", "reference-list-diagnostic", asItem(row("e8c0ac9d-f3c1-44c9-bdf2-71201eba4d53")), null, "Stored 12A bibliography-heavy extraction; evaluate uncertain relevance without imposing a good/bad label"),
  entry("mit-703", "corporate-promotional", mitEvidence, false, "Exact stored 12F extraction, 703 characters"),
  entry("contract-article", "substantive-article", validFixtures.ExtractedItem, true, "Existing contracts/fixtures.ts"),
  entry("short-article", "short-substantive-article", { ...validFixtures.ExtractedItem, content: short, extractionQuality: "partial" }, true, "Second sentence of existing contract extraction, ten words"),
  entry("short-no-final-punctuation", "uncertain-substantive-format", { ...validFixtures.ExtractedItem, content: short.replace(/\.$/, ""), extractionQuality: "partial" }, true, "Same fixture sentence without final punctuation"),
  entry("html-extraction", "multi-paragraph-extraction", { title: "Structured article title", description: "OpenGraph description", content: normal.content, extractionQuality: normal.quality }, true, "Existing normalArticleHtml passed through real Readability"),
  entry("spanish-extraction", "substantive-spanish-extraction", { title: "Contenido en un contenedor genérico como extracción parcial", description: null, content: spanish.content, extractionQuality: spanish.quality }, true, "Existing articleWithoutArticleTagHtml; descriptive title derived from its text"),
  entry("secondary-attribution", "uncertain-substantive-article", { ...attribution.items[0], extractionQuality: "full" }, true, "Existing secondary attribution Verifier fixture; truth remains Verifier's role"),
  entry("metadata-teaser", "metadata-only-teaser", { ...mitEvidence, content: mitEvidence.description, extractionQuality: "metadata_only" }, false, "Stored discovery/OpenGraph teaser only"),
  entry("title-related-teaser", "title-related-low-information-teaser", { ...mitEvidence, content: "Watch the climate tech companies list.", extractionQuality: "full" }, false, "Short teaser derived from stored title and description terms; full label alone is not enough"),
  entry("long-promotion", "long-irrelevant-promotion", { ...validFixtures.ExtractedItem, content: Array(8).fill(mitEvidence.content).join("\n\n") }, false, "Repeated stored promotional text against the existing AI-chip candidate"),
  entry("changed-corporate-block", "different-hash-same-bad-structure", { ...mitEvidence, content: mitEvidence.content.replaceAll("MIT Technology Review", "Independent Publishing Group").replace("1899", "1998") }, false, "Identity substitutions in the stored institutional text"),
  entry("long-navigation", "long-navigation-index", { ...mitEvidence, content: Array(30).fill("References\n\nArticle\n\nGoogle Scholar\n\nRelated content").join("\n\n") }, false, "Repeated menu labels present in the stored reference extraction"),
  entry("headline-echo", "headline-only-repetition", { ...mitEvidence, content: Array(25).fill(mitEvidence.title).join("\n\n") }, false, "Repeated candidate title with no body evidence"),
  entry("empty", "empty-content", { ...validFixtures.ExtractedItem, content: "" }, false, "Empty-content edge"),
  entry("noise", "whitespace-noise", { ...validFixtures.ExtractedItem, content: " \n\t... --- ||| \n " }, false, "Whitespace/punctuation edge"),
];
