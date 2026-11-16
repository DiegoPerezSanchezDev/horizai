import "server-only";
import { parseOperatorAllowlist } from "./policy.ts";

export function getEditorialAuthConfiguration() {
  const url = process.env.EDITORIAL_AUTH_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.EDITORIAL_AUTH_PUBLISHABLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const allowlist = parseOperatorAllowlist(process.env.EDITORIAL_OPERATOR_EMAILS);
  if (!url || !key || allowlist.length === 0 || !isPublishableAuthKey(key)) return null;
  try {
    const parsed = new URL(url);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/" ||
      (parsed.protocol !== "https:" && !(process.env.NODE_ENV === "development" && local && parsed.protocol === "http:"))) return null;
    return { url: parsed.origin, key, allowlist };
  } catch { return null; }
}

function isPublishableAuthKey(key: string): boolean {
  if (key.startsWith("sb_publishable_")) return true;
  // Legacy local anon key support. This only validates configuration, never user identity.
  try { return JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role === "anon"; } catch { return false; }
}

export function getEditorialAuthOrigin(requestUrl: string): string | null {
  const configured = process.env.EDITORIAL_AUTH_ORIGIN?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim();
  try {
    const url = new URL(configured || new URL(requestUrl).origin);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (process.env.NODE_ENV === "production") return configured && url.protocol === "https:" ? url.origin : null;
    return configured || local ? url.origin : null;
  } catch { return null; }
}
