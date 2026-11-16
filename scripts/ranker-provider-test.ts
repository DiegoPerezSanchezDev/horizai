import nextEnv from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import { MissingAgentConfigurationError, errorSummary } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createConfiguredRanker, getRankerModelConfig } from "../lib/agents/ranker/ranker-agent.ts";
import { rankerFixtures } from "../lib/agents/ranker/ranker-fixtures.ts";
import { calculateImportanceScore } from "../lib/agents/contracts/index.ts";

nextEnv.loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const missing = ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_RANK"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const config = { ...getRankerModelConfig(), maxRetries: 0 };
  const logger = new SupabaseAgentLogger();
  const availability = await logger.getRemainingRequests(config.dailyRequestLimit, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 1) throw new Error("Insufficient daily requests for isolated Ranker provider test");
  const fixture = rankerFixtures[0];
  const result = await createConfiguredRanker(logger).rank(fixture.input, { modelConfig: config, dryRun: true });
  const recomputedImportanceScore = calculateImportanceScore({
    impact: result.output.impact,
    novelty: result.output.novelty,
    reach: result.output.reach,
    credibility: result.output.credibility,
    economicImpact: result.output.economicImpact,
    momentum: result.output.momentum,
  });
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/ranker-provider-report.json", `${JSON.stringify({
    status: "success",
    eventKey: result.output.eventKey,
    agentVersion: result.agentVersion,
    model: result.model,
    rankingResult: result.output,
    semanticDimensions: { impact: result.output.impact, novelty: result.output.novelty, economicImpact: result.output.economicImpact },
    deterministicSignals: result.signals,
    importanceScore: result.output.importanceScore,
    recomputation: { recomputedImportanceScore, matches: result.output.importanceScore === recomputedImportanceScore },
    guardrails: { rejectedCapActivated: false, rumorCapActivated: false, singleSourceHardCapActivated: false },
    formulaVersion: result.formulaVersion,
    telemetry: result.telemetry,
    attempts: result.attempts,
    retries: Math.max(0, result.attempts - 1),
  }, null, 2)}\n`, "utf8");
  console.log(`Ranker provider test prepared result: ${result.output.importanceScore}`);
}

main().catch((error: unknown) => { const summary = errorSummary(error); console.error(`Ranker provider test failed closed: ${summary.code} — ${summary.message}`); process.exitCode = 1; });
