import nextEnv from "@next/env";
import { errorSummary, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { readSafeClassifierPipelineCheckpoint } from "../lib/agents/classifier/classifier-pipeline-checkpoint.ts";
import { createConfiguredRanker, getRankerModelConfig } from "../lib/agents/ranker/ranker-agent.ts";
import { buildRankerInput } from "../lib/agents/ranker/ranker-input.ts";
import { readSafeEditorPipelineCheckpoint } from "../lib/agents/classifier/classifier-checkpoint.ts";
import { loadActiveReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { projectClassificationGeo } from "../lib/agents/classifier/geo-resolver.ts";
import { buildRankerPipelineCheckpoint, writeRankerPipelineCheckpointAtomic } from "../lib/agents/critic/ranker-pipeline-checkpoint.ts";

nextEnv.loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const missing = ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_RANK"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const checkpoint = await readSafeClassifierPipelineCheckpoint();
  const input = buildRankerInput({ event: { eventKey: checkpoint.eventKey, canonicalTitle: checkpoint.canonicalTitle, occurredAt: checkpoint.event.occurredAt, sourceItems: Array.from({ length: checkpoint.event.sourceCount }, () => ({ publishedAt: checkpoint.event.latestPublishedAt })) }, verification: checkpoint.verification, translation: checkpoint.translation, editorial: checkpoint.editorial, classification: checkpoint.classification });
  const config = { ...getRankerModelConfig(), maxRetries: 0 };
  const result = await createConfiguredRanker(new SupabaseAgentLogger()).rank(input, { modelConfig: config, dryRun: true });
  const editorCheckpoint = await readSafeEditorPipelineCheckpoint();
  if (editorCheckpoint.eventKey !== checkpoint.eventKey) throw new Error("Ranker replay cannot build a checkpoint from a different editor lineage");
  const registry = await loadActiveReferenceRegistry();
  const projection = projectClassificationGeo(checkpoint.classification, registry);
  const rankerCheckpoint = buildRankerPipelineCheckpoint({
    schemaVersion: 1,
    event: input.event,
    verification: checkpoint.verification,
    translation: editorCheckpoint.translation,
    editorial: editorCheckpoint.editorial,
    classification: projection.classification,
    sources: checkpoint.sources,
    sourceEvidence: [],
    geo: projection.geo,
  }, {
    result: result.output,
    formulaVersion: result.formulaVersion,
    momentumAvailable: result.signals.momentumAvailable,
    deterministicSignals: {
      credibility: result.signals.credibility,
      reach: result.signals.reach,
      momentum: result.signals.momentum,
      sourceCount: result.signals.sourceCount,
      contradictionPenalty: result.signals.contradictionPenalty,
      uncertaintyPenalty: result.signals.uncertaintyPenalty,
      geographicReachSignal: result.signals.geographicReachSignal,
    },
  });
  const checkpointPath = await writeRankerPipelineCheckpointAtomic(rankerCheckpoint);
  console.log(JSON.stringify({ status: "SUCCESS", eventKey: result.output.eventKey, agentVersion: result.agentVersion, model: result.model, semanticDimensions: { impact: result.output.impact, novelty: result.output.novelty, economicImpact: result.output.economicImpact }, deterministicSignals: result.signals, rankingResult: { reach: result.output.reach, credibility: result.output.credibility, momentum: result.output.momentum, importanceScore: result.output.importanceScore }, formulaVersion: result.formulaVersion, telemetry: result.telemetry, attempts: result.attempts, retries: Math.max(0, result.attempts - 1), checkpoint: checkpointPath }, null, 2));
}

main().catch((error: unknown) => { const summary = errorSummary(error); console.error(`Ranker replay failed closed: ${summary.code} — ${summary.message}`); process.exitCode = 1; });
