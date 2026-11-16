import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classificationResultSchema,
  clusteredEventSchema,
  editorialDraftSchema,
  rankingResultSchema,
  translationResultSchema,
  verificationResultSchema,
  extractedItemSchema,
} from "../lib/agents/contracts/index.ts";
import { buildClassifierInput, buildClassifierModelInput } from "../lib/agents/classifier/classifier-input.ts";
import { createReferenceRegistry, type ReferenceRegistry } from "../lib/agents/classifier/geo-registry.ts";
import { projectClassificationGeo } from "../lib/agents/classifier/geo-resolver.ts";
import { buildCriticInput, buildCriticModelInput, buildCriticSourceEvidence } from "../lib/agents/critic/critic-input.ts";
import type { CriticInput } from "../lib/agents/critic/critic-types.ts";
import { runCriticPrechecks } from "../lib/agents/critic/critic-prechecks.ts";
import { buildEditorInput, buildEditorModelInput } from "../lib/agents/editor/editor-input.ts";
import { buildRankerPipelineInput } from "../lib/agents/ranker/ranker-input.ts";
import { buildTranslatorModelInput } from "../lib/agents/translator/translator-input.ts";
import { translatorInputSchema } from "../lib/agents/translator/translator-types.ts";
import { verifierInputSchema, type VerifierInput } from "../lib/agents/verifier/verifier-types.ts";
import { hashContent } from "../lib/agents/extraction/content-hash.ts";
import {
  QUALITY_BENCHMARK_CASE_IDS,
  qualityBenchmarkCases,
  qualityBenchmarkInputSha256,
  type QualityBenchmarkCaseId,
} from "../lib/agents/runtime/cloudflare-quality-benchmark.ts";
import { buildVerifierModelInput } from "../lib/agents/verifier/verifier-input-builder.ts";
import { rankerInputSchema } from "../lib/agents/ranker/ranker-types.ts";

type JsonRecord = Record<string, unknown>;
export type BenchmarkStage = "verifier" | "translator" | "editor" | "classifier" | "ranker" | "critic";
export type StageReadiness = "READY_FROM_STORED_INPUT" | "INPUT_CAN_BE_DETERMINISTICALLY_RECONSTRUCTED" | "MISSING";

export type PreparedBenchmarkStage = {
  benchmarkCaseId: QualityBenchmarkCaseId;
  stage: BenchmarkStage;
  readiness: StageReadiness;
  input: unknown | null;
  modelInput: unknown | null;
  inputSha256: string | null;
  hashStatus: "READY" | "REQUIRES_EXACT_RAW_ITEM_READ" | "MISSING";
  historicalInputComparability: "PROVEN_FROM_STORED_MODEL_INPUT" | "RECONSTRUCTED_FROM_CHECKPOINT" | "REGISTRY_NOT_STORED" | "NOT_PROVEN";
  checkpointPaths: string[];
  historicalOutput: JsonRecord | null;
  deterministicDiagnostics: JsonRecord;
  blocker: string | null;
};

export type QualityBenchmarkCaseProvenanceManifest = {
  benchmarkCaseId: QualityBenchmarkCaseId;
  caseKind: "PROBLEM_CASE" | "CLEAN_CONTROL";
  historicalProviderProvenance: "CONFIRMED_GROQ";
  sourceCount: number;
  rawItemTraceability: "AVAILABLE" | "MISSING";
  rawItemId: string | null;
  rawContentSha256: string | null;
  criticControlUsable?: boolean;
  availableStageInputs: Record<string, Omit<PreparedBenchmarkStage, "input" | "modelInput">>;
  availableHistoricalOutputs: Record<string, JsonRecord | null>;
  knownHistoricalCriticOutcome: {
    decision: string;
    findingCount: number;
    findings: Array<{ code: string | null; severity: string | null }>;
    evidenceRole: "HISTORICAL_REFERENCE_NOT_GOLD_LABEL";
  };
  missingLineageComponents: string[];
  copyrightSafeReviewRepresentation: {
    representation: string;
    storedInputReferences: string[];
    factInventory: string[];
    noArticleBodyCopied: true;
  };
};

export const qualityBenchmarkRegistrySnapshot: ReferenceRegistry = createReferenceRegistry(
  [
    { code: "CHINA", name: "China", latitude: 35.8617, longitude: 104.1954 },
    { code: "EUROPE", name: "Europa", latitude: 54.526, longitude: 15.2551 },
    { code: "GLOBAL", name: "Global", latitude: 20, longitude: 0 },
    { code: "INDIA", name: "India", latitude: 20.5937, longitude: 78.9629 },
    { code: "JAPAN", name: "Japón", latitude: 36.2048, longitude: 138.2529 },
    { code: "LATAM", name: "LatAm", latitude: -8.7832, longitude: -55.4915 },
    { code: "MIDDLE-EAST", name: "Oriente Medio", latitude: 29.2985, longitude: 42.55 },
    { code: "SOUTH-KOREA", name: "Corea del Sur", latitude: 35.9078, longitude: 127.7669 },
    { code: "SPAIN", name: "España", latitude: 40.4637, longitude: -3.7492 },
    { code: "UK", name: "Reino Unido", latitude: 55.3781, longitude: -3.436 },
    { code: "US", name: "EE. UU.", latitude: 39.8283, longitude: -98.5795 },
  ],
  [
    { slug: "chips", name: "Chips" },
    { slug: "empresas", name: "Empresas" },
    { slug: "innovacion", name: "Innovación" },
    { slug: "investigacion", name: "Investigación" },
    { slug: "modelos", name: "Modelos" },
    { slug: "regulacion", name: "Regulación" },
    { slug: "startups", name: "Startups" },
    { slug: "talento", name: "Talento" },
  ],
);

function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`BLOCKED_BENCHMARK_CHECKPOINT_INVALID:${name}`);
  return value as JsonRecord;
}

function readJson(path: string): JsonRecord {
  return record(JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as unknown, path);
}

function requiredRecord(parent: JsonRecord, key: string): JsonRecord {
  return record(parent[key], key);
}

function requiredArray(parent: JsonRecord, key: string): unknown[] {
  const value = parent[key];
  if (!Array.isArray(value)) throw new Error(`BLOCKED_BENCHMARK_CHECKPOINT_INVALID:${key}`);
  return value;
}

function requiredString(parent: JsonRecord, key: string): string {
  const value = parent[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`BLOCKED_BENCHMARK_CHECKPOINT_INVALID:${key}`);
  return value;
}

function translatedFactsProjection(value: unknown): Array<{ sourceText: string; translatedText: string }> {
  if (!Array.isArray(value)) throw new Error("BLOCKED_BENCHMARK_TRANSLATED_FACTS_MISSING");
  return value.map((entry) => {
    const fact = record(entry, "translatedFact");
    if (typeof fact.sourceText !== "string" || typeof fact.translatedText !== "string") throw new Error("BLOCKED_BENCHMARK_TRANSLATED_FACT_INVALID");
    return { sourceText: fact.sourceText, translatedText: fact.translatedText };
  });
}

function eventProjection(value: JsonRecord): { eventKey: string; canonicalTitle: string } {
  return { eventKey: String(value.eventKey), canonicalTitle: String(value.canonicalTitle) };
}

function stageOutput(caseId: QualityBenchmarkCaseId, stage: BenchmarkStage): JsonRecord | null {
  const paths = qualityBenchmarkCases[caseId].checkpoints;
  const path = stage === "verifier" ? paths.translator
    : stage === "translator" ? paths.editor
      : paths.critic;
  const checkpoint = readJson(path);
  const output = stage === "verifier" ? checkpoint.verification
    : stage === "translator" ? checkpoint.translation
      : stage === "editor" ? checkpoint.editorial
        : stage === "classifier" ? checkpoint.classification
          : stage === "ranker" ? checkpoint.ranking
            : checkpoint.critic;
  if (stage === "verifier") verificationResultSchema.parse(output);
  else if (stage === "translator") translationResultSchema.parse(output);
  else if (stage === "editor") editorialDraftSchema.parse(output);
  else if (stage === "classifier") classificationResultSchema.parse(output);
  else if (stage === "ranker") rankingResultSchema.parse(record(output, "ranking").result);
  else if (typeof output !== "object" || output === null || Array.isArray(output)) throw new Error("BLOCKED_HISTORICAL_CRITIC_OUTPUT_MISSING");
  return record(output, `${stage}HistoricalOutput`);
}

function summaryFor(stage: BenchmarkStage, output: JsonRecord): JsonRecord {
  if (stage === "verifier") return {
    status: output.status,
    confidenceScore: output.confidenceScore,
    verifiedFactCount: Array.isArray(output.verifiedFacts) ? output.verifiedFacts.length : 0,
    contradictionCount: Array.isArray(output.contradictions) ? output.contradictions.length : 0,
  };
  if (stage === "translator") return {
    translatedFactCount: Array.isArray(output.translatedFacts) ? output.translatedFacts.length : 0,
    preservedNameCount: Array.isArray(output.preservedNames) ? output.preservedNames.length : 0,
  };
  if (stage === "editor") return {
    headline: output.headlineEs,
    keyPointCount: Array.isArray(output.keyPoints) ? output.keyPoints.length : 0,
    knownHistoricalConcern: "A key point asserts a patch-status/confirmation detail absent from the stored verified fact.",
  };
  if (stage === "classifier") return {
    categorySlugs: output.categorySlugs,
    primaryRegionCode: output.primaryRegionCode,
    entityCount: ["companies", "models", "people", "technologies"].reduce((sum, key) => sum + (Array.isArray(output[key]) ? (output[key] as unknown[]).length : 0), 0),
  };
  if (stage === "ranker") {
    const result = record(output.result, "rankingResult");
    const signals = record(output.deterministicSignals, "deterministicSignals");
    return {
      semanticDimensions: { impact: result.impact, novelty: result.novelty, economicImpact: result.economicImpact },
      deterministicSignals: { credibility: signals.credibility, reach: signals.reach, momentum: signals.momentum },
      importanceScore: result.importanceScore,
      formulaVersion: output.formulaVersion,
    };
  }
  const issues = Array.isArray(output.issues) ? output.issues.map((entry) => {
    const finding = record(entry, "criticIssue");
    return { type: finding.type ?? finding.kind, code: finding.code ?? finding.dimension, severity: finding.severity };
  }) : [];
  return { decision: output.decision, findingCount: issues.length, findings: issues };
}

function prepared(
  caseId: QualityBenchmarkCaseId,
  stage: BenchmarkStage,
  input: unknown,
  modelInput: unknown,
  comparability: PreparedBenchmarkStage["historicalInputComparability"],
  diagnostics: JsonRecord = {},
): PreparedBenchmarkStage {
  const definition = qualityBenchmarkCases[caseId];
  const output = stageOutput(caseId, stage);
  return {
    benchmarkCaseId: caseId,
    stage,
    readiness: "READY_FROM_STORED_INPUT",
    input,
    modelInput,
    inputSha256: qualityBenchmarkInputSha256(modelInput),
    hashStatus: "READY",
    historicalInputComparability: comparability,
    checkpointPaths: [definition.checkpoints[stage]],
    historicalOutput: output ? summaryFor(stage, output) : null,
    deterministicDiagnostics: diagnostics,
    blocker: null,
  };
}

export function prepareCurrentContractCriticStage(
  checkpoint: JsonRecord,
  sourceEvidence: CriticInput["sourceEvidence"],
): {
  input: CriticInput;
  modelInput: ReturnType<typeof buildCriticModelInput>["input"];
  prechecks: ReturnType<typeof runCriticPrechecks>;
  evidenceCatalogCount: number;
  historicalGeographyReprojected: boolean;
} {
  const verification = verificationResultSchema.parse(checkpoint.verification);
  const translation = translationResultSchema.parse(checkpoint.translation);
  const storedClassification = classificationResultSchema.parse(checkpoint.classification);
  const geographyProjection = projectClassificationGeo(storedClassification, qualityBenchmarkRegistrySnapshot);
  const input = buildCriticInput({
    event: record(checkpoint.event, "criticEvent") as CriticInput["event"],
    verification,
    translation,
    editorial: editorialDraftSchema.parse(checkpoint.editorial),
    classification: geographyProjection.classification,
    ranking: record(checkpoint.ranking, "criticRanking") as CriticInput["ranking"],
    sources: requiredArray(checkpoint, "sources").map((value) => record(value, "criticSource")) as CriticInput["sources"],
    sourceEvidence,
    geo: geographyProjection.geo,
  });
  const prechecks = runCriticPrechecks(input, { registry: qualityBenchmarkRegistrySnapshot });
  if (!prechecks.passed) throw new Error("BLOCKED_CRITIC_PRECHECKS:" + prechecks.issues.map((issue) => issue.code).join(","));
  const built = buildCriticModelInput(input);
  return {
    input,
    modelInput: built.input,
    prechecks,
    evidenceCatalogCount: built.evidenceCatalog.length,
    historicalGeographyReprojected: geographyProjection.classification.latitude !== storedClassification.latitude
      || geographyProjection.classification.longitude !== storedClassification.longitude,
  };
}

export function prepareStoredBenchmarkStage(
  caseId: QualityBenchmarkCaseId,
  stage: BenchmarkStage,
  options: { sourceEvidence?: CriticInput["sourceEvidence"] } = {},
): PreparedBenchmarkStage {
  const definition = qualityBenchmarkCases[caseId];
  if (stage === "verifier") {
    const checkpoint = readJson(definition.checkpoints.verifier);
    const event = record(checkpoint.event, "verifierEvent");
    const eventKey = String(event.eventKey);
    return {
      benchmarkCaseId: caseId,
      stage,
      readiness: caseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem ? "INPUT_CAN_BE_DETERMINISTICALLY_RECONSTRUCTED" : "MISSING",
      input: null,
      modelInput: null,
      inputSha256: null,
      hashStatus: caseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem ? "REQUIRES_EXACT_RAW_ITEM_READ" : "MISSING",
      historicalInputComparability: "NOT_PROVEN",
      checkpointPaths: [definition.checkpoints.verifier, ...(caseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem && "snapshotPath" in definition ? [definition.snapshotPath] : [])],
      historicalOutput: stageOutput(caseId, "verifier") ? summaryFor("verifier", stageOutput(caseId, "verifier")!) : null,
      deterministicDiagnostics: { checkpointEventKeyMatchesCase: eventKey === definition.historicalEventKey, sourceCount: definition.sourceCount },
      blocker: caseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem ? "Exact extracted source content is remote-only in the raw_items row; the future executor must read that exact rawItemId and check its saved content hash before hashing or dispatch." : "No rawItemId, extracted item, excerpt or source body is linked to this MIT checkpoint.",
    };
  }

  const checkpoint = readJson(definition.checkpoints[stage]);
  const verification = verificationResultSchema.parse(checkpoint.verification);
  if (stage === "translator") {
    const input = translatorInputSchema.parse({
      schemaVersion: 1,
      event: clusteredEventSchema.parse(checkpoint.event),
      verification,
      sourceLanguage: String(checkpoint.sourceLanguage),
      sources: requiredArray(checkpoint, "sources"),
    });
    const modelInput = buildTranslatorModelInput(input).input;
    const storedModelInput = checkpoint.translatorModelInput;
    const storedHash = storedModelInput ? qualityBenchmarkInputSha256(storedModelInput) : null;
    const builtHash = qualityBenchmarkInputSha256(modelInput);
    if (storedHash !== builtHash) throw new Error(`BLOCKED_TRANSLATOR_STORED_INPUT_MISMATCH:${caseId}`);
    return prepared(caseId, stage, input, modelInput, "PROVEN_FROM_STORED_MODEL_INPUT", {
      checkpointModelInputHashMatchesBuilder: true,
      historicalInputSha256: storedHash,
    });
  }

  const translationRecord = requiredRecord(checkpoint, "translation");
  const sources = requiredArray(checkpoint, "sources");
  if (stage === "editor") {
    const translation = translationResultSchema.parse(translationRecord);
    const input = buildEditorInput({
      event: eventProjection(requiredRecord(checkpoint, "event")),
      verification,
      translation,
      sources: sources.map((entry) => {
        const source = record(entry, "editorSource");
        return { sourceId: String(source.sourceId), sourceName: String(source.sourceName), canonicalUrl: String(source.canonicalUrl), sourceType: typeof source.sourceType === "string" ? source.sourceType : null };
      }),
    });
    const modelInput = buildEditorModelInput(input).input;
    return prepared(caseId, stage, input, modelInput, "RECONSTRUCTED_FROM_CHECKPOINT", { zodValid: true, deterministicEditorGuardInputAvailable: true });
  }

  if (stage === "classifier") {
    const editorial = requiredRecord(checkpoint, "editorial");
    const input = buildClassifierInput({
      event: eventProjection(requiredRecord(checkpoint, "event")),
      verification,
      translation: {
        translatedTitle: String(translationRecord.translatedTitle),
        translatedFacts: translatedFactsProjection(translationRecord.translatedFacts),
        preservedNames: translationRecord.preservedNames as string[],
      },
      editorial: {
        headlineEs: String(editorial.headlineEs),
        summaryEs: String(editorial.summaryEs),
        keyPoints: editorial.keyPoints as string[],
      },
      sources: sources.map((entry) => {
        const source = record(entry, "classifierSource");
        return { sourceName: String(source.sourceName), sourceType: typeof source.sourceType === "string" ? source.sourceType : null, countryCode: typeof source.countryCode === "string" ? source.countryCode : null };
      }),
    });
    const modelInput = buildClassifierModelInput(input, {
      regionCodes: [...qualityBenchmarkRegistrySnapshot.regions.keys()],
      categorySlugs: [...qualityBenchmarkRegistrySnapshot.categories.keys()],
    }).input;
    return prepared(caseId, stage, input, modelInput, "REGISTRY_NOT_STORED", {
      zodValid: true,
      registryCodesPinnedToAuditedActiveSet: true,
      historicalRegistryOrderingAndSnapshotStored: false,
      allowedRegionCount: modelInput.allowedRegionCodes.length,
      allowedCategoryCount: modelInput.allowedCategorySlugs.length,
    });
  }

  if (stage === "ranker") {
    const editorial = requiredRecord(checkpoint, "editorial");
    const input = buildRankerPipelineInput({
      event: requiredRecord(checkpoint, "event") as never,
      verification,
      translation: {
        translatedTitle: String(translationRecord.translatedTitle),
        translatedFacts: translatedFactsProjection(translationRecord.translatedFacts),
      },
      editorial: {
        headlineEs: String(editorial.headlineEs),
        summaryEs: String(editorial.summaryEs),
        whyItMattersEs: String(editorial.whyItMattersEs),
        keyPoints: editorial.keyPoints as string[],
      },
      classification: classificationResultSchema.parse(checkpoint.classification),
    });
    const modelInput = rankerInputSchema.parse(input);
    const createdAt = typeof checkpoint.createdAt === "string" ? checkpoint.createdAt : null;
    const rankResult = rankingResultSchema.parse(record(checkpoint.ranking, "historicalRankerOutput").result);
    return prepared(caseId, stage, input, modelInput, "RECONSTRUCTED_FROM_CHECKPOINT", {
      zodValid: true,
      historicalFormulaVersion: typeof requiredRecord(checkpoint, "ranking").formulaVersion === "string" ? requiredRecord(checkpoint, "ranking").formulaVersion : null,
      historicalImportanceScore: rankResult.importanceScore,
      referenceTime: createdAt,
      activityHistoryInput: "NONE_STORED_OR_USED_BY_HISTORICAL_PIPELINE_STAGE",
    });
  }

  translationResultSchema.parse(translationRecord);
  const sourceEvidence = options.sourceEvidence
    ?? (Array.isArray(checkpoint.sourceEvidence) ? checkpoint.sourceEvidence as CriticInput["sourceEvidence"] : undefined);
  if (sourceEvidence === undefined) {
    const definition = qualityBenchmarkCases[caseId];
    const canReconstruct = caseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem
      && definition.rawItemTraceability === "AVAILABLE"
      && definition.rawItemId !== null;
    return {
      benchmarkCaseId: caseId,
      stage,
      readiness: canReconstruct ? "INPUT_CAN_BE_DETERMINISTICALLY_RECONSTRUCTED" : "MISSING",
      input: null,
      modelInput: null,
      inputSha256: null,
      hashStatus: canReconstruct ? "REQUIRES_EXACT_RAW_ITEM_READ" : "MISSING",
      historicalInputComparability: "NOT_PROVEN",
      checkpointPaths: [definition.checkpoints.critic, ...(canReconstruct ? [definition.snapshotPath] : [])],
      historicalOutput: stageOutput(caseId, stage) ? summaryFor(stage, stageOutput(caseId, stage)!) : null,
      deterministicDiagnostics: {
        sourceEvidenceStoredInCheckpoint: false,
        requiredSourceCount: definition.sourceCount,
        currentContract: "ONE_BOUNDED_EXCERPT_PER_SOURCE_WITH_MATCHING_LINEAGE",
        sourceEvidenceLookup: "NOT_RUN_OFFLINE",
      },
      blocker: canReconstruct
        ? "The legacy Critic checkpoint has no sourceEvidence. An exact raw_items read must verify the stored ID and content hash before deriving the bounded excerpt."
        : "The legacy Critic checkpoint has no sourceEvidence and this case has no linked rawItemId. Current-contract Critic input cannot be reconstructed without evidence fabrication.",
    };
  }
  const currentStage = prepareCurrentContractCriticStage(checkpoint, sourceEvidence);
  return prepared(caseId, stage, currentStage.input, currentStage.modelInput, "RECONSTRUCTED_FROM_CHECKPOINT", {
    zodValid: true,
    deterministicPrechecks: "PASS",
    historicalGeographyReprojected: currentStage.historicalGeographyReprojected,
    evidenceCatalogCount: currentStage.evidenceCatalogCount,
    sourceEvidenceCount: currentStage.input.sourceEvidence.length,
    sourceEvidenceSource: options.sourceEvidence ? "EXACT_RAW_ITEM_READ" : "STORED_CHECKPOINT",
    historicalCriticDecision: record(checkpoint.critic, "historicalCritic").decision,
    historicalCriticFindings: Array.isArray(record(checkpoint.critic, "historicalCritic").issues) ? (record(checkpoint.critic, "historicalCritic").issues as unknown[]).length : null,
  });
}

export async function reconstructArsVerifierInputWithReadOnlyDb(): Promise<{
  input: VerifierInput;
  modelInput: unknown;
  inputSha256: string;
  sourceContentSha256: string;
  criticSourceEvidence: CriticInput["sourceEvidence"];
  sourceProvenance: {
    rawItemId: string;
    sourceId: string;
    sourceItemId: string;
    externalId: string;
    sourceUrl: string;
    extractedContentSha256: string;
    urlIdentityMatched: true;
    rawItemIdentityMatched: true;
  };
}> {
  const caseDefinition = qualityBenchmarkCases[QUALITY_BENCHMARK_CASE_IDS.arsProblem];
  const verifierCheckpoint = readJson(caseDefinition.checkpoints.verifier);
  const snapshot = readJson(caseDefinition.snapshotPath);
  const snapshotItem = record(requiredArray(snapshot, "items")[0], "ArsSnapshotItem");
  const rawItemId = requiredString(snapshotItem, "rawItemId");
  const sourceId = requiredString(snapshotItem, "sourceId");
  const sourceItemId = requiredString(snapshotItem, "sourceItemId");
  const externalId = requiredString(snapshotItem, "externalId");
  const sourceUrl = requiredString(snapshotItem, typeof snapshotItem.canonicalUrl === "string" ? "canonicalUrl" : "originalUrl");
  const snapshotContentHash = requiredString(snapshotItem, "contentHash");
  const verifierEvent = requiredRecord(verifierCheckpoint, "event");
  const sourceItems = requiredArray(verifierEvent, "sourceItems").map((value) => record(value, "verifierEventSource"));
  if (rawItemId !== caseDefinition.rawItemId
    || externalId !== sourceItemId
    || !sourceItems.some((source) => source.sourceId === sourceId && source.candidateId === sourceItemId)) {
    throw new Error("BLOCKED_ARS_RAW_ITEM_IDENTITY_MISMATCH");
  }
  const { createSupabaseServerClient } = await import("../lib/supabase/server-client.ts");
  const db = createSupabaseServerClient();
  const response = await db.from("raw_items").select("id,source_id,external_id,raw_content,content_hash,normalized_payload").eq("id", caseDefinition.rawItemId).maybeSingle();
  if (response.error || !response.data || typeof response.data.raw_content !== "string" || response.data.raw_content.length === 0) {
    throw new Error("BLOCKED_ARS_EXACT_RAW_ITEM_READ_OR_HASH_MISMATCH");
  }
  const normalized = record(response.data.normalized_payload, "rawItemNormalizedPayload");
  const remoteFinalUrl = typeof normalized.finalUrl === "string" ? normalized.finalUrl : null;
  const normalizeUrlIdentity = (value: string | null): string | null => {
    if (!value) return null;
    try {
      const url = new URL(value);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      return url.origin + path + url.search;
    } catch {
      return null;
    }
  };
  const computedContentHash = hashContent(response.data.raw_content);
  const storedContentHash = typeof response.data.content_hash === "string" ? response.data.content_hash.replace(/^sha256:/, "") : "";
  if (response.data.id !== caseDefinition.rawItemId
    || response.data.source_id !== sourceId
    || response.data.external_id !== externalId
    || (typeof normalized.sourceId === "string" && normalized.sourceId !== sourceId)
    || normalizeUrlIdentity(remoteFinalUrl) === null
    || normalizeUrlIdentity(remoteFinalUrl) !== normalizeUrlIdentity(sourceUrl)
    || storedContentHash !== snapshotContentHash.replace(/^sha256:/, "")
    || storedContentHash !== caseDefinition.rawContentSha256
    || computedContentHash.replace(/^sha256:/, "") !== caseDefinition.rawContentSha256) {
    throw new Error("BLOCKED_ARS_EXACT_RAW_ITEM_READ_OR_HASH_MISMATCH");
  }
  const item = extractedItemSchema.parse({
    schemaVersion: 1,
    candidateId: sourceItemId,
    url: snapshotItem.originalUrl,
    canonicalUrl: snapshotItem.canonicalUrl ?? snapshotItem.originalUrl,
    title: snapshotItem.title,
    description: snapshotItem.excerpt,
    author: typeof normalized.author === "string" ? normalized.author : null,
    publishedAt: snapshotItem.publishedAt,
    language: snapshotItem.language,
    content: response.data.raw_content,
    contentHash: snapshotItem.contentHash,
    metadata: { ...normalized, sourceId: snapshotItem.sourceId, sourceName: snapshotItem.sourceName, sourceCountryCode: snapshotItem.countryCode },
    extractionQuality: snapshotItem.extractionQuality,
  });
  const event = requiredRecord(verifierCheckpoint, "event");
  const sourceRows = requiredArray(verifierCheckpoint, "sources").map((value) => {
    const source = record(value, "verifierSource");
    return {
      sourceId: String(source.sourceId),
      sourceName: String(source.sourceName),
      sourceUrl,
      sourceType: typeof source.sourceType === "string" ? source.sourceType : null,
      countryCode: typeof source.countryCode === "string" ? source.countryCode : null,
      language: typeof source.language === "string" ? source.language : null,
    };
  });
  const input = verifierInputSchema.parse({ event, items: [item], sources: sourceRows });
  const modelInput = buildVerifierModelInput(input, 12_000).input;
  const criticSourceEvidence = buildCriticSourceEvidence(
    sourceRows.map((source) => ({ sourceId: source.sourceId, sourceItemId, sourceUrl: source.sourceUrl })),
    [item],
  );
  return {
    input,
    modelInput,
    inputSha256: qualityBenchmarkInputSha256(modelInput),
    sourceContentSha256: computedContentHash,
    criticSourceEvidence,
    sourceProvenance: {
      rawItemId,
      sourceId,
      sourceItemId,
      externalId,
      sourceUrl,
      extractedContentSha256: computedContentHash,
      urlIdentityMatched: true,
      rawItemIdentityMatched: true,
    },
  };
}

export function caseProvenanceManifest(caseId: QualityBenchmarkCaseId): QualityBenchmarkCaseProvenanceManifest {
  const definition = qualityBenchmarkCases[caseId];
  const stages: Record<string, PreparedBenchmarkStage> = {};
  for (const stage of ["verifier", "translator", "editor", "classifier", "ranker", "critic"] as const) stages[stage] = prepareStoredBenchmarkStage(caseId, stage);
  const storedCritic = stages.critic;
  const criticControlUsable = caseId === QUALITY_BENCHMARK_CASE_IDS.mitControl
    ? storedCritic.readiness === "READY_FROM_STORED_INPUT" && storedCritic.deterministicDiagnostics.deterministicPrechecks === "PASS"
    : undefined;
  const safeStages = Object.fromEntries(Object.entries(stages).map(([stage, result]) => [stage, {
    benchmarkCaseId: result.benchmarkCaseId,
    stage: result.stage,
    readiness: result.readiness,
    inputSha256: result.inputSha256,
    hashStatus: result.hashStatus,
    historicalInputComparability: result.historicalInputComparability,
    checkpointPaths: result.checkpointPaths,
    historicalOutput: result.historicalOutput,
    deterministicDiagnostics: result.deterministicDiagnostics,
    blocker: result.blocker,
  }]));
  const historicalCritic = storedCritic.historicalOutput;
  const criticFindings = historicalCritic && Array.isArray(historicalCritic.findings)
    ? historicalCritic.findings.map((entry) => {
      const finding = record(entry, "historicalCriticFinding");
      return {
        code: typeof finding.code === "string" ? finding.code : null,
        severity: typeof finding.severity === "string" ? finding.severity : null,
      };
    })
    : [];
  return {
    benchmarkCaseId: caseId,
    caseKind: definition.kind,
    historicalProviderProvenance: definition.historicalProviderProvenance,
    sourceCount: definition.sourceCount,
    rawItemTraceability: definition.rawItemTraceability,
    rawItemId: definition.rawItemId,
    rawContentSha256: definition.rawContentSha256,
    ...(criticControlUsable === undefined ? {} : { criticControlUsable }),
    availableStageInputs: safeStages,
    availableHistoricalOutputs: Object.fromEntries(Object.entries(stages).map(([stage, result]) => [stage, result.historicalOutput])),
    knownHistoricalCriticOutcome: {
      decision: typeof historicalCritic?.decision === "string" ? historicalCritic.decision : "unknown",
      findingCount: typeof historicalCritic?.findingCount === "number" ? historicalCritic.findingCount : criticFindings.length,
      findings: criticFindings,
      evidenceRole: "HISTORICAL_REFERENCE_NOT_GOLD_LABEL",
    },
    missingLineageComponents: caseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem
      ? ["exact Verifier model input bytes were not preserved locally; exact linked raw_items row read is required before future dispatch", "historical Critic nonempty evidence-reference branch is not proven exercised", "no second source for corroboration"]
      : ["rawItemId and original/extracted source content are absent", "no second source for corroboration"],
    copyrightSafeReviewRepresentation: caseId === QUALITY_BENCHMARK_CASE_IDS.arsProblem
      ? {
        representation: "bounded factual inventory and stage summaries",
        storedInputReferences: Object.values(definition.checkpoints),
        factInventory: [
          "The stored fact describes a Muse transcription vulnerability that could expose an authentication token and enable account compromise through endpoint manipulation.",
          "The historical editorial draft added a patch-status or confirmation detail absent from the stored verified fact; Critic flagged an unsupported editorial claim.",
        ],
        noArticleBodyCopied: true,
      }
      : {
        representation: "bounded factual inventory and stage summaries",
        storedInputReferences: Object.values(definition.checkpoints),
        factInventory: [
          "The stored fact concerns OpenAI Foundation funding a proposal for scientific datasets about failed biotechnology companies.",
          "The original source item is not linked to this checkpoint, so the stored fact and clean Critic result cannot be independently checked against the article.",
        ],
        noArticleBodyCopied: true,
      },
  };
}

export function isStoredManifestStageUsable(preparedStage: PreparedBenchmarkStage): boolean {
  return preparedStage.readiness === "READY_FROM_STORED_INPUT" && preparedStage.inputSha256 !== null;
}
