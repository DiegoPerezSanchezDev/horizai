import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeOperatorEmail, parseOperatorAllowlist, authorizeVerifiedOperator, isSameOriginAuthPost, editorialCookiePolicy, isEditorialProtectedPath, isEditorialAuthPublicPath } from "../lib/editorial-auth/policy.ts";
import { resolveEditorialOperator } from "../lib/editorial-auth/resolve.ts";
import { getEditorialAuthConfiguration, getEditorialAuthOrigin } from "../lib/editorial-auth/config.ts";

const email = "operator@example.test";
const user = { id: "synthetic-operator", email, email_confirmed_at: "2026-10-21T08:00:00Z", is_anonymous: false };
const mock = (result) => ({ auth: { getUser: async () => result } });

test("operator allowlist normalizes exact verified emails and fails closed on malformed configuration", () => {
  assert.equal(normalizeOperatorEmail(" Operator@EXAMPLE.test "), email);
  assert.deepEqual(parseOperatorAllowlist(" Operator@EXAMPLE.test, second@example.test;operator@example.test\n"), [email, "second@example.test"]);
  for (const value of [undefined, "", "bad", "operator@example.test,bad", "operator@example.test\r\nInjected: value"]) assert.deepEqual(parseOperatorAllowlist(value), []);
  for (const value of [null, 42, "a@b", "a b@example.test"]) assert.equal(normalizeOperatorEmail(value), null);
});

test("verified allowlisted operator receives only minimal identity", () => {
  assert.deepEqual(authorizeVerifiedOperator({ ...user, email: " Operator@EXAMPLE.test ", user_metadata: { admin: true } }, [email]), { status: "authorized", operator: { id: user.id, email } });
  for (const patch of [{ email: "outsider@example.test" }, { email_confirmed_at: undefined }, { email_confirmed_at: "invalid" }, { is_anonymous: true }, { id: "" }]) {
    assert.deepEqual(authorizeVerifiedOperator({ ...user, ...patch }, [email]), { status: "unauthorized" });
  }
  assert.deepEqual(authorizeVerifiedOperator(user, []), { status: "unauthorized" });
});

test("canonical resolver denies anonymous, expired, malformed, provider errors and missing configuration", async () => {
  const good = mock({ data: { user }, error: null });
  assert.deepEqual(await resolveEditorialOperator(good, [email], true), { status: "authorized", operator: { id: user.id, email } });
  assert.deepEqual(await resolveEditorialOperator(good, [email], false), { status: "anonymous" });
  assert.deepEqual(await resolveEditorialOperator(null, [email], true), { status: "unavailable" });
  assert.deepEqual(await resolveEditorialOperator(good, [], true), { status: "unavailable" });
  for (const result of [{ data: { user: null }, error: null }, { data: { user: null }, error: { status: 401 } }, { data: { user: null }, error: { status: 400, code: "refresh_token_not_found" } }]) {
    assert.deepEqual(await resolveEditorialOperator(mock(result), [email], true), { status: "expired" });
  }
  assert.deepEqual(await resolveEditorialOperator(mock({ data: { user: null }, error: { status: 503 } }), [email], true), { status: "unavailable" });
  assert.deepEqual(await resolveEditorialOperator({ auth: { getUser: async () => { throw new Error("provider failure"); } } }, [email], true), { status: "unavailable" });
  assert.deepEqual(await resolveEditorialOperator(mock({ data: { user: { ...user, email: "outsider@example.test" } }, error: null }), [email], true), { status: "unauthorized" });
});

test("editorial pages and future APIs are protected, public product stays outside the matcher", () => {
  for (const path of ["/editorial", "/editorial/reviews/x", "/api/editorial", "/api/editorial/reviews/x"]) assert.equal(isEditorialProtectedPath(path), true);
  for (const path of ["/", "/?map=heat", "/noticias/public-story", "/privacidad", "/terminos", "/editorial/login", "/editorial/auth/request", "/editorial/auth/verify", "/editorial/auth/logout"]) assert.equal(isEditorialProtectedPath(path), false);
  assert.equal(isEditorialAuthPublicPath("/editorial/auth/verify/extra"), false);
});

test("cookie model is HttpOnly, host-only, SameSite Lax, Secure in production", () => {
  assert.deepEqual(editorialCookiePolicy("production"), { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  assert.equal(editorialCookiePolicy("development").secure, false);
  assert.equal("domain" in editorialCookiePolicy("production"), false);
});

test("auth POSTs enforce exact trusted Origin and reject missing/null/cross-site origins", () => {
  assert.equal(isSameOriginAuthPost("https://horizai.example", "https://horizai.example", "same-origin"), true);
  for (const [origin, expected, fetchSite] of [[null,"https://horizai.example",null], ["null","https://horizai.example",null], ["https://evil.example","https://horizai.example",null], ["https://horizai.example.evil.test","https://horizai.example",null], ["https://horizai.example","https://horizai.example","cross-site"], ["https://horizai.example",null,null]]) assert.equal(isSameOriginAuthPost(origin, expected, fetchSite), false);
});

test("server configuration never falls back to privileged credentials and rejects unsafe production URLs", () => {
  const names = ["NODE_ENV","EDITORIAL_OPERATOR_EMAILS","EDITORIAL_AUTH_URL","EDITORIAL_AUTH_PUBLISHABLE_KEY","EDITORIAL_AUTH_ORIGIN","NEXT_PUBLIC_SITE_URL"];
  const before = Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try {
    process.env.NODE_ENV = "production";
    process.env.EDITORIAL_OPERATOR_EMAILS = email;
    process.env.EDITORIAL_AUTH_URL = "https://auth.example.test";
    process.env.EDITORIAL_AUTH_PUBLISHABLE_KEY = "sb_publishable_fixture_auth01";
    assert.equal(getEditorialAuthConfiguration()?.allowlist[0], email);
    process.env.EDITORIAL_AUTH_PUBLISHABLE_KEY = "sb_" + "secret_fixture_auth01";
    assert.equal(getEditorialAuthConfiguration(), null);
    process.env.EDITORIAL_AUTH_PUBLISHABLE_KEY = "sb_publishable_fixture_auth01";
    process.env.EDITORIAL_AUTH_URL = "http://127.0.0.1:55321";
    assert.equal(getEditorialAuthConfiguration(), null);
    process.env.NODE_ENV = "development";
    assert.ok(getEditorialAuthConfiguration());
    delete process.env.EDITORIAL_AUTH_ORIGIN;
    delete process.env.NEXT_PUBLIC_SITE_URL;
    assert.equal(getEditorialAuthOrigin("http://127.0.0.1:3016/editorial/auth/request"), "http://127.0.0.1:3016");
    process.env.NODE_ENV = "production";
    assert.equal(getEditorialAuthOrigin("http://127.0.0.1:3016/editorial/auth/request"), null);
  } finally {
    for (const name of names) { if(before[name]===undefined) delete process.env[name]; else process.env[name]=before[name]; }
  }
});

test("server helper and adapter revalidate authorization independently of the proxy", () => {
  const helper = readFileSync("lib/editorial-auth/server.ts","utf8");
  assert.match(helper,/import "server-only"/);
  assert.match(helper,/requireEditorialOperator = cache/);
  assert.match(helper,/await resolveEditorialOperator/);
  assert.match(helper,/result.status !== "authorized"\) redirect/);
  assert.doesNotMatch(helper,/getSession\(/);
  const guard = readFileSync("lib/editorial/access.ts","utf8");
  assert.ok(guard.indexOf("await requireEditorialOperator()") < guard.indexOf('if (process.env.NODE_ENV !== "development")'));
  const config = readFileSync("lib/editorial-auth/config.ts","utf8");
  assert.doesNotMatch(config,/NEXT_PUBLIC_EDITORIAL_OPERATOR|SUPABASE_SECRET_KEY|SERVICE_ROLE/);
  const handlers = readFileSync("lib/editorial-auth/handlers.ts","utf8");
  assert.match(handlers,/shouldCreateUser: false/);
  assert.doesNotMatch(handlers,/console\.|signUp\(|signInWithPassword\(|\.rpc\(/);
  const client = readFileSync("lib/editorial-auth/client.ts","utf8");
  assert.doesNotMatch(client,/localStorage|createBrowserClient|SUPABASE_SECRET_KEY/);
});
