import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { editorialDraftSchema, translationResultSchema, verificationResultSchema } from "../contracts/index.ts";
import { sourceMetadataSchema } from "../translator/translator-types.ts";
import { criticInputSchema, type CriticInput, type CriticRankingCheckpoint } from "./critic-types.ts";

const rankerCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  eventKey: z.string().trim().min(1).max(200),
  canonicalTitle: z.string().trim().min(1).max(500),
  event: z.object({
    eventKey: z.string().trim().min(1).max(200),
    canonicalTitle: z.string().trim().min(1).max(500),
    sourceCount: z.number().int().positive().max(100),
    occurredAt: z.iso.datetime({ offset: true }).nullable(),
    latestPublishedAt: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
  verification: verificationResultSchema,
  translation: translationResultSchema,
  editorial: editorialDraftSchema,
  classification: criticInputSchema.shape.classification,
  ranking: criticInputSchema.shape.ranking,
  sources: z.array(sourceMetadataSchema).min(1).max(100),
  sourceEvidence: criticInputSchema.shape.sourceEvidence,
  geo: criticInputSchema.shape.geo,
  createdAt: z.iso.datetime({ offset: true }),
}).strict().refine((value) => value.eventKey === value.event.eventKey && value.eventKey === value.verification.eventKey && value.eventKey === value.translation.eventKey && value.eventKey === value.editorial.eventKey && value.eventKey === value.classification.eventKey && value.eventKey === value.ranking.result.eventKey, "Ranker checkpoint identifiers must remain consistent").refine((value) => value.event.sourceCount === value.sources.length && value.ranking.deterministicSignals.sourceCount === value.sources.length, "Ranker checkpoint source counts must remain consistent");

export type RankerPipelineCheckpoint = z.infer<typeof rankerCheckpointSchema>;
export { rankerCheckpointSchema };

export function buildRankerPipelineCheckpoint(input: Omit<CriticInput, "ranking">, ranking: CriticRankingCheckpoint, createdAt = new Date().toISOString()): RankerPipelineCheckpoint {
  return rankerCheckpointSchema.parse({ ...input, eventKey: input.event.eventKey, canonicalTitle: input.event.canonicalTitle, ranking, createdAt });
}

export type RankerCheckpointFileSystem = {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

const nodeFileSystem: RankerCheckpointFileSystem = {
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

export function parseSafeRankerPipelineCheckpoint(raw: string): RankerPipelineCheckpoint {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("Ranker pipeline checkpoint is not valid JSON"); }
  const blocked = forbiddenKeys(parsed);
  if (blocked.length > 0) throw new Error(`Ranker pipeline checkpoint contains prohibited fields: ${blocked.join(", ")}`);
  return rankerCheckpointSchema.parse(parsed);
}

export async function writeRankerPipelineCheckpointAtomic(checkpoint: RankerPipelineCheckpoint, targetPath = "artifacts/pipeline-ranker-checkpoint.json", fileSystem: RankerCheckpointFileSystem = nodeFileSystem): Promise<{ path: string; bytes: number }> {
  const serialized = `${JSON.stringify(rankerCheckpointSchema.parse(checkpoint), null, 2)}\n`;
  const temporaryPath = `${targetPath}.tmp`;
  await fileSystem.mkdir(dirname(targetPath), { recursive: true });
  try {
    await fileSystem.writeFile(temporaryPath, serialized, "utf8");
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    try { await fileSystem.unlink(temporaryPath); } catch { /* Preserve original failure. */ }
    throw new Error("Unable to atomically write Ranker pipeline checkpoint", { cause: error });
  }
  return { path: targetPath, bytes: new TextEncoder().encode(serialized).byteLength };
}

export async function readSafeRankerPipelineCheckpoint(path = "artifacts/pipeline-ranker-checkpoint.json", fileSystem: RankerCheckpointFileSystem = nodeFileSystem): Promise<RankerPipelineCheckpoint> {
  return parseSafeRankerPipelineCheckpoint(await fileSystem.readFile(path, "utf8"));
}
