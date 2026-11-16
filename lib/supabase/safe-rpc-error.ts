export type SafeRpcFailure = {
  operation: string;
  httpStatus: number | null;
  postgrestCode: string | null;
  sqlState: string | null;
  message: string | null;
  details: string | null;
  hint: string | null;
  causeName: string | null;
  causeMessage: string | null;
};

type SafeRpcFailureOptions = {
  httpStatus?: unknown;
  sensitiveValues?: readonly string[];
};

const MAX_ERROR_FIELD_LENGTH = 2_048;

function objectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function runtimeSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => value && /(?:SECRET|PASSWORD|TOKEN|API.?KEY|ACCESS.?KEY|DIRECT_DB_URL|DATABASE_URL)/i.test(name))
    .map(([, value]) => value!)
    .filter((value) => value.length >= 8);
}

function redactSafeText(value: string | null, sensitiveValues: readonly string[]): string | null {
  if (value === null) return null;
  let safe = value;
  const exactSecrets = [...new Set([...runtimeSecretValues(), ...sensitiveValues].filter((entry) => entry.length >= 8))]
    .sort((left, right) => right.length - left.length);
  for (const secret of exactSecrets) safe = safe.split(secret).join("[REDACTED]");
  safe = safe
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(?:postgres(?:ql)?):\/\/[^\s@/]+:[^\s@/]+@[^\s]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/((?:authorization|apikey|api[_-]?key|secret[_-]?key|password|cookie)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  return safe.length > MAX_ERROR_FIELD_LENGTH ? `${safe.slice(0, MAX_ERROR_FIELD_LENGTH)}[TRUNCATED]` : safe;
}

function safeCause(error: unknown, sensitiveValues: readonly string[]): { causeName: string | null; causeMessage: string | null } {
  const direct = objectField(error, "cause");
  if (direct === undefined || direct === null) return { causeName: null, causeMessage: null };
  const causeName = redactSafeText(stringField(objectField(direct, "name")), sensitiveValues);
  const directMessage = typeof direct === "string" ? direct : stringField(objectField(direct, "message"));
  const nested = objectField(direct, "cause");
  const nestedMessage = typeof nested === "string" ? nested : stringField(objectField(nested, "message"));
  const combined = [directMessage, nestedMessage].filter((part): part is string => part !== null).join("; ") || null;
  return { causeName, causeMessage: redactSafeText(combined, sensitiveValues) };
}

export function normalizeSafeRpcFailure(
  operation: string,
  error: unknown,
  options: SafeRpcFailureOptions = {},
): SafeRpcFailure {
  const rawCode = stringField(objectField(error, "code"));
  const isSqlState = rawCode !== null && /^[0-9A-Z]{5}$/.test(rawCode) && !rawCode.startsWith("PGRST");
  const cause = safeCause(error, options.sensitiveValues ?? []);
  const rawMessage = error instanceof Error ? error.message : stringField(objectField(error, "message"));
  const httpStatus = typeof options.httpStatus === "number" && Number.isInteger(options.httpStatus)
    && options.httpStatus >= 100 && options.httpStatus <= 599 ? options.httpStatus : null;

  return {
    operation,
    httpStatus,
    postgrestCode: rawCode !== null && !isSqlState ? redactSafeText(rawCode, options.sensitiveValues ?? []) : null,
    sqlState: isSqlState ? rawCode : null,
    message: redactSafeText(rawMessage, options.sensitiveValues ?? []),
    details: redactSafeText(stringField(objectField(error, "details")), options.sensitiveValues ?? []),
    hint: redactSafeText(stringField(objectField(error, "hint")), options.sensitiveValues ?? []),
    causeName: cause.causeName,
    causeMessage: cause.causeMessage,
  };
}

export class SafeRpcFailureError extends Error {
  readonly rpcFailure: SafeRpcFailure;

  constructor(rpcFailure: SafeRpcFailure) {
    super(rpcFailure.message ?? "RPC_FAILURE");
    this.name = "SafeRpcFailureError";
    this.rpcFailure = rpcFailure;
  }
}

export function isSafeRpcFailureError(error: unknown): error is SafeRpcFailureError {
  return error instanceof SafeRpcFailureError;
}
