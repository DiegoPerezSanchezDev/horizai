import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { classificationResultSchema, editorialDraftSchema, translationResultSchema, verificationResultSchema } from "../contracts/index.ts";
import { sourceMetadataSchema } from "../translator/translator-types.ts";

const eventSchema = z.object({
  eventKey: z.string().trim().min(1).max(200),
  canonicalTitle: z.string().trim().min(1).max(500),
  sourceCount: z.number().int().positive().max(100),
  occurredAt: z.iso.datetime({ offset: true }).nullable(),
  latestPublishedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();

const translationSchema = translationResultSchema.pick({ schemaVersion: true, eventKey: true, sourceLanguage: true, targetLanguage: true, translatedTitle: true, translatedFacts: true, preservedNames: true, translationNotes: true });
const editorialSchema = editorialDraftSchema.pick({ schemaVersion: true, eventKey: true, headlineEs: true, summaryEs: true, whyItMattersEs: true, keyPoints: true });

export const classifierPipelineCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  eventKey: z.string().trim().min(1).max(200),
  canonicalTitle: z.string().trim().min(1).max(500),
  event: eventSchema,
  verification: verificationResultSchema,
  translation: translationSchema,
  editorial: editorialSchema,
  classification: classificationResultSchema,
  sources: z.array(sourceMetadataSchema).min(1).max(100),
  createdAt: z.iso.datetime({ offset: true }),
}).strict().refine((value) => value.eventKey === value.event.eventKey && value.eventKey === value.verification.eventKey && value.eventKey === value.translation.eventKey && value.eventKey === value.editorial.eventKey && value.eventKey === value.classification.eventKey, "Classifier checkpoint identifiers must remain consistent");

export type ClassifierPipelineCheckpoint = z.infer<typeof classifierPipelineCheckpointSchema>;

export type ClassifierPipelineCheckpointFileSystem = {
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

const nodeFileSystem: ClassifierPipelineCheckpointFileSystem = { async mkdir(path, options) { await mkdir(path, options); }, async writeFile(path, data, encoding) { await writeFile(path, data, encoding); }, async rename(oldPath, newPath) { await rename(oldPath, newPath); }, async unlink(path) { await unlink(path); }, async readFile(path, encoding) { return readFile(path, encoding); } };
const forbidden = new Set(["html", "raw_content", "rawcontent", "authorization", "api_key", "apikey", "prompt", "systeminstructions", "reasoning", "chainofthought", "secret"]);

function forbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenKeys(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    return [...(forbidden.has(normalized) ? [`${path}.${key}`] : []), ...forbiddenKeys(child, `${path}.${key}`)];
  });
}

export function parseSafeClassifierPipelineCheckpoint(raw: string): ClassifierPipelineCheckpoint {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("Classifier pipeline checkpoint is not valid JSON"); }
  const blocked = forbiddenKeys(parsed);
  if (blocked.length > 0) throw new Error(`Classifier pipeline checkpoint contains prohibited fields: ${blocked.join(", ")}`);
  return classifierPipelineCheckpointSchema.parse(parsed);
}

export async function writeClassifierPipelineCheckpointAtomic(checkpoint: ClassifierPipelineCheckpoint, targetPath = "artifacts/pipeline-classifier-checkpoint.json", fileSystem: ClassifierPipelineCheckpointFileSystem = nodeFileSystem): Promise<{ path: string; bytes: number }> {
  const serialized = `${JSON.stringify(classifierPipelineCheckpointSchema.parse(checkpoint), null, 2)}\n`;
  const temporaryPath = `${targetPath}.tmp`;
  await fileSystem.mkdir(dirname(targetPath), { recursive: true });
  try {
    await fileSystem.writeFile(temporaryPath, serialized, "utf8");
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    try { await fileSystem.unlink(temporaryPath); } catch { /* Preserve original failure. */ }
    throw new Error("Unable to atomically write Classifier pipeline checkpoint", { cause: error });
  }
  return { path: targetPath, bytes: new TextEncoder().encode(serialized).byteLength };
}

export async function readSafeClassifierPipelineCheckpoint(path = "artifacts/pipeline-classifier-checkpoint.json", fileSystem: ClassifierPipelineCheckpointFileSystem = nodeFileSystem): Promise<ClassifierPipelineCheckpoint> {
  return parseSafeClassifierPipelineCheckpoint(await fileSystem.readFile(path, "utf8"));
}
