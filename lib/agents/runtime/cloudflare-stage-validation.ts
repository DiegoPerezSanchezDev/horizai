import { CLOUDFLARE_LLAMA_VALIDATION_MODEL } from "./provider-cost-policy.ts";
import { normalEventStages, type NormalEventStage } from "./event-model-stages.ts";
import { evaluateGroqSchedulerThroughputReadiness, readGroqMaxConcurrentEvents } from "./groq-capacity-policy.ts";

export { normalEventStages };
export type { NormalEventStage };

export type CloudflareStageCompatibilityStatus = "NOT_VALIDATED" | "REAL_VALIDATED" | "REAL_VALIDATED_WITH_UNEXERCISED_NONEMPTY_EVIDENCE_BRANCH";

export const cloudflareStageCompatibilityMatrix: Readonly<Record<NormalEventStage, {
  status: CloudflareStageCompatibilityStatus;
  fixture: string;
  note: string;
}>> = Object.freeze({
  verifier: { status: "REAL_VALIDATED", fixture: "verifier:unit:confirmed-two-source", note: "verifier-v1 passed one supervised Cloudflare call: HTTP 200, VerificationResult Zod, canonical status/confidence and fixture source references validated; synthetic fixture does not establish semantic calibration." },
  translator: { status: "REAL_VALIDATED", fixture: "translator:unit:gpt-5-launch-2026", note: "translator-v1 passed one supervised Cloudflare call: HTTP 200, TranslationResult Zod, deterministic assembly, source-claim/source-item provenance and canonical Spanish target validated; semantic fidelity, Spanish language and entity preservation remain uncertified." },
  editor: { status: "REAL_VALIDATED", fixture: "editor:canonical-editor-input", note: "editor-v2 passed one canonical-fixture Cloudflare run: HTTP 200, strict generation Zod, deterministic assembly, numeric provenance, preserved names and final EditorialDraft." },
  classifier: { status: "REAL_VALIDATED", fixture: "classifier:fixture-new-openai-model", note: "classifier-v1 passed one supervised Cloudflare call: HTTP 200, ClassificationResult Zod, shared-fixture category/region registry checks, ISO-country validation, deterministic Geo resolution and entity normalization passed; semantic category choice remains uncertified." },
  ranker: { status: "REAL_VALIDATED", fixture: "ranker:confirmed-launch", note: "ranker-v1 passed one supervised Cloudflare call: HTTP 200, strict three-score generation Zod, deterministic credibility/reach/momentum, authoritative importance formula and final RankingResult passed; semantic score calibration remains uncertified." },
  critic: { status: "REAL_VALIDATED_WITH_UNEXERCISED_NONEMPTY_EVIDENCE_BRANCH", fixture: "critic:canonical-pass-fixture", note: "critic-v3 real HTTP 200; non-empty evidence-reference generation branch remains unexercised." },
});

export const supervisedValidationFixtureAllowlist: Readonly<Record<NormalEventStage, string>> = Object.freeze({
  verifier: "verifier:unit:confirmed-two-source",
  translator: "translator:unit:gpt-5-launch-2026",
  editor: "editor:canonical-editor-input",
  classifier: "classifier:fixture-new-openai-model",
  ranker: "ranker:confirmed-launch",
  critic: "critic:canonical-pass-fixture",
});

export const supervisedValidationAgentVersionAllowlist: Readonly<Record<NormalEventStage, string>> = Object.freeze({
  verifier: "verifier-v1",
  translator: "translator-v1",
  editor: "editor-v2",
  classifier: "classifier-v1",
  ranker: "ranker-v1",
  critic: "critic-v3",
});

export const SUPERVISED_VALIDATION_PROVIDER = "cloudflare_workers_ai" as const;
export const SUPERVISED_VALIDATION_MODEL = CLOUDFLARE_LLAMA_VALIDATION_MODEL;
export const SUPERVISED_VALIDATION_MAX_ATTEMPTS = 1 as const;
export const SUPERVISED_VALIDATION_MAX_RETRIES = 0 as const;

const validatedStatuses = new Set<CloudflareStageCompatibilityStatus>([
  "REAL_VALIDATED",
  "REAL_VALIDATED_WITH_UNEXERCISED_NONEMPTY_EVIDENCE_BRANCH",
]);

export function getUnvalidatedCloudflareStages(
  matrix: Readonly<Record<NormalEventStage, { status: CloudflareStageCompatibilityStatus }>> = cloudflareStageCompatibilityMatrix,
): NormalEventStage[] {
  return normalEventStages.filter((stage) => !validatedStatuses.has(matrix[stage].status));
}

export function cloudflareAllRequiredStagesValidated(
  matrix: Readonly<Record<NormalEventStage, { status: CloudflareStageCompatibilityStatus }>> = cloudflareStageCompatibilityMatrix,
): boolean {
  return getUnvalidatedCloudflareStages(matrix).length === 0;
}

export type CloudflareActivationGateState = {
  technicalAllStagesValidated: boolean;
  semanticQualityGateValidated: boolean;
  capacityProductionReady: boolean;
  schedulerThroughputReady: boolean;
  freeOnlySafetyValidated: boolean;
  productionRoutingEnabled: boolean;
};

export type CloudflareProductionApprovalGates = Pick<
  CloudflareActivationGateState,
  "semanticQualityGateValidated" | "capacityProductionReady" | "schedulerThroughputReady" | "freeOnlySafetyValidated" | "productionRoutingEnabled"
>;

/** Keeps technical validation, quality approval, capacity approval, and routing as separate gates. */
export function getCloudflareActivationGateState(input: {
  matrix?: Readonly<Record<NormalEventStage, { status: CloudflareStageCompatibilityStatus }>>;
  semanticQualityGateValidated?: boolean;
  capacityProductionReady?: boolean;
  schedulerThroughputReady?: boolean;
  freeOnlySafetyValidated?: boolean;
  productionRoutingEnabled?: boolean;
  maxConcurrentGroqEvents?: number;
} = {}): CloudflareActivationGateState {
  const maxConcurrentGroqEvents = input.maxConcurrentGroqEvents ?? readGroqMaxConcurrentEvents();
  const throughputReadiness = evaluateGroqSchedulerThroughputReadiness({
    proposedReady: input.schedulerThroughputReady ?? false,
    maxConcurrentGroqEvents,
  });
  return {
    technicalAllStagesValidated: cloudflareAllRequiredStagesValidated(input.matrix),
    semanticQualityGateValidated: input.semanticQualityGateValidated ?? false,
    capacityProductionReady: input.capacityProductionReady ?? false,
    schedulerThroughputReady: throughputReadiness.schedulerThroughputReady,
    freeOnlySafetyValidated: input.freeOnlySafetyValidated ?? false,
    productionRoutingEnabled: input.productionRoutingEnabled ?? false,
  };
}

export type CloudflareFullEventEligibility = {
  eligible: boolean;
  reason:
    | "ROUTER_DISABLED"
    | "REQUIRED_STAGES_NOT_VALIDATED"
    | "SEMANTIC_QUALITY_NOT_VALIDATED"
    | "CAPACITY_PRODUCTION_NOT_READY"
    | "SCHEDULER_THROUGHPUT_NOT_READY"
    | "FREE_ONLY_SAFETY_NOT_VALIDATED"
    | "PRODUCTION_ROUTING_DISABLED"
    | "FREE_CAPACITY_UNAVAILABLE"
    | "ELIGIBLE";
};

/** Full-event eligibility requires independent approvals; missing gate state fails closed. */
export function evaluateCloudflareFullEventEligibility(input: {
  routerEnabled: boolean;
  allRequiredStagesValidated: boolean;
  freeCapacityAvailable: boolean;
  activationGates?: CloudflareProductionApprovalGates;
}): CloudflareFullEventEligibility {
  if (!input.routerEnabled) return { eligible: false, reason: "ROUTER_DISABLED" };
  if (!input.allRequiredStagesValidated) return { eligible: false, reason: "REQUIRED_STAGES_NOT_VALIDATED" };
  const gates = input.activationGates;
  if (gates?.semanticQualityGateValidated !== true) return { eligible: false, reason: "SEMANTIC_QUALITY_NOT_VALIDATED" };
  if (gates.capacityProductionReady !== true) return { eligible: false, reason: "CAPACITY_PRODUCTION_NOT_READY" };
  if (gates.schedulerThroughputReady !== true) return { eligible: false, reason: "SCHEDULER_THROUGHPUT_NOT_READY" };
  if (gates.freeOnlySafetyValidated !== true) return { eligible: false, reason: "FREE_ONLY_SAFETY_NOT_VALIDATED" };
  if (gates.productionRoutingEnabled !== true) return { eligible: false, reason: "PRODUCTION_ROUTING_DISABLED" };
  if (!input.freeCapacityAvailable) return { eligible: false, reason: "FREE_CAPACITY_UNAVAILABLE" };
  return { eligible: true, reason: "ELIGIBLE" };
}

export function selectProviderForNewFullEvent(input: {
  routerEnabled: boolean;
  groqCapacityAvailable: boolean;
  cloudflareCapacityAvailable: boolean;
  cloudflareAllRequiredStagesValidated: boolean;
  cloudflareActivationGates?: CloudflareProductionApprovalGates;
}): { provider: "groq" | "cloudflare_workers_ai" | null; reason: string } {
  if (!input.routerEnabled) return { provider: null, reason: "ROUTER_DISABLED" };
  if (input.groqCapacityAvailable) return { provider: "groq", reason: "GROQ_PREFERRED" };
  if (!input.cloudflareCapacityAvailable) return { provider: null, reason: "BLOCKED_FREE_CAPACITY_EXHAUSTED" };
  const cloudflare = evaluateCloudflareFullEventEligibility({
    routerEnabled: true,
    allRequiredStagesValidated: input.cloudflareAllRequiredStagesValidated,
    freeCapacityAvailable: true,
    activationGates: input.cloudflareActivationGates,
  });
  if (cloudflare.eligible) return { provider: "cloudflare_workers_ai", reason: "GROQ_CAPACITY_UNAVAILABLE" };
  if (cloudflare.reason !== "FREE_CAPACITY_UNAVAILABLE") return { provider: null, reason: `CLOUDFLARE_${cloudflare.reason}` };
  return { provider: null, reason: "BLOCKED_FREE_CAPACITY_EXHAUSTED" };
}

export type SupervisedCloudflareStageValidationRequest = {
  stage: string;
  fixture: string;
  provider: string;
  model: string;
  agentVersion?: string;
  eventKey?: string;
  maxAttempts?: number;
  maxRetries?: number;
};

export function supervisedValidationPurpose(stage: NormalEventStage): `${NormalEventStage}_stage_validation` {
  return `${stage}_stage_validation`;
}

export function createSupervisedValidationEventKey(stage: NormalEventStage, validationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(validationId)) {
    throw new Error("BLOCKED_INVALID_VALIDATION_ID");
  }
  return `supervised-validation:${supervisedValidationPurpose(stage)}:${validationId.toLowerCase()}`;
}

export function validateSupervisedCloudflareStageValidation(request: SupervisedCloudflareStageValidationRequest): {
  stage: NormalEventStage;
  fixture: string;
  provider: typeof SUPERVISED_VALIDATION_PROVIDER;
  model: typeof SUPERVISED_VALIDATION_MODEL;
  agentVersion: string;
  validationPurpose: `${NormalEventStage}_stage_validation`;
  maxAttempts: 1;
  maxRetries: 0;
} {
  if (!(normalEventStages as readonly string[]).includes(request.stage)) throw new Error("BLOCKED_UNKNOWN_VALIDATION_STAGE");
  const stage = request.stage as NormalEventStage;
  if (request.fixture !== supervisedValidationFixtureAllowlist[stage]) throw new Error("BLOCKED_FIXTURE_NOT_ALLOWLISTED");
  const agentVersion = supervisedValidationAgentVersionAllowlist[stage];
  if (request.agentVersion !== undefined && request.agentVersion !== agentVersion) throw new Error("BLOCKED_AGENT_VERSION_NOT_ALLOWLISTED");
  if (request.provider !== SUPERVISED_VALIDATION_PROVIDER) throw new Error("BLOCKED_PROVIDER_NOT_ALLOWLISTED");
  if (request.model !== SUPERVISED_VALIDATION_MODEL) throw new Error("BLOCKED_MODEL_NOT_ALLOWLISTED");
  if (request.maxAttempts !== undefined && request.maxAttempts !== SUPERVISED_VALIDATION_MAX_ATTEMPTS) throw new Error("BLOCKED_VALIDATION_ATTEMPT_LIMIT");
  if (request.maxRetries !== undefined && request.maxRetries !== SUPERVISED_VALIDATION_MAX_RETRIES) throw new Error("BLOCKED_VALIDATION_RETRY_LIMIT");
  if (request.eventKey !== undefined) {
    const expectedPrefix = `supervised-validation:${supervisedValidationPurpose(stage)}:`;
    if (!request.eventKey.startsWith(expectedPrefix) || createSupervisedValidationEventKey(stage, request.eventKey.slice(expectedPrefix.length)) !== request.eventKey) {
      throw new Error("BLOCKED_NON_SYNTHETIC_VALIDATION_IDENTITY");
    }
  }
  return {
    stage,
    fixture: request.fixture,
    provider: SUPERVISED_VALIDATION_PROVIDER,
    model: SUPERVISED_VALIDATION_MODEL,
    agentVersion,
    validationPurpose: supervisedValidationPurpose(stage),
    maxAttempts: SUPERVISED_VALIDATION_MAX_ATTEMPTS,
    maxRetries: SUPERVISED_VALIDATION_MAX_RETRIES,
  };
}
