import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";

const diagnostics: Array<{ method: string; status: number }> = [];
const originalFetch = globalThis.fetch.bind(globalThis);
let unsafeRequestObserved = false;

globalThis.fetch = async (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const url = new URL(requestUrl);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (!url.pathname.startsWith("/rest/v1/") || !["GET", "HEAD"].includes(method)) unsafeRequestObserved = true;
  const response = await originalFetch(input, init);
  diagnostics.push({ method, status: response.status });
  return response;
};

async function main(): Promise<void> {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) throw new Error("M40_PRIVATE_READ_ENV_MISSING");
  const utcDay = new Date().toISOString().slice(0, 10);
  const logger = new SupabaseAgentLogger(createSupabaseServerClient());
  const providers = ["groq", "cloudflare_workers_ai", "cerebras"] as const;
  const accounting: Record<string, unknown> = {};

  for (const provider of providers) {
    const usage = await logger.getProviderDailyUsage(provider, utcDay);
    accounting[provider] = {
      requestsReserved: usage.requestsReserved,
      requestsDispatched: usage.requestsDispatched,
      tokenUsageKnown: usage.tokenUsageKnown,
      unknownTokenRequests: usage.unknownTokenRequests,
      neuronsUsed: usage.neuronsUsed,
      neuronUsageKnown: usage.neuronUsageKnown,
    };
  }

  if (unsafeRequestObserved || diagnostics.some(({ status }) => status < 200 || status >= 300)) {
    throw new Error("M40_PRIVATE_READ_REQUEST_GATE_FAILED");
  }
  console.log(JSON.stringify({ utcDay, mechanism: "SupabaseAgentLogger read-only PostgREST GET", providers: accounting, requestCount: diagnostics.length, statuses: diagnostics.map(({ method, status }) => ({ method, status })), remoteWrites: 0, providerCalls: 0 }));
}

main().catch(() => {
  console.error("M40_PROVIDER_ACCOUNTING_READ_FAILED");
  process.exitCode = 1;
});
