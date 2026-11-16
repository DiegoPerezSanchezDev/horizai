export type SupabaseRequestGuardPhase = "PREFLIGHT" | "RESUME";

export type SupabaseRequestGuardPolicy = {
  pathname: string;
  method: string;
  phase: SupabaseRequestGuardPhase;
  readTables: ReadonlySet<string>;
  readRpcs: ReadonlySet<string>;
  resumeRpcs: ReadonlySet<string>;
};

export function isAllowedSupabaseRequest({
  pathname,
  method,
  phase,
  readTables,
  readRpcs,
  resumeRpcs,
}: SupabaseRequestGuardPolicy): boolean {
  const parts = pathname.split("/").filter(Boolean);
  const verb = method.toUpperCase();

  if (parts[0] !== "rest" || parts[1] !== "v1") return false;

  if (parts[2] === "rpc" && parts.length === 4) {
    return verb === "POST" && (readRpcs.has(parts[3]) || (phase === "RESUME" && resumeRpcs.has(parts[3])));
  }

  if (parts.length !== 3 || !readTables.has(parts[2])) return false;
  if (verb === "GET" || verb === "HEAD") return true;

  return phase === "RESUME" && (
    (parts[2] === "agent_runs" && ["POST", "PATCH"].includes(verb))
    || (parts[2] === "agent_logs" && verb === "POST")
  );
}
