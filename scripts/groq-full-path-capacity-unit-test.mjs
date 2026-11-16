import assert from "node:assert/strict";
import {
  GROQ_RESET_SAFETY_MARGIN_MS,
  GROQ_TPM_SAFETY_MARGIN,
  assertGroqStageIdentity,
  calculateTpdScenarios,
  captureAllowlistedGroqHeaders,
  classifyGroq429Evidence,
  classifyGroqPacing,
  classifyUnpacedPath,
  decideGroqTpmPacing,
  estimateGroqStageTokenRequirement,
  hasExplicitGroqRequestIdentity,
  maximumRolling60SecondAmount,
  normalizeGroqHeadersForPacing,
  resolveGroqProbeExecutionMode,
  separateGroqLimitProvenance,
} from "../lib/agents/runtime/groq-capacity-pacing.ts";
import { parseDurationSeconds } from "../lib/agents/runtime/model-provider.ts";

assert.equal(parseDurationSeconds("1.529s"), 1.529);
assert.equal(parseDurationSeconds("1m26.4s"), 86.4);
assert.equal(parseDurationSeconds("1h 2m 3s"), 3_723);
assert.equal(parseDurationSeconds("250ms"), 0.25);
assert.equal(parseDurationSeconds("12"), 12);
assert.equal(parseDurationSeconds(null), null);
assert.equal(parseDurationSeconds(""), null);
assert.equal(parseDurationSeconds("~1.5s"), null);
assert.equal(parseDurationSeconds("1.5s-junk"), null);
assert.equal(parseDurationSeconds("-1s"), null);

const estimated = estimateGroqStageTokenRequirement({ systemInstructionChars: 1_000, modelInputChars: 1_500, schemaChars: 500, maxOutputTokens: 1_200 });
assert.equal(estimated.promptInputChars, 3_000);
assert.equal(estimated.estimatedInputTokens, 1_628);
assert.equal(estimated.estimatedStageTokenRequirement, 2_828);

const headers = normalizeGroqHeadersForPacing({
  retryAfter: null,
  limitRequests: "1000",
  remainingRequests: "999",
  limitTokens: "8000",
  remainingTokens: "7000",
  resetRequests: "1m26.4s",
  resetTokens: "1.529s",
  retryAfterSeconds: null,
  resetRequestsSeconds: 86.4,
  resetTokensSeconds: 1.529,
});
assert.equal(headers?.tokenLimitMinute, 8000);
assert.equal(headers?.tokenRemainingMinute, 7000);
assert.equal(headers?.tokenResetSeconds, 1.529);

assert.deepEqual(decideGroqTpmPacing({
  isFirstStage: false,
  providerHeaders: headers,
  estimatedStageTokenRequirement: 6_000,
  tokenLimitTpm: 8_000,
}), { decision: "IMMEDIATE", waitDurationMs: 0, reason: "TOKEN_HEADROOM_SUFFICIENT" });
assert.deepEqual(decideGroqTpmPacing({
  isFirstStage: false,
  providerHeaders: headers,
  estimatedStageTokenRequirement: 7_000,
  tokenLimitTpm: 8_000,
}), { decision: "WAIT_FOR_TOKEN_RESET", waitDurationMs: 1_779, reason: "TOKEN_HEADROOM_INSUFFICIENT", resetSeconds: 1.529 });
assert.deepEqual(decideGroqTpmPacing({
  isFirstStage: true,
  providerHeaders: null,
  estimatedStageTokenRequirement: 8_000,
  tokenLimitTpm: 8_000,
}), { decision: "BLOCKED_SINGLE_STAGE_TPM_SAFETY", waitDurationMs: 0, reason: "STAGE_ESTIMATE_EXCEEDS_TPM" });
assert.deepEqual(decideGroqTpmPacing({ isFirstStage: false, providerHeaders: null, estimatedStageTokenRequirement: 1_000, tokenLimitTpm: 8_000 }), {
  decision: "IMMEDIATE", waitDurationMs: 0, reason: "EXTERNAL_REMAINING_UNKNOWN",
});
assert.equal(decideGroqTpmPacing({
  isFirstStage: false,
  providerHeaders: { ...headers, tokenRemainingMinute: 100, tokenResetSeconds: null },
  estimatedStageTokenRequirement: 1_000,
  tokenLimitTpm: 8_000,
}).decision, "BLOCKED_TPM_RESET_UNKNOWN");
assert.deepEqual(decideGroqTpmPacing({ isFirstStage: true, providerHeaders: null, estimatedStageTokenRequirement: 1_000, tokenLimitTpm: 8_000 }), { decision: "IMMEDIATE", waitDurationMs: 0, reason: "FIRST_STAGE" });
assert.equal(GROQ_TPM_SAFETY_MARGIN, 128);
assert.equal(GROQ_RESET_SAFETY_MARGIN_MS, 250);

const safeHeaders = captureAllowlistedGroqHeaders({
  retryAfter: "2s",
  limitRequests: "1000",
  remainingRequests: "999",
  limitTokens: "8000",
  remainingTokens: "7900",
  resetRequests: "1m",
  resetTokens: "1s",
  retryAfterSeconds: 2,
  resetRequestsSeconds: 60,
  resetTokensSeconds: 1,
  authorization: "must-not-be-captured",
});
assert.deepEqual(Object.keys(safeHeaders), [
  "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens", "retry-after",
]);
assert.equal(JSON.stringify(safeHeaders).includes("must-not-be-captured"), false);

assert.equal(classifyGroq429Evidence({ headers: { remainingTokens: "0" } }), "TPM_LIMIT");
assert.equal(classifyGroq429Evidence({ headers: { remainingRequests: "0" } }), "RPD_LIMIT");
assert.equal(classifyGroq429Evidence({ headers: {}, providerMessage: "requests per minute limit exceeded" }), "RPM_LIMIT");
assert.equal(classifyGroq429Evidence({ headers: {}, providerMessage: "rate limit exceeded" }), "UNKNOWN");

const evidence = separateGroqLimitProvenance({
  manualConfirmation: { plan: "FREE", rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000 },
  providerReported: { rpd: 1_000, tpm: 8_000, rpm: "UNKNOWN_FROM_API_HEADERS", tpd: "UNKNOWN_FROM_API_HEADERS" },
});
assert.equal(evidence.humanConfirmedPlan.provenance, "USER_MANUAL_CONFIRMATION");
assert.equal(evidence.providerReportedLimits.provenance, "PROVIDER_REPORTED_HEADERS");
assert.equal(evidence.providerReportedLimits.rpm, "UNKNOWN_FROM_API_HEADERS");
assert.equal(evidence.humanConfirmedPlan.rpm, 30);

assert.doesNotThrow(() => assertGroqStageIdentity({ provider: "groq", model: "openai/gpt-oss-20b", expectedModel: "openai/gpt-oss-20b" }));
assert.throws(() => assertGroqStageIdentity({ provider: "cloudflare_workers_ai", model: "openai/gpt-oss-20b", expectedModel: "openai/gpt-oss-20b" }), /GROQ_STAGE_IDENTITY_MISMATCH/);
assert.throws(() => assertGroqStageIdentity({ provider: "groq", model: "different-model", expectedModel: "openai/gpt-oss-20b" }), /GROQ_STAGE_IDENTITY_MISMATCH/);
assert.equal(hasExplicitGroqRequestIdentity({
  runProvider: "groq", configProvider: "groq", configModel: "openai/gpt-oss-20b",
  telemetryProvider: "groq", telemetryModel: "openai/gpt-oss-20b", providerRequestsUsed: 1,
  reservationCount: 1, reservationProvider: "groq", reservationModel: "openai/gpt-oss-20b",
  reservationDispatched: true, expectedModel: "openai/gpt-oss-20b",
}), true);
assert.equal(hasExplicitGroqRequestIdentity({
  runProvider: "groq", configProvider: "groq", configModel: "openai/gpt-oss-20b",
  telemetryProvider: undefined, telemetryModel: "openai/gpt-oss-20b", providerRequestsUsed: 1,
  reservationCount: 1, reservationProvider: "groq", reservationModel: "openai/gpt-oss-20b",
  reservationDispatched: true, expectedModel: "openai/gpt-oss-20b",
}), false);

assert.equal(maximumRolling60SecondAmount([
  { timestampUtc: "2026-09-25T12:00:00.000Z", amount: 100 },
  { timestampUtc: "2026-09-25T12:00:40.000Z", amount: 200 },
  { timestampUtc: "2026-09-25T12:01:00.000Z", amount: 400 },
]), 600);
assert.equal(maximumRolling60SecondAmount([
  { timestampUtc: "2026-09-25T12:00:00.000Z", amount: 2 },
  { timestampUtc: "2026-09-25T12:00:01.000Z", amount: 1 },
]), 3);

const scenarios = calculateTpdScenarios(10_000, 200_000);
assert.deepEqual(scenarios.map(({ paths, tokenDemand, percentageOfHardTpd, fitsHardTpd, fitsSoft85PercentTpd }) => ({ paths, tokenDemand, percentageOfHardTpd, fitsHardTpd, fitsSoft85PercentTpd })), [
  { paths: 10, tokenDemand: 100_000, percentageOfHardTpd: 50, fitsHardTpd: true, fitsSoft85PercentTpd: true },
  { paths: 12, tokenDemand: 120_000, percentageOfHardTpd: 60, fitsHardTpd: true, fitsSoft85PercentTpd: true },
  { paths: 15, tokenDemand: 150_000, percentageOfHardTpd: 75, fitsHardTpd: true, fitsSoft85PercentTpd: true },
]);
assert.equal(calculateTpdScenarios(12_000, 200_000)[2].fitsSoft85PercentTpd, false);

assert.equal(classifyUnpacedPath({ fullPath: false, unpacedTokenSum: 9_000, tpmLimit: 8_000 }), "PARTIAL_PATH_INSUFFICIENT_DATA");
assert.equal(classifyUnpacedPath({ fullPath: true, unpacedTokenSum: 8_001, tpmLimit: 8_000 }), "UNPACED_CLEARLY_OVER_TPM");
assert.equal(classifyUnpacedPath({ fullPath: true, unpacedTokenSum: 7_999, tpmLimit: 8_000 }), "UNPACED_BELOW_TPM_BUT_NOT_CERTIFIED");
assert.equal(classifyGroqPacing({ fullPath: false, waitCount: 0, unpacedClassification: "PARTIAL_PATH_INSUFFICIENT_DATA", maximumObserved60sTokens: 0, tpmLimit: 8_000 }), "PARTIAL_PATH_INSUFFICIENT_DATA");
assert.equal(classifyGroqPacing({ fullPath: true, waitCount: 1, unpacedClassification: "UNPACED_CLEARLY_OVER_TPM", maximumObserved60sTokens: 8_100, tpmLimit: 8_000 }), "PACING_REQUIRED");
assert.equal(classifyGroqPacing({ fullPath: true, waitCount: 0, unpacedClassification: "UNPACED_CLEARLY_OVER_TPM", maximumObserved60sTokens: 7_000, tpmLimit: 8_000 }), "PACING_RECOMMENDED");
assert.equal(classifyGroqPacing({ fullPath: true, waitCount: 0, unpacedClassification: "UNPACED_BELOW_TPM_BUT_NOT_CERTIFIED", maximumObserved60sTokens: 7_000, tpmLimit: 8_000 }), "IMMEDIATE_PATH_PLAUSIBLY_SAFE_BUT_NOT_CERTIFIED");

assert.equal(resolveGroqProbeExecutionMode([]), "PREFLIGHT_ONLY");
assert.equal(resolveGroqProbeExecutionMode(["--execute-one-path"]), "EXECUTE_ONE_PATH");
assert.throws(() => resolveGroqProbeExecutionMode(["--preflight-only"]), /Unsupported probe arguments/);
assert.throws(() => resolveGroqProbeExecutionMode(["--execute-one-path", "--execute-one-path"]), /Unsupported probe arguments/);

console.log("Groq full-path capacity pure/offline checks passed (no provider or Supabase calls)");
