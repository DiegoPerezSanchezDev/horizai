import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.ts";
import {
  qualityBenchmarkAgentVersions,
  qualityBenchmarkAccountingEventKey,
  plannedQualityBenchmarkCalls,
  QUALITY_BENCHMARK_CASE_IDS,
  QUALITY_BENCHMARK_MODEL,
  QUALITY_BENCHMARK_PROVIDER,
  QUALITY_BENCHMARK_PURPOSE,
  type NormalEventStage,
  type QualityBenchmarkCaseId,
} from "../lib/agents/runtime/cloudflare-quality-benchmark.ts";

const REQUIRED_FLAG = "--validate-quality-benchmark-authorization-readonly";
const EXPECTED_PROJECT_REF = "skrthgpurquypgdwxast";
type AuthorizationRpc = "reserve_cloudflare_quality_benchmark_capacity" | "reserve_cloudflare_supervised_stage_validation_capacity";

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}

function requiredEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_SECRET_KEY"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`BLOCKED_MISSING_${name}`);
  return value;
}

function result(label: string, status: string, detail?: string) {
  return { label, status, ...(detail ? { detail } : {}) };
}

async function expectRpcRejection(
  client: SupabaseClient<Database>,
  rpc: AuthorizationRpc,
  args: Record<string, unknown>,
  label: string,
  expectedMessage: string,
) {
  check(args.p_run_id === null, "BLOCKED_REMOTE_VALIDATION_MUST_NOT_CREATE_OR_USE_A_RUN");
  const { error } = await client.rpc(rpc, args as never);
  if (!error) throw new Error(`BLOCKED_REMOTE_AUTHORIZATION_UNEXPECTED_SUCCESS:${label}`);
  if (!error.message.includes(expectedMessage)) throw new Error(`BLOCKED_REMOTE_AUTHORIZATION_MISMATCH:${label}`);
  return result(label, "PASS", expectedMessage);
}

function qualityArgs(input: {
  caseId: string;
  stage: string;
  purpose?: string;
  provider?: string;
  model?: string;
  agentVersion?: string;
}): Record<string, unknown> {
  return {
    p_run_id: null,
    p_stage: input.stage,
    p_benchmark_case_id: input.caseId,
    p_agent_name: input.stage,
    p_agent_version: input.agentVersion ?? qualityBenchmarkAgentVersions[input.stage as keyof typeof qualityBenchmarkAgentVersions],
    p_event_key: qualityBenchmarkAccountingEventKey(input.caseId as QualityBenchmarkCaseId, input.stage as NormalEventStage),
    p_attempt: 1,
    p_validation_purpose: input.purpose ?? QUALITY_BENCHMARK_PURPOSE,
    p_provider: input.provider ?? QUALITY_BENCHMARK_PROVIDER,
    p_model: input.model ?? QUALITY_BENCHMARK_MODEL,
    p_request_date: new Date().toISOString().slice(0, 10),
    p_request_limit: 8,
    p_daily_neuron_allocation: 10_000,
    p_estimated_neurons: 1,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== REQUIRED_FLAG) throw new Error("BLOCKED_REMOTE_VALIDATION_REQUIRES_EXACT_READONLY_FLAG");
  check(plannedQualityBenchmarkCalls.length === 7, "BLOCKED_QUALITY_BENCHMARK_PLAN_DRIFT");
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const projectRef = new URL(url).hostname.split(".")[0];
  check(projectRef === EXPECTED_PROJECT_REF, "BLOCKED_REMOTE_PROJECT_REF_MISMATCH");
  const client = createClient<Database>(url, requiredEnv("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const cases = QUALITY_BENCHMARK_CASE_IDS;
  const results: Array<{ label: string; status: string; detail?: string }> = [];

  for (const call of plannedQualityBenchmarkCalls) {
    results.push(await expectRpcRejection(
      client,
      "reserve_cloudflare_quality_benchmark_capacity",
      qualityArgs({ caseId: call.benchmarkCaseId, stage: call.stage }),
      `${call.benchmarkCaseId}/${call.stage}`,
      "provider-matched dry-run quality benchmark run is required",
    ));
  }

  results.push(await expectRpcRejection(client, "reserve_cloudflare_quality_benchmark_capacity",
    qualityArgs({ caseId: "quality:unknown-case-v1", stage: "critic" }), "unknown-case", "case and stage are outside the quality benchmark allowlist"));
  results.push(await expectRpcRejection(client, "reserve_cloudflare_quality_benchmark_capacity",
    qualityArgs({ caseId: cases.mitControl, stage: "verifier" }), "mit-verifier", "case and stage are outside the quality benchmark allowlist"));
  results.push(await expectRpcRejection(client, "reserve_cloudflare_quality_benchmark_capacity",
    qualityArgs({ caseId: cases.arsProblem, stage: "translator", purpose: "translator_stage_validation" }), "wrong-purpose", "request is outside the quality benchmark allowlist"));
  results.push(await expectRpcRejection(client, "reserve_cloudflare_quality_benchmark_capacity",
    qualityArgs({ caseId: cases.arsProblem, stage: "translator", provider: "groq" }), "wrong-provider", "request is outside the quality benchmark allowlist"));
  results.push(await expectRpcRejection(client, "reserve_cloudflare_quality_benchmark_capacity",
    qualityArgs({ caseId: cases.arsProblem, stage: "translator", model: "@cf/meta/llama-3.1-8b-instruct" }), "wrong-model", "request is outside the quality benchmark allowlist"));
  results.push(await expectRpcRejection(client, "reserve_cloudflare_quality_benchmark_capacity",
    qualityArgs({ caseId: cases.arsProblem, stage: "translator", agentVersion: "translator-v999" }), "wrong-agent-version", "request is outside the quality benchmark allowlist"));

  const canonicalArgs = {
    p_run_id: null,
    p_stage: "translator",
    p_agent_name: "translator",
    p_agent_version: "translator-v1",
    p_event_key: "supervised-validation:translator_stage_validation:00000000-0000-4000-8000-000000000000",
    p_fixture: "translator:unit:gpt-5-launch-2026",
    p_attempt: 1,
    p_validation_purpose: "translator_stage_validation",
    p_provider: "cloudflare_workers_ai",
    p_model: QUALITY_BENCHMARK_MODEL,
    p_request_date: new Date().toISOString().slice(0, 10),
    p_request_limit: 8,
    p_daily_neuron_allocation: 10_000,
    p_estimated_neurons: 1,
  };
  results.push(await expectRpcRejection(client, "reserve_cloudflare_supervised_stage_validation_capacity",
    canonicalArgs, "canonical-synthetic-translator", "provider-matched dry-run validation run is required"));
  results.push(await expectRpcRejection(client, "reserve_cloudflare_supervised_stage_validation_capacity",
    { ...canonicalArgs, p_fixture: cases.arsProblem }, "benchmark-as-synthetic-fixture", "request is outside the supervised stage validation allowlist"));

  process.stdout.write(`${JSON.stringify({
    status: "REMOTE_AUTHORIZATION_VALIDATED_WITHOUT_RUN_OR_RESERVATION",
    remoteProjectRef: projectRef,
    serviceRolePassed: true,
    runRowsCreated: 0,
    providerReservationsCreated: 0,
    providerCalls: 0,
    results,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error && /^BLOCKED_[A-Z0-9_:-]{3,120}$/.test(error.message) ? error.message : "BLOCKED_REMOTE_AUTHORIZATION_VALIDATION_FAILED"}\n`);
  process.exitCode = 1;
});
