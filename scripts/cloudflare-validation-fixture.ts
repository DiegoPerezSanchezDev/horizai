import { z } from "zod";
import { estimateCloudflareNeurons, readCloudflareNeuronRates } from "../lib/agents/runtime/free-provider-router.ts";
import { CLOUDFLARE_WORKERS_AI_MODEL } from "../lib/agents/runtime/provider-cost-policy.ts";
import { toStrictProviderJsonSchema } from "../lib/agents/runtime/strict-json-schema.ts";

export const MAX_REQUESTS = 1;
export const MAX_RETRIES = 0;
export const EXPECTED_DAILY_NEURON_LIMIT = 10_000;
export const MAX_OUTPUT_TOKENS = 1_024;

export const SYSTEM_INSTRUCTIONS = [
  "Return only the requested structured JSON object.",
  "This is a synthetic transport/schema fixture, not a news article or a HorizAI agent task.",
  "Do not use external tools, providers, search, or any outside facts.",
  "Copy the single fictional fixture fact into the required schema and mark its synthetic evidence as verified.",
].join(" ");

export const SYNTHETIC_INPUT = {
  fixtureKind: "fictional_only",
  text: "In the imaginary test setting, the fictional device Lumen-3 has three indicator lights. This statement describes no real product or event.",
  expectedFactId: "fictional-fixture",
};

export const ValidationSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("ok"),
  provider: z.literal("cloudflare_workers_ai"),
  facts: z.array(z.object({
    id: z.literal("fictional-fixture"),
    statement: z.string().trim().min(1).max(160),
    evidence: z.object({
      source: z.literal("synthetic_fixture"),
      verified: z.boolean(),
    }).strict(),
  }).strict()).length(1),
}).strict();

export function estimateValidationFixtureInputTokens(): number {
  const strictJsonSchema = toStrictProviderJsonSchema(ValidationSchema);
  return Math.ceil((SYSTEM_INSTRUCTIONS.length + JSON.stringify(SYNTHETIC_INPUT).length + JSON.stringify(strictJsonSchema).length) / 2) + 128;
}

export function estimateValidationFixtureNeurons(model: string = CLOUDFLARE_WORKERS_AI_MODEL): number {
  return estimateCloudflareNeurons({
    inputTokens: estimateValidationFixtureInputTokens(),
    outputTokens: MAX_OUTPUT_TOKENS,
    ...readCloudflareNeuronRates(process.env, model),
  });
}
