import type { EditorialReview } from "./review.ts";

/**
 * Pure builder of the "pending editorial reviews" message (plain text + simple HTML).
 * No I/O, no environment access and no delivery: it only formats data that already exists in the
 * verified review DTO. Missing data is shown as missing; no score, reason or fact is ever invented.
 */

export const EDITORIAL_CONTACT_EMAIL = "d.perez.sanchez.dev@gmail.com";

export type EditorialDigestOptions = {
  /** Public origin of the app, e.g. https://horizai.example. Without it the panel link is a relative path. */
  adminBaseUrl?: string | null;
  contactEmail?: string;
  /** ISO timestamp used in the header; supplied by the caller to keep the builder pure. */
  generatedAt: string;
  /** Articles already published today (UTC), if known. The daily limit is 2. */
  publishedToday?: number | null;
  dailyPublicationLimit?: number;
};

export type EditorialDigest = { subject: string; text: string; html: string; reviewCount: number };

const verificationLabels: Record<string, string> = {
  confirmed: "Confirmada", developing: "En desarrollo", single_source: "Fuente única", rumor: "Rumor", rejected: "Rechazada",
};
const criticLabels: Record<string, string> = {
  pass: "Superado", reject: "Rechazado", revise_verification: "Revisar verificación", revise_translation: "Revisar traducción",
  revise_editorial: "Revisar edición", revise_classification: "Revisar clasificación", revise_ranking: "Revisar ranking",
};
const severityLabels: Record<string, string> = { low: "baja", medium: "media", high: "alta", critical: "crítica", INFO: "información", WARNING: "atención", BLOCKER: "bloqueo" };

export function editorialReviewPanelUrl(reviewId: string, adminBaseUrl?: string | null): string {
  const path = `/editorial/reviews/${encodeURIComponent(reviewId)}`;
  if (!adminBaseUrl) return path;
  try {
    const base = new URL(adminBaseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return path;
    return new URL(path, base.origin).toString();
  } catch { return path; }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch { return null; }
}

function formatMadrid(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }).format(new Date(time)) + " (Madrid)";
}

/** Shows the stored score as it is (at most two decimals), never rounded to a coarser value. */
function number(value: number): string {
  return String(Number(value.toFixed(2)));
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "line"; label?: string; text: string }
  | { kind: "list"; label: string; items: string[]; empty?: string }
  | { kind: "link"; label: string; text: string; href: string | null };

/** One neutral intermediate representation, rendered both as text and as HTML so both always agree. */
function reviewBlocks(review: EditorialReview, index: number, total: number, options: EditorialDigestOptions): Block[] {
  const blocks: Block[] = [];
  const evidence = review.evidence;
  const where = [review.country, review.region].filter(Boolean).join(" · ") || "Sin país ni región identificados";
  blocks.push({ kind: "heading", text: `${index + 1}/${total} · ${review.headline}` });
  blocks.push({ kind: "line", label: "Resumen", text: review.summary });
  blocks.push({ kind: "line", label: "Por qué importa", text: review.whyItMatters });
  blocks.push({ kind: "line", label: "País / región", text: where });
  blocks.push({ kind: "line", label: "Categoría", text: review.category ?? "Sin categoría" });
  blocks.push({ kind: "line", label: "Creada", text: formatMadrid(review.createdAt) });
  blocks.push({ kind: "line", label: "Objetivo de aprobación", text: review.humanRevisionId ? "Revisión humana corregida" : "Borrador original" });

  if (evidence) {
    const r = evidence.ranking;
    blocks.push({ kind: "line", label: "Puntuación (Ranker)", text: r.importanceScore === null ? "Sin puntuación de importancia en el paquete" : `${number(r.importanceScore)}/100` });
    blocks.push({ kind: "line", label: "Desglose", text: `impacto ${number(r.impact)} · novedad ${number(r.novelty)} · alcance ${number(r.reach)} · credibilidad ${number(r.credibility)} · impacto económico ${number(r.economicImpact)} · impulso ${number(r.momentum)}` });
    blocks.push({ kind: "line", label: "Por qué se eligió (Ranker)", text: r.rankReason });
    blocks.push({ kind: "line", label: "Verificación", text: `${verificationLabels[evidence.verification.status] ?? evidence.verification.status} · confianza ${number(evidence.verification.confidenceScore)}/100 · ${evidence.verification.reason}` });
    blocks.push({ kind: "line", label: "Crítico", text: `${criticLabels[evidence.critic.decision] ?? evidence.critic.decision} · severidad ${severityLabels[evidence.critic.severity] ?? evidence.critic.severity} · ${evidence.critic.notes}` });
  } else {
    blocks.push({ kind: "line", label: "Puntuación (Ranker)", text: review.rankerScore === null ? "No disponible en los datos de esta revisión" : `${number(review.rankerScore)}/100` });
    blocks.push({ kind: "line", label: "Motivo de la elección, verificación y crítico", text: "No disponibles en los datos de esta revisión." });
  }

  const withSources = (claim: { claim: string; sources: string[] }) => claim.sources.length ? `${claim.claim} (fuentes: ${claim.sources.join(", ")})` : claim.claim;
  if (evidence) {
    blocks.push({ kind: "list", label: "Hechos verificados", items: evidence.verification.verifiedFacts.map(withSources), empty: "El verificador no listó hechos verificados." });
    blocks.push({ kind: "list", label: "Incertidumbres", items: evidence.verification.uncertainClaims.map(withSources), empty: "Ninguna declarada." });
    blocks.push({ kind: "list", label: "Contradicciones entre fuentes", items: evidence.verification.contradictions.map(withSources), empty: "Ninguna declarada." });
  }

  const notices = [
    ...review.warnings.map((warning) => `[${severityLabels[warning.severity] ?? warning.severity}] ${warning.title}: ${warning.detail}`),
    ...(evidence?.critic.issues.map((issue) => `[crítico · ${severityLabels[issue.severity] ?? issue.severity}] ${issue.message}`) ?? []),
    ...(evidence?.critic.unsupportedClaims.map((item) => `[afirmación sin respaldo] ${item.claim} — ${item.reason}`) ?? []),
  ];
  blocks.push({ kind: "list", label: "Avisos (guard y crítico)", items: notices, empty: "Sin avisos." });

  if (review.sources.length === 0) blocks.push({ kind: "line", label: "Fuentes", text: "Sin fuentes asociadas." });
  for (const [sourceIndex, source] of review.sources.entries()) {
    const kind = source.classification === "PRIMARY" ? "primaria" : source.classification === "SECONDARY" ? "secundaria" : "sin clasificar";
    blocks.push({ kind: "link", label: `Fuente ${sourceIndex + 1} (${kind})`, text: `${source.publisher} — ${source.title}`, href: safeHref(source.url) });
  }

  blocks.push({ kind: "line", label: "ID de revisión", text: review.reviewId });
  if (review.packageSha256) blocks.push({ kind: "line", label: "SHA-256 del paquete", text: review.packageSha256 });
  blocks.push({ kind: "link", label: "Revisar en el panel", text: editorialReviewPanelUrl(review.reviewId, options.adminBaseUrl), href: options.adminBaseUrl ? editorialReviewPanelUrl(review.reviewId, options.adminBaseUrl) : null });
  return blocks;
}

function renderText(blocks: Block[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") lines.push("", block.text, "-".repeat(Math.min(block.text.length, 72)));
    else if (block.kind === "line") lines.push(block.label ? `${block.label}: ${block.text}` : block.text);
    else if (block.kind === "link") lines.push(`${block.label}: ${block.text}${block.href && block.href !== block.text ? ` <${block.href}>` : ""}`);
    else if (block.items.length === 0) lines.push(`${block.label}: ${block.empty ?? "—"}`);
    else lines.push(`${block.label}:`, ...block.items.map((item) => `  • ${item}`));
  }
  return lines;
}

function renderHtml(blocks: Block[]): string {
  const rows: string[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") rows.push(`<h2 style="margin:28px 0 8px;font-size:18px;line-height:1.3;color:#0b1220">${escapeHtml(block.text)}</h2>`);
    else if (block.kind === "line") rows.push(`<p style="margin:4px 0;font-size:14px;line-height:1.55;color:#1f2937">${block.label ? `<strong>${escapeHtml(block.label)}:</strong> ` : ""}${escapeHtml(block.text)}</p>`);
    else if (block.kind === "link") {
      const text = escapeHtml(block.text);
      rows.push(`<p style="margin:4px 0;font-size:14px;line-height:1.55;color:#1f2937"><strong>${escapeHtml(block.label)}:</strong> ${block.href ? `<a href="${escapeHtml(block.href)}" style="color:#1d4ed8">${text}</a>` : text}</p>`);
    } else if (block.items.length === 0) rows.push(`<p style="margin:4px 0;font-size:14px;line-height:1.55;color:#1f2937"><strong>${escapeHtml(block.label)}:</strong> ${escapeHtml(block.empty ?? "—")}</p>`);
    else rows.push(`<p style="margin:8px 0 2px;font-size:14px;color:#1f2937"><strong>${escapeHtml(block.label)}:</strong></p><ul style="margin:0 0 4px;padding-left:20px;font-size:14px;line-height:1.55;color:#1f2937">${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`);
  }
  return rows.join("\n");
}

export function buildEditorialReviewDigest(reviews: readonly EditorialReview[], options: EditorialDigestOptions): EditorialDigest {
  const contact = options.contactEmail ?? EDITORIAL_CONTACT_EMAIL;
  const limit = options.dailyPublicationLimit ?? 2;
  const count = reviews.length;
  const day = Number.isFinite(Date.parse(options.generatedAt)) ? options.generatedAt.slice(0, 10) : "";
  const subject = count === 0
    ? `HorizAI · Sin noticias pendientes de revisión${day ? ` (${day})` : ""}`
    : `HorizAI · ${count} ${count === 1 ? "noticia pendiente" : "noticias pendientes"} de revisión${day ? ` (${day})` : ""}`;

  const intro = count === 0
    ? "No hay noticias pendientes de revisión."
    : `${count} ${count === 1 ? "noticia espera" : "noticias esperan"} tu decisión. Ninguna se publica sin tu aprobación.`;
  const publishedLine = options.publishedToday === undefined || options.publishedToday === null
    ? null
    : `Publicadas hoy (UTC): ${options.publishedToday} de ${limit} permitidas.`;
  const footer = [
    `Aprobar, poner en espera o rechazar se hace en el panel editorial (enlace en cada noticia). La puntuación y los motivos proceden de los agentes (Ranker, Verificador y Crítico); la decisión final es tuya.`,
    `Contacto del medio: ${contact}`,
  ];

  const blocks = reviews.flatMap((review, index) => reviewBlocks(review, index, count, options));
  const text = [
    subject, "=".repeat(Math.min(subject.length, 72)), intro, ...(publishedLine ? [publishedLine] : []),
    `Generado: ${formatMadrid(options.generatedAt)}`,
    ...renderText(blocks), "", "—", ...footer,
  ].join("\n");

  const html = [
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>`,
    `<body style="margin:0;padding:24px;background:#f4f6fa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif"><div style="max-width:680px;margin:0 auto;background:#ffffff;padding:24px 28px;border-radius:8px">`,
    `<h1 style="margin:0 0 8px;font-size:22px;color:#0b1220">${escapeHtml(subject)}</h1>`,
    `<p style="margin:4px 0;font-size:14px;color:#1f2937">${escapeHtml(intro)}</p>`,
    ...(publishedLine ? [`<p style="margin:4px 0;font-size:14px;color:#1f2937">${escapeHtml(publishedLine)}</p>`] : []),
    `<p style="margin:4px 0;font-size:12px;color:#6b7280">Generado: ${escapeHtml(formatMadrid(options.generatedAt))}</p>`,
    renderHtml(blocks),
    `<hr style="margin:28px 0 12px;border:0;border-top:1px solid #e5e7eb">`,
    `<p style="margin:4px 0;font-size:12px;line-height:1.6;color:#6b7280">${escapeHtml(footer[0]!)}</p>`,
    `<p style="margin:4px 0;font-size:12px;color:#6b7280">Contacto del medio: <a href="mailto:${escapeHtml(contact)}" style="color:#1d4ed8">${escapeHtml(contact)}</a></p>`,
    `</div></body></html>`,
  ].join("\n");

  return { subject, text, html, reviewCount: count };
}
