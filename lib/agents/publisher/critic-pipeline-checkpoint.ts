import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { clusteredEventSchema, criticResultSchema } from "../contracts/index.ts";
import { rankerCheckpointSchema, type RankerPipelineCheckpoint } from "../critic/ranker-pipeline-checkpoint.ts";

const reviewAccountingSchema = z.object({
  provider: z.enum(["groq", "cerebras", "cloudflare_workers_ai"]),
  model: z.string().trim().min(1),
  requestCount: z.number().int().positive(),
  attempts: z.number().int().positive(),
  retries: z.number().int().nonnegative(),
  providerRequestDispatched: z.literal(true),
  providerUnit: z.enum(["requests", "tokens", "neurons"]).nullable(),
  providerUnitUsageKnown: z.literal(true),
  actualProviderUnitUsage: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().positive().nullable(),
  settlement: z.literal("SETTLED"),
}).strict();

const reviewSourceLineageSchema = z.object({
  sourceId: z.string().uuid(),
  sourceItemId: z.string().trim().min(1).max(300),
  rawItemId: z.string().uuid(),
  sourceName: z.string().trim().min(1).max(200),
  contentHash: z.string().trim().min(8),
  canonicalUrl: z.string().url(),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

const accountingStages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const;
const reviewPackageContextSchema = z.object({
  canonicalEvent: clusteredEventSchema,
  sourceLineage: z.array(reviewSourceLineageSchema).min(1).max(100),
  providerAccounting: z.object(Object.fromEntries(accountingStages.map((stage) => [stage, reviewAccountingSchema])) as Record<(typeof accountingStages)[number], typeof reviewAccountingSchema>).strict(),
}).strict();
export type CriticReviewPackageContext = z.infer<typeof reviewPackageContextSchema>;

export const criticPipelineCheckpointSchema = rankerCheckpointSchema.extend({
  critic: criticResultSchema,
  /** Event-attempt identity for supervised durable Critic PASS proof. */
  attemptId: z.string().uuid().optional(),
  /** Minimal durable evidence needed to rebuild a supervised review package after process loss. */
  reviewPackageContext: reviewPackageContextSchema.optional(),
}).refine((value) => value.critic.eventKey === value.eventKey, "Critic checkpoint identifiers must remain consistent")
  .refine((value) => !value.reviewPackageContext || value.reviewPackageContext.canonicalEvent.eventKey === value.eventKey, "Critic review context event must remain consistent")
  .refine((value) => !value.reviewPackageContext || value.reviewPackageContext.sourceLineage.length === value.sources.length
    && value.reviewPackageContext.sourceLineage.every((entry) => value.sources.some((source) => source.sourceId === entry.sourceId && source.sourceItemId === entry.sourceItemId)), "Critic review context source lineage must remain consistent");

export type CriticPipelineCheckpoint = z.infer<typeof criticPipelineCheckpointSchema>;

export function buildCriticPipelineCheckpoint(rankerCheckpoint: RankerPipelineCheckpoint, critic: z.infer<typeof criticResultSchema>, createdAt = new Date().toISOString(), reviewPackageContext?: CriticReviewPackageContext, attemptId?: string): CriticPipelineCheckpoint {
  return criticPipelineCheckpointSchema.parse({ ...rankerCheckpoint, critic, createdAt, ...(attemptId ? { attemptId } : {}), ...(reviewPackageContext ? { reviewPackageContext } : {}) });
}

export type CriticCheckpointFileSystem = {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

const nodeFileSystem: CriticCheckpointFileSystem = {
  async mkdir(path, options) { await mkdir(path, options); },
  async writeFile(path, data, encoding) { await writeFile(path, data, encoding); },
  async rename(oldPath, newPath) { await rename(oldPath, newPath); },
  async unlink(path) { await unlink(path); },
  async readFile(path, encoding) { return readFile(path, encoding); },
};

const forbidden = new Set(["html", "raw_content", "rawcontent", "authorization", "api_key", "apikey", "prompt", "systeminstructions", "reasoning", "chainofthought", "secret"]);
function forbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenKeys(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    return [...(forbidden.has(normalized) ? [`${path}.${key}`] : []), ...forbiddenKeys(child, `${path}.${key}`)];
  });
}

export function parseSafeCriticPipelineCheckpoint(raw: string): CriticPipelineCheckpoint {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("Critic pipeline checkpoint is not valid JSON"); }
  const blocked = forbiddenKeys(parsed);
  if (blocked.length > 0) throw new Error(`Critic pipeline checkpoint contains prohibited fields: ${blocked.join(", ")}`);
  return criticPipelineCheckpointSchema.parse(parsed);
}

export async function writeCriticPipelineCheckpointAtomic(checkpoint: CriticPipelineCheckpoint, targetPath = "artifacts/pipeline-critic-checkpoint.json", fileSystem: CriticCheckpointFileSystem = nodeFileSystem): Promise<{ path: string; bytes: number }> {
  const serialized = `${JSON.stringify(criticPipelineCheckpointSchema.parse(checkpoint), null, 2)}\n`;
  const temporaryPath = `${targetPath}.tmp`;
  await fileSystem.mkdir(dirname(targetPath), { recursive: true });
  try {
    await fileSystem.writeFile(temporaryPath, serialized, "utf8");
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    try { await fileSystem.unlink(temporaryPath); } catch { /* Preserve original failure. */ }
    throw new Error("Unable to atomically write Critic pipeline checkpoint", { cause: error });
  }
  return { path: targetPath, bytes: new TextEncoder().encode(serialized).byteLength };
}

export async function readSafeCriticPipelineCheckpoint(path = "artifacts/pipeline-critic-checkpoint.json", fileSystem: CriticCheckpointFileSystem = nodeFileSystem): Promise<CriticPipelineCheckpoint> {
  return parseSafeCriticPipelineCheckpoint(await fileSystem.readFile(path, "utf8"));
}
