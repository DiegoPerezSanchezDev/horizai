export type OperatorIdentity = { id: string; email: string };
export type OperatorAuthResult =
  | { status: "authorized"; operator: OperatorIdentity }
  | { status: "anonymous" | "expired" | "unauthorized" | "unavailable" };

export function normalizeOperatorEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email) ? email : null;
}

export function parseOperatorAllowlist(value: string | undefined): readonly string[] {
  const entries = (value ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  const emails = entries.map(normalizeOperatorEmail);
  // Configuration errors must not silently produce a partially working policy.
  return emails.length > 0 && emails.every((email) => email !== null) ? [...new Set(emails)] : [];
}

export function authorizeVerifiedOperator(user: {
  id?: string; email?: string; email_confirmed_at?: string; is_anonymous?: boolean;
} | null, allowlist: readonly string[]): OperatorAuthResult {
  if (!user) return { status: "anonymous" };
  const email = normalizeOperatorEmail(user.email);
  if (!user.id || !email || !user.email_confirmed_at || !Number.isFinite(Date.parse(user.email_confirmed_at)) ||
    user.is_anonymous === true || !allowlist.includes(email)) return { status: "unauthorized" };
  return { status: "authorized", operator: { id: user.id, email } };
}

export const EDITORIAL_SESSION_COOKIE = "horizai-editorial-auth";
export const EDITORIAL_PENDING_COOKIE = "horizai-editorial-pending";
export function isEditorialSessionCookie(name: string): boolean {
  return name === EDITORIAL_SESSION_COOKIE || name.startsWith(EDITORIAL_SESSION_COOKIE + ".") ||
    name.startsWith(EDITORIAL_SESSION_COOKIE + "-");
}

export function editorialCookiePolicy(nodeEnv: string | undefined) {
  return { httpOnly: true, secure: nodeEnv === "production", sameSite: "lax" as const, path: "/" };
}

export function isEditorialAuthPublicPath(path: string): boolean {
  return ["/editorial/login", "/editorial/auth/request", "/editorial/auth/verify", "/editorial/auth/logout"].includes(path);
}

export function isEditorialProtectedPath(path: string): boolean {
  return (path === "/editorial" || path.startsWith("/editorial/") || path === "/api/editorial" || path.startsWith("/api/editorial/")) &&
    !isEditorialAuthPublicPath(path);
}

export function isSameOriginAuthPost(origin: string | null, expectedOrigin: string | null, fetchSite: string | null): boolean {
  if (!origin || !expectedOrigin || fetchSite === "cross-site") return false;
  try { return origin === new URL(expectedOrigin).origin && new URL(origin).origin === origin; } catch { return false; }
}
