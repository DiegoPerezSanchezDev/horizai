import { assertFactualRemediationAuthorization, factualRemediationIncident, type FactualRemediationAuthorization } from "./factual-remediation.ts";
import { z } from "zod";

export const factualRemediationContinuation = {
  attemptId: "a82482be-58d8-4fc6-ac16-946d0906257b",
  originalPipelineRunId: "db368f10-d9c1-4897-b752-b3d2cb156e09",
  continuationPipelineRunId: "f140d01b-b7f1-4f05-b8f7-9ad0081e7105",
  resumeStage: "critic",
  agentVersion: "critic-v4",
  pilotAttempts: 5,
  pilotAttemptCeiling: 5,
  maxProviderCalls: 1,
  checkpointHashes: {
    verifier: "668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378",
    translator: "668c5483f2e6662f7e17138b652e0fb0a66f4e52e5c59e4685e448d89eae5378",
    editor: "ac88461328385917a3c9ebd219815b06211b1d0ed64684eea1f0993c4e5cc218",
    classifier: "947951b78f3aa39719943d8d916a70c23a796777b33557b8dcb5d67d3b4a345d",
    ranker: "17d758b3883239ab7e3dc28141b8449c9b93df43827f56d77b4ef6fe506d5edf",
  },
} as const;

export type FactualRemediationContinuationAuthorization = FactualRemediationAuthorization;
export type FactualRemediationContinuationCommand =
  | { mode: "preflight" }
  | { mode: "execute"; continuationPipelineRunId: string }
  | { mode: "help" };

const checkpointHash = (value: string) => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_EXPECTED_CHECKPOINT_HASH_INVALID");
  return z.literal(value);
};

export type ContinuationCheckpointHashes = Record<"verifier" | "translator" | "editor" | "classifier" | "ranker", string>;

export function createContinuationCheckpointManifestSchema(expected: {
  eventKey: string;
  sourceRunId: string;
  checkpointHashes: ContinuationCheckpointHashes;
}) {
  return z.object({
    schemaVersion: z.literal(1),
    eventKey: z.literal(expected.eventKey),
    sourceRunId: z.literal(expected.sourceRunId),
    resumeStage: z.literal("critic"),
    criticCheckpoint: z.literal("absent"),
    checkpoints: z.object({
      verifier: checkpointHash(expected.checkpointHashes.verifier),
      translator: checkpointHash(expected.checkpointHashes.translator),
      editor: checkpointHash(expected.checkpointHashes.editor),
      classifier: checkpointHash(expected.checkpointHashes.classifier),
      ranker: checkpointHash(expected.checkpointHashes.ranker),
    }).strict(),
  }).strict();
}

export const continuationCheckpointManifestSchema = createContinuationCheckpointManifestSchema({
  eventKey: factualRemediationIncident.eventKey,
  sourceRunId: factualRemediationContinuation.originalPipelineRunId,
  checkpointHashes: factualRemediationContinuation.checkpointHashes,
});

export type ContinuationCheckpointManifest = z.infer<typeof continuationCheckpointManifestSchema>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalizeJsonValue(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new Error("FACTUAL_REMEDIATION_CONTINUATION_JSON_VALUE_INVALID");
  if (seen.has(value)) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_JSON_VALUE_CYCLIC");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_JSON_ARRAY_HOLE");
        result.push(canonicalizeJsonValue(value[index], seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_JSON_OBJECT_INVALID");
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalizeJsonValue(record[key], seen)]));
  } finally {
    seen.delete(value);
  }
}

export function canonicalJsonString(value: unknown): string {
  const canonical = canonicalizeJsonValue(value, new WeakSet());
  const serialize = (entry: JsonValue): string => {
    if (entry === null) return "null";
    if (typeof entry === "string") return JSON.stringify(entry);
    if (typeof entry === "boolean") return entry ? "true" : "false";
    if (typeof entry === "number") return Object.is(entry, -0) ? "-0" : String(entry);
    if (Array.isArray(entry)) return `[${entry.map(serialize).join(",")}]`;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${serialize(entry[key]!)}`).join(",")}}`;
  };
  return serialize(canonical);
}

export function canonicalContinuationCheckpointManifest(
  value: unknown,
  schema: z.ZodType<ContinuationCheckpointManifest> = continuationCheckpointManifestSchema,
): { manifest: ContinuationCheckpointManifest; canonicalJson: string } {
  const manifest = schema.parse(value);
  return { manifest, canonicalJson: canonicalJsonString(manifest) };
}

export function continuationCheckpointManifestsEqual(
  left: unknown,
  right: unknown,
  schema: z.ZodType<ContinuationCheckpointManifest> = continuationCheckpointManifestSchema,
): boolean {
  try {
    return canonicalContinuationCheckpointManifest(left, schema).canonicalJson
      === canonicalContinuationCheckpointManifest(right, schema).canonicalJson;
  } catch {
    return false;
  }
}

export function parseFactualRemediationContinuationCommand(argv: readonly string[]): FactualRemediationContinuationCommand {
  if (argv.length === 1 && argv[0] === "--help") return { mode: "help" };
  const values = new Map<string, string>();
  let execute = false;
  let preflight = false;
  for (const arg of argv) {
    if (arg === "--preflight-only") { if (preflight) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_DUPLICATE_PREFLIGHT"); preflight = true; continue; }
    if (arg === "--execute-critic-continuation") { if (execute) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_DUPLICATE_EXECUTION_FLAG"); execute = true; continue; }
    const match = /^(--continuation-run-id)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_ARGUMENT_INVALID");
    values.set(match[1], match[2]);
  }
  if (!execute) {
    if (values.size > 0) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_AUTH_REQUIRES_EXECUTION_FLAG");
    return { mode: "preflight" };
  }
  if (preflight) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_MODE_CONFLICT");
  const continuationPipelineRunId = values.get("--continuation-run-id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(continuationPipelineRunId)
    || continuationPipelineRunId !== factualRemediationContinuation.continuationPipelineRunId) {
    throw new Error("FACTUAL_REMEDIATION_CONTINUATION_RUN_ID_REQUIRED");
  }
  return { mode: "execute", continuationPipelineRunId };
}

export type ContinuationEligibilityEvidence = {
  attemptId: string;
  eventKey: string;
  attemptNumber: number;
  pilotAttemptNumber: number;
  pilotAttempts: number;
  purpose: string;
  finalState: string | null;
  completed: boolean;
  stopStage: string | null;
  stopReason: string | null;
  failureCode: string | null;
  failureClass: string | null;
  criticProviderRequestDispatched: boolean;
  canonicalPreDispatchProof: boolean;
  criticCheckpointPresent: boolean;
  upstreamCheckpointStages: string[];
  laterAttemptExists: boolean;
  continuationAlreadyAuthorized: boolean;
  requestedRestartStage: string;
  databaseRole: "service_role" | "anon" | "authenticated" | "unknown";
  authorization?: FactualRemediationContinuationAuthorization;
};

export function assertFactualRemediationContinuationEligible(value: ContinuationEligibilityEvidence): void {
  if (value.databaseRole !== "service_role") throw new Error("FACTUAL_REMEDIATION_CONTINUATION_SERVICE_ROLE_REQUIRED");
  if (value.attemptId !== factualRemediationContinuation.attemptId
    || value.eventKey !== factualRemediationIncident.eventKey
    || value.attemptNumber !== 2
    || value.pilotAttemptNumber !== 5
    || value.pilotAttempts !== 5) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_ATTEMPT_IDENTITY_INVALID");
  if (value.purpose !== "FACTUAL_REMEDIATION") throw new Error("FACTUAL_REMEDIATION_CONTINUATION_PURPOSE_INVALID");
  if (!value.completed || value.finalState !== "TECHNICAL_FAILURE") throw new Error("FACTUAL_REMEDIATION_CONTINUATION_TERMINAL_STATE_INVALID");
  if (value.stopStage !== "critic" || value.stopReason !== "cost_guard_violation"
    || value.failureCode !== "cost_guard_violation" || value.failureClass !== "GROQ_TPM_STAGE_EXCEEDS_TPM") {
    throw new Error("FACTUAL_REMEDIATION_CONTINUATION_FAILURE_CLASS_INELIGIBLE");
  }
  if (value.criticProviderRequestDispatched || !value.canonicalPreDispatchProof) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_NON_DISPATCH_UNPROVEN");
  if (value.criticCheckpointPresent) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_CRITIC_CHECKPOINT_EXISTS");
  const expectedStages = ["verifier", "translator", "editor", "classifier", "ranker"];
  if (expectedStages.some((stage) => !value.upstreamCheckpointStages.includes(stage))) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINTS_MISSING");
  if (value.laterAttemptExists) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_LATER_ATTEMPT_EXISTS");
  if (value.continuationAlreadyAuthorized) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_ALREADY_CONSUMED");
  if (value.requestedRestartStage !== "critic") throw new Error("FACTUAL_REMEDIATION_CONTINUATION_STAGE_FIXED_TO_CRITIC");
  if (!value.authorization) throw new Error("FACTUAL_REMEDIATION_CONTINUATION_HUMAN_AUTHORIZATION_REQUIRED");
  assertFactualRemediationAuthorization(value.authorization);
}
