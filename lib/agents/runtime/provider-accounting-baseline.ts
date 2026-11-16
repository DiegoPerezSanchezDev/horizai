import type { ProviderDailyUsage } from "./free-provider-router.ts";

export type CloudflareAccountingBaseline = {
  utcDate: string;
  reservations: number;
  dispatchedRequests: number;
  reservedEstimatedNeurons: number;
  knownTokenUsage: boolean;
  capturedAt: string;
};

export type CloudflareAccountingDelta = {
  reservations: number;
  dispatchedRequests: number;
  reservedEstimatedNeurons: number;
};

function utcDateOf(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("CLOUDFLARE_ACCOUNTING_INVALID_TIMESTAMP");
  return value.toISOString().slice(0, 10);
}

function isNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateUsage(usage: ProviderDailyUsage): number {
  if (usage.provider !== "cloudflare_workers_ai") throw new Error("CLOUDFLARE_ACCOUNTING_PROVIDER_MISMATCH");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(usage.dateUtc) || utcDateOf(new Date(`${usage.dateUtc}T00:00:00.000Z`)) !== usage.dateUtc) {
    throw new Error("CLOUDFLARE_ACCOUNTING_INVALID_UTC_PERIOD");
  }
  if (!isNonnegativeInteger(usage.requestsReserved) || !isNonnegativeInteger(usage.requestsDispatched)
    || usage.requestsDispatched > usage.requestsReserved) {
    throw new Error("CLOUDFLARE_ACCOUNTING_INCONSISTENT_REQUEST_COUNTS");
  }
  if (usage.neuronUsageKnown !== true || usage.neuronsUsed === undefined || !isNonnegativeInteger(usage.neuronsUsed)
    || (usage.requestsReserved > 0 && usage.neuronsUsed === 0)) {
    throw new Error("CLOUDFLARE_ACCOUNTING_NEURON_USAGE_UNKNOWN");
  }
  return usage.neuronsUsed;
}

/** Captures and validates an aggregate ledger snapshot for one UTC quota period. */
export function createCloudflareAccountingBaseline(
  usage: ProviderDailyUsage,
  capturedAt: Date = new Date(),
): CloudflareAccountingBaseline {
  const neurons = validateUsage(usage);
  if (utcDateOf(capturedAt) !== usage.dateUtc) throw new Error("CLOUDFLARE_ACCOUNTING_UTC_PERIOD_CHANGED");
  if (usage.requestsDispatched > 0 && !usage.tokenUsageKnown) {
    throw new Error("CLOUDFLARE_ACCOUNTING_DISPATCH_TELEMETRY_INCONSISTENT");
  }

  return {
    utcDate: usage.dateUtc,
    reservations: usage.requestsReserved,
    dispatchedRequests: usage.requestsDispatched,
    reservedEstimatedNeurons: neurons,
    knownTokenUsage: usage.tokenUsageKnown,
    capturedAt: capturedAt.toISOString(),
  };
}

/** Fails closed if the quota date changed before a supervised dispatch or comparison. */
export function assertCloudflareUtcPeriod(expectedUtcDate: string, now: Date = new Date()): void {
  if (utcDateOf(now) !== expectedUtcDate) throw new Error("CLOUDFLARE_ACCOUNTING_UTC_PERIOD_CHANGED");
}

export function checkCloudflareBaselineCapacity(input: {
  baseline: CloudflareAccountingBaseline;
  dailyNeuronAllocation: number;
  estimatedNextRequestNeurons: number;
  dailyRequestLimit?: number;
  softLimitRatio: number;
}): { softLimitNeurons: number; softRemainingNeurons: number; softRemainingAfterReservation: number } {
  const { baseline, dailyNeuronAllocation, estimatedNextRequestNeurons, dailyRequestLimit, softLimitRatio } = input;
  if (!Number.isSafeInteger(dailyNeuronAllocation) || dailyNeuronAllocation <= 0
    || !Number.isSafeInteger(estimatedNextRequestNeurons) || estimatedNextRequestNeurons <= 0
    || !Number.isFinite(softLimitRatio) || softLimitRatio <= 0 || softLimitRatio > 1) {
    throw new Error("CLOUDFLARE_ACCOUNTING_INVALID_CAPACITY_CONFIG");
  }
  if (dailyRequestLimit !== undefined && (!Number.isSafeInteger(dailyRequestLimit) || dailyRequestLimit <= 0)) {
    throw new Error("CLOUDFLARE_ACCOUNTING_INVALID_REQUEST_LIMIT");
  }
  if (baseline.reservedEstimatedNeurons > dailyNeuronAllocation) throw new Error("CLOUDFLARE_ACCOUNTING_OVER_HARD_CAP");
  if (dailyRequestLimit !== undefined && baseline.reservations + 1 > dailyRequestLimit) {
    throw new Error("CLOUDFLARE_ACCOUNTING_REQUEST_LIMIT_REACHED");
  }

  const softLimitNeurons = Math.floor(dailyNeuronAllocation * softLimitRatio);
  const softRemainingNeurons = softLimitNeurons - baseline.reservedEstimatedNeurons;
  const softRemainingAfterReservation = softRemainingNeurons - estimatedNextRequestNeurons;
  if (softRemainingAfterReservation < 0) throw new Error("CLOUDFLARE_ACCOUNTING_SOFT_CAP_EXCEEDED");
  return { softLimitNeurons, softRemainingNeurons, softRemainingAfterReservation };
}

/** Computes phase-local changes; lifetime/day totals are never compared to constants. */
export function cloudflareAccountingDelta(
  baseline: CloudflareAccountingBaseline,
  after: ProviderDailyUsage,
): CloudflareAccountingDelta {
  const neuronsAfter = validateUsage(after);
  if (after.dateUtc !== baseline.utcDate) throw new Error("CLOUDFLARE_ACCOUNTING_UTC_PERIOD_MISMATCH");
  const delta = {
    reservations: after.requestsReserved - baseline.reservations,
    dispatchedRequests: after.requestsDispatched - baseline.dispatchedRequests,
    reservedEstimatedNeurons: neuronsAfter - baseline.reservedEstimatedNeurons,
  };
  if (delta.reservations < 0 || delta.dispatchedRequests < 0 || delta.reservedEstimatedNeurons < 0
    || delta.dispatchedRequests > delta.reservations) {
    throw new Error("CLOUDFLARE_ACCOUNTING_INVALID_PHASE_DELTA");
  }
  return delta;
}

export function assertCloudflareOneRequestDelta(
  delta: CloudflareAccountingDelta,
  expectedEstimatedNeurons: number,
): void {
  if (delta.reservations !== 1 || delta.dispatchedRequests !== 1
    || delta.reservedEstimatedNeurons !== expectedEstimatedNeurons) {
    throw new Error("CLOUDFLARE_ACCOUNTING_PHASE_DELTA_MISMATCH");
  }
}

export function assertCloudflareNoRequestDelta(delta: CloudflareAccountingDelta): void {
  if (delta.reservations !== 0 || delta.dispatchedRequests !== 0 || delta.reservedEstimatedNeurons !== 0) {
    throw new Error("CLOUDFLARE_ACCOUNTING_UNDISPATCHED_DELTA_MISMATCH");
  }
}
