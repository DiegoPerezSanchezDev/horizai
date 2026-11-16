import { schedulerSlots, type SchedulerSlot } from "./scheduler-types.ts";

export const DEFAULT_SCHEDULING_TIMEZONE = "Europe/Madrid";

type LocalScheduleTime = {
  localDate: string;
  hour: number;
  minute: number;
  offsetName: string;
};

function assertValidDate(value: Date): void {
  if (Number.isNaN(value.getTime())) throw new Error("SCHEDULER_INVALID_SCHEDULED_AT");
}

export function utcRequestDate(value: Date): string {
  assertValidDate(value);
  return value.toISOString().slice(0, 10);
}

export function localScheduleTime(value: Date, timezone = DEFAULT_SCHEDULING_TIMEZONE): LocalScheduleTime {
  assertValidDate(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(value);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error("SCHEDULER_INVALID_TIMEZONE");
  return { localDate: `${get("year")}-${get("month")}-${get("day")}`, hour, minute: Number(get("minute")), offsetName: get("timeZoneName") };
}

/** Stable conceptual slots: morning 06:00–11:59, afternoon 12:00–17:59, night 18:00–05:59. */
export function classifyScheduleSlot(value: Date, timezone = DEFAULT_SCHEDULING_TIMEZONE): SchedulerSlot {
  const { hour } = localScheduleTime(value, timezone);
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "night";
}

export function nextScheduleSlot(slot: SchedulerSlot): SchedulerSlot {
  const index = schedulerSlots.indexOf(slot);
  return schedulerSlots[(index + 1) % schedulerSlots.length];
}

export function triggerIdentity(requestDateUtc: string, slot: SchedulerSlot): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDateUtc)) throw new Error("SCHEDULER_INVALID_REQUEST_DATE");
  return `scheduled:${requestDateUtc}:${slot}`;
}
