import assert from "node:assert/strict";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { assertExecutionMode, parsePipelineCliArgs } from "../lib/agents/pipeline/pipeline-cli.ts";

const parse = (args) => parsePipelineCliArgs(args);
assert.equal(parse([]).executionMode, "preflight");
assert.equal(parse(["--hours=48", "--limit=1"]).execute, false);
assert.deepEqual(parse(["--preflight-only", "--hours=48", "--limit=1"]), { executionMode: "preflight", execute: false, preflightOnly: true, help: false, hours: 48, limit: 1, dryRun: true, publish: false });
assert.equal(parse(["--execute", "--hours=48", "--limit=1"]).executionMode, "execute");
assert.doesNotThrow(() => assertExecutionMode("execute"));
assert.throws(() => assertExecutionMode("preflight"));
for (const args of [["--execute"], ["--execute", "--hours=48"], ["--excute"], ["--publish=true"], ["--preflight-only", "--execute", "--hours=48", "--limit=1"], ["--prefligth-only"], ["--execute", "--hours=48", "--limit=2"]]) assert.throws(() => parse(args));
const logger = new InMemoryAgentLogger();
const before = await logger.getRemainingRequests(20, "2026-09-18");
assert.throws(() => parse(["--prefligth-only"]));
const after = await logger.getRemainingRequests(20, "2026-09-18");
assert.deepEqual(after, before);
let mockVerifierCalls = 0;
if (parse(["--execute", "--hours=48", "--limit=1"]).executionMode === "execute") { assert.doesNotThrow(() => assertExecutionMode("execute")); mockVerifierCalls += 1; }
assert.equal(mockVerifierCalls, 1);
console.log("pipeline:cli:unit: OK (safe default, explicit execute, args loss, unknown flags, publish lock, limit lock, reservation immutability)");
