import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  classificationResultSchema,
  clusteredEventSchema,
  editorialDraftSchema,
  extractedItemSchema,
  rankingResultSchema,
  translationResultSchema,
  verificationResultSchema,
  type ClusteredEvent,
  type EditorialDraft,
  type ExtractedItem,
  type RankingResult,
  type TranslationResult,
  type VerificationResult,
} from "../contracts/index.ts";
import { criticInputSchema, type CriticInput } from "../critic/critic-types.ts";
import type { AgentTelemetry } from "../runtime/runtime-types.ts";
import type { CheckpointVerification, GeoStageOutput, PipelineEventContext, PipelineSourceMetadata } from "./pipeline-types.ts";

export const capacityResumeStages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
export type CapacityResumeStage = (typeof capacityResumeStages)[number];
export const capacityResumeCheckpointStages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
export type CapacityResumeCheckpointStage = (typeof capacityResumeCheckpointStages)[number];

export const capacityResumePreviousStages: Record<CapacityResumeStage, readonly CapacityResumeCheckpointStage[]> = {
  verifier: [],
  translator: ["verifier"],
  editor: ["verifier", "translator"],
  classifier: ["verifier", "translator", "editor"],
  ranker: ["verifier", "translator", "editor", "classifier"],
  critic: ["verifier", "translator", "editor", "classifier", "ranker"],
};

export type CapacityResumeSnapshot = {
  schemaVersion: 1;
  kind: "SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME";
  attemptId: string;
  pipelineRunId: string;
  eventKey: string;
  resumeStage: CapacityResumeStage;
  /** Original event-attempt start time; needed when Verifier has no prior telemetry. */
  attemptStartedAt?: string;
  event: ClusteredEvent;
  items: ExtractedItem[];
  sources: PipelineSourceMetadata[];
  verification?: VerificationResult;
  translation?: TranslationResult;
  editorial?: EditorialDraft;
  classification?: z.infer<typeof classificationResultSchema>;
  geo?: GeoStageOutput;
  ranking?: RankingResult;
  criticInputOverride?: CriticInput;
  checkpoints: Partial<Record<CapacityResumeCheckpointStage, CheckpointVerification>>;
  checkpointSha256: Partial<Record<CapacityResumeCheckpointStage, string>>;
  providerAccounting: Partial<Record<CapacityResumeCheckpointStage, AgentTelemetry>>;
  nextStageDispatchCount: 0;
  nextStageCheckpointPresent: false;
  /** The migration 30 regression consumes these aliases for classifier-only snapshots. */
  classifierDispatchCount?: 0;
  classifierCheckpointPresent?: false;
  resumeGeneration: number;
};

export type CapacityResumeAttemptEvidence = {
  attemptId: string;
  eventKey: string;
  pipelineRunId: string;
  startedAt?: string;
  completedAt: string | null;
  finalState: string | null;
  stopStage: string | null;
  stopReason: string | null;
  countsTowardRetryLimit: boolean;
};

export type CapacityResumeEvidence = {
  attempt: CapacityResumeAttemptEvidence;
  currentEvent: ClusteredEvent;
  currentSources: PipelineSourceMetadata[];
  currentItems: ExtractedItem[];
  currentCheckpointSha256: Partial<Record<CapacityResumeCheckpointStage, string>>;
  nextStageDispatchCount?: number;
  nextStageCheckpointPresent?: boolean;
  /** Backwards-compatible classifier checks for prior offline evidence. */
  classifierDispatchCount?: number;
  classifierCheckpointPresent?: boolean;
  unresolvedProviderUsage: boolean;
  activeOwner: boolean;
  terminalEditorialRejection: boolean;
};

export type CapacityResumeAssessment =
  | { valid: true; firstStage: CapacityResumeStage; previousModelCallsToRepeat: 0; ownerId: string }
  | { valid: false; reasons: string[] };

/** M35 counts defer/resume cycles, not the number of completed provider stages. */
export function nextCapacityResumeGeneration(previousGeneration?: number): number {
  if (previousGeneration === undefined) return 0;
  if (!Number.isSafeInteger(previousGeneration) || previousGeneration < 0 || previousGeneration >= 1000) {
    throw new Error("CAPACITY_RESUME_GENERATION_INVALID");
  }
  return previousGeneration + 1;
}

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const resumeSourceSchema = z.object({
  sourceId: z.string().uuid(),
  sourceItemId: z.string().trim().min(1).max(300),
  rawItemId: z.string().uuid().nullable(),
  sourceName: z.string().trim().min(1).max(200),
  sourceUrl: z.string().url(),
  sourceType: z.string().trim().min(1).max(80).nullable().optional(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/).nullable().optional(),
}).strict();

const geoStageSchema = z.object({
  eventKey: z.string().trim().min(1).max(200),
  primaryRegionCode: z.string().trim().min(1).max(20).nullable(),
  countryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).max(100),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  resolutionLevel: z.enum(["global", "region", "country", "unresolved"]),
  resolvedFrom: z.enum(["country_registry", "region_registry"]).nullable(),
  provenance: z.enum(["classifier", "reference_registry", "unresolved"]),
}).strict();

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function checkpointMap(value: unknown, expected: readonly CapacityResumeCheckpointStage[], eventKey: string): Partial<Record<CapacityResumeCheckpointStage, CheckpointVerification>> | null {
  const input = record(value);
  if (!hasExactKeys(input, expected)) return null;
  const result: Partial<Record<CapacityResumeCheckpointStage, CheckpointVerification>> = {};
  for (const stage of expected) {
    const item = record(input[stage]);
    if (item.stage !== stage || item.eventKey !== eventKey || typeof item.path !== "string" || item.path.length === 0
      || item.written !== true || item.readable !== true || item.valid !== true) return null;
    result[stage] = item as unknown as CheckpointVerification;
  }
  return result;
}

function telemetryMap(value: unknown, expected: readonly CapacityResumeCheckpointStage[]): Partial<Record<CapacityResumeCheckpointStage, AgentTelemetry>> | null {
  const input = record(value);
  if (!hasExactKeys(input, expected)) return null;
  const result: Partial<Record<CapacityResumeCheckpointStage, AgentTelemetry>> = {};
  for (const stage of expected) {
    const item = record(input[stage]);
    const valid = item.status === "SUCCESS"
      && item.provider === "groq"
      && item.providerRequestDispatched === true
      && item.providerRequestsUsed === 1
      && item.attempts === 1
      && item.retries === 0
      && item.providerUnit === "tokens"
      && item.providerUnitUsageKnown === true
      && Number.isSafeInteger(item.inputTokens) && Number(item.inputTokens) >= 0
      && Number.isSafeInteger(item.outputTokens) && Number(item.outputTokens) >= 0
      && Number.isSafeInteger(item.totalTokens) && Number(item.totalTokens) > 0
      && Number(item.inputTokens) + Number(item.outputTokens) === Number(item.totalTokens);
    if (!valid) return null;
    result[stage] = item as unknown as AgentTelemetry;
  }
  return result;
}

export function parseCapacityResumeSnapshot(value: unknown): CapacityResumeSnapshot {
  const input = record(value);
  const resumeStage = input.resumeStage;
  if (input.schemaVersion !== 1 || input.kind !== "SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME"
    || !capacityResumeStages.includes(resumeStage as CapacityResumeStage)
    || input.nextStageDispatchCount !== 0 || input.nextStageCheckpointPresent !== false
    || !Number.isSafeInteger(input.resumeGeneration) || Number(input.resumeGeneration) < 0 || Number(input.resumeGeneration) > 1000
    || typeof input.attemptId !== "string" || typeof input.pipelineRunId !== "string" || typeof input.eventKey !== "string") {
    throw new Error("CAPACITY_RESUME_SNAPSHOT_IDENTITY_INVALID");
  }
  const stage = resumeStage as CapacityResumeStage;
  if (input.attemptStartedAt !== undefined && (typeof input.attemptStartedAt !== "string" || !Number.isFinite(Date.parse(input.attemptStartedAt)))) {
    throw new Error("CAPACITY_RESUME_ATTEMPT_START_INVALID");
  }
  if (stage === "verifier" && (typeof input.attemptStartedAt !== "string" || !Number.isFinite(Date.parse(input.attemptStartedAt)))) {
    throw new Error("CAPACITY_RESUME_VERIFIER_START_REQUIRED");
  }
  if (stage === "classifier" && (input.classifierDispatchCount !== 0 || input.classifierCheckpointPresent !== false)) {
    throw new Error("CAPACITY_RESUME_SNAPSHOT_PENDING_CLASSIFIER_INVALID");
  }
  if (stage !== "classifier" && (input.classifierDispatchCount !== undefined || input.classifierCheckpointPresent !== undefined)) {
    throw new Error("CAPACITY_RESUME_SNAPSHOT_CLASSIFIER_ALIAS_UNEXPECTED");
  }
  const expected = capacityResumePreviousStages[stage];
  const event = clusteredEventSchema.parse(input.event);
  const items = Array.isArray(input.items) ? input.items.map((item) => extractedItemSchema.parse(item)) : [];
  const sources = Array.isArray(input.sources) ? input.sources.map((source) => resumeSourceSchema.parse(source)) as PipelineSourceMetadata[] : [];
  const verification = input.verification === undefined ? undefined : verificationResultSchema.parse(input.verification);
  const translation = input.translation === undefined ? undefined : translationResultSchema.parse(input.translation);
  const editorial = input.editorial === undefined ? undefined : editorialDraftSchema.parse(input.editorial);
  const classification = input.classification === undefined ? undefined : classificationResultSchema.parse(input.classification);
  const geo = input.geo === undefined ? undefined : geoStageSchema.parse(input.geo);
  const ranking = input.ranking === undefined ? undefined : rankingResultSchema.parse(input.ranking);
  const criticInputOverride = input.criticInputOverride === undefined ? undefined : criticInputSchema.parse(input.criticInputOverride);
  const checkpoints = checkpointMap(input.checkpoints, expected, String(input.eventKey));
  const providerAccounting = telemetryMap(input.providerAccounting, expected);
  const hashes = record(input.checkpointSha256);
  const validHashes = hasExactKeys(hashes, expected) && expected.every((name) => typeof hashes[name] === "string" && /^[a-f0-9]{64}$/.test(hashes[name] as string));
  if (!checkpoints || !providerAccounting || !validHashes
    || event.eventKey !== input.eventKey
    || (stage === "verifier" ? verification !== undefined || translation !== undefined : !verification || verification.eventKey !== input.eventKey)
    || (stage === "translator" ? translation !== undefined : stage !== "verifier" && (!translation || translation.eventKey !== input.eventKey))
    || (stage === "verifier" || stage === "translator" || stage === "editor"
      ? editorial !== undefined
      : !editorial || editorial.eventKey !== input.eventKey)
    || (classification && classification.eventKey !== input.eventKey) || (geo && geo.eventKey !== input.eventKey) || (ranking && ranking.eventKey !== input.eventKey)
    || (criticInputOverride && criticInputOverride.event.eventKey !== input.eventKey)
    || (stage === "verifier" && ["verification", "translation", "editorial", "classification", "geo", "ranking", "criticInputOverride"].some((key) => input[key] !== undefined))
    || (stage === "translator" && ["translation", "editorial", "classification", "geo", "ranking", "criticInputOverride"].some((key) => input[key] !== undefined))
    || (stage === "ranker" && (!classification || !geo))
    || (stage === "critic" && (!classification || !geo || !ranking))
    || items.length !== event.sourceItems.length || sources.length !== event.sourceItems.length
    || event.sourceItems.some((eventSource) => {
      const item = items.find((candidate) => candidate.candidateId === eventSource.candidateId);
      const source = sources.find((candidate) => candidate.sourceItemId === eventSource.candidateId);
      const itemSourceId = typeof item?.metadata.sourceId === "string" ? item.metadata.sourceId : null;
      return !item || !source || source.sourceId !== eventSource.sourceId || source.sourceUrl !== item.canonicalUrl
        || !source.rawItemId || (itemSourceId !== null && itemSourceId !== source.sourceId);
    })
    || new Set(sources.map((source) => source.rawItemId)).size !== sources.length) {
    throw new Error("CAPACITY_RESUME_SNAPSHOT_CONTRACT_INVALID");
  }
  return {
    schemaVersion: 1,
    kind: "SUPERVISED_PRE_DISPATCH_CAPACITY_RESUME",
    attemptId: input.attemptId,
    pipelineRunId: input.pipelineRunId,
    eventKey: input.eventKey,
    resumeStage: stage,
    ...(typeof input.attemptStartedAt === "string" ? { attemptStartedAt: input.attemptStartedAt } : {}),
    event,
    items,
    sources,
    ...(verification ? { verification } : {}),
    ...(translation ? { translation } : {}),
    ...(editorial ? { editorial } : {}),
    ...(classification ? { classification } : {}),
    ...(geo ? { geo: geo as GeoStageOutput } : {}),
    ...(ranking ? { ranking } : {}),
    ...(criticInputOverride ? { criticInputOverride } : {}),
    checkpoints,
    checkpointSha256: Object.fromEntries(expected.map((name) => [name, String(hashes[name])])) as Partial<Record<CapacityResumeCheckpointStage, string>>,
    providerAccounting,
    nextStageDispatchCount: 0,
    nextStageCheckpointPresent: false,
    ...(stage === "classifier" ? { classifierDispatchCount: 0 as const, classifierCheckpointPresent: false as const } : {}),
    resumeGeneration: Number(input.resumeGeneration),
  };
}

export function capacityResumeSnapshotsMatch(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(parseCapacityResumeSnapshot(left)) === canonicalJson(parseCapacityResumeSnapshot(right));
  } catch {
    return false;
  }
}

function lineage(context: Pick<PipelineEventContext, "event" | "items" | "sources">): string {
  const byId = new Map(context.items.map((item) => [item.candidateId, item]));
  return JSON.stringify(context.event.sourceItems.map((eventSource) => {
    const item = byId.get(eventSource.candidateId);
    const source = context.sources.find((entry) => entry.sourceItemId === eventSource.candidateId);
    return {
      sourceItemId: eventSource.candidateId,
      sourceId: eventSource.sourceId,
      rawItemId: source?.rawItemId ?? null,
      canonicalUrl: item?.canonicalUrl ?? null,
      contentHash: item?.contentHash ?? null,
    };
  }).sort((left, right) => left.sourceItemId.localeCompare(right.sourceItemId)));
}

export function assessCapacityResume(snapshotValue: unknown, evidence: CapacityResumeEvidence, options: { ownerId?: string } = {}): CapacityResumeAssessment {
  let snapshot: CapacityResumeSnapshot;
  try { snapshot = parseCapacityResumeSnapshot(snapshotValue); }
  catch (error) { return { valid: false, reasons: [error instanceof Error ? error.message : "CAPACITY_RESUME_SNAPSHOT_INVALID"] }; }
  const reasons: string[] = [];
  const requiredStages = capacityResumePreviousStages[snapshot.resumeStage];
  const nextStageDispatchCount = evidence.nextStageDispatchCount ?? (snapshot.resumeStage === "classifier" ? evidence.classifierDispatchCount : undefined);
  const nextStageCheckpointPresent = evidence.nextStageCheckpointPresent ?? (snapshot.resumeStage === "classifier" ? evidence.classifierCheckpointPresent : undefined);
  if (snapshot.attemptId !== evidence.attempt.attemptId || snapshot.eventKey !== evidence.attempt.eventKey || snapshot.pipelineRunId !== evidence.attempt.pipelineRunId) reasons.push("ATTEMPT_OR_EVENT_IDENTITY_CHANGED");
  if (snapshot.eventKey !== evidence.currentEvent.eventKey || canonicalJson(snapshot.event) !== canonicalJson(evidence.currentEvent)) reasons.push("EVENT_CHANGED");
  if (lineage(snapshot) !== lineage({ event: evidence.currentEvent, items: evidence.currentItems, sources: evidence.currentSources })) reasons.push("SOURCE_RAW_LINEAGE_CHANGED");
  if (evidence.attempt.completedAt !== null || evidence.attempt.finalState !== null || evidence.attempt.stopStage !== snapshot.resumeStage
    || !["PROVIDER_CAPACITY_EXHAUSTED", "WORKER_TIME_BUDGET_EXHAUSTED"].includes(evidence.attempt.stopReason ?? "") || evidence.attempt.countsTowardRetryLimit) reasons.push("ATTEMPT_NOT_RESUMABLE_DEFERRED");
  if (requiredStages.some((name) => evidence.currentCheckpointSha256[name] !== snapshot.checkpointSha256[name])) reasons.push("COMPLETED_CHECKPOINT_CHANGED");
  if (nextStageDispatchCount !== 0) reasons.push("NEXT_STAGE_DISPATCH_HISTORY_AMBIGUOUS");
  if (nextStageCheckpointPresent !== false) reasons.push("NEXT_STAGE_CHECKPOINT_ALREADY_EXISTS");
  if (evidence.unresolvedProviderUsage) reasons.push("UPSTREAM_PROVIDER_USAGE_UNSETTLED");
  if (evidence.activeOwner) reasons.push("CAPACITY_RESUME_ALREADY_OWNED");
  if (evidence.terminalEditorialRejection || snapshot.verification?.status === "rejected") reasons.push("TERMINAL_EDITORIAL_REJECTION");
  const storedSources = new Set(snapshot.sources.map((source) => source.sourceItemId));
  const eventSources = snapshot.event.sourceItems;
  if (snapshot.items.length !== eventSources.length || storedSources.size !== eventSources.length
    || eventSources.some((source) => !storedSources.has(source.candidateId))) reasons.push("SNAPSHOT_SOURCE_LINEAGE_INCOMPLETE");
  if (reasons.length > 0) return { valid: false, reasons };
  return { valid: true, firstStage: snapshot.resumeStage, previousModelCallsToRepeat: 0, ownerId: options.ownerId ?? randomUUID() };
}

export async function checkpointSha256(checkpoints: Partial<Record<CapacityResumeCheckpointStage, CheckpointVerification>>): Promise<Partial<Record<CapacityResumeCheckpointStage, string>>> {
  const hashes: Partial<Record<CapacityResumeCheckpointStage, string>> = {};
  for (const stage of capacityResumeCheckpointStages) {
    const checkpoint = checkpoints[stage];
    if (!checkpoint) continue;
    if (!checkpoint.path || !checkpoint.written || !checkpoint.readable || !checkpoint.valid) throw new Error("CAPACITY_RESUME_CHECKPOINT_NOT_VERIFIED");
    hashes[stage] = sha256(await readFile(checkpoint.path));
  }
  return hashes;
}

export async function writeCapacityResumeSnapshot(snapshotValue: Omit<CapacityResumeSnapshot, "checkpointSha256"> & { checkpointSha256?: Partial<Record<CapacityResumeCheckpointStage, string>> }, targetPath: string): Promise<{ path: string; sha256: string }> {
  const hashes = snapshotValue.checkpointSha256 ?? await checkpointSha256(snapshotValue.checkpoints);
  const snapshot = parseCapacityResumeSnapshot({ ...snapshotValue, checkpointSha256: hashes });
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, targetPath);
  return { path: targetPath, sha256: sha256(serialized) };
}

export async function readCapacityResumeSnapshot(path: string): Promise<{ snapshot: CapacityResumeSnapshot; sha256: string }> {
  const bytes = await readFile(path);
  const parsed = parseCapacityResumeSnapshot(JSON.parse(bytes.toString("utf8")) as unknown);
  return { snapshot: parsed, sha256: sha256(bytes) };
}
