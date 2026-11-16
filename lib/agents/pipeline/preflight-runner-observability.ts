import { createHash } from "node:crypto";

export const PREFLIGHT_PHASES = [
  "RUNNER_START",
  "ENV_VALIDATED",
  "ARTIFACT_PRECONDITION_VALIDATED",
  "PIPELINE_CONSTRUCTION_START",
  "PIPELINE_CONSTRUCTION_COMPLETE",
  "PREFLIGHT_START",
  "PREFLIGHT_CLIENT_READY",
  "ATTEMPT_READ_START",
  "FIRST_REMOTE_REQUEST_START",
  "FIRST_REMOTE_RESPONSE_RECEIVED",
  "PREFLIGHT_COMPLETE",
] as const;

export type PreflightPhase = typeof PREFLIGHT_PHASES[number];
export type PreflightFailureClassification =
  | "LOCAL_RUNNER_PRECONDITION_FAILURE"
  | "LOCAL_PIPELINE_CONSTRUCTION_FAILURE"
  | "LOCAL_PREFLIGHT_FAILURE"
  | "REMOTE_PREFLIGHT_FAILURE"
  | "CLAIM_FAILURE"
  | "RESUME_FAILURE"
  | "PROVIDER_STAGE_FAILURE";

type PhaseMarker = { phase: PreflightPhase; step: string; timestamp: string };
type SafeCause = { name: string; message: string; code: string | number | null; details: string | null; hint: string | null };

export type SafeRunnerError = {
  phase: string;
  step: string | null;
  name: string;
  message: string;
  code: string | number | null;
  details: string | null;
  hint: string | null;
  causeChain: SafeCause[];
  safeStack: string | null;
  safeStackFingerprint: string | null;
};

const MAX_ERROR_TEXT = 2_000;
const MAX_STACK_TEXT = 8_000;
const MAX_CAUSES = 6;
const SENSITIVE_ASSIGNMENT = /((?:SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DIRECT_DB_URL|AGENT_API_KEY|GROQ_API_KEY|CEREBRAS_API_KEY|CLOUDFLARE_AI_API_TOKEN|CLOUDFLARE_API_TOKEN|DATABASE_URL|POSTGRES_URL|POSTGRES_PASSWORD|PASSWORD|ACCESS[_-]?TOKEN|API[_-]?KEY|SECRET|CREDENTIAL)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function readProperty(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return (value as Record<string, unknown>)[key]; } catch { return undefined; }
}

function isError(value: unknown): value is Error {
  try { return value instanceof Error; } catch { return false; }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toSafeString(value: unknown): string {
  try { return String(value); } catch { return "[unprintable thrown value]"; }
}

function redactSafeText(value: unknown, secretValues: readonly string[] = []): string {
  let result = typeof value === "string" ? value : toSafeString(value);
  for (const secret of [...secretValues].filter((candidate) => candidate.length > 0).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[REDACTED]");
  }
  result = result
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:apikey|api[_-]?key|token|access[_-]?token|secret|password|authorization)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT, "$1[REDACTED]")
    .replace(/\b(?:postgres|postgresql):\/\/[^\s"'<>]+/gi, "[REDACTED_DATABASE_URL]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
    .replace(/\b(?:gsk_|csk_|sk-)[A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_API_KEY]");
  return result.slice(0, MAX_ERROR_TEXT);
}

function safeFields(value: unknown, secretValues: readonly string[]): SafeCause {
  const rawName = readProperty(value, "name");
  const rawMessage = readProperty(value, "message");
  const rawCode = readProperty(value, "code");
  const rawDetails = readProperty(value, "details");
  const rawHint = readProperty(value, "hint");
  const errorInstance = isError(value);
  const name = typeof rawName === "string" && rawName.length > 0 ? rawName : errorInstance ? "Error" : "NonErrorThrow";
  const message = typeof rawMessage === "string" ? rawMessage : typeof value === "string" ? value : errorInstance ? value.message : toSafeString(value);
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : null;
  return {
    name: redactSafeText(name, secretValues).slice(0, 120),
    message: redactSafeText(message, secretValues),
    code: code === null ? null : typeof code === "string" ? redactSafeText(code, secretValues).slice(0, 120) : code,
    details: typeof rawDetails === "string" ? redactSafeText(rawDetails, secretValues) : null,
    hint: typeof rawHint === "string" ? redactSafeText(rawHint, secretValues) : null,
  };
}

export function captureSafeRunnerError(input: {
  error: unknown;
  phase: string;
  step?: string | null;
  secretValues?: readonly string[];
}): SafeRunnerError {
  const secrets = input.secretValues ?? [];
  const root = safeFields(input.error, secrets);
  const causeChain: SafeCause[] = [];
  const seen = new Set<unknown>();
  let cause = readProperty(input.error, "cause");
  while (cause !== undefined && cause !== null && causeChain.length < MAX_CAUSES && !seen.has(cause)) {
    seen.add(cause);
    causeChain.push(safeFields(cause, secrets));
    cause = readProperty(cause, "cause");
  }
  const rawStack = stringValue(readProperty(input.error, "stack"));
  const safeStack = rawStack ? redactSafeText(rawStack, secrets).slice(0, MAX_STACK_TEXT) : null;
  return {
    phase: input.phase,
    step: input.step ? redactSafeText(input.step, secrets).slice(0, 240) : null,
    ...root,
    causeChain,
    safeStack,
    safeStackFingerprint: safeStack ? createHash("sha256").update(safeStack).digest("hex") : null,
  };
}

export function classifyPreflightFailure(input: {
  phase: string | null;
  remoteRequestCount: number;
  remoteFailureOccurred?: boolean;
}): PreflightFailureClassification {
  if (input.phase === "CLAIM") return "CLAIM_FAILURE";
  if (input.phase === "RESUME") return "RESUME_FAILURE";
  if (input.phase === "PROVIDER_STAGE") return "PROVIDER_STAGE_FAILURE";
  if (input.remoteRequestCount > 0 && input.remoteFailureOccurred) return "REMOTE_PREFLIGHT_FAILURE";
  if (input.phase === "PIPELINE_CONSTRUCTION_START" || input.phase === "PIPELINE_CONSTRUCTION_COMPLETE") {
    return "LOCAL_PIPELINE_CONSTRUCTION_FAILURE";
  }
  if (input.phase === "RUNNER_START" || input.phase === "ENV_VALIDATED" || input.phase === "ARTIFACT_PRECONDITION_VALIDATED") {
    return "LOCAL_RUNNER_PRECONDITION_FAILURE";
  }
  return "LOCAL_PREFLIGHT_FAILURE";
}

export class PreflightRunnerObservability {
  private activePhase: string | null = null;
  private activeStep: string | null = null;
  private lastCompletedPhase: string | null = null;
  private failingPhase: string | null = null;
  private remoteRequestCount = 0;
  private firstRemoteOperation: string | null = null;
  private firstRemoteHttpStatus: number | null = null;
  private readonly phaseMarkers: PhaseMarker[] = [];
  private exactSafeError: SafeRunnerError | null = null;
  private readonly secretValues: readonly string[];

  constructor(secretValues: readonly string[] = []) {
    this.secretValues = secretValues;
  }

  enter(phase: string, step: string): void {
    this.activePhase = phase;
    this.activeStep = redactSafeText(step, this.secretValues).slice(0, 240);
    this.failingPhase = null;
    this.phaseMarkers.push({ phase: phase as PreflightPhase, step: this.activeStep, timestamp: new Date().toISOString() });
  }

  complete(phase: string, step: string): void {
    const safeStep = redactSafeText(step, this.secretValues).slice(0, 240);
    this.phaseMarkers.push({ phase: phase as PreflightPhase, step: safeStep, timestamp: new Date().toISOString() });
    this.lastCompletedPhase = phase;
    this.activePhase = null;
    this.activeStep = null;
    this.failingPhase = null;
  }

  setStep(step: string): void {
    this.activeStep = redactSafeText(step, this.secretValues).slice(0, 240);
  }

  remoteRequestStarted(operation: string): void {
    this.remoteRequestCount += 1;
    if (this.remoteRequestCount === 1) {
      this.firstRemoteOperation = redactSafeText(operation, this.secretValues).slice(0, 240);
      this.phaseMarkers.push({ phase: "FIRST_REMOTE_REQUEST_START", step: this.firstRemoteOperation, timestamp: new Date().toISOString() });
    }
  }

  remoteResponseReceived(operation: string, httpStatus: number | null): void {
    if (this.remoteRequestCount === 1 && this.firstRemoteHttpStatus === null) {
      this.firstRemoteHttpStatus = httpStatus;
      this.phaseMarkers.push({
        phase: "FIRST_REMOTE_RESPONSE_RECEIVED",
        step: redactSafeText(operation, this.secretValues).slice(0, 240),
        timestamp: new Date().toISOString(),
      });
    }
  }

  capture(error: unknown): SafeRunnerError {
    this.failingPhase = this.activePhase ?? this.lastCompletedPhase ?? "RUNNER_START";
    this.exactSafeError = captureSafeRunnerError({
      error,
      phase: this.failingPhase,
      step: this.activeStep,
      secretValues: this.secretValues,
    });
    return this.exactSafeError;
  }

  snapshot(): {
    phaseMarkers: PhaseMarker[];
    lastCompletedPhase: string | null;
    failingPhase: string | null;
    step: string | null;
    remoteRequestCount: number;
    firstRemoteOperation: string | null;
    firstRemoteHttpStatus: number | null;
    exactSafeError: SafeRunnerError | null;
  } {
    return {
      phaseMarkers: this.phaseMarkers.slice(),
      lastCompletedPhase: this.lastCompletedPhase,
      failingPhase: this.failingPhase,
      step: this.activeStep,
      remoteRequestCount: this.remoteRequestCount,
      firstRemoteOperation: this.firstRemoteOperation,
      firstRemoteHttpStatus: this.firstRemoteHttpStatus,
      exactSafeError: this.exactSafeError,
    };
  }
}

/** Executes one injected runner phase while preserving its exact failure boundary. */
export async function runObservedPhase<T>(
  tracker: PreflightRunnerObservability,
  phase: string,
  step: string,
  action: () => Promise<T>,
): Promise<T> {
  tracker.enter(phase, step);
  const result = await action();
  tracker.complete(phase, step + " complete");
  return result;
}

export function artifactCanStartRun(paths: readonly string[], exists: (path: string) => boolean): boolean {
  return paths.every((path) => !exists(path));
}
