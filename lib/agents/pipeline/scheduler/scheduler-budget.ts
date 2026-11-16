import { initialRequestsRequired } from "../pipeline-budget.ts";

export function schedulerWorstCasePerEvent(): number {
  return initialRequestsRequired();
}

export function eventsAllowedByBudget(remaining: number, worstCasePerEvent = schedulerWorstCasePerEvent()): number {
  if (!Number.isInteger(remaining) || remaining < 0) throw new Error("SCHEDULER_INVALID_REMAINING_BUDGET");
  if (!Number.isInteger(worstCasePerEvent) || worstCasePerEvent < 1) throw new Error("SCHEDULER_INVALID_EVENT_COST");
  return Math.floor(remaining / worstCasePerEvent);
}

export function canStartEvent(remaining: number, worstCasePerEvent = schedulerWorstCasePerEvent()): boolean {
  return eventsAllowedByBudget(remaining, worstCasePerEvent) > 0;
}

export function remainingAfterEvent(remaining: number, requestsUsed: number): number {
  if (!Number.isInteger(remaining) || remaining < 0 || !Number.isInteger(requestsUsed) || requestsUsed < 0 || requestsUsed > remaining) {
    throw new Error("SCHEDULER_INVALID_EVENT_ACCOUNTING");
  }
  return remaining - requestsUsed;
}

export function plannedEventLimit(remaining: number, maxEventsPerRun: number): number {
  if (!Number.isInteger(maxEventsPerRun) || maxEventsPerRun < 1) throw new Error("SCHEDULER_INVALID_MAX_EVENTS");
  return Math.min(maxEventsPerRun, eventsAllowedByBudget(remaining));
}
