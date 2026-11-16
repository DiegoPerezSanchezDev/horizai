export type PipelineExecutionMode = "preflight" | "execute";

export type PipelineCliOptions = {
  executionMode: PipelineExecutionMode;
  execute: boolean;
  preflightOnly: boolean;
  help: boolean;
  hours: number | null;
  limit: number | null;
  dryRun: true;
  publish: false;
};

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 168) throw new Error(`${name} must be a positive integer no greater than 168`);
  return parsed;
}

export function parsePipelineCliArgs(argv: string[]): PipelineCliOptions {
  let execute = false;
  let preflightOnly = false;
  let help = false;
  let hours: number | null = null;
  let limit: number | null = null;
  for (const argument of argv) {
    if (argument === "--execute") execute = true;
    else if (argument === "--preflight-only") preflightOnly = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--dry-run") { /* pipeline:test is always dry-run */ }
    else if (argument === "--publish=false") { /* pipeline:test never publishes */ }
    else if (argument === "--publish=true") throw new Error("pipeline:test never enables publication; use --publish=false");
    else if (argument.startsWith("--hours=")) hours = positiveInteger(argument.slice(8), "hours");
    else if (argument.startsWith("--limit=")) limit = positiveInteger(argument.slice(8), "limit");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (execute && preflightOnly) throw new Error("--execute and --preflight-only are mutually exclusive");
  if (help && (execute || preflightOnly || hours !== null || limit !== null)) throw new Error("--help cannot be combined with execution arguments");
  if (execute) {
    if (hours === null) throw new Error("--execute requires --hours=N");
    if (limit === null) throw new Error("--execute requires --limit=N");
    if (limit !== 1) throw new Error("pipeline:test real execution only permits --limit=1");
  }
  return { executionMode: execute ? "execute" : "preflight", execute, preflightOnly, help, hours, limit, dryRun: true, publish: false };
}

/** Defense-in-depth guard immediately before the first model stage. */
export function assertExecutionMode(mode: PipelineExecutionMode): void {
  if (mode !== "execute") throw new Error("Provider execution is forbidden outside explicit --execute mode");
}

export function pipelineCliHelp(): string {
  return [
    "HorizAI pipeline:test",
    "",
    "Safe default: preflight only; no provider calls or reservations.",
    "Preflight: npm run pipeline:preflight -- --hours=48 --limit=1",
    "Execute:   npm run pipeline:test -- --execute --hours=48 --limit=1",
    "",
    "Real execution requires all three flags: --execute, --hours=N and --limit=1.",
    "Publication is permanently disabled by this CLI.",
  ].join("\n");
}

export function printPipelineCliDiagnostics(cli: PipelineCliOptions): void {
  console.log(`Execution mode: ${cli.executionMode}`);
  console.log(`execute: ${cli.execute}`);
  console.log(`preflightOnly: ${cli.preflightOnly}`);
  console.log(`hours: ${cli.hours ?? "unset"}`);
  console.log(`limit: ${cli.limit ?? "unset"}`);
  console.log("dryRun: true");
  console.log("publish: false");
}
