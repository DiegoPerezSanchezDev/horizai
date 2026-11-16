import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalSupervisedRunCommand, parseSupervisedRunArgs } from "../lib/agents/pipeline/supervised-run-cli.ts";

assert.equal(parseSupervisedRunArgs(["--execute-supervised"]), "execute");
assert.equal(parseSupervisedRunArgs(["--help"]), "help");
for (const args of [[], ["--execute"], ["--excute-supervised"], ["--execute-supervised", "--help"], ["--execute-supervised", "--execute-supervised"], ["--", "--execute-supervised"]]) {
  assert.throws(() => parseSupervisedRunArgs(args), /Use only:/);
}
// A swallowed npm flag must never become implicit authorization via environment.
const priorFlag = process.env.npm_config_execute_supervised;
process.env.npm_config_execute_supervised = "true";
assert.throws(() => parseSupervisedRunArgs([]), /npm.cmd/);
if (priorFlag === undefined) delete process.env.npm_config_execute_supervised;
else process.env.npm_config_execute_supervised = priorFlag;

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const runner = readFileSync(new URL("./supervised-pipeline-run.ts", import.meta.url), "utf8");
assert.ok(runner.indexOf('parseSupervisedRunArgs(process.argv.slice(2))') < runner.indexOf('const supabase = createSupabaseServerClient()'));
assert.ok(canonicalSupervisedRunCommand.startsWith("npm.cmd run pipeline:supervised:run -- "));

// Run the exact package script/arguments in an isolated directory whose entrypoint
// only imports the pure parser. It has no .env, DB, scheduler, or provider imports.
const root = mkdtempSync(join(tmpdir(), "horizai-supervised-argv-"));
try {
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, scripts: { "pipeline:supervised:run": pkg.scripts["pipeline:supervised:run"] } }));
  const parserUrl = pathToFileURL(resolve("lib/agents/pipeline/supervised-run-cli.ts")).href;
  writeFileSync(join(root, "scripts/supervised-pipeline-run.ts"), `import { parseSupervisedRunArgs } from ${JSON.stringify(parserUrl)}; console.log(JSON.stringify({mode:parseSupervisedRunArgs(process.argv.slice(2)),argv:process.argv.slice(2),realWork:0}));`);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npmCommand, ["run", "pipeline:supervised:run", "--", "--execute-supervised"], { cwd: root, encoding: "utf8", shell: process.platform === "win32", windowsHide: true, timeout: 30_000 });
  const parsed = output.split(/\r?\n/).find((line) => line.startsWith('{"mode"'));
  assert.deepEqual(JSON.parse(parsed), { mode: "execute", argv: ["--execute-supervised"], realWork: 0 });
} finally {
  // root is a fresh mkdtemp child of the OS temp directory, never the workspace.
  assert.ok(root.startsWith(join(tmpdir(), "horizai-supervised-argv-")));
  rmSync(root, { recursive: true, force: true });
}
console.log("Supervised CLI fixtures passed: strict explicit flag, safe help, fail closed on swallowed flags, canonical npm.cmd forwarding; real work 0");
