// P0-b live capture: READ-ONLY GET of the public RSS/Atom feeds registered in migration 20260912000002.
// No Supabase, no persist, no providers, no article bodies. Two passes (48h, 168h): two requests per feed.
// Run: node --experimental-strip-types scripts/discovery-live-feed-capture-p0b.mjs
import { discoverFromSources } from "../lib/agents/discovery/discovery-runner.ts";

const feeds = [
  ["MIT Technology Review", "https://www.technologyreview.com/feed/", "US", "en"],
  ["The Verge AI", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", "US", "en"],
  ["TechCrunch AI", "https://techcrunch.com/category/artificial-intelligence/feed/", "US", "en"],
  ["Ars Technica", "https://feeds.arstechnica.com/arstechnica/technology-lab", "US", "en"],
  ["Hugging Face Blog", "https://huggingface.co/blog/feed.xml", "US", "en"],
  ["Google AI Blog", "https://blog.google/innovation-and-ai/technology/ai/rss/", "US", "en"],
  ["OpenAI News", "https://openai.com/news/rss.xml", "US", "en"],
  ["DeepMind Blog", "https://deepmind.google/blog/rss.xml", "GB", "en"],
  ["Nature Machine Intelligence", "https://www.nature.com/natmachintell.rss", "GB", "en"],
  ["EL PAIS Tecnologia", "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/tecnologia/portada", "ES", "es"],
  ["Xataka", "https://www.xataka.com/feedburner.xml", "ES", "es"],
].map(([name, feedUrl, countryCode, language], i) => ({
  id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
  name, url: feedUrl, feedUrl, discoveryMethod: "rss", sourceType: "website", countryCode, language, priority: 50,
}));

const out = {};
for (const hours of [48, 168]) {
  const r = await discoverFromSources(feeds, { hours, persist: false, concurrency: 2, timeoutMs: 20_000 });
  const perSource = r.sources.map((s) => ({
    source: s.source.name, country: s.source.countryCode, status: s.status,
    itemsInFeed: s.discovered, admittedInWindow: s.valid, undatedExcluded: s.undatedExcluded, invalid: s.invalid,
    error: s.error?.message ?? null,
  }));
  out[`window_${hours}h`] = {
    admittedTotal: r.candidates.length, duplicateUrls: r.duplicateUrls,
    byCountry: Object.fromEntries(Object.entries(r.candidates.reduce((a, c) => ((a[c.possibleCountryCode ?? "?"] = (a[c.possibleCountryCode ?? "?"] ?? 0) + 1), a), {}))),
    byLanguage: Object.fromEntries(Object.entries(r.candidates.reduce((a, c) => ((a[c.language] = (a[c.language] ?? 0) + 1), a), {}))),
    perSource,
  };
}
console.log(JSON.stringify({ capturedAt: new Date().toISOString(), ...out }, null, 2));
