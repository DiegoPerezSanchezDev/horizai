import { NextResponse, type NextRequest } from "next/server";
import type { CookieOptions } from "@supabase/ssr";
import { createEditorialAuthClient } from "./lib/editorial-auth/client";
import { getEditorialAuthConfiguration, getEditorialAuthOrigin } from "./lib/editorial-auth/config";
import { editorialCookiePolicy, isEditorialAuthPublicPath, isEditorialSessionCookie } from "./lib/editorial-auth/policy";
import { resolveEditorialOperator } from "./lib/editorial-auth/resolve";

/** Verified operator boundary before HTML/RSC, including the future private API namespace. */
export async function proxy(request: NextRequest) {
  const writes: { name: string; value: string; options: CookieOptions }[] = [];
  const cacheHeaders: Record<string, string> = {};
  let response: NextResponse;
  if (isEditorialAuthPublicPath(request.nextUrl.pathname)) {
    response = NextResponse.next();
  } else {
    const hadSession = request.cookies.getAll().some((cookie) => isEditorialSessionCookie(cookie.name));
    const client = createEditorialAuthClient({
      getAll: () => request.cookies.getAll(),
      setAll(changes, headers) {
        for (const change of changes) { request.cookies.set(change.name, change.value); writes.push(change); }
        Object.assign(cacheHeaders, headers);
      },
    });
    const result = await resolveEditorialOperator(client, getEditorialAuthConfiguration()?.allowlist ?? [], hadSession);
    if (result.status === "authorized") {
      response = NextResponse.next({ request: { headers: request.headers } });
    } else if (request.nextUrl.pathname.startsWith("/api/")) {
      response = NextResponse.json({ error: "EDITORIAL_ACCESS_DENIED" }, { status: result.status === "unauthorized" ? 403 : result.status === "unavailable" ? 503 : 401 });
    } else {
      // No user-controlled return URL, code, email or token in the redirect.
      const target = new URL("/editorial/login", getEditorialAuthOrigin(request.url) ?? request.url);
      target.search = `?state=${result.status}`;
      response = NextResponse.redirect(target, 303);
    }
  }
  for (const change of writes) response.cookies.set(change.name, change.value, { ...change.options, ...editorialCookiePolicy(process.env.NODE_ENV) });
  for (const [key, value] of Object.entries(cacheHeaders)) response.headers.set(key, value);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
  response.headers.set("Referrer-Policy", "same-origin");
  return response;
}

export const config = { matcher: ["/editorial/:path*", "/api/editorial/:path*"] };
