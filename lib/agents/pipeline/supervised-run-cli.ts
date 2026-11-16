export const canonicalSupervisedRunCommand = "npm.cmd run pipeline:supervised:run -- --execute-supervised";

/** Parse before any database, lease, discovery, or provider work. */
export function parseSupervisedRunArgs(argv: readonly string[]): "help" | "execute" {
  if (argv.length === 1 && argv[0] === "--help") return "help";
  if (argv.length === 1 && argv[0] === "--execute-supervised") return "execute";
  throw new Error(`Use only: ${canonicalSupervisedRunCommand}. Use --help for offline usage. In PowerShell, npm.cmd preserves the explicit execution flag.`);
}
