import assert from "node:assert/strict";
import {
  acquireSchedulerRunLease,
  accountEventAndCheckNext,
  classifyScheduleSlot,
  createScheduledRunPlan,
  eventEligibility,
  localScheduleTime,
  releaseSchedulerRunLease,
  revisionCost,
  schedulerResult,
  selectEligibleEvents,
  triggerIdentity,
  utcRequestDate,
} from "../lib/agents/pipeline/index.ts";

const quota = (remaining, requestDateUtc = "2026-09-21") => ({ requestDateUtc, limit: 20, used: 20 - remaining, remaining });
const scheduledAt = new Date("2026-09-21T10:00:00Z");

const allowed = createScheduledRunPlan({ runId: "run-a", scheduledAt, quota: quota(20), eligibleEventCount: 10 });
assert.equal(allowed.allowed, true, "20 remaining permits a scheduled run");
assert.equal(allowed.eventsAllowedByBudget, 3);
assert.equal(allowed.plannedEventLimit, 3);
assert.equal(allowed.worstCasePerEvent, 6);
assert.equal(allowed.dryRun, true);
assert.equal(allowed.publish, false);
assert.equal(allowed.automaticRevision, false);

const blockedBudget = createScheduledRunPlan({ runId: "run-b", scheduledAt, quota: quota(5), eligibleEventCount: 10 });
assert.equal(blockedBudget.allowed, false);
assert.equal(blockedBudget.blockReason, "BLOCKED_INSUFFICIENT_DAILY_BUDGET");
const exactBudget = createScheduledRunPlan({ runId: "run-c", scheduledAt, quota: quota(6), eligibleEventCount: 10 });
assert.equal(exactBudget.allowed, true);
assert.equal(exactBudget.plannedEventLimit, 1);

const groqSoftCap = createScheduledRunPlan({ runId: "groq-soft", scheduledAt, quota: { requestDateUtc: "2026-09-21", limit: 20, admissionLimit: 16, used: 10, remaining: 6 }, eligibleEventCount: 10 });
assert.equal(groqSoftCap.allowed, true, "Groq projects a full six-call path below the exclusive 17-request soft threshold");
const groqCrossesSoftCap = createScheduledRunPlan({ runId: "groq-soft-block", scheduledAt, quota: { requestDateUtc: "2026-09-21", limit: 20, admissionLimit: 16, used: 11, remaining: 5 }, eligibleEventCount: 10 });
assert.equal(groqCrossesSoftCap.allowed, false, "a new event that would reach 17 requests is held before starting");
assert.equal(groqCrossesSoftCap.quotaLimit, 20, "the reported hard cap remains distinct from its soft admission ceiling");
assert.equal(groqCrossesSoftCap.quotaAdmissionLimit, 16);
assert.equal(groqCrossesSoftCap.quotaProvider, "groq");

const afterSkip = accountEventAndCheckNext({ remaining: 20, requestsUsed: 1, processed: 0, maxEventsPerRun: 3 });
assert.deepEqual(afterSkip, { remaining: 19, canContinue: true, stopReason: null });
const afterFullB = accountEventAndCheckNext({ remaining: afterSkip.remaining, requestsUsed: 6, processed: 1, maxEventsPerRun: 3 });
assert.deepEqual(afterFullB, { remaining: 13, canContinue: true, stopReason: null });
const afterFullC = accountEventAndCheckNext({ remaining: afterFullB.remaining, requestsUsed: 6, processed: 2, maxEventsPerRun: 3 });
assert.deepEqual(afterFullC, { remaining: 7, canContinue: false, stopReason: "MAX_EVENTS_PER_RUN" });
assert.equal(accountEventAndCheckNext({ remaining: 6, requestsUsed: 6, processed: 0, maxEventsPerRun: 3 }).stopReason, "BUDGET_EXHAUSTED");

const events = [
  { eventKey: "z", publishedAt: "2026-09-20T08:00:00Z", status: "new" },
  { eventKey: "a", publishedAt: "2026-09-20T08:00:00Z", status: "new" },
  { eventKey: "old-success", publishedAt: "2026-09-19T08:00:00Z", status: "success" },
  { eventKey: "failed", publishedAt: "2026-09-19T09:00:00Z", status: "failed", attemptedRunId: "run-a" },
  { eventKey: "skipped", publishedAt: null, status: "skipped_verification_insufficient" },
  { eventKey: "revision", publishedAt: null, status: "blocked_revision_required" },
  { eventKey: "rejected", publishedAt: null, status: "blocked_rejected" },
];
assert.equal(eventEligibility(events[2], "run-a").eligible, false);
assert.equal(eventEligibility(events[3], "run-a").eligible, false);
assert.equal(eventEligibility(events[4], "run-a").eligible, false);
assert.equal(eventEligibility({ ...events[4], reconsiderationAllowed: true }, "run-a").eligible, true);
assert.equal(eventEligibility(events[5], "run-a").eligible, false);
assert.equal(eventEligibility(events[6], "run-a").eligible, false);
assert.deepEqual(selectEligibleEvents([...events, events[0]], "run-a", 10).map((event) => event.eventKey), ["a", "z"]);

assert.equal(createScheduledRunPlan({ runId: "run-active", scheduledAt, quota: quota(20), activeRun: true }).blockReason, "BLOCKED_RUN_ALREADY_ACTIVE");
assert.equal(createScheduledRunPlan({ runId: "run-duplicate", scheduledAt, quota: quota(20), duplicateTrigger: true }).blockReason, "BLOCKED_DUPLICATE_TRIGGER");
assert.equal(triggerIdentity("2026-09-21", "morning"), "scheduled:2026-09-21:morning");
assert.notEqual(triggerIdentity("2026-09-21", "morning"), triggerIdentity("2026-09-21", "afternoon"));

const leases = {
  async acquire() { return { status: "busy", lease: { ownerRunId: "run-live", acquiredAt: "2026-09-21T08:00:00Z", expiresAt: "2026-09-21T09:00:00Z" } }; },
  async release() { return { status: "rejected", lease: { ownerRunId: "run-live", acquiredAt: "2026-09-21T08:00:00Z", expiresAt: "2026-09-21T09:00:00Z" } }; },
};
assert.equal((await acquireSchedulerRunLease(leases, { ownerRunId: "run-new", now: scheduledAt, ttlMs: 3600000 })).status, "busy");
assert.equal((await releaseSchedulerRunLease(leases, { ownerRunId: "run-new" })).status, "rejected");
const expiredLease = { async acquire() { return { status: "expired", lease: { ownerRunId: "run-new", acquiredAt: scheduledAt.toISOString(), expiresAt: new Date(scheduledAt.getTime() + 3600000).toISOString() } }; }, async release() { return { status: "released", lease: { ownerRunId: "run-new", acquiredAt: scheduledAt.toISOString(), expiresAt: new Date(scheduledAt.getTime() + 3600000).toISOString() } }; } };
assert.equal((await acquireSchedulerRunLease(expiredLease, { ownerRunId: "run-new", now: scheduledAt, ttlMs: 3600000 })).status, "expired");
assert.equal((await releaseSchedulerRunLease(expiredLease, { ownerRunId: "run-new" })).status, "released");

assert.equal(revisionCost("verification"), 6);
assert.equal(revisionCost("translation"), 5);
assert.equal(revisionCost("editorial"), 4);
assert.equal(revisionCost("classification"), 3);
assert.equal(revisionCost("ranking"), 2);

const beforeReset = new Date("2026-09-20T23:59:59Z");
const afterReset = new Date("2026-09-21T00:00:00Z");
assert.equal(utcRequestDate(beforeReset), "2026-09-20");
assert.equal(utcRequestDate(afterReset), "2026-09-21");
assert.notEqual(utcRequestDate(beforeReset), utcRequestDate(afterReset));
const dstBefore = localScheduleTime(new Date("2026-03-29T00:30:00Z"), "Europe/Madrid");
const dstAfter = localScheduleTime(new Date("2026-03-29T01:30:00Z"), "Europe/Madrid");
assert.equal(dstBefore.localDate, "2026-03-29");
assert.equal(dstAfter.localDate, "2026-03-29");
assert.equal(dstBefore.hour, 1);
assert.equal(dstAfter.hour, 3);
assert.equal(classifyScheduleSlot(new Date("2026-03-29T00:30:00Z"), "Europe/Madrid"), "night");
assert.equal(classifyScheduleSlot(new Date("2026-03-29T01:30:00Z"), "Europe/Madrid"), "night");
for (const instant of ["2026-01-15T07:00:00Z", "2026-07-15T07:00:00Z"]) assert.equal(classifyScheduleSlot(new Date(instant), "Europe/Madrid"), "morning");
for (const instant of ["2026-01-15T13:00:00Z", "2026-07-15T13:00:00Z"]) assert.equal(classifyScheduleSlot(new Date(instant), "Europe/Madrid"), "afternoon");
for (const instant of ["2026-01-15T19:00:00Z", "2026-07-15T19:00:00Z"]) assert.equal(classifyScheduleSlot(new Date(instant), "Europe/Madrid"), "night");

const rateLimitResult = schedulerResult({ plan: allowed, quotaAfter: quota(19), leaseOutcome: "released", attempts: [{ eventKey: "event-rate-limit", status: "failed", requestsUsed: 1, reason: "FREE_TIER_LIMIT_REACHED" }], stopReason: "BLOCKED_PROVIDER_RATE_LIMIT" });
assert.equal(rateLimitResult.stopReason, "BLOCKED_PROVIDER_RATE_LIMIT");
assert.equal(rateLimitResult.requestsUsed, 1);

console.log("pipeline:scheduler:unit: OK (budget, dynamic accounting, UTC reset, Europe/Madrid DST, slots, leases, duplicate triggers, event deduplication, failure/revision/rejection policy, rate-limit stop, max events)");
