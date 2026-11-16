import { validateSupervisedCloudflareStageValidation } from "../lib/agents/runtime/cloudflare-stage-validation.ts";

function parseArguments(args: string[]): { stage: string; fixture: string; provider: string; model: string } {
  const parsed: Record<string, string> = {};
  for (const arg of args) {
    if (arg === "--execute") throw new Error("INFERENCE_DISABLED_IN_10G5");
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error("BLOCKED_INVALID_ARGUMENTS");
    const [, name, value] = match;
    if (!("stage fixture provider model".split(" ")).includes(name) || parsed[name]) throw new Error("BLOCKED_UNKNOWN_OR_DUPLICATE_ARGUMENT");
    parsed[name] = value;
  }
  const { stage, fixture, provider, model } = parsed;
  if (!stage || !fixture || !provider || !model) throw new Error("BLOCKED_MISSING_ARGUMENT");
  return { stage, fixture, provider, model };
}

try {
  const args = parseArguments(process.argv.slice(2));
  const plan = validateSupervisedCloudflareStageValidation(args);
  process.stdout.write(`${JSON.stringify({ ...plan, execution: "PLAN_ONLY_IN_10G5", inferenceEnabled: false })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "BLOCKED_VALIDATION_ARGUMENTS";
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}
