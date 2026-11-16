import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
import { runClustering } from "../lib/agents/clustering/cluster-runner.ts";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function parseArgs(args: string[]): { hours: number; limit: number; persist: boolean } {
  let hours = Number(process.env.npm_config_hours ?? process.env.NPM_CONFIG_HOURS ?? 24);
  let limit = Number(process.env.npm_config_limit ?? process.env.NPM_CONFIG_LIMIT ?? 50);
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
      console.log("Usage: npm run cluster:test -- [--hours=24] [--limit=50] [--persist]");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) throw new Error("hours must be greater than 0 and no more than 168");
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) throw new Error("limit must be an integer between 1 and 100");
  return { hours, limit, persist };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runClustering({ ...options });
  const reportPath = path.join(process.cwd(), "artifacts", "cluster-report.json");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");

  console.log("HorizAI Event Clustering");
  console.log("--------------------------------");
  console.log(`Extracted items: ${result.extractedItems}`);
  console.log(`Events created: ${result.events.length}`);
  console.log(`Multi-source events: ${result.multiSourceEvents}`);
  console.log(`Single-source events: ${result.singleSourceEvents}`);
  console.log(`Largest cluster: ${result.largestCluster} sources`);
  console.log(`Needs review cases: ${result.needsReview}`);
  console.log(`Possible false merges: ${result.possibleFalseMerges.length}`);
  console.log(`Report: ${reportPath}`);
  console.log("--------------------------------");
  for (const event of [...result.events].sort((left, right) => new Set(right.sourceItems.map((item) => item.sourceId)).size - new Set(left.sourceItems.map((item) => item.sourceId)).size || right.clusterConfidence - left.clusterConfidence).slice(0, 8)) {
    const sourceCount = new Set(event.sourceItems.map((item) => item.sourceId)).size;
    console.log(`[${sourceCount} source${sourceCount === 1 ? "" : "s"} | ${event.clusterConfidence.toFixed(1)}%] ${event.canonicalTitle}`);
    for (const source of event.sourceItems.slice(0, 5)) console.log(`- ${source.sourceName}`);
  }
  console.log(`Persisted events: ${result.persistedEvents}${options.persist ? "" : " (dry-run)"}`);
  console.log(`Persisted event_sources: ${result.persistedEventSources}`);
  console.log(`Persist skipped: ${result.persistSkipped}`);
  console.log(`Persist errors: ${result.persistErrors}`);
}

main().catch((error: unknown) => {
  console.error(`Cluster test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
