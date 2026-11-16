import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { parsePipelineCliArgs, printPipelineCliDiagnostics } from "../lib/agents/pipeline/pipeline-cli.ts";

async function main(): Promise<void> {
  const cli = parsePipelineCliArgs(["--preflight-only", ...process.argv.slice(2)]);
  printPipelineCliDiagnostics(cli);
  const pipeline = createProductionPipeline({ config: { hours: cli.hours ?? 24, limit: cli.limit ?? 1, dryRun: true, publish: false, trigger: "manual" } });
  const preflight = await pipeline.preflight();
  if (preflight.provider.toLowerCase() !== "groq") throw new Error("Pipeline preflight requires AGENT_PROVIDER=groq");
  if (Object.values(preflight.maxRetries).some((value) => value !== 0)) throw new Error("Pipeline preflight requires maxRetries=0 for every model stage");
  if (preflight.quotaRemaining < preflight.requiredRequests) throw new Error(`Insufficient persistent quota: ${preflight.quotaRemaining} remaining, ${preflight.requiredRequests} required`);
  console.log("Provider execution allowed: NO");
  console.log(`Quota provider: ${preflight.quotaProvider}`);
  console.log(`Supabase connected: ${preflight.supabaseConnected}`);
  for (const [stage, retries] of Object.entries(preflight.maxRetries)) console.log(`${stage}: maxRetries=${retries}`);
  console.log(`Groq request budget: ${preflight.quotaRemaining}/${preflight.dailyRequestLimit} remaining`);
  console.log(`Worst-case required=${preflight.requiredRequests}`);
  console.log(`Budget available: ${preflight.quotaRemaining >= preflight.requiredRequests}`);
  console.log("Groq calls=0");
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Pipeline preflight failed"); process.exitCode = 1; });
