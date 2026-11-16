import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { auditRepository, formatSanitizedAudit, scanTextForSecretPresence } from "./safe-secret-audit.mjs";

const supabaseSecret = ["sb", "_secret_", "SYNTHETIC", "_ONLY_123456"].join("");
const groqSecret = ["gsk", "_SYNTHETIC_ONLY_123456"].join("");
const dbPassword = ["synthetic", "-password", "-only"].join("");
const assignedSecret = ["assembled", "offline", "credential", "material", "00123"].join("_");
const privateDbUrl = ["postgresql://", "fixture:", dbPassword, "@localhost:5432/fixture"].join("");
const text = `SUPABASE_SECRET_KEY=${supabaseSecret}\nAGENT_API_KEY=${groqSecret}\nSOME_PRIVATE_KEY=${assignedSecret}\nDB=${privateDbUrl}`;
const categories = scanTextForSecretPresence(text);
assert.deepEqual(categories, ["credential_assignment", "database_url_credential", "groq_api_key", "supabase_private_key"]);
assert.deepEqual(scanTextForSecretPresence("TEST_API_TOKEN=unit-test-token-placeholder-value"), [], "obvious placeholder values are not reported as credentials");

const report = formatSanitizedAudit({
  filesScanned: 3,
  envLocalIgnored: true,
  findings: [{ path: "artifacts/synthetic.json", categories, presence: true }],
});
assert.match(report, /presence=true/);
assert.match(report, /artifacts\/synthetic\.json/);
assert.doesNotMatch(report, new RegExp(supabaseSecret));
assert.doesNotMatch(report, new RegExp(groqSecret));
assert.doesNotMatch(report, new RegExp(dbPassword));
assert.doesNotMatch(report, new RegExp(assignedSecret));
assert.doesNotMatch(report, /postgresql:\/\//i);

console.log("Secret audit detects synthetic credentials and reports sanitized presence only");

const repository = mkdtempSync(join(tmpdir(), "horizai-secret-audit-"));
try {
  const git = (...args) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  git("init", "--quiet");
  writeFileSync(join(repository, ".gitignore"), ".env.local\n");
  writeFileSync(join(repository, "large.txt"), "baseline\n");
  git("add", ".");
  git("-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.test", "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "synthetic baseline");
  writeFileSync(join(repository, "large.txt"), "Synthetic non-sensitive release content for the audit buffer regression.\n".repeat(25_000));
  const largeReport = auditRepository(repository);
  assert.deepEqual(largeReport.findings, []);
  assert.equal(largeReport.envLocalIgnored, true);
  assert.equal(largeReport.filesScanned, 2);
  console.log("Secret audit handles a Git diff larger than the default child-process buffer");
} finally {
  assert.equal(dirname(resolve(repository)), resolve(tmpdir()));
  assert.ok(basename(repository).startsWith("horizai-secret-audit-"));
  rmSync(repository, { recursive: true, force: true });
}
