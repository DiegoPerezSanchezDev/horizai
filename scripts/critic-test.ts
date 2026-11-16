import nextEnv from "@next/env";
import { spawn } from "node:child_process";
import { errorSummary, AgentError, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { getCriticModelConfig } from "../lib/agents/critic/critic-agent.ts";
import { getVerifierModelConfig } from "../lib/agents/verifier/verifier-agent.ts";
import { getTranslatorModelConfig } from "../lib/agents/translator/translator-agent.ts";
import { getEditorV2ModelConfig } from "../lib/agents/editor/editor-v2-agent.ts";
import { getClassifierModelConfig } from "../lib/agents/classifier/classifier-agent.ts";
import { getRankerModelConfig } from "../lib/agents/ranker/ranker-agent.ts";
import { parseVerifierCliOptions } from "../lib/agents/verifier/verifier-cli-options.ts";

nextEnv.loadEnvConfig(process.cwd());

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", command, ...args], { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const missing = ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_VERIFY", "AGENT_MODEL_TRANSLATE", "AGENT_MODEL_EDITOR", "AGENT_MODEL_CLASSIFY", "AGENT_MODEL_RANK", "AGENT_MODEL_CRITIC"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const { hours, limit } = parseVerifierCliOptions(process.argv);
  const configs = [getVerifierModelConfig(), getTranslatorModelConfig(), getEditorV2ModelConfig(), getClassifierModelConfig(), getRankerModelConfig(), getCriticModelConfig()];
  if (configs.some((config) => config.maxRetries !== 0)) throw new AgentError("cost_guard_violation", "Critic E2E requires maxRetries=0 for all six stages");
  const availability = await new SupabaseAgentLogger().getRemainingRequests(20, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 6) throw new AgentError("DAILY_REQUEST_LIMIT_REACHED", "Critic E2E requires six reserved requests");
  const rankerExit = await run("scripts/ranker-test.ts", [`--hours=${hours}`, `--limit=${limit}`]);
  if (rankerExit === 2) {
    console.log("Critic pipeline status: SKIPPED_VERIFICATION_INSUFFICIENT");
    return;
  }
  if (rankerExit !== 0) {
    process.exitCode = rankerExit;
    return;
  }
  process.exitCode = await run("scripts/critic-replay-test.ts", []);
}

main().catch((error: unknown) => { const summary = errorSummary(error); console.error(`Critic pipeline failed closed: ${summary.code} — ${summary.message}`); process.exitCode = 1; });
