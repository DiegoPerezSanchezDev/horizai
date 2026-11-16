import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { clusteredEventSchema, editorialDraftSchema, translationResultSchema, verificationResultSchema } from "../contracts/index.ts";

const httpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), "URL must use http or https");
const sourceSchema = z.object({
  sourceId: z.string().uuid(), sourceName: z.string().trim().min(1).max(200), canonicalUrl: httpUrl, sourceType: z.string().trim().min(1).max(100).nullable(),
}).strict();

export const translatorEditorCheckpointSchema = z.object({
  schemaVersion: z.literal(1), eventKey: z.string().trim().min(1).max(200), canonicalTitle: z.string().trim().min(1).max(500),
  event: clusteredEventSchema, verification: verificationResultSchema, translation: translationResultSchema,
  /** Exact validated Editor output. Legacy checkpoints may omit it but cannot be used for resume. */
  editorial: editorialDraftSchema.optional(),
  sources: z.array(sourceSchema).min(1).max(100),
}).strict().refine((value) => value.eventKey === value.event.eventKey && value.eventKey === value.verification.eventKey && value.eventKey === value.translation.eventKey && (value.editorial === undefined || value.editorial.eventKey === value.eventKey), "Translator checkpoint identifiers must remain consistent");
export type TranslatorEditorCheckpoint = z.infer<typeof translatorEditorCheckpointSchema>;

export type TranslatorEditorCheckpointFileSystem = { mkdir(path: string, options: { recursive: boolean }): Promise<void>; writeFile(path: string, data: string, encoding: "utf8"): Promise<void>; rename(oldPath: string, newPath: string): Promise<void>; unlink(path: string): Promise<void>; readFile(path: string, encoding: "utf8"): Promise<string> };
const nodeFileSystem: TranslatorEditorCheckpointFileSystem = { async mkdir(path, options) { await mkdir(path, options); }, async writeFile(path, data, encoding) { await writeFile(path, data, encoding); }, async rename(oldPath, newPath) { await rename(oldPath, newPath); }, async unlink(path) { await unlink(path); }, async readFile(path, encoding) { return readFile(path, encoding); } };
const forbidden = new Set(["html", "raw_content", "rawcontent", "authorization", "api_key", "apikey", "prompt", "systeminstructions", "reasoning", "chainofthought", "secret"]);
function findForbidden(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findForbidden(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => { const normalized = key.replace(/[-_]/g, "").toLowerCase(); return [...(forbidden.has(normalized) ? [`${path}.${key}`] : []), ...findForbidden(child, `${path}.${key}`)]; });
}
export function parseSafeTranslatorEditorCheckpoint(raw: string): TranslatorEditorCheckpoint {
  let value: unknown; try { value = JSON.parse(raw) as unknown; } catch { throw new Error("Translator-to-editor checkpoint is not valid JSON"); }
  const blocked = findForbidden(value); if (blocked.length > 0) throw new Error(`Translator-to-editor checkpoint contains prohibited fields: ${blocked.join(", ")}`);
  return translatorEditorCheckpointSchema.parse(value);
}
export async function writeTranslatorEditorCheckpointAtomic(checkpoint: TranslatorEditorCheckpoint, targetPath = "artifacts/pipeline-translator-checkpoint.json", fileSystem: TranslatorEditorCheckpointFileSystem = nodeFileSystem): Promise<{ path: string; bytes: number }> {
  const serialized = `${JSON.stringify(translatorEditorCheckpointSchema.parse(checkpoint), null, 2)}\n`; const temporaryPath = `${targetPath}.tmp`;
  await fileSystem.mkdir(dirname(targetPath), { recursive: true });
  try { await fileSystem.writeFile(temporaryPath, serialized, "utf8"); await fileSystem.rename(temporaryPath, targetPath); } catch (error) { try { await fileSystem.unlink(temporaryPath); } catch { /* preserve original error */ } throw new Error("Unable to atomically write Translator-to-editor checkpoint", { cause: error }); }
  return { path: targetPath, bytes: new TextEncoder().encode(serialized).byteLength };
}
export async function readSafeTranslatorEditorCheckpoint(path = "artifacts/pipeline-translator-checkpoint.json", fileSystem: TranslatorEditorCheckpointFileSystem = nodeFileSystem): Promise<TranslatorEditorCheckpoint> { return parseSafeTranslatorEditorCheckpoint(await fileSystem.readFile(path, "utf8")); }
