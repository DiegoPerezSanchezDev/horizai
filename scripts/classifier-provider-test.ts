import { mkdir, writeFile } from "node:fs/promises";
import { errorSummary, getAgentFailureDetails, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createConfiguredClassifier, getClassifierModelConfig } from "../lib/agents/classifier/classifier-agent.ts";
import { classifierFixtures } from "../lib/agents/classifier/classifier-fixtures.ts";
import { loadActiveReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";

function missingConfiguration(): string[] {
  return ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_CLASSIFY"].filter((name) => !process.env[name]?.trim());
}

async function main(): Promise<void> {
  const missing = missingConfiguration();
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const config = { ...getClassifierModelConfig(), maxRetries: 0 };
  const logger = new SupabaseAgentLogger();
  const availability = await logger.getRemainingRequests(config.dailyRequestLimit, new Date().toISOString().slice(0, 10));
  if (availability.remaining < 1) throw new Error("Insufficient daily requests for isolated Classifier provider test");
  const fixture = classifierFixtures[0];
  const result = await createConfiguredClassifier(logger).classify(fixture.input, { modelConfig: config, dryRun: true, registry: await loadActiveReferenceRegistry() });
  const report = {
    status: "success",
    eventKey: result.output.eventKey,
    agentVersion: result.agentVersion,
    model: result.model,
    primaryRegionCode: result.output.primaryRegionCode,
    countryCodes: result.output.countryCodes,
    categorySlugs: result.output.categorySlugs,
    entities: { companies: result.output.companies, models: result.output.models, people: result.output.people, technologies: result.output.technologies },
    geo: result.geo,
    telemetry: result.telemetry,
    attempts: result.attempts,
    retries: Math.max(0, result.attempts - 1),
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/classifier-provider-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Classifier provider test prepared result: ${result.output.primaryRegionCode ?? "unresolved"}`);
}

main().catch((error: unknown) => {
  const summary = errorSummary(error);
  const details = getAgentFailureDetails(error);
  console.error(`Classifier provider test failed closed: ${summary.code} — ${summary.message}`);
  if (details.attempts > 0) console.error(`Attempts: ${details.attempts}`);
  process.exitCode = 1;
});
