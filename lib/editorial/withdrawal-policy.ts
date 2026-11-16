// Pure policy for withdrawing a published article. No I/O, no server-only imports, unit-testable.
export const WITHDRAWAL_REASONS = {
  factual_error: "Error factual",
  rights_claim: "Reclamo de derechos",
  source_request: "Petición de la fuente",
  other: "Otro motivo",
} as const;

export type WithdrawalReason = keyof typeof WITHDRAWAL_REASONS;

export type WithdrawalCommand =
  | { action: "withdraw"; slug: string; reason: WithdrawalReason; note: string }
  | { action: "restore"; slug: string };

export type WithdrawalParseResult =
  | { ok: true; command: WithdrawalCommand }
  | { ok: false; code: "invalid" | "invalid_slug" | "invalid_reason" | "invalid_note" | "not_confirmed" };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 300;
const NOTE_MIN = 10;
const NOTE_MAX = 1000;

/** Withdrawal is off unless the flag is exactly "true"; merging code never activates it. */
export function isWithdrawalEnabled(value: string | undefined): boolean {
  return value === "true";
}

/** Accepts a bare slug or a pasted article URL such as https://host/noticias/<slug>. */
export function extractArticleSlug(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let candidate = input.trim();
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const segments = new URL(candidate).pathname.split("/").filter(Boolean);
      const index = segments.indexOf("noticias");
      if (index === -1 || !segments[index + 1]) return null;
      candidate = decodeURIComponent(segments[index + 1]);
    } catch {
      return null;
    }
  }
  candidate = candidate.toLowerCase();
  return candidate.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(candidate) ? candidate : null;
}

function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Control characters are rejected rather than silently stripped.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return null;
  const note = value.replace(/\s+/g, " ").trim();
  return note.length >= NOTE_MIN && note.length <= NOTE_MAX ? note : null;
}

export function parseWithdrawalForm(form: URLSearchParams): WithdrawalParseResult {
  const allowed = new Set(["action", "slug", "reason", "note", "confirm"]);
  for (const key of form.keys()) {
    if (!allowed.has(key) || form.getAll(key).length !== 1) return { ok: false, code: "invalid" };
  }
  const action = form.get("action");
  const slug = extractArticleSlug(form.get("slug"));
  if (action !== "withdraw" && action !== "restore") return { ok: false, code: "invalid" };
  if (!slug) return { ok: false, code: "invalid_slug" };
  if (form.get("confirm") !== "yes") return { ok: false, code: "not_confirmed" };
  if (action === "restore") return { ok: true, command: { action, slug } };

  const reason = form.get("reason");
  if (!reason || !Object.prototype.hasOwnProperty.call(WITHDRAWAL_REASONS, reason)) return { ok: false, code: "invalid_reason" };
  const note = cleanNote(form.get("note"));
  if (!note) return { ok: false, code: "invalid_note" };
  return { ok: true, command: { action, slug, reason: reason as WithdrawalReason, note } };
}

export type WithdrawalOutcomeCode =
  | "withdrawn" | "already_withdrawn" | "restored"
  | "not_found" | "not_published" | "not_withdrawn" | "disabled" | "error";

/** Maps a PostgREST error body to a stable outcome code; never forwards raw database text. */
export function mapWithdrawalError(bodyText: string): WithdrawalOutcomeCode {
  if (bodyText.includes("ARTICLE_NOT_FOUND")) return "not_found";
  if (bodyText.includes("ARTICLE_NOT_PUBLISHED")) return "not_published";
  if (bodyText.includes("ARTICLE_NOT_WITHDRAWN")) return "not_withdrawn";
  return "error";
}
