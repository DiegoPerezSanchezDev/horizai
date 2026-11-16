import assert from "node:assert/strict";
import { z } from "zod";
import {
  cloudflareAllRequiredStagesValidated,
  cloudflareStageCompatibilityMatrix,
  createSupervisedValidationEventKey,
  evaluateCloudflareFullEventEligibility,
  getCloudflareActivationGateState,
  getUnvalidatedCloudflareStages,
  normalEventStages,
  selectProviderForNewFullEvent,
  SUPERVISED_VALIDATION_MODEL,
  supervisedValidationAgentVersionAllowlist,
  supervisedValidationFixtureAllowlist,
  validateSupervisedCloudflareStageValidation,
} from "../lib/agents/runtime/cloudflare-stage-validation.ts";
import { estimateCloudflareNeurons, readCloudflareNeuronRates } from "../lib/agents/runtime/free-provider-router.ts";
import { evaluateGroqSchedulerThroughputReadiness } from "../lib/agents/runtime/groq-capacity-policy.ts";
import { CloudflareWorkersAIModelProvider } from "../lib/agents/runtime/cloudflare-workers-ai-provider.ts";

const envNames = [
  "AGENT_MODEL_VERIFY", "AGENT_MODEL_TRANSLATE", "AGENT_MODEL_EDITOR", "AGENT_MODEL_CLASSIFY", "AGENT_MODEL_RANK", "AGENT_MODEL_CRITIC",
  "AGENT_MAX_OUTPUT_TOKENS", "AGENT_MAX_INPUT_CHARS", "CLOUDFLARE_DAILY_NEURON_LIMIT",
  "CLOUDFLARE_LLAMA_3_3_70B_INPUT_NEURONS_PER_MILLION_TOKENS", "CLOUDFLARE_LLAMA_3_3_70B_OUTPUT_NEURONS_PER_MILLION_TOKENS", "CLOUDFLARE_NEURON_SAFETY_MARGIN_BPS", "GROQ_MAX_CONCURRENT_EVENTS",
];
const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
for (const name of envNames.slice(0, 6)) process.env[name] = "offline-fixture-model";
process.env.AGENT_MAX_OUTPUT_TOKENS = "1200";
process.env.AGENT_MAX_INPUT_CHARS = "12000";
process.env.CLOUDFLARE_DAILY_NEURON_LIMIT = "10000";
process.env.GROQ_MAX_CONCURRENT_EVENTS = "1";
for (const name of envNames.slice(9)) delete process.env[name];

try {
  assert.deepEqual(normalEventStages, ["verifier", "translator", "editor", "classifier", "ranker", "critic"]);
  assert.deepEqual(getUnvalidatedCloudflareStages(), []);
  assert.equal(cloudflareAllRequiredStagesValidated(), true);
  assert.deepEqual(getCloudflareActivationGateState(), {
    technicalAllStagesValidated: true,
    semanticQualityGateValidated: false,
    capacityProductionReady: false,
    schedulerThroughputReady: false,
    freeOnlySafetyValidated: false,
    productionRoutingEnabled: false,
  });
  assert.equal(cloudflareStageCompatibilityMatrix.verifier.status, "REAL_VALIDATED");
  assert.equal(cloudflareStageCompatibilityMatrix.translator.status, "REAL_VALIDATED");
  assert.equal(cloudflareStageCompatibilityMatrix.classifier.status, "REAL_VALIDATED");
  assert.equal(cloudflareStageCompatibilityMatrix.editor.status, "REAL_VALIDATED");
  assert.equal(cloudflareStageCompatibilityMatrix.ranker.status, "REAL_VALIDATED");
  assert.equal(cloudflareStageCompatibilityMatrix.critic.status, "REAL_VALIDATED_WITH_UNEXERCISED_NONEMPTY_EVIDENCE_BRANCH");
  const rankerUnvalidatedMatrix = Object.fromEntries(normalEventStages.map((stage) => [
    stage,
    { status: stage === "ranker" ? "NOT_VALIDATED" : cloudflareStageCompatibilityMatrix[stage].status },
  ]));
  assert.deepEqual(getUnvalidatedCloudflareStages(rankerUnvalidatedMatrix), ["ranker"]);
  assert.equal(cloudflareAllRequiredStagesValidated(rankerUnvalidatedMatrix), false);

  for (const stage of normalEventStages) {
    const request = validateSupervisedCloudflareStageValidation({
      stage,
      fixture: supervisedValidationFixtureAllowlist[stage],
      provider: "cloudflare_workers_ai",
      model: SUPERVISED_VALIDATION_MODEL,
      agentVersion: supervisedValidationAgentVersionAllowlist[stage],
      maxAttempts: 1,
      maxRetries: 0,
    });
    assert.equal(request.validationPurpose, `${stage}_stage_validation`);
    assert.equal(request.agentVersion, supervisedValidationAgentVersionAllowlist[stage]);
    assert.equal(request.maxAttempts, 1);
    assert.equal(request.maxRetries, 0);
  }
  assert.throws(() => validateSupervisedCloudflareStageValidation({ stage: "editor", fixture: supervisedValidationFixtureAllowlist.editor, provider: "cloudflare_workers_ai", model: SUPERVISED_VALIDATION_MODEL, agentVersion: "editor-v1" }), /BLOCKED_AGENT_VERSION_NOT_ALLOWLISTED/);
  assert.throws(() => validateSupervisedCloudflareStageValidation({ stage: "publisher", fixture: "x", provider: "cloudflare_workers_ai", model: SUPERVISED_VALIDATION_MODEL }), /BLOCKED_UNKNOWN_VALIDATION_STAGE/);
  assert.throws(() => validateSupervisedCloudflareStageValidation({ stage: "editor", fixture: supervisedValidationFixtureAllowlist.editor, provider: "groq", model: SUPERVISED_VALIDATION_MODEL }), /BLOCKED_PROVIDER_NOT_ALLOWLISTED/);
  assert.throws(() => validateSupervisedCloudflareStageValidation({ stage: "editor", fixture: supervisedValidationFixtureAllowlist.editor, provider: "cerebras", model: SUPERVISED_VALIDATION_MODEL }), /BLOCKED_PROVIDER_NOT_ALLOWLISTED/);
  assert.throws(() => validateSupervisedCloudflareStageValidation({ stage: "editor", fixture: supervisedValidationFixtureAllowlist.editor, provider: "cloudflare_workers_ai", model: "@cf/openai/gpt-oss-120b" }), /BLOCKED_MODEL_NOT_ALLOWLISTED/);
  assert.throws(() => validateSupervisedCloudflareStageValidation({ stage: "editor", fixture: "production-event-42", provider: "cloudflare_workers_ai", model: SUPERVISED_VALIDATION_MODEL }), /BLOCKED_FIXTURE_NOT_ALLOWLISTED/);
  assert.throws(() => validateSupervisedCloudflareStageValidation({ stage: "editor", fixture: supervisedValidationFixtureAllowlist.editor, provider: "cloudflare_workers_ai", model: SUPERVISED_VALIDATION_MODEL, maxRetries: 1 }), /BLOCKED_VALIDATION_RETRY_LIMIT/);
  assert.throws(() => validateSupervisedCloudflareStageValidation({ stage: "editor", fixture: supervisedValidationFixtureAllowlist.editor, provider: "cloudflare_workers_ai", model: SUPERVISED_VALIDATION_MODEL, eventKey: "production-event-42" }), /BLOCKED_NON_SYNTHETIC_VALIDATION_IDENTITY/);
  const syntheticKey = createSupervisedValidationEventKey("editor", "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(syntheticKey, "supervised-validation:editor_stage_validation:123e4567-e89b-42d3-a456-426614174000");

  assert.deepEqual(evaluateCloudflareFullEventEligibility({ routerEnabled: true, allRequiredStagesValidated: false, freeCapacityAvailable: true }), { eligible: false, reason: "REQUIRED_STAGES_NOT_VALIDATED" }, "8000 free Neurons do not bypass a missing Editor compatibility approval");
  assert.deepEqual(selectProviderForNewFullEvent({ routerEnabled: true, groqCapacityAvailable: false, cloudflareCapacityAvailable: true, cloudflareAllRequiredStagesValidated: false }), { provider: null, reason: "CLOUDFLARE_REQUIRED_STAGES_NOT_VALIDATED" });
  assert.deepEqual(selectProviderForNewFullEvent({ routerEnabled: true, groqCapacityAvailable: true, cloudflareCapacityAvailable: true, cloudflareAllRequiredStagesValidated: false }), { provider: "groq", reason: "GROQ_PREFERRED" });
  const fullyValidatedMatrix = Object.fromEntries(normalEventStages.map((stage) => [stage, { status: "REAL_VALIDATED" } ]));
  assert.equal(cloudflareAllRequiredStagesValidated(fullyValidatedMatrix), true);
  assert.deepEqual(getCloudflareActivationGateState({ matrix: fullyValidatedMatrix }), {
    technicalAllStagesValidated: true,
    semanticQualityGateValidated: false,
    capacityProductionReady: false,
    schedulerThroughputReady: false,
    freeOnlySafetyValidated: false,
    productionRoutingEnabled: false,
  });
  const unapprovedParallelReadiness = getCloudflareActivationGateState({ schedulerThroughputReady: true, maxConcurrentGroqEvents: 2 });
  assert.equal(unapprovedParallelReadiness.schedulerThroughputReady, false, "scheduler readiness cannot be true with parallel Groq events unapproved");
  assert.deepEqual(evaluateGroqSchedulerThroughputReadiness({ proposedReady: true, maxConcurrentGroqEvents: 2 }), { schedulerThroughputReady: false, reason: "GROQ_RPM_CONCURRENCY_NOT_APPROVED" });
  assert.deepEqual(evaluateGroqSchedulerThroughputReadiness({ proposedReady: true, maxConcurrentGroqEvents: 1 }), { schedulerThroughputReady: true, reason: "READY" });
  const fullyApprovedGates = {
    semanticQualityGateValidated: true,
    capacityProductionReady: true,
    schedulerThroughputReady: true,
    freeOnlySafetyValidated: true,
    productionRoutingEnabled: true,
  };
  assert.deepEqual(evaluateCloudflareFullEventEligibility({ routerEnabled: true, allRequiredStagesValidated: true, freeCapacityAvailable: true, activationGates: fullyApprovedGates }), { eligible: true, reason: "ELIGIBLE" });
  for (const [gate, expectedReason] of [
    ["semanticQualityGateValidated", "SEMANTIC_QUALITY_NOT_VALIDATED"],
    ["capacityProductionReady", "CAPACITY_PRODUCTION_NOT_READY"],
    ["schedulerThroughputReady", "SCHEDULER_THROUGHPUT_NOT_READY"],
    ["freeOnlySafetyValidated", "FREE_ONLY_SAFETY_NOT_VALIDATED"],
    ["productionRoutingEnabled", "PRODUCTION_ROUTING_DISABLED"],
  ]) {
    const activationGates = { ...fullyApprovedGates, [gate]: false };
    assert.deepEqual(evaluateCloudflareFullEventEligibility({ routerEnabled: true, allRequiredStagesValidated: true, freeCapacityAvailable: true, activationGates }), { eligible: false, reason: expectedReason }, `${gate} blocks Cloudflare independently`);
    assert.deepEqual(selectProviderForNewFullEvent({ routerEnabled: true, groqCapacityAvailable: false, cloudflareCapacityAvailable: true, cloudflareAllRequiredStagesValidated: true, cloudflareActivationGates: activationGates }), { provider: null, reason: `CLOUDFLARE_${expectedReason}` });
  }

  const { buildCloudflareStageCapacityReport } = await import("../lib/agents/runtime/cloudflare-stage-capacity.ts");
  const report = buildCloudflareStageCapacityReport();
  assert.equal(report.stages.length, 6);
  assert.deepEqual(report.stages.map(({ stage }) => stage), normalEventStages);
  assert.ok(report.stages.every((stage) => stage.maxOutputTokens === 1200));
  assert.ok(report.stages.every((stage) => Number.isInteger(stage.productionMaxRetries) && stage.productionMaxRetries <= 2));
  assert.ok(report.stages.every((stage) => stage.cloudflareRequestTokenField === "max_tokens"));
  for (const stage of report.stages) {
    assert.equal(stage.estimatedInputTokens, Math.ceil((stage.promptChars + stage.fixtureInputChars + stage.strictSchemaChars) / 2) + 128);
    assert.equal(stage.reservationNeurons, estimateCloudflareNeurons({
      inputTokens: stage.estimatedInputTokens,
      outputTokens: stage.maxOutputTokens,
      ...readCloudflareNeuronRates(process.env, SUPERVISED_VALIDATION_MODEL),
    }));
  }
  const reservationSum = report.stages.reduce((sum, stage) => sum + stage.reservationNeurons, 0);
  assert.equal(report.conservativeFullEventReservationEstimate, reservationSum);
  assert.equal(report.cleanDayConservativeAdmissionCapacity, Math.floor(report.softNeuronCap / reservationSum));
  assert.equal(report.tenFullCloudflareEvents.reservationNeurons, reservationSum * 10);
  assert.equal(report.tenFullCloudflareEvents.result, reservationSum * 10 <= report.softNeuronCap ? "PASS" : "FAIL_CAPACITY_BY_RESERVATION");
  assert.equal(report.observedFullEventNeuronEstimate, "INSUFFICIENT_SAMPLE");
  assert.equal(report.historicalCriticObservation.postResponseEstimateNeurons, 73);
  assert.equal(report.historicalCriticObservation.actualProviderNeurons, null);
  assert.ok(Math.abs(report.historicalCriticObservation.reservationOverheadRatio - 482 / 73) < 0.000001);
  assert.deepEqual(report.mixedRoutingPolicySimulation, {
    eventCount: 10,
    cloudflareFreeCapacityAssumedNeurons: 8000,
    allRequiredStagesValidated: true,
    groqAssumedAvailable: true,
    groqAssignments: 10,
    cloudflareAssignments: 0,
    result: "PASS_POLICY_ONLY",
  });
  assert.deepEqual(report.blockedCloudflareSecondarySimulation, {
    eventCount: 10,
    cloudflareFreeCapacityAssumedNeurons: 8000,
    groqAssumedAvailable: false,
    cloudflareAssignments: 0,
    blockedEvents: 10,
    result: "PASS_FAIL_CLOSED",
  });

  const stageConfigs = await Promise.all([
    import("../lib/agents/verifier/verifier-agent.ts"),
    import("../lib/agents/translator/translator-agent.ts"),
    import("../lib/agents/editor/editor-v2-agent.ts"),
    import("../lib/agents/classifier/classifier-agent.ts"),
    import("../lib/agents/ranker/ranker-agent.ts"),
    import("../lib/agents/critic/critic-agent.ts"),
  ]);
  const configGetters = ["getVerifierModelConfig", "getTranslatorModelConfig", "getEditorV2ModelConfig", "getClassifierModelConfig", "getRankerModelConfig", "getCriticModelConfig"];
  const configs = stageConfigs.map((module, index) => module[configGetters[index]]());
  assert.deepEqual(configs.map((config) => config.maxOutputTokens), report.stages.map((stage) => stage.maxOutputTokens));

  const fakeAccount = "1234567890abcdef1234567890abcdef";
  const provider = new CloudflareWorkersAIModelProvider(fakeAccount, "offline-fixture-token", async (_url, init) => {
    const body = JSON.parse(init?.body?.toString() ?? "{}");
    const configIndex = requests++;
    assert.equal(body.model, SUPERVISED_VALIDATION_MODEL);
    assert.equal(body.max_tokens, configs[configIndex].maxOutputTokens, `${normalEventStages[configIndex]} maps its configured limit to Cloudflare max_tokens`);
    assert.equal(Object.hasOwn(body, "max_completion_tokens"), false);
    return new Response(JSON.stringify({ model: SUPERVISED_VALIDATION_MODEL, choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
  }, SUPERVISED_VALIDATION_MODEL);
  let requests = 0;
  const echoSchema = z.object({ ok: z.literal(true) }).strict();
  for (let index = 0; index < normalEventStages.length; index += 1) {
    await provider.generateStructured({
      systemInstructions: "offline mock only",
      input: { stage: normalEventStages[index], fixture: true },
      schema: echoSchema,
      schemaName: "OfflineFixture",
      config: { ...configs[index], model: SUPERVISED_VALIDATION_MODEL, maxRetries: 0, structuredOutputMode: "json_object" },
      onRequestDispatched: () => undefined,
    });
  }
  assert.equal(requests, 6, "six adapter checks used mock fetch only; no provider inference occurred");
  console.log("cloudflare:stage:unit: OK (offline fixtures and mock transport; 0 provider inference)");
} finally {
  for (const name of envNames) {
    if (oldEnv[name] === undefined) delete process.env[name];
    else process.env[name] = oldEnv[name];
  }
}
