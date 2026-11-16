import assert from "node:assert/strict";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { AgentError, AgentTimeoutError, FreeTierLimitReachedError, getProviderDiagnostics, PermanentProviderError, StructuredOutputError, TransientProviderError } from "../lib/agents/runtime/agent-errors.ts";
import { MockModelProvider, OpenAICompatibleModelProvider } from "../lib/agents/runtime/model-provider.ts";
import { DailyRequestBudget } from "../lib/agents/runtime/request-budget.ts";
import { toStrictProviderJsonSchema } from "../lib/agents/runtime/strict-json-schema.ts";
import { getTranslatorModelConfig, TranslatorAgent, translatorGenerationSchema, translatorSystemInstructions } from "../lib/agents/translator/translator-agent.ts";
import { translationResultSchema } from "../lib/agents/contracts/index.ts";
import { canonicalTranslationResultFixture, canonicalTranslatorGenerationFixture, translatorGenerationShapeExample } from "../lib/agents/translator/translator-fixtures.ts";
import { summarizeZodIssue } from "../lib/agents/runtime/structured-output.ts";
import { translatorCheckpointSchema } from "../lib/agents/translator/translator-checkpoint.ts";
import { buildTranslatorModelInput } from "../lib/agents/translator/translator-input.ts";
import { canonicalTranslatorInput } from "../lib/agents/translator/translator-input-fixtures.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";

function inputFixture() { return structuredClone(canonicalTranslatorInput); }

function outputFixture(input) {
  return {
    schemaVersion: 1,
    eventKey: input.event.eventKey,
    sourceLanguage: "en",
    targetLanguage: "es",
    translatedTitle: "OpenAI lanza GPT-5",
    translatedFacts: [
      {
        sourceText: "OpenAI launched GPT-5 with 128K tokens and a $4.2 billion investment.",
        translatedText: "OpenAI lanzó GPT-5 con 128K tokens y una inversión de $4.2 billion.",
        sourceItemId: "candidate-1",
      },
      {
        sourceText: "The company may expand access next quarter.",
        translatedText: "La empresa podría ampliar el acceso el próximo trimestre.",
        sourceItemId: "candidate-1",
      },
    ],
    translatedSourceMaterial: "Hecho: OpenAI lanzó GPT-5 con 128K tokens y una inversión de $4.2 billion. Incertidumbre: la empresa podría ampliar el acceso el próximo trimestre. Contradicción: la fecha de lanzamiento es discutida.",
    preservedNames: ["OpenAI", "GPT-5"],
    translationNotes: ["Se conserva la incertidumbre expresada por could/may.", "La contradicción se mantiene sin resolver."],
  };
}

function generationFixture(input) {
  return {
    translatedTitle: "OpenAI anuncia GPT-5",
    factTranslations: input.verification.verifiedFacts.map((_, factIndex) => ({
      factIndex,
      translatedText: factIndex === 0
        ? "OpenAI anunció GPT-5 con 128K tokens y una inversión de $4.2 billion."
        : `Traducción del hecho ${factIndex}.`,
    })),
    translatedSourceMaterial: "Hecho: OpenAI anunció GPT-5 con 128K tokens y una inversión de $4.2 billion. Incertidumbre: la empresa podría ampliar el acceso el próximo trimestre. Contradicción: la fecha de lanzamiento es discutida.",
    preservedNames: ["OpenAI", "GPT-5"],
    translationNotes: ["Se conserva la incertidumbre y la contradicción sin resolver."],
  };
}

function inputWithFacts(count) {
  const base = inputFixture();
  return {
    ...base,
    verification: {
      ...base.verification,
      verifiedFacts: Array.from({ length: count }, (_, index) => ({
        claim: [
          "OpenAI anunció GPT-5 con 128K tokens y una inversión de $4.2 billion.",
          "El nombre GPT-5.6 aparece en la documentación técnica.",
          "La URL https://example.com/a?x=1 contiene comillas \"dobles\", saltos de línea y Unicode: ñ.",
        ][index] ?? `Hecho adicional ${index}: 50%; el texto contiene dos puntos y punto y coma.`,
        sourceIds: [sourceId],
      })),
    },
  };
}

const config = {
  model: "fixture-translator-model",
  timeoutMs: 100,
  maxRetries: 2,
  retryBackoffMs: 0,
  dailyRequestLimit: 20,
  maxOutputTokens: 1200,
  failOnRateLimit: true,
  allowPaidFallback: false,
  structuredOutputMode: "strict_schema",
  reasoningEffort: "low",
  includeReasoning: false,
};

const bestEffortConfig = { ...config, structuredOutputMode: "best_effort_schema" };

const freshOptions = (modelConfig = config) => ({ modelConfig, requestBudget: new DailyRequestBudget() });
const compatibleMockProvider = () => new OpenAICompatibleModelProvider("https://groq.example/openai/v1", "test-key", { providerId: "mock" });

const strictTranslationSchema = toStrictProviderJsonSchema(translationResultSchema);
assert.equal(strictTranslationSchema.additionalProperties, false);
assert.deepEqual(strictTranslationSchema.required, [
  "schemaVersion",
  "eventKey",
  "sourceLanguage",
  "targetLanguage",
  "translatedTitle",
  "translatedFacts",
  "translatedSourceMaterial",
  "preservedNames",
  "translationNotes",
]);

const strictGenerationSchema = toStrictProviderJsonSchema(translatorGenerationSchema);
assert.equal(strictGenerationSchema.additionalProperties, false);
assert.deepEqual(strictGenerationSchema.required, [
  "translatedTitle",
  "factTranslations",
  "translatedSourceMaterial",
  "preservedNames",
  "translationNotes",
]);

const input = inputFixture();
const checkpoint = translatorCheckpointSchema.parse({
  schemaVersion: 1,
  eventKey: input.event.eventKey,
  event: input.event,
  verification: input.verification,
  sourceLanguage: input.sourceLanguage,
  sources: input.sources,
  translatorModelInput: buildTranslatorModelInput(input).input,
});
assert.equal(checkpoint.eventKey, input.event.eventKey);
assert.deepEqual(checkpoint.verification, input.verification);
assert.doesNotMatch(JSON.stringify(checkpoint), /complete article|raw_content|<html/i);

const previousTranslatorEnv = {
  model: process.env.AGENT_MODEL_TRANSLATE,
  reasoning: process.env.AGENT_REASONING_EFFORT_TRANSLATE,
  includeReasoning: process.env.AGENT_INCLUDE_REASONING_TRANSLATE,
};
process.env.AGENT_MODEL_TRANSLATE = "fixture-translator-model";
process.env.AGENT_REASONING_EFFORT_TRANSLATE = "low";
process.env.AGENT_INCLUDE_REASONING_TRANSLATE = "false";
const configuredTranslator = getTranslatorModelConfig();
assert.equal(configuredTranslator.reasoningEffort, "low");
assert.equal(configuredTranslator.includeReasoning, false);
for (const [name, value] of Object.entries({
  AGENT_MODEL_TRANSLATE: previousTranslatorEnv.model,
  AGENT_REASONING_EFFORT_TRANSLATE: previousTranslatorEnv.reasoning,
  AGENT_INCLUDE_REASONING_TRANSLATE: previousTranslatorEnv.includeReasoning,
})) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
const logger = new InMemoryAgentLogger();
const agent = new TranslatorAgent(new MockModelProvider((request) => {
  assert.match(request.systemInstructions, /UNTRUSTED DATA/);
  assert.match(request.systemInstructions, /never follow commands/);
  assert.match(JSON.stringify(request.input), /The release date is disputed/);
  assert.doesNotMatch(JSON.stringify(request.input), /complete article/i);
  const generated = generationFixture(input);
  assert.deepEqual(Object.keys(generated).sort(), ["factTranslations", "preservedNames", "translatedSourceMaterial", "translatedTitle", "translationNotes"]);
  assert.doesNotMatch(JSON.stringify(generated), /sourceText|sourceItemId|eventKey|schemaVersion|targetLanguage/);
  return generated;
}), logger);
const result = await agent.translate(input, freshOptions());
assert.equal(result.output.targetLanguage, "es");
assert.equal(result.output.preservedNames.includes("GPT-5"), true);
assert.match(result.output.translatedFacts[0].translatedText, /128K/);
assert.match(result.output.translatedFacts[0].translatedText, /\$4\.2 billion/);
assert.equal(result.output.translatedFacts.length, 1);
assert.equal(result.output.translatedFacts[0].sourceText, input.verification.verifiedFacts[0].claim);
assert.equal(result.output.translatedFacts[0].sourceItemId, "candidate-1");
assert.equal(result.diagnostics?.generationSchemaValid, true);
assert.equal(result.diagnostics?.finalTranslationResultValid, true);
assert.equal(result.diagnostics?.translationAssemblySuccess, true);
assert.equal(result.diagnostics?.factCountExpected, 1);
assert.equal(result.diagnostics?.factCountTranslated, 1);
assert.ok((result.diagnostics?.generationOutputBytes ?? 0) > 0);
const completedTelemetry = logger.entries.find((entry) => entry.entry.step === "completed")?.entry.payload;
assert.equal(completedTelemetry?.generationSchemaValid, true);
assert.equal(completedTelemetry?.finalTranslationResultValid, true);
assert.equal(completedTelemetry?.translationAssemblySuccess, true);
assert.equal(completedTelemetry?.factCountExpected, 1);
assert.equal(completedTelemetry?.factCountTranslated, 1);
assert.match(result.output.translatedSourceMaterial, /Contradicción/);
assert.equal(result.attempts, 1);

const invalidOutput = new TranslatorAgent(new MockModelProvider(() => ({ ...generationFixture(input), targetLanguage: "en" })), new InMemoryAgentLogger());
await assert.rejects(() => invalidOutput.translate(input, freshOptions()), StructuredOutputError);

for (const field of ["translatedSourceMaterial", "preservedNames", "translationNotes"]) {
  const incomplete = { ...generationFixture(input) };
  delete incomplete[field];
  const missingFieldAgent = new TranslatorAgent(new MockModelProvider(() => incomplete), new InMemoryAgentLogger());
  await assert.rejects(() => missingFieldAgent.translate(input, freshOptions()), StructuredOutputError);
}
const emptyArrays = { ...outputFixture(input), preservedNames: [], translationNotes: [] };
assert.equal(translationResultSchema.safeParse(emptyArrays).success, true);
assert.equal(translationResultSchema.safeParse(outputFixture(input)).success, true);
assert.doesNotThrow(() => translationResultSchema.parse(canonicalTranslationResultFixture));
assert.doesNotThrow(() => translatorGenerationSchema.parse(canonicalTranslatorGenerationFixture));
assert.equal(translatorGenerationSchema.safeParse(JSON.parse(translatorGenerationShapeExample)).success, true);
assert.match(translatorSystemInstructions, /factTranslations must contain exactly one object per verifiedFact/);
assert.match(translatorSystemInstructions, /Do not repeat sourceText or sourceItemId/);
assert.match(translatorSystemInstructions, /preservedNames must be an array of up to 100 unique trimmed strings/);
assert.match(translatorSystemInstructions, /translationNotes must be an array of up to 30 unique trimmed strings/);
const truncatedAgent = new TranslatorAgent(new MockModelProvider(() => ({ ...generationFixture(input), translatedSourceMaterial: "" })), new InMemoryAgentLogger());
await assert.rejects(() => truncatedAgent.translate(input, freshOptions()), StructuredOutputError);

const rejectedInput = { ...input, verification: { ...input.verification, status: "rejected" } };
await assert.rejects(() => agent.translate(rejectedInput, freshOptions()));

let preconditionCalls = 0;
const emptyFactsAgent = new TranslatorAgent(new MockModelProvider(() => {
  preconditionCalls += 1;
  return generationFixture(input);
}), new InMemoryAgentLogger());
const emptyFactsInput = { ...input, verification: { ...input.verification, verifiedFacts: [] } };
await assert.rejects(
  () => emptyFactsAgent.translate(emptyFactsInput, freshOptions()),
  (error) => error instanceof AgentError && error.code === "translator_precondition_failed",
);
assert.equal(preconditionCalls, 0);

let timeoutCalls = 0;
const timeoutAgent = new TranslatorAgent(new MockModelProvider(async () => {
  timeoutCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, 30));
  return generationFixture(input);
}), new InMemoryAgentLogger());
await assert.rejects(() => timeoutAgent.translate(input, freshOptions({ ...config, timeoutMs: 5 })), AgentTimeoutError);
assert.equal(timeoutCalls, 3);

let retryCalls = 0;
const retryAgent = new TranslatorAgent(new MockModelProvider(() => {
  retryCalls += 1;
  if (retryCalls < 3) throw new TransientProviderError("temporary translator fixture failure");
  return generationFixture(input);
}), new InMemoryAgentLogger());
const retryResult = await retryAgent.translate(input, freshOptions());
assert.equal(retryResult.attempts, 3);

let bestEffortSchemaCalls = 0;
const bestEffortSchemaAgent = new TranslatorAgent(new MockModelProvider(() => {
  bestEffortSchemaCalls += 1;
  return bestEffortSchemaCalls === 1 ? { ...generationFixture(input), targetLanguage: "en" } : generationFixture(input);
}), new InMemoryAgentLogger());
const bestEffortSchemaResult = await bestEffortSchemaAgent.translate(input, freshOptions(bestEffortConfig));
assert.equal(bestEffortSchemaResult.attempts, 2);
assert.equal(bestEffortSchemaCalls, 2);

let bestEffortPermanentSchemaCalls = 0;
const bestEffortPermanentSchemaAgent = new TranslatorAgent(new MockModelProvider(() => {
  bestEffortPermanentSchemaCalls += 1;
  return { ...generationFixture(input), targetLanguage: "en" };
}), new InMemoryAgentLogger());
await assert.rejects(() => bestEffortPermanentSchemaAgent.translate(input, freshOptions(bestEffortConfig)), StructuredOutputError);
assert.equal(bestEffortPermanentSchemaCalls, 3);

let permanentCalls = 0;
const permanentAgent = new TranslatorAgent(new MockModelProvider(() => {
  permanentCalls += 1;
  throw new PermanentProviderError("definitive translator fixture failure");
}), new InMemoryAgentLogger());
await assert.rejects(() => permanentAgent.translate(input, freshOptions()), PermanentProviderError);
assert.equal(permanentCalls, 1);

let rateLimitCalls = 0;
const rateLimitAgent = new TranslatorAgent(new MockModelProvider(() => {
  rateLimitCalls += 1;
  throw new FreeTierLimitReachedError();
}), new InMemoryAgentLogger());
await assert.rejects(() => rateLimitAgent.translate(input, freshOptions()), FreeTierLimitReachedError);
assert.equal(rateLimitCalls, 1);

const budget = new DailyRequestBudget(() => new Date("2026-09-13T12:00:00Z"));
const budgetLogger = new InMemoryAgentLogger();
const budgetAgent = new TranslatorAgent(new MockModelProvider(() => generationFixture(input)), budgetLogger);
await budgetAgent.translate(input, { modelConfig: { ...config, dailyRequestLimit: 1 }, requestBudget: budget });
await assert.rejects(() => budgetAgent.translate(input, { modelConfig: { ...config, dailyRequestLimit: 1 }, requestBudget: budget }));
assert.equal(budgetLogger.entries.filter((entry) => entry.entry.step === "provider_request_reserved").length, 1);

const threeFactInput = inputWithFacts(3);
const threeFactGeneration = generationFixture(threeFactInput);
const threeFactResult = new TranslatorAgent(new MockModelProvider(() => threeFactGeneration), new InMemoryAgentLogger());
const assembledThreeFacts = await threeFactResult.translate(threeFactInput, freshOptions({ ...config, maxRetries: 0 }));
assert.deepEqual(assembledThreeFacts.output.translatedFacts.map((fact) => fact.sourceText), threeFactInput.verification.verifiedFacts.map((fact) => fact.claim));
assert.deepEqual(assembledThreeFacts.output.translatedFacts.map((fact) => fact.sourceItemId), ["candidate-1", "candidate-1", "candidate-1"]);
assert.equal(assembledThreeFacts.output.eventKey, threeFactInput.event.eventKey);
assert.equal(assembledThreeFacts.output.schemaVersion, 1);
assert.equal(assembledThreeFacts.output.targetLanguage, "es");
assert.equal(assembledThreeFacts.diagnostics?.factCountExpected, 3);
assert.equal(assembledThreeFacts.diagnostics?.factCountTranslated, 3);

const attributedInput = inputFixture();
const attributedSourceClaim = "Source A reports that Outlet B said Project X will launch in October.";
attributedInput.verification.verifiedFacts = [{ claim: attributedSourceClaim, sourceIds: [sourceId] }];
attributedInput.verification.uncertainClaims = [{ claim: "Project X will launch in October.", sourceIds: [sourceId] }];
const attributedGeneration = {
  ...generationFixture(attributedInput),
  translatedTitle: "Según Source A, Outlet B informó que el proyecto X llegaría en octubre",
  factTranslations: [{ factIndex: 0, translatedText: "Source A informa que Outlet B dijo que el proyecto X llegaría en octubre." }],
  translatedSourceMaterial: "Según Source A, Outlet B informó que el proyecto X llegaría en octubre; no hay confirmación independiente en el material suministrado.",
};
const attributedResult = await new TranslatorAgent(new MockModelProvider(() => attributedGeneration), new InMemoryAgentLogger()).translate(attributedInput, freshOptions({ ...config, maxRetries: 0 }));
assert.equal(attributedResult.output.translatedFacts[0].sourceText, attributedSourceClaim, "the exact attributed source claim is restored deterministically");
assert.match(attributedResult.output.translatedFacts[0].translatedText, /Outlet B/);
assert.match(attributedResult.output.translatedFacts[0].translatedText, /informa que/i);
assert.match(translatorSystemInstructions, /Preserve who reported what/i);

const nonexistentIndex = { ...threeFactGeneration, factTranslations: threeFactGeneration.factTranslations.map((item) => ({ ...item })), };
nonexistentIndex.factTranslations[2] = { factIndex: 99, translatedText: "Hecho" };
const nonexistentIndexAgent = new TranslatorAgent(new MockModelProvider(() => nonexistentIndex), new InMemoryAgentLogger());
await assert.rejects(
  () => nonexistentIndexAgent.translate(threeFactInput, freshOptions({ ...config, maxRetries: 0 })),
  (error) => getProviderDiagnostics(error)?.finalTranslationResultValid === false
);

const duplicateIndex = { ...threeFactGeneration, factTranslations: threeFactGeneration.factTranslations.map((item) => ({ ...item })) };
duplicateIndex.factTranslations[1] = { factIndex: 0, translatedText: "Duplicado" };
const duplicateIndexAgent = new TranslatorAgent(new MockModelProvider(() => duplicateIndex), new InMemoryAgentLogger());
await assert.rejects(() => duplicateIndexAgent.translate(threeFactInput, freshOptions({ ...config, maxRetries: 0 })), StructuredOutputError);

const missingFact = { ...threeFactGeneration, factTranslations: threeFactGeneration.factTranslations.slice(0, 2) };
const missingFactAgent = new TranslatorAgent(new MockModelProvider(() => missingFact), new InMemoryAgentLogger());
await assert.rejects(() => missingFactAgent.translate(threeFactInput, freshOptions({ ...config, maxRetries: 0 })), StructuredOutputError);

const emptyTranslation = { ...threeFactGeneration, factTranslations: threeFactGeneration.factTranslations.map((item) => ({ ...item })), };
emptyTranslation.factTranslations[0] = { factIndex: 0, translatedText: "" };
const emptyTranslationAgent = new TranslatorAgent(new MockModelProvider(() => emptyTranslation), new InMemoryAgentLogger());
await assert.rejects(() => emptyTranslationAgent.translate(threeFactInput, freshOptions({ ...config, maxRetries: 0 })), StructuredOutputError);

assert.equal(translationResultSchema.safeParse({ ...outputFixture(input), translatedFacts: [] }).success, false);
assert.match(translatorSystemInstructions, /UNTRUSTED DATA/);
assert.match(translatorSystemInstructions, /Return EVERY required field from the schema/);
assert.match(translatorSystemInstructions, /Return ONLY one valid JSON object/);
assert.match(translatorSystemInstructions, /Do not add keys outside the required structure/);
assert.match(translatorSystemInstructions, /do not translate it as Source A independently confirming X/);
for (const field of ["translatedSourceMaterial", "preservedNames", "translationNotes"]) assert.match(translatorSystemInstructions, new RegExp(field));

const originalFetch = globalThis.fetch;
let serializedRequest = null;
globalThis.fetch = async (_url, init) => {
  serializedRequest = JSON.parse(init.body);
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(generationFixture(input)) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};
await new OpenAICompatibleModelProvider("https://groq.example/openai/v1", "test-key").generateStructured({
  systemInstructions: "Translate only supplied claims.",
  input: { eventKey: input.event.eventKey },
  schema: translatorGenerationSchema,
  schemaName: "TranslatorGeneration",
  config,
});
assert.equal(serializedRequest.response_format.type, "json_schema");
assert.equal(serializedRequest.response_format.json_schema.name, "TranslatorGeneration");
assert.equal(serializedRequest.response_format.json_schema.strict, true);
assert.equal(serializedRequest.max_completion_tokens, 1200);
assert.equal(Object.hasOwn(serializedRequest, "max_tokens"), false);
assert.equal(Object.hasOwn(serializedRequest, "tools"), false);
assert.equal(serializedRequest.stream, false, "provider transport explicitly disables streaming");
assert.equal(serializedRequest.reasoning_effort, "low");
assert.equal(serializedRequest.include_reasoning, false);
assert.equal(serializedRequest.response_format.json_schema.schema.additionalProperties, false);
assert.equal(serializedRequest.response_format.json_schema.schema.required.length, 5);

serializedRequest = null;
await new OpenAICompatibleModelProvider("https://groq.example/openai/v1", "test-key").generateStructured({
  systemInstructions: "Translate only supplied claims.",
  input: { eventKey: input.event.eventKey },
  schema: translatorGenerationSchema,
  schemaName: "TranslatorGeneration",
  config: bestEffortConfig,
});
assert.equal(serializedRequest.response_format.type, "json_schema");
assert.equal(serializedRequest.response_format.json_schema.strict, false);
assert.ok(serializedRequest.response_format.json_schema.schema);

serializedRequest = null;
await new OpenAICompatibleModelProvider("https://groq.example/openai/v1", "test-key").generateStructured({
  systemInstructions: "Translate only supplied claims.",
  input: { eventKey: input.event.eventKey },
  schema: translatorGenerationSchema,
  schemaName: "TranslatorGeneration",
  config: { ...bestEffortConfig, structuredOutputMode: "json_object" },
});
assert.equal(serializedRequest.response_format.type, "json_object");
assert.equal(Object.hasOwn(serializedRequest.response_format, "json_schema"), false);

globalThis.fetch = async () => new Response(JSON.stringify({
  error: {
    message: "Failed to generate JSON",
    type: "invalid_request_error",
    code: "failed_generation",
    failed_generation: { error: "missing required fields", translatedTitle: "secret generated text must not be retained" },
  },
}), { status: 400 });
await assert.rejects(
  () => new OpenAICompatibleModelProvider("https://groq.example/openai/v1", "test-key").generateStructured({
    systemInstructions: "Translate only supplied claims.",
    input: { eventKey: input.event.eventKey },
    schema: translatorGenerationSchema,
    schemaName: "TranslatorGeneration",
    config,
  }),
  (error) => {
    const diagnostics = getProviderDiagnostics(error);
    assert.equal(diagnostics?.failureKind, "PROVIDER_HTTP_ERROR");
    assert.equal(diagnostics?.failedGenerationPresent, true);
    assert.equal(diagnostics?.failedGenerationType, "object");
    assert.equal(diagnostics?.failedGenerationJsonParseable, true);
    assert.deepEqual(diagnostics?.failedGenerationTopLevelFields, ["error", "translatedTitle"]);
    assert.equal(diagnostics?.failedGenerationReason, "missing_required_fields");
    assert.ok((diagnostics?.failedGenerationMissingRequiredFields?.length ?? 0) > 0);
    assert.ok(!JSON.stringify(diagnostics).includes("secret generated text"));
    return true;
  }
);

const invalidNestedOutput = { ...generationFixture(input), factTranslations: [{ factIndex: 0, translatedText: 42 }] };
globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(invalidNestedOutput) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
}), { status: 200, headers: { "content-type": "application/json" } });
const nestedTelemetryAgent = new TranslatorAgent(compatibleMockProvider(), new InMemoryAgentLogger());
await assert.rejects(
  () => nestedTelemetryAgent.translate(input, { modelConfig: { ...config, maxRetries: 0 }, requestBudget: new DailyRequestBudget() }),
  (error) => {
    const diagnostics = getProviderDiagnostics(error);
    assert.equal(diagnostics?.zodIssueCount, 1);
    assert.deepEqual(diagnostics?.invalidPaths, ["factTranslations[0].translatedText"]);
    assert.equal(diagnostics?.zodIssues?.[0]?.expected, "string");
    assert.equal(diagnostics?.zodIssues?.[0]?.receivedType, "number");
    assert.ok(!JSON.stringify(diagnostics).includes("Texto"));
    return true;
  },
);

globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ ...generationFixture(input), factTranslations: [], translatedSourceMaterial: "" }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
}), { status: 200, headers: { "content-type": "application/json" } });
const emptyGenerationAgent = new TranslatorAgent(compatibleMockProvider(), new InMemoryAgentLogger());
await assert.rejects(
  () => emptyGenerationAgent.translate(input, { modelConfig: { ...config, maxRetries: 0 }, requestBudget: new DailyRequestBudget() }),
  (error) => {
    const diagnostics = getProviderDiagnostics(error);
    assert.equal(diagnostics?.factCountExpected, 1);
    assert.equal(diagnostics?.factCountGenerated, 0);
    assert.deepEqual(diagnostics?.expectedFactIndices, [0]);
    assert.deepEqual(diagnostics?.receivedFactIndices, []);
    assert.equal(diagnostics?.translatedSourceMaterialChars, 0);
    assert.deepEqual(diagnostics?.invalidPaths, ["factTranslations", "translatedSourceMaterial"]);
    assert.equal(diagnostics?.generationSchemaValid, undefined);
    return true;
  },
);

const summary = summarizeZodIssue({ code: "invalid_type", path: ["translatedFacts", 0, "sourceText"], expected: "string", input: 42, message: "Invalid input" });
assert.equal(summary.invalidPath, "translatedFacts[0].sourceText");
assert.equal(summary.summary.receivedType, "number");

const partialOutput = { ...generationFixture(input) };
delete partialOutput.translatedSourceMaterial;
delete partialOutput.preservedNames;
delete partialOutput.translationNotes;
globalThis.fetch = async () => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify(partialOutput) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
}), { status: 200, headers: { "content-type": "application/json" } });
const telemetryAgent = new TranslatorAgent(compatibleMockProvider(), new InMemoryAgentLogger());
await assert.rejects(
  () => telemetryAgent.translate(input, freshOptions()),
  (error) => {
    const diagnostics = getProviderDiagnostics(error);
    assert.equal(diagnostics?.failureKind, "LOCAL_SCHEMA_VALIDATION_ERROR");
    assert.equal(diagnostics?.finishReason, "stop");
    assert.equal(diagnostics?.responseJsonParseable, true);
    assert.equal(diagnostics?.validationResult, "invalid");
    assert.deepEqual(diagnostics?.responseMissingTopLevelFields, ["translatedSourceMaterial", "preservedNames", "translationNotes"]);
    assert.deepEqual(diagnostics?.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    assert.ok((diagnostics?.responseBodyBytes ?? 0) > 0);
    return true;
  }
);

globalThis.fetch = async () => new Response("not-json", { status: 200 });
const jsonErrorAgent = new TranslatorAgent(compatibleMockProvider(), new InMemoryAgentLogger());
await assert.rejects(
  () => jsonErrorAgent.translate(input, freshOptions()),
  (error) => {
    const diagnostics = getProviderDiagnostics(error);
    assert.equal(diagnostics?.failureKind, "LOCAL_JSON_PARSE_ERROR");
    assert.equal(diagnostics?.responseJsonParseable, false);
    return true;
  }
);

globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "schema rejected", type: "invalid_request_error", code: "invalid_schema" } }), {
  status: 400,
});
await assert.rejects(
  () => new OpenAICompatibleModelProvider("https://groq.example/openai/v1", "test-key").generateStructured({
    systemInstructions: "Translate only supplied claims.",
    input: { eventKey: input.event.eventKey },
    schema: translatorGenerationSchema,
    schemaName: "TranslatorGeneration",
    config,
  }),
  (error) => {
    assert.ok(error instanceof PermanentProviderError);
    assert.equal(getProviderDiagnostics(error)?.httpStatus, 400);
    return true;
  }
);
globalThis.fetch = originalFetch;
console.log("Translator unit fixtures passed");
