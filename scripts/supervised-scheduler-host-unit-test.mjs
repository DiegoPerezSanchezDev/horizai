import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runScheduledInvocationCli } from "./supervised-scheduler-run.ts";

const root = new URL("../", import.meta.url);
const workflow = await readFile(new URL("ops/github-actions/horizai-supervised-scheduler.yml", root), "utf8");
const orchestrator = await readFile(new URL("lib/agents/pipeline/scheduler/supervised-scheduler-orchestrator.ts", root), "utf8");
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

let invocations = 0;
let received;
const output = [];
const run = async (input) => {
  invocations += 1;
  received = input;
  return { statusCode: 200, ok: true, outcome: "STOPPED", executionSource: "github_actions" };
};
const now = () => new Date("2026-10-23T05:17:00.000Z");
const enabled = await runScheduledInvocationCli({
  args: ["--execute-supervised"], env: { SCHEDULER_WORKER_ENABLED: "true" }, now, invoke: run, write: (line) => output.push(line),
});
assert.equal(enabled, 0);
assert.equal(invocations, 1);
assert.equal(received.executionSource, "github_actions");
assert.deepEqual(received.metadata, {
  utcDate: "2026-10-23", triggerId: "supervised-candidates:2026-10-23", invocationId: "horizai-supervised:2026-10-23",
});
assert.equal(received.now.toISOString(), "2026-10-23T05:17:00.000Z");

assert.equal(await runScheduledInvocationCli({ args: [], env: { SCHEDULER_WORKER_ENABLED: "true" }, now, invoke: run, write: (line) => output.push(line) }), 2);
assert.equal(await runScheduledInvocationCli({ args: ["--execute-supervised"], env: {}, now, invoke: run, write: (line) => output.push(line) }), 2);
assert.equal(invocations, 1, "disabled or unconfirmed CLI must not invoke the orchestrator");
assert.equal(packageJson.scripts["pipeline:supervised:scheduled"], "node --env-file-if-exists=.env.local --conditions=react-server --experimental-strip-types scripts/supervised-scheduler-run.ts");

assert.equal(await (await import("node:fs/promises")).access(new URL(".github/workflows", root)).then(() => true, () => false), false);
assert.match(workflow, /17 5 \* \* \*/);
assert.match(workflow, /workflow_dispatch:/);
assert.match(workflow, /runs-on: ubuntu-latest/);
assert.match(workflow, /actions\/checkout@v7/);
assert.match(workflow, /actions\/setup-node@v7/);
assert.match(workflow, /package-manager-cache: false/);
assert.match(workflow, /timeout-minutes: 30/);
assert.match(workflow, /group: horizai-supervised-scheduler/);
assert.match(workflow, /cancel-in-progress: false/);
assert.match(workflow, /vars\.SCHEDULER_WORKER_ENABLED == 'true'/);
assert.match(workflow, /npm ci/);
assert.match(workflow, /npm run pipeline:supervised:scheduled -- --execute-supervised/);
assert.doesNotMatch(workflow, /SUPABASE_DIRECT_DB_URL|SCHEDULER_INTERNAL_TOKEN|CLOUDFLARE|CEREBRAS/);
assert.doesNotMatch(workflow, /npm run build|netlify deploy|actions\/upload-artifact|cache: npm/);
assert.match(workflow, /secrets\.SUPABASE_SECRET_KEY/);
assert.match(workflow, /secrets\.AGENT_API_KEY/);
assert.match(orchestrator, /executionSource: SchedulerExecutionSource/);
assert.match(orchestrator, /control\.claim/);
assert.match(orchestrator, /control\.finish/);
assert.match(orchestrator, /control\.heartbeat/);
assert.match(orchestrator, /chooseResumeFirstWork/);
assert.match(orchestrator, /createCapacityResumeRequestBudget/);
assert.match(orchestrator, /runSupervisedScheduledInvocation/);
assert.equal(output.filter((line) => line.includes('"executionSource": "github_actions"')).length, 1);

console.log("scheduler:host:unit: OK (single canonical orchestration call, opt-in CLI guard, UTC date, inactive GitHub template, least-privilege runtime secrets)");
