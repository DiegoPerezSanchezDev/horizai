import { AgentError, FreeTierLimitReachedError, MissingAgentConfigurationError, PaidProviderForbiddenError, PermanentProviderError, TransientProviderError } from "./agent-errors.ts";
import { assertGeminiFreeRequest, GEMINI_PROVIDER_ID, geminiGenerateContentEndpoint, geminiProviderEnabled, readGeminiModel } from "./gemini-policy.ts";
import { FileGeminiUsageStore, GeminiLimitAccountant, GeminiLocalLimitError, parseGeminiRateLimitHint, readGeminiLimits, readGeminiPacingMaxWaitMs, type GeminiLease } from "./gemini-capacity.ts";
import { toGeminiJsonSchema } from "./gemini-schema.ts";
import type { ModelProvider } from "./model-provider.ts";
import type { GenerateStructuredRequest, ModelProviderResponse, ProviderDiagnostics, ProviderErrorCategory, RateLimitHeaders, RequestMetrics } from "./runtime-types.ts";

type JsonObject = Record<string, unknown>;
export type GeminiStructuredFormat = "response_format" | "response_json_schema";
export type GeminiThinking = { level?: "minimal" | "low" | "medium" | "high"; budget?: number };

export interface GeminiAccountedProvider extends ModelProvider {
  readonly providerId: typeof GEMINI_PROVIDER_ID;
  readonly accountant: GeminiLimitAccountant;
  assertRequestApproved(model: string): void;
}

export function isGeminiAccountedProvider(provider: ModelProvider): provider is GeminiAccountedProvider {
  return provider.providerId === GEMINI_PROVIDER_ID
    && typeof (provider as Partial<GeminiAccountedProvider>).assertRequestApproved === "function"
    && (provider as Partial<GeminiAccountedProvider>).accountant instanceof GeminiLimitAccountant;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }

function providerErrorCategory(status: number): ProviderErrorCategory {
  if (status === 429) return "RATE_LIMIT";
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (status === 408) return "TIMEOUT";
  if (status >= 500) return "SERVER_ERROR";
  return "BAD_REQUEST";
}

function retryAfterSeconds(headers: Headers): number | null {
  const raw = headers.get("retry-after")?.trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : null;
}

function rateLimitHeaders(headers: Headers): RateLimitHeaders {
  const retryAfter = headers.get("retry-after");
  return {
    retryAfter, limitRequests: null, remainingRequests: null, limitTokens: null, remainingTokens: null,
    resetRequests: null, resetTokens: null, retryAfterSeconds: retryAfterSeconds(headers), resetRequestsSeconds: null, resetTokensSeconds: null,
  };
}

/** chars/2 + fixed overhead + full output budget: deliberately pessimistic, like the Groq stage estimator. */
export function estimateGeminiRequestTokens(input: { systemChars: number; inputChars: number; schemaChars: number; maxOutputTokens: number }): number {
  return Math.ceil((input.systemChars + input.inputChars + input.schemaChars) / 2) + 128 + input.maxOutputTokens;
}

export function readGeminiStructuredFormat(env: NodeJS.ProcessEnv = process.env): GeminiStructuredFormat {
  const raw = env.GEMINI_STRUCTURED_FORMAT?.trim().toLowerCase();
  if (!raw || raw === "response_format") return "response_format";
  if (raw === "response_json_schema") return "response_json_schema";
  throw new AgentError("cost_guard_violation", "GEMINI_STRUCTURED_FORMAT must be response_format or response_json_schema");
}

export function readGeminiThinking(env: NodeJS.ProcessEnv = process.env): GeminiThinking | undefined {
  const level = env.GEMINI_THINKING_LEVEL?.trim().toLowerCase();
  const budgetRaw = env.GEMINI_THINKING_BUDGET?.trim();
  if (level && budgetRaw) throw new AgentError("cost_guard_violation", "GEMINI_THINKING_LEVEL and GEMINI_THINKING_BUDGET are mutually exclusive");
  if (level) {
    if (!["minimal", "low", "medium", "high"].includes(level)) throw new AgentError("cost_guard_violation", "GEMINI_THINKING_LEVEL must be minimal, low, medium or high");
    return { level: level as NonNullable<GeminiThinking["level"]> };
  }
  if (budgetRaw) {
    const budget = Number(budgetRaw);
    if (!/^\d+$/.test(budgetRaw) || !Number.isSafeInteger(budget) || budget > 24_576) throw new AgentError("cost_guard_violation", "GEMINI_THINKING_BUDGET must be an integer between 0 and 24576");
    return { budget };
  }
  return undefined;
}

export type GeminiProviderOptions = {
  apiKey: string;
  model: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  accountant?: GeminiLimitAccountant;
  structuredFormat?: GeminiStructuredFormat;
  thinking?: GeminiThinking;
  pacingMaxWaitMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

/**
 * Gemini Developer API adapter over native `generateContent` (https://ai.google.dev/gemini-api/docs/structured-output).
 * Inert unless the policy gates in gemini-policy.ts are set; capacity is enforced locally before every dispatch and
 * a provider 429 blocks further dispatches (fail closed, no retry, no fallback).
 */
export class GeminiModelProvider implements GeminiAccountedProvider {
  readonly providerId = GEMINI_PROVIDER_ID;
  readonly accountant: GeminiLimitAccountant;
  readonly model: string;
  private readonly apiKey: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly structuredFormat: GeminiStructuredFormat;
  private readonly thinking?: GeminiThinking;
  private readonly pacingMaxWaitMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: GeminiProviderOptions) {
    this.env = options.env ?? process.env;
    this.endpoint = geminiGenerateContentEndpoint(options.model);
    assertGeminiFreeRequest(options.model, this.endpoint, this.env);
    if (!options.apiKey.trim()) throw new MissingAgentConfigurationError(["GEMINI_API_KEY"]);
    this.apiKey = options.apiKey.trim();
    this.model = options.model;
    this.accountant = options.accountant ?? new GeminiLimitAccountant(readGeminiLimits(this.env));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.structuredFormat = options.structuredFormat ?? readGeminiStructuredFormat(this.env);
    this.thinking = options.thinking ?? readGeminiThinking(this.env);
    this.pacingMaxWaitMs = options.pacingMaxWaitMs ?? readGeminiPacingMaxWaitMs(this.env);
    this.sleep = options.sleep ?? defaultSleep;
  }

  assertRequestApproved(model: string): void {
    if (model !== this.model) throw new PaidProviderForbiddenError();
    assertGeminiFreeRequest(model, this.endpoint, this.env);
  }

  private safeText(value: unknown, maxLength = 1_000): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    let safe = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    safe = safe.replaceAll(this.apiKey, "[REDACTED]").replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]").replace(/([?&]key=)[^\s&"']+/gi, "$1[REDACTED]");
    return safe.slice(0, maxLength);
  }

  private async reserveWithPacing(estimatedTokens: number, signal?: AbortSignal): Promise<GeminiLease> {
    const deadline = Date.now() + this.pacingMaxWaitMs;
    for (;;) {
      try {
        return this.accountant.reserve(estimatedTokens);
      } catch (error) {
        if (!(error instanceof GeminiLocalLimitError) || !error.isMinuteWindow || error.retryAfterMs === null || this.pacingMaxWaitMs === 0) throw error;
        const wait = error.retryAfterMs + 250;
        if (Date.now() + wait > deadline) throw error;
        await this.sleep(wait, signal);
      }
    }
  }

  private requestBody(request: GenerateStructuredRequest<unknown>, schema: JsonObject | null, inputJson: string): string {
    const structured: JsonObject = this.structuredFormat === "response_json_schema"
      ? { responseMimeType: "application/json", ...(schema ? { responseJsonSchema: schema } : {}) }
      : { responseFormat: { text: { mimeType: "APPLICATION_JSON", ...(schema ? { schema } : {}) } } };
    return JSON.stringify({
      systemInstruction: { parts: [{ text: request.systemInstructions }] },
      contents: [{ role: "user", parts: [{ text: inputJson }] }],
      generationConfig: {
        maxOutputTokens: request.config.maxOutputTokens,
        ...(request.config.temperature === undefined ? {} : { temperature: request.config.temperature }),
        ...structured,
        ...(this.thinking ? { thinkingConfig: this.thinking.level ? { thinkingLevel: this.thinking.level } : { thinkingBudget: this.thinking.budget } } : {}),
      },
    });
  }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<ModelProviderResponse<T>> {
    this.assertRequestApproved(request.config.model);
    const schema = request.config.structuredOutputMode === "json_object" ? null : toGeminiJsonSchema(request.schema);
    const expectedFields = schema && Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : [];
    const schemaJson = schema ? JSON.stringify(schema) : "";
    const inputJson = JSON.stringify(request.input);
    const bodyJson = this.requestBody(request as GenerateStructuredRequest<unknown>, schema, inputJson);
    const baseMetrics = request.requestMetrics ?? {
      systemPromptChars: request.systemInstructions.length, inputChars: inputJson.length, schemaChars: schemaJson.length,
      sourceCount: 0, originalContentChars: [], sentContentChars: [], truncated: [],
    } satisfies RequestMetrics;
    const requestMetrics: RequestMetrics = {
      ...baseMetrics,
      maxOutputTokensRequested: request.config.maxOutputTokens,
      bodyBytes: byteLength(bodyJson),
      systemPromptChars: request.systemInstructions.length,
      inputChars: inputJson.length,
      schemaChars: schemaJson.length,
    };
    const estimatedTokens = estimateGeminiRequestTokens({ systemChars: request.systemInstructions.length, inputChars: inputJson.length, schemaChars: schemaJson.length, maxOutputTokens: request.config.maxOutputTokens });
    const lease = await this.reserveWithPacing(estimatedTokens, request.signal);
    try {
      await request.onRequestDispatched?.();
    } catch (error) {
      lease.release();
      throw error;
    }
    lease.markDispatched();

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: bodyJson,
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new TransientProviderError("Model provider request failed", error, { provider: GEMINI_PROVIDER_ID, errorCategory: "NETWORK_ERROR", providerRequestDispatched: true });
    }

    const responseText = await response.text();
    let body: unknown;
    let bodyParseable = true;
    try { body = JSON.parse(responseText) as unknown; } catch { bodyParseable = false; }
    let diagnostics: ProviderDiagnostics = {
      provider: GEMINI_PROVIDER_ID, httpStatus: response.status, rateLimitHeaders: rateLimitHeaders(response.headers), requestMetrics,
      providerUnit: "tokens", providerUnitUsageKnown: false, structuredOutputMode: request.config.structuredOutputMode,
      responseBodyBytes: byteLength(responseText), responseBodyChars: responseText.length, responseJsonParseable: bodyParseable,
      responseTopLevelFields: isRecord(body) ? Object.keys(body) : [], responseMissingTopLevelFields: [], validationResult: "not_run",
    };

    if (!response.ok) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : null;
      diagnostics = {
        ...diagnostics, failureKind: "PROVIDER_HTTP_ERROR", errorCategory: providerErrorCategory(response.status),
        providerMessage: this.safeText(error?.message), providerType: this.safeText(error?.status, 200),
        providerCode: this.safeText(typeof error?.code === "number" ? String(error.code) : error?.code, 200),
      };
      const suffix = diagnostics.providerMessage ? `: ${diagnostics.providerMessage}` : "";
      if (response.status === 429) {
        this.accountant.recordRateLimited(parseGeminiRateLimitHint(body, retryAfterSeconds(response.headers)));
        throw new FreeTierLimitReachedError(diagnostics);
      }
      if (response.status === 408 || response.status >= 500) throw new TransientProviderError(`Model provider returned HTTP ${response.status}${suffix}`, undefined, diagnostics);
      throw new PermanentProviderError(`Model provider returned HTTP ${response.status}${suffix}`, undefined, diagnostics);
    }

    const invalid = (message: string, extra: Partial<ProviderDiagnostics>, cause?: unknown): AgentError => new AgentError("invalid_structured_output", message, cause, {
      ...diagnostics, ...extra, validationResult: "invalid", errorCategory: "INVALID_RESPONSE",
    });
    if (!bodyParseable || !isRecord(body)) throw invalid("Model provider returned invalid JSON", { failureKind: "LOCAL_JSON_PARSE_ERROR", contentJsonParseable: false });

    const usageMetadata = isRecord(body.usageMetadata) ? body.usageMetadata : null;
    const count = (key: string): number | undefined => {
      const value = usageMetadata?.[key];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    };
    const promptTokens = count("promptTokenCount");
    const outputTokens = count("candidatesTokenCount") !== undefined || count("thoughtsTokenCount") !== undefined
      ? (count("candidatesTokenCount") ?? 0) + (count("thoughtsTokenCount") ?? 0)
      : undefined;
    const totalTokens = count("totalTokenCount") ?? (promptTokens !== undefined && outputTokens !== undefined ? promptTokens + outputTokens : undefined);
    const usage = totalTokens !== undefined && totalTokens > 0 ? { inputTokens: promptTokens, outputTokens, totalTokens } : undefined;
    if (usage) {
      lease.settle(usage.totalTokens);
      diagnostics = { ...diagnostics, providerUnitUsageKnown: true, actualProviderUnitUsage: usage.totalTokens, usage };
    }

    const candidate = Array.isArray(body.candidates) && isRecord(body.candidates[0]) ? body.candidates[0] : null;
    const blockReason = isRecord(body.promptFeedback) && typeof body.promptFeedback.blockReason === "string" ? body.promptFeedback.blockReason : null;
    if (!candidate) throw invalid(blockReason ? "Model provider blocked the prompt" : "Model provider response must contain a candidate", { failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR", contentJsonParseable: false, finishReason: blockReason });
    const finishReason = typeof candidate.finishReason === "string" ? candidate.finishReason : null;
    diagnostics = { ...diagnostics, finishReason };
    if (finishReason !== null && finishReason !== "STOP") {
      throw invalid(`Model provider stopped with ${finishReason}`, {
        failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR", contentJsonParseable: false,
        failedGenerationReason: finishReason === "MAX_TOKENS" ? "max_completion_tokens_reached" : null,
      });
    }
    const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
    const text = parts.filter((part): part is JsonObject => isRecord(part) && part.thought !== true && typeof part.text === "string").map((part) => part.text as string).join("");
    if (!text) throw invalid("Model provider message content must be JSON text", { failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR", contentJsonParseable: false });
    let output: unknown;
    try {
      output = JSON.parse(text) as unknown;
    } catch (error) {
      throw invalid("Model provider returned invalid JSON content", { failureKind: "LOCAL_JSON_PARSE_ERROR", contentJsonParseable: false }, error);
    }
    const outputFields = isRecord(output) ? Object.keys(output) : [];
    diagnostics = {
      ...diagnostics, failureKind: "SUCCESS", contentJsonParseable: true,
      responseTopLevelFields: outputFields, responseMissingTopLevelFields: expectedFields.filter((field) => !outputFields.includes(field)),
    };
    return { output: output as T, model: request.config.model, provider: GEMINI_PROVIDER_ID, usage, diagnostics };
  }
}

const sharedAccountants = new Map<string, GeminiLimitAccountant>();

/**
 * Builds the provider only when every gate is set. Accountants are shared per limits+ledger inside one process so
 * two provider instances cannot double the local budget. Order matters: policy gates first, then configuration.
 */
export function createGeminiModelProvider(env: NodeJS.ProcessEnv = process.env, overrides: Partial<GeminiProviderOptions> = {}): GeminiModelProvider {
  if (!geminiProviderEnabled(env)) throw new PaidProviderForbiddenError();
  const missing = ["GEMINI_API_KEY", "GEMINI_MODEL"].filter((name) => !env[name]?.trim());
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const limits = readGeminiLimits(env);
  const ledger = env.GEMINI_USAGE_LEDGER_PATH?.trim();
  const key = JSON.stringify([limits, ledger ?? ""]);
  let accountant = overrides.accountant ?? sharedAccountants.get(key);
  if (!accountant) {
    accountant = new GeminiLimitAccountant(limits, ledger ? { store: new FileGeminiUsageStore(ledger) } : {});
    sharedAccountants.set(key, accountant);
  }
  return new GeminiModelProvider({ apiKey: env.GEMINI_API_KEY!, model: readGeminiModel(env)!, env, ...overrides, accountant });
}

/** Test hook: forgets the process-wide accountants. */
export function resetSharedGeminiAccountantsForTests(): void { sharedAccountants.clear(); }
