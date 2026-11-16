import assert from "node:assert/strict";
import { z } from "zod";
import { CerebrasModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { runStructuredAgent } from "../lib/agents/runtime/agent-runner.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { freeProviderPolicy } from "../lib/agents/runtime/provider-cost-policy.ts";
import { FREE_ROUTABLE_PROVIDERS } from "../lib/agents/runtime/free-provider-router.ts";

const schema = z.object({ value: z.string().min(1) }).strict();
const config = { model: "gpt-oss-120b", timeoutMs: 50, maxRetries: 0, retryBackoffMs: 0, maxOutputTokens: 1200, dailyRequestLimit: 20, failOnRateLimit: true, allowPaidFallback: false, structuredOutputMode: "strict_schema", reasoningEffort: "low", includeReasoning: false };
let fetches = 0;
const provider = new CerebrasModelProvider("offline-fixture-key", "gpt-oss-120b", async () => {
  fetches += 1;
  throw new Error("trial-only provider must be blocked before dispatch");
});
const logger = new InMemoryAgentLogger();

assert.equal(freeProviderPolicy.cerebras.costClass, "TRIAL_ONLY");
assert.equal(freeProviderPolicy.cerebras.billingMode, "trial_only");
assert.equal(FREE_ROUTABLE_PROVIDERS.includes("cerebras"), false);
await assert.rejects(() => runStructuredAgent({
  agentName: "cerebras-fixture",
  agentVersion: "unit-v1",
  eventKey: "fixture-event",
  input: { test: true },
  systemInstructions: "Return JSON.",
  schemaName: "Fixture",
  schema,
  modelConfig: config,
  provider,
  logger,
  requestBudget: new DailyRequestBudget(() => new Date("2026-09-23T12:00:00.000Z")),
}), { code: "PAID_PROVIDER_FORBIDDEN" });

assert.equal(fetches, 0, "Cerebras never reaches the provider from the shared agent runtime");
assert.equal(logger.runs.length, 0, "blocked provider does not create a misleading model run");
assert.equal(logger.entries.length, 0, "blocked provider does not create request or dispatch logs");
assert.equal((await logger.getRemainingRequests(20, "2026-09-23")).used, 0);

console.log("provider:cerebras:unit: OK (trial-only blocked before dispatch; offline)");
