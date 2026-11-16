export type RemoteReadEndpointClass = "TABLE" | "RPC";
export type RemoteReadFailure = {
  operation: string; endpointClass: RemoteReadEndpointClass; httpStatus: number | null;
  code: string | null; message: string | null; details: string | null; hint: string | null;
  timestamp: string; clientHelper: "createSupabaseServerClient";
};
type ErrorFields = { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } | null | undefined;
type NormalizeRemoteReadFailureInput = {
  operation: string; endpointClass: RemoteReadEndpointClass; httpStatus?: unknown;
  error: ErrorFields; timestamp?: string;
};
const credentialEnvName = /KEY|TOKEN|PASSWORD|SECRET|DATABASE_URL|DB_URL/i;
const credentialPatterns = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bsb_(?:secret|publishable|anon|service_role)_[A-Za-z0-9_-]+\b/gi,
  /\b(?:gsk|csk)_[A-Za-z0-9_-]{12,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
  /\b(?:authorization|apikey|set-cookie|cookie)\s*[:=]\s*[^\r\n,;]+/gi,
  /\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi,
];
const maxFieldLength = 1200;
function redact(value: string): string {
  let result = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  for (const [name, secret] of Object.entries(process.env)) {
    if (credentialEnvName.test(name) && secret && secret.length >= 8) result = result.split(secret).join("[REDACTED]");
  }
  for (const pattern of credentialPatterns) { pattern.lastIndex = 0; result = result.replace(pattern, "[REDACTED]"); }
  return result.slice(0, maxFieldLength);
}
function safeString(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? redact(value) : null; }

/** Copies allowlisted PostgREST error fields only; never headers, cookies, bodies, or client objects. */
export function normalizeRemoteReadFailure(input: NormalizeRemoteReadFailureInput): RemoteReadFailure | null {
  if (!input.error) return null;
  return {
    operation: redact(input.operation), endpointClass: input.endpointClass,
    httpStatus: Number.isInteger(input.httpStatus) && Number(input.httpStatus) >= 100 && Number(input.httpStatus) <= 599 ? Number(input.httpStatus) : null,
    code: safeString(input.error.code), message: safeString(input.error.message),
    details: safeString(input.error.details), hint: safeString(input.error.hint),
    timestamp: safeString(input.timestamp) ?? new Date().toISOString(),
    clientHelper: "createSupabaseServerClient",
  };
}
/** Emits one allowlisted JSON record, never the original error or request. */
export function logRemoteReadFailure(input: NormalizeRemoteReadFailureInput): RemoteReadFailure | null {
  const failure = normalizeRemoteReadFailure(input);
  if (failure) console.error("SUPABASE_REMOTE_READ_FAILURE", JSON.stringify(failure));
  return failure;
}
