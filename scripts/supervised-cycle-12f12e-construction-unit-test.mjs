import assert from "node:assert/strict";

let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts += 1; throw new Error("NETWORK_BLOCKED_IN_CONSTRUCTION_TEST"); };

const [{ ProviderScopedDailyRequestBudget }, { createCapacityResumeProductionPipeline }, { createProductionPipeline }, { createSupabaseServerClient }, { buildPipelinePublicationPayload }, { SUPERVISED_EVENT_ATTEMPT_LIMIT, SUPERVISED_PROVIDER_REQUEST_LIMIT }] = await Promise.all([
  import("../lib/agents/runtime/request-budget.ts"),
  import("./capacity-resume-production-pipeline.ts"),
  import("../lib/agents/pipeline/create-production-pipeline.ts"),
  import("../lib/supabase/server-client.ts"),
  import("../lib/agents/publisher/publication-payload.ts"),
  import("../lib/agents/pipeline/supervised-throughput-policy.ts"),
]);

const resumeBudget = new ProviderScopedDailyRequestBudget(() => new Date(), 18);
for (let count = 0; count < 5; count += 1) resumeBudget.reserve("groq", 18);
const resumeSteps = [];
const resume = createCapacityResumeProductionPipeline({
  requestBudget: resumeBudget,
  pipelineRunId: "f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d",
  onConstructionStep: (step) => resumeSteps.push(step),
});

const dailySteps = [];
const dailySupabase = createSupabaseServerClient();
const dailyBudget = new ProviderScopedDailyRequestBudget(() => new Date(), SUPERVISED_PROVIDER_REQUEST_LIMIT);
const daily = createProductionPipeline({
  supabase: dailySupabase,
  requestBudget: dailyBudget,
  runId: "12f12e-construction-test",
  persistTraceability: true,
  publicationPayloadFactory: buildPipelinePublicationPayload,
  config: { mode: "supervised", hours: 24, limit: SUPERVISED_EVENT_ATTEMPT_LIMIT, dryRun: true, publish: false, trigger: "manual", automaticRevision: false, maxRevisionAttempts: 1 },
  onConstructionStep: (step) => dailySteps.push(step),
});

assert.ok(resumeSteps.includes("resume.create-production-pipeline"));
assert.ok(resumeSteps.includes("pipeline.return"));
assert.ok(dailySteps.includes("provider.client"));
assert.ok(dailySteps.includes("pipeline.orchestrator"));
assert.deepEqual(daily.configs, resume.pipeline.configs, "resume and daily runners must use the same canonical supervised provider configuration");
assert.equal(networkAttempts, 0, "pipeline construction must not perform network operations");

console.log(JSON.stringify({
  result: "PASS",
  freshProcess: true,
  resumeOrientedConstruction: "PASS",
  dailyRunOrientedConstruction: "PASS",
  sameCanonicalConfiguration: "PASS",
  dailyConfiguredCandidateLimit: SUPERVISED_EVENT_ATTEMPT_LIMIT,
  remoteRequests: 0,
  providerCalls: 0,
}));
