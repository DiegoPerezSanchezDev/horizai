import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const localEvidenceSuites = new Set([
  "cloudflare:quality-benchmark:unit",
  "pipeline:factual-remediation:final-resume:unit",
  "pipeline:factual-remediation:continuation:unit",
  "human-review:revision-binding:unit",
  "supervised-snapshot:executor:unit",
]);
const suites = Object.entries(scripts).filter(([name]) =>
  (name.endsWith(":unit") || name === "agents:contracts:test") && !localEvidenceSuites.has(name),
);
let failures = 0;
const logDirectory = new URL("../artifacts/release-checks/", import.meta.url);
mkdirSync(logDirectory, { recursive: true });
for (const [name, command] of suites) {
  const [executable, ...args] = command.split(/\s+/);
  if (executable !== "node" || args.some((argument) => argument.startsWith("--env-file"))) {
    throw new Error(`Release suite must be a standalone offline Node command: ${name}`);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env, GROQ_TPM_PACING_MAX_WAIT_MS: "0" },
  });
  if (result.status === 0) console.log(`PASS ${name}`);
  else {
    failures++;
    const logName = `${name.replaceAll(":", "-")}.log`;
    writeFileSync(new URL(logName, logDirectory), `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`);
    console.error(`FAIL ${name}; details: artifacts/release-checks/${logName}`);
  }
}
console.log(`Release suites: ${suites.length - failures}/${suites.length} passed.`);
console.log(`${localEvidenceSuites.size} historical evidence suites require private local artifacts and are outside this release check.`);
for (const name of localEvidenceSuites) console.log(`LOCAL EVIDENCE REQUIRED ${name}`);
process.exitCode = failures ? 1 : 0;
