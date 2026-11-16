import { createHash } from "node:crypto";
import { CLOUDFLARE_LLAMA_VALIDATION_MODEL } from "./provider-cost-policy.ts";
import { normalEventStages, type NormalEventStage } from "./event-model-stages.ts";

export type { NormalEventStage };

export const QUALITY_BENCHMARK_PURPOSE = "quality_benchmark" as const;
export const QUALITY_BENCHMARK_PROVIDER = "cloudflare_workers_ai" as const;
export const QUALITY_BENCHMARK_MODEL = CLOUDFLARE_LLAMA_VALIDATION_MODEL;
export const MAX_QUALITY_BENCHMARK_CALLS = 8 as const;

export const QUALITY_BENCHMARK_CASE_IDS = {
  arsProblem: "quality:ars-problematic-lineage-v1",
  mitControl: "quality:mit-clean-control-v1",
} as const;

export type QualityBenchmarkCaseId = (typeof QUALITY_BENCHMARK_CASE_IDS)[keyof typeof QUALITY_BENCHMARK_CASE_IDS];
export type QualityBenchmarkCaseKind = "PROBLEM_CASE" | "CLEAN_CONTROL";

export const qualityBenchmarkAgentVersions: Readonly<Record<NormalEventStage, string>> = Object.freeze({
  verifier: "verifier-v1",
  translator: "translator-v1",
  editor: "editor-v2",
  classifier: "classifier-v1",
  ranker: "ranker-v1",
  critic: "critic-v3",
});

export const qualityBenchmarkCases = Object.freeze({
  [QUALITY_BENCHMARK_CASE_IDS.arsProblem]: {
    kind: "PROBLEM_CASE" as const,
    historicalEventKey: "event-5c80fcd1a4e5b0d010308f37d646625a",
    sourceCount: 1,
    historicalProviderProvenance: "CONFIRMED_GROQ" as const,
    rawItemTraceability: "AVAILABLE" as const,
    rawItemId: "93dea107-8bbf-42a5-8314-c0b4c70522ec",
    rawContentSha256: "7aa373cdeeb56947806f21460d97042739cd62f7f8d3dd812c0a41d9e7dd7f84",
    snapshotPath: "artifacts/supervised-candidates/b6f66b19-1281-406c-9bdd-0fdb18b46d08.json",
    checkpoints: {
      verifier: "artifacts/pipeline-checkpoints/13e5e2fd-1de8-4386-b4c5-43eec39b0532/verifier-event-5c80fcd1a4e5b0d010308f37d646625a.json",
      translator: "artifacts/pipeline-checkpoints/13e5e2fd-1de8-4386-b4c5-43eec39b0532/translator-event-5c80fcd1a4e5b0d010308f37d646625a.json",
      editor: "artifacts/pipeline-checkpoints/13e5e2fd-1de8-4386-b4c5-43eec39b0532/editor-event-5c80fcd1a4e5b0d010308f37d646625a.json",
      classifier: "artifacts/pipeline-checkpoints/13e5e2fd-1de8-4386-b4c5-43eec39b0532/classifier-event-5c80fcd1a4e5b0d010308f37d646625a.json",
      ranker: "artifacts/pipeline-checkpoints/13e5e2fd-1de8-4386-b4c5-43eec39b0532/ranker-event-5c80fcd1a4e5b0d010308f37d646625a.json",
      critic: "artifacts/pipeline-checkpoints/c7623266-72b7-4da9-81af-1eddab539aa9/critic-event-5c80fcd1a4e5b0d010308f37d646625a.json",
    },
  },
  [QUALITY_BENCHMARK_CASE_IDS.mitControl]: {
    kind: "CLEAN_CONTROL" as const,
    historicalEventKey: "event-2a0197acd23aa82ff91895e1464d2897",
    sourceCount: 1,
    historicalProviderProvenance: "CONFIRMED_GROQ" as const,
    rawItemTraceability: "MISSING" as const,
    rawItemId: null,
    rawContentSha256: null,
    checkpoints: {
      verifier: "artifacts/pipeline-checkpoints/57aa6e65-2ec4-4f9f-9139-bfa794cbe2a9/verifier-event-2a0197acd23aa82ff91895e1464d2897.json",
      translator: "artifacts/pipeline-checkpoints/57aa6e65-2ec4-4f9f-9139-bfa794cbe2a9/translator-event-2a0197acd23aa82ff91895e1464d2897.json",
      editor: "artifacts/pipeline-checkpoints/57aa6e65-2ec4-4f9f-9139-bfa794cbe2a9/editor-event-2a0197acd23aa82ff91895e1464d2897.json",
      classifier: "artifacts/pipeline-checkpoints/57aa6e65-2ec4-4f9f-9139-bfa794cbe2a9/classifier-event-2a0197acd23aa82ff91895e1464d2897.json",
      ranker: "artifacts/pipeline-checkpoints/57aa6e65-2ec4-4f9f-9139-bfa794cbe2a9/ranker-event-2a0197acd23aa82ff91895e1464d2897.json",
      critic: "artifacts/pipeline-checkpoints/57aa6e65-2ec4-4f9f-9139-bfa794cbe2a9/critic-event-2a0197acd23aa82ff91895e1464d2897.json",
    },
  },
});

export type QualityBenchmarkPlannedCall = {
  benchmarkCaseId: QualityBenchmarkCaseId;
  stage: NormalEventStage;
  agentVersion: string;
  attempt: 1;
  maxRetries: 0;
  provider: typeof QUALITY_BENCHMARK_PROVIDER;
  model: typeof QUALITY_BENCHMARK_MODEL;
  purpose: typeof QUALITY_BENCHMARK_PURPOSE;
};

const plannedPairs: ReadonlyArray<readonly [QualityBenchmarkCaseId, NormalEventStage]> = [
  [QUALITY_BENCHMARK_CASE_IDS.arsProblem, "verifier"],
  [QUALITY_BENCHMARK_CASE_IDS.arsProblem, "translator"],
  [QUALITY_BENCHMARK_CASE_IDS.arsProblem, "editor"],
  [QUALITY_BENCHMARK_CASE_IDS.arsProblem, "classifier"],
  [QUALITY_BENCHMARK_CASE_IDS.arsProblem, "ranker"],
  [QUALITY_BENCHMARK_CASE_IDS.arsProblem, "critic"],
];

export const plannedQualityBenchmarkCalls: readonly QualityBenchmarkPlannedCall[] = Object.freeze(
  plannedPairs.map(([benchmarkCaseId, stage]) => ({
    benchmarkCaseId,
    stage,
    agentVersion: qualityBenchmarkAgentVersions[stage],
    attempt: 1 as const,
    maxRetries: 0 as const,
    provider: QUALITY_BENCHMARK_PROVIDER,
    model: QUALITY_BENCHMARK_MODEL,
    purpose: QUALITY_BENCHMARK_PURPOSE,
  })),
);

export function qualityBenchmarkAccountingEventKey(benchmarkCaseId: QualityBenchmarkCaseId, stage: NormalEventStage): string {
  return `quality-benchmark:${benchmarkCaseId}:${stage}`;
}

export type QualityBenchmarkAuthorizationRequest = {
  benchmarkCaseId: string;
  stage: string;
  agentVersion: string;
  eventKey: string;
  purpose: string;
  provider: string;
  model: string;
  attempt: number;
  maxRetries: number;
  inputSha256?: string;
};

export function authorizeQualityBenchmarkCall(request: QualityBenchmarkAuthorizationRequest): QualityBenchmarkPlannedCall {
  if (!(normalEventStages as readonly string[]).includes(request.stage)) throw new Error("BLOCKED_QUALITY_BENCHMARK_STAGE_NOT_ALLOWLISTED");
  const call = plannedQualityBenchmarkCalls.find((candidate) => candidate.benchmarkCaseId === request.benchmarkCaseId && candidate.stage === request.stage);
  if (!call) throw new Error("BLOCKED_QUALITY_BENCHMARK_CASE_STAGE_NOT_ALLOWLISTED");
  if (request.purpose !== QUALITY_BENCHMARK_PURPOSE) throw new Error("BLOCKED_QUALITY_BENCHMARK_PURPOSE_MISMATCH");
  if (request.provider !== QUALITY_BENCHMARK_PROVIDER) throw new Error("BLOCKED_QUALITY_BENCHMARK_PROVIDER_NOT_ALLOWLISTED");
  if (request.model !== QUALITY_BENCHMARK_MODEL) throw new Error("BLOCKED_QUALITY_BENCHMARK_MODEL_NOT_ALLOWLISTED");
  if (request.agentVersion !== call.agentVersion) throw new Error("BLOCKED_QUALITY_BENCHMARK_AGENT_VERSION_MISMATCH");
  if (request.eventKey !== qualityBenchmarkAccountingEventKey(call.benchmarkCaseId, call.stage)) throw new Error("BLOCKED_QUALITY_BENCHMARK_EVENT_IDENTITY_MISMATCH");
  if (request.attempt !== 1 || request.maxRetries !== 0) throw new Error("BLOCKED_QUALITY_BENCHMARK_RETRY_POLICY");
  if (request.inputSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/.test(request.inputSha256)) throw new Error("BLOCKED_QUALITY_BENCHMARK_INPUT_HASH_INVALID");
  return call;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error("BLOCKED_QUALITY_BENCHMARK_INPUT_UNDEFINED");
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("BLOCKED_QUALITY_BENCHMARK_INPUT_NOT_JSON");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/** Hash a canonical JSON serialization of the exact projected model input. */
export function qualityBenchmarkInputSha256(modelInput: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(modelInput), "utf8").digest("hex")}`;
}

export type QualityBenchmarkCliMode = "PREFLIGHT_ONLY" | "EXECUTE";

export function parseQualityBenchmarkCliArgs(args: readonly string[]): QualityBenchmarkCliMode {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preflight")) return "PREFLIGHT_ONLY";
  if (args.length === 1 && args[0] === "--execute-quality-benchmark") return "EXECUTE";
  throw new Error("BLOCKED_UNKNOWN_OR_CONFLICTING_QUALITY_BENCHMARK_FLAGS");
}

export function assertQualityBenchmarkCallCeiling(calls: readonly unknown[], maximum = MAX_QUALITY_BENCHMARK_CALLS): void {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_QUALITY_BENCHMARK_CALLS || calls.length > maximum) {
    throw new Error("BLOCKED_QUALITY_BENCHMARK_CALL_CEILING");
  }
}

/** A planned stage can dispatch at most once; preserve failure-side dispatch evidence. */
export function qualityBenchmarkFailureDispatchCount(providerRequestsUsed: number | undefined): number {
  if (providerRequestsUsed === undefined) return 0;
  if (!Number.isSafeInteger(providerRequestsUsed) || providerRequestsUsed < 0 || providerRequestsUsed > 1) {
    throw new Error("BLOCKED_QUALITY_BENCHMARK_FAILURE_DISPATCH_COUNT");
  }
  return providerRequestsUsed;
}

export type IsolatedStageDispatchers<TInput, TResult> = Readonly<Record<NormalEventStage, (input: TInput) => Promise<TResult>>>;

/** Dispatches only the named stage; the benchmark runner never walks pipeline neighbors. */
export async function invokeExactlyOneQualityBenchmarkStage<TInput, TResult>(
  stage: NormalEventStage,
  input: TInput,
  dispatchers: IsolatedStageDispatchers<TInput, TResult>,
): Promise<TResult> {
  const dispatch = dispatchers[stage];
  if (typeof dispatch !== "function") throw new Error("BLOCKED_QUALITY_BENCHMARK_STAGE_EXECUTOR_MISSING");
  return dispatch(input);
}
