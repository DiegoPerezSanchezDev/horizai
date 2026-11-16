import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const migration = await readFile(new URL("supabase/migrations/20261022120000_scheduler_safety_repair_m40.sql", root), "utf8");

function functionBody(name) {
  const start = migration.indexOf(`create function public.${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = migration.indexOf("$function$;", start);
  assert.notEqual(end, -1, `missing function end ${name}`);
  return migration.slice(start, end);
}

const claim = functionBody("claim_supervised_scheduler_invocation_m40");
const heartbeat = functionBody("heartbeat_supervised_scheduler_lease_m40");
const finish = functionBody("finish_supervised_scheduler_invocation_m40");
const resumeClaim = functionBody("claim_pipeline_event_attempt_scheduler_resume_m40");
const resumeRelease = functionBody("release_pipeline_event_attempt_scheduler_resume_m40");

function legacySqlNotBetween(value) {
  if (value === null || value === undefined) return null;
  return value < 60 || value > 1020;
}
function plpgsqlIfBranches(condition) { return condition === true; }
function correctedTtlRejected(value) { return value === null || value === undefined || !Number.isInteger(value) || value < 60 || value > 1020; }

// Reproduce the old SQL three-valued-logic defect: IF NULL does not branch,
// while make_interval(secs => NULL) yields a NULL expiry.
assert.equal(legacySqlNotBetween(null), null);
assert.equal(plpgsqlIfBranches(legacySqlNotBetween(null)), false);
const legacyExpiry = (ttl, now) => ttl === null || ttl === undefined ? null : now + ttl;
assert.equal(legacyExpiry(null, 1_000), null);

assert.match(claim, /p_lease_ttl_seconds is null or p_lease_ttl_seconds not between 60 and 1020/i);
assert.match(heartbeat, /p_lease_ttl_seconds is null or p_lease_ttl_seconds not between 60 and 1020/i);
for (const input of ["p_invocation_id", "p_owner_id", "p_fencing_token", "p_now", "p_lease_ttl_seconds"]) {
  assert.match(heartbeat, new RegExp(`${input} is null`, "i"), `heartbeat must reject NULL ${input}`);
}
for (const value of [null, undefined, 59, 1021, 0, 60.5]) assert.equal(correctedTtlRejected(value), true);
for (const value of [60, 1020]) assert.equal(correctedTtlRejected(value), false);

for (const required of ["p_invocation_id", "p_owner_id", "p_fencing_token", "p_status", "p_requests_used", "p_now"]) {
  assert.match(finish, new RegExp(`${required} is null`, "i"), `finalizer must fail closed on NULL ${required}`);
}
assert.match(finish, /p_requests_remaining is not null and p_requests_remaining < 0/i);
assert.match(finish, /p_duration_ms is not null and p_duration_ms < 0/i);
for (const required of ["p_attempt_id", "p_event_key", "p_pipeline_run_id", "p_owner_id", "p_resume_stage"]) {
  assert.match(resumeClaim, new RegExp(`${required} is null`, "i"), `resume claim must reject NULL ${required}`);
  assert.match(resumeRelease, new RegExp(`${required} is null`, "i"), `resume release must reject NULL ${required}`);
}
assert.match(resumeClaim, /not \(p_resume_stage = any\(/i);
assert.match(resumeRelease, /not \(p_resume_stage = any\(/i);
assert.match(claim, /auth\.role\(\) is distinct from 'service_role'/i);
assert.match(heartbeat, /auth\.role\(\) is distinct from 'service_role'/i);
assert.match(claim, /p_utc_day is distinct from \(p_now at time zone 'UTC'\)::date/i);
assert.match(claim, /p_owner_id is null/i);
assert.ok(claim.indexOf("p_lease_ttl_seconds is null") < claim.indexOf("select * into v_lease"), "invalid TTL must be rejected before lease reads/locks");
assert.match(claim, /v_lease\.expires_at is null[\s\S]*?return jsonb_build_object\('status', 'ALREADY_RUNNING'/i);
assert.ok(heartbeat.indexOf("p_lease_ttl_seconds is null") < heartbeat.indexOf("update public.supervised_scheduler_lease"), "invalid heartbeat must not mutate the lease");
assert.match(resumeClaim, /v_attempt\.stop_reason is null/i);
assert.match(migration, /grant execute on function public\.claim_supervised_scheduler_invocation_m40.*to service_role/s);
assert.match(migration, /grant execute on function public\.heartbeat_supervised_scheduler_lease_m40.*to service_role/s);
assert.match(migration, /set search_path = pg_catalog, public/);
assert.match(migration, /constraint supervised_scheduler_lease_active_expiry check \(owner_id is null or released_at is not null or expires_at is not null\)/i);
assert.doesNotMatch(migration, /\b(drop|truncate)\s+(table|column|function)\b/i);

// Model a corrected lease claim/takeover and invalid heartbeat without any DB or provider access.
const lease = { owner: null, fencingToken: 0, expiresAt: null };
function claimLease(owner, ttl, now) {
  if (correctedTtlRejected(ttl) || !owner) return "REJECTED";
  if (lease.owner && lease.expiresAt === null) return "ALREADY_RUNNING";
  if (lease.owner && lease.expiresAt > now) return "DENIED";
  lease.owner = owner;
  lease.fencingToken += 1;
  lease.expiresAt = now + ttl;
  return "ACQUIRED";
}
function heartbeatLease(owner, fence, ttl, now) {
  if (!owner || !Number.isInteger(fence) || correctedTtlRejected(ttl) || !Number.isFinite(now)) return false;
  if (lease.owner !== owner || lease.fencingToken !== fence || lease.expiresAt <= now) return false;
  lease.expiresAt = now + ttl;
  return true;
}
assert.equal(claimLease("owner-A", 60, 1_000), "ACQUIRED");
const afterClaim = structuredClone(lease);
assert.equal(Number.isFinite(lease.expiresAt), true);
assert.equal(claimLease("owner-B", null, 1_005), "REJECTED");
assert.deepEqual(lease, afterClaim, "failed NULL-TTL claim must preserve owner, fence, and expiry");
assert.equal(claimLease("owner-B", 60, 1_010), "DENIED");
assert.equal(heartbeatLease("owner-A", lease.fencingToken, null, 1_010), false);
assert.deepEqual(lease, afterClaim, "failed takeover/heartbeat must preserve owner, fence, and valid expiry");
lease.expiresAt = null;
const ambiguousLease = structuredClone(lease);
assert.equal(claimLease("owner-B", 60, 1_020), "ALREADY_RUNNING");
assert.deepEqual(lease, ambiguousLease, "a pre-existing active lease with NULL expiry must fail closed without owner takeover");

console.log("migration40:lease:unit: OK (NULL TTL claim/heartbeat rejection, TTL boundaries, takeover/fencing immutability, required NULL identities, service-role ACL)");
