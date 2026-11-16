/**
 * Daily supervised-cycle ceilings. Defaults are conservative; the operator may raise them
 * through the environment, but only inside a hard range so a typo cannot disable the guard.
 * Groq free tier budget (200K tokens/day, ~10-13K tokens and 6 requests per event) bounds the ceiling.
 */
function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name}_INVALID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_OUT_OF_RANGE`);
  return value;
}

export const supervisedEventAttemptLimit = boundedInteger("SUPERVISED_EVENT_ATTEMPT_LIMIT", 5, 1, 12);
export const supervisedProviderRequestLimit = boundedInteger("SUPERVISED_PROVIDER_REQUEST_LIMIT", 36, 6, 120);
export const supervisedExtractionCandidateLimit = boundedInteger("SUPERVISED_EXTRACTION_CANDIDATE_LIMIT", Math.max(6, supervisedEventAttemptLimit + 1), 1, 30);
