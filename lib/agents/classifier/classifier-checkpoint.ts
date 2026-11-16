import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { editorialDraftSchema, translationResultSchema, verificationResultSchema } from "../contracts/index.ts";
import { sourceMetadataSchema } from "../translator/translator-types.ts";

export const editorPipelineCheckpointSchema = z.object({
  schemaVersion: z.literal(1),
  eventKey: z.string().trim().min(1).max(200),
  canonicalTitle: z.string().trim().min(1).max(500),
  verification: verificationResultSchema,
  translation: translationResultSchema,
  editorial: editorialDraftSchema,
  sources: z.array(sourceMetadataSchema).min(1).max(100),
}).strict().refine((value) => value.eventKey === value.verification.eventKey && value.eventKey === value.translation.eventKey && value.eventKey === value.editorial.eventKey, "Editor checkpoint identifiers must remain consistent");

export type EditorPipelineCheckpoint = z.infer<typeof editorPipelineCheckpointSchema>;
export type ClassifierCheckpointFileSystem = {
  mkdir(path: string, options: { recursive: true }): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

const nodeFileSystem: ClassifierCheckpointFileSystem = {
  async mkdir(path, options) { await mkdir(path, options); },
  async writeFile(path, data, encoding) { await writeFile(path, data, encoding); },
  async rename(oldPath, newPath) { await rename(oldPath, newPath); },
  async unlink(path) { await unlink(path); },
  async readFile(path, encoding) { return readFile(path, encoding); },
};

const forbidden = new Set(["html", "raw_content", "rawcontent", "authorization", "api_key", "apikey", "prompt", "systeminstructions", "reasoning", "chainofthought"]);
function forbiddenKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenKeys(item, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const normalized = key.replace(/[-_]/g, "").toLowerCase();
    return [...(forbidden.has(normalized) ? [`${path}.${key}`] : []), ...forbiddenKeys(child, `${path}.${key}`)];
  });
}

export function parseSafeEditorPipelineCheckpoint(raw: string): EditorPipelineCheckpoint {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch { throw new Error("Editor pipeline checkpoint is not valid JSON"); }
  const blocked = forbiddenKeys(parsed);
  if (blocked.length > 0) throw new Error(`Editor pipeline checkpoint contains prohibited fields: ${blocked.join(", ")}`);
  return editorPipelineCheckpointSchema.parse(parsed);
}

export async function writeEditorPipelineCheckpointAtomic(checkpoint: EditorPipelineCheckpoint, targetPath = "artifacts/pipeline-editor-checkpoint.json", fileSystem: ClassifierCheckpointFileSystem = nodeFileSystem): Promise<{ path: string; bytes: number }> {
  const serialized = `${JSON.stringify(editorPipelineCheckpointSchema.parse(checkpoint), null, 2)}\n`;
  const temporaryPath = `${targetPath}.tmp`;
  await fileSystem.mkdir(dirname(targetPath), { recursive: true });
  try {
    await fileSystem.writeFile(temporaryPath, serialized, "utf8");
    await fileSystem.rename(temporaryPath, targetPath);
  } catch (error) {
    try { await fileSystem.unlink(temporaryPath); } catch { /* Preserve original failure. */ }
    throw new Error("Unable to atomically write Editor pipeline checkpoint", { cause: error });
  }
  return { path: targetPath, bytes: new TextEncoder().encode(serialized).byteLength };
}

export async function readSafeEditorPipelineCheckpoint(path = "artifacts/pipeline-editor-checkpoint.json", fileSystem: ClassifierCheckpointFileSystem = nodeFileSystem): Promise<EditorPipelineCheckpoint> {
  return parseSafeEditorPipelineCheckpoint(await fileSystem.readFile(path, "utf8"));
}
