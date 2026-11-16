import { PaidProviderForbiddenError } from "./agent-errors.ts";

export type PermanentFreeProviderId = "groq" | "cloudflare_workers_ai";
export type ProviderId = PermanentFreeProviderId | "cerebras";
/** Only permanently-free allowlisted providers are eligible for free-only routing. */
export type FreeProviderId = PermanentFreeProviderId;
export type ProviderCostClass = "PERMANENT_FREE_APPROVED" | "TRIAL_ONLY" | "PAID" | "UNKNOWN";

export const CLOUDFLARE_WORKERS_AI_MODEL = "@cf/openai/gpt-oss-20b" as const;
export const CLOUDFLARE_LLAMA_VALIDATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

/** Billing eligibility, structured qualification, and automatic routing are separate approvals. */
type CloudflareModelApproval = {
  freeApproved: boolean;
  structuredProductionApproved: boolean | "CANDIDATE";
  productionRoutingEnabled: boolean;
};

export const cloudflareModelPolicy: Record<string, CloudflareModelApproval> = {
  [CLOUDFLARE_WORKERS_AI_MODEL]: {
    freeApproved: true,
    structuredProductionApproved: false,
    productionRoutingEnabled: false,
  },
  [CLOUDFLARE_LLAMA_VALIDATION_MODEL]: {
    freeApproved: true,
    structuredProductionApproved: "CANDIDATE",
    productionRoutingEnabled: false,
  },
} as const;

export function isCloudflareModelFreeApproved(model: string): boolean {
  return model in cloudflareModelPolicy && cloudflareModelPolicy[model as keyof typeof cloudflareModelPolicy].freeApproved;
}

export function isCloudflareModelProductionRoutable(model: string): boolean {
  if (!(model in cloudflareModelPolicy)) return false;
  const policy = cloudflareModelPolicy[model as keyof typeof cloudflareModelPolicy];
  return policy.freeApproved && policy.structuredProductionApproved === true && policy.productionRoutingEnabled;
}

export function cloudflareStructuredApprovalStatus(model: string): false | "CANDIDATE" | true | null {
  return model in cloudflareModelPolicy
    ? cloudflareModelPolicy[model as keyof typeof cloudflareModelPolicy].structuredProductionApproved
    : null;
}

/** Explicit policy; provider names alone never imply free eligibility. */
export const freeProviderPolicy = {
  groq: { costClass: "PERMANENT_FREE_APPROVED", billingMode: "free_only", endpoint: "https://api.groq.com/openai/v1/chat/completions", approvedModels: ["openai/gpt-oss-20b"] },
  cloudflare_workers_ai: { costClass: "PERMANENT_FREE_APPROVED", billingMode: "free_only", endpoint: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions", approvedModels: [CLOUDFLARE_WORKERS_AI_MODEL, CLOUDFLARE_LLAMA_VALIDATION_MODEL] },
  cerebras: { costClass: "TRIAL_ONLY", billingMode: "trial_only", endpoint: "https://api.cerebras.ai/v1/chat/completions", approvedModels: ["gpt-oss-120b"] },
} as const;

function endpointAllowed(provider: ProviderId, endpoint: string): boolean {
  if (provider !== "cloudflare_workers_ai") return endpoint === freeProviderPolicy[provider].endpoint;
  return /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1\/chat\/completions$/i.test(endpoint);
}

export function assertFreeProviderRequest(provider: string, model: string, endpoint: string): asserts provider is FreeProviderId {
  const approval = freeProviderPolicy[provider as ProviderId];
  if (!approval || approval.costClass !== "PERMANENT_FREE_APPROVED" || approval.billingMode !== "free_only" || !endpointAllowed(provider as ProviderId, endpoint) || !(approval.approvedModels as readonly string[]).includes(model)) {
    throw new PaidProviderForbiddenError();
  }
}
