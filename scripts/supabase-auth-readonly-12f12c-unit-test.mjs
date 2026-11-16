import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const diagnosticUrl = pathToFileURL(resolve("scripts/supabase-auth-readonly-12f12c.mjs")).href;
const syntheticKey = ["sb", "secret", "synthetic", "offline"].join("_");
const publicKey = ["sb", "publishable", "synthetic", "offline"].join("_");
const checks = [];
for (const mode of ["success", "jwt-error", "missing-secret", "already-recorded"]) {
  const taskDir = await mkdtemp(join(tmpdir(), "horizai-auth-unit-"));
  try {
    await mkdir(join(taskDir, "artifacts"));
    const fileVariables = {
      NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
      ...(mode === "missing-secret" ? {} : { SUPABASE_SECRET_KEY: syntheticKey }),
    };
    await writeFile(join(taskDir, ".env.local"), Object.entries(fileVariables).map(([k, v]) => k + "=" + v).join("\n"));
    const outputPath = join(taskDir, "artifacts/supervised-cycle-12f12c-auth-diagnostic.json");
    if (mode === "already-recorded") await writeFile(outputPath, "{}");
    const script = [
      "let calls = 0;",
      "globalThis.fetch = async (input, init) => {",
      "const request = new Request(input, init);",
      "if (request.method !== 'POST' || !request.url.includes('/rest/v1/rpc/')) throw new Error('UNIT_BOUNDARY');",
      "if (request.headers.get('apikey') !== process.env.SUPABASE_SECRET_KEY) throw new Error('UNIT_KEY_SOURCE');",
      "if (request.headers.has('cookie')) throw new Error('UNIT_COOKIE');",
      "calls++;",
      "const body = " + JSON.stringify(mode) + " === 'jwt-error'",
      "? { code: 'PGRST303', message: 'JWT issued at future', details: process.env.SUPABASE_SECRET_KEY, hint: null }",
      ": { synthetic: true };",
      "return new Response(JSON.stringify(body), { status: " + (mode === "jwt-error" ? 401 : 200) + ", headers: { 'content-type': 'application/json' } });",
      "};",
      "await import(" + JSON.stringify(diagnosticUrl) + ");",
      "console.log('UNIT_NETWORK_CALLS=' + calls);",
    ].join("\n");
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/SUPABASE|GROQ|CEREBRAS|CLOUDFLARE|SECRET|TOKEN|PASSWORD/i.test(key)));
    Object.assign(childEnv, fileVariables);
    const child = spawnSync(process.execPath, ["--conditions=react-server", "--experimental-strip-types", "--input-type=module", "--eval", script],
      { cwd: taskDir, env: childEnv, encoding: "utf8", timeout: 20000 });
    assert.equal(child.status, 0, mode + ": child must complete without unhandled errors");
    const output = child.stdout + child.stderr;
    assert.ok(!output.includes(syntheticKey), "synthetic credential must not be printed");
    assert.ok(!output.includes(publicKey), "public credential must not be printed");
    if (mode === "already-recorded") {
      assert.ok(output.includes("DIAGNOSTIC_ALREADY_RECORDED"));
    } else {
      const evidenceText = await readFile(outputPath, "utf8");
      assert.ok(!evidenceText.includes(syntheticKey), "artifact must redact credentials");
      const evidence = JSON.parse(evidenceText);
      assert.equal(evidence.providerCalls, 0);
      assert.equal(evidence.remoteWrites, 0);
      assert.equal(evidence.resumeInvocations, 0);
      if (mode === "missing-secret") {
        assert.equal(evidence.requests.length, 0, "public variable must not substitute missing secret");
        assert.equal(evidence.diagnosticFailure, "Missing required server environment variable: SUPABASE_SECRET_KEY");
      } else {
        assert.equal(evidence.requests.length, 4, "exactly four safe reads; no automatic retries");
        assert.ok(evidence.requests.every((r) => r.apiKeyMatchesServerSecret && !r.cookiePresent));
        assert.ok(evidence.requests.every((r) => r.authorizationMode === "SERVER_SECRET_BEARER"));
        assert.ok(evidence.requests.every((r) => r.httpStatus === (mode === "jwt-error" ? 401 : 200)));
        if (mode === "jwt-error") assert.ok(evidence.requests.every((r) =>
          r.postgrestCode === "PGRST303" && r.message === "JWT issued at future" && r.details === "[REDACTED]"));
      }
    }
    checks.push({ mode, result: "PASS", externalNetworkRequests: 0 });
  } finally {
    // Only remove the absolute temporary directory created by mkdtemp above.
    await rm(taskDir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ suite: "12F.12C bounded auth diagnostic", checks, providerCalls: 0, remoteWrites: 0 }));
