import { validFixtures } from "../contracts/fixtures.ts";
import type { ClusterRunResult } from "../clustering/cluster-types.ts";
import type { DiscoveryRunResult, SourceRegistryEntry } from "../discovery/discovery-types.ts";
import type { ExtractionRunResult } from "../extraction/extraction-types.ts";
import type { PipelineStage, PipelineStageOutcome, PipelineStages } from "./pipeline-types.ts";
import type { CriticResult } from "../contracts/index.ts";
import type { PublisherExecutionResult } from "../publisher/publisher-types.ts";
import { clusteringConfig } from "../clustering/clustering-config.ts";

const sourceId = validFixtures.DiscoveryCandidate.sourceId;
const source: SourceRegistryEntry = { id: sourceId, name: validFixtures.DiscoveryCandidate.sourceName, url: "https://example.com", feedUrl: null, discoveryMethod: "manual", sourceType: "official", countryCode: "US", language: "en", priority: 1 };

export const offlineDiscoveryResult: DiscoveryRunResult = {
  startedAt: "2026-09-16T08:00:00.000Z", finishedAt: "2026-09-16T08:00:00.001Z", hours: 24, sources: [{ source, status: "success", discovered: 1, valid: 1, invalid: 0, undatedExcluded: 0, error: null, durationMs: 1 }], candidates: [validFixtures.DiscoveryCandidate], candidatesDiscovered: 1, duplicateUrls: 0, duplicateContentHashes: 0, invalidCandidates: 0, undatedExcluded: 0, persisted: 0, persistSkipped: 0, persistErrors: 0, traceability: [],
};

export const offlineExtractionResult: ExtractionRunResult = {
  startedAt: offlineDiscoveryResult.startedAt, finishedAt: offlineDiscoveryResult.finishedAt, hours: 24, limit: 1, candidatesSelected: 1, results: [{ candidate: validFixtures.DiscoveryCandidate, status: "success", quality: "full", item: validFixtures.ExtractedItem, contentLength: validFixtures.ExtractedItem.content.length, error: null, durationMs: 1, rawItemId: null }], full: 1, partial: 0, metadataOnly: 0, blocked: 0, failed: 0, averageContentLength: validFixtures.ExtractedItem.content.length, persisted: 0, persistSkipped: 0, persistErrors: 0, traceability: [],
};

export const offlineClusterResult: ClusterRunResult = {
  extractedItems: 1, duplicatesRemoved: 0, events: [validFixtures.ClusteredEvent], multiSourceEvents: 0, singleSourceEvents: 1, largestCluster: 1, needsReview: 0, possibleFalseMerges: [], report: { generatedAt: offlineDiscoveryResult.startedAt, config: clusteringConfig, extractedItems: 1, duplicatesRemoved: 0, pairScores: [], ambiguousPairs: [], clusters: [] }, persistedEvents: 0, persistedEventSources: 0, persistSkipped: 0, persistErrors: 0,
};

function eventOutput<T extends { eventKey: string }>(value: T, eventKey: string): T { return { ...structuredClone(value), eventKey }; }

export type OfflineScenario = {
  verifier?: "success" | "skip" | "fail";
  translator?: "success" | "fail";
  editor?: "success" | "fail";
  classifier?: "success" | "fail";
  ranker?: "success" | "fail";
  critic?: "pass" | "revise" | "reject" | "fail";
  checkpointFailure?: string;
  events?: number;
  failEventKey?: string;
  failStage?: string;
};

export function makeOutcome<T extends { eventKey: string }>(output: T, stage: string, eventKey: string, options: { requests?: number; checkpoint?: boolean } = {}): PipelineStageOutcome<T> {
  return { output: eventOutput(output, eventKey), eventKey, agentVersion: `${stage}-fixture-v1`, model: "mock-offline", attempts: options.requests === 0 ? 0 : 1, retries: 0, providerRequestsUsed: options.requests ?? 1, latencyMs: 1, checkpoint: options.checkpoint === false ? undefined : async () => ({ stage: stage as PipelineStage, path: `memory://${stage}/${eventKey}`, eventKey, written: true, readable: true, valid: true }) };
}

function publisherOutcome(eventKey: string): PipelineStageOutcome<PublisherExecutionResult> {
  return { output: { status: "success", dryRun: true, summary: { idempotencyOutcome: "dry_run_new", transactionAttempted: false, transactionCommitted: false, articleCreated: false, articleUpdated: false, articleId: null, categoriesLinkedCount: 1, entitiesLinkedCount: 1, sourcesLinkedCount: 1, activityRowsCreated: 0 }, writePlan: { publisherVersion: "publisher-v1", eventKey, event: { eventId: "fixture-event-id", operation: "update_existing", eventStatus: "active", reviewStatus: "approved", regionId: "fixture-region-id" }, article: { eventId: "fixture-event-id", existingArticleId: null, operation: "insert", idempotencyKey: "event_id", slug: validFixtures.PublicationPayload.article.slug, publicationStatus: "published" }, eventSources: { operation: "reuse_existing", sourceIds: [sourceId] }, categories: [], entities: [], articleCategories: "upsert_by_article_and_category", articleEntities: "upsert_by_article_and_entity", activityHistory: { operation: "none", reason: "publication_does_not_recalculate_aggregates" } } }, eventKey, agentVersion: "publisher-fixture-v1", model: "orchestrator", attempts: 0, retries: 0, providerRequestsUsed: 0, latencyMs: 0 };
}

export function createOfflineStages(scenario: OfflineScenario = {}): { stages: PipelineStages; calls: string[]; publisherDryRuns: boolean[] } {
  const calls: string[] = [];
  const publisherDryRuns: boolean[] = [];
  const mode = { verifier: "success", translator: "success", editor: "success", classifier: "success", ranker: "success", critic: "pass", ...scenario };
  const call = <T extends { eventKey: string }>(stage: string, output: T, contextEventKey: string, options: { requests?: number; checkpoint?: boolean } = {}): Promise<PipelineStageOutcome<T>> => {
    calls.push(stage);
    if (mode[stage as keyof typeof mode] === "fail" || scenario.failEventKey === contextEventKey && scenario.failStage === stage) return Promise.reject(new Error(`${stage}_fixture_failure`));
    if (scenario.checkpointFailure === stage) return Promise.resolve(makeOutcome(output, stage, contextEventKey, { ...options, checkpoint: false }));
    return Promise.resolve(makeOutcome(output, stage, contextEventKey, options));
  };
  const stages: PipelineStages = {
    async discovery() { calls.push("discovery"); return offlineDiscoveryResult; },
    async extraction() { calls.push("extraction"); return offlineExtractionResult; },
    async clustering() { calls.push("clustering"); return offlineClusterResult; },
    sourceMetadata: () => [{ sourceId, sourceItemId: validFixtures.ExtractedItem.candidateId, rawItemId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceName: source.name, sourceUrl: validFixtures.ExtractedItem.canonicalUrl, language: "en", sourceType: "official", countryCode: "US" }],
    verifier: (context) => {
      const output = mode.verifier === "skip" ? { ...validFixtures.VerificationResult, verifiedFacts: [], status: "single_source" as const } : validFixtures.VerificationResult;
      return call("verifier", output, context.event.eventKey);
    },
    translator: (context) => call("translator", validFixtures.TranslationResult, context.event.eventKey),
    editor: (context) => call("editor", validFixtures.EditorialDraft, context.event.eventKey),
    classifier: (context) => call("classifier", validFixtures.ClassificationResult, context.event.eventKey),
    geo: (context) => call("geo", { eventKey: context.event.eventKey, primaryRegionCode: "US", countryCodes: ["US"], latitude: 39.8283, longitude: -98.5795, resolutionLevel: "region" as const, resolvedFrom: "region_registry" as const, provenance: "reference_registry" as const }, context.event.eventKey, { requests: 0, checkpoint: false }),
    ranker: (context) => call("ranker", validFixtures.RankingResult, context.event.eventKey),
    critic: (context) => {
      const decision = mode.critic === "revise" ? "revise_editorial" : mode.critic === "reject" ? "reject" : "pass";
      return call("critic", { ...validFixtures.CriticResult, decision } as CriticResult, context.event.eventKey);
    },
    publisher: (context, _run, options) => { calls.push("publisher"); publisherDryRuns.push(options.dryRun); return Promise.resolve(publisherOutcome(context.event.eventKey)); },
  };
  return { stages, calls, publisherDryRuns };
}
