import assert from "node:assert/strict";
import { buildEditorReport, editorReportSchema } from "../lib/agents/editor/editor-report.ts";
import { canonicalEditorialDraft, canonicalEditorInput } from "../lib/agents/editor/editor-fixtures.ts";

const report = buildEditorReport({
  editorInput: canonicalEditorInput,
  draft: canonicalEditorialDraft,
  result: {
    output: canonicalEditorialDraft,
    runId: "fixture-run",
    agentName: "editor",
    agentVersion: "editor-v1",
    model: "fixture-editor-model",
    attempts: 1,
    latencyMs: 50,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    diagnostics: {
      httpStatus: 200,
      structuredOutputMode: "json_object",
      reasoningEffort: "low",
      includeReasoning: false,
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      requestMetrics: {
        bodyBytes: 100,
        systemPromptChars: 10,
        inputChars: 20,
        schemaChars: 30,
        sourceCount: 1,
        originalContentChars: [20],
        sentContentChars: [20],
        truncated: [false],
      },
      responseBodyBytes: 200,
      validationResult: "valid",
      failureKind: "SUCCESS",
    },
  },
  verifierStatus: "single_source",
  verifierConfidence: 90,
  translatedFactCount: 2,
  dryRun: true,
  hours: 48,
  limit: 1,
  startedAt: "2026-09-14T10:00:00.000Z",
  finishedAt: "2026-09-14T10:00:00.050Z",
});

assert.doesNotThrow(() => editorReportSchema.parse(report));
assert.equal(report.metadata.sourceCount, canonicalEditorInput.sources.length);
assert.equal(report.metadata.verifierConfidence, 90);
assert.equal(report.dimensions.suggestedSlugValid, true);
assert.ok(report.sample.bodyPreview.length <= 500);
assert.equal(Object.hasOwn(report.sample, "bodyEs"), false);
assert.equal(Object.hasOwn(report, "bodyEs"), false);
assert.ok(Object.keys(report.qa).includes("FACTUAL_PRECISION"));
assert.ok(Object.keys(report.qa).includes("FIDELITY"));
assert.equal(report.telemetry.providerHttpStatus, 200);
assert.equal(report.telemetry.finishReason, "stop");
assert.equal(report.telemetry.zodValid, true);
const serialized = JSON.stringify(report);
assert.doesNotMatch(serialized, /api[_-]?key|authorization|chain.of.thought|reasoning_content/i);
assert.doesNotMatch(serialized, /translatedSourceMaterial|raw_content|<html/i);

console.log("Editor report unit fixtures passed");
