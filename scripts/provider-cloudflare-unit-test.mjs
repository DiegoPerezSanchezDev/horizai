import assert from "node:assert/strict";
import { z } from "zod";
import { CloudflareWorkersAIModelProvider, createCloudflareWorkersAIProvider, createCloudflareWorkersAIValidationCandidateProvider } from "../lib/agents/runtime/cloudflare-workers-ai-provider.ts";
import { CLOUDFLARE_LLAMA_VALIDATION_MODEL } from "../lib/agents/runtime/provider-cost-policy.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { attemptOutcomeFromPipelineResult } from "../lib/agents/pipeline/event-attempt-policy.ts";

const accountId = "1234567890abcdef1234567890abcdef";
const date = "2026-09-23T12:00:00.000Z";
const schema = z.object({ result: z.enum(["ok"]), confidence: z.number().int().min(0).max(100) }).strict();
const config = { model: "@cf/openai/gpt-oss-20b", timeoutMs: 30, maxRetries: 0, retryBackoffMs: 0, maxOutputTokens: 1024, dailyRequestLimit: 20, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "json_object" };
const completion = (content) => ({ model: "@cf/openai/gpt-oss-20b", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 } });
const response = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const envNames = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_API_TOKEN", "CLOUDFLARE_DAILY_NEURON_LIMIT", "CLOUDFLARE_FREE_DAILY_REQUEST_LIMIT", "FREE_PROVIDER_SOFT_LIMIT_RATIO"];
const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
try {
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_AI_API_TOKEN;
  assert.throws(() => createCloudflareWorkersAIProvider(), { code: "missing_configuration" });
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
  process.env.CLOUDFLARE_AI_API_TOKEN = "offline-fixture-token";
  assert.equal(createCloudflareWorkersAIProvider().providerId, "cloudflare_workers_ai", "server-only env factory selects only the approved provider");
  let candidateFetches = 0;
  const candidateProvider = createCloudflareWorkersAIValidationCandidateProvider(async (url, options) => {
    candidateFetches += 1;
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`);
    const request = JSON.parse(options.body);
    assert.equal(request.model, CLOUDFLARE_LLAMA_VALIDATION_MODEL, "validation factory pins the candidate model");
    assert.equal(request.max_tokens, 1024);
    assert.equal(Object.hasOwn(request, "max_completion_tokens"), false);
    assert.equal(request.stream, false);
    assert.equal(request.response_format.type, "json_schema");
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal("tools" in request, false);
    return response(200, { model: CLOUDFLARE_LLAMA_VALIDATION_MODEL, choices: [{ message: { content: '{"result":"ok","confidence":90}' }, finish_reason: "stop" }], usage: { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 } });
  });
  const candidateResult = await candidateProvider.generateStructured({
    systemInstructions: "Return the requested strict JSON fixture.",
    input: { synthetic: true },
    schema,
    schemaName: "FixtureResult",
    config: { ...config, model: CLOUDFLARE_LLAMA_VALIDATION_MODEL, structuredOutputMode: "strict_schema" },
    onRequestDispatched: () => undefined,
  });
  assert.equal(candidateResult.model, CLOUDFLARE_LLAMA_VALIDATION_MODEL);
  assert.equal(candidateResult.output.confidence, 90);
  assert.equal(candidateResult.diagnostics.contentJsonParseable, true);
  assert.equal(candidateFetches, 1, "candidate provider mock sends one offline request");
} finally {
  for (const name of envNames) { if (oldEnv[name] === undefined) delete process.env[name]; else process.env[name] = oldEnv[name]; }
}

function setup(fetchImpl, modelConfig = config) {
  const logger = new InMemoryAgentLogger();
  let fetchCount = 0;
  const provider = new CloudflareWorkersAIModelProvider(accountId, "offline-fixture-token", async (...args) => { fetchCount += 1; return fetchImpl(...args); });
  const execute = async () => {
    const saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.CLOUDFLARE_ACCOUNT_ID = accountId;
    process.env.CLOUDFLARE_AI_API_TOKEN = "offline-fixture-token";
    process.env.CLOUDFLARE_DAILY_NEURON_LIMIT = "10000";
    process.env.FREE_PROVIDER_SOFT_LIMIT_RATIO = "0.85";
    delete process.env.CLOUDFLARE_FREE_DAILY_REQUEST_LIMIT;
    try {
      return await runStructuredAgent({
        agentName: "cloudflare-fixture", agentVersion: "offline-test-v1", eventKey: "fixture-event",
        input: { trustedFixture: true }, systemInstructions: "Return only the requested structured output.", schemaName: "FixtureResult",
        schema, modelConfig, provider, logger, requestBudget: new DailyRequestBudget(() => new Date(date)),
        finalizeOutput: (output) => {
          if (output.result !== "ok") throw new Error("deterministic guard rejected output");
          return { output };
        },
      });
    } finally {
      for (const name of envNames) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    }
  };
  return { execute, logger, get fetchCount() { return fetchCount; } };
}

const jsonMode = setup(async (url, options) => {
  assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`);
  const request = JSON.parse(options.body);
  assert.equal(request.model, "@cf/openai/gpt-oss-20b");
  assert.equal(request.stream, false);
  assert.equal(request.response_format.type, "json_object");
  assert.equal(request.max_tokens, 1024, "Cloudflare receives the provider-native max_tokens field instead of relying on its default");
  assert.equal(Object.hasOwn(request, "max_completion_tokens"), false);
  assert.equal(options.headers.authorization, "Bearer offline-fixture-token");
  assert.equal("tools" in request, false);
  return response(200, completion('{"result":"ok","confidence":90}'));
});
const jsonResult = await jsonMode.execute();
assert.deepEqual(jsonResult.output, { result: "ok", confidence: 90 });
assert.equal(jsonResult.telemetry.provider, "cloudflare_workers_ai");
assert.equal(jsonResult.telemetry.providerUnit, "neurons");
assert.equal(jsonResult.telemetry.providerUnitUsageKnown, false, "unit is known, actual neuron amount is not reported by mock");
assert.equal(jsonResult.telemetry.estimatedNeurons, 3, "computed estimate stays separate from actual usage");
assert.equal(jsonResult.telemetry.actualProviderUnitUsage, null);
assert.equal(jsonResult.telemetry.providerHttpStatus, 200);
assert.equal(jsonResult.telemetry.inputTokens, 25);
assert.equal(jsonResult.telemetry.outputTokens, 7);
assert.equal(jsonResult.telemetry.totalTokens, 32);
assert.equal(jsonResult.telemetry.zodValid, true);
assert.equal(jsonResult.telemetry.finishReason, "stop");
assert.equal(jsonResult.diagnostics.requestMetrics.maxOutputTokensRequested, 1024);
assert.equal(jsonMode.fetchCount, 1);

const stageSpecificOutputLimit = setup(async (_url, options) => {
  const request = JSON.parse(options.body);
  assert.equal(request.max_tokens, 384, "a stage-specific runtime limit is forwarded to Cloudflare unchanged");
  assert.equal(Object.hasOwn(request, "max_completion_tokens"), false);
  return response(200, completion('{"result":"ok","confidence":50}'));
}, { ...config, maxOutputTokens: 384 });
assert.equal((await stageSpecificOutputLimit.execute()).output.confidence, 50);
assert.equal(stageSpecificOutputLimit.fetchCount, 1);

const schemaMode = setup(async (_url, options) => {
  const request = JSON.parse(options.body);
  assert.equal(request.response_format.type, "json_schema");
  assert.equal(request.response_format.json_schema.strict, true);
  return response(200, completion('{"result":"ok","confidence":50}'));
}, { ...config, structuredOutputMode: "strict_schema" });
assert.equal((await schemaMode.execute()).output.confidence, 50, "valid generation passes parse → Zod → deterministic guard");
assert.equal(schemaMode.fetchCount, 1);

const disallowedModel = setup(async () => { throw new Error("disallowed model must not dispatch"); }, { ...config, model: "@cf/openai/gpt-oss-120b" });
await assert.rejects(disallowedModel.execute(), { code: "PAID_PROVIDER_FORBIDDEN" });
assert.equal(disallowedModel.fetchCount, 0, "unapproved Cloudflare model is blocked before dispatch");

async function failure(name, fetchImpl, expectedCategory, expectedStatus, code, modelConfig = config) {
  const fixture = setup(fetchImpl, modelConfig);
  let error;
  try { await fixture.execute(); } catch (caught) { error = caught; }
  assert.ok(error, `${name} must fail closed`);
  const details = getAgentFailureDetails(error);
  assert.equal(details.telemetry.provider, "cloudflare_workers_ai", name);
  assert.equal(details.telemetry.providerHttpStatus, expectedStatus, name);
  assert.equal(details.telemetry.errorCategory, expectedCategory, name);
  assert.equal(details.telemetry.providerRequestDispatched, true, name);
  assert.equal(details.attempts, 1, name);
  assert.equal(details.telemetry.retries, 0, name);
  assert.equal(fixture.fetchCount, 1, name);
  if (code) assert.equal(error.code, code, name);
  return { error, details };
}

const malformedJsonFailure = await failure("malformed JSON", async () => response(200, completion("not-json")), "INVALID_RESPONSE", 200, "invalid_structured_output");
assert.equal(malformedJsonFailure.details.diagnostics.contentJsonParseable, false);
await failure("schema-invalid JSON", async () => response(200, completion('{"result":"ok","confidence":100.5}')), "INVALID_RESPONSE", 200, "invalid_structured_output");
const unexpectedKeyFailure = await failure("unexpected property diagnostic", async () => response(200, completion('{"result":"ok","confidence":90,"unexpected":"redacted-value"}')), "INVALID_RESPONSE", 200, "invalid_structured_output");
assert.deepEqual(unexpectedKeyFailure.details.diagnostics.zodIssues[0].unexpectedKeys, ["unexpected"]);
assert.equal(JSON.stringify(unexpectedKeyFailure.details.diagnostics).includes("redacted-value"), false, "Zod diagnostics never include response values");
const missingFieldFailure = await failure("missing property diagnostic", async () => response(200, completion('{"result":"ok"}')), "INVALID_RESPONSE", 200, "invalid_structured_output");
assert.equal(missingFieldFailure.details.diagnostics.zodIssues[0].receivedType, "undefined");
await failure("JSON-mode error", async () => response(400, { error: { message: "JSON Mode couldn't be met", code: "json_mode_error" } }), "BAD_REQUEST", 400, "provider_permanent");
await failure("HTTP 400", async () => response(400, { error: { message: "Bad request" } }), "BAD_REQUEST", 400, "provider_permanent");
await failure("HTTP 401", async () => response(401, { error: { message: "Unauthorized" } }), "AUTH_ERROR", 401, "provider_permanent");
await failure("HTTP 403", async () => response(403, { error: { message: "Forbidden" } }), "AUTH_ERROR", 403, "provider_permanent");
const rateLimit = await failure("HTTP 429", async () => response(429, { error: { message: "Daily neuron allocation exceeded" } }), "RATE_LIMIT", 429, "FREE_TIER_LIMIT_REACHED", { ...config, maxRetries: 2 });
const attempt = attemptOutcomeFromPipelineResult({ finalState: "FAILED", stopStage: "critic", stopReason: "PROVIDER_RATE_LIMIT", failure: { errorCode: rateLimit.error.code, httpStatus: 429 } }, new Date(date));
assert.equal(attempt.finalState, "PROVIDER_RATE_LIMIT");
assert.equal(attempt.countsTowardRetryLimit, false);
const echoedSecret = await failure("provider echoes authorization", async () => response(400, { error: { message: "Rejected Bearer offline-fixture-token" } }), "BAD_REQUEST", 400, "provider_permanent");
assert.equal(JSON.stringify(echoedSecret.details).includes("offline-fixture-token"), false, "provider diagnostics redact echoed bearer credentials");
await failure("HTTP 500", async () => response(500, { error: { message: "Unavailable" } }), "SERVER_ERROR", 500, "provider_transient");
await failure("network failure", async () => { throw new TypeError("offline fixture failure"); }, "NETWORK_ERROR", null, "provider_transient");
await failure("timeout", async () => new Promise(() => {}), "TIMEOUT", null, "timeout", { ...config, timeoutMs: 5 });

assert.equal(jsonResult.telemetry.actualProviderUnitUsage, null, "mock never represents provider-reported Neurons");
console.log("provider:cloudflare:unit: OK (MOCK_COMPATIBLE, 0 provider calls)");
