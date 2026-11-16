import { z } from "zod";
import { StructuredOutputError } from "./agent-errors.ts";
import type { ProviderDiagnostics } from "./runtime-types.ts";

function observedType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function issuePath(path: Array<PropertyKey>): Array<string | number> {
  return path.filter((part): part is string | number => typeof part === "string" || typeof part === "number");
}

function pathLabel(path: Array<string | number>): string {
  if (path.length === 0) return "output";
  return path.map((part, index) => typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`).join("");
}

function sanitizeMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
}

export function summarizeZodIssue(issue: z.core.$ZodIssue): {
  summary: import("./runtime-types.ts").ZodIssueSummary;
  invalidPath: string;
} {
  const path = issuePath(issue.path);
  const raw = issue as unknown as Record<string, unknown>;
  const input = raw.input;
  const expected = typeof raw.expected === "string" ? raw.expected : undefined;
  const receivedFromMessage = /received\s+([a-z]+)/i.exec(issue.message)?.[1]?.toLowerCase();
  const unexpectedKeys = Array.isArray(raw.keys) && raw.keys.every((key) => typeof key === "string")
    ? raw.keys.slice(0, 50) as string[]
    : undefined;
  const options = Array.isArray(raw.values) && raw.values.every((value) => ["string", "number", "boolean"].includes(typeof value))
    ? raw.values.map((value) => String(value)).slice(0, 50)
    : undefined;
  const summary = {
    path,
    code: issue.code,
    ...(expected ? { expected } : {}),
    ...(Object.hasOwn(raw, "input") ? { receivedType: observedType(input) } : receivedFromMessage ? { receivedType: receivedFromMessage } : {}),
    ...(options ? { options } : {}),
    ...(unexpectedKeys ? { unexpectedKeys } : {}),
    message: sanitizeMessage(issue.message),
  };
  return { summary, invalidPath: pathLabel(path) };
}

export function parseStructuredOutput<T>(schema: z.ZodType<T>, value: unknown, diagnostics?: ProviderDiagnostics): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const summaries = parsed.error.issues.map(summarizeZodIssue);
  throw new StructuredOutputError(
    summaries.map(({ invalidPath, summary }) => `${invalidPath}: ${summary.message}`),
    {
      ...diagnostics,
      zodIssueCount: summaries.length,
      zodIssues: summaries.map(({ summary }) => summary),
      invalidPaths: summaries.map(({ invalidPath }) => invalidPath),
    }
  );
}
