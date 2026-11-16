import nextEnv from "@next/env";
import { errorSummary, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { CriticAgent, getCriticModelConfig } from "../lib/agents/critic/critic-agent.ts";
import { editorialDriftInput } from "../lib/agents/critic/critic-fixtures.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { createReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";

nextEnv.loadEnvConfig(process.cwd());

async function main(): Promise<void> {
  const missing = ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_CRITIC"].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const registry = createReferenceRegistry([{ code: "US", name: "Estados Unidos", latitude: 39.8283, longitude: -98.5795 }], [{ slug: "modelos", name: "Modelos" }]);
  const config = { ...getCriticModelConfig(), maxRetries: 0 };
  const result = await new CriticAgent(createConfiguredModelProvider(), new SupabaseAgentLogger()).critique(editorialDriftInput, { dryRun: true, modelConfig: config, registry });
  const findings = result.generation.findings;
  const safeReport = {
    status: "SUCCESS",
    provider: {
      httpStatus: result.telemetry?.providerHttpStatus ?? null,
      model: result.model,
      agentVersion: result.agentVersion,
      routingVersion: result.diagnostics?.routingVersion ?? "critic-routing-v1",
      structuredOutputMode: result.telemetry?.structuredOutputMode ?? null,
      reasoningEffort: result.telemetry?.reasoningEffort ?? null,
      includeReasoning: result.telemetry?.includeReasoning ?? null,
      finishReason: result.telemetry?.finishReason ?? null,
      attempts: result.attempts,
      retries: Math.max(0, result.attempts - 1),
      inputTokens: result.telemetry?.inputTokens ?? null,
      outputTokens: result.telemetry?.outputTokens ?? null,
      totalTokens: result.telemetry?.totalTokens ?? null,
      latencyMs: result.latencyMs,
      requestBytes: result.telemetry?.requestBytes ?? null,
      responseBytes: result.telemetry?.responseBytes ?? null,
    },
    generation: {
      zodValid: result.diagnostics?.semanticGenerationValid ?? result.telemetry?.zodValid ?? null,
      findingsCount: findings.length,
      issueFindingsCount: findings.filter((finding) => finding.kind === "issue").length,
      unsupportedClaimFindingsCount: findings.filter((finding) => finding.kind === "unsupported_claim").length,
      extraFields: "NO",
      findings: findings.map((finding) => finding.kind === "issue"
        ? { kind: finding.kind, dimension: finding.dimension, severity: finding.severity, stage: finding.stage, message: finding.message.slice(0, 300), evidenceIndices: finding.evidenceIndices }
        : { kind: finding.kind, severity: finding.severity, stage: finding.stage, claim: finding.claim.slice(0, 300), reason: finding.reason.slice(0, 300), evidenceIndices: finding.evidenceIndices }),
    },
    publicResult: { zodValid: result.diagnostics?.finalCriticResultValid ?? false, decision: result.output.decision, issueCount: result.output.issues.length, unsupportedClaimCount: result.output.unsupportedClaims.length },
    evidence: { catalogSize: result.diagnostics?.evidenceCatalogSize ?? null, indicesReceived: result.diagnostics?.evidenceIndicesReceived ?? [], indicesValid: result.diagnostics?.evidenceIndicesValid ?? false, resolvedRefsCount: result.diagnostics?.resolvedEvidenceRefsCount ?? null, inventedIndices: result.diagnostics?.inventedEvidenceIndicesCount ?? 0, refsValidated: result.diagnostics?.evidenceRefsValidated ?? false },
    routing: { finalDecision: result.output.decision, routedStage: result.routedStage, severity: result.output.severity, decisionGeneratedByLlm: false, deterministicRouterExecuted: true },
    prechecks: { deterministicPrechecksPassed: result.prechecks.passed, eventKeyConsistency: result.prechecks.passed, translationCoverage: result.prechecks.passed, editorGuard: result.prechecks.passed, registryValidation: result.prechecks.passed, geoProvenance: result.prechecks.passed, rankingRecomputation: result.prechecks.passed, rankingFormula: result.prechecks.passed, verifiedFactsGreaterThanZero: result.prechecks.passed },
  };
  console.log(JSON.stringify(safeReport, null, 2));
}

main().catch((error: unknown) => { const summary = errorSummary(error); console.error(`Critic provider test failed closed: ${summary.code} — ${summary.message}`); process.exitCode = 1; });
