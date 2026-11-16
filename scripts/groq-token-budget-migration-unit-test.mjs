import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const migrationName = "20260925000025_groq_atomic_token_capacity.sql";
const directory = new URL("../supabase/migrations/", import.meta.url);
const names = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
assert.ok(names.includes(migrationName), "the Groq token migration keeps its assigned sequence number");
assert.ok(names.indexOf("20260927000026_cloudflare_quality_benchmark_authorization.sql") > names.indexOf(migrationName),
  "subsequent additive migrations keep a later sequence number");
const sql = readFileSync(new URL(`../supabase/migrations/${migrationName}`, import.meta.url), "utf8").toLowerCase();

assert.match(sql, /^begin;/);
assert.match(sql.trimEnd(), /commit;$/);
assert.doesNotMatch(sql, /create\s+table|alter\s+table|drop\s+table|truncate\s+table/,
  "the existing agent_logs ledger is reused without a table/schema change");
assert.match(sql, /create function public\.reserve_groq_request_and_tokens/);
assert.match(sql, /create function public\.settle_groq_token_usage/);
assert.match(sql, /create or replace function public\.mark_agent_request_dispatched/);
assert.match(sql, /create or replace function public\.release_agent_request/);
assert.match(sql, /p_request_hard_limit/);
assert.match(sql, /p_request_soft_limit/);
assert.match(sql, /p_token_hard_limit/);
assert.match(sql, /p_token_soft_limit/);
assert.match(sql, /p_estimated_tokens is null or p_estimated_tokens < 1/);
assert.match(sql, /provider_unit, provider_unit_amount/);
assert.ok(sql.includes("'tokens', p_estimated_tokens"));
assert.match(sql, /tokenusagestate', 'reserved_estimate'/);
assert.match(sql, /provider_unit_amount = v_actual::bigint/);
assert.match(sql, /provider_token_settlement_conflict/);
assert.match(sql, /v_actual - v_reserved/);
assert.match(sql, /providerrequestdispatched', true/);
assert.match(sql, /coalesce\(payload ->> 'providerrequestdispatched', 'false'\) <> 'true'/);
assert.match(sql, /request date must be the current utc day/);
assert.match(sql, /created_at >= v_day_start and created_at < v_day_end/);
assert.match(sql, /horizai-agent-budget:groq:/);
const reserveFunction = sql.split("create or replace function public.mark_agent_request_dispatched")[0];
assert.doesNotMatch(reserveFunction, /horizai-agent-budget:' \|\| p_request_date/,
  "Groq capacity admission does not use a provider-global lock");
assert.match(sql, /if v_provider = 'groq' then[\s\S]*horizai-agent-budget:groq:[\s\S]*else[\s\S]*horizai-agent-budget:' \|\| p_request_date/,
  "shared dispatch/release choose the Groq/day lock only for Groq rows");
assert.match(sql, /v_legacy_unknown > 0/);
assert.match(sql, /groq_daily_token_usage_unknown/);
assert.match(sql, /revoke all on function public\.reserve_groq_request_and_tokens[\s\S]*from public, anon, authenticated/);
assert.match(sql, /grant execute on function public\.reserve_groq_request_and_tokens[\s\S]*to service_role/);
assert.match(sql, /revoke all on function public\.settle_groq_token_usage[\s\S]*from public, anon, authenticated/);
assert.match(sql, /grant execute on function public\.settle_groq_token_usage[\s\S]*to service_role/);
assert.doesNotMatch(sql, /reserve_cloudflare_neuron_capacity|provider_unit = 'neurons'|provider_unit_amount.*neurons/,
  "the Cloudflare neuron policy is not altered");

console.log("groq token budget migration static checks passed (no database connection; SQL concurrency remains static-only)");
