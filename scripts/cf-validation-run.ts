/**
 * cf-validation-run — real Cloudflare Workers AI validation, NO database, NO publication.
 *
 * Usage (never prints env values):
 *   node --env-file=.env.local --conditions=react-server --experimental-strip-types \
 *     scripts/cf-validation-run.ts --stage verifier --cases confirmed2,confirmed1 --model llama [--execute]
 *
 * Without --execute it only prints the plan (zero network calls).
 * Hard neuron budget (default 3000, margin-adjusted token-derived estimate) is persisted in a state file
 * and shared by every invocation; any 429 / quota error writes a STOP flag that blocks further dispatch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getAgentFailureDetails } from "../lib/agents/runtime/agent-errors.ts";
import { CloudflareWorkersAIModelProvider } from "../lib/agents/runtime/cloudflare-workers-ai-provider.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { CLOUDFLARE_LLAMA_VALIDATION_MODEL, CLOUDFLARE_WORKERS_AI_MODEL } from "../lib/agents/runtime/provider-cost-policy.ts";
import { estimateCloudflareNeurons, readCloudflareNeuronRates } from "../lib/agents/runtime/free-provider-router.ts";
import type { AgentLogger, AgentRunMetadata, ModelConfig, RequestReservation } from "../lib/agents/runtime/runtime-types.ts";
import { createVerifierInputFixture, createSecondaryAttributionVerifierInputFixture } from "../lib/agents/verifier/verifier-fixtures.ts";
import { VerifierAgent, getVerifierModelConfig } from "../lib/agents/verifier/verifier-agent.ts";
import { canonicalTranslatorInput } from "../lib/agents/translator/translator-input-fixtures.ts";
import { TranslatorAgent, getTranslatorModelConfig } from "../lib/agents/translator/translator-agent.ts";
import { canonicalEditorInput } from "../lib/agents/editor/editor-fixtures.ts";
import { EditorV2Agent, getEditorV2ModelConfig } from "../lib/agents/editor/editor-v2-agent.ts";
import { classifierFixtureRegistry, classifierFixtures } from "../lib/agents/classifier/classifier-fixtures.ts";
import { ClassifierAgent, getClassifierModelConfig } from "../lib/agents/classifier/classifier-agent.ts";
import { rankerFixtures } from "../lib/agents/ranker/ranker-fixtures.ts";
import { RankerAgent, getRankerModelConfig } from "../lib/agents/ranker/ranker-agent.ts";
import { canonicalCriticInput, secondaryAttributionInput, promptInjectionInput, editorialDriftInput } from "../lib/agents/critic/critic-fixtures.ts";
import { CriticAgent, getCriticModelConfig } from "../lib/agents/critic/critic-agent.ts";
import { prepareStoredBenchmarkStage, qualityBenchmarkRegistrySnapshot } from "./cloudflare-quality-benchmark-fixtures.ts";
import { QUALITY_BENCHMARK_CASE_IDS } from "../lib/agents/runtime/cloudflare-quality-benchmark.ts";

const BUDGET_STATE = process.env.CF_VALIDATION_STATE ?? "";
const RESULTS_FILE = process.env.CF_VALIDATION_RESULTS ?? "";
const HARD_BUDGET = Number(process.env.CF_VALIDATION_BUDGET ?? 3000);

type Stage = "verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic";
type State = { spentNeurons: number; spentNeuronsRaw: number; calls: number; stop: string | null };

function args() {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : undefined; };
  return { stage: get("stage") as Stage, cases: (get("cases") ?? "").split(",").filter(Boolean), model: get("model") ?? "llama", execute: a.includes("--execute") };
}

function loadState(): State {
  if (!BUDGET_STATE) throw new Error("CF_VALIDATION_STATE not set");
  return existsSync(BUDGET_STATE) ? JSON.parse(readFileSync(BUDGET_STATE, "utf8")) : { spentNeurons: 0, spentNeuronsRaw: 0, calls: 0, stop: null };
}
function saveState(s: State) { mkdirSync(dirname(BUDGET_STATE), { recursive: true }); writeFileSync(BUDGET_STATE, JSON.stringify(s, null, 2)); }

function appendResult(r: unknown) {
  const all = existsSync(RESULTS_FILE) ? JSON.parse(readFileSync(RESULTS_FILE, "utf8")) : [];
  all.push(r);
  writeFileSync(RESULTS_FILE, JSON.stringify(all, null, 2));
}

class MemoryLogger implements AgentLogger {
  private n = 0;
  private readonly state: () => State;
  constructor(state: () => State) { this.state = state; }
  async startRun() { return `mem-${++this.n}`; }
  async reserveRequest(_r: string | null, _m: AgentRunMetadata, _a: number, _l: number, requestDate: string, capacity?: { estimatedNeurons?: number }): Promise<RequestReservation> {
    const st = this.state();
    if (st.stop) return { allowed: false, dailyCount: st.calls, dailyLimit: null, requestDate, reason: `STOP:${st.stop}` };
    const est = capacity?.estimatedNeurons ?? 0;
    // Hard budget gate: realistic pre-dispatch bound = reservation estimate (max_tokens worst case) must fit the remaining budget.
    if (st.spentNeurons + est > HARD_BUDGET) return { allowed: false, dailyCount: st.calls, dailyLimit: null, requestDate, reason: "LOCAL_BUDGET_WORST_CASE_EXCEEDED" };
    return { allowed: true, dailyCount: st.calls + 1, dailyLimit: null, requestDate, reservationId: ++this.n };
  }
  async releaseRequest() { return true; }
  async markRequestDispatched() { return true; }
  async getRemainingRequests() { return { remaining: 9999, used: 0, limit: 9999 } as never; }
  async getProviderDailyUsage(provider: never, dateUtc: string) {
    const st = this.state();
    return { provider, dateUtc, requestsReserved: st.calls, requestsDispatched: st.calls, inputTokens: 0, outputTokens: 0, totalTokens: 0, tokenUsageKnown: true, unknownTokenRequests: 0, neuronsUsed: st.spentNeurons, neuronUsageKnown: true };
  }
  async log() { /* in-memory only */ }
  async finishRun() { /* in-memory only */ }
}

function summarizeKeys(o: unknown, depth = 0): unknown {
  return depth > 4 ? "…" : o;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function main() {
  const { stage, cases, model, execute } = args();
  if (!stage || cases.length === 0) throw new Error("usage: --stage <stage> --cases a,b --model llama|gptoss [--execute]");
  const modelId = model === "gptoss" ? CLOUDFLARE_WORKERS_AI_MODEL : CLOUDFLARE_LLAMA_VALIDATION_MODEL;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_AI_API_TOKEN?.trim();
  if (!accountId || !token) throw new Error("MISSING_CLOUDFLARE_ENV");
  const rates = readCloudflareNeuronRates(process.env, modelId);

  // ---- case builders -------------------------------------------------------------------
  const stored = (caseId: string, st: "translator" | "editor" | "classifier" | "ranker") => {
    const p = prepareStoredBenchmarkStage(caseId as never, st);
    if (!p.input) throw new Error(`stored input missing for ${caseId}/${st}: ${p.blocker}`);
    return { input: p.input, historical: p.historicalOutput };
  };
  type Built = { id: string; run: (provider: CloudflareWorkersAIModelProvider, logger: MemoryLogger, cfg: ModelConfig) => Promise<unknown>; historical?: unknown };
  const rankerOpts = { now: new Date("2026-09-14T12:00:00.000Z"), activityHistory: [{ periodStart: "2026-09-14T10:00:00.000Z", periodEnd: "2026-09-14T11:00:00.000Z", activityScore: 90, eventCount: 8, articleCount: 4 }] };
  const build = (id: string): Built => {
    const common = { requestBudget: new DailyRequestBudget(() => new Date()), dryRun: true };
    switch (stage) {
      case "verifier": {
        const input = id === "confirmed2" ? createVerifierInputFixture("confirmed", 2) : id === "confirmed1" ? createVerifierInputFixture("confirmed", 1) : id === "secondary" ? createSecondaryAttributionVerifierInputFixture() : null;
        if (!input) throw new Error(`unknown verifier case ${id}`);
        return { id, run: (p, l, c) => new VerifierAgent(p, l).verify(input, { modelConfig: c, ...common }) };
      }
      case "translator": {
        const s = id === "canonical" ? { input: canonicalTranslatorInput, historical: null } : stored(id === "ars" ? QUALITY_BENCHMARK_CASE_IDS.arsProblem : QUALITY_BENCHMARK_CASE_IDS.mitControl, "translator");
        return { id, historical: s.historical, run: (p, l, c) => new TranslatorAgent(p, l).translate(s.input as never, { modelConfig: c, ...common }) };
      }
      case "editor": {
        const s = id === "canonical" ? { input: canonicalEditorInput, historical: null } : stored(id === "ars" ? QUALITY_BENCHMARK_CASE_IDS.arsProblem : QUALITY_BENCHMARK_CASE_IDS.mitControl, "editor");
        return { id, historical: s.historical, run: (p, l, c) => new EditorV2Agent(p, l).edit(s.input as never, { modelConfig: c, ...common }) };
      }
      case "classifier": {
        if (id === "ars" || id === "mit") {
          const s = stored(id === "ars" ? QUALITY_BENCHMARK_CASE_IDS.arsProblem : QUALITY_BENCHMARK_CASE_IDS.mitControl, "classifier");
          return { id, historical: s.historical, run: (p, l, c) => new ClassifierAgent(p, l).classify(s.input as never, { modelConfig: c, ...common, registry: qualityBenchmarkRegistrySnapshot }) };
        }
        const f = classifierFixtures[Number(id)];
        if (!f) throw new Error(`unknown classifier case ${id}`);
        return { id: `${id}:${f.input.event.canonicalTitle ?? ""}`.slice(0, 60), historical: f.expected, run: (p, l, c) => new ClassifierAgent(p, l).classify(f.input as never, { modelConfig: c, ...common, registry: classifierFixtureRegistry }) };
      }
      case "ranker": {
        if (id === "ars" || id === "mit") {
          const s = stored(id === "ars" ? QUALITY_BENCHMARK_CASE_IDS.arsProblem : QUALITY_BENCHMARK_CASE_IDS.mitControl, "ranker");
          return { id, historical: s.historical, run: (p, l, c) => new RankerAgent(p, l).rank(s.input as never, { modelConfig: c, ...common, ...rankerOpts }) };
        }
        const f = rankerFixtures[Number(id)];
        if (!f) throw new Error(`unknown ranker case ${id}`);
        return { id: `${id}:${f.name}`, historical: (f as { generation?: unknown }).generation, run: (p, l, c) => new RankerAgent(p, l).rank(structuredClone(f.input) as never, { modelConfig: c, ...common, ...rankerOpts }) };
      }
      case "critic": {
        const m: Record<string, unknown> = { canonical: canonicalCriticInput, secondary: secondaryAttributionInput, injection: promptInjectionInput, drift: editorialDriftInput };
        if (!m[id]) throw new Error(`unknown critic case ${id}`);
        return { id, run: (p, l, c) => new CriticAgent(p, l).critique(structuredClone(m[id]) as never, { modelConfig: c, ...common, registry: classifierFixtureRegistry }) };
      }
    }
  };
  const productionCfg: ModelConfig = ({ verifier: getVerifierModelConfig, translator: getTranslatorModelConfig, editor: getEditorV2ModelConfig, classifier: getClassifierModelConfig, ranker: getRankerModelConfig, critic: getCriticModelConfig } as Record<Stage, () => ModelConfig>)[stage]();
  const cfg: ModelConfig = { ...productionCfg, model: modelId, maxRetries: 0, dailyRequestLimit: 50 };

  const plan = cases.map(build);
  console.log(JSON.stringify({ stage, model: modelId, cases: plan.map((p) => p.id), structuredOutputMode: cfg.structuredOutputMode, maxOutputTokens: cfg.maxOutputTokens, execute, hardBudget: HARD_BUDGET, state: loadState() }));
  if (!execute) return;

  for (const c of plan) {
    const st = loadState();
    if (st.stop) { console.log(JSON.stringify({ case: c.id, skipped: `STOP:${st.stop}` })); break; }
    if (st.spentNeurons >= HARD_BUDGET) { console.log(JSON.stringify({ case: c.id, skipped: "BUDGET_REACHED" })); break; }
    let httpStatus: number | null = null;
    let calls = 0;
    const guardedFetch: typeof fetch = async (url, init) => {
      calls += 1;
      const res = await fetch(url, { ...init, redirect: "error" });
      httpStatus = res.status;
      if (res.status === 429 || res.status === 402 || res.status === 403) {
        const s = loadState(); s.stop = `HTTP_${res.status}`; saveState(s);
      }
      return res;
    };
    const provider = new CloudflareWorkersAIModelProvider(accountId, token, guardedFetch, modelId);
    const logger = new MemoryLogger(loadState);
    const t0 = Date.now();
    let result: unknown = null; let failure: unknown = null;
    try { result = await c.run(provider, logger, cfg); } catch (e) { failure = e; }
    const latencyMs = Date.now() - t0;
    const fd = failure ? getAgentFailureDetails(failure) : null;
    const resultRecord = toRecord(result);
    const diag = toRecord(resultRecord.diagnostics ?? fd?.diagnostics ?? fd?.telemetry);
    const usage = toRecord(resultRecord.usage ?? diag.usage);
    const inTok = Number(usage.inputTokens ?? 0); const outTok = Number(usage.outputTokens ?? 0);
    const neuronsRaw = calls > 0 && (inTok || outTok) ? estimateCloudflareNeurons({ inputTokens: inTok, outputTokens: outTok, ...rates, safetyMarginBps: 10_000 }) : 0;
    const neurons = calls > 0 && (inTok || outTok) ? estimateCloudflareNeurons({ inputTokens: inTok, outputTokens: outTok, ...rates }) : 0;
    const s2 = loadState(); s2.spentNeurons += neurons; s2.spentNeuronsRaw += neuronsRaw; s2.calls += calls;
    const errMsg = failure instanceof Error ? failure.message : failure ? String(failure) : null;
    if (/429|quota|rate.?limit|capacity|neuron/i.test(`${errMsg} ${diag.failureKind ?? ""}`) && httpStatus !== 200) s2.stop = s2.stop ?? "QUOTA_OR_RATE_ERROR";
    saveState(s2);
    const record = {
      stage, model: modelId, case: c.id, ok: !failure, httpStatus, providerCalls: calls, latencyMs,
      inputTokens: inTok, outputTokens: outTok, neuronsEstimatedWithMargin: neurons, neuronsEstimatedRaw: neuronsRaw,
      finishReason: diag.finishReason ?? null, failureKind: failure ? (diag.failureKind ?? null) : "SUCCESS",
      zodIssues: failure ? (diag.zodIssues ?? null) : null, missingFields: failure ? (diag.responseMissingTopLevelFields ?? null) : null,
      error: errMsg ? errMsg.slice(0, 300) : null,
      output: resultRecord.output ?? null, historicalGroqOrExpected: c.historical ?? null,
      cumulative: { spentNeurons: s2.spentNeurons, spentRaw: s2.spentNeuronsRaw, calls: s2.calls, stop: s2.stop },
    };
    appendResult(record);
    console.log(JSON.stringify({ case: c.id, ok: record.ok, http: httpStatus, ms: latencyMs, inTok, outTok, neurons, failureKind: record.failureKind, error: record.error, cumulative: record.cumulative }));
    if (s2.stop) break;
  }
}

main().catch((e) => { console.error("FATAL", e instanceof Error ? e.message : String(e)); process.exit(1); });
void summarizeKeys;
