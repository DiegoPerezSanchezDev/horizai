import assert from "node:assert/strict";
import { z } from "zod";
import { AgentError, AgentTimeoutError } from "../lib/agents/runtime/agent-errors.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { MockModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { agentTelemetrySchema, buildAgentTelemetry, telemetryStatusFromError } from "../lib/agents/runtime/telemetry.ts";

const config = {
  model: "fixture-model",
  timeoutMs: 100,
  maxRetries: 0,
  retryBackoffMs: 0,
  maxOutputTokens: 1200,
  dailyRequestLimit: 20,
  failOnRateLimit: true,
  allowPaidFallback: false,
  structuredOutputMode: "json_object",
  reasoningEffort: "low",
  includeReasoning: false,
};

const diagnostics = {
  httpStatus: 200,
  structuredOutputMode: "json_object",
  reasoningEffort: "low",
  includeReasoning: false,
  finishReason: "stop",
  usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 },
  requestMetrics: {
    bodyBytes: 1234,
    systemPromptChars: 10,
    inputChars: 20,
    schemaChars: 30,
    sourceCount: 1,
    originalContentChars: [20],
    sentContentChars: [20],
    truncated: [false],
  },
  responseBodyBytes: 456,
  validationResult: "valid",
  failureKind: "SUCCESS",
};

const successTelemetry = buildAgentTelemetry({
  status: "SUCCESS",
  model: "fixture-model-effective",
  agentVersion: "fixture-v1",
  config,
  diagnostics,
  attempts: 1,
  latencyMs: 25,
  startedAt: "2026-09-14T10:00:00.000Z",
  finishedAt: "2026-09-14T10:00:00.025Z",
});
assert.equal(agentTelemetrySchema.parse(successTelemetry).providerHttpStatus, 200);
assert.equal(successTelemetry.finishReason, "stop");
assert.equal(successTelemetry.requestBytes, 1234);
assert.equal(successTelemetry.responseBytes, 456);
assert.equal(successTelemetry.zodValid, true);
assert.equal(successTelemetry.inputTokens, 10);
assert.equal(successTelemetry.totalTokens, 17);

const unavailableTelemetry = buildAgentTelemetry({
  status: "TIMEOUT",
  model: "fixture-model",
  agentVersion: "fixture-v1",
  config,
  diagnostics: undefined,
  attempts: 1,
  latencyMs: 100,
  startedAt: "2026-09-14T10:00:00.000Z",
  finishedAt: "2026-09-14T10:00:00.100Z",
});
assert.equal(unavailableTelemetry.providerHttpStatus, null);
assert.equal(unavailableTelemetry.finishReason, null);
assert.equal(unavailableTelemetry.responseBytes, null);
assert.equal(telemetryStatusFromError(new AgentTimeoutError(100)), "TIMEOUT");
const capacityError = new AgentError("PROVIDER_CAPACITY_EXHAUSTED", "synthetic pre-dispatch capacity stop");
assert.equal(telemetryStatusFromError(capacityError), "PROVIDER_CAPACITY_EXHAUSTED");
const capacityTelemetry = buildAgentTelemetry({
  status: telemetryStatusFromError(capacityError),
  model: "fixture-model",
  agentVersion: "fixture-v1",
  config,
  attempts: 0,
  latencyMs: 1,
  providerRequestsUsed: 0,
  startedAt: "2026-09-14T10:00:00.000Z",
  finishedAt: "2026-09-14T10:00:00.001Z",
});
assert.equal(agentTelemetrySchema.parse(capacityTelemetry).providerRequestDispatched, false);
assert.equal(capacityTelemetry.providerRequestsUsed, 0);

const logger = new InMemoryAgentLogger();
const provider = new MockModelProvider(() => ({ ok: true }));
const result = await runStructuredAgent({
  agentName: "fixture",
  agentVersion: "fixture-v1",
  eventKey: "fixture-event",
  input: { value: "safe" },
  systemInstructions: "Return JSON.",
  schemaName: "FixtureOutput",
  schema: z.object({ ok: z.boolean() }).strict(),
  modelConfig: config,
  provider: {
    providerId: "mock",
    async generateStructured(request) {
      const response = await provider.generateStructured(request);
      return { ...response, diagnostics };
    },
  },
  logger,
  dryRun: true,
});
assert.equal(result.diagnostics?.httpStatus, 200);
const run = logger.runs[0];
assert.equal(run?.status, "succeeded");
const persistedStats = run?.stats;
assert.ok(persistedStats && typeof persistedStats === "object" && !Array.isArray(persistedStats));
assert.equal(persistedStats.telemetry.providerHttpStatus, 200);
assert.equal(persistedStats.telemetry.finishReason, "stop");
assert.equal(persistedStats.telemetry.requestBytes, 1234);
assert.equal(persistedStats.telemetry.responseBytes, 456);
const completed = logger.entries.find((entry) => entry.entry.step === "completed");
assert.ok(completed);
assert.equal(completed.entry.payload.telemetry.finishReason, "stop");
assert.doesNotMatch(JSON.stringify(persistedStats), /api[_-]?key|authorization|reasoning_content|chain.of.thought/i);

console.log("Runtime telemetry unit fixtures passed");
