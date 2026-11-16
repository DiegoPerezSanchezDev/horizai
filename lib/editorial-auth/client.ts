import "server-only";
import { createServerClient, type CookieMethodsServer } from "@supabase/ssr";
import { getEditorialAuthConfiguration } from "./config.ts";
import { EDITORIAL_SESSION_COOKIE, editorialCookiePolicy } from "./policy.ts";

/** A fresh, publishable-key Auth client per request. Never a service-role client. */
export function createEditorialAuthClient(cookies: CookieMethodsServer) {
  const configuration = getEditorialAuthConfiguration();
  if (!configuration) return null;
  return createServerClient(configuration.url, configuration.key, {
    cookieOptions: { name: EDITORIAL_SESSION_COOKIE, ...editorialCookiePolicy(process.env.NODE_ENV), maxAge: 60 * 60 * 24 * 7 },
    cookies,
    global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store", signal: AbortSignal.timeout(10_000) }) },
  });
}
