import { readSafeTranslatorCheckpoint } from "../lib/agents/translator/translator-checkpoint.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { TranslatorAgent, getTranslatorModelConfig } from "../lib/agents/translator/translator-agent.ts";
import { errorSummary } from "../lib/agents/runtime/agent-errors.ts";

async function main(): Promise<void> {
  const checkpoint = await readSafeTranslatorCheckpoint();
  const translatorInput = {
    schemaVersion: 1 as const,
    event: checkpoint.event,
    verification: checkpoint.verification,
    sourceLanguage: checkpoint.sourceLanguage,
    sources: checkpoint.sources,
  };
  const config = getTranslatorModelConfig();
  const result = await new TranslatorAgent(createConfiguredModelProvider(), new SupabaseAgentLogger()).translate(translatorInput, {
    dryRun: true,
    modelConfig: { ...config, maxRetries: 0 },
  });
  console.log(`Translator replay succeeded: ${result.output.translatedTitle}`);
  console.log(`Attempts: ${result.attempts} | Retries: ${Math.max(0, result.attempts - 1)}`);
}

main().catch((error: unknown) => {
  const summary = errorSummary(error);
  console.error(`Translator replay failed closed: ${summary.code} — ${summary.message}`);
  process.exitCode = 1;
});
