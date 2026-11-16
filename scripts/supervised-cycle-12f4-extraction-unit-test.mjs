import assert from "node:assert/strict";
import { deduplicateCandidates } from "../lib/agents/discovery/discovery-runner.ts";
import { extractCandidate } from "../lib/agents/extraction/extraction-runner.ts";
import { emptyArticleHtml, normalArticleHtml } from "../lib/agents/extraction/fixtures.ts";
import { createOfflineStages, offlineClusterResult, offlineDiscoveryResult } from "../lib/agents/pipeline/pipeline-fixtures.ts";
import { createStaticPipelineQuota, InMemoryPipelineEventAttemptRegistry, PipelineOrchestrator, supervisedSchedulerOutcome } from "../lib/agents/pipeline/index.ts";
import { createLoggerPipelinePersistence } from "../lib/agents/pipeline/pipeline-observability.ts";
import { SUPERVISED_EXTRACTION_CANDIDATE_LIMIT } from "../lib/agents/pipeline/supervised-throughput-policy.ts";
import { InMemoryAgentLogger } from "../lib/agents/runtime/agent-logger.ts";
import { validFixtures } from "../lib/agents/contracts/fixtures.ts";

const originalFetch = globalThis.fetch;
const baseCandidate = structuredClone(validFixtures.DiscoveryCandidate);
// This is a historical evidence fixture, independent of today's selector.
const historical12f4ExtractionSelectionLimit = 3;
const makeCandidate = (index, overrides = {}) => ({
  ...baseCandidate,
  externalId: `12f4-fixture-${index}`,
  url: `https://fixture-${index}.example.test/article`,
  titleOriginal: `Synthetic story ${index}`,
  excerptOriginal: null,
  ...overrides,
});

try {
  globalThis.fetch = async () => new Response(normalArticleHtml, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const knownSource = await extractCandidate(makeCandidate("known", { sourceName: "Known fixture source" }));
  const unknownSource = await extractCandidate(makeCandidate("unknown", { sourceName: "Unknown fixture source" }));
  assert.equal(knownSource.status, "success");
  assert.ok(knownSource.item, "known accessible article yields an ExtractedItem");
  assert.equal(unknownSource.status, "success", "source identity is not required by the generic extractor");
  assert.ok(unknownSource.item);
  assert.ok(!knownSource.item.content.includes("Navigation noise"));

  let blockedBodyRead = false;
  globalThis.fetch = async () => {
    const response = new Response("synthetic denial body", { status: 403 });
    response.text = async () => { blockedBodyRead = true; return "synthetic denial body"; };
    return response;
  };
  const blocked = await extractCandidate(makeCandidate("blocked"));
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.error?.code, "blocked");
  assert.equal(blocked.error?.statusCode, 403);
  assert.equal(blocked.item, null);
  assert.equal(blockedBodyRead, false, "non-OK response is rejected before reading its body or invoking Readability");

  globalThis.fetch = async () => new Response(emptyArticleHtml, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const empty = await extractCandidate(makeCandidate("empty"));
  assert.equal(empty.status, "failed");
  assert.equal(empty.error?.code, "empty_content");
  assert.equal(empty.item, null);

  const duplicateRecords = [
    { candidate: makeCandidate("duplicate-a"), canonicalUrl: "https://example.test/story", contentHash: null },
    { candidate: makeCandidate("duplicate-b"), canonicalUrl: "https://example.test/story", contentHash: null },
  ];
  const deduplicated = deduplicateCandidates(duplicateRecords);
  assert.equal(deduplicated.records.length, 1);
  assert.equal(deduplicated.duplicateUrls, 1);

  const fixture = createOfflineStages();
  const candidates = Array.from({ length: 45 }, (_, index) => makeCandidate(index));
  const historical12f4SelectedCandidates = candidates.slice(0, historical12f4ExtractionSelectionLimit);
  const historical12f4TerminalOutcomes = historical12f4SelectedCandidates.map(() => "FETCH_BLOCKED");
  assert.equal(historical12f4ExtractionSelectionLimit, 3, "the historical 12F.4 extraction selection cap remains three");
  assert.equal(historical12f4SelectedCandidates.length, 3, "the historical 12F.4 reconstruction retains three selected candidates");
  assert.deepEqual(historical12f4TerminalOutcomes, ["FETCH_BLOCKED", "FETCH_BLOCKED", "FETCH_BLOCKED"], "the recovered historical run has three blocked extraction outcomes");

  fixture.stages.discovery = async () => {
    fixture.calls.push("discovery");
    return {
      ...offlineDiscoveryResult,
      candidates,
      candidatesDiscovered: candidates.length,
      duplicateUrls: 0,
      duplicateContentHashes: 0,
    };
  };
  let extractedCandidateCount = 0;
  fixture.stages.extraction = async ({ discovery }) => {
    fixture.calls.push("extraction");
    extractedCandidateCount = discovery.candidates.length;
    const results = [];
    for (const candidate of discovery.candidates) {
      const result = await extractCandidate(candidate);
      results.push({ ...result, rawItemId: null });
    }
    return {
      startedAt: offlineDiscoveryResult.startedAt,
      finishedAt: offlineDiscoveryResult.finishedAt,
      hours: 24,
      limit: 1,
      candidatesSelected: discovery.candidates.length,
      results,
      full: results.filter((result) => result.quality === "full").length,
      partial: results.filter((result) => result.quality === "partial" && result.item !== null).length,
      metadataOnly: results.filter((result) => result.quality === "metadata_only").length,
      blocked: results.filter((result) => result.status === "blocked").length,
      failed: results.filter((result) => result.status === "failed").length,
      averageContentLength: 0,
      persisted: 0,
      persistSkipped: 0,
      persistErrors: 0,
      traceability: [],
    };
  };
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("fixture-0") || url.includes("fixture-1")) {
      return new Response("synthetic denial body", { status: 403 });
    }
    return new Response(emptyArticleHtml, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  fixture.stages.clustering = async ({ extraction }) => {
    fixture.calls.push("clustering");
    const extractedItems = extraction.results.filter((result) => result.item !== null).length;
    return {
      ...offlineClusterResult,
      extractedItems,
      events: [],
      multiSourceEvents: 0,
      singleSourceEvents: 0,
      largestCluster: 0,
      report: { ...offlineClusterResult.report, extractedItems, clusters: [] },
    };
  };
  const logger = new InMemoryAgentLogger();
  const pipelineResult = await new PipelineOrchestrator({
    stages: fixture.stages,
    quota: createStaticPipelineQuota(6),
    persistence: createLoggerPipelinePersistence(logger),
    attemptRegistry: new InMemoryPipelineEventAttemptRegistry(),
    humanReviewGateway: {},
    runId: "44444444-4444-4444-8444-444444444444",
    now: () => new Date("2026-10-10T12:00:00.000Z"),
    config: {
      mode: "supervised",
      dryRun: true,
      publish: false,
      hours: 24,
      limit: 1,
      automaticRevision: false,
      maxRevisionAttempts: 1,
    },
  }).run();

  assert.equal(extractedCandidateCount, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT, "the current supervised selector applies its authoritative cap");
  assert.ok(extractedCandidateCount <= 6, "the current selector does not exceed the 12F.5B cap");
  assert.equal(pipelineResult.candidatesDiscovered, 45);
  assert.equal(pipelineResult.extractedItems, 0);
  assert.equal(pipelineResult.clusteredEvents, 0);
  assert.equal(pipelineResult.eventsAttempted, 0);
  assert.equal(pipelineResult.providerRequestsUsed, 0);
  assert.deepEqual(pipelineResult.extractionSummary.candidateOutcomes.map((outcome) => outcome.candidateId), candidates.slice(0, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT).map((candidate) => candidate.externalId), "current extraction keeps the first selected candidates without replacement");
  assert.equal(/"(?:content|rawContent|title|url|excerpt|body)"\s*:/i.test(JSON.stringify(pipelineResult.extractionSummary)), false, "candidate-level durable telemetry contains no body, excerpt, or content fields");
  assert.deepEqual(pipelineResult.extractionSummary, {
    candidatesSelected: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT,
    extractedItems: 0,
    successfulResults: 0,
    blockedResults: 2,
    failedResults: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT - 2,
    errorCodeCounts: { blocked: 2, empty_content: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT - 2 },
    persisted: 0,
    persistUpdated: 0,
    persistSkipped: 0,
    persistErrors: 0,
    extractionAttempts: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT,
    unexpectedResults: 0,
    extractionSucceeded: 0,
    extractionFailed: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT,
    extractionSkipped: 0,
    rawItemsTouched: 0,
    rawItemsInserted: 0,
    rawItemsUpdated: 0,
    rawItemsReused: 0,
    rawItemPersistenceErrors: 0,
    candidateOutcomes: candidates.slice(0, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT).map((candidate, index) => ({
      candidateId: candidate.externalId,
      sourceId: baseCandidate.sourceId,
      rawItemId: null,
      discoveryRawItemMapping: "NOT_REQUESTED",
      extractionRawItemMapping: "NOT_REQUESTED",
      extractionAttempted: true,
      fetchOutcome: index < 2 ? "BLOCKED" : "SUCCEEDED",
      extractionOutcome: "FAILED",
      failureCode: index < 2 ? "blocked" : "empty_content",
      parserOutcome: index < 2 ? "NOT_REACHED" : "SUCCEEDED",
      qualityGateOutcome: "NOT_REACHED",
      terminalOutcome: index < 2 ? "FETCH_BLOCKED" : "EMPTY_BODY",
    })),
  });
  assert.deepEqual(logger.runs[0].stats?.extractionSummary, pipelineResult.extractionSummary, "safe extraction aggregate is persisted with the run summary");
  assert.deepEqual(fixture.calls, ["discovery", "extraction", "clustering"]);
  assert.equal(fixture.calls.some((stage) => ["verifier", "translator", "editor", "classifier", "ranker", "critic", "publisher"].includes(stage)), false);
  assert.deepEqual(supervisedSchedulerOutcome(pipelineResult), {
    runStatus: "succeeded",
    finalDecision: "allowed",
    schedulerDecision: "NO_ELIGIBLE_EXTRACTED_ITEMS",
    stopReason: "NO_ELIGIBLE_EXTRACTED_ITEMS",
  });
  assert.deepEqual(supervisedSchedulerOutcome({
    ...pipelineResult,
    extractionSummary: {
      ...pipelineResult.extractionSummary,
      failedResults: 3,
      errorCodeCounts: { parse_error: 1 },
      candidateOutcomes: pipelineResult.extractionSummary.candidateOutcomes.map((outcome, index) => index === 2 ? { ...outcome, parserOutcome: "FAILED", failureCode: "parse_error", terminalOutcome: "PARSER_FAILED" } : outcome),
    },
  }), {
    runStatus: "failed",
    finalDecision: "failed",
    schedulerDecision: "TECHNICAL_FAILURE",
    stopReason: "EXTRACTION_OUTCOME_UNRESOLVED",
  }, "unknown/parser failures are not relabeled as a safe no-eligible result");
  assert.deepEqual(supervisedSchedulerOutcome({
    ...pipelineResult,
    extractionSummary: {
      ...pipelineResult.extractionSummary,
      persistErrors: 1,
      rawItemPersistenceErrors: 1,
      candidateOutcomes: pipelineResult.extractionSummary.candidateOutcomes.map((outcome, index) => index === 2 ? { ...outcome, extractionRawItemMapping: "FAILED", failureCode: "RAW_ITEM_PERSISTENCE_FAILED", terminalOutcome: "PERSISTENCE_FAILED" } : outcome),
    },
  }), {
    runStatus: "failed",
    finalDecision: "failed",
    schedulerDecision: "TECHNICAL_FAILURE",
    stopReason: "EXTRACTION_OUTCOME_UNRESOLVED",
  }, "persistence errors remain technical failures");

  const runSyntheticLifecycle = async ({ specs, persistenceByCandidate = {}, discoveryPersistenceWasEnabled = false } = {}) => {
    const local = createOfflineStages();
    local.stages.discovery = async () => {
      const candidateMappings = { ...persistenceByCandidate };
      if (discoveryPersistenceWasEnabled && !candidateMappings[candidates[10].externalId]) candidateMappings[candidates[10].externalId] = {
        sourceItemId: candidates[10].externalId, sourceId: candidates[10].sourceId, rawItemId: "synthetic-unselected-raw", outcome: "created",
      };
      const outcomes = candidates.map((candidate) => candidateMappings[candidate.externalId] ?? (discoveryPersistenceWasEnabled
        ? undefined
        : { sourceItemId: candidate.externalId, sourceId: candidate.sourceId, rawItemId: null, outcome: "not_requested" }));
      const traceability = outcomes.filter((item) => item && ["created", "reused", "updated"].includes(item.outcome)).map((item) => ({
        sourceItemId: item.sourceItemId, sourceId: item.sourceId, rawItemId: item.rawItemId,
        action: item.outcome === "created" ? "created" : "reused", updated: item.outcome === "updated",
      }));
      return {
        ...offlineDiscoveryResult,
        candidates,
        candidatesDiscovered: 45,
        duplicateUrls: 0,
        duplicateContentHashes: 0,
        persisted: outcomes.filter((item) => item?.outcome === "created").length,
        persistSkipped: outcomes.filter((item) => item?.outcome === "reused").length,
        persistErrors: outcomes.filter((item) => item?.outcome === "failed").length,
        traceability,
        persistenceOutcomes: outcomes.filter(Boolean),
      };
    };
    local.stages.extraction = async ({ discovery }) => {
      const results = specs.map((spec, index) => {
        const candidate = discovery.candidates[index];
        return {
          candidate,
          status: spec.status,
          quality: spec.status === "success" ? "full" : "failed",
          item: spec.status === "success" ? { ...validFixtures.ExtractedItem, candidateId: candidate.externalId } : null,
          contentLength: spec.status === "success" ? validFixtures.ExtractedItem.content.length : 0,
          error: spec.code ? { code: spec.code, message: "synthetic outcome" } : null,
          durationMs: 1,
          rawItemId: spec.rawItemId ?? null,
          attempted: spec.attempted ?? true,
          fetchOutcome: spec.fetchOutcome,
          parserOutcome: spec.parserOutcome,
          rawItemMappingOutcome: spec.rawItemMappingOutcome ?? "not_requested",
          rawItemUpdated: spec.rawItemMappingOutcome === "updated",
        };
      });
      const traceability = results.filter((result) => result.rawItemId && ["created", "updated", "reused"].includes(result.rawItemMappingOutcome)).map((result) => ({
        sourceItemId: result.candidate.externalId,
        sourceId: result.candidate.sourceId,
        rawItemId: result.rawItemId,
        action: result.rawItemMappingOutcome === "created" ? "created" : "reused",
        updated: result.rawItemMappingOutcome === "updated",
      }));
      return {
        startedAt: offlineDiscoveryResult.startedAt,
        finishedAt: offlineDiscoveryResult.finishedAt,
        hours: 24,
        limit: 1,
        candidatesSelected: discovery.candidates.length,
        results,
        full: results.filter((result) => result.quality === "full").length,
        partial: 0,
        metadataOnly: 0,
        blocked: results.filter((result) => result.status === "blocked").length,
        failed: results.filter((result) => result.status === "failed").length,
        averageContentLength: 0,
        persisted: traceability.filter((item) => item.action === "created").length,
        persistUpdated: traceability.filter((item) => item.updated).length,
        persistSkipped: traceability.filter((item) => item.action === "reused" && !item.updated).length,
        persistErrors: specs.filter((spec) => spec.rawItemMappingOutcome === "failed").length,
        traceability,
      };
    };
    local.stages.clustering = async () => ({
      ...offlineClusterResult,
      extractedItems: 0,
      events: [],
      multiSourceEvents: 0,
      singleSourceEvents: 0,
      largestCluster: 0,
      report: { ...offlineClusterResult.report, extractedItems: 0, clusters: [] },
    });
    const logger = new InMemoryAgentLogger();
    const result = await new PipelineOrchestrator({
      stages: local.stages,
      quota: createStaticPipelineQuota(6),
      persistence: createLoggerPipelinePersistence(logger),
      attemptRegistry: new InMemoryPipelineEventAttemptRegistry(),
      humanReviewGateway: {},
      now: () => new Date("2026-10-10T12:00:00.000Z"),
      config: { mode: "supervised", dryRun: true, publish: false, hours: 24, limit: 1, automaticRevision: false, maxRevisionAttempts: 1 },
    }).run();
    return { result, logger };
  };

  const blockedSpec = { status: "blocked", code: "blocked", fetchOutcome: "blocked", parserOutcome: "not_reached" };
  const allBlockedSpecs = Array.from({ length: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT }, () => blockedSpec);
  const allBlocked = await runSyntheticLifecycle({ specs: allBlockedSpecs });
  assert.equal(allBlocked.result.extractionSummary.extractionAttempts, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT);
  assert.equal(allBlocked.result.extractionSummary.extractionFailed, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT);
  assert.equal(allBlocked.result.extractionSummary.extractionSkipped, 0);
  assert.equal(supervisedSchedulerOutcome(allBlocked.result).schedulerDecision, "NO_ELIGIBLE_EXTRACTED_ITEMS", "complete blocked outcomes for every current selected candidate are a safe zero-item terminal");

  const partialSuccess = await runSyntheticLifecycle({ specs: [
    { status: "success", fetchOutcome: "succeeded", parserOutcome: "succeeded" },
    ...Array.from({ length: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT - 1 }, () => blockedSpec),
  ] });
  assert.equal(partialSuccess.result.extractionSummary.extractedItems, 1);
  assert.equal(supervisedSchedulerOutcome(partialSuccess.result).schedulerDecision, "COMPLETED", "one successful extraction is not a zero-item terminal");

  const persistenceByCandidate = Object.fromEntries(candidates.slice(0, 3).map((candidate, index) => [candidate.externalId, {
    sourceItemId: candidate.externalId,
    sourceId: candidate.sourceId,
    rawItemId: `synthetic-raw-${index + 1}`,
    outcome: index === 1 ? "reused" : "created",
  }]));
  for (const candidate of candidates.slice(3, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT)) {
    persistenceByCandidate[candidate.externalId] = { sourceItemId: candidate.externalId, sourceId: candidate.sourceId, rawItemId: null, outcome: "not_requested" };
  }
  const mapped = await runSyntheticLifecycle({ specs: allBlockedSpecs, persistenceByCandidate, discoveryPersistenceWasEnabled: true });
  assert.deepEqual(mapped.result.extractionSummary.candidateOutcomes.slice(0, 3).map((item) => [item.candidateId, item.rawItemId, item.discoveryRawItemMapping]), [
    [candidates[0].externalId, "synthetic-raw-1", "CREATED"],
    [candidates[1].externalId, "synthetic-raw-2", "REUSED"],
    [candidates[2].externalId, "synthetic-raw-3", "CREATED"],
  ], "selected candidates preserve exact source/raw-item mapping for created and deduplicated rows");
  assert.equal(mapped.result.extractionSummary.rawItemsTouched, 4);
  assert.equal(mapped.result.extractionSummary.rawItemsInserted, 3);
  assert.equal(mapped.result.extractionSummary.rawItemsReused, 1);
  assert.equal(mapped.result.discoverySummary.discoveredCandidates, 45);
  assert.equal(mapped.result.discoverySummary.candidatesAfterDeduplication, 45);
  assert.equal(mapped.result.discoverySummary.rawItemsInserted, 3);
  assert.equal(mapped.result.discoverySummary.rawItemsReused, 1);
  assert.equal(mapped.result.extractionSummary.extractionAttempts, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT);
  assert.deepEqual(mapped.logger.runs[0].stats?.discoverySummary, mapped.result.discoverySummary);

  const unmapped = await runSyntheticLifecycle({ specs: allBlockedSpecs, discoveryPersistenceWasEnabled: true });
  assert.equal(unmapped.result.extractionSummary.candidateOutcomes[0].discoveryRawItemMapping, "NOT_RECORDED");
  assert.equal(supervisedSchedulerOutcome(unmapped.result).schedulerDecision, "TECHNICAL_FAILURE", "an unaccounted persistence mapping prevents the safe terminal");

  const missingTerminal = await runSyntheticLifecycle({ specs: [blockedSpec, blockedSpec] });
  assert.equal(missingTerminal.result.extractionSummary.extractionSkipped, SUPERVISED_EXTRACTION_CANDIDATE_LIMIT - 2);
  assert.equal(missingTerminal.result.extractionSummary.candidateOutcomes[2].terminalOutcome, "NOT_ATTEMPTED");
  assert.equal(supervisedSchedulerOutcome(missingTerminal.result).schedulerDecision, "TECHNICAL_FAILURE");

  const parserFailure = await runSyntheticLifecycle({ specs: [blockedSpec, blockedSpec, { status: "failed", code: "parse_error", fetchOutcome: "succeeded", parserOutcome: "failed" }, ...Array.from({ length: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT - 3 }, () => blockedSpec)] });
  assert.equal(parserFailure.result.extractionSummary.candidateOutcomes[2].terminalOutcome, "PARSER_FAILED");
  assert.equal(supervisedSchedulerOutcome(parserFailure.result).schedulerDecision, "TECHNICAL_FAILURE");

  const unknownFailure = await runSyntheticLifecycle({ specs: [blockedSpec, blockedSpec, { status: "failed", code: "unclassified_failure", fetchOutcome: "failed", parserOutcome: "not_reached" }, ...Array.from({ length: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT - 3 }, () => blockedSpec)] });
  assert.equal(unknownFailure.result.extractionSummary.candidateOutcomes[2].terminalOutcome, "FETCH_FAILED");
  assert.equal(supervisedSchedulerOutcome(unknownFailure.result).schedulerDecision, "TECHNICAL_FAILURE", "unknown error codes remain technical even when they are candidate-scoped");

  const persistFailure = await runSyntheticLifecycle({ specs: [blockedSpec, blockedSpec, { ...blockedSpec, rawItemMappingOutcome: "failed" }, ...Array.from({ length: SUPERVISED_EXTRACTION_CANDIDATE_LIMIT - 3 }, () => blockedSpec)] });
  assert.equal(persistFailure.result.extractionSummary.candidateOutcomes[2].terminalOutcome, "PERSISTENCE_FAILED");
  assert.equal(persistFailure.result.extractionSummary.rawItemPersistenceErrors, 1);
  assert.equal(supervisedSchedulerOutcome(persistFailure.result).schedulerDecision, "TECHNICAL_FAILURE");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("12F.4 extraction diagnosis offline regressions passed");
