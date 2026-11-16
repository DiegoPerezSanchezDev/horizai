import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { AgentError, FreeTierLimitReachedError } from "../lib/agents/runtime/agent-errors.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { assertFreeProviderRequest } from "../lib/agents/runtime/provider-cost-policy.ts";
import { createConfiguredModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { assertGeminiFreeRequest, GEMINI_FREE_TIER_CANDIDATE_MODELS, geminiGenerateContentEndpoint } from "../lib/agents/runtime/gemini-policy.ts";
import { assertGeminiSchemaSubset, toGeminiJsonSchema } from "../lib/agents/runtime/gemini-schema.ts";
import { FileGeminiUsageStore, GEMINI_DEFAULT_LIMITS, GeminiLimitAccountant, GeminiLocalLimitError, nextPacificMidnightMs, pacificDayKey, parseGeminiRateLimitHint, readGeminiLimits } from "../lib/agents/runtime/gemini-capacity.ts";
import { createGeminiModelProvider, estimateGeminiRequestTokens, GeminiModelProvider, resetSharedGeminiAccountantsForTests } from "../lib/agents/runtime/gemini-provider.ts";
import { assertGeminiStageAssignment, GeminiEventSession } from "../lib/agents/runtime/gemini-event-session.ts";
import { verificationResultSchema } from "../lib/agents/contracts/index.ts";
import { translatorGenerationSchema } from "../lib/agents/translator/translator-generation.ts";
import { editorGenerationSchema } from "../lib/agents/editor/editor-generation.ts";
import { classifierGenerationSchema } from "../lib/agents/classifier/classifier-types.ts";
import { rankerGenerationSchema } from "../lib/agents/ranker/ranker-types.ts";
import { criticCurrentGenerationSchema } from "../lib/agents/critic/critic-types.ts";

const MODEL = "gemini-3.5-flash-lite";
const FAKE_KEY = "AIzaFAKE-offline-key-0000000000000000";
const ENABLED_ENV = { GEMINI_PROVIDER_ENABLED: "true", GEMINI_FREE_TIER_PROJECT_CONFIRMED: "true", GEMINI_API_KEY: FAKE_KEY, GEMINI_MODEL: MODEL };
const schema = z.object({ title: z.string().min(1).max(80), score: z.number().int().min(0).max(10), tags: z.array(z.string()) }).strict();
const config = { model: MODEL, timeoutMs: 2_000, maxRetries: 0, retryBackoffMs: 0, maxOutputTokens: 400, dailyRequestLimit: 20, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "strict_schema" };

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function okBody(output, usage = { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 160 }) {
  return { candidates: [{ content: { parts: [{ text: "internal thought", thought: true }, { text: JSON.stringify(output) }] }, finishReason: "STOP" }], usageMetadata: usage, modelVersion: MODEL };
}
function makeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return responder(calls.length, { url, init, body });
  };
  return { fetchImpl, calls };
}
const request = (overrides = {}) => ({ systemInstructions: "Return JSON.", input: { text: "hello" }, schema, schemaName: "Fixture", config, ...overrides });
let clock = Date.parse("2026-11-07T20:00:00Z");
const now = () => clock;
const newAccountant = (limits = {}, options = {}) => new GeminiLimitAccountant({ ...GEMINI_DEFAULT_LIMITS, ...limits }, { now, ...options });
const newProvider = (fetchImpl, accountant = newAccountant(), extra = {}) => new GeminiModelProvider({ apiKey: FAKE_KEY, model: MODEL, env: ENABLED_ENV, fetchImpl, accountant, ...extra });

// ---------- 1. Policy: disabled by default, closed list, gates ----------
assert.deepEqual(GEMINI_FREE_TIER_CANDIDATE_MODELS.filter((model) => /pro|argon|image|tts|live|omni|embedding/.test(model)), [], "no paid-only or non-text family in the closed list");
assert.throws(() => assertGeminiFreeRequest(MODEL, geminiGenerateContentEndpoint(MODEL), {}), { code: "PAID_PROVIDER_FORBIDDEN" }, "inert without activation");
assert.throws(() => assertGeminiFreeRequest(MODEL, geminiGenerateContentEndpoint(MODEL), { GEMINI_PROVIDER_ENABLED: "true" }), { code: "PAID_PROVIDER_FORBIDDEN" }, "free-tier attestation is required");
assert.throws(() => assertGeminiFreeRequest(MODEL, geminiGenerateContentEndpoint(MODEL), { GEMINI_FREE_TIER_PROJECT_CONFIRMED: "true" }), { code: "PAID_PROVIDER_FORBIDDEN" }, "activation flag is required");
assert.throws(() => assertGeminiFreeRequest(MODEL, geminiGenerateContentEndpoint(MODEL), { GEMINI_PROVIDER_ENABLED: "yes", GEMINI_FREE_TIER_PROJECT_CONFIRMED: "true" }), { code: "cost_guard_violation" }, "ambiguous flag fails closed");
assert.doesNotThrow(() => assertGeminiFreeRequest(MODEL, geminiGenerateContentEndpoint(MODEL), ENABLED_ENV));
for (const model of ["gemini-4-argon", "gemini-3.1-pro-preview", "gemini-3.1-flash-image", "gemini-2.0-flash", "gpt-oss-20b", "../gemini-3.5-flash-lite"]) {
  assert.throws(() => assertGeminiFreeRequest(model, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, ENABLED_ENV), { code: "PAID_PROVIDER_FORBIDDEN" }, model);
}
for (const endpoint of ["https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent", "https://evil.example/v1beta/models/gemini-3.5-flash-lite:generateContent", "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent"]) {
  assert.throws(() => assertGeminiFreeRequest(MODEL, endpoint, ENABLED_ENV), { code: "PAID_PROVIDER_FORBIDDEN" }, endpoint);
}
assert.throws(() => assertGeminiFreeRequest(MODEL, geminiGenerateContentEndpoint(MODEL), { ...ENABLED_ENV, GEMINI_APPROVED_MODELS: "gemini-3.1-flash-lite" }), { code: "PAID_PROVIDER_FORBIDDEN" }, "env can narrow the list");
assert.throws(() => assertGeminiFreeRequest(MODEL, geminiGenerateContentEndpoint(MODEL), { ...ENABLED_ENV, GEMINI_APPROVED_MODELS: `${MODEL},gemini-4-argon` }), { code: "PAID_PROVIDER_FORBIDDEN" }, "env cannot widen the list");
assert.throws(() => assertFreeProviderRequest("gemini_free", MODEL, geminiGenerateContentEndpoint(MODEL)), { code: "PAID_PROVIDER_FORBIDDEN" }, "the Groq/Cloudflare free policy and router stay closed to Gemini");

assert.throws(() => createGeminiModelProvider({}), { code: "PAID_PROVIDER_FORBIDDEN" }, "no env, no provider");
assert.throws(() => createGeminiModelProvider({ GEMINI_API_KEY: FAKE_KEY, GEMINI_MODEL: MODEL }), { code: "PAID_PROVIDER_FORBIDDEN" }, "key alone does not activate");
assert.throws(() => createGeminiModelProvider({ GEMINI_PROVIDER_ENABLED: "true", GEMINI_FREE_TIER_PROJECT_CONFIRMED: "true", GEMINI_MODEL: MODEL }), { code: "missing_configuration" });
assert.throws(() => createGeminiModelProvider({ GEMINI_PROVIDER_ENABLED: "true", GEMINI_FREE_TIER_PROJECT_CONFIRMED: "true", GEMINI_API_KEY: FAKE_KEY }), { code: "missing_configuration" }, "model has no default");
assert.throws(() => createGeminiModelProvider({ ...ENABLED_ENV, GEMINI_FREE_TIER_PROJECT_CONFIRMED: "false" }), { code: "PAID_PROVIDER_FORBIDDEN" });

{
  const saved = { provider: process.env.AGENT_PROVIDER, enabled: process.env.GEMINI_PROVIDER_ENABLED, key: process.env.GEMINI_API_KEY };
  try {
    delete process.env.GEMINI_PROVIDER_ENABLED;
    delete process.env.GEMINI_API_KEY;
    process.env.AGENT_PROVIDER = "gemini_free";
    assert.throws(() => createConfiguredModelProvider(), { code: "PAID_PROVIDER_FORBIDDEN" }, "AGENT_PROVIDER=gemini_free is blocked while disabled");
    process.env.AGENT_PROVIDER = "groq";
    process.env.AGENT_API_URL = "https://api.groq.com/openai/v1";
    process.env.AGENT_API_KEY = "offline-only";
    assert.equal(createConfiguredModelProvider().providerId, "groq", "Groq path is unchanged when Gemini is not configured");
  } finally {
    for (const [name, value] of [["AGENT_PROVIDER", saved.provider], ["GEMINI_PROVIDER_ENABLED", saved.enabled], ["GEMINI_API_KEY", saved.key]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    delete process.env.AGENT_API_URL; delete process.env.AGENT_API_KEY;
  }
}

// ---------- 2. Schema conversion ----------
{
  const rich = z.object({
    kind: z.literal("a"),
    mode: z.union([z.literal("x"), z.literal("y")]),
    level: z.enum(["low", "high"]),
    note: z.string().min(1).max(10).regex(/^[a-z]+$/).nullable(),
    when: z.string().datetime(),
    mail: z.string().email(),
    count: z.number().int().min(0),
    nested: z.object({ ok: z.boolean(), items: z.array(z.string().min(1)).min(1).max(5) }).nullable(),
    choice: z.enum(["p", "q"]).nullable(),
  }).strict();
  const converted = toGeminiJsonSchema(rich);
  assert.doesNotThrow(() => assertGeminiSchemaSubset(converted));
  const text = JSON.stringify(converted);
  for (const banned of ["pattern", "format", "minLength", "maxLength", "minItems", "maxItems", "minimum", "const", "oneOf", "allOf", "$schema", "$ref"]) assert.equal(text.includes(`"${banned}"`), false, `${banned} removed`);
  assert.deepEqual(converted.properties.kind, { type: "string", enum: ["a"] });
  assert.deepEqual(converted.properties.mode, { type: "string", enum: ["x", "y"] });
  assert.deepEqual(converted.properties.note.type, ["string", "null"]);
  assert.deepEqual(converted.properties.choice, { type: ["string", "null"], enum: ["p", "q", null] });
  assert.deepEqual(converted.properties.nested.type, ["object", "null"]);
  assert.equal(converted.additionalProperties, false);
  assert.deepEqual(converted.required, Object.keys(rich.shape));
  assert.deepEqual(Object.keys(converted.properties), Object.keys(rich.shape), "property order is preserved");
  assert.throws(() => assertGeminiSchemaSubset({ type: "object", properties: {}, required: [], additionalProperties: false, pattern: "x" }), { code: "cost_guard_violation" });
  assert.throws(() => assertGeminiSchemaSubset({ type: "string", const: "x" }), /outside the Gemini subset/);
  assert.throws(() => toGeminiJsonSchema(z.object({ a: z.string().optional() })), { code: "cost_guard_violation" }, "non-strict schemas still fail closed");
}
for (const [name, real] of Object.entries({ verificationResultSchema, translatorGenerationSchema, editorGenerationSchema, classifierGenerationSchema, rankerGenerationSchema, criticCurrentGenerationSchema })) {
  const converted = toGeminiJsonSchema(real);
  assert.doesNotThrow(() => assertGeminiSchemaSubset(converted), name);
  assert.equal(converted.type, "object", name);
}

// ---------- 3. Local capacity accounting ----------
assert.deepEqual(readGeminiLimits({}), GEMINI_DEFAULT_LIMITS);
assert.deepEqual(readGeminiLimits({ GEMINI_LIMIT_RPM: "5", GEMINI_LIMIT_RPD: "50", GEMINI_LIMIT_TPM: "9000", GEMINI_LIMIT_TPD: "90000" }), { rpm: 5, rpd: 50, tpm: 9_000, tpd: 90_000 });
for (const bad of [{ GEMINI_LIMIT_RPM: "0" }, { GEMINI_LIMIT_RPD: "abc" }, { GEMINI_LIMIT_TPM: "-1" }, { GEMINI_LIMIT_TPD: "99999999999" }, { GEMINI_LIMIT_TPM: "50000" }, { GEMINI_LIMIT_RPM: "30" }]) {
  assert.throws(() => readGeminiLimits(bad), { code: "cost_guard_violation" }, JSON.stringify(bad));
}
assert.equal(new Date(nextPacificMidnightMs(Date.parse("2026-11-07T20:00:00Z"))).toISOString(), "2026-11-08T08:00:00.000Z", "PST midnight");
assert.equal(new Date(nextPacificMidnightMs(Date.parse("2026-07-01T12:00:00Z"))).toISOString(), "2026-07-02T07:00:00.000Z", "PDT midnight");
assert.equal(pacificDayKey(Date.parse("2026-11-08T07:59:00Z")), "2026-11-07");
assert.equal(pacificDayKey(Date.parse("2026-11-08T08:00:00Z")), "2026-11-08");
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const accountant = newAccountant({ rpm: 2, rpd: 3, tpm: 1_000, tpd: 2_500 });
  const first = accountant.reserve(400);
  first.markDispatched();
  first.settle(300);
  assert.equal(accountant.snapshot().dayTokens, 300, "estimate is replaced by the provider-reported figure");
  accountant.reserve(300).markDispatched();
  assert.throws(() => accountant.reserve(100), (error) => error instanceof GeminiLocalLimitError && error.limitKind === "RPM" && error.code === "PROVIDER_CAPACITY_EXHAUSTED" && error.retryAfterMs === 60_000);
  clock += 60_001;
  const third = accountant.reserve(900);
  assert.throws(() => accountant.reserve(1_001), { limitKind: "REQUEST_TOO_LARGE" });
  third.release();
  assert.equal(accountant.snapshot().dayRequests, 2, "a pre-dispatch release gives the capacity back");
  const dispatched = accountant.reserve(500);
  dispatched.markDispatched();
  dispatched.release();
  assert.equal(accountant.snapshot().dayRequests, 3, "a dispatched lease cannot be released");
  clock += 61_000;
  assert.throws(() => accountant.reserve(10), { limitKind: "RPD" }, "daily request limit");
  clock = Date.parse("2026-11-08T08:00:01Z");
  assert.doesNotThrow(() => accountant.reserve(10), "Pacific midnight resets the day");
}
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const tokens = newAccountant({ rpm: 10, rpd: 100, tpm: 1_000, tpd: 1_500 });
  tokens.reserve(800).markDispatched();
  assert.throws(() => tokens.reserve(300), (error) => error.limitKind === "TPM" && error.isMinuteWindow && error.retryAfterMs === 60_000);
  clock += 60_001;
  tokens.reserve(600).markDispatched();
  assert.throws(() => tokens.reserve(300), { limitKind: "TPD" }, "daily token limit");
  assert.throws(() => tokens.admitEvent({ requests: 6, tokens: 200, largestRequestTokens: 100 }), { code: "PROVIDER_CAPACITY_EXHAUSTED", limitKind: "TPD" }, "event admission needs daily token headroom for all stages");
}
{
  assert.deepEqual(parseGeminiRateLimitHint({ error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }, null), { retryAfterMs: null, scope: "day" });
  assert.deepEqual(parseGeminiRateLimitHint({ error: { details: [{ violations: [{ quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier" }] }, { retryDelay: "34s" }] } }, null), { retryAfterMs: 34_000, scope: "minute" });
  assert.deepEqual(parseGeminiRateLimitHint("garbage", 7), { retryAfterMs: 7_000, scope: "unknown" });
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-ledger-"));
  try {
    clock = Date.parse("2026-11-07T20:00:00Z");
    const file = path.join(dir, "ledger.json");
    const first = newAccountant({ rpd: 5 }, { store: new FileGeminiUsageStore(file) });
    first.reserve(100).markDispatched();
    first.recordRateLimited({ retryAfterMs: null, scope: "unknown" });
    const reloaded = newAccountant({ rpd: 5 }, { store: new FileGeminiUsageStore(file) });
    assert.equal(reloaded.snapshot().dayRequests, 1, "ledger file survives a restart");
    assert.throws(() => reloaded.reserve(10), { limitKind: "RATE_LIMITED_429" }, "a recorded 429 block survives a restart");
    fs.writeFileSync(file, "{ not json");
    const broken = newAccountant({ rpd: 5 }, { store: new FileGeminiUsageStore(file) });
    assert.throws(() => broken.reserve(10), { limitKind: "LEDGER_UNAVAILABLE" }, "unreadable ledger fails closed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- 4. Provider against a simulated Gemini endpoint ----------
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const accountant = newAccountant();
  const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, okBody({ title: "Hola", score: 7, tags: ["a"] })));
  const provider = newProvider(fetchImpl, accountant);
  const result = await provider.generateStructured(request());
  assert.deepEqual(result.output, { title: "Hola", score: 7, tags: ["a"] }, "thought parts are ignored");
  assert.equal(result.provider, "gemini_free");
  assert.equal(result.model, MODEL);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 40, totalTokens: 160 }, "thinking tokens count as output");
  assert.equal(result.diagnostics.providerUnit, "tokens");
  assert.equal(result.diagnostics.providerUnitUsageKnown, true);
  assert.equal(accountant.snapshot().dayTokens, 160, "settled to provider usage");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`);
  assert.equal(calls[0].headers["x-goog-api-key"], FAKE_KEY);
  assert.equal(JSON.stringify(calls[0].body).includes(FAKE_KEY), false, "the key never travels in the body");
  assert.equal(calls[0].body.systemInstruction.parts[0].text, "Return JSON.");
  assert.equal(calls[0].body.contents[0].parts[0].text, JSON.stringify({ text: "hello" }));
  assert.equal(calls[0].body.generationConfig.maxOutputTokens, 400);
  const sent = calls[0].body.generationConfig.responseFormat.text;
  assert.equal(sent.mimeType, "APPLICATION_JSON");
  assert.deepEqual(sent.schema, toGeminiJsonSchema(schema), "the converted schema is what is sent");
  assert.equal(JSON.stringify(sent.schema).includes("minLength"), false);

  const alt = makeFetch(() => jsonResponse(200, okBody({ title: "x", score: 1, tags: [] })));
  await newProvider(alt.fetchImpl, newAccountant(), { structuredFormat: "response_json_schema", thinking: { level: "low" } }).generateStructured(request({ config: { ...config, temperature: 0 } }));
  assert.equal(alt.calls[0].body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(alt.calls[0].body.generationConfig.responseJsonSchema, toGeminiJsonSchema(schema));
  assert.equal(alt.calls[0].body.generationConfig.responseFormat, undefined);
  assert.deepEqual(alt.calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: "low" });
  assert.equal(alt.calls[0].body.generationConfig.temperature, 0);

  const jsonMode = makeFetch(() => jsonResponse(200, okBody({ title: "x", score: 1, tags: [] })));
  await newProvider(jsonMode.fetchImpl).generateStructured(request({ config: { ...config, structuredOutputMode: "json_object" } }));
  assert.equal(jsonMode.calls[0].body.generationConfig.responseFormat.text.schema, undefined, "json_object mode sends no schema");

  assert.ok(estimateGeminiRequestTokens({ systemChars: 100, inputChars: 100, schemaChars: 100, maxOutputTokens: 400 }) === 150 + 128 + 400);
}
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const wrongModel = makeFetch(() => { throw new Error("must not dispatch"); });
  await assert.rejects(() => newProvider(wrongModel.fetchImpl).generateStructured(request({ config: { ...config, model: "gemini-3.1-flash-lite" } })), { code: "PAID_PROVIDER_FORBIDDEN" });
  await assert.rejects(() => newProvider(wrongModel.fetchImpl).generateStructured(request({ schema: z.object({ a: z.string().optional() }) })), { code: "cost_guard_violation" });
  assert.equal(wrongModel.calls.length, 0);
  assert.throws(() => new GeminiModelProvider({ apiKey: FAKE_KEY, model: MODEL, env: {}, fetchImpl: wrongModel.fetchImpl }), { code: "PAID_PROVIDER_FORBIDDEN" }, "constructing the adapter requires the gates");
}

// 429: fail closed, then local block without any network call
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const accountant = newAccountant({ rpm: 10, rpd: 100, tpm: 6_000, tpd: 40_000 });
  const { fetchImpl, calls } = makeFetch(() => jsonResponse(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `quota exceeded for key ${FAKE_KEY}`, details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }, { "retry-after": "30" }));
  const provider = newProvider(fetchImpl, accountant);
  const error = await provider.generateStructured(request()).catch((caught) => caught);
  assert.ok(error instanceof FreeTierLimitReachedError);
  assert.equal(error.diagnostics.httpStatus, 429);
  assert.equal(error.diagnostics.errorCategory, "RATE_LIMIT");
  assert.equal(error.diagnostics.rateLimitHeaders.retryAfterSeconds, 30);
  assert.equal(JSON.stringify(error.diagnostics).includes(FAKE_KEY), false, "the key is redacted from provider messages");
  assert.ok(error.diagnostics.providerMessage.includes("[REDACTED]"));
  await assert.rejects(() => provider.generateStructured(request()), (caught) => caught instanceof GeminiLocalLimitError && caught.limitKind === "RATE_LIMITED_429");
  assert.equal(calls.length, 1, "no request is sent while blocked");
  clock += 11 * 3_600_000;
  await assert.rejects(() => provider.generateStructured(request()), { limitKind: "RATE_LIMITED_429" }, "a daily-scope 429 blocks until the Pacific reset");
  clock = Date.parse("2026-11-08T08:00:01Z");
  assert.equal(accountant.snapshot().blockedUntil, null);
}
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const accountant = newAccountant({ rpm: 10, rpd: 100, tpm: 6_000, tpd: 40_000 });
  const { fetchImpl, calls } = makeFetch((count) => count === 1
    ? jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "slow down", details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }, { retryDelay: "34s" }] } })
    : jsonResponse(200, okBody({ title: "ok", score: 1, tags: [] })));
  const provider = newProvider(fetchImpl, accountant);
  await assert.rejects(() => provider.generateStructured(request()), FreeTierLimitReachedError);
  clock += 30_000;
  await assert.rejects(() => provider.generateStructured(request()), { limitKind: "RATE_LIMITED_429" });
  clock += 31_000;
  assert.equal((await provider.generateStructured(request())).output.title, "ok", "a minute-scoped 429 expires after the reported delay (min 60 s)");
  assert.equal(calls.length, 2);
}

// local limits are enforced before any request is sent; pacing is opt-in
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const { fetchImpl, calls } = makeFetch(() => jsonResponse(200, okBody({ title: "ok", score: 1, tags: [] })));
  const provider = newProvider(fetchImpl, newAccountant({ rpm: 1, rpd: 5, tpm: 6_000, tpd: 40_000 }));
  await provider.generateStructured(request());
  await assert.rejects(() => provider.generateStructured(request()), { code: "PROVIDER_CAPACITY_EXHAUSTED", limitKind: "RPM" });
  assert.equal(calls.length, 1, "the second request never leaves the process");

  const waits = [];
  const paced = newProvider(fetchImpl, newAccountant({ rpm: 1, rpd: 5, tpm: 6_000, tpd: 40_000 }), { pacingMaxWaitMs: 90_000, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  await paced.generateStructured(request());
  await paced.generateStructured(request());
  assert.equal(waits.length, 1, "pacing waits once for the rolling minute window");
  assert.ok(waits[0] >= 60_000 && waits[0] <= 61_000);
  const stingy = newProvider(fetchImpl, newAccountant({ rpm: 1, rpd: 5, tpm: 6_000, tpd: 40_000 }), { pacingMaxWaitMs: 1_000, sleep: async () => { throw new Error("must not wait beyond the bound"); } });
  await stingy.generateStructured(request());
  await assert.rejects(() => stingy.generateStructured(request()), { limitKind: "RPM" });
  const huge = newProvider(fetchImpl, newAccountant({ rpm: 5, rpd: 5, tpm: 500, tpd: 40_000 }));
  await assert.rejects(() => huge.generateStructured(request()), { limitKind: "REQUEST_TOO_LARGE" });
}

// other provider failures
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const cases = [
    [() => jsonResponse(400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "schema too complex" } }), { code: "provider_permanent" }],
    [() => jsonResponse(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "bad key" } }), { code: "provider_permanent" }],
    [() => jsonResponse(503, { error: { code: 503, status: "UNAVAILABLE", message: "busy" } }), { code: "provider_transient" }],
    [() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: "{\"title\":" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { totalTokenCount: 500 } }), { code: "invalid_structured_output" }],
    [() => jsonResponse(200, { promptFeedback: { blockReason: "SAFETY" } }), { code: "invalid_structured_output" }],
    [() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: "not json" }] }, finishReason: "STOP" }] }), { code: "invalid_structured_output" }],
    [() => new Response("<html>gateway</html>", { status: 200 }), { code: "invalid_structured_output" }],
  ];
  for (const [responder, expected] of cases) {
    const { fetchImpl } = makeFetch(responder);
    await assert.rejects(() => newProvider(fetchImpl).generateStructured(request()), expected);
  }
  const accountant = newAccountant();
  const { fetchImpl } = makeFetch(() => jsonResponse(200, { candidates: [{ content: { parts: [{ text: "{\"title\":" }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { totalTokenCount: 500 } }));
  await newProvider(fetchImpl, accountant).generateStructured(request()).catch(() => undefined);
  assert.equal(accountant.snapshot().dayTokens, 500, "usage reported on a failed generation is still settled");
  const network = newProvider(async () => { throw new TypeError("fetch failed"); }, accountant);
  await assert.rejects(() => network.generateStructured(request()), { code: "provider_transient" });
  assert.equal(accountant.snapshot().dayRequests, 2, "a dispatched request that failed on the network still counts");
}

// ---------- 5. Event session: single provider, no mid-event fallback ----------
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  const { fetchImpl, calls } = makeFetch((count) => count === 2
    ? jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } })
    : jsonResponse(200, okBody({ title: "ok", score: 1, tags: [] })));
  const accountant = newAccountant({ rpm: 10, rpd: 10, tpm: 6_000, tpd: 40_000 });
  const provider = newProvider(fetchImpl, accountant);
  const session = new GeminiEventSession(provider, { eventKey: "event-1", model: MODEL, stageTokens: 1_000 });
  assert.equal(Object.isFrozen(session.assignment), true);
  assert.doesNotThrow(() => assertGeminiStageAssignment(session.assignment, "event-1", "gemini_free", MODEL));
  assert.throws(() => assertGeminiStageAssignment(session.assignment, "event-1", "groq", MODEL), /EVENT_PROVIDER_ASSIGNMENT_MISMATCH/);
  assert.throws(() => assertGeminiStageAssignment(session.assignment, "event-2", "gemini_free", MODEL), /EVENT_PROVIDER_ASSIGNMENT_MISMATCH/);
  await assert.rejects(() => session.generateStructured(request({ config: { ...config, model: "gemini-3.1-flash-lite" } })), { code: "PAID_PROVIDER_FORBIDDEN" }, "stages cannot switch model");
  assert.equal((await session.generateStructured(request())).output.title, "ok");
  await assert.rejects(() => session.generateStructured(request()), FreeTierLimitReachedError);
  assert.equal(session.halted, "FREE_TIER_LIMIT_REACHED");
  await assert.rejects(() => session.generateStructured(request()), { limitKind: "RATE_LIMITED_429" }, "the event is halted, not redirected");
  assert.equal(calls.length, 2);

  const tight = newAccountant({ rpm: 10, rpd: 5, tpm: 6_000, tpd: 40_000 });
  assert.throws(() => new GeminiEventSession(newProvider(fetchImpl, tight), { eventKey: "event-3", model: MODEL }), { limitKind: "RPD" }, "an event that cannot finish today is not started");
  assert.throws(() => new GeminiEventSession(newProvider(fetchImpl, newAccountant({ tpd: 3_000, tpm: 3_000 })), { eventKey: "event-4", model: MODEL, stageTokens: 600 }), { limitKind: "TPD" });
  assert.throws(() => new GeminiEventSession(provider, { eventKey: "event-5", model: "gemini-4-argon" }), { code: "PAID_PROVIDER_FORBIDDEN" });

  const capped = new GeminiEventSession(newProvider(makeFetch(() => jsonResponse(200, okBody({ title: "ok", score: 1, tags: [] }))).fetchImpl, newAccountant({ rpm: 10, rpd: 20, tpm: 6_000, tpd: 40_000 })), { eventKey: "event-6", model: MODEL, maxRequests: 1 });
  await capped.generateStructured(request());
  await assert.rejects(() => capped.generateStructured(request()), { code: "cost_guard_violation" }, "per-event request cap");
}

// ---------- 6. Through the shared agent runner (no Groq/Cloudflare RPCs, zero retries) ----------
{
  clock = Date.parse("2026-11-07T20:00:00Z");
  resetSharedGeminiAccountantsForTests();
  const logger = new InMemoryAgentLogger();
  let reserveCalls = 0;
  const reserveRequest = logger.reserveRequest.bind(logger);
  logger.reserveRequest = async (...args) => { reserveCalls += 1; return reserveRequest(...args); };
  const { fetchImpl, calls } = makeFetch((count) => count === 1
    ? jsonResponse(200, okBody({ title: "Hola", score: 3, tags: ["x"] }))
    : jsonResponse(429, { error: { status: "RESOURCE_EXHAUSTED", message: "quota" } }));
  const accountant = newAccountant({ rpm: 10, rpd: 20, tpm: 6_000, tpd: 40_000 });
  const provider = newProvider(fetchImpl, accountant);
  const budget = new DailyRequestBudget(() => new Date(clock));
  const run = () => runStructuredAgent({ agentName: "gemini-fixture", agentVersion: "unit-v1", eventKey: "event-1", input: { text: "hello" }, systemInstructions: "Return JSON.", schemaName: "Fixture", schema, modelConfig: config, provider, logger, requestBudget: budget });
  const result = await run();
  assert.deepEqual(result.output, { title: "Hola", score: 3, tags: ["x"] });
  assert.equal(result.providerRequestsUsed, 1);
  assert.equal(result.diagnostics.provider, "gemini_free");
  assert.equal(result.telemetry.provider, "gemini_free");
  assert.equal(result.telemetry.providerUnit, "tokens");
  assert.equal(logger.runs[0].metadata.provider, "gemini_free");
  assert.equal(reserveCalls, 0, "the Groq/Cloudflare reservation path is never used for Gemini");
  assert.equal(budget.snapshot("mock").requests, 0, "the process-wide request budget is untouched");
  const failure = await run().catch((caught) => caught);
  assert.ok(failure instanceof FreeTierLimitReachedError, "429 surfaces as FREE_TIER_LIMIT_REACHED");
  assert.equal(budget.snapshot("mock").requests, 0);
  const blocked = await run().catch((caught) => caught);
  assert.ok(blocked instanceof AgentError && blocked.code === "PROVIDER_CAPACITY_EXHAUSTED", "later calls are denied locally");
  assert.equal(calls.length, 2);
  assert.equal(accountant.snapshot().dayRequests, 2);

  const spoof = { providerId: "gemini_free", async generateStructured() { throw new Error("must not dispatch"); } };
  await assert.rejects(() => runStructuredAgent({ agentName: "gemini-fixture", agentVersion: "unit-v1", eventKey: "event-1", input: {}, systemInstructions: "x", schemaName: "Fixture", schema, modelConfig: config, provider: spoof, logger, requestBudget: budget }), { code: "PAID_PROVIDER_FORBIDDEN" }, "a gemini_free impostor without local accounting is rejected");
}

console.log("provider:gemini:unit: OK (offline; simulated endpoint; no network, no secrets)");
