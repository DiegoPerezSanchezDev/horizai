import { humanReviewCheckNames, type HumanReviewCheckName } from "../agents/publisher/human-review-operations.ts";

// Pure policy for the panel's decision forms. No I/O. The substantive rules (package hash, seven checks, current
// checkpoints, two-per-day cap) are NOT here: they live in human-review-operations.ts and are shared with the CLI.
// This file only validates the shape of the request and turns errors into stable, safe outcome codes.

export const EDITORIAL_CHECK_LABELS: Record<HumanReviewCheckName, string> = {
  "facts": "Los hechos están respaldados por las fuentes",
  "attribution": "La atribución a cada fuente es correcta",
  "uncertainty": "La incertidumbre se conserva en el texto",
  "headline": "El titular es aceptable",
  "summary": "El resumen es aceptable",
  "unsupported-claims": "No hay afirmaciones materiales sin respaldo",
  "source-chain": "La cadena de fuentes es correcta",
};

export type EditorialDecisionAction = "approve" | "approve_publish" | "hold" | "reject";

export type EditorialDecisionCommand =
  | {
    action: EditorialDecisionAction;
    reviewId: string;
    expectedPackageSha256: string;
    checks: Record<HumanReviewCheckName, boolean>;
    expectedRevisionSha256?: string;
  }
  | { action: "publish"; items: { reviewId: string; expectedPackageSha256: string }[] };

export type EditorialDecisionOutcome =
  | "approved" | "held" | "rejected" | "published"
  | "approved_publish_failed"
  | "disabled" | "invalid" | "invalid_id" | "invalid_hash" | "invalid_selection" | "not_confirmed"
  | "checks_required" | "stale" | "status" | "daily_limit" | "not_found" | "package_unavailable" | "error";

export type EditorialDecisionParseResult =
  | { ok: true; command: EditorialDecisionCommand }
  | { ok: false; code: Extract<EditorialDecisionOutcome, "invalid" | "invalid_id" | "invalid_hash" | "invalid_selection" | "not_confirmed"> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const checkFieldNames = humanReviewCheckNames.map((name) => `check_${name}`);

/** Decisions need BOTH the live-data flag and an explicit decisions flag. Merging code never activates them. */
export function isEditorialDecisionEnabled(decisionsFlag: string | undefined, liveDataFlag: string | undefined): boolean {
  return decisionsFlag === "true" && liveDataFlag === "true";
}

export function parseEditorialDecisionForm(form: URLSearchParams): EditorialDecisionParseResult {
  const action = form.get("action");
  if (action === "publish") {
    for (const key of form.keys()) if (key !== "action" && key !== "item" && key !== "confirm") return { ok: false, code: "invalid" };
    if (form.getAll("action").length !== 1 || form.getAll("confirm").length > 1) return { ok: false, code: "invalid" };
    const raw = form.getAll("item");
    if (raw.length < 1 || raw.length > 2) return { ok: false, code: "invalid_selection" };
    const items: { reviewId: string; expectedPackageSha256: string }[] = [];
    for (const entry of raw) {
      const [reviewId, sha, ...rest] = entry.split(":");
      if (rest.length || !reviewId || !UUID.test(reviewId)) return { ok: false, code: "invalid_id" };
      if (!sha || !SHA256.test(sha)) return { ok: false, code: "invalid_hash" };
      items.push({ reviewId, expectedPackageSha256: sha });
    }
    if (new Set(items.map((item) => item.reviewId)).size !== items.length) return { ok: false, code: "invalid_selection" };
    if (form.get("confirm") !== "yes") return { ok: false, code: "not_confirmed" };
    return { ok: true, command: { action: "publish", items } };
  }

  if (action !== "approve" && action !== "approve_publish" && action !== "hold" && action !== "reject") return { ok: false, code: "invalid" };
  const allowed = new Set(["action", "review_id", "package_sha256", "revision_sha256", "confirm", ...checkFieldNames]);
  for (const key of form.keys()) if (!allowed.has(key) || form.getAll(key).length !== 1) return { ok: false, code: "invalid" };
  const reviewId = form.get("review_id") ?? "";
  if (!UUID.test(reviewId)) return { ok: false, code: "invalid_id" };
  const expectedPackageSha256 = form.get("package_sha256") ?? "";
  if (!SHA256.test(expectedPackageSha256)) return { ok: false, code: "invalid_hash" };
  const revision = form.get("revision_sha256");
  if (revision !== null && !SHA256.test(revision)) return { ok: false, code: "invalid_hash" };
  if (form.get("confirm") !== "yes") return { ok: false, code: "not_confirmed" };

  const checks = {} as Record<HumanReviewCheckName, boolean>;
  for (const name of humanReviewCheckNames) {
    const value = form.get(`check_${name}`);
    // A checkbox left unticked is an explicit "fail": hold/reject may carry failed checks, approval may not (enforced downstream).
    if (value !== null && value !== "pass") return { ok: false, code: "invalid" };
    checks[name] = value === "pass";
  }
  return { ok: true, command: { action, reviewId, expectedPackageSha256, checks, ...(revision !== null ? { expectedRevisionSha256: revision } : {}) } };
}

/** Never forwards raw error text (it can include row data). Only the known domain codes are recognised. */
export function mapEditorialDecisionError(error: unknown): EditorialDecisionOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return "package_unavailable";
  const message = error instanceof Error ? error.message : "";
  if (message === "HUMAN_REVIEW_NOT_FOUND") return "not_found";
  if (message === "HUMAN_APPROVAL_REQUIRES_ALL_SEVEN_CHECKS_TO_PASS") return "checks_required";
  if (message.startsWith("HUMAN_REVIEW_DAILY_PUBLICATION_LIMIT")) return "daily_limit";
  if (message.startsWith("HUMAN_REVIEW_STATUS_NOT_ALLOWED") || message === "HUMAN_REVIEW_DECISION_NOT_ALLOWED" || message.startsWith("HUMAN_REVIEW_NOT_APPROVED")) return "status";
  if (message === "HUMAN_REVIEW_PACKAGE_IDENTITY_OR_HASH_STALE" || message.startsWith("HUMAN_REVIEW_CHECKPOINT_STALE")
    || message === "HUMAN_REVIEW_APPROVAL_REVISION_HASH_STALE" || message === "HUMAN_REVIEW_APPROVED_REVISION_STALE"
    || message === "HUMAN_APPROVAL_REQUIRED" || message === "HUMAN_REVIEW_EXPECTED_REVISION_SHA256_REQUIRED"
    || message === "HUMAN_REVIEW_REVISION_HASH_NOT_EXPECTED") return "stale";
  return "error";
}

export const EDITORIAL_DECISION_MESSAGES: Record<EditorialDecisionOutcome, { tone: "ok" | "warn"; text: string }> = {
  approved: { tone: "ok", text: "Noticia aprobada. Ya está en la cola de publicación; puedes publicarla desde la bandeja." },
  approved_publish_failed: { tone: "warn", text: "La aprobación quedó registrada, pero no se pudo confirmar la publicación. Actualiza la bandeja y comprueba su estado antes de reintentar." },
  held: { tone: "ok", text: "Noticia puesta en espera. Puedes volver a decidir más adelante." },
  rejected: { tone: "ok", text: "Noticia rechazada." },
  published: { tone: "ok", text: "Publicación completada." },
  disabled: { tone: "warn", text: "Las decisiones están desactivadas en este entorno." },
  invalid: { tone: "warn", text: "Solicitud no válida." },
  invalid_id: { tone: "warn", text: "Identificador de revisión no válido." },
  invalid_hash: { tone: "warn", text: "El hash del paquete no es válido. Recarga la revisión." },
  invalid_selection: { tone: "warn", text: "Selecciona una o dos noticias aprobadas para publicar." },
  not_confirmed: { tone: "warn", text: "Marca la casilla de confirmación." },
  checks_required: { tone: "warn", text: "Para aprobar hay que marcar las siete comprobaciones. Si alguna falla, pon la noticia en espera o recházala." },
  stale: { tone: "warn", text: "El paquete cambió o ya no coincide con lo que viste. No se ha hecho nada; recarga la revisión y vuelve a comprobarla." },
  status: { tone: "warn", text: "La revisión ya no está en un estado que permita esta acción. Recarga la bandeja." },
  daily_limit: { tone: "warn", text: "Límite de publicaciones del día alcanzado (máximo 2 por día UTC) o hay otra publicación en curso. No se ha publicado nada." },
  not_found: { tone: "warn", text: "La revisión no existe." },
  package_unavailable: { tone: "warn", text: "El paquete de revisión no está disponible en este servidor. No se ha hecho nada." },
  error: { tone: "warn", text: "No se pudo completar la acción. Revisa el estado antes de reintentar." },
};

export function isEditorialDecisionOutcome(value: unknown): value is EditorialDecisionOutcome {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EDITORIAL_DECISION_MESSAGES, value);
}
