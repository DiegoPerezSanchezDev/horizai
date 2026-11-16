import { z } from "zod";
import type { AgentExecutionResult } from "../runtime/runtime-types.ts";
import { agentTelemetrySchema, buildAgentTelemetry } from "../runtime/telemetry.ts";
import type { EditorialDraft } from "../contracts/index.ts";
import type { EditorInput } from "./editor-types.ts";
import { buildEditorSafeSnapshot, type EditorQaResult } from "./editor-qa.ts";

const qaStatusSchema = z.enum(["PASS", "WARNING", "FAIL"]);
const qaCheckSchema = z.object({ status: qaStatusSchema, reason: z.string().trim().min(1).max(300).optional() }).strict();

export const editorReportSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  dryRun: z.boolean(),
  hours: z.number().int().positive(),
  limit: z.number().int().positive(),
  eventKey: z.string().trim().min(1),
  metadata: z.object({
    agentVersion: z.string().trim().min(1),
    model: z.string().trim().min(1),
    sourceCount: z.number().int().nonnegative(),
    verifierStatus: z.string().trim().min(1),
    verifierConfidence: z.number().int().min(0).max(100),
    translatedFactCount: z.number().int().nonnegative(),
  }).strict(),
  dimensions: z.object({
    headlineEsChars: z.number().int().nonnegative(),
    dekEsChars: z.number().int().nonnegative(),
    summaryEsChars: z.number().int().nonnegative(),
    whyItMattersEsChars: z.number().int().nonnegative(),
    bodyEsChars: z.number().int().nonnegative(),
    keyPointsCount: z.number().int().nonnegative(),
    suggestedSlugValid: z.boolean(),
  }).strict(),
  sample: z.object({
    headlineEs: z.string(),
    dekEs: z.string(),
    whyItMattersEs: z.string(),
    keyPoints: z.array(z.string()),
    bodyPreview: z.string().max(500),
  }).strict(),
  qa: z.record(z.string(), qaCheckSchema),
  telemetry: agentTelemetrySchema,
}).strict();

export type EditorReport = z.infer<typeof editorReportSchema>;

export function buildEditorReport(input: {
  editorInput: EditorInput;
  draft: EditorialDraft;
  result: AgentExecutionResult<EditorialDraft>;
  verifierStatus: string;
  verifierConfidence: number;
  translatedFactCount: number;
  dryRun: boolean;
  hours: number;
  limit: number;
  startedAt: string;
  finishedAt: string;
}): EditorReport {
  const snapshot = buildEditorSafeSnapshot(input.editorInput, input.draft);
  const telemetry = input.result.telemetry ?? buildAgentTelemetry({
    status: "SUCCESS",
    model: input.result.model,
    agentVersion: input.result.agentVersion,
    config: {
      model: input.result.model,
      timeoutMs: 0,
      maxRetries: 0,
      retryBackoffMs: 0,
      maxOutputTokens: 0,
      dailyRequestLimit: 1,
      failOnRateLimit: true,
      allowPaidFallback: false,
      structuredOutputMode: input.result.diagnostics?.structuredOutputMode ?? "json_object",
      reasoningEffort: input.result.diagnostics?.reasoningEffort,
      includeReasoning: input.result.diagnostics?.includeReasoning,
    },
    diagnostics: input.result.diagnostics,
    attempts: input.result.attempts,
    latencyMs: input.result.latencyMs,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });
  return editorReportSchema.parse({
    generatedAt: input.finishedAt,
    dryRun: input.dryRun,
    hours: input.hours,
    limit: input.limit,
    eventKey: input.editorInput.event.eventKey,
    metadata: {
      agentVersion: input.result.agentVersion,
      model: input.result.model,
      sourceCount: input.editorInput.sources.length,
      verifierStatus: input.verifierStatus,
      verifierConfidence: input.verifierConfidence,
      translatedFactCount: input.translatedFactCount,
    },
    dimensions: {
      headlineEsChars: snapshot.headlineEsChars,
      dekEsChars: snapshot.dekEsChars,
      summaryEsChars: snapshot.summaryEsChars,
      whyItMattersEsChars: snapshot.whyItMattersEsChars,
      bodyEsChars: snapshot.bodyEsChars,
      keyPointsCount: snapshot.keyPointsCount,
      suggestedSlugValid: snapshot.suggestedSlugValid,
    },
    sample: snapshot.sample,
    qa: snapshot.qa,
    telemetry,
  });
}

export type { EditorQaResult };
