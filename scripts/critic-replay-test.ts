import nextEnv from "@next/env";
import { join } from "node:path";
import { errorSummary, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { createConfiguredCritic, getCriticModelConfig } from "../lib/agents/critic/critic-agent.ts";
import { readSafeRankerPipelineCheckpoint } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";
import { buildCriticPipelineCheckpoint, writeCriticPipelineCheckpointAtomic } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { loadActiveReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { projectClassificationGeo } from "../lib/agents/classifier/geo-resolver.ts";

nextEnv.loadEnvConfig(process.cwd());

function requiredArgument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length).trim();
  if (!value || value.includes("..") || value.includes("/") || value.includes("\\")) {
    throw new Error(`Missing or invalid required argument: --${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const missing = ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_CRITIC"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const runId = requiredArgument("run-id");
  const eventKey = requiredArgument("event-key");
  const stage = requiredArgument("stage");
  if (stage !== "ranker") throw new Error("Only --stage=ranker is supported by this replay");
  const checkpointPath = join("artifacts", "pipeline-checkpoints", runId, `${stage}-${eventKey}.json`);
  const checkpoint = await readSafeRankerPipelineCheckpoint(checkpointPath);
  const registry = await loadActiveReferenceRegistry();
  const projection = projectClassificationGeo(checkpoint.classification, registry);
  const projectedCheckpoint = { ...checkpoint, classification: projection.classification, geo: projection.geo };
  const input = { schemaVersion: projectedCheckpoint.schemaVersion, event: projectedCheckpoint.event, verification: projectedCheckpoint.verification, translation: projectedCheckpoint.translation, editorial: projectedCheckpoint.editorial, classification: projectedCheckpoint.classification, ranking: projectedCheckpoint.ranking, sources: projectedCheckpoint.sources, sourceEvidence: projectedCheckpoint.sourceEvidence, geo: projectedCheckpoint.geo };
  const result = await createConfiguredCritic(new SupabaseAgentLogger()).critique(input, { dryRun: true, registry, modelConfig: { ...getCriticModelConfig(), maxRetries: 0 } });
  const criticCheckpointPath = join("artifacts", "pipeline-checkpoints", runId, `critic-${eventKey}.json`);
  const writtenCriticCheckpointPath = await writeCriticPipelineCheckpointAtomic(buildCriticPipelineCheckpoint(projectedCheckpoint, result.output), criticCheckpointPath);
  console.log(JSON.stringify({ status: "SUCCESS", runId, checkpointPath, eventKey: result.output.eventKey, decision: result.output.decision, severity: result.output.severity, routedStage: result.routedStage, findings: result.output.issues.length, unsupportedClaims: result.output.unsupportedClaims.length, agentVersion: result.agentVersion, model: result.model, telemetry: result.telemetry, prechecks: result.prechecks, criticCheckpoint: writtenCriticCheckpointPath }, null, 2));
}

main().catch((error: unknown) => { const summary = errorSummary(error); console.error(`Critic replay failed closed: ${summary.code} — ${summary.message}`); process.exitCode = 1; });
