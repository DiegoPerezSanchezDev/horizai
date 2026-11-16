import { createHash } from "node:crypto";
import { basename } from "node:path";

export type ConstructionFailureDiagnostic = {
  phase: "PIPELINE_CONSTRUCTION";
  componentStep: string | null;
  error: {
    name: string;
    message: string;
    code: string | number | null;
    stackFingerprint: string | null;
    causeChain: Array<{ name: string; message: string; code: string | number | null }>;
  };
  timestamp: string;
  runtime: {
    nodeVersion: string;
    processMode: string;
    entrypoint: string;
  };
};

const MAX_CAUSE_DEPTH = 5;
const MAX_MESSAGE_LENGTH = 1_200;
const SECRET_ENV_NAMES = [
  "SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DIRECT_DB_URL", "AGENT_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY",
  "CLOUDFLARE_AI_API_TOKEN", "CLOUDFLARE_API_TOKEN", "DATABASE_URL", "POSTGRES_URL", "POSTGRES_PASSWORD",
];

function redactText(value: unknown, secretValues: readonly string[] = []): string {
  let text = typeof value === "string" ? value : String(value);
  for (const secret of [...secretValues].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  text = text
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/((?:SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DIRECT_DB_URL|AGENT_API_KEY|GROQ_API_KEY|CEREBRAS_API_KEY|CLOUDFLARE_AI_API_TOKEN|CLOUDFLARE_API_TOKEN|DATABASE_URL|POSTGRES_URL|POSTGRES_PASSWORD)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/((?:postgres|postgresql):\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");
  return text.slice(0, MAX_MESSAGE_LENGTH);
}

function errorFields(value: unknown, secretValues: readonly string[]): { name: string; message: string; code: string | number | null } {
  if (value instanceof Error) {
    const candidateCode = (value as Error & { code?: unknown }).code;
    const code = typeof candidateCode === "string" || typeof candidateCode === "number" ? candidateCode : null;
    return {
      name: redactText(value.name || "Error", secretValues).slice(0, 100),
      message: redactText(value.message || "(empty error message)", secretValues),
      code: code === null ? null : typeof code === "string" ? redactText(code, secretValues).slice(0, 100) : code,
    };
  }
  return { name: "NonErrorThrow", message: redactText(value, secretValues), code: null };
}

function causeChain(error: unknown, secretValues: readonly string[]): ConstructionFailureDiagnostic["error"]["causeChain"] {
  const chain: ConstructionFailureDiagnostic["error"]["causeChain"] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = error instanceof Error ? error.cause : undefined;
  while (cursor !== undefined && cursor !== null && chain.length < MAX_CAUSE_DEPTH && !seen.has(cursor)) {
    seen.add(cursor);
    const fields = errorFields(cursor, secretValues);
    chain.push(fields);
    cursor = cursor instanceof Error ? cursor.cause : undefined;
  }
  return chain;
}

function processMode(): string {
  const conditions = process.execArgv.find((argument) => argument.startsWith("--conditions="));
  const nodeEnv = process.env.NODE_ENV?.trim();
  return ["node-cli", conditions ? conditions.slice("--conditions=".length) : null, nodeEnv ? `NODE_ENV=${nodeEnv}` : null]
    .filter((part): part is string => Boolean(part)).join(";");
}

export function secretValuesFromEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  return SECRET_ENV_NAMES.map((name) => env[name]).filter((value): value is string => Boolean(value));
}

export function captureConstructionFailure(input: {
  error: unknown;
  componentStep?: string | null;
  secretValues?: readonly string[];
  timestamp?: string;
  entrypoint?: string;
}): ConstructionFailureDiagnostic {
  const secrets = input.secretValues ?? [];
  const fields = errorFields(input.error, secrets);
  const rawStack = input.error instanceof Error ? input.error.stack ?? "" : "";
  const safeStack = redactText(rawStack, secrets);
  return {
    phase: "PIPELINE_CONSTRUCTION",
    componentStep: input.componentStep ?? null,
    error: {
      ...fields,
      stackFingerprint: safeStack ? createHash("sha256").update(safeStack).digest("hex") : null,
      causeChain: causeChain(input.error, secrets),
    },
    timestamp: input.timestamp ?? new Date().toISOString(),
    runtime: {
      nodeVersion: process.version,
      processMode: processMode(),
      entrypoint: basename(input.entrypoint ?? process.argv[1] ?? "unknown"),
    },
  };
}

/** Runs one synchronous construction operation and reports safe diagnostics before rethrowing. */
export function runWithConstructionDiagnostics<T>(input: {
  componentStep: () => string | null;
  action: () => T;
  onFailure: (diagnostic: ConstructionFailureDiagnostic) => void;
  secretValues?: readonly string[];
}): T {
  try {
    return input.action();
  } catch (error) {
    input.onFailure(captureConstructionFailure({ error, componentStep: input.componentStep(), secretValues: input.secretValues }));
    throw error;
  }
}
