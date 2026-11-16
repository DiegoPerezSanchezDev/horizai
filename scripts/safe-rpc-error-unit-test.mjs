import assert from "node:assert/strict";
import { normalizeSafeRpcFailure } from "../lib/supabase/safe-rpc-error.ts";

const previousSecret = process.env.SUPABASE_SECRET_KEY;
process.env.SUPABASE_SECRET_KEY = "synthetic-secret-value-for-redaction-test";

const postgrest = normalizeSafeRpcFailure("bind_revision", {
  code: "PGRST202",
  message: "RPC not found",
  details: "safe details",
  hint: "safe hint",
}, { httpStatus: 404 });
assert.deepEqual(postgrest, {
  operation: "bind_revision",
  httpStatus: 404,
  postgrestCode: "PGRST202",
  sqlState: null,
  message: "RPC not found",
  details: "safe details",
  hint: "safe hint",
  causeName: null,
  causeMessage: null,
});

const postgres = normalizeSafeRpcFailure("bind_revision", {
  code: "22023",
  message: "human_review_revision_input_invalid",
  details: "constraint context",
  hint: "correct the supplied JSON shape",
}, { httpStatus: 400 });
assert.equal(postgres.sqlState, "22023");
assert.equal(postgres.postgrestCode, null);
assert.equal(postgres.httpStatus, 400);
assert.equal(postgres.message, "human_review_revision_input_invalid");
assert.equal(postgres.details, "constraint context");
assert.equal(postgres.hint, "correct the supplied JSON shape");

const nestedCause = Object.assign(new Error("transport wrapper"), {
  cause: Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND example.invalid") }),
});
const transport = normalizeSafeRpcFailure("bind_revision", nestedCause);
assert.equal(transport.httpStatus, null);
assert.equal(transport.causeName, "TypeError");
assert.equal(transport.causeMessage, "fetch failed; getaddrinfo ENOTFOUND example.invalid");

const secret = process.env.SUPABASE_SECRET_KEY;
const redacted = normalizeSafeRpcFailure("bind_revision", {
  code: "PGRST301",
  message: `key=${secret}`,
  details: `Bearer ${secret}`,
  hint: ["postgres://user:", secret, "@db.example.invalid:5432/postgres"].join(""),
}, { sensitiveValues: ["synthetic article body that must not persist"] });
assert.equal(redacted.message, "key=[REDACTED]");
assert.equal(redacted.details, "Bearer [REDACTED]");
assert.equal(redacted.hint, "[REDACTED_DATABASE_URL]");
assert.equal(JSON.stringify(redacted).includes(secret), false);
assert.equal(JSON.stringify(redacted).includes("synthetic article body that must not persist"), false);

assert.deepEqual(normalizeSafeRpcFailure("bind_revision", {}), {
  operation: "bind_revision",
  httpStatus: null,
  postgrestCode: null,
  sqlState: null,
  message: null,
  details: null,
  hint: null,
  causeName: null,
  causeMessage: null,
});
assert.equal(normalizeSafeRpcFailure("bind_revision", "non-Error failure").message, null);
assert.equal(normalizeSafeRpcFailure("bind_revision", { message: "plain object error", code: "PGRST999" }).message, "plain object error");
assert.equal(normalizeSafeRpcFailure("bind_revision", { message: "x" }, { httpStatus: 700 }).httpStatus, null);

if (previousSecret === undefined) delete process.env.SUPABASE_SECRET_KEY;
else process.env.SUPABASE_SECRET_KEY = previousSecret;

console.log(JSON.stringify({ status: "PASS", postgrestCode: true, sqlState: true, messageDetailsHint: true, cause: true, missingFields: true, nonErrorValues: true, redaction: true }, null, 2));
