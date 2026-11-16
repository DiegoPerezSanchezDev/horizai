import type { SchedulerLeaseAcquireResult, SchedulerLeaseReleaseResult, SchedulerLeaseRepository } from "./scheduler-types.ts";

export async function acquireSchedulerRunLease(repository: SchedulerLeaseRepository, input: { ownerRunId: string; now: Date; ttlMs: number }): Promise<SchedulerLeaseAcquireResult> {
  if (!input.ownerRunId.trim() || !Number.isInteger(input.ttlMs) || input.ttlMs < 1 || Number.isNaN(input.now.getTime())) throw new Error("SCHEDULER_INVALID_LEASE_REQUEST");
  return repository.acquire(input);
}

export async function releaseSchedulerRunLease(repository: SchedulerLeaseRepository, input: { ownerRunId: string }): Promise<SchedulerLeaseReleaseResult> {
  if (!input.ownerRunId.trim()) throw new Error("SCHEDULER_INVALID_LEASE_OWNER");
  return repository.release(input);
}
