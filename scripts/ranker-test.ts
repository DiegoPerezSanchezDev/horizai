import nextEnv from "@next/env";
import { spawn } from "node:child_process";
import { errorSummary, AgentError, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { getClassifierModelConfig } from "../lib/agents/classifier/classifier-agent.ts";
import { getRankerModelConfig } from "../lib/agents/ranker/ranker-agent.ts";
import { parseVerifierCliOptions } from "../lib/agents/verifier/verifier-cli-options.ts";

nextEnv.loadEnvConfig(process.cwd());

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => { const child = spawn(process.execPath, ["--experimental-strip-types", command, ...args], { stdio: "inherit", env: process.env }); child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
}

async function main(): Promise<void> {
  const missing = ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_VERIFY", "AGENT_MODEL_TRANSLATE", "AGENT_MODEL_EDITOR", "AGENT_MODEL_CLASSIFY", "AGENT_MODEL_RANK"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const { hours, limit } = parseVerifierCliOptions(process.argv);
  const classifierConfig = { ...getClassifierModelConfig(), maxRetries: 0 };
  const rankerConfig = { ...getRankerModelConfig(), maxRetries: 0 };
  const availability = await new SupabaseAgentLogger().getRemainingRequests(rankerConfig.dailyRequestLimit, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 5) throw new AgentError("DAILY_REQUEST_LIMIT_REACHED", "Ranker E2E requires five reserved requests");
  if (classifierConfig.maxRetries !== 0 || rankerConfig.maxRetries !== 0) throw new Error("Ranker E2E requires maxRetries=0");
  const classifierExit = await run("scripts/classifier-test.ts", [`--hours=${hours}`, `--limit=${limit}`]);
  if (classifierExit === 2) {
    console.log("Ranker pipeline status: SKIPPED_VERIFICATION_INSUFFICIENT");
    process.exitCode = 0;
  } else if (classifierExit !== 0) {
    process.exitCode = classifierExit;
  } else {
    process.exitCode = await run("scripts/ranker-replay-test.ts", []);
  }
}

main().catch((error: unknown) => { const summary = errorSummary(error); console.error(`Ranker pipeline failed closed: ${summary.code} — ${summary.message}`); process.exitCode = 1; });
