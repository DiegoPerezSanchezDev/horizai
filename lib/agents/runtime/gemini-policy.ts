import { AgentError, PaidProviderForbiddenError } from "./agent-errors.ts";

/**
 * Gemini (Google AI Studio, free tier) provider policy.
 *
 * Deliberately NOT part of `freeProviderPolicy` / `FreeProviderId`: the free router, the capacity
 * configs and `assertFreeProviderRequest` stay closed to Groq and Cloudflare. A Gemini request is
 * only ever approved by `assertGeminiFreeRequest`, and only when every gate below is explicitly set.
 */
export const GEMINI_PROVIDER_ID = "gemini_free" as const;
export type GeminiProviderId = typeof GEMINI_PROVIDER_ID;

export const GEMINI_API_ORIGIN = "https://generativelanguage.googleapis.com";
const GEMINI_MODEL_NAME = /^gemini-[a-z0-9][a-z0-9.-]{1,60}$/;

/**
 * Closed list. Text models whose "Standard" Free Tier input and output price is "Free of charge" on
 * https://ai.google.dev/gemini-api/docs/pricing (read 2026-11-07). Everything else (Gemini 4 Argon, *-pro-preview,
 * image, TTS, live, Omni, embeddings, preview models with tighter limits) is excluded. Environment variables
 * can only select or narrow within this list; adding a model is a reviewed code change on purpose.
 */
export const GEMINI_FREE_TIER_CANDIDATE_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-2.5-flash",
] as const;

export function geminiGenerateContentEndpoint(model: string): string {
  if (!GEMINI_MODEL_NAME.test(model)) throw new PaidProviderForbiddenError();
  return `${GEMINI_API_ORIGIN}/v1beta/models/${model}:generateContent`;
}

function strictBoolean(name: string, value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new AgentError("cost_guard_violation", `${name} must be true or false`);
}

/** First gate: the adapter is inert unless this is exactly "true". */
export function geminiProviderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return strictBoolean("GEMINI_PROVIDER_ENABLED", env.GEMINI_PROVIDER_ENABLED);
}

/**
 * Second gate: Gemini's free tier is determined by the Google Cloud project behind the key. A key from a project
 * with billing enabled is paid usage. Code cannot verify this, so the operator must attest it explicitly.
 */
export function geminiFreeTierProjectConfirmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return strictBoolean("GEMINI_FREE_TIER_PROJECT_CONFIRMED", env.GEMINI_FREE_TIER_PROJECT_CONFIRMED);
}

export function readApprovedGeminiModels(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env.GEMINI_APPROVED_MODELS?.trim();
  if (!raw) return GEMINI_FREE_TIER_CANDIDATE_MODELS;
  const requested = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (requested.length === 0 || requested.some((model) => !(GEMINI_FREE_TIER_CANDIDATE_MODELS as readonly string[]).includes(model))) {
    throw new PaidProviderForbiddenError();
  }
  return [...new Set(requested)];
}

/** `GEMINI_MODEL` has no default: without an explicit choice there is nothing to approve. */
export function readGeminiModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const model = env.GEMINI_MODEL?.trim();
  return model ? model : null;
}

export function assertGeminiFreeRequest(model: string, endpoint: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!geminiProviderEnabled(env) || !geminiFreeTierProjectConfirmed(env)) throw new PaidProviderForbiddenError();
  if (!readApprovedGeminiModels(env).includes(model)) throw new PaidProviderForbiddenError();
  if (endpoint !== geminiGenerateContentEndpoint(model)) throw new PaidProviderForbiddenError();
}
