import nextEnv from "@next/env";
import { runExtraction } from "../lib/agents/extraction/extraction-runner.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function parseArgs(args: string[]): { hours: number; limit: number; persist: boolean } {
  let hours = Number(process.env.npm_config_hours ?? process.env.NPM_CONFIG_HOURS ?? 24);
  let limit = Number(process.env.npm_config_limit ?? process.env.NPM_CONFIG_LIMIT ?? 20);
  let persist = process.env.npm_config_persist === "true" || process.env.NPM_CONFIG_PERSIST === "true";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--persist") {
      persist = true;
      continue;
    }
    if (argument === "--hours" || argument === "--limit") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a number`);
      if (argument === "--hours") hours = Number(value);
      else limit = Number(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--hours=")) {
      hours = Number(argument.slice("--hours=".length));
      continue;
    }
    if (argument.startsWith("--limit=")) {
      limit = Number(argument.slice("--limit=".length));
      continue;
    }
    if (argument === "--help") {
      console.log("Usage: npm run extraction:test -- [--hours=24] [--limit=20] [--persist]");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("hours must be greater than 0 and no more than 168");
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) throw new Error("limit must be an integer between 1 and 100");
  return { hours, limit, persist };
}

function qualityLabel(result: { status: string; quality: string; error?: { code: string } | null }): string {
  if (result.status === "blocked") return "blocked";
  if (result.status === "failed") return result.error?.code ?? "failed";
  return result.quality;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runExtraction({ ...options, persist: options.persist });
  console.log("HorizAI Extraction");
  console.log("--------------------------------");
  console.log(`Candidates selected: ${result.candidatesSelected}`);
  for (const extracted of result.results) {
    const suffix = extracted.status === "success" ? `${extracted.contentLength.toLocaleString("en-US")} chars` : extracted.error?.message ?? "failed";
    console.log(`${extracted.status === "success" ? "✓" : extracted.status === "blocked" ? "!" : "✗"} ${extracted.candidate.sourceName} ${qualityLabel(extracted)} ${suffix}`);
  }
  console.log("--------------------------------");
  console.log(`Full: ${result.full}`);
  console.log(`Partial: ${result.partial}`);
  console.log(`Metadata only: ${result.metadataOnly}`);
  console.log(`Blocked: ${result.blocked}`);
  console.log(`Failed: ${result.failed}`);
  console.log(`Avg content: ${result.averageContentLength.toLocaleString("en-US")} chars`);
  console.log(`Persisted: ${result.persisted}${options.persist ? "" : " (dry-run)"}`);
  console.log(`Persist skipped: ${result.persistSkipped}`);
  console.log(`Persist errors: ${result.persistErrors}`);
  console.log(`Duration: ${Date.parse(result.finishedAt) - Date.parse(result.startedAt)} ms`);
}

main().catch((error: unknown) => {
  console.error(`Extraction test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
