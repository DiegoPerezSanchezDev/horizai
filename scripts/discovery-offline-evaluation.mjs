// P0-b: offline evaluation of discovery. No network, no providers, no Supabase, persist=false.
// Run: node --experimental-strip-types scripts/discovery-offline-evaluation.mjs [--json]
import { discoverFromSources } from "../lib/agents/discovery/discovery-runner.ts";
import { canonicalizeUrl } from "../lib/agents/discovery/canonical-url.ts";
import { NOW, WINDOW_HOURS, sources, items, brokenFeedUrl, quietFeedUrl } from "./fixtures/discovery-offline-corpus-p0b.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const urlFor = (it) => (it.link !== undefined ? it.link : `https://${sources.find((s) => s.key === it.src).url.replace("https://", "")}/n/${it.n}`);

function rssItem(it) {
  const link = urlFor(it);
  return `<item><guid>${esc(it.n)}</guid>${it.title ? `<title>${esc(it.title)}</title>` : ""}${link ? `<link>${esc(link)}</link>` : ""}<description>${esc(it.excerpt)}</description>${it.date ? `<pubDate>${esc(it.date)}</pubDate>` : ""}</item>`;
}
function atomEntry(it) {
  const link = urlFor(it);
  return `<entry><id>${esc(it.n)}</id>${it.title ? `<title>${esc(it.title)}</title>` : ""}${link ? `<link rel="alternate" href="${esc(link)}"/>` : ""}<summary>${esc(it.excerpt)}</summary>${it.date ? `<updated>${esc(it.date)}</updated>` : ""}</entry>`;
}

const feeds = new Map();
for (const s of sources) {
  const own = items.filter((it) => it.src === s.key);
  feeds.set(
    s.feedUrl,
    s.discoveryMethod === "atom"
      ? `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${own.map(atomEntry).join("")}</feed>`
      : `<?xml version="1.0"?><rss version="2.0"><channel><title>${esc(s.name)}</title>${own.map(rssItem).join("")}</channel></rss>`
  );
}

globalThis.fetch = async (url) => {
  if (url === brokenFeedUrl) return new Response("boom", { status: 503 });
  const body = feeds.get(url);
  if (body === undefined) throw new Error(`unexpected fetch ${url}`);
  return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
};

const result = await discoverFromSources(sources, { hours: WINDOW_HOURS, persist: false, now: NOW, concurrency: 1 });

const admittedUrls = new Set(result.candidates.map((c) => c.url));
const admittedByUrl = new Map(result.candidates.map((c) => [c.url, c]));
function wasAdmitted(it) {
  const link = urlFor(it);
  if (!link) return false;
  try {
    const canonical = canonicalizeUrl(link);
    if (!admittedUrls.has(canonical)) return false;
    // A duplicate shares its canonical URL with the original: only the first occurrence counts as admitted.
    if (it.expected.reason === "duplicate_url") {
      const first = items.find((o) => o.n !== it.n && o.src === it.src && urlFor(o) && (() => { try { return canonicalizeUrl(urlFor(o)) === canonical; } catch { return false; } })());
      return !first;
    }
    return true;
  } catch { return false; }
}

const rows = items.map((it) => {
  const admitted = wasAdmitted(it);
  const expectedAdmit = it.expected.stage === "admit";
  const outcome = expectedAdmit ? (admitted ? "ok_admitted" : "LOSS") : (admitted ? "UNEXPECTED_ADMIT" : "ok_dropped");
  const cand = admitted ? admittedByUrl.get(canonicalizeUrl(urlFor(it))) : null;
  const srcCountry = sources.find((s) => s.key === it.src).countryCode;
  return { n: it.n, src: it.src, topic: it.topic, expected: it.expected.stage + (it.expected.reason ? `:${it.expected.reason}` : ""), admitted, outcome, newsCountry: it.newsCountry, sourceCountry: srcCountry, candidateCountry: cand?.possibleCountryCode ?? null, note: it.note ?? "" };
});

const count = (p) => rows.filter(p).length;
const inScopeExpectedAdmit = rows.filter((r) => r.topic === "in" && r.expected === "admit");
const losses = rows.filter((r) => r.outcome === "LOSS");
const unexpectedAdmits = rows.filter((r) => r.outcome === "UNEXPECTED_ADMIT");
const countryMismatch = rows.filter((r) => r.admitted && r.newsCountry !== r.candidateCountry);

const summary = {
  corpus: { sources: sources.length, items: items.length, windowHours: WINDOW_HOURS, now: NOW.toISOString() },
  runnerCounters: { candidatesAdmitted: result.candidates.length, discoveredAfterWindow: result.candidatesDiscovered, invalid: result.invalidCandidates, undatedExcluded: result.undatedExcluded, duplicateUrls: result.duplicateUrls, duplicateContentHashes: result.duplicateContentHashes },
  sourceStatus: Object.fromEntries(result.sources.map((s) => [s.source.name, s.status])),
  quietSourceLegitimatelyEmpty: result.sources.find((s) => s.source.feedUrl === quietFeedUrl)?.status === "empty",
  brokenSourceIsolated: result.sources.find((s) => s.source.feedUrl === brokenFeedUrl)?.status === "http_error" && result.candidates.length > 0,
  expectedAdmitInScope: inScopeExpectedAdmit.length,
  admittedInScope: inScopeExpectedAdmit.filter((r) => r.admitted).length,
  lossesTotal: losses.length,
  unexpectedAdmits: unexpectedAdmits.length,
  outOfScopeAdmittedNoise: count((r) => r.topic === "out" && r.admitted),
  admittedTotal: result.candidates.length,
  noiseShareOfAdmitted: +(count((r) => r.topic === "out" && r.admitted) / Math.max(1, result.candidates.length)).toFixed(2),
  countryMismatchAdmitted: countryMismatch.length,
  admittedWithNewsCountryKnownWrong: countryMismatch.map((r) => r.n),
  perItemDiscardReasonRecordedByRunner: false,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ summary, rows }, null, 2));
} else {
  console.log("P0-b offline discovery evaluation (synthetic fixtures; no network/providers)\n");
  console.table(rows.map(({ n, expected, outcome, topic, newsCountry, candidateCountry }) => ({ n, expected, outcome, topic, newsCountry, candidateCountry })));
  console.log(JSON.stringify(summary, null, 2));
}
