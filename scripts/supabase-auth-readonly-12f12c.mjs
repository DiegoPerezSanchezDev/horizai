import { access, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

// A bounded diagnostic, never a retry loop or a resume entry point.
const outputPath = "artifacts/supervised-cycle-12f12c-auth-diagnostic.json";
let alreadyRecorded = false;
try { await access(outputPath); alreadyRecorded = true; } catch { /* First invocation. */ }
if (alreadyRecorded) {
  console.log("DIAGNOSTIC_ALREADY_RECORDED; no network requests");
  process.exit(0);
}
const variables = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const fileEnv = parseEnv(await readFile(".env.local", "utf8"));
const secrets = Object.entries({ ...fileEnv, ...process.env })
  .filter(([name, value]) => /KEY|TOKEN|PASSWORD|DB_URL/.test(name) && value)
  .map(([, value]) => value);
function safe(value) {
  if (value == null) return null;
  let result = String(value);
  for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
  return result.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED_KEY]");
}
const realFetch = globalThis.fetch;
const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
let currentPath;
const requests = [];
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const allowed = ["get_pipeline_human_review_operator_status", "list_pipeline_human_reviews_operator"];
  if (url.origin !== origin || request.method !== "POST" ||
      !allowed.some((rpc) => url.pathname === `/rest/v1/rpc/${rpc}`)) {
    throw new Error("READ_ONLY_DIAGNOSTIC_BOUNDARY");
  }
  if (requests.length >= 4) throw new Error("DIAGNOSTIC_REQUEST_CAP");
  const headers = request.headers;
  const record = {
    clientPath: currentPath, endpoint: url.pathname, method: request.method,
    apiKeyMatchesServerSecret: headers.get("apikey") === process.env.SUPABASE_SECRET_KEY,
    authorizationMode: headers.get("authorization") === `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      ? "SERVER_SECRET_BEARER" : headers.has("authorization") ? "OTHER_PRESENT" : "ABSENT",
    cookiePresent: headers.has("cookie"),
  };
  requests.push(record);
  const response = await realFetch(request);
  let body;
  try { body = await response.clone().json(); } catch { body = null; }
  Object.assign(record, {
    httpStatus: response.status, postgrestCode: safe(body?.code),
    message: safe(body?.message), details: safe(body?.details), hint: safe(body?.hint),
    result: response.ok ? "PASS" : safe(body?.code) ?? "HTTP_ERROR",
  });
  return response;
};

const output = {
  phase: "12F.12C", utcDate: new Date().toISOString().slice(0, 10),
  envConsistency: Object.fromEntries(variables.map((name) => [name, {
    process: process.env[name]?.trim() ? "PRESENT" : "ABSENT",
    envLocal: fileEnv[name]?.trim() ? "PRESENT" : "ABSENT",
    matchesEnvLocal: process.env[name] && fileEnv[name] ? process.env[name] === fileEnv[name] : null,
  }])),
  credentialClass: process.env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")
    ? "SUPABASE_SECRET_KEY" : "OTHER_FORMAT",
  loader: "node --env-file-if-exists=.env.local", freshProcess: true,
  requests, providerCalls: 0, remoteWrites: 0, claimCount: 0, resumeInvocations: 0,
};
try {
  // The successful 10C path and failing 12B path used this identical factory.
  for (const path of ["12F.10C known-safe helper", "12F.12B normal helper"]) {
    currentPath = path;
    const client = createSupabaseServerClient();
    await client.rpc("get_pipeline_human_review_operator_status", {});
    await client.rpc("list_pipeline_human_reviews_operator", { p_limit: 1 });
  }
} catch (error) {
  output.diagnosticFailure = safe(error.message);
} finally {
  globalThis.fetch = realFetch;
}
await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output, null, 2));
