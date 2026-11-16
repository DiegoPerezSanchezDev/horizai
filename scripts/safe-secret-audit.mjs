import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const secretPatterns = [
  ["supabase_private_key", /\bsb_secret_[A-Za-z0-9_-]{8,}/g],
  ["groq_api_key", /\bgsk_[A-Za-z0-9_-]{12,}/g],
  ["cerebras_api_key", /\bcsk_[A-Za-z0-9_-]{12,}/g],
  ["jwt_credential", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["database_url_credential", /\bpostgres(?:ql)?:\/\/[^:\s@/]+:[^@\s/]+@[^\s"'<>]+/gi],
  ["bearer_credential", /\bBearer\s+[A-Za-z0-9._~-]{24,}/gi],
  ["credential_assignment", /\b[A-Z][A-Z0-9_]*(?:SECRET|API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|DB_URL|DATABASE_URL)[ \t]*=[ \t]*["']?([^ \t\r\n"'#`,}]{16,})/g],
];

export function scanTextForSecretPresence(text) {
  const input = String(text);
  const categories = new Set();
  for (const [category, pattern] of secretPatterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(input)) !== null) {
      const capturedValue = match[1] ?? match[0];
      if (category === "credential_assignment" && /(?:^|[-_])(?:test|dummy|synthetic|fixture|example|placeholder|redacted)(?:[-_]|$)/i.test(capturedValue)) continue;
      categories.add(category);
      break;
    }
  }
  return [...categories].sort();
}

function gitText(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    throw new Error("SAFE_SECRET_AUDIT_GIT_QUERY_FAILED");
  }
}

function isExcludedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized === ".env.local" || normalized.endsWith("/.env.local");
}

export function auditRepository(cwd = process.cwd()) {
  const root = resolve(cwd);
  const listed = gitText(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)
    .split("\0").filter(Boolean).filter((path) => !isExcludedPath(path));
  const findings = new Map();
  let filesScanned = 0;
  const addFinding = (path, categories) => {
    if (categories.length === 0) return;
    const key = path.replaceAll("\\", "/");
    findings.set(key, [...new Set([...(findings.get(key) ?? []), ...categories])].sort());
  };

  for (const repoPath of listed) {
    let bytes;
    try { bytes = readFileSync(resolve(root, repoPath)); } catch { continue; }
    if (bytes.includes(0)) continue;
    filesScanned += 1;
    addFinding(repoPath, scanTextForSecretPresence(bytes.toString("utf8")));
  }

  const diff = gitText(["diff", "--no-ext-diff", "--unified=0", "HEAD", "--"], root);
  let diffPath = "git-diff";
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      diffPath = line.slice(6);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    addFinding(diffPath, scanTextForSecretPresence(line.slice(1)));
  }

  let envLocalIgnored = false;
  try {
    execFileSync("git", ["check-ignore", "--quiet", ".env.local"], { cwd: root, stdio: "ignore" });
    envLocalIgnored = true;
  } catch { /* the report records only the ignore state; it does not read the file */ }

  return {
    filesScanned,
    findings: [...findings].map(([path, categories]) => ({ path, categories, presence: true })),
    envLocalIgnored,
  };
}

export function formatSanitizedAudit(report) {
  const lines = [
    `SAFE_SECRET_AUDIT ${report.findings.length === 0 ? "PASS" : "FINDINGS"}`,
    `files_scanned=${report.filesScanned}`,
    `finding_files=${report.findings.length}`,
    `env_local_ignored=${report.envLocalIgnored ? "true" : "false"}`,
  ];
  for (const finding of report.findings) {
    lines.push(`presence=true path=${finding.path} categories=${finding.categories.join(",")}`);
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = auditRepository();
    process.stdout.write(`${formatSanitizedAudit(report)}\n`);
    if (report.findings.length > 0 || !report.envLocalIgnored) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SAFE_SECRET_AUDIT_FAILED");
    process.exitCode = 1;
  }
}
