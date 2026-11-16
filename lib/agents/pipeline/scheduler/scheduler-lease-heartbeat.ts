export const SCHEDULER_LEASE_HEARTBEAT_INTERVAL_MS = 60_000;

export type SchedulerLeaseHeartbeat = {
  isLost(): boolean;
  stop(): void;
};

/** Keeps a durable scheduler lease alive while work is running. A failed or
 * unconfirmed heartbeat closes the next-stage gate so the process cannot
 * begin additional semantic work under uncertain ownership.
 */
export function startSchedulerLeaseHeartbeat(
  heartbeat: () => Promise<boolean>,
  intervalMs = SCHEDULER_LEASE_HEARTBEAT_INTERVAL_MS,
): SchedulerLeaseHeartbeat {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("SCHEDULER_HEARTBEAT_INTERVAL_INVALID");
  let lost = false;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight || lost) return;
    inFlight = true;
    void heartbeat().then((owned) => {
      if (!owned) lost = true;
    }).catch(() => {
      lost = true;
    }).finally(() => {
      inFlight = false;
    });
  }, intervalMs);
  timer.unref?.();
  return {
    isLost: () => lost,
    stop: () => clearInterval(timer),
  };
}
