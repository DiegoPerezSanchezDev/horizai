import assert from "node:assert/strict";
import { cleanupSmokeRun } from "../lib/agents/runtime/smoke-cleanup.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";

function createFakeSupabase() {
  const runs = new Set(["real-run", "smoke-a", "smoke-b"]);
  const logs = [
    { id: 1, run_id: "real-run", step: "provider_request_reserved" },
    { id: 2, run_id: "real-run", step: "provider_request_reserved" },
    { id: 3, run_id: "real-run", step: "provider_request_reserved" },
    { id: 4, run_id: "smoke-a", step: "provider_request_reserved" },
    { id: 5, run_id: "smoke-a", step: "relationship-check" },
    { id: 6, run_id: "smoke-b", step: "provider_request_reserved" },
  ];
  const client = {
    from(table) {
      return {
        delete() {
          return {
            eq(column, value) {
              if (table === "agent_logs") {
                for (let index = logs.length - 1; index >= 0; index -= 1) if (logs[index][column] === value) logs.splice(index, 1);
              } else if (table === "agent_runs" && column === "id") {
                runs.delete(value);
              }
              return Promise.resolve({ error: null });
            },
          };
        },
        select() {
          return {
            eq(column, value) {
              const data = table === "agent_logs"
                ? logs.filter((row) => row[column] === value).map(({ id }) => ({ id }))
                : [...runs].filter((id) => id === value).map((id) => ({ id }));
              return Promise.resolve({ data, error: null });
            },
          };
        },
      };
    },
    countReservations() { return logs.filter((row) => row.step === "provider_request_reserved").length; },
    hasLog(id) { return logs.some((row) => row.id === id); },
  };
  return client;
}

const fake = createFakeSupabase();
assert.equal(fake.countReservations(), 5);
assert.deepEqual(await cleanupSmokeRun(fake, "smoke-a"), []);
assert.equal(fake.countReservations(), 4);
assert.equal(fake.hasLog(1), true);
assert.equal(fake.hasLog(2), true);
assert.equal(fake.hasLog(3), true);
assert.equal(fake.hasLog(4), false);
assert.equal(fake.hasLog(5), false);
assert.deepEqual(await cleanupSmokeRun(fake, "smoke-a"), []);
assert.deepEqual(await cleanupSmokeRun(fake, "smoke-b"), []);
assert.equal(fake.countReservations(), 3);

const sameDay = new DailyRequestBudget(() => new Date("2026-09-15T23:59:00Z"));
assert.equal(sameDay.reserve(20).requestDate, "2026-09-15");
assert.equal(sameDay.reserve(20).dailyCount, 2);
const nextDay = new DailyRequestBudget(() => new Date("2026-09-15T23:59:00Z"));
let now = new Date("2026-09-15T23:59:00Z");
const rollover = new DailyRequestBudget(() => now);
for (let index = 0; index < 20; index += 1) rollover.reserve(20);
now = new Date("2026-09-16T00:00:00Z");
assert.deepEqual(rollover.reserve(20), { dailyCount: 1, requestDate: "2026-09-16" });
assert.equal(nextDay.snapshot().day, "2026-09-15");
console.log("Supabase smoke cleanup unit fixtures passed");
