import nextEnv from "@next/env";
import { runDiscovery } from "../lib/agents/discovery/discovery-runner.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function parseArgs(args: string[]): { hours: number; persist: boolean } {
  let hours = Number(process.env.npm_config_hours ?? process.env.NPM_CONFIG_HOURS ?? 24);
  let persist = process.env.npm_config_persist === "true" || process.env.NPM_CONFIG_PERSIST === "true";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (argument === "--persist") {
      persist = true;
      continue;
    }
    if (argument === "--hours") {
      const value = args[index + 1];
      if (!value) throw new Error("--hours requires a number");
      hours = Number(value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--hours=")) {
      hours = Number(argument.slice("--hours=".length));
      continue;
    }
    if (argument === "--help") {
      console.log("Usage: npm run discovery:test -- [--hours=24] [--persist]");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error("hours must be greater than 0 and no more than 168");
  }
  return { hours, persist };
}

function statusIcon(status: string): string {
  if (status === "success") return "✓";
  if (status === "empty") return "–";
  return "✗";
}

async function main(): Promise<void> {
  const { hours, persist } = parseArgs(process.argv.slice(2));
  const result = await runDiscovery({ hours, persist });
  console.log("HorizAI Discovery");
  console.log(`Window: last ${hours}h`);
  console.log(`Sources active: ${result.sources.length}`);
  for (const source of result.sources) {
    const detail = source.error ? ` ${source.error.code}: ${source.error.message}` : "";
    console.log(`${statusIcon(source.status)} ${source.source.name} ${source.valid} candidates${detail}`);
  }
  console.log(`Candidates discovered: ${result.candidatesDiscovered}`);
  console.log(`Duplicate URLs: ${result.duplicateUrls}`);
  console.log(`Duplicate content hashes: ${result.duplicateContentHashes}`);
  console.log(`Valid candidates after dedupe: ${result.candidates.length}`);
  console.log(`Invalid candidates: ${result.invalidCandidates}`);
  console.log(`Undated excluded: ${result.undatedExcluded}`);
  console.log(`Persisted: ${result.persisted}${persist ? "" : " (dry-run)"}`);
  console.log(`Persist skipped: ${result.persistSkipped}`);
  console.log(`Persist errors: ${result.persistErrors}`);
  console.log("Sample candidates:");
  for (const candidate of result.candidates.slice(0, 8)) {
    console.log(`- [${candidate.sourceName}] ${candidate.titleOriginal.slice(0, 140)} — ${candidate.url}`);
  }
  console.log(`Duration: ${Date.parse(result.finishedAt) - Date.parse(result.startedAt)} ms`);
}

main().catch((error: unknown) => {
  console.error(`Discovery test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
