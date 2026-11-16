import assert from "node:assert/strict";
import { z } from "zod";
import { AgentError, AgentTimeoutError, FreeTierLimitReachedError, PermanentProviderError } from "../lib/agents/runtime/agent-errors.ts";
import { getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { MockModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { EditorAgent } from "../lib/agents/editor/editor-agent.ts";
import { canonicalEditorGeneration, canonicalEditorInput } from "../lib/agents/editor/editor-fixtures.ts";

const schema = z.object({ value: z.string() }).strict();
const config = { model: "fixture", timeoutMs: 10, maxRetries: 0, retryBackoffMs: 0, maxOutputTokens: 1200, dailyRequestLimit: 20, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "json_object", reasoningEffort: "low", includeReasoning: false };
const run = (provider, logger, budget, customConfig = config) => runStructuredAgent({ agentName: "reservation-test", agentVersion: "test-v1", eventKey: "reservation-event", input: { value: "input" }, systemInstructions: "test", schemaName: "ReservationOutput", schema, modelConfig: customConfig, provider, logger, requestBudget: budget });
const budget = () => new DailyRequestBudget(() => new Date("2026-09-15T12:00:00Z"));

const providerDiagnostics = {
  httpStatus: 200,
  finishReason: "stop",
  usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60 },
  requestMetrics: { bodyBytes: 900, systemPromptChars: 10, inputChars: 20, schemaChars: 30, sourceCount: 1, originalContentChars: [100], sentContentChars: [100], truncated: [false] },
  responseBodyBytes: 500,
  validationResult: "not_run",
  failureKind: "SUCCESS",
};

const invalidInputLogger = new InMemoryAgentLogger();
const invalidInput = { ...canonicalEditorInput, event: { ...canonicalEditorInput.event, eventKey: "" } };
await assert.rejects(() => new EditorAgent(new MockModelProvider(() => canonicalEditorGeneration), invalidInputLogger).edit(invalidInput, { modelConfig: config, requestBudget: budget() }));
assert.equal(invalidInputLogger.runs.length, 0, "input Zod failure must not create a request run");

const invalidConfigLogger = new InMemoryAgentLogger();
await assert.rejects(() => run(new MockModelProvider(() => ({ value: "ok" })), invalidConfigLogger, budget(), { ...config, maxOutputTokens: 1201 }), AgentError);
assert.equal(invalidConfigLogger.runs.length, 0, "invalid local config must not create a request run");

const preDispatchLogger = new InMemoryAgentLogger();
await assert.rejects(() => run({ providerId: "mock", generateStructured: async () => { throw new AgentError("cost_guard_violation", "local schema construction failed"); } }, preDispatchLogger, budget()), AgentError);
assert.equal((await preDispatchLogger.getRemainingRequests(20, "2026-09-15")).used, 0);

const serializationLogger = new InMemoryAgentLogger();
await assert.rejects(() => run({ providerId: "mock", generateStructured: async () => { throw new TypeError("serialization failed"); } }, serializationLogger, budget()), TypeError);
assert.equal((await serializationLogger.getRemainingRequests(20, "2026-09-15")).used, 0);

for (const error of [new PermanentProviderError("HTTP 400"), new FreeTierLimitReachedError(), new PermanentProviderError("HTTP 500")]) {
  const logger = new InMemoryAgentLogger();
  const provider = { providerId: "mock", generateStructured: async (request) => { await request.onRequestDispatched?.(); throw error; } };
  await assert.rejects(() => run(provider, logger, budget()), error.constructor);
  assert.equal((await logger.getRemainingRequests(20, "2026-09-15")).used, 0, "mock requests must not consume the Groq bucket");
  assert.equal(logger.entries.filter((entry) => entry.entry.step === "provider_request_reserved").length, 1);
  assert.equal(getAgentFailureDetails(error).providerRequestsUsed, 1);
}

const timeoutLogger = new InMemoryAgentLogger();
await assert.rejects(() => run({ providerId: "mock", generateStructured: async (request) => { await request.onRequestDispatched?.(); return new Promise(() => {}); } }, timeoutLogger, budget()), AgentTimeoutError);
assert.equal((await timeoutLogger.getRemainingRequests(20, "2026-09-15")).used, 0, "mock timeout reservation must remain outside the Groq bucket");

const timeoutError = timeoutLogger.entries.find((entry) => entry.entry.step === "failed");
assert.equal(timeoutError?.entry.payload.telemetry.providerRequestsUsed, 1);

const guardLogger = new InMemoryAgentLogger();
const guardAgent = new EditorAgent({
  providerId: "mock",
  async generateStructured(request) {
    await request.onRequestDispatched?.();
    return { output: { ...canonicalEditorGeneration, bodyEs: `${canonicalEditorGeneration.bodyEs} 9999` }, model: "fixture-editor", diagnostics: providerDiagnostics };
  },
}, guardLogger);
await assert.rejects(() => guardAgent.edit(canonicalEditorInput, { modelConfig: { ...config, maxRetries: 0 }, requestBudget: budget() }));
assert.equal((await guardLogger.getRemainingRequests(20, "2026-09-15")).used, 0, "post-provider mock guard failure must not consume Groq capacity");
assert.equal(guardLogger.entries.filter((entry) => entry.entry.step === "provider_request_reserved").length, 1, "post-provider guard failure retains its own dispatched reservation");
const guardDetails = guardLogger.entries.find((entry) => entry.entry.step === "failed");
assert.ok(guardDetails);
assert.equal(guardDetails.entry.payload.telemetry.providerHttpStatus, 200);
assert.equal(guardDetails.entry.payload.telemetry.providerRequestsUsed, 1);
assert.equal(guardDetails.entry.payload.telemetry.inputTokens, 40);
assert.equal(guardDetails.entry.payload.telemetry.outputTokens, 20);
assert.equal(guardDetails.entry.payload.telemetry.requestBytes, 900);
assert.equal(guardDetails.entry.payload.telemetry.responseBytes, 500);
assert.equal(guardDetails.entry.payload.telemetry.finishReason, "stop");

const outputSchemaLogger = new InMemoryAgentLogger();
await assert.rejects(() => run({ providerId: "mock", generateStructured: async (request) => { await request.onRequestDispatched?.(); return { output: { invalid: true }, model: "fixture", diagnostics: providerDiagnostics }; } }, outputSchemaLogger, budget()), AgentError);
assert.equal((await outputSchemaLogger.getRemainingRequests(20, "2026-09-15")).used, 0, "mock schema failure must not consume Groq capacity");
assert.equal(outputSchemaLogger.entries.filter((entry) => entry.entry.step === "provider_request_reserved").length, 1, "HTTP 200 schema failure retains its mock reservation");
assert.equal(outputSchemaLogger.entries.find((entry) => entry.entry.step === "failed")?.entry.payload.telemetry.providerRequestsUsed, 1);

const successLogger = new InMemoryAgentLogger();
await run(new MockModelProvider(() => ({ value: "ok" })), successLogger, budget());
assert.equal((await successLogger.getRemainingRequests(20, "2026-09-15")).used, 0, "successful mock request must not consume Groq capacity");

const ownershipLogger = new InMemoryAgentLogger();
const first = await ownershipLogger.reserveRequest("run-a", { agentName: "test", agentVersion: "v1", eventKey: null, model: "fixture", dryRun: true }, 1, 20, "2026-09-15");
assert.ok(first.reservationId);
assert.equal(await ownershipLogger.releaseRequest("run-b", first.reservationId, "2026-09-15"), false);
assert.equal(await ownershipLogger.releaseRequest("run-a", first.reservationId, "2026-09-15"), true);
assert.equal((await ownershipLogger.getRemainingRequests(20, "2026-09-15")).used, 0);

console.log("Reservation lifecycle fixtures passed");
