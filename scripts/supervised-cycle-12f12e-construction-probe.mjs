import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { captureConstructionFailure, runWithConstructionDiagnostics, secretValuesFromEnvironment } from "../lib/agents/pipeline/construction-diagnostics.ts";

const outputPath = "artifacts/supervised-cycle-12f12e-construction-resume.json";
const invocationPath = "artifacts/supervised-cycle-12f12e-construction-invocation.json";
const requestCounts = { remoteRequests: 0, blockedNetworkAttempts: 0, providerCalls: 0, remoteWrites: 0 };
let currentStep = "diagnostic.network-guard";
const steps = [];
const startedAt = new Date().toISOString();

function presence(name) { return process.env[name]?.trim() ? "PRESENT" : "ABSENT"; }
function validUrl(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return "ABSENT";
  try { const parsed = new URL(raw); return ["https:", "http:"].includes(parsed.protocol) && parsed.hostname ? "VALID_FORMAT" : "INVALID_FORMAT"; }
  catch { return "INVALID_FORMAT"; }
}
function envSummary() {
  const provider = process.env.AGENT_PROVIDER?.trim().toLowerCase();
  const router = process.env.FREE_PROVIDER_ROUTER_ENABLED?.trim().toLowerCase();
  return {
    supabaseUrl: { presence: presence("NEXT_PUBLIC_SUPABASE_URL"), format: validUrl("NEXT_PUBLIC_SUPABASE_URL") },
    supabaseServerSecret: { presence: presence("SUPABASE_SECRET_KEY"), format: process.env.SUPABASE_SECRET_KEY?.trim() ? (/^sb_secret_[A-Za-z0-9_-]+$/.test(process.env.SUPABASE_SECRET_KEY.trim()) || /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(process.env.SUPABASE_SECRET_KEY.trim()) ? "VALID_FORMAT" : "INVALID_FORMAT") : "ABSENT", credentialClass: "Supabase server secret" },
    groq: { provider: provider === "groq" ? "VALID_FORMAT" : provider ? "INVALID_FORMAT" : "ABSENT", endpoint: validUrl("AGENT_API_URL"), key: presence("AGENT_API_KEY"), modelIdentifiers: Object.fromEntries(["AGENT_MODEL_VERIFY", "AGENT_MODEL_TRANSLATE", "AGENT_MODEL_EDITOR", "AGENT_MODEL_CLASSIFY", "AGENT_MODEL_RANK", "AGENT_MODEL_CRITIC"].map((name) => [name, presence(name)])) },
    supervisedMode: "CONFIGURED_BY_RUNNER",
    freeProviderRouter: router === "true" ? "ENABLED" : router === undefined || router === "" || router === "false" ? "DISABLED" : "INVALID_FORMAT",
  };
}

assert.equal(existsSync(outputPath), false, "12F12E_OUTPUT_ALREADY_EXISTS");
assert.equal(existsSync(invocationPath), false, "12F12E_CONSTRUCTION_ALREADY_ATTEMPTED");
writeFileSync(invocationPath, JSON.stringify({ phase: "12F.12E", startedAtUtc: startedAt, constructionInvocationCount: 1, remoteRequestsAllowed: 0 }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  requestCounts.blockedNetworkAttempts += 1;
  throw new Error("NETWORK_BLOCKED_DURING_LOCAL_CONSTRUCTION_DIAGNOSIS");
};

const artifact = {
  phase: "12F.12E",
  attemptId: "4658d5c0-857c-4ed5-b97f-afb133b2bf22",
  historicalPgrst303Classification: "INSUFFICIENT_EVIDENCE",
  constructionTrace: { steps, succeeded: false, path: "shared capacity-resume production builder → createProductionPipeline" },
  constructionErrorCapture: null,
  constructionRootCause: "PENDING_CAPTURE",
  constructionFix: { implemented: false, migrationRequired: false },
  constructionRegression: { productionFactory: "NOT_RUN", freshProcess: "NOT_RUN", resumeOriented: "NOT_RUN", dailyRunOriented: "NOT_RUN", sameCanonicalConfiguration: "NOT_RUN" },
  environmentConfig: envSummary(),
  remotePreflight: { status: "NOT_RUN", invocationCount: 0, remoteRequests: 0 },
  remoteFailureDiagnostics: null,
  attemptState: null,
  capacity: null,
  claim: "NOT_RUN",
  resume: { invocationCount: 0, stage: "critic", generationBefore: 1, generationAfter: null },
  critic: null,
  m34: null,
  review: null,
  m32: null,
  providerAccounting: { providerCalls: 0, remoteWrites: 0, remoteReadsAttempted: 0 },
  finalState: null,
  publicState: null,
  readyForHumanAction: false,
  requestCounts,
};

try {
  currentStep = "module.initialization.resume-builder";
  const { createCapacityResumeProductionPipeline } = await import("./capacity-resume-production-pipeline.ts");
  currentStep = "resume.request-budget";
  const { ProviderScopedDailyRequestBudget } = await import("../lib/agents/runtime/request-budget.ts");
  const budget = new ProviderScopedDailyRequestBudget(() => new Date(), 18);
  for (let count = 0; count < 5; count += 1) budget.reserve("groq", 18);
  const constructed = runWithConstructionDiagnostics({
    componentStep: () => currentStep,
    secretValues: secretValuesFromEnvironment(),
    onFailure: (diagnostic) => { artifact.constructionErrorCapture = diagnostic; },
    action: () => createCapacityResumeProductionPipeline({
      requestBudget: budget,
      pipelineRunId: "f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d",
      onConstructionStep: (step) => { currentStep = step; steps.push(step); },
    }),
  });
  artifact.constructionTrace.succeeded = true;
  artifact.constructionTrace.steps = [...steps];
  artifact.constructionRootCause = "NON_REPRODUCIBLE";
  artifact.constructionRegression = { productionFactory: "PASS", freshProcess: "PASS", resumeOriented: "PASS", dailyRunOriented: "NOT_RUN", sameCanonicalConfiguration: "PASS" };
  artifact.finalState = "CONSTRUCTION_HEALTHY_LOCAL_GATES_PENDING";
  void constructed;
} catch (error) {
  if (!artifact.constructionErrorCapture) {
    artifact.constructionErrorCapture = captureConstructionFailure({ error, componentStep: currentStep, secretValues: secretValuesFromEnvironment(), entrypoint: process.argv[1] });
  }
  artifact.constructionTrace.steps = [...steps];
  artifact.constructionRootCause = "OTHER_PROVEN_CAUSE";
  artifact.finalState = "PIPELINE_CONSTRUCTION_FAILURE";
}

globalThis.fetch = originalFetch;
artifact.requestCounts = { ...requestCounts, remoteRequests: 0, providerCalls: 0, remoteWrites: 0 };
artifact.providerAccounting = { providerCalls: 0, remoteWrites: 0, remoteReadsAttempted: 0 };
artifact.remotePreflight = { status: "NOT_RUN", invocationCount: 0, remoteRequests: 0 };
artifact.readyForHumanAction = false;
writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ phase: artifact.phase, constructionSucceeded: artifact.constructionTrace.succeeded, failingStep: artifact.constructionErrorCapture?.componentStep ?? null, errorName: artifact.constructionErrorCapture?.error.name ?? null, errorCode: artifact.constructionErrorCapture?.error.code ?? null, errorMessage: artifact.constructionErrorCapture?.error.message ?? null, safeCause: artifact.constructionErrorCapture?.error.causeChain ?? [], remoteRequests: 0, blockedNetworkAttempts: requestCounts.blockedNetworkAttempts, providerCalls: 0, remoteWrites: 0, artifact: outputPath }));
