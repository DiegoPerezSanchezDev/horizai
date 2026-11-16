import assert from "node:assert/strict";
import {
  assertCloudflareOneRequestDelta,
  assertCloudflareNoRequestDelta,
  assertCloudflareUtcPeriod,
  checkCloudflareBaselineCapacity,
  cloudflareAccountingDelta,
  createCloudflareAccountingBaseline,
} from "../lib/agents/runtime/provider-accounting-baseline.ts";

const day = "2026-09-24";
const capturedAt = new Date(`${day}T12:00:00.000Z`);
function usage({ reservations = 0, dispatched = 0, neurons = 0, tokenUsageKnown = true, neuronUsageKnown = true, dateUtc = day } = {}) {
  return {
    provider: "cloudflare_workers_ai",
    dateUtc,
    requestsReserved: reservations,
    requestsDispatched: dispatched,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenUsageKnown,
    unknownTokenRequests: tokenUsageKnown ? 0 : 1,
    neuronsUsed: neurons,
    neuronUsageKnown,
  };
}
const baseline = (values) => createCloudflareAccountingBaseline(usage(values), capturedAt);

// A: empty period is valid.
assert.equal(baseline({}).reservations, 0);
assertCloudflareNoRequestDelta(cloudflareAccountingDelta(baseline({}), usage()));
// B: one historical reservation/dispatch is valid.
assert.equal(baseline({ reservations: 1, dispatched: 1, neurons: 25 }).dispatchedRequests, 1);
// C: the currently observed two-call history is accepted as data, not a constant.
const twoCallBaseline = baseline({ reservations: 2, dispatched: 2, neurons: 77 });
assert.equal(twoCallBaseline.reservedEstimatedNeurons, 77);
// D: larger same-day history remains valid when capacity is sufficient.
const fiftyCallBaseline = baseline({ reservations: 50, dispatched: 50, neurons: 5_000 });
assert.equal(checkCloudflareBaselineCapacity({
  baseline: fiftyCallBaseline,
  dailyNeuronAllocation: 10_000,
  estimatedNextRequestNeurons: 50,
  softLimitRatio: 0.85,
}).softRemainingAfterReservation, 3_450);
// Phase accounting uses deltas from the captured baseline, not fixed daily totals.
const post = usage({ reservations: 3, dispatched: 3, neurons: 129 });
const delta = cloudflareAccountingDelta(twoCallBaseline, post);
assert.deepEqual(delta, { reservations: 1, dispatchedRequests: 1, reservedEstimatedNeurons: 52 });
assertCloudflareOneRequestDelta(delta, 52);
// E: an impossible ledger and unknown dispatched telemetry fail closed.
assert.throws(() => baseline({ reservations: 1, dispatched: 2, neurons: 25 }), /INCONSISTENT_REQUEST_COUNTS/);
assert.throws(() => baseline({ reservations: 1, dispatched: 1, neurons: 25, tokenUsageKnown: false }), /DISPATCH_TELEMETRY_INCONSISTENT/);
assert.throws(() => baseline({ reservations: 1, dispatched: 1, neurons: 25, neuronUsageKnown: false }), /NEURON_USAGE_UNKNOWN/);
// F: crossing the UTC quota boundary cannot be silently compared.
assert.throws(() => assertCloudflareUtcPeriod(day, new Date("2026-09-25T00:00:00.000Z")), /UTC_PERIOD_CHANGED/);
assert.throws(() => cloudflareAccountingDelta(twoCallBaseline, usage({ reservations: 3, dispatched: 3, neurons: 129, dateUtc: "2026-09-25" })), /UTC_PERIOD_MISMATCH/);

console.log("Cloudflare accounting baseline tests passed (6 cases; no network). ");
