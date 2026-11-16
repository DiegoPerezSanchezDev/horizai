import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { resolve } from "node:path";
import { scanTextForSecretPresence } from "./safe-secret-audit.mjs";

const mode = process.argv[2];
assert.ok(["development", "production"].includes(mode));
const origin = process.env.HORIZAI_EDITORIAL_QA_ORIGIN ?? `http://127.0.0.1:${mode === "production" ? 3017 : 3016}`;
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/, "QA may only contact a local server");
const paths = ["/editorial", "/editorial?scenario=empty", "/editorial/reviews/demo-madrid", "/editorial/reviews/demo-warning", "/editorial/reviews/demo-corrected"];
const checks = [];
const cookieFile = process.env.HORIZAI_EDITORIAL_QA_COOKIE_FILE;
let operatorCookie = "";
if (cookieFile) {
  assert.equal(mode, "development", "Fixture session is development-only");
  const file = resolve(cookieFile);
  assert.equal(file, resolve(".auth-01-local/operator-cookies.json"));
  operatorCookie = JSON.parse(await readFile(file, "utf8")).map(([name, value]) => `${name}=${value}`).join("; ");
}
const fixtureAccess = mode === "development" && !!operatorCookie;

for (const path of paths) {
  const response = await fetch(origin + path, { redirect: "manual", headers: { Cookie: operatorCookie } });
  const body = await response.text();
  assert.equal(response.status, fixtureAccess ? 200 : 303, path);
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  const cacheControl = response.headers.get("cache-control") ?? "";
  assert.match(cacheControl, mode === "production" ? /private.*no-store/ : /no-cache|no-store/);
  const csp = response.headers.get("content-security-policy") ?? "";
  if (!fixtureAccess) {
    assert.doesNotMatch(body, /Un laboratorio público de Madrid|Una red de hospitales|Un consorcio europeo|demo-draft-01|demo-revision-02|En este ejemplo de desarrollo/);
    if (mode === "production") assert.doesNotMatch(csp, /unsafe-eval/);
    assert.equal(new URL(response.headers.get("location"), origin).pathname, "/editorial/login");
  } else {
    assert.match(body, /noindex/);
    assert.match(csp, /unsafe-eval/);
    assert.match(body, /Datos simulados/);
    if (path.includes("scenario=empty")) assert.match(body, /Todo al día/);
    if (path.includes("demo-warning")) assert.match(body, /Bloqueo editorial/);
    if (path.includes("demo-corrected")) assert.match(body, /demo-revision-02/);
  }
  assert.deepEqual(scanTextForSecretPresence(body), [], path);
  checks.push({ path, status: response.status, noindex: true, cacheControl, secrets: "NONE" });
}

const rsc = await fetch(origin + "/editorial/reviews/demo-madrid", { redirect: "manual", headers: { RSC: "1", Cookie: operatorCookie } });
const rscBody = await rsc.text();
if (!fixtureAccess) {
  assert.equal(rsc.status, 303);
  assert.doesNotMatch(rscBody, /Un laboratorio público de Madrid|demo-draft-01/);
}
checks.push({ request: "direct RSC", status: rsc.status, fixtureLeakInProduction: false });

if (fixtureAccess) {
  // Native fetch normalizes Host; use node:http to actually send the hostile header.
  const outside = await new Promise((resolve, reject) => {
    get(origin + "/editorial/reviews/demo-madrid", { headers: { Host: "untrusted.example.org", Cookie: operatorCookie } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    }).on("error", reject);
  });
  assert.equal(outside.status, 404);
  assert.doesNotMatch(outside.body, /Un laboratorio público de Madrid|demo-draft-01/);
  checks.push({ request: "nonlocal Host", status: outside.status, fixtureLeak: false });
  const unknown = await fetch(origin + "/editorial/reviews/unknown", { headers: { Cookie: operatorCookie } });
  assert.equal(unknown.status, 404);
  assert.match(await unknown.text(), /Revisión no disponible/);
  checks.push({ request: "unknown review", status: unknown.status });
}

const sitemap = await fetch(origin + "/sitemap.xml");
assert.doesNotMatch(await sitemap.text(), /editorial/);
const robots = await fetch(origin + "/robots.txt");
const robotsBody = await robots.text();
assert.ok(robotsBody.includes("Disallow: /") || robotsBody.includes("Disallow: /editorial"));

let clientFilesScanned = 0;
async function scanClientBundles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await scanClientBundles(path);
    else if (entry.name.endsWith(".js")) {
      const source = await readFile(path, "utf8");
      assert.deepEqual(scanTextForSecretPresence(source), [], "No credential values in client bundles");
      assert.doesNotMatch(source, /SUPABASE_SECRET_KEY|EDITORIAL_OPERATOR_EMAILS|operator@example\.test|En este ejemplo de desarrollo, un laboratorio|Este caso ficticio describe una propuesta|Esta revisión humana ficticia corrige/);
      clientFilesScanned++;
    }
  }
}
if (mode === "production") await scanClientBundles(".next/static");

const report = { status: "PASS", mode, fixtureAccess, origin, checks, sitemapExcludesEditorial: true, noindex: true, clientFilesScanned, remoteWrites: 0 };
await writeFile(`artifacts/auth-01/editorial-routes-${mode}-${fixtureAccess ? "operator" : "anonymous"}.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
