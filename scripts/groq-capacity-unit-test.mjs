import assert from "node:assert/strict";
import { z } from "zod";
import { getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { OpenAICompatibleModelProvider, normalizeGroqProviderRateLimit, readRateLimitHeaders } from "../lib/agents/runtime/model-provider.ts";
import { freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { ProviderScopedDailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { agentTelemetrySchema } from "../lib/agents/runtime/telemetry.ts";

const model = "openai/gpt-oss-20b";
const secretFixture = "PROBE_UNIT_SECRET_DO_NOT_PERSIST";
const config = {
  model,
  timeoutMs: 1_000,
  maxRetries: 0,
  retryBackoffMs: 0,
  maxOutputTokens: 64,
  dailyRequestLimit: 20,
  failOnRateLimit: true,
  allowPaidFallback: false,
  structuredOutputMode: "json_object",
  reasoningEffort: "low",
  includeReasoning: false,
  groqCapacity: { requestHardLimit: 20, requestSoftLimit: 20, tokenHardLimit: 200_000, tokenSoftLimit: 200_000, tokenMinuteHardLimit: 8_000 },
};
const schema = z.object({ ok: z.literal(true) }).strict();
const rateHeaders = {
  "x-ratelimit-limit-requests": "1000",
  "x-ratelimit-remaining-requests": "999",
  "x-ratelimit-reset-requests": "1h30m",
  "x-ratelimit-limit-tokens": "8000",
  "x-ratelimit-remaining-tokens": "7999",
  "x-ratelimit-reset-tokens": "59.5s",
  "retry-after": "3",
};

assert.equal(freeProviderPolicy.groq.billingMode, "free_only");
assert.equal(freeProviderPolicy.groq.approvedModels.includes(model), true);

const parsedHeaders = readRateLimitHeaders(new Headers(rateHeaders));
assert.equal(parsedHeaders.limitRequests, "1000");
assert.equal(parsedHeaders.remainingRequests, "999");
assert.equal(parsedHeaders.resetRequestsSeconds, 5_400);
assert.equal(parsedHeaders.limitTokens, "8000");
assert.equal(parsedHeaders.resetTokensSeconds, 59.5);
assert.equal(parsedHeaders.retryAfterSeconds, 3);
assert.deepEqual(normalizeGroqProviderRateLimit(parsedHeaders), {
  requestLimitDaily: 1_000,
  requestRemainingDaily: 999,
  requestReset: "1h30m",
  requestResetSeconds: 5_400,
  tokenLimitMinute: 8_000,
  tokenRemainingMinute: 7_999,
  tokenReset: "59.5s",
  tokenResetSeconds: 59.5,
  retryAfterSeconds: 3,
});

const missingHeaders = readRateLimitHeaders(new Headers());
assert.deepEqual(normalizeGroqProviderRateLimit(missingHeaders), {
  requestLimitDaily: null,
  requestRemainingDaily: null,
  requestReset: null,
  requestResetSeconds: null,
  tokenLimitMinute: null,
  tokenRemainingMinute: null,
  tokenReset: null,
  tokenResetSeconds: null,
  retryAfterSeconds: null,
});

const malformedReset = normalizeGroqProviderRateLimit(readRateLimitHeaders(new Headers({
  "x-ratelimit-reset-requests": "not-a-valid-reset!",
  "x-ratelimit-reset-tokens": "???",
})));
assert.equal(malformedReset.requestReset, null);
assert.equal(malformedReset.requestResetSeconds, null);
assert.equal(malformedReset.tokenReset, null);
assert.equal(malformedReset.tokenResetSeconds, null);

const successfulBody = {
  model,
  choices: [{ message: { role: "assistant", content: JSON.stringify({ ok: true }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
};

async function runProbe(status, body, responseHeaders) {
  let httpAttempts = 0;
  let capturedRequest = null;
  const provider = new OpenAICompatibleModelProvider(freeProviderPolicy.groq.endpoint, secretFixture, {
    providerId: "groq",
    enforceFreeOnly: true,
    configuredModel: model,
    fetchImpl: async (url, init) => {
      httpAttempts += 1;
      capturedRequest = { url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify(body), { status, headers: responseHeaders });
    },
  });
  const logger = new InMemoryAgentLogger();
  let result = null;
  let failure = null;
  try {
    result = await runStructuredAgent({
      agentName: "groq-free-capacity-probe",
      agentVersion: "groq-capacity-probe-v1",
      eventKey: null,
      input: { diagnostic: "Reply with ok=true." },
      systemInstructions: "Return only the tiny JSON object required by the schema.",
      schemaName: "GroqCapacityProbe",
      schema,
      modelConfig: config,
      provider,
      logger,
      dryRun: true,
      requestBudget: new ProviderScopedDailyRequestBudget(),
    });
  } catch (error) {
    failure = error;
  }
  return { httpAttempts, capturedRequest, logger, result, failure };
}

const success = await runProbe(200, successfulBody, rateHeaders);
assert.equal(success.httpAttempts, 1);
assert.equal(success.result?.telemetry.provider, "groq");
assert.equal(success.result?.telemetry.model, model);
assert.equal(success.result?.telemetry.providerRateLimit?.requestLimitDaily, 1_000);
assert.equal(success.result?.telemetry.providerRateLimit?.tokenLimitMinute, 8_000);
assert.equal(success.result?.telemetry.inputTokens, 12);
assert.equal(success.result?.telemetry.outputTokens, 2);
assert.equal(success.result?.telemetry.totalTokens, 14);
assert.equal(agentTelemetrySchema.parse(success.result.telemetry).provider, "groq");
assert.equal(success.logger.runs[0].metadata.provider, "groq");
assert.equal(success.logger.runs[0].metadata.eventKey, null);
assert.equal(success.logger.entries.find((entry) => entry.entry.step === "provider_request_reserved")?.metadata.provider, "groq");
const successReservation = success.logger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
assert.ok(successReservation.entry.payload.estimatedTokens > 0);
assert.deepEqual(success.logger.getGroqTokenReservationSnapshot(successReservation.entry.payload.requestDate, successReservation.entry.payload.reservationId), {
  runId: success.logger.runs[0].id, dispatched: true, accountedTokens: 14, tokenUsageState: "settled",
});
assert.equal(success.capturedRequest.url, freeProviderPolicy.groq.endpoint);
assert.equal(success.capturedRequest.headers.authorization, `Bearer ${secretFixture}`);
assert.equal(success.capturedRequest.body.model, model);
assert.equal(success.capturedRequest.body.max_completion_tokens, 64);
assert.equal(success.capturedRequest.body.reasoning_effort, "low");
assert.equal(success.capturedRequest.body.include_reasoning, false);
assert.equal("service_tier" in success.capturedRequest.body, false, "omission preserves ordinary/default on-demand processing");
assert.equal("tools" in success.capturedRequest.body, false);
assert.doesNotMatch(JSON.stringify({ runs: success.logger.runs, entries: success.logger.entries, telemetry: success.result.telemetry }), new RegExp(secretFixture));

const rateLimited = await runProbe(429, { error: { message: "rate limited", type: "rate_limit_error" } }, rateHeaders);
assert.equal(rateLimited.httpAttempts, 1, "429 is not retried");
assert.equal(rateLimited.result, null);
assert.ok(rateLimited.failure);
const failed = getAgentFailureDetails(rateLimited.failure);
assert.equal(failed.attempts, 1);
assert.equal(failed.providerRequestsUsed, 1);
assert.equal(failed.telemetry?.provider, "groq");
assert.equal(failed.telemetry?.providerHttpStatus, 429);
assert.equal(failed.telemetry?.retries, 0);
assert.equal(failed.telemetry?.providerRateLimit?.retryAfterSeconds, 3);
assert.equal(failed.telemetry?.providerRateLimit?.requestLimitDaily, 1_000);
assert.equal(rateLimited.logger.runs[0].metadata.provider, "groq");
assert.equal(rateLimited.logger.runs[0].stats.telemetry.provider, "groq");
assert.equal(rateLimited.logger.runs[0].stats.telemetry.model, model);
const rateReservation = rateLimited.logger.entries.find((entry) => entry.entry.step === "provider_request_reserved");
assert.ok(rateReservation.entry.payload.estimatedTokens > 0, "429 without trusted usage retains the estimate");
assert.deepEqual(rateLimited.logger.getGroqTokenReservationSnapshot(rateReservation.entry.payload.requestDate, rateReservation.entry.payload.reservationId), {
  runId: rateLimited.logger.runs[0].id, dispatched: true, accountedTokens: rateReservation.entry.payload.estimatedTokens, tokenUsageState: "reserved_estimate",
});
assert.doesNotMatch(JSON.stringify({ runs: rateLimited.logger.runs, entries: rateLimited.logger.entries, telemetry: failed.telemetry }), new RegExp(secretFixture));

console.log("groq:capacity:unit: OK (parser, missing/malformed headers, 429, provider identity, no secrets/tier/tools, 0 retries; offline only)");
