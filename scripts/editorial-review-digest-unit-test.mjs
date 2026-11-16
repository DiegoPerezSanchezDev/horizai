// The pending-reviews message: pure, complete, escaped, honest about missing data. No network, no delivery.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { EDITORIAL_CONTACT_EMAIL, buildEditorialReviewDigest, editorialReviewPanelUrl } from "../lib/editorial/review-digest.ts";
import { mapM32Review } from "../lib/editorial/live-mapping.ts";
import { buildReviewScenario, ids } from "./editorial-test-support.mjs";

const generatedAt = "2026-10-21T08:30:00.000Z";
const base = { adminBaseUrl: "https://panel.example.org", generatedAt, publishedToday: 1 };

async function realReview() {
  const scenario = await buildReviewScenario();
  const mapped = mapM32Review({ ...scenario.row, critic_pass: true }, scenario.artifact).review;
  return { scenario, review: mapped };
}

test("every requested element appears, taken from the real review data", async () => {
  const { scenario, review } = await realReview();
  try {
    const digest = buildEditorialReviewDigest([review], base);
    for (const [label, expected] of [
      ["headline", review.headline], ["summary", review.summary], ["why it matters", review.whyItMatters],
      ["category", "chips"], ["country", "Estados Unidos"], ["region", "US"],
      ["score", "74.45/100"], ["breakdown", "impacto 74 · novedad 81 · alcance 63 · credibilidad 88"],
      ["rank reason", scenario.artifact.reviewEvidence.ranking.rankReason],
      ["verification", "Confirmada · confianza 88/100"], ["critic", "Superado · severidad baja"],
      ["verified fact", "The accelerator entered production in September 2026."], ["verified fact source", "fuentes: Example Tech Journal"],
      ["uncertainty", "Market share impact is not yet measurable."], ["contradiction", "One outlet reports a later production date."],
      ["primary source", "Fuente 1 (primaria): example.com — Example Tech Journal"], ["source url", "https://example.com/news/ai-chip"],
      ["secondary source", "Fuente 2 (secundaria): example.org — Second Source Weekly"],
      ["review id", ids.review], ["package hash", scenario.packageSha256],
      ["panel link", `https://panel.example.org/editorial/reviews/${ids.review}`],
      ["contact", "d.perez.sanchez.dev@gmail.com"], ["published today", "Publicadas hoy (UTC): 1 de 2 permitidas."],
    ]) {
      assert.ok(digest.text.includes(expected), `text is missing ${label}: ${expected}`);
    }
    assert.equal(EDITORIAL_CONTACT_EMAIL, "d.perez.sanchez.dev@gmail.com");
    for (const expected of [review.headline, "74.45/100", scenario.packageSha256, `https://panel.example.org/editorial/reviews/${ids.review}`, "mailto:d.perez.sanchez.dev@gmail.com", 'href="https://example.com/news/ai-chip"']) {
      assert.ok(digest.html.includes(expected.replace(/&/g, "&amp;")), `html is missing ${expected}`);
    }
    assert.equal(digest.subject, "HorizAI · 1 noticia pendiente de revisión (2026-10-21)");
    assert.equal(digest.reviewCount, 1);
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("five pending reviews produce five numbered entries and a plural subject", async () => {
  const { scenario, review } = await realReview();
  try {
    const reviews = Array.from({ length: 5 }, (_, index) => ({ ...review, reviewId: `review-${index + 1}`, headline: `Titular número ${index + 1}` }));
    const digest = buildEditorialReviewDigest(reviews, base);
    assert.equal(digest.subject, "HorizAI · 5 noticias pendientes de revisión (2026-10-21)");
    assert.match(digest.text, /5 noticias esperan tu decisión\. Ninguna se publica sin tu aprobación\./);
    for (let index = 1; index <= 5; index += 1) {
      assert.ok(digest.text.includes(`${index}/5 · Titular número ${index}`));
      assert.ok(digest.text.includes(`/editorial/reviews/review-${index}`));
    }
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("missing evidence is reported as missing and no score or reason is invented", async () => {
  const { scenario, review } = await realReview();
  try {
    const { evidence, ...withoutEvidence } = review;
    void evidence;
    const noScore = buildEditorialReviewDigest([{ ...withoutEvidence, rankerScore: null }], base).text;
    assert.match(noScore, /Puntuación \(Ranker\): No disponible en los datos de esta revisión/);
    assert.match(noScore, /Motivo de la elección, verificación y crítico: No disponibles en los datos de esta revisión\./);
    assert.doesNotMatch(noScore, /\/100/);
    const scoreOnly = buildEditorialReviewDigest([{ ...withoutEvidence, rankerScore: 61 }], base).text;
    assert.match(scoreOnly, /Puntuación \(Ranker\): 61\/100/);
    assert.doesNotMatch(scoreOnly, /Por qué se eligió/);
    const nullScore = buildEditorialReviewDigest([{ ...review, evidence: { ...review.evidence, ranking: { ...review.evidence.ranking, importanceScore: null } } }], base).text;
    assert.match(nullScore, /Sin puntuación de importancia en el paquete/);
    const noOrigin = buildEditorialReviewDigest([{ ...withoutEvidence, country: null, region: null, category: null, sources: [], packageSha256: undefined }], base).text;
    assert.match(noOrigin, /Sin país ni región identificados/);
    assert.match(noOrigin, /Categoría: Sin categoría/);
    assert.match(noOrigin, /Fuentes: Sin fuentes asociadas\./);
    assert.doesNotMatch(noOrigin, /SHA-256 del paquete/);
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("guard warnings, critic issues and unsupported claims are all listed", async () => {
  const { scenario, review } = await realReview();
  try {
    const warned = {
      ...review,
      warnings: [{ id: "lineage", severity: "BLOCKER", title: "Cadena de fuentes", detail: "No coincide con el borrador." }],
      evidence: { ...review.evidence, critic: { ...review.evidence.critic, issues: [{ code: "SCOPE", severity: "high", message: "Alcance exagerado en el titular." }],
        unsupportedClaims: [{ claim: "Duplicará el mercado", reason: "Ninguna fuente lo respalda" }] } },
    };
    const text = buildEditorialReviewDigest([warned], base).text;
    assert.match(text, /\[bloqueo\] Cadena de fuentes: No coincide con el borrador\./);
    assert.match(text, /\[crítico · alta\] Alcance exagerado en el titular\./);
    assert.match(text, /\[afirmación sin respaldo\] Duplicará el mercado — Ninguna fuente lo respalda/);
    const clean = buildEditorialReviewDigest([review], base).text;
    assert.match(clean, /Avisos \(guard y crítico\): Sin avisos\./);
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("HTML escapes every value and never links an unsafe URL; text and HTML agree", async () => {
  const { scenario, review } = await realReview();
  try {
    const hostile = {
      ...review,
      headline: `<script>alert("x")</script> & "comillas"`,
      summary: "<img src=x onerror=alert(1)>",
      sources: [{ publisher: "evil.example", title: "<b>Fuente</b>", url: "javascript:alert(1)", publishedAt: null, classification: "PRIMARY" }],
    };
    const digest = buildEditorialReviewDigest([hostile], base);
    assert.equal(digest.html.includes("<script>"), false);
    assert.equal(digest.html.includes("<img src=x"), false);
    assert.equal(digest.html.includes("<b>Fuente</b>"), false);
    assert.ok(digest.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;comillas&quot;"));
    assert.equal(digest.html.includes("javascript:"), false, "an unsafe source URL is not rendered as a link");
    assert.ok(digest.text.includes("<script>"), "plain text keeps the raw characters");
    const { scenario: other, review: normal } = await realReview();
    try {
      const both = buildEditorialReviewDigest([normal], base);
      for (const fragment of [normal.headline, "74.45/100", normal.evidence.ranking.rankReason, ids.review]) {
        assert.ok(both.text.includes(fragment) && both.html.includes(fragment), fragment);
      }
    } finally { rmSync(other.base, { recursive: true, force: true }); }
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("the builder is pure and handles the empty case and unusable base URLs", async () => {
  const { scenario, review } = await realReview();
  try {
    assert.deepEqual(buildEditorialReviewDigest([review], base), buildEditorialReviewDigest([review], base));
    const empty = buildEditorialReviewDigest([], { generatedAt });
    assert.equal(empty.subject, "HorizAI · Sin noticias pendientes de revisión (2026-10-21)");
    assert.match(empty.text, /No hay noticias pendientes de revisión\./);
    assert.doesNotMatch(empty.text, /Publicadas hoy/);
    assert.equal(editorialReviewPanelUrl("abc", null), "/editorial/reviews/abc");
    assert.equal(editorialReviewPanelUrl("abc", "not a url"), "/editorial/reviews/abc");
    assert.equal(editorialReviewPanelUrl("abc", "javascript:alert(1)"), "/editorial/reviews/abc");
    assert.equal(editorialReviewPanelUrl("a b", "https://panel.example.org/ignored/path"), "https://panel.example.org/editorial/reviews/a%20b");
    assert.match(buildEditorialReviewDigest([review], { generatedAt }).text, /Revisar en el panel: \/editorial\/reviews\//);
    const custom = buildEditorialReviewDigest([review], { ...base, contactEmail: "otro@example.org", dailyPublicationLimit: 3 });
    assert.match(custom.text, /Contacto del medio: otro@example\.org/);
    assert.match(custom.text, /1 de 3 permitidas/);
  } finally { rmSync(scenario.base, { recursive: true, force: true }); }
});

test("the builder has no I/O, environment or delivery code, and the script is read-only", () => {
  const source = readFileSync("lib/editorial/review-digest.ts", "utf8");
  assert.doesNotMatch(source, /process\.env|fetch\(|node:|import\(|Date\.now|new Date\(\)|nodemailer|smtp|webhook/i);
  const script = readFileSync("scripts/editorial-review-digest.ts", "utf8");
  assert.doesNotMatch(script, /\.decide\(|publishReviewed|publish_reviewed|\.rpc\(|fetch\(|sendMail|nodemailer/);
  assert.match(script, /--sample/);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts["editorial:digest"], /editorial-review-digest\.ts/);
  for (const name of ["editorial:digest:unit", "editorial:decisions:unit", "human-review:operations:unit"]) assert.ok(pkg.scripts[name], name);
});
