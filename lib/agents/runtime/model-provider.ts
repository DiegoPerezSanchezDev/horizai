import { AgentError, FreeTierLimitReachedError, MissingAgentConfigurationError, PaidProviderForbiddenError, PermanentProviderError, TransientProviderError } from "./agent-errors.ts";
import { toStrictProviderJsonSchema } from "./strict-json-schema.ts";
import { assertFreeProviderRequest, type FreeProviderId, type ProviderId } from "./provider-cost-policy.ts";
import { estimateCloudflareNeurons, readCloudflareNeuronRates } from "./free-provider-router.ts";
import { GEMINI_PROVIDER_ID } from "./gemini-policy.ts";
import { createGeminiModelProvider } from "./gemini-provider.ts";
import type { GenerateStructuredRequest, ModelConfig, ModelProviderResponse, ProviderDiagnostics, ProviderErrorCategory, ProviderRateLimitTelemetry, RateLimitHeaders, RequestMetrics } from "./runtime-types.ts";

export interface ModelProvider {
  readonly providerId?: string;
  generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<ModelProviderResponse<T>>;
}

export function providerErrorCategory(status: number): ProviderErrorCategory {
  if (status === 429) return "RATE_LIMIT";
  if (status === 401 || status === 403) return "AUTH_ERROR";
  if (status === 408) return "TIMEOUT";
  if (status >= 500) return "SERVER_ERROR";
  return "BAD_REQUEST";
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new MissingAgentConfigurationError([name]);
  return value;
}

function missingEnv(names: string[]): string[] {
  return names.filter((name) => !process.env[name]?.trim());
}

function safeProviderText(value: unknown, maxLength = 1_000): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let safe = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  safe = safe.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  for (const name of ["AGENT_API_KEY", "CEREBRAS_API_KEY", "CLOUDFLARE_AI_API_TOKEN", "GEMINI_API_KEY", "SUPABASE_SECRET_KEY"]) {
    const secret = process.env[name]?.trim();
    if (secret) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  return safe.slice(0, maxLength);
}

export function parseDurationSeconds(value: string | null): number | null {
  if (!value?.trim()) return null;
  const text = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  const pattern = /\s*(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gy;
  let offset = 0;
  let seconds = 0;
  while (offset < text.length) {
    pattern.lastIndex = offset;
    const part = pattern.exec(text);
    if (!part || part.index !== offset) return null;
    const amount = Number(part[1]);
    if (!Number.isFinite(amount) || amount < 0) return null;
    const unit = part[2];
    seconds += unit === "h" ? amount * 3_600 : unit === "m" ? amount * 60 : unit === "ms" ? amount / 1_000 : amount;
    if (!Number.isFinite(seconds)) return null;
    offset = pattern.lastIndex;
  }
  return seconds;
}

function nonnegativeHeaderInteger(value: string | null | undefined): number | null {
  if (!value?.trim() || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function safeResetHeader(value: string | null | undefined): string | null {
  const reset = value?.trim();
  if (!reset || reset.length > 80) return null;
  if (/^[\da-zA-Z:.,+\-]+$/.test(reset)) return reset;
  const timestamp = Date.parse(reset);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Maps Groq's allowlisted headers to explicit RPD/TPM fields; it never infers RPM/TPD. */
export function normalizeGroqProviderRateLimit(headers: RateLimitHeaders | null | undefined): ProviderRateLimitTelemetry {
  if (!headers) return {
    requestLimitDaily: null, requestRemainingDaily: null, requestReset: null, requestResetSeconds: null,
    tokenLimitMinute: null, tokenRemainingMinute: null, tokenReset: null, tokenResetSeconds: null, retryAfterSeconds: null,
  };
  const requestResetHeader = headers.resetRequestsDay ?? headers.resetRequests;
  const tokenResetHeader = headers.resetTokensMinute ?? headers.resetTokens;
  const requestResetSeconds = parseDurationSeconds(requestResetHeader) ?? headers.resetRequestsSeconds;
  const tokenResetSeconds = parseDurationSeconds(tokenResetHeader) ?? headers.resetTokensSeconds;
  return {
    requestLimitDaily: nonnegativeHeaderInteger(headers.limitRequestsDay ?? headers.limitRequests),
    requestRemainingDaily: nonnegativeHeaderInteger(headers.remainingRequestsDay ?? headers.remainingRequests),
    requestReset: safeResetHeader(requestResetHeader),
    requestResetSeconds: requestResetSeconds !== null && requestResetSeconds >= 0 ? requestResetSeconds : null,
    tokenLimitMinute: nonnegativeHeaderInteger(headers.limitTokensMinute ?? headers.limitTokens),
    tokenRemainingMinute: nonnegativeHeaderInteger(headers.remainingTokensMinute ?? headers.remainingTokens),
    tokenReset: safeResetHeader(tokenResetHeader),
    tokenResetSeconds: tokenResetSeconds !== null && tokenResetSeconds >= 0 ? tokenResetSeconds : null,
    retryAfterSeconds: headers.retryAfterSeconds !== null && headers.retryAfterSeconds !== undefined && headers.retryAfterSeconds >= 0 ? headers.retryAfterSeconds : null,
  };
}

export function readRateLimitHeaders(headers: Headers): RateLimitHeaders {
  const retryAfter = headers.get("retry-after");
  const resetRequests = headers.get("x-ratelimit-reset-requests");
  const resetTokens = headers.get("x-ratelimit-reset-tokens");
  return {
    retryAfter,
    limitRequests: headers.get("x-ratelimit-limit-requests"),
    remainingRequests: headers.get("x-ratelimit-remaining-requests"),
    limitTokens: headers.get("x-ratelimit-limit-tokens"),
    remainingTokens: headers.get("x-ratelimit-remaining-tokens"),
    resetRequests,
    resetTokens,
    retryAfterSeconds: parseDurationSeconds(retryAfter),
    resetRequestsSeconds: parseDurationSeconds(resetRequests),
    resetTokensSeconds: parseDurationSeconds(resetTokens),
    limitRequestsDay: headers.get("x-ratelimit-limit-requests-day"),
    remainingRequestsDay: headers.get("x-ratelimit-remaining-requests-day"),
    resetRequestsDay: headers.get("x-ratelimit-reset-requests-day"),
    limitTokensMinute: headers.get("x-ratelimit-limit-tokens-minute"),
    remainingTokensMinute: headers.get("x-ratelimit-remaining-tokens-minute"),
    resetTokensMinute: headers.get("x-ratelimit-reset-tokens-minute"),
  };
}

function failedGenerationDetails(value: unknown, expectedFields: string[]): Pick<ProviderDiagnostics, "failedGenerationPresent" | "failedGenerationType" | "failedGenerationChars" | "failedGenerationJsonParseable" | "failedGenerationTopLevelFields" | "failedGenerationReason" | "failedGenerationMissingRequiredFields"> {
  if (value === undefined) return { failedGenerationPresent: false, failedGenerationType: null, failedGenerationChars: null, failedGenerationJsonParseable: null, failedGenerationTopLevelFields: [], failedGenerationReason: null, failedGenerationMissingRequiredFields: [] };
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  let parsed: unknown = value;
  let jsonParseable = true;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      jsonParseable = false;
    }
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  const lower = serialized.toLowerCase();
  const reason = lower.includes("max completion tokens") || lower.includes("maximum completion tokens") || lower.includes("length limit")
    ? "max_completion_tokens_reached"
    : lower.includes("missing required") || lower.includes("required field") || lower.includes("required properties")
      ? "missing_required_fields"
      : lower.includes("schema") || lower.includes("jsonschema")
        ? "schema_mismatch"
        : lower.includes("no choices")
          ? "no_choices"
          : lower.includes("malformed") || lower.includes("invalid json")
            ? "malformed_json"
            : null;
  const topLevelFields = isRecord(parsed) ? Object.keys(parsed) : [];
  const missingRequiredFields = expectedFields.filter((field) => !topLevelFields.includes(field));
  return {
    failedGenerationPresent: true,
    failedGenerationType: type,
    failedGenerationChars: serialized.length,
    failedGenerationJsonParseable: jsonParseable,
    failedGenerationTopLevelFields: topLevelFields,
    failedGenerationReason: reason,
    failedGenerationMissingRequiredFields: missingRequiredFields,
  };
}

async function providerErrorDetails(response: Response, requestMetrics: RequestMetrics, expectedFields: string[]): Promise<ProviderDiagnostics> {
  let providerMessage: string | null = null;
  let providerType: string | null = null;
  let providerCode: string | null = null;
  const responseText = await response.text();
  const responseMetrics = {
    responseBodyBytes: byteLength(responseText),
    responseBodyChars: responseText.length,
    responseJsonParseable: false,
    responseTopLevelFields: [] as string[],
    responseMissingTopLevelFields: [],
    validationResult: "not_run" as const,
    failureKind: "PROVIDER_HTTP_ERROR" as const,
  };
  try {
    const body: unknown = JSON.parse(responseText);
    responseMetrics.responseJsonParseable = true;
    if (isRecord(body)) responseMetrics.responseTopLevelFields = Object.keys(body);
    if (isRecord(body) && isRecord(body.error)) {
      providerMessage = safeProviderText(body.error.message);
      providerType = safeProviderText(body.error.type, 200);
      providerCode = safeProviderText(body.error.code, 200);
      const failedGeneration = failedGenerationDetails(body.error.failed_generation, expectedFields);
      return { httpStatus: response.status, providerMessage, providerType, providerCode, rateLimitHeaders: readRateLimitHeaders(response.headers), requestMetrics, ...responseMetrics, ...failedGeneration };
    }
  } catch {
    // Keep diagnostics safe and bounded when the provider returns non-JSON text.
  }
  return { httpStatus: response.status, providerMessage, providerType, providerCode, rateLimitHeaders: readRateLimitHeaders(response.headers), requestMetrics, ...responseMetrics, ...failedGenerationDetails(undefined, expectedFields) };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** OpenAI-compatible adapter. The endpoint remains configured by environment. */
export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly providerId: ProviderId;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly enforceFreeOnly: boolean;
  private readonly configuredModel?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly supportsIncludeReasoning: boolean;

  constructor(endpoint: string, apiKey: string, options: { providerId?: ProviderId; enforceFreeOnly?: boolean; configuredModel?: string; fetchImpl?: typeof fetch; supportsIncludeReasoning?: boolean } = {}) {
    this.providerId = options.providerId ?? "groq";
    this.endpoint = endpoint.replace(/\/$/, "").endsWith("/chat/completions")
      ? endpoint
      : `${endpoint.replace(/\/$/, "")}/chat/completions`;
    this.apiKey = apiKey;
    this.enforceFreeOnly = options.enforceFreeOnly ?? false;
    this.configuredModel = options.configuredModel;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.supportsIncludeReasoning = options.supportsIncludeReasoning ?? true;
  }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<ModelProviderResponse<T>> {
    if (this.enforceFreeOnly) assertFreeProviderRequest(this.providerId, request.config.model, this.endpoint);
    if (this.configuredModel && request.config.model !== this.configuredModel) throw new PaidProviderForbiddenError();
    const schema = toStrictProviderJsonSchema(request.schema);
    const expectedFields = Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === "string") : [];
    const schemaJson = JSON.stringify(schema);
    const inputJson = JSON.stringify(request.input);
    const baseMetrics = request.requestMetrics ?? {
      systemPromptChars: request.systemInstructions.length,
      inputChars: inputJson.length,
      schemaChars: schemaJson.length,
      sourceCount: 0,
      originalContentChars: [],
      sentContentChars: [],
      truncated: [],
    } satisfies RequestMetrics;
    const responseFormat = request.config.structuredOutputMode === "json_object"
      ? { type: "json_object" }
      : {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: request.config.structuredOutputMode === "strict_schema",
            schema,
          },
        };
    const outputTokenLimit = this.providerId === "cloudflare_workers_ai"
      ? { max_tokens: request.config.maxOutputTokens }
      : { max_completion_tokens: request.config.maxOutputTokens };
    const requestBody = {
      model: request.config.model,
      messages: [
        { role: "system", content: request.systemInstructions },
        { role: "user", content: inputJson },
      ],
      response_format: responseFormat,
      stream: false,
      ...(request.config.temperature === undefined ? {} : { temperature: request.config.temperature }),
      ...(request.config.reasoningEffort === undefined ? {} : { reasoning_effort: request.config.reasoningEffort }),
      ...(this.supportsIncludeReasoning && request.config.includeReasoning !== undefined ? { include_reasoning: request.config.includeReasoning } : {}),
      ...outputTokenLimit,
    };
    const bodyJson = JSON.stringify(requestBody);
    const requestMetrics: RequestMetrics = {
      ...baseMetrics,
      maxOutputTokensRequested: request.config.maxOutputTokens,
      bodyBytes: byteLength(bodyJson),
      systemPromptChars: request.systemInstructions.length,
      inputChars: inputJson.length,
      schemaChars: schemaJson.length,
    };
    let response: Response;
    // A failed persistent dispatch marker is local and must stay pre-dispatch.
    await request.onRequestDispatched?.();
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: bodyJson,
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new TransientProviderError("Model provider request failed", error, { provider: this.providerId, errorCategory: "NETWORK_ERROR", providerRequestDispatched: true });
    }

    let diagnostics: ProviderDiagnostics = response.ok
      ? { httpStatus: response.status, rateLimitHeaders: readRateLimitHeaders(response.headers), requestMetrics, validationResult: "not_run" }
      : await providerErrorDetails(response, requestMetrics, expectedFields);
    diagnostics = {
      ...diagnostics,
      provider: this.providerId,
      ...(this.providerId === "groq" ? { providerRateLimit: normalizeGroqProviderRateLimit(diagnostics.rateLimitHeaders) } : {}),
      ...(this.providerId === "cloudflare_workers_ai" ? { providerUnit: "neurons" as const, providerUnitUsageKnown: false, actualProviderUnitUsage: null } : {}),
      ...(response.ok ? {} : { errorCategory: providerErrorCategory(response.status) }),
      structuredOutputMode: request.config.structuredOutputMode,
      ...(request.config.reasoningEffort === undefined ? {} : { reasoningEffort: request.config.reasoningEffort }),
      ...(request.config.includeReasoning === undefined ? {} : { includeReasoning: request.config.includeReasoning }),
    };
    if (!response.ok) {
      const suffix = diagnostics.providerMessage ? `: ${diagnostics.providerMessage}` : "";
      if (response.status === 429) throw new FreeTierLimitReachedError(diagnostics);
      if (response.status === 408 || response.status >= 500) {
        throw new TransientProviderError(`Model provider returned HTTP ${response.status}${suffix}`, undefined, diagnostics);
      }
      throw new PermanentProviderError(`Model provider returned HTTP ${response.status}${suffix}`, undefined, diagnostics);
    }

    let responseText = "";
    let body: unknown;
    try {
      responseText = await response.text();
      body = JSON.parse(responseText) as unknown;
      diagnostics = {
        ...diagnostics,
        responseBodyBytes: byteLength(responseText),
        responseBodyChars: responseText.length,
        responseJsonParseable: true,
        responseTopLevelFields: isRecord(body) ? Object.keys(body) : [],
        responseMissingTopLevelFields: [],
        failureKind: "SUCCESS",
      };
    } catch (error) {
      const text = typeof responseText === "string" ? responseText : "";
      throw new AgentError("invalid_structured_output", "Model provider returned invalid JSON", error, {
        ...diagnostics,
        responseBodyBytes: byteLength(text),
        responseBodyChars: text.length,
        responseJsonParseable: false,
        contentJsonParseable: false,
        responseTopLevelFields: [],
        responseMissingTopLevelFields: [],
        validationResult: "invalid",
        failureKind: "LOCAL_JSON_PARSE_ERROR",
        errorCategory: "INVALID_RESPONSE",
      });
    }
    if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0]) || !isRecord(body.choices[0].message)) {
    throw new AgentError("invalid_structured_output", "Model provider response must contain a chat completion choice", undefined, {
      ...diagnostics,
      validationResult: "invalid",
      failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR",
      errorCategory: "INVALID_RESPONSE",
      contentJsonParseable: false,
    });
    }

    const usage = isRecord(body.usage)
      ? {
          inputTokens: typeof body.usage.prompt_tokens === "number" ? body.usage.prompt_tokens : undefined,
          outputTokens: typeof body.usage.completion_tokens === "number" ? body.usage.completion_tokens : undefined,
          totalTokens: typeof body.usage.total_tokens === "number" ? body.usage.total_tokens : undefined,
        }
      : undefined;
    const content = body.choices[0].message.content;
    const finishReason = typeof body.choices[0].finish_reason === "string" ? body.choices[0].finish_reason : null;
    const estimatedNeurons = this.providerId === "cloudflare_workers_ai" && usage?.inputTokens !== undefined && usage.outputTokens !== undefined
      ? estimateCloudflareNeurons({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...readCloudflareNeuronRates(process.env, request.config.model) })
      : null;
    const providerDiagnostics = { ...diagnostics, finishReason, usage, ...(this.providerId === "cloudflare_workers_ai" ? { providerUnit: "neurons" as const, providerUnitUsageKnown: false, estimatedNeurons, actualProviderUnitUsage: null } : {}) };
    if (typeof content !== "string") throw new AgentError("invalid_structured_output", "Model provider message content must be JSON text", undefined, {
      ...providerDiagnostics,
      validationResult: "invalid",
      failureKind: "LOCAL_SCHEMA_VALIDATION_ERROR",
      errorCategory: "INVALID_RESPONSE",
      contentJsonParseable: false,
    });
    let output: unknown;
    try {
      output = JSON.parse(content) as unknown;
    } catch (error) {
      throw new AgentError("invalid_structured_output", "Model provider returned invalid JSON content", error, {
        ...providerDiagnostics,
        responseBodyBytes: byteLength(responseText),
        responseBodyChars: responseText.length,
        responseJsonParseable: true,
        contentJsonParseable: false,
        responseTopLevelFields: [],
        responseMissingTopLevelFields: [],
        validationResult: "invalid",
        failureKind: "LOCAL_JSON_PARSE_ERROR",
        errorCategory: "INVALID_RESPONSE",
      });
    }

    const outputFields = isRecord(output) ? Object.keys(output) : [];
    const missingFields = expectedFields.filter((field): field is string => typeof field === "string" && !outputFields.includes(field));
    const outputDiagnostics: ProviderDiagnostics = {
      ...providerDiagnostics,
      contentJsonParseable: true,
      responseTopLevelFields: outputFields,
      responseMissingTopLevelFields: missingFields,
    };

    const effectiveModel = typeof body.model === "string" && body.model.trim() ? body.model : request.config.model;
    if (this.enforceFreeOnly) assertFreeProviderRequest(this.providerId, effectiveModel, this.endpoint);
    return { output: output as T, model: effectiveModel, provider: this.providerId, usage, diagnostics: outputDiagnostics };
  }
}

/** Historical adapter retained for explicit non-production testing; trial-only policy excludes it from the free router. */
export class CerebrasModelProvider extends OpenAICompatibleModelProvider {
  constructor(apiKey: string, configuredModel: string, fetchImpl?: typeof fetch) {
    super("https://api.cerebras.ai/v1", apiKey, { providerId: "cerebras", enforceFreeOnly: false, configuredModel, fetchImpl, supportsIncludeReasoning: false });
  }
}

export function createProviderClient(providerId: FreeProviderId = "groq"): ModelProvider {
  if (providerId !== "groq") throw new PaidProviderForbiddenError();
  const missing = missingEnv(["AGENT_API_URL", "AGENT_API_KEY"]);
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  const url = readRequiredEnv("AGENT_API_URL");
  assertFreeProviderRequest("groq", "openai/gpt-oss-20b", `${url.replace(/\/$/, "")}/chat/completions`);
  return new OpenAICompatibleModelProvider(url, readRequiredEnv("AGENT_API_KEY"), { providerId: "groq", enforceFreeOnly: true });
}

export function createConfiguredModelProvider(): ModelProvider {
  // Gemini is opt-in twice: AGENT_PROVIDER must name it AND createGeminiModelProvider requires its own activation gates.
  if (process.env.AGENT_PROVIDER?.trim().toLowerCase() === GEMINI_PROVIDER_ID) return createGeminiModelProvider();
  const missing = missingEnv(["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY"]);
  if (missing.length > 0) throw new MissingAgentConfigurationError(missing);
  if (readRequiredEnv("AGENT_PROVIDER").toLowerCase() !== "groq") throw new PaidProviderForbiddenError();
  return createProviderClient("groq");
}

export type MockProviderResponder = (request: GenerateStructuredRequest<unknown>) => unknown | Promise<unknown>;

export class MockModelProvider implements ModelProvider {
  readonly providerId = "mock";
  calls = 0;
  private readonly responder: MockProviderResponder;

  constructor(responder: MockProviderResponder) {
    this.responder = responder;
  }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<ModelProviderResponse<T>> {
    this.calls += 1;
    await request.onRequestDispatched?.();
    const output = await this.responder(request as GenerateStructuredRequest<unknown>);
    return { output: output as T, model: request.config.model, provider: this.providerId };
  }
}

export type { ModelConfig };
