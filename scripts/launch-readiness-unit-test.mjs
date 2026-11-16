import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = fileURLToPath(new URL("../lib/public-site-url.ts", import.meta.url));
let importSequence = 0;

async function loadSiteUrlModule({ nodeEnv, siteUrl }) {
  process.env.NODE_ENV = nodeEnv;
  if (siteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = siteUrl;
  return import(`${pathToFileURL(modulePath).href}?case=${importSequence++}`);
}

const originalNodeEnv = process.env.NODE_ENV;
const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const netlifyEnvironment = Object.fromEntries(["NETLIFY", "CONTEXT", "URL", "HORIZAI_DEPLOY_CONTEXT"].map((name) => [name, process.env[name]]));
for (const name of Object.keys(netlifyEnvironment)) delete process.env[name];
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(" "));

try {
  const local = await loadSiteUrlModule({ nodeEnv: "development", siteUrl: "http://localhost:3000/" });
  assert.equal(local.getPublicSiteUrl()?.toString(), "http://localhost:3000/");
  assert.equal(local.canIndexPublicSite(), false);
  assert.equal(local.getCanonicalUrl("/noticias/historia")?.toString(), "http://localhost:3000/noticias/historia");

  const production = await loadSiteUrlModule({ nodeEnv: "production", siteUrl: "https://horizai.test/" });
  assert.equal(production.getPublicSiteUrl()?.toString(), "https://horizai.test/");
  assert.equal(production.canIndexPublicSite(), true);
  assert.equal(production.getSiteSocialImageUrl()?.toString(), "https://horizai.test/social-card");

  for (const invalidUrl of [undefined, "http://horizai.test", "http://localhost:3000", "https://horizai.test/path", "https://user:password@horizai.test", "https://horizai.test/?preview=1"]) {
    const invalid = await loadSiteUrlModule({ nodeEnv: "production", siteUrl: invalidUrl });
    assert.equal(invalid.getPublicSiteUrl(), undefined, `Expected URL to be rejected: ${invalidUrl ?? "missing"}`);
    assert.equal(invalid.canIndexPublicSite(), false, `Expected indexing to be disabled: ${invalidUrl ?? "missing"}`);
  }
  assert.ok(warnings.length > 0);
  assert.ok(warnings.every((warning) => !warning.includes("horizai.test") && !warning.includes("password")));

  process.env.NETLIFY = "true";
  process.env.CONTEXT = "production";
  process.env.URL = "https://horizai-pilot.netlify.app";
  const netlifyProduction = await loadSiteUrlModule({ nodeEnv: "production" });
  assert.equal(netlifyProduction.getPublicSiteUrl()?.origin, process.env.URL);
  assert.equal(netlifyProduction.canIndexPublicSite(), true);
  const customDomain = await loadSiteUrlModule({ nodeEnv: "production", siteUrl: "https://horizai.test" });
  assert.equal(customDomain.getPublicSiteUrl()?.origin, "https://horizai.test");
  for (const context of ["deploy-preview", "branch-deploy", "dev", "unknown"]) {
    process.env.CONTEXT = context;
    const preview = await loadSiteUrlModule({ nodeEnv: "production", siteUrl: "https://horizai.test" });
    assert.equal(preview.canIndexPublicSite(), false);
    const previewWithoutCanonical = await loadSiteUrlModule({ nodeEnv: "production" });
    assert.equal(previewWithoutCanonical.getPublicSiteUrl(), undefined);
  }
  delete process.env.NETLIFY;
  delete process.env.CONTEXT;
  process.env.HORIZAI_DEPLOY_CONTEXT = "deploy-preview";
  const runtimePreview = await loadSiteUrlModule({ nodeEnv: "production", siteUrl: "https://horizai.test" });
  assert.equal(runtimePreview.canIndexPublicSite(), false);

  const { serializeJsonLd } = await import("../lib/structured-data.ts");
  const jsonLd = serializeJsonLd({ headline: "A <script> title", separator: "\u2028\u2029" });
  assert.equal(JSON.parse(jsonLd).headline, "A <script> title");
  assert.equal(JSON.parse(jsonLd).separator, "\u2028\u2029");
  assert.ok(!jsonLd.includes("<script>"));
  assert.ok(!jsonLd.includes("\u2028") && !jsonLd.includes("\u2029"));

  process.stdout.write("Launch URL contract and JSON-LD escaping tests passed\n");
} finally {
  console.warn = originalWarn;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
  for (const [name, value] of Object.entries(netlifyEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
