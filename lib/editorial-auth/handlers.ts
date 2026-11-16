import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { createEditorialAuthClient } from "./client.ts";
import { getEditorialAuthConfiguration, getEditorialAuthOrigin } from "./config.ts";
import { EDITORIAL_PENDING_COOKIE, editorialCookiePolicy, isEditorialSessionCookie, isSameOriginAuthPost, normalizeOperatorEmail } from "./policy.ts";
import { resolveEditorialOperator } from "./resolve.ts";

type AuthAction = "request" | "verify" | "logout";

async function readSmallForm(request: NextRequest): Promise<URLSearchParams | null> {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 2048) { await reader.cancel(); return null; }
    chunks.push(chunk.value);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  for (const key of form.keys()) if (form.getAll(key).length !== 1 || !["email", "token"].includes(key)) return null;
  return form;
}

/** Only authentication operations. No editorial RPCs or decision endpoints. */
export async function handleEditorialAuthPost(request: NextRequest, action: AuthAction): Promise<NextResponse> {
  const policy = editorialCookiePolicy(process.env.NODE_ENV);
  const writes: { name: string; value: string; options: CookieOptions }[] = [];
  const extraHeaders: Record<string, string> = {};
  function finish(state: string, destination = "/editorial/login") {
    const url = new URL(destination, getEditorialAuthOrigin(request.url) ?? request.url);
    url.search = destination === "/editorial/login" ? `?state=${state}` : "";
    const response = NextResponse.redirect(url, 303);
    for (const cookie of writes) response.cookies.set(cookie.name, cookie.value, { ...cookie.options, ...policy });
    for (const [key, value] of Object.entries(extraHeaders)) response.headers.set(key, value);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("Referrer-Policy", "same-origin");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    return response;
  }
  if (!isSameOriginAuthPost(request.headers.get("origin"), getEditorialAuthOrigin(request.url), request.headers.get("sec-fetch-site"))) {
    return NextResponse.json({ error: "INVALID_AUTH_ORIGIN" }, { status: 403, headers: { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } });
  }
  const clearLocalSession = () => {
    for (const cookie of request.cookies.getAll()) if (isEditorialSessionCookie(cookie.name) || cookie.name === EDITORIAL_PENDING_COOKIE) {
      writes.push({ name: cookie.name, value: "", options: { maxAge: 0 } });
    }
  };
  try {
    const client = createEditorialAuthClient({
      getAll: () => request.cookies.getAll(),
      setAll(changes, headers) {
        for (const cookie of changes) { request.cookies.set(cookie.name, cookie.value); writes.push(cookie); }
        Object.assign(extraHeaders, headers);
      },
    });
    if (action === "logout") {
      try { await client?.auth.signOut({ scope: "local" }); } catch { /* Local removal remains mandatory when the provider is unavailable. */ }
      clearLocalSession();
      return finish("signed-out");
    }
    const configuration = getEditorialAuthConfiguration();
    if (!client || !configuration || !getEditorialAuthOrigin(request.url)) return finish("unavailable");
    const form = await readSmallForm(request);
    if (!form) return finish("invalid");
    if (action === "request") {
      const email = normalizeOperatorEmail(form.get("email"));
      if (!email) return finish("invalid-email");
      if (configuration.allowlist.includes(email)) {
        // Never self-register, even if the Supabase project's general signup is enabled.
        const origin = getEditorialAuthOrigin(request.url);
        // The redirect only takes effect if the URL is in the Supabase Auth redirect allow-list; the code flow works without it.
        await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, ...(origin ? { emailRedirectTo: new URL("/editorial/login", origin).toString() } : {}) } });
        // Provider errors (for example the built-in mailer 429) are deliberately neither shown nor logged: the response must stay uniform.
      }
      // Uniform response; the pending email grants no access and is not an auth assertion.
      writes.push({ name: EDITORIAL_PENDING_COOKIE, value: email, options: { maxAge: 600 } });
      return finish("code");
    }
    const email = normalizeOperatorEmail(request.cookies.get(EDITORIAL_PENDING_COOKIE)?.value);
    const token = form.get("token") ?? "";
    if (!email) return finish("expired");
    if (!/^\d{6,10}$/.test(token) || !configuration.allowlist.includes(email)) return finish("invalid-code");
    const verified = await client.auth.verifyOtp({ email, token, type: "email" });
    if (verified.error) return finish("invalid-code");
    const operator = await resolveEditorialOperator(client, configuration.allowlist, true);
    if (operator.status !== "authorized") { clearLocalSession(); return finish(operator.status); }
    writes.push({ name: EDITORIAL_PENDING_COOKIE, value: "", options: { maxAge: 0 } });
    return finish("", "/editorial");
  } catch {
    // Never log provider response objects, codes, tokens, email addresses or cookies.
    if (action === "logout") { clearLocalSession(); return finish("signed-out"); }
    return finish("unavailable");
  }
}
