import "server-only";

import { MissingAgentConfigurationError } from "./agent-errors.ts";
import { OpenAICompatibleModelProvider } from "./model-provider.ts";
import { assertFreeProviderRequest, CLOUDFLARE_LLAMA_VALIDATION_MODEL, CLOUDFLARE_WORKERS_AI_MODEL } from "./provider-cost-policy.ts";
import type { ModelProvider } from "./model-provider.ts";

export { CLOUDFLARE_WORKERS_AI_MODEL };

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new MissingAgentConfigurationError([name]);
  return value;
}

/** Server-only Cloudflare REST adapter; it shares the runtime's HTTP/JSON/Zod path. */
export class CloudflareWorkersAIModelProvider extends OpenAICompatibleModelProvider {
  constructor(accountId: string, apiToken: string, fetchImpl?: typeof fetch, configuredModel: string = CLOUDFLARE_WORKERS_AI_MODEL) {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
    super(endpoint, apiToken, {
      providerId: "cloudflare_workers_ai",
      enforceFreeOnly: true,
      configuredModel,
      fetchImpl,
      supportsIncludeReasoning: false,
    });
  }
}

export function createCloudflareWorkersAIProvider(fetchImpl?: typeof fetch): ModelProvider {
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnv("CLOUDFLARE_AI_API_TOKEN");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  assertFreeProviderRequest("cloudflare_workers_ai", CLOUDFLARE_WORKERS_AI_MODEL, endpoint);
  return new CloudflareWorkersAIModelProvider(accountId, apiToken, fetchImpl);
}

/** Pinned to the allowlisted model for the isolated 10G.3c synthetic validation only. */
export function createCloudflareWorkersAIValidationCandidateProvider(fetchImpl?: typeof fetch): ModelProvider {
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requiredEnv("CLOUDFLARE_AI_API_TOKEN");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
  assertFreeProviderRequest("cloudflare_workers_ai", CLOUDFLARE_LLAMA_VALIDATION_MODEL, endpoint);
  return new CloudflareWorkersAIModelProvider(accountId, apiToken, fetchImpl, CLOUDFLARE_LLAMA_VALIDATION_MODEL);
}
