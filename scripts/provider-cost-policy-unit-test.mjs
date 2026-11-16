import assert from "node:assert/strict";
import { assertFreeProviderRequest, freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { createConfiguredModelProvider, createProviderClient } from "../lib/agents/runtime/model-provider.ts";

assert.equal(freeProviderPolicy.groq.billingMode, "free_only");
assert.equal(freeProviderPolicy.cerebras.costClass, "TRIAL_ONLY");
assert.equal(freeProviderPolicy.cloudflare_workers_ai.costClass, "PERMANENT_FREE_APPROVED");
assertFreeProviderRequest("groq", "openai/gpt-oss-20b", freeProviderPolicy.groq.endpoint);
assertFreeProviderRequest("cloudflare_workers_ai", "@cf/openai/gpt-oss-20b", "https://api.cloudflare.com/client/v4/accounts/1234567890abcdef1234567890abcdef/ai/v1/chat/completions");
assert.throws(() => createProviderClient("openai"), { code: "PAID_PROVIDER_FORBIDDEN" });
for (const [provider, model, endpoint] of [
  ["openai", "gpt-oss-120b", "https://api.openai.com/v1/chat/completions"],
  ["groq", "paid-model", freeProviderPolicy.groq.endpoint],
  ["cerebras", "gpt-oss-120b", freeProviderPolicy.cerebras.endpoint],
  ["cloudflare_workers_ai", "@cf/openai/gpt-oss-120b", "https://api.cloudflare.com/client/v4/accounts/1234567890abcdef1234567890abcdef/ai/v1/chat/completions"],
  ["cloudflare_workers_ai", "@cf/openai/gpt-oss-20b", "https://paid.example/v1/chat/completions"],
]) assert.throws(() => assertFreeProviderRequest(provider, model, endpoint), { code: "PAID_PROVIDER_FORBIDDEN" });

const names = ["AGENT_PROVIDER", "AGENT_API_URL", "AGENT_API_KEY", "CEREBRAS_API_KEY", "CEREBRAS_MODEL"];
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
try {
  process.env.AGENT_PROVIDER = "groq";
  process.env.AGENT_API_URL = "https://api.groq.com/openai/v1";
  process.env.AGENT_API_KEY = "offline-only";
  assert.equal(createConfiguredModelProvider().providerId, "groq");
  process.env.AGENT_PROVIDER = "cerebras";
  assert.throws(() => createConfiguredModelProvider(), { code: "PAID_PROVIDER_FORBIDDEN" });
  assert.throws(() => createProviderClient("cerebras"), { code: "PAID_PROVIDER_FORBIDDEN" });
} finally {
  for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
}
console.log("provider:cost-policy:unit: OK (offline only)");
