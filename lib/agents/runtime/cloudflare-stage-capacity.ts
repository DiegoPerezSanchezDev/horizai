import { verificationResultSchema } from "../contracts/index.ts";
import { buildClassifierModelInput } from "../classifier/classifier-input.ts";
import { classifierFixtureRegistry, classifierFixtures } from "../classifier/classifier-fixtures.ts";
import { classifierGenerationSchema } from "../classifier/classifier-types.ts";
import { getClassifierModelConfig } from "../classifier/classifier-agent.ts";
import { criticCurrentGenerationSchema } from "../critic/critic-types.ts";
import { canonicalCriticInput } from "../critic/critic-fixtures.ts";
import { buildCriticModelInput } from "../critic/critic-input.ts";
import { getCriticModelConfig } from "../critic/critic-agent.ts";
import { editorGenerationSchema } from "../editor/editor-generation.ts";
import { canonicalEditorInput } from "../editor/editor-fixtures.ts";
import { buildEditorModelInput } from "../editor/editor-input.ts";
import { getEditorV2ModelConfig } from "../editor/editor-v2-agent.ts";
import { rankerFixtures } from "../ranker/ranker-fixtures.ts";
import { rankerGenerationSchema, rankerInputSchema } from "../ranker/ranker-types.ts";
import { getRankerModelConfig } from "../ranker/ranker-agent.ts";
import { estimateCloudflareNeurons, readCloudflareNeuronRates, readProviderCapacityConfig } from "./free-provider-router.ts";
import { toStrictProviderJsonSchema } from "./strict-json-schema.ts";
import { translatorGenerationSchema } from "../translator/translator-generation.ts";
import { buildTranslatorModelInput } from "../translator/translator-input.ts";
import { canonicalTranslatorInput } from "../translator/translator-input-fixtures.ts";
import { getTranslatorModelConfig } from "../translator/translator-agent.ts";
import { createVerifierInputFixture } from "../verifier/verifier-fixtures.ts";
import { buildVerifierModelInput } from "../verifier/verifier-input-builder.ts";
import { getVerifierModelConfig, verifierSystemInstructions } from "../verifier/verifier-agent.ts";
import { translatorSystemInstructions } from "../translator/translator-prompt.ts";
import { editorV2SystemInstructions } from "../editor/editor-v2-prompt.ts";
import { classifierSystemInstructions } from "../classifier/classifier-prompt.ts";
import { rankerSystemInstructions } from "../ranker/ranker-prompt.ts";
import { criticSystemInstructions } from "../critic/critic-prompt.ts";
import { CLOUDFLARE_LLAMA_VALIDATION_MODEL } from "./provider-cost-policy.ts";
import { normalEventStages, type NormalEventStage } from "./event-model-stages.ts";
import { cloudflareAllRequiredStagesValidated, selectProviderForNewFullEvent } from "./cloudflare-stage-validation.ts";

function verifierInputCharacterLimit(): number {
  const configured = process.env.AGENT_MAX_INPUT_CHARS?.trim();
  const value = configured ? Number(configured) : 12_000;
  if (!Number.isInteger(value) || value < 2 || value > 12_000) throw new Error("AGENT_MAX_INPUT_CHARS must be an integer between 2 and 12000 for the canonical two-source fixture");
  return value;
}

export type CloudflareStageCapacityEstimate = {
  stage: NormalEventStage;
  agentVersion: string;
  fixture: string;
  fixtureInputChars: number;
  promptChars: number;
  strictSchemaChars: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  productionMaxRetries: number;
  cloudflareRequestTokenField: "max_tokens";
  reservationNeurons: number;
};

function stageEstimate(input: {
  stage: NormalEventStage;
  agentVersion: string;
  fixture: string;
  modelInput: unknown;
  systemInstructions: string;
  schema: Parameters<typeof toStrictProviderJsonSchema>[0];
  maxOutputTokens: number;
  productionMaxRetries: number;
}): CloudflareStageCapacityEstimate {
  const fixtureInputChars = JSON.stringify(input.modelInput).length;
  const strictSchemaChars = JSON.stringify(toStrictProviderJsonSchema(input.schema)).length;
  // Reuses the established conservative fixture estimate: chars / 2 + 128 framing tokens.
  const estimatedInputTokens = Math.ceil((input.systemInstructions.length + fixtureInputChars + strictSchemaChars) / 2) + 128;
  const rates = readCloudflareNeuronRates(process.env, CLOUDFLARE_LLAMA_VALIDATION_MODEL);
  return {
    stage: input.stage,
    agentVersion: input.agentVersion,
    fixture: input.fixture,
    fixtureInputChars,
    promptChars: input.systemInstructions.length,
    strictSchemaChars,
    estimatedInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    productionMaxRetries: input.productionMaxRetries,
    cloudflareRequestTokenField: "max_tokens",
    reservationNeurons: estimateCloudflareNeurons({ inputTokens: estimatedInputTokens, outputTokens: input.maxOutputTokens, ...rates }),
  };
}

export function buildCloudflareStageCapacityReport(): {
  model: typeof CLOUDFLARE_LLAMA_VALIDATION_MODEL;
  inputEstimator: string;
  neuronRates: ReturnType<typeof readCloudflareNeuronRates>;
  dailyNeuronAllocation: number;
  softLimitRatio: number;
  softNeuronCap: number;
  stages: CloudflareStageCapacityEstimate[];
  conservativeFullEventReservationEstimate: number;
  cleanDayConservativeAdmissionCapacity: number;
  tenFullCloudflareEvents: { reservationNeurons: number; softCapNeurons: number; result: "PASS" | "FAIL_CAPACITY_BY_RESERVATION" };
  observedFullEventNeuronEstimate: "INSUFFICIENT_SAMPLE";
  historicalCriticObservation: { reservedNeurons: 482; postResponseEstimateNeurons: number; inputTokens: 2070; outputTokens: 7; actualProviderNeurons: null; reservationOverheadRatio: number };
  mixedRoutingPolicySimulation: { eventCount: 10; cloudflareFreeCapacityAssumedNeurons: 8000; allRequiredStagesValidated: boolean; groqAssumedAvailable: true; groqAssignments: number; cloudflareAssignments: number; result: "PASS_POLICY_ONLY" };
  blockedCloudflareSecondarySimulation: { eventCount: 10; cloudflareFreeCapacityAssumedNeurons: 8000; groqAssumedAvailable: false; cloudflareAssignments: number; blockedEvents: number; result: "PASS_FAIL_CLOSED" };
} {
  const verifierConfig = getVerifierModelConfig();
  const translatorConfig = getTranslatorModelConfig();
  const editorConfig = getEditorV2ModelConfig();
  const classifierConfig = getClassifierModelConfig();
  const rankerConfig = getRankerModelConfig();
  const criticConfig = getCriticModelConfig();

  const verifierBuilt = buildVerifierModelInput(createVerifierInputFixture("confirmed", 2), verifierInputCharacterLimit());
  const translatorBuilt = buildTranslatorModelInput(canonicalTranslatorInput);
  const editorBuilt = buildEditorModelInput(canonicalEditorInput);
  const classifierFixture = classifierFixtures[0];
  const classifierBuilt = buildClassifierModelInput(classifierFixture.input, {
    regionCodes: [...classifierFixtureRegistry.regions.keys()],
    categorySlugs: [...classifierFixtureRegistry.categories.keys()],
  });
  const rankerInput = rankerInputSchema.parse(rankerFixtures[0].input);
  const criticBuilt = buildCriticModelInput(canonicalCriticInput);

  const rates = readCloudflareNeuronRates(process.env, CLOUDFLARE_LLAMA_VALIDATION_MODEL);
  const stages = [
    stageEstimate({ stage: "verifier", agentVersion: "verifier-v1", fixture: "verifier:unit:confirmed-two-source", modelInput: verifierBuilt.input, systemInstructions: verifierSystemInstructions, schema: verificationResultSchema, maxOutputTokens: verifierConfig.maxOutputTokens, productionMaxRetries: verifierConfig.maxRetries }),
    stageEstimate({ stage: "translator", agentVersion: "translator-v1", fixture: "translator:unit:gpt-5-launch-2026", modelInput: translatorBuilt.input, systemInstructions: translatorSystemInstructions, schema: translatorGenerationSchema, maxOutputTokens: translatorConfig.maxOutputTokens, productionMaxRetries: translatorConfig.maxRetries }),
    stageEstimate({ stage: "editor", agentVersion: "editor-v2", fixture: "editor:canonical-editor-input", modelInput: editorBuilt.input, systemInstructions: editorV2SystemInstructions, schema: editorGenerationSchema, maxOutputTokens: editorConfig.maxOutputTokens, productionMaxRetries: editorConfig.maxRetries }),
    stageEstimate({ stage: "classifier", agentVersion: "classifier-v1", fixture: "classifier:fixture-new-openai-model", modelInput: classifierBuilt.input, systemInstructions: classifierSystemInstructions, schema: classifierGenerationSchema, maxOutputTokens: classifierConfig.maxOutputTokens, productionMaxRetries: classifierConfig.maxRetries }),
    stageEstimate({ stage: "ranker", agentVersion: "ranker-v1", fixture: "ranker:confirmed-launch", modelInput: rankerInput, systemInstructions: rankerSystemInstructions, schema: rankerGenerationSchema, maxOutputTokens: rankerConfig.maxOutputTokens, productionMaxRetries: rankerConfig.maxRetries }),
    stageEstimate({ stage: "critic", agentVersion: "critic-v3", fixture: "critic:canonical-pass-fixture", modelInput: criticBuilt.input, systemInstructions: criticSystemInstructions, schema: criticCurrentGenerationSchema, maxOutputTokens: criticConfig.maxOutputTokens, productionMaxRetries: criticConfig.maxRetries }),
  ];

  if (stages.length !== normalEventStages.length || stages.some((stage, index) => stage.stage !== normalEventStages[index])) throw new Error("Cloudflare stage capacity report does not cover the normal event stage set");
  const capacity = readProviderCapacityConfig("cloudflare_workers_ai", process.env);
  const dailyNeuronAllocation = capacity.dailyNeuronAllocation ?? 0;
  if (!Number.isSafeInteger(dailyNeuronAllocation) || dailyNeuronAllocation < 1) throw new Error("CLOUDFLARE_DAILY_NEURON_LIMIT must be configured for offline capacity estimation");
  const conservativeFullEventReservationEstimate = stages.reduce((total, stage) => total + stage.reservationNeurons, 0);
  const softNeuronCap = Math.floor(dailyNeuronAllocation * capacity.softLimitRatio);
  const allRequiredStagesValidated = cloudflareAllRequiredStagesValidated();
  const mixedAssignments = Array.from({ length: 10 }, () => selectProviderForNewFullEvent({
    routerEnabled: true, groqCapacityAvailable: true, cloudflareCapacityAvailable: true, cloudflareAllRequiredStagesValidated: allRequiredStagesValidated,
  }));
  // Keep this policy simulation explicitly unvalidated even after the real matrix reaches 6/6.
  const blockedSecondary = Array.from({ length: 10 }, () => selectProviderForNewFullEvent({
    routerEnabled: true, groqCapacityAvailable: false, cloudflareCapacityAvailable: true, cloudflareAllRequiredStagesValidated: false,
  }));
  const historicalCriticPostResponseEstimate = estimateCloudflareNeurons({
    inputTokens: 2_070, outputTokens: 7, ...rates,
  });
  if (!mixedAssignments.every((assignment) => assignment.provider === "groq")) throw new Error("Mixed-route policy simulation allowed an unexpected provider assignment");
  if (!blockedSecondary.every((assignment) => assignment.provider === null)) throw new Error("Cloudflare secondary simulation did not fail closed for unvalidated stages");
  return {
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    inputEstimator: "ceil((systemPromptChars + JSON input chars + strict JSON schema chars) / 2) + 128; approximate, not tokenizer-exact",
    neuronRates: rates,
    dailyNeuronAllocation,
    softLimitRatio: capacity.softLimitRatio,
    softNeuronCap,
    stages,
    conservativeFullEventReservationEstimate,
    cleanDayConservativeAdmissionCapacity: Math.floor(softNeuronCap / conservativeFullEventReservationEstimate),
    tenFullCloudflareEvents: {
      reservationNeurons: conservativeFullEventReservationEstimate * 10,
      softCapNeurons: softNeuronCap,
      result: conservativeFullEventReservationEstimate * 10 <= softNeuronCap ? "PASS" : "FAIL_CAPACITY_BY_RESERVATION",
    },
    observedFullEventNeuronEstimate: "INSUFFICIENT_SAMPLE",
    historicalCriticObservation: {
      reservedNeurons: 482,
      postResponseEstimateNeurons: historicalCriticPostResponseEstimate,
      inputTokens: 2_070,
      outputTokens: 7,
      actualProviderNeurons: null,
      reservationOverheadRatio: 482 / historicalCriticPostResponseEstimate,
    },
    mixedRoutingPolicySimulation: {
      eventCount: 10,
      cloudflareFreeCapacityAssumedNeurons: 8_000,
      allRequiredStagesValidated,
      groqAssumedAvailable: true,
      groqAssignments: mixedAssignments.filter((assignment) => assignment.provider === "groq").length,
      cloudflareAssignments: mixedAssignments.filter((assignment) => assignment.provider === "cloudflare_workers_ai").length,
      result: "PASS_POLICY_ONLY",
    },
    blockedCloudflareSecondarySimulation: {
      eventCount: 10,
      cloudflareFreeCapacityAssumedNeurons: 8_000,
      groqAssumedAvailable: false,
      cloudflareAssignments: blockedSecondary.filter((assignment) => assignment.provider === "cloudflare_workers_ai").length,
      blockedEvents: blockedSecondary.filter((assignment) => assignment.provider === null).length,
      result: "PASS_FAIL_CLOSED",
    },
  };
}
