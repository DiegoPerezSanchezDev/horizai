import { classificationResultSchema, type ClassificationResult } from "../contracts/index.ts";
import { createConfiguredModelProvider, type ModelProvider } from "../runtime/model-provider.ts";
import { runStructuredAgent } from "../runtime/agent-runner.ts";
import type { AgentLogger, AgentExecutionResult, ModelConfig } from "../runtime/runtime-types.ts";
import { FREE_TIER_MAX_OUTPUT_TOKENS, readGroqDailyRequestHardCap, readStructuredOutputMode, validateCostGuardConfig, type DailyRequestBudget, type ProviderScopedDailyRequestBudget } from "../runtime/request-budget.ts";
import { buildClassifierModelInput } from "./classifier-input.ts";
import { classifierAgentVersion, classifierSystemInstructions } from "./classifier-prompt.ts";
import { classifierInputSchema, classifierGenerationSchema, type ClassifierGeneration, type ClassifierInput } from "./classifier-types.ts";
import { loadActiveReferenceRegistry, type ReferenceRegistry } from "./geo-registry.ts";
import { resolveGeo, type GeoResolution } from "./geo-resolver.ts";
import { normalizeEntityGroups } from "./classifier-normalizer.ts";

function numberEnv(name: string, fallback: number, maximum?: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}
function integerEnv(name: string, fallback: number, maximum: number): number {
  const value = numberEnv(name, fallback, maximum);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}
function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}
function reasoningEffortEnv(name: string): "low" | "medium" | "high" | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new Error(`${name} must be low, medium, or high`);
}

function requiredModel(): string {
  const model = process.env.AGENT_MODEL_CLASSIFY?.trim();
  if (!model) throw new Error("Missing agent configuration: AGENT_MODEL_CLASSIFY");
  return model;
}

export function getClassifierModelConfig(): ModelConfig {
  const reasoningEffort = reasoningEffortEnv("AGENT_REASONING_EFFORT_CLASSIFY");
  const includeReasoning = process.env.AGENT_INCLUDE_REASONING_CLASSIFY?.trim();
  const config: ModelConfig = {
    model: requiredModel(),
    timeoutMs: numberEnv("AGENT_TIMEOUT_MS", 30_000),
    maxRetries: integerEnv("AGENT_MAX_RETRIES", 2, 2),
    retryBackoffMs: numberEnv("AGENT_RETRY_BACKOFF_MS", 250),
    maxOutputTokens: integerEnv("AGENT_MAX_OUTPUT_TOKENS", FREE_TIER_MAX_OUTPUT_TOKENS, FREE_TIER_MAX_OUTPUT_TOKENS),
    dailyRequestLimit: readGroqDailyRequestHardCap(),
    failOnRateLimit: booleanEnv("AGENT_FAIL_ON_RATE_LIMIT", true),
    allowPaidFallback: booleanEnv("AGENT_ALLOW_PAID_FALLBACK", false),
    structuredOutputMode: readStructuredOutputMode(process.env.AGENT_STRUCTURED_OUTPUT_CLASSIFY ?? process.env.AGENT_STRUCTURED_OUTPUT_MODE, "json_object"),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(includeReasoning ? { includeReasoning: booleanEnv("AGENT_INCLUDE_REASONING_CLASSIFY", false) } : {}),
  };
  validateCostGuardConfig(config);
  return config;
}

export type ClassifierRunOptions = { dryRun?: boolean; modelConfig?: ModelConfig; requestBudget?: DailyRequestBudget | ProviderScopedDailyRequestBudget; registry?: ReferenceRegistry; pipelineRunId?: string };
export type ClassifierExecutionResult = AgentExecutionResult<ClassificationResult> & { geo: GeoResolution; categoryCount: number; countryCount: number; entityCount: number };

const ISO_COUNTRY_CODES = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "));

function assembleClassificationResult(input: ClassifierInput, generation: ClassifierGeneration, registry: ReferenceRegistry): { output: ClassificationResult; geo: GeoResolution } {
  if (generation.categorySlugs.length > 3 || generation.categorySlugs.some((slug) => !registry.categories.has(slug))) throw new Error("Classifier returned a category outside the active registry");
  if (generation.primaryRegionCode !== null && !registry.regions.has(generation.primaryRegionCode)) throw new Error("Classifier returned a region outside the active registry");
  if (generation.countryCodes.some((code) => !ISO_COUNTRY_CODES.has(code))) throw new Error("Classifier returned a non-ISO country code");
  const entities = normalizeEntityGroups({ companies: generation.companies, models: generation.models, people: generation.people, technologies: generation.technologies });
  const geo = resolveGeo({ regionCode: generation.primaryRegionCode }, registry);
  const output = classificationResultSchema.parse({
    schemaVersion: 1,
    eventKey: input.event.eventKey,
    primaryRegionCode: generation.primaryRegionCode,
    countryCodes: generation.countryCodes,
    categorySlugs: generation.categorySlugs,
    ...entities,
    latitude: geo.latitude,
    longitude: geo.longitude,
  });
  return { output, geo };
}

export class ClassifierAgent {
  private readonly provider: ModelProvider;
  private readonly logger?: AgentLogger;

  constructor(provider: ModelProvider, logger?: AgentLogger) {
    this.provider = provider;
    this.logger = logger;
  }

  async classify(input: ClassifierInput, options: ClassifierRunOptions = {}): Promise<ClassifierExecutionResult> {
    const validatedInput = classifierInputSchema.parse(input);
    const registry = options.registry ?? await loadActiveReferenceRegistry();
    const builtInput = buildClassifierModelInput(validatedInput, {
      regionCodes: [...registry.regions.keys()],
      categorySlugs: [...registry.categories.keys()],
    });
    const result = await runStructuredAgent({
      agentName: "classifier",
      agentVersion: classifierAgentVersion,
      eventKey: validatedInput.event.eventKey,
      pipelineRunId: options.pipelineRunId,
      input: builtInput.input,
      systemInstructions: classifierSystemInstructions,
      schemaName: "ClassifierGeneration",
      schema: classifierGenerationSchema,
      modelConfig: options.modelConfig ?? getClassifierModelConfig(),
      provider: this.provider,
      logger: this.logger,
      dryRun: options.dryRun ?? true,
      requestBudget: options.requestBudget,
      requestMetrics: {
        systemPromptChars: classifierSystemInstructions.length,
        inputChars: builtInput.inputChars,
        schemaChars: 0,
        sourceCount: validatedInput.sources.length,
        originalContentChars: [],
        sentContentChars: [],
        truncated: [],
      },
      finalizeOutput: (generation) => assembleClassificationResult(validatedInput, generation, registry),
    });
    const geo = resolveGeo({ regionCode: result.output.primaryRegionCode }, registry);
    const entityCount = result.output.companies.length + result.output.models.length + result.output.people.length + result.output.technologies.length;
    return { ...result, geo, categoryCount: result.output.categorySlugs.length, countryCount: result.output.countryCodes.length, entityCount };
  }
}

export function createConfiguredClassifier(logger?: AgentLogger): ClassifierAgent {
  return new ClassifierAgent(createConfiguredModelProvider(), logger);
}

export { classifierAgentVersion, classifierSystemInstructions } from "./classifier-prompt.ts";
export { classifierInputSchema, classifierModelInputSchema, classifierGenerationSchema } from "./classifier-types.ts";
export type { ClassifierInput, ClassifierModelInput, ClassifierGeneration } from "./classifier-types.ts";
