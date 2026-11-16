import { mkdir, writeFile } from "node:fs/promises";
import { runExtraction } from "../lib/agents/extraction/extraction-runner.ts";
import { clusterExtractedItems } from "../lib/agents/clustering/cluster-runner.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { errorSummary, getAgentFailureDetails, getProviderDiagnostics, MissingAgentConfigurationError } from "../lib/agents/runtime/agent-errors.ts";
import { createConfiguredVerifier } from "../lib/agents/verifier/verifier-agent.ts";
import type { VerifierInput } from "../lib/agents/verifier/verifier-types.ts";
import type { AgentExecutionResult, AgentUsage, ProviderDiagnostics, RequestMetrics } from "../lib/agents/runtime/runtime-types.ts";
import type { VerificationResult } from "../lib/agents/contracts/index.ts";
import { parseVerifierCliOptions } from "../lib/agents/verifier/verifier-cli-options.ts";

type ReportEntry = {
  inputs: {
    eventKey: string;
    canonicalTitle: string;
    sourceCount: number;
    sourceNames: string[];
    candidateIds: string[];
    titles: string[];
  };
  status: VerificationResult["status"] | "failed";
  confidence: number | null;
  verifiedFactsCount: number;
  uncertainClaimsCount: number;
  contradictionsCount: number;
  reasonChars: number;
  agentVersion: string;
  model: string;
  attempts: number;
  latencyMs: number | null;
  tokenUsage?: AgentUsage;
  requestMetrics?: RequestMetrics;
  providerDiagnostics?: ProviderDiagnostics;
  error?: { code: string; message: string; providerMessage?: string | null };
};

type RunReport = {
  generatedAt: string;
  dryRun: true;
  hours: number;
  limit: number;
  eventsConsidered: number;
  eventsSent: number;
  events: ReportEntry[];
  summary?: {
    confirmed: number;
    singleSource: number;
    developing: number;
    rumor: number;
    rejected: number;
    failed: number;
    averageConfidence: number;
    retries: number;
    inputTokens: number;
    outputTokens: number;
  };
};

function missingConfiguration(): string[] {
  return ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "AGENT_MODEL_VERIFY"].filter((name) => !process.env[name]?.trim());
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function makeVerifierInput(event: VerifierInput["event"], items: VerifierInput["items"]): VerifierInput {
  return {
    event,
    items,
    sources: event.sourceItems.map((sourceItem) => {
      const item = items.find((candidate) => candidate.candidateId === sourceItem.candidateId);
      const metadata = item?.metadata ?? {};
      return {
        sourceId: sourceItem.sourceId,
        sourceName: sourceItem.sourceName,
        sourceUrl: sourceItem.url,
        sourceType: stringMetadata(metadata.sourceType),
        countryCode: stringMetadata(metadata.sourceCountryCode),
        language: item?.language ?? null,
      };
    }),
  };
}

function reportEntry(input: VerifierInput, result: AgentExecutionResult<VerificationResult>): ReportEntry {
  return {
    inputs: {
      eventKey: input.event.eventKey,
      canonicalTitle: input.event.canonicalTitle,
      sourceCount: input.event.sourceItems.length,
      sourceNames: input.event.sourceItems.map((source) => source.sourceName),
      candidateIds: input.event.sourceItems.map((source) => source.candidateId),
      titles: input.event.sourceItems.map((source) => source.title),
    },
    status: result.output.status,
    confidence: result.output.confidenceScore,
    verifiedFactsCount: result.output.verifiedFacts.length,
    uncertainClaimsCount: result.output.uncertainClaims.length,
    contradictionsCount: result.output.contradictions.length,
    reasonChars: result.output.reason.length,
    agentVersion: result.agentVersion,
    model: result.model,
    attempts: result.attempts,
    latencyMs: result.latencyMs,
    tokenUsage: result.usage,
    requestMetrics: result.diagnostics?.requestMetrics,
    providerDiagnostics: result.diagnostics,
  };
}

async function main(): Promise<void> {
  const missing = missingConfiguration();
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const { hours, limit } = parseVerifierCliOptions(process.argv);
  const verifier = createConfiguredVerifier(new SupabaseAgentLogger());
  const extraction = await runExtraction({ hours, limit, persist: false });
  const extractedItems = extraction.results.flatMap((result) => result.item ? [result.item] : []);
  const clustered = clusterExtractedItems(extractedItems);
  const events = clustered.events.slice(0, limit);
  const itemsByCandidate = new Map(extractedItems.map((item) => [item.candidateId, item]));
  const report: RunReport = { generatedAt: new Date().toISOString(), dryRun: true, hours, limit, eventsConsidered: events.length, eventsSent: 0, events: [] };
  const counts: Record<string, number> = { confirmed: 0, single_source: 0, developing: 0, rumor: 0, rejected: 0 };
  let failures = 0;
  let retries = 0;

  for (const event of events) {
    const items = event.sourceItems.flatMap((source) => {
      const item = itemsByCandidate.get(source.candidateId);
      return item ? [item] : [];
    });
    const input = makeVerifierInput(event, items);
    try {
      const result = await verifier.verify(input, { dryRun: true });
      report.events.push(reportEntry(input, result));
      counts[result.output.status] += 1;
      retries += Math.max(0, result.attempts - 1);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : "Unknown verifier error";
      const details = getAgentFailureDetails(error);
      const summary = errorSummary(error);
      const providerDiagnostics = details.diagnostics ?? getProviderDiagnostics(error);
      report.events.push({
        inputs: {
          eventKey: event.eventKey,
          canonicalTitle: event.canonicalTitle,
          sourceCount: event.sourceItems.length,
          sourceNames: event.sourceItems.map((source) => source.sourceName),
          candidateIds: event.sourceItems.map((source) => source.candidateId),
          titles: event.sourceItems.map((source) => source.title),
        },
        status: "failed",
        confidence: null,
        verifiedFactsCount: 0,
        uncertainClaimsCount: 0,
        contradictionsCount: 0,
        reasonChars: 0,
        agentVersion: "verifier-v1",
        model: process.env.AGENT_MODEL_VERIFY?.trim() ?? "unconfigured",
        attempts: details.attempts,
        latencyMs: details.latencyMs,
        requestMetrics: providerDiagnostics?.requestMetrics,
        providerDiagnostics,
        error: { code: summary.code, message, providerMessage: providerDiagnostics?.providerMessage },
      });
      if (summary.code === "FREE_TIER_LIMIT_REACHED" || summary.code === "DAILY_REQUEST_LIMIT_REACHED") break;
    }
  }

  const successful = report.events.filter((event) => event.status !== "failed");
  const averageConfidence = successful.length === 0 ? 0 : Math.round(successful.reduce((sum, event) => sum + (event.confidence ?? 0), 0) / successful.length);
  const inputTokens = report.events.reduce((sum, event) => sum + (event.tokenUsage?.inputTokens ?? 0), 0);
  const outputTokens = report.events.reduce((sum, event) => sum + (event.tokenUsage?.outputTokens ?? 0), 0);
  report.summary = {
    confirmed: counts.confirmed,
    singleSource: counts.single_source,
    developing: counts.developing,
    rumor: counts.rumor,
    rejected: counts.rejected,
    failed: failures,
    averageConfidence,
    retries,
    inputTokens,
    outputTokens,
  };
  report.eventsSent = report.events.length;
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/verifier-report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("HorizAI Verifier");
  console.log("--------------------------------");
  console.log(`Events considered: ${events.length}`);
  console.log(`Events sent to model: ${report.eventsSent}`);
  console.log(`✓ confirmed       ${counts.confirmed}`);
  console.log(`~ single_source   ${counts.single_source}`);
  console.log(`? developing      ${counts.developing}`);
  console.log(`! rumor           ${counts.rumor}`);
  console.log(`✗ rejected        ${counts.rejected}`);
  console.log(`Avg confidence: ${averageConfidence}`);
  console.log(`Agent failures: ${failures}`);
  console.log(`Retries: ${retries}`);
  console.log(`Input tokens: ${inputTokens}`);
  console.log(`Output tokens: ${outputTokens}`);
  console.log("--------------------------------");
  for (const event of report.events) {
    if (event.status === "failed") {
    console.log(`[failed] ${event.inputs.canonicalTitle}`);
      console.log(`Error: ${event.error?.code ?? "unknown"} — ${event.error?.message ?? "unknown"}`);
      if (event.error?.providerMessage) console.log(`Provider message: ${event.error.providerMessage}`);
      console.log(`Attempts: ${event.attempts} | Retries: ${Math.max(0, event.attempts - 1)} | Latency: ${event.latencyMs ?? 0} ms`);
      if (event.requestMetrics) console.log(`Body: ${event.requestMetrics.bodyBytes ?? 0} bytes | Input: ${event.requestMetrics.inputChars} chars`);
      continue;
    }
    console.log(`[${event.status} | ${event.confidence}] ${event.inputs.canonicalTitle}`);
    console.log(`Sources: ${event.inputs.sourceCount}`);
    console.log(`Verified facts: ${event.verifiedFactsCount}`);
    console.log(`Uncertain claims: ${event.uncertainClaimsCount}`);
    console.log(`Attempts: ${event.attempts} | Retries: ${Math.max(0, event.attempts - 1)} | Latency: ${event.latencyMs} ms`);
    console.log(`Input tokens: ${event.tokenUsage?.inputTokens ?? 0} | Output tokens: ${event.tokenUsage?.outputTokens ?? 0}`);
    console.log(`Input: ${event.requestMetrics?.inputChars ?? 0} chars | Body: ${event.requestMetrics?.bodyBytes ?? 0} bytes | Truncated: ${event.requestMetrics?.truncated.some(Boolean) ?? false}`);
  }
  if (failures > 0) throw new Error(`${failures} verifier event(s) failed; fail closed`);
}

main().catch((error: unknown) => {
  if (error instanceof MissingAgentConfigurationError) {
    console.error(`Verifier real run not executed. Missing variables: ${error.missingVariables.join(", ")}`);
  } else {
    console.error(error instanceof Error ? error.message : "Verifier test failed");
  }
  process.exitCode = 1;
});
