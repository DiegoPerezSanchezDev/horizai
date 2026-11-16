import { z } from "zod";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clusteredEventSchema, translationResultSchema, verificationResultSchema } from "../contracts/index.ts";
import { translatorModelInputSchema, sourceMetadataSchema } from "./translator-types.ts";

/** Safe, replayable Translator input. It contains no raw article or provider secret. */
export const translatorCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  eventKey: z.string().trim().min(1).max(200),
  event: clusteredEventSchema,
  verification: verificationResultSchema,
  /** Present on the post-Translator checkpoint; absent on the Verifier checkpoint. */
  translationResult: translationResultSchema.optional(),
  sourceLanguage: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  sources: z.array(sourceMetadataSchema).min(1).max(100),
  translatorModelInput: translatorModelInputSchema,
}).strict().refine(
  (checkpoint) => checkpoint.eventKey === checkpoint.event.eventKey
    && checkpoint.eventKey === checkpoint.verification.eventKey
    && checkpoint.eventKey === checkpoint.translatorModelInput.eventKey
    && (checkpoint.translationResult === undefined || checkpoint.translationResult.eventKey === checkpoint.eventKey)
    && checkpoint.sourceLanguage === checkpoint.translatorModelInput.sourceLanguage,
  "Checkpoint identifiers and language must remain consistent"
);

export type TranslatorCheckpoint = z.infer<typeof translatorCheckpointSchema>;

export type CheckpointFileSystem = {
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

export const nodeCheckpointFileSystem: CheckpointFileSystem = {
  async mkdir(path, options) { await mkdir(path, options); },
  async writeFile(path, data, encoding) { await writeFile(path, data, encoding); },
  async rename(oldPath, newPath) { await rename(oldPath, newPath); },
  async unlink(path) { await unlink(path); },
  async readFile(path, encoding) { return readFile(path, encoding); },
};

const forbiddenCheckpointKeys = new Set([
  "html",
  "raw_content",
  "rawcontent",
  "authorization",
  "api_key",
  "apikey",
  "prompt",
  "systeminstructions",
  "reasoning",
  "chainofthought",
]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function findForbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    const current = forbiddenCheckpointKeys.has(normalized) ? [`${path}.${key}`] : [];
    return [...current, ...findForbiddenKeys(child, `${path}.${key}`)];
  });
}

export function parseSafeTranslatorCheckpoint(raw: string): TranslatorCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Translator checkpoint is not valid JSON");
  }
  const forbidden = findForbiddenKeys(parsed);
  if (forbidden.length > 0) throw new Error(`Translator checkpoint contains prohibited fields: ${forbidden.join(", ")}`);
  return translatorCheckpointSchema.parse(parsed);
}

export async function writeTranslatorCheckpointAtomic(
  checkpoint: TranslatorCheckpoint,
  targetPath = "artifacts/pipeline-verifier-checkpoint.json",
  fileSystem: CheckpointFileSystem = nodeCheckpointFileSystem
): Promise<{ path: string; bytes: number }> {
  const validated = translatorCheckpointSchema.parse(checkpoint);
  const serialized = JSON.stringify(validated, null, 2) + "\n";
  const temporaryPath = `${targetPath}.tmp`;
  await fileSystem.mkdir(dirname(targetPath), { recursive: true });
  try {
    await fileSystem.writeFile(temporaryPath, serialized, "utf8");
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    try { await fileSystem.unlink(temporaryPath); } catch { /* Preserve the original write failure. */ }
    throw new Error("Unable to atomically write Translator checkpoint", { cause: error });
  }
  return { path: targetPath, bytes: byteLength(serialized) };
}

export async function readSafeTranslatorCheckpoint(
  path = "artifacts/pipeline-verifier-checkpoint.json",
  fileSystem: CheckpointFileSystem = nodeCheckpointFileSystem
): Promise<TranslatorCheckpoint> {
  const raw = await fileSystem.readFile(path, "utf8");
  return parseSafeTranslatorCheckpoint(raw);
}
