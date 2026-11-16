import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { clusterExtractedItems } from "../clustering/cluster-runner.ts";
import { evaluateContentFreshness } from "../extraction/freshness-policy.ts";
import { hashContent } from "../extraction/content-hash.ts";
import { candidateExternalId, canonicalizeUrl } from "../discovery/canonical-url.ts";

const isoDateTime = z.iso.datetime({ offset: true });
const httpUrl = z.url().refine((value) => /^https?:\/\//i.test(value));
const uuid = z.string().uuid();

export const supervisedCandidateSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: uuid,
  createdAt: isoDateTime,
  selectionReferenceTime: isoDateTime,
  hours: z.number().int().positive().max(168),
  eventKey: z.string().regex(/^event-[a-f0-9]{32}$/),
  title: z.string().trim().min(1).max(500),
  items: z.array(z.object({
    sourceItemId: z.string().trim().min(1).max(300),
    rawItemId: uuid,
    sourceId: uuid,
    externalId: z.string().trim().min(1).max(300),
    sourceName: z.string().trim().min(1).max(200),
    sourceType: z.string().trim().min(1).max(40),
    countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
    sourceUrl: httpUrl,
    feedUrl: httpUrl.nullable(),
    originalUrl: httpUrl,
    canonicalUrl: httpUrl,
    title: z.string().trim().min(1).max(500),
    excerpt: z.string().max(2000).nullable(),
    language: z.string().trim().min(2).max(12),
    contentHash: z.string().trim().min(8).max(256),
    publishedAt: isoDateTime.nullable(),
    discoveredAt: isoDateTime,
    effectiveFreshnessAt: isoDateTime,
    freshnessExpiresAt: isoDateTime,
    extractionStatus: z.string().trim().min(1).max(40),
    extractionQuality: z.enum(["full", "partial", "metadata_only", "failed"]),
    extractedCharacters: z.number().int().nonnegative(),
    ownership: z.literal(true),
  }).strict()).min(1).max(100),
  sourceItemIds: z.array(z.string().min(1)).min(1).max(100),
  rawItemIds: z.array(uuid).min(1).max(100),
  sourceIds: z.array(uuid).min(1).max(100),
  contentHashes: z.array(z.string().min(8)).min(1).max(100),
  attemptCount: z.number().int().nonnegative(),
  eligibility: z.object({
    eligible: z.literal(true),
    activeClaim: z.literal(false),
    quarantined: z.literal(false),
    nextEligibleAt: isoDateTime.nullable(),
  }).strict(),
  ownership: z.literal(true),
  integrityHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((snapshot, context) => {
  const pairs = [
    [snapshot.sourceItemIds, snapshot.items.map((item) => item.sourceItemId)],
    [snapshot.rawItemIds, snapshot.items.map((item) => item.rawItemId)],
    [snapshot.sourceIds, snapshot.items.map((item) => item.sourceId)],
    [snapshot.contentHashes, snapshot.items.map((item) => item.contentHash)],
  ];
  if (pairs.some(([actual, expected]) => JSON.stringify(actual) !== JSON.stringify(expected))) {
    context.addIssue({ code: "custom", message: "Snapshot identity arrays must align with item records" });
  }
  if (new Set(snapshot.sourceItemIds).size !== snapshot.sourceItemIds.length) {
    context.addIssue({ code: "custom", path: ["sourceItemIds"], message: "Source item identities must be unique" });
  }
});

export type SupervisedCandidateSnapshot = z.infer<typeof supervisedCandidateSnapshotSchema>;
export type SnapshotSource = { id: string; name: string; url: string; feedUrl: string | null; sourceType: string; countryCode: string | null; language: string; isActive: boolean };
export type SnapshotRawItem = { id: string; sourceId: string; externalId: string | null; originalUrl: string; canonicalUrl: string | null; title: string | null; excerpt: string | null; language: string | null; publishedAt: string | null; discoveredAt: string; contentHash: string | null; processingStatus: string; extractionQuality: string | null; rawContent: string | null; normalizedPayload: unknown };
export type SnapshotAttemptState = { attempts: number; eligible: boolean; activeClaim: boolean; quarantined: boolean; nextEligibleAt: string | null };
export type SnapshotValidationStore = {
  getRawItem(id: string): Promise<SnapshotRawItem | null>;
  getSource(id: string): Promise<SnapshotSource | null>;
  getAttemptState(eventKey: string, now: Date): Promise<SnapshotAttemptState>;
  hasArticle(eventKey: string): Promise<boolean>;
};

type SnapshotItemInput = { rawItem: SnapshotRawItem; source: SnapshotSource };

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalize(record[key])).join(",") + "}";
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function snapshotContent(snapshot: SupervisedCandidateSnapshot): Omit<SupervisedCandidateSnapshot, "integrityHash"> {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "integrityHash")) as Omit<SupervisedCandidateSnapshot, "integrityHash">;
}

export function supervisedSnapshotIntegrity(snapshot: SupervisedCandidateSnapshot): string {
  return digest(snapshotContent(snapshot));
}

function sourceHostMatches(urlValue: string, source: SnapshotSource): boolean {
  const itemHost = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, "");
  const registeredHosts = [source.url, source.feedUrl].filter((value): value is string => Boolean(value))
    .map((value) => new URL(value).hostname.toLowerCase().replace(/^www\./, ""));
  return registeredHosts.includes(itemHost);
}

function sourceItemMatches(item: SupervisedCandidateSnapshot["items"][number], raw: SnapshotRawItem, source: SnapshotSource): boolean {
  return raw.id === item.rawItemId
    && raw.sourceId === item.sourceId && source.id === item.sourceId
    && raw.externalId === item.externalId && item.sourceItemId === raw.externalId
    && item.externalId === candidateExternalId(source.id, canonicalizeUrl(item.originalUrl))
    && raw.originalUrl === item.originalUrl && (raw.canonicalUrl ?? raw.originalUrl) === item.canonicalUrl
    && raw.title === item.title && raw.excerpt === item.excerpt && (raw.language ?? source.language) === item.language
    && raw.publishedAt === item.publishedAt && raw.discoveredAt === item.discoveredAt
    && raw.contentHash === item.contentHash && raw.processingStatus === item.extractionStatus
    && raw.extractionQuality === item.extractionQuality && (raw.rawContent?.length ?? 0) === item.extractedCharacters
    && Boolean(raw.rawContent) && hashContent(raw.rawContent ?? "") === item.contentHash
    && source.name === item.sourceName && source.sourceType === item.sourceType && source.countryCode === item.countryCode && source.url === item.sourceUrl && source.feedUrl === item.feedUrl
    && source.isActive && sourceHostMatches(item.canonicalUrl, source) && sourceHostMatches(item.originalUrl, source);
}

function eventKeyMatches(snapshot: SupervisedCandidateSnapshot): boolean {
  const items = snapshot.items.map((entry) => ({
    schemaVersion: 1 as const,
    candidateId: entry.sourceItemId,
    url: entry.originalUrl,
    canonicalUrl: entry.canonicalUrl,
    title: entry.title,
    description: entry.excerpt,
    author: null,
    publishedAt: entry.publishedAt,
    language: entry.language,
    content: "[source content omitted from snapshot]",
    contentHash: entry.contentHash,
    extractionQuality: entry.extractionQuality,
    metadata: { sourceId: entry.sourceId, sourceName: entry.sourceName, sourceCountryCode: entry.countryCode },
  }));
  const ids = snapshot.sourceItemIds.toSorted();
  const event = clusterExtractedItems(items).events.find((candidate) =>
    JSON.stringify(candidate.sourceItems.map((item) => item.candidateId).sort()) === JSON.stringify(ids));
  return event?.eventKey === snapshot.eventKey && event.canonicalTitle === snapshot.title;
}

export function createSupervisedCandidateSnapshot(input: {
  eventKey: string;
  title: string;
  items: SnapshotItemInput[];
  referenceTime: Date;
  createdAt?: Date;
  hours: number;
  attemptState: SnapshotAttemptState;
  snapshotId?: string;
}): SupervisedCandidateSnapshot {
  if (!input.attemptState.eligible || input.attemptState.activeClaim || input.attemptState.quarantined) throw new Error("SNAPSHOT_ATTEMPT_STATE_INELIGIBLE");
  if (input.items.length === 0) throw new Error("SNAPSHOT_REQUIRES_SOURCE_ITEMS");
  const items = input.items.map(({ rawItem, source }) => {
    if (!rawItem.externalId || !rawItem.title || !rawItem.contentHash || !rawItem.extractionQuality) throw new Error("SNAPSHOT_RAW_ITEM_INCOMPLETE");
    if (rawItem.sourceId !== source.id || rawItem.externalId !== candidateExternalId(source.id, canonicalizeUrl(rawItem.originalUrl)) || !source.isActive) throw new Error("SNAPSHOT_SOURCE_OWNERSHIP_MISMATCH");
    if (!sourceHostMatches(rawItem.canonicalUrl ?? rawItem.originalUrl, source) || !sourceHostMatches(rawItem.originalUrl, source)) throw new Error("SNAPSHOT_SOURCE_URL_MISMATCH");
    const freshness = evaluateContentFreshness({ sourceItemId: rawItem.externalId, rawItemId: rawItem.id, publishedAt: rawItem.publishedAt, discoveredAt: rawItem.discoveredAt }, input.referenceTime, input.hours);
    if (!freshness.eligible || !freshness.effectiveFreshnessAt) throw new Error("SNAPSHOT_EXPIRED_BEFORE_CREATION");
    return {
      sourceItemId: rawItem.externalId, rawItemId: rawItem.id, sourceId: source.id, externalId: rawItem.externalId,
      sourceName: source.name, sourceType: source.sourceType, sourceUrl: source.url, feedUrl: source.feedUrl,
      countryCode: source.countryCode,
      originalUrl: rawItem.originalUrl, canonicalUrl: rawItem.canonicalUrl ?? rawItem.originalUrl,
      title: rawItem.title, excerpt: rawItem.excerpt, language: rawItem.language ?? source.language,
      contentHash: rawItem.contentHash, publishedAt: rawItem.publishedAt, discoveredAt: rawItem.discoveredAt,
      effectiveFreshnessAt: freshness.effectiveFreshnessAt,
      freshnessExpiresAt: new Date(Date.parse(freshness.effectiveFreshnessAt) + input.hours * 3_600_000).toISOString(),
      extractionStatus: rawItem.processingStatus, extractionQuality: rawItem.extractionQuality,
      extractedCharacters: rawItem.rawContent?.length ?? 0, ownership: true as const,
    };
  });
  const base = {
    schemaVersion: 1 as const, snapshotId: input.snapshotId ?? randomUUID(),
    createdAt: (input.createdAt ?? new Date()).toISOString(), selectionReferenceTime: input.referenceTime.toISOString(),
    hours: input.hours, eventKey: input.eventKey, title: input.title, items,
    sourceItemIds: items.map((item) => item.sourceItemId), rawItemIds: items.map((item) => item.rawItemId),
    sourceIds: items.map((item) => item.sourceId), contentHashes: items.map((item) => item.contentHash),
    attemptCount: input.attemptState.attempts,
    eligibility: { eligible: true as const, activeClaim: false as const, quarantined: false as const, nextEligibleAt: input.attemptState.nextEligibleAt },
    ownership: true as const,
  };
  const snapshot = supervisedCandidateSnapshotSchema.parse({ ...base, integrityHash: digest(base) });
  if (!eventKeyMatches(snapshot)) throw new Error("SNAPSHOT_EVENT_KEY_RECONSTRUCTION_MISMATCH");
  return snapshot;
}

export async function validateSupervisedCandidateSnapshot(value: unknown, store: SnapshotValidationStore, now = new Date()): Promise<{ valid: boolean; reasons: string[]; snapshot: SupervisedCandidateSnapshot | null }> {
  const parsed = supervisedCandidateSnapshotSchema.safeParse(value);
  if (!parsed.success) return { valid: false, reasons: ["SNAPSHOT_SCHEMA_INVALID"], snapshot: null };
  const snapshot = parsed.data;
  const reasons: string[] = [];
  if (supervisedSnapshotIntegrity(snapshot) !== snapshot.integrityHash) reasons.push("SNAPSHOT_INTEGRITY_MISMATCH");
  if (!eventKeyMatches(snapshot)) reasons.push("SNAPSHOT_EVENT_KEY_MISMATCH");
  for (const item of snapshot.items) {
    const raw = await store.getRawItem(item.rawItemId);
    if (!raw) { reasons.push("RAW_ITEM_MISSING"); continue; }
    const source = await store.getSource(item.sourceId);
    if (!source || !sourceItemMatches(item, raw, source)) reasons.push("SOURCE_OR_EXTRACTION_IDENTITY_MISMATCH");
    const freshness = evaluateContentFreshness({ sourceItemId: item.sourceItemId, rawItemId: item.rawItemId, publishedAt: raw.publishedAt, discoveredAt: raw.discoveredAt }, now, snapshot.hours);
    if (!freshness.eligible || freshness.effectiveFreshnessAt !== item.effectiveFreshnessAt || now.getTime() > Date.parse(item.freshnessExpiresAt)) reasons.push("SNAPSHOT_FRESHNESS_EXPIRED_OR_CHANGED");
  }
  const attempt = await store.getAttemptState(snapshot.eventKey, now);
  if (attempt.attempts !== snapshot.attemptCount) reasons.push("SNAPSHOT_ATTEMPT_COUNT_CHANGED");
  if (!attempt.eligible || attempt.activeClaim || attempt.quarantined) reasons.push("SNAPSHOT_ATTEMPT_NOT_ELIGIBLE");
  if (attempt.nextEligibleAt !== snapshot.eligibility.nextEligibleAt) reasons.push("SNAPSHOT_ATTEMPT_WINDOW_CHANGED");
  if (await store.hasArticle(snapshot.eventKey)) reasons.push("SNAPSHOT_ARTICLE_EXISTS");
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], snapshot };
}

/** Resume validation is bound to an already-claimed lineage: validate its original freshness, not freshness at resume time. */
export async function validateSupervisedCandidateSnapshotForResume(
  value: unknown,
  store: SnapshotValidationStore,
  originalClaimStartedAt: Date,
): Promise<{ valid: boolean; reasons: string[]; snapshot: SupervisedCandidateSnapshot | null }> {
  const parsed = supervisedCandidateSnapshotSchema.safeParse(value);
  if (!parsed.success) return { valid: false, reasons: ["SNAPSHOT_SCHEMA_INVALID"], snapshot: null };
  const snapshot = parsed.data;
  const reasons: string[] = [];
  const claimTime = originalClaimStartedAt.getTime();
  if (supervisedSnapshotIntegrity(snapshot) !== snapshot.integrityHash) reasons.push("SNAPSHOT_INTEGRITY_MISMATCH");
  if (!eventKeyMatches(snapshot)) reasons.push("SNAPSHOT_EVENT_KEY_MISMATCH");
  if (!Number.isFinite(claimTime) || Date.parse(snapshot.createdAt) > claimTime) reasons.push("SNAPSHOT_NOT_CREATED_BEFORE_ORIGINAL_CLAIM");
  for (const item of snapshot.items) {
    if (claimTime < Date.parse(item.effectiveFreshnessAt) || claimTime > Date.parse(item.freshnessExpiresAt)) reasons.push("SNAPSHOT_NOT_FRESH_AT_ORIGINAL_CLAIM");
    const raw = await store.getRawItem(item.rawItemId);
    if (!raw) { reasons.push("RAW_ITEM_MISSING"); continue; }
    const source = await store.getSource(item.sourceId);
    if (!source || !sourceItemMatches(item, raw, source)) reasons.push("SNAPSHOT_CONTENT_CHANGED_OR_SOURCE_OWNERSHIP_INVALID");
  }
  const attempt = await store.getAttemptState(snapshot.eventKey, originalClaimStartedAt);
  if (attempt.activeClaim) reasons.push("ACTIVE_CLAIM_EXISTS");
  if (await store.hasArticle(snapshot.eventKey)) reasons.push("SNAPSHOT_ARTICLE_EXISTS");
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], snapshot };
}

export function supervisedSnapshotPath(snapshotId: string, root = "artifacts/supervised-candidates"): string {
  if (!uuid.safeParse(snapshotId).success) throw new Error("INVALID_SNAPSHOT_ID");
  return join(root, snapshotId + ".json");
}

export async function writeSupervisedCandidateSnapshot(snapshot: SupervisedCandidateSnapshot, path = supervisedSnapshotPath(snapshot.snapshotId)): Promise<void> {
  const parsed = supervisedCandidateSnapshotSchema.parse(snapshot);
  if (supervisedSnapshotIntegrity(parsed) !== parsed.integrityHash || !eventKeyMatches(parsed)) throw new Error("SNAPSHOT_INTEGRITY_OR_EVENT_KEY_INVALID");
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = path + "." + randomUUID() + ".tmp";
  await writeFile(temporaryPath, JSON.stringify(parsed, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, path);
}

export async function readSupervisedCandidateSnapshot(path: string): Promise<SupervisedCandidateSnapshot> {
  const snapshot = supervisedCandidateSnapshotSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (supervisedSnapshotIntegrity(snapshot) !== snapshot.integrityHash || !eventKeyMatches(snapshot)) throw new Error("SNAPSHOT_INTEGRITY_OR_EVENT_KEY_INVALID");
  return snapshot;
}

/** Future execution APIs must take a validated snapshot, never a free-form event key. */
export function supervisedExecutionEventKey(validation: { valid: boolean; snapshot: SupervisedCandidateSnapshot | null }): string {
  if (!validation.valid || !validation.snapshot) throw new Error("VALID_SUPERVISED_SNAPSHOT_REQUIRED");
  return validation.snapshot.eventKey;
}
