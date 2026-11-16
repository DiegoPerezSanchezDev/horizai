import assert from "node:assert/strict";
import { logRemoteReadFailure, normalizeRemoteReadFailure } from "../lib/supabase/safe-remote-read-error.ts";
const syntheticSecret = ["synthetic", "secret", "value", "only"].join("_");
const previousSecret = process.env.SUPABASE_SECRET_KEY;
process.env.SUPABASE_SECRET_KEY = syntheticSecret;
const originalError = console.error;
const emitted = [];
console.error = (...args) => emitted.push(args.map(String).join(" "));
try {
  const full = normalizeRemoteReadFailure({
    operation: "load deferred attempt", endpointClass: "TABLE", httpStatus: 401,
    error: { code: "PGRST303", message: "JWT validation failed", details: "safe detail", hint: "safe hint" },
    timestamp: "2026-10-20T12:00:00.000Z",
  });
  assert.equal(full?.httpStatus, 401);
  assert.equal(full?.code, "PGRST303");
  assert.equal(full?.message, "JWT validation failed");
  assert.equal(full?.details, "safe detail");
  assert.equal(full?.hint, "safe hint");
  assert.equal(full?.operation, "load deferred attempt");
  assert.equal(full?.endpointClass, "TABLE");
  assert.equal(full?.timestamp, "2026-10-20T12:00:00.000Z");
  assert.equal(full?.clientHelper, "createSupabaseServerClient");
  const sparse = normalizeRemoteReadFailure({
    operation: "read status", endpointClass: "RPC",
    error: { code: undefined, message: "unavailable", details: null, hint: undefined },
  });
  assert.deepEqual(
    { httpStatus: sparse?.httpStatus, code: sparse?.code, details: sparse?.details, hint: sparse?.hint },
    { httpStatus: null, code: null, details: null, hint: null },
  );
  logRemoteReadFailure({
    operation: "read status", endpointClass: "RPC", httpStatus: 401,
    error: {
      code: "PGRST303", message: "Authorization: Bearer abcdefghijklmnop",
      details: "cookie: synthetic_cookie_value",
      hint: "apikey=" + syntheticSecret,
    },
    timestamp: "2026-10-20T12:00:00.000Z",
  });
  assert.equal(emitted.length, 1);
  const line = emitted[0];
  assert.ok(!line.includes(syntheticSecret));
  assert.ok(!line.includes("abcdefghijklmnop"));
  assert.ok(!line.includes("synthetic_cookie_value"));
  assert.ok(!line.includes("apikey="));
  const record = JSON.parse(line.slice(line.indexOf("{")));
  assert.equal(record.httpStatus, 401);
  assert.equal(record.code, "PGRST303");
  assert.equal(record.message, "[REDACTED]");
  assert.equal(record.details, "[REDACTED]");
  assert.equal(record.hint, "[REDACTED]");
  const beforeSuccess = emitted.length;
  assert.equal(normalizeRemoteReadFailure({
    operation: "list reviews", endpointClass: "RPC", httpStatus: 200, error: null,
  }), null);
  assert.equal(emitted.length, beforeSuccess);
  console.log(JSON.stringify({ suite: "PostgREST safe read error observability", status: "PASS",
    checks: ["status", "code", "message/details/hint", "missing fields", "auth redaction", "secret redaction", "cookie redaction", "success unaffected"] }));
} finally {
  console.error = originalError;
  if (previousSecret === undefined) delete process.env.SUPABASE_SECRET_KEY;
  else process.env.SUPABASE_SECRET_KEY = previousSecret;
}
