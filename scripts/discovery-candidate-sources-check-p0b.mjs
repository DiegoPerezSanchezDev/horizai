// P0-b candidate source check. READ-ONLY: one GET per candidate feed plus one GET of /robots.txt.
// No Supabase, no persist, no providers, nothing is added to the source catalog.
// Run: node --experimental-strip-types scripts/discovery-candidate-sources-check-p0b.mjs
import { fetchFeed } from "../lib/agents/discovery/feed-fetcher.ts";
import { parseFeed } from "../lib/agents/discovery/feed-parser.ts";

// [region, name, country, language, feedUrl]
const candidates = [
  ["Asia", "Tech in Asia", "SG", "en", "https://www.techinasia.com/feed"],
  ["Asia", "SCMP Tech", "HK", "en", "https://www.scmp.com/rss/36/feed"],
  ["Asia", "Nikkei Asia", "JP", "en", "https://asia.nikkei.com/rss/feed/nar"],
  ["Asia", "The Hindu Sci-Tech", "IN", "en", "https://www.thehindu.com/sci-tech/technology/feeder/default.rss"],
  ["Asia", "Synced (China AI)", "CN", "en", "https://syncedreview.com/feed/"],
  ["Asia", "ITmedia AI+", "JP", "ja", "https://rss.itmedia.co.jp/rss/2.0/aiplus.xml"],
  ["Asia", "GIGAZINE", "JP", "ja", "https://gigazine.net/news/rss_2.0/"],
  ["Asia", "ifanr", "CN", "zh", "https://www.ifanr.com/feed"],
  ["Asia", "IT之家", "CN", "zh", "https://www.ithome.com/rss/"],
  ["LatAm", "Xataka Mexico", "MX", "es", "https://www.xataka.com.mx/feedburner.xml"],
  ["LatAm", "Xataka Colombia", "CO", "es", "https://www.xataka.com.co/feedburner.xml"],
  ["LatAm", "Xataka Argentina", "AR", "es", "https://www.xataka.com.ar/feedburner.xml"],
  ["LatAm", "Tecnoblog", "BR", "pt", "https://tecnoblog.net/feed/"],
  ["LatAm", "Canaltech", "BR", "pt", "https://canaltech.com.br/rss/"],
  ["LatAm", "Olhar Digital", "BR", "pt", "https://olhardigital.com.br/feed/"],
  ["Africa", "TechCabal", "NG", "en", "https://techcabal.com/feed/"],
  ["Africa", "Techpoint Africa", "NG", "en", "https://techpoint.africa/feed/"],
  ["Africa", "Disrupt Africa", "ZA", "en", "https://disrupt-africa.com/feed/"],
  ["Africa", "ITWeb Africa", "ZA", "en", "https://itweb.africa/rss"],
  ["MiddleEast", "Wamda", "AE", "en", "https://www.wamda.com/feed"],
  ["MiddleEast", "MENAbytes", "AE", "en", "https://www.menabytes.com/feed/"],
  ["MiddleEast", "Calcalist Tech", "IL", "en", "https://www.calcalistech.com/ctechnews/rss"],
  ["MiddleEast", "AITNews (Arabic)", "SA", "ar", "https://aitnews.com/feed/"],
  ["Europe", "Heise Online", "DE", "de", "https://www.heise.de/rss/heise-atom.xml"],
  ["Europe", "Numerama", "FR", "fr", "https://www.numerama.com/feed/"],
  ["Europe", "The Register", "GB", "en", "https://www.theregister.com/headlines.atom"],
  ["Global", "Rest of World", "US", "en", "https://restofworld.org/feed/"],
];

async function robots(origin, path) {
  try {
    const { text } = await fetchFeed(`${origin}/robots.txt`, 10_000);
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    let applies = false; let blocked = false;
    for (const l of lines) {
      const m = /^user-agent:\s*(.*)$/i.exec(l);
      if (m) { applies = m[1].trim() === "*"; continue; }
      const d = /^disallow:\s*(.*)$/i.exec(l);
      if (applies && d && d[1] && path.startsWith(d[1].trim())) blocked = true;
    }
    return blocked ? "DISALLOWED_FOR_*" : "no_block_for_*";
  } catch { return "robots_unavailable"; }
}

const results = [];
let next = 0;
async function worker() {
  while (next < candidates.length) {
    const [region, name, country, language, feedUrl] = candidates[next++];
    const u = new URL(feedUrl);
    const row = { region, name, country, language, feedUrl };
    try {
      const { text } = await fetchFeed(feedUrl, 15_000);
      const items = parseFeed(text);
      const dated = items.filter((i) => i.dateReliable && i.publishedAt);
      const newest = dated.map((i) => i.publishedAt).sort().at(-1) ?? null;
      const ageH = newest ? Math.round((Date.now() - Date.parse(newest)) / 36e5) : null;
      row.status = "ok"; row.items = items.length; row.undated = items.length - dated.length;
      row.newestAgeHours = ageH; row.sampleTitle = (items[0]?.title ?? "").slice(0, 70);
      row.robots = await robots(u.origin, u.pathname);
    } catch (e) {
      row.status = "fail"; row.error = String(e?.message ?? e).slice(0, 60);
    }
    results.push(row);
  }
}
await Promise.all([worker(), worker(), worker()]);
results.sort((a, b) => candidates.findIndex((c) => c[4] === a.feedUrl) - candidates.findIndex((c) => c[4] === b.feedUrl));
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 1));
