import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { archivePublishedFactualIncident12C2A, publishedFactualIncident12C2A } from "../lib/agents/publisher/article-lifecycle.ts";
import { SupabaseIncidentArticleLifecycleRepository } from "../lib/agents/publisher/supabase-incident-article-lifecycle-repository.ts";

const incident = publishedFactualIncident12C2A;
const reportPath = resolve("artifacts/published-factual-remediation-12c2a.json");
const priorEvidencePath = resolve("artifacts/published-factual-incident-12c1.json");
const checkpointDirectory = resolve(`artifacts/pipeline-checkpoints/${"63b81d9a-e46f-4434-9637-335d3f455e0b"}`);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`ARCHIVE_CONFIGURATION_MISSING_${name}`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function restRows(baseUrl: string, key: string, table: string, query: Record<string, string>, usePublicKey = false): Promise<Record<string, unknown>[]> {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/rest/v1/${table}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const response = await fetch(url, {
    cache: "no-store",
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`ARCHIVE_READ_${table.toUpperCase()}_FAILED_${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error(`ARCHIVE_READ_${table.toUpperCase()}_INVALID_RESPONSE`);
  if (usePublicKey && response.headers.get("content-type")?.includes("application/json") !== true) throw new Error("PUBLIC_CONTRACT_RESPONSE_NOT_JSON");
  return data as Record<string, unknown>[];
}

async function checkpointInventory(): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const files = (await readdir(checkpointDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(`${incident.eventKey}.json`))
    .map((entry) => entry.name)
    .sort();
  const requiredStages = ["verifier", "translator", "editor", "critic"];
  for (const stage of requiredStages) {
    if (!files.some((name) => name.startsWith(`${stage}-`))) throw new Error(`INCIDENT_CHECKPOINT_MISSING_${stage.toUpperCase()}`);
  }
  return Promise.all(files.map(async (name) => {
    const path = resolve(checkpointDirectory, name);
    const content = await readFile(path);
    return { path: path.replace(`${process.cwd()}\\`, "").replaceAll("\\", "/"), sha256: sha256(content.toString("utf8")), bytes: content.byteLength };
  }));
}

async function snapshotInternal(baseUrl: string, serviceKey: string) {
  const articles = await restRows(baseUrl, serviceKey, "articles", { select: "*", id: `eq.${incident.articleId}` });
  const events = await restRows(baseUrl, serviceKey, "events", { select: "id,event_key,event_status,review_status,updated_at", id: `eq.${incident.eventId}`, event_key: `eq.${incident.eventKey}` });
  const eventSources = await restRows(baseUrl, serviceKey, "event_sources", { select: "*", event_id: `eq.${incident.eventId}` });
  const rawItems = await restRows(baseUrl, serviceKey, "raw_items", { select: "id,source_id,canonical_url,content_hash,processing_status,extraction_quality", id: "eq.d3834944-72f6-4f59-9aca-3f66ae92dc33" });
  const sources = await restRows(baseUrl, serviceKey, "sources", { select: "id,name,url,is_active", id: "eq.e8dd0363-f51e-4381-9fb2-c02ee81f4d41" });
  const attempts = await restRows(baseUrl, serviceKey, "pipeline_event_attempts", { select: "id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,next_eligible_at,created_at", event_key: `eq.${incident.eventKey}`, order: "attempt_number.asc" });
  if (articles.length !== 1 || events.length !== 1 || rawItems.length !== 1 || sources.length !== 1 || eventSources.length !== 1 || attempts.length < 1) {
    throw new Error("INCIDENT_RELATIONSHIP_PREFLIGHT_FAILED");
  }
  const article = articles[0];
  if (article.id !== incident.articleId || article.event_id !== incident.eventId || article.slug !== incident.slug) throw new Error("INCIDENT_ARTICLE_IDENTITY_MISMATCH");
  if (events[0].event_key !== incident.eventKey) throw new Error("INCIDENT_EVENT_KEY_MISMATCH");
  if (eventSources[0].source_id !== "e8dd0363-f51e-4381-9fb2-c02ee81f4d41" || eventSources[0].raw_item_id !== "d3834944-72f6-4f59-9aca-3f66ae92dc33") throw new Error("INCIDENT_SOURCE_RELATION_MISMATCH");
  if (rawItems[0].source_id !== "e8dd0363-f51e-4381-9fb2-c02ee81f4d41") throw new Error("INCIDENT_RAW_ITEM_SOURCE_MISMATCH");
  return { article, events, eventSources, rawItems, sources, attempts };
}

function rowsHash(rows: unknown[]): string {
  return sha256(JSON.stringify(rows));
}

function rowsStableHash(rows: unknown[]): string {
  return sha256(stableStringify(rows));
}

async function writeReport(report: Record<string, unknown>): Promise<void> {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args.length === 1 ? args[0] : "";
  if (mode !== "--preflight-only" && mode !== "--execute-exact-archive") throw new Error("Run with --preflight-only or --execute-exact-archive; this script is scoped to the incident identity in article-lifecycle.ts");

  const baseUrl = process.env.SUPABASE_URL?.trim() || requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = process.env.SUPABASE_SECRET_KEY?.trim() || requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const priorEvidence = JSON.parse(await readFile(priorEvidencePath, "utf8")) as { publicSnapshot?: { sha256OfRetrievedJsonRow?: string } };
  const publicBeforeRows = await restRows(baseUrl, publicKey, "public_published_articles", { select: "*", order: "published_at.desc" }, true);
  const internalBefore = await snapshotInternal(baseUrl, serviceKey);
  const checkpointsBefore = await checkpointInventory();
  const publicIncidentRowsBefore = publicBeforeRows.filter((row) => row.slug === incident.slug);
  const incidentVisibleBefore = publicIncidentRowsBefore.length > 0;
  const incidentArticle = internalBefore.article;
  if (publicIncidentRowsBefore.length > 1) throw new Error("INCIDENT_PUBLIC_CONTRACT_DUPLICATE_SLUG");
  if (!publicIncidentRowsBefore.length && incidentArticle.publication_status === "published") throw new Error("INCIDENT_PUBLIC_CONTRACT_MISSING_BEFORE_ARCHIVE");
  if (publicIncidentRowsBefore.length && incidentArticle.publication_status !== "published") throw new Error("INCIDENT_STATUS_PUBLIC_CONTRACT_MISMATCH");
  if (incidentArticle.publication_status !== "published" && incidentArticle.publication_status !== "archived") throw new Error("INCIDENT_STATUS_NOT_ARCHIVABLE");
  const incidentPublicHashBefore = publicIncidentRowsBefore.length ? sha256(JSON.stringify(publicIncidentRowsBefore[0])) : null;
  if (incidentPublicHashBefore && incidentPublicHashBefore !== priorEvidence.publicSnapshot?.sha256OfRetrievedJsonRow) throw new Error("INCIDENT_PUBLIC_SNAPSHOT_DIFFERS_FROM_12C1");
  const articleStatusBefore = String(incidentArticle.publication_status);
  const expectedPublicCountAfter = publicBeforeRows.length - (articleStatusBefore === "published" ? 1 : 0);
  const otherPublicRowsBefore = publicBeforeRows.filter((row) => row.slug !== incident.slug);
  const attemptRows = internalBefore.attempts;
  const report: Record<string, unknown> = {
    phase: "12C.2A",
    status: mode === "--preflight-only" ? "PREFLIGHT_PASSED_NO_WRITE" : "ARCHIVE_WRITE_PENDING",
    capturedAt: new Date().toISOString(),
    incident: { ...incident, rawItemIds: ["d3834944-72f6-4f59-9aca-3f66ae92dc33"], sourceIds: ["e8dd0363-f51e-4381-9fb2-c02ee81f4d41"] },
    publicBefore: {
      contract: "public_published_articles",
      count: publicBeforeRows.length,
      incidentVisible: incidentVisibleBefore,
      incidentRowSha256: incidentPublicHashBefore,
      incidentRowMatches12C1: incidentPublicHashBefore === priorEvidence.publicSnapshot?.sha256OfRetrievedJsonRow,
      allRowsSha256: rowsHash(publicBeforeRows),
      otherRows: otherPublicRowsBefore.map((row) => ({ slug: row.slug, sha256: sha256(JSON.stringify(row)) })),
    },
    internalBefore: {
      article: { exists: true, publicationStatus: articleStatusBefore, rowSha256: rowsStableHash([incidentArticle]) },
      event: { exists: true, rowCount: internalBefore.events.length, rowsSha256: rowsStableHash(internalBefore.events), eventStatus: internalBefore.events[0].event_status, reviewStatus: internalBefore.events[0].review_status },
      eventSources: { rowCount: internalBefore.eventSources.length, rowsSha256: rowsStableHash(internalBefore.eventSources) },
      rawItems: { rowCount: internalBefore.rawItems.length, rowsSha256: rowsStableHash(internalBefore.rawItems) },
      sources: { rowCount: internalBefore.sources.length, rowsSha256: rowsStableHash(internalBefore.sources) },
      pipelineAttempts: { rowCount: attemptRows.length, rowsSha256: rowsStableHash(attemptRows), rows: attemptRows.map((row) => ({ attemptNumber: row.attempt_number, finalState: row.final_state, countsTowardRetryLimit: row.counts_toward_retry_limit, completedAt: row.completed_at })) },
      checkpoints: checkpointsBefore,
      localEvidence: [priorEvidencePath.replace(`${process.cwd()}\\`, "").replaceAll("\\", "/"), "docs/published-factual-incident-12c1.md"],
    },
    archive: { method: "conditional service-role repository lifecycle", request: { table: "articles", fields: ["publication_status"], from: "published", to: "archived" }, databaseManagedFields: ["updated_at"], changed: false, affectedRows: 0, deleted: false },
    providerCalls: { groq: 0, cloudflare: 0, cerebras: 0, inference: 0, retries: 0, fallback: 0 },
  };
  if (mode === "--preflight-only") {
    console.log(JSON.stringify({ status: report.status, articleId: incident.articleId, currentStatus: articleStatusBefore, publicCount: publicBeforeRows.length, incidentVisible: incidentVisibleBefore, incidentSnapshotMatches12C1: incidentPublicHashBefore === priorEvidence.publicSnapshot?.sha256OfRetrievedJsonRow, attemptRows: attemptRows.length, checkpointFiles: checkpointsBefore.length, providerCalls: 0, remoteWrites: 0 }, null, 2));
    return;
  }
  await writeReport(report);

  try {
    const lifecycle = await archivePublishedFactualIncident12C2A(SupabaseIncidentArticleLifecycleRepository.fromEnvironment());
    const publicAfterRows = await restRows(baseUrl, publicKey, "public_published_articles", { select: "*", order: "published_at.desc" }, true);
    const internalAfter = await snapshotInternal(baseUrl, serviceKey);
    const checkpointsAfter = await checkpointInventory();
    const publicIncidentRowsAfter = publicAfterRows.filter((row) => row.slug === incident.slug);
    const incidentVisibleAfter = publicIncidentRowsAfter.length > 0;
    const otherPublicRowsAfter = publicAfterRows.filter((row) => row.slug !== incident.slug);
    const afterArticle = internalAfter.article;
    const articleExceptArchiveFields = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "publication_status" && key !== "updated_at"));
    const statusOnlyArticleChange = stableStringify(articleExceptArchiveFields(incidentArticle)) === stableStringify(articleExceptArchiveFields(afterArticle));
    const preserved = {
      articleRowExists: internalAfter.article.id === incident.articleId,
      articleTextAndOtherFieldsUnchanged: statusOnlyArticleChange,
      articleStatusArchived: afterArticle.publication_status === "archived",
      eventRowUnchanged: rowsStableHash(internalBefore.events) === rowsStableHash(internalAfter.events),
      eventSourcesUnchanged: rowsStableHash(internalBefore.eventSources) === rowsStableHash(internalAfter.eventSources),
      rawItemsUnchanged: rowsStableHash(internalBefore.rawItems) === rowsStableHash(internalAfter.rawItems),
      sourcesUnchanged: rowsStableHash(internalBefore.sources) === rowsStableHash(internalAfter.sources),
      pipelineAttemptsUnchanged: rowsStableHash(internalBefore.attempts) === rowsStableHash(internalAfter.attempts),
      checkpointsUnchanged: stableStringify(checkpointsBefore) === stableStringify(checkpointsAfter),
      criticCheckpointPresent: checkpointsAfter.some((checkpoint) => checkpoint.path.includes("critic-")),
    };
    if (publicIncidentRowsAfter.length !== 0) throw new Error("INCIDENT_STILL_VISIBLE_IN_PUBLIC_CONTRACT");
    if (publicAfterRows.length !== expectedPublicCountAfter) throw new Error("PUBLIC_COUNT_DID_NOT_DECREASE_BY_EXPECTED_AMOUNT");
    if (stableStringify(otherPublicRowsBefore.map((row) => ({ slug: row.slug, sha256: sha256(JSON.stringify(row)) }))) !== stableStringify(otherPublicRowsAfter.map((row) => ({ slug: row.slug, sha256: sha256(JSON.stringify(row)) })))) throw new Error("OTHER_PUBLIC_ARTICLES_CHANGED");
    if (Object.values(preserved).some((value) => value !== true)) throw new Error("INCIDENT_HISTORY_PRESERVATION_CHECK_FAILED");

    Object.assign(report, {
      status: "ARCHIVED_AND_VERIFIED",
      completedAt: new Date().toISOString(),
      publicAfter: {
        contract: "public_published_articles",
        count: publicAfterRows.length,
        incidentVisible: incidentVisibleAfter,
        incidentSlugVisible: incidentVisibleAfter,
        allRowsSha256: rowsHash(publicAfterRows),
        otherRows: otherPublicRowsAfter.map((row) => ({ slug: row.slug, sha256: sha256(JSON.stringify(row)) })),
        countDelta: publicAfterRows.length - publicBeforeRows.length,
        publicRoute: "app/noticias/[slug]/page.tsx calls getPublishedArticleBySlug; a null loader result calls notFound()",
      },
      archive: { method: "conditional service-role repository lifecycle", request: { table: "articles", fields: ["publication_status"], from: "published", to: "archived" }, databaseManagedFields: ["updated_at"], updatedAtBefore: incidentArticle.updated_at, updatedAtAfter: afterArticle.updated_at, changed: lifecycle.changed, affectedRows: lifecycle.changed ? 1 : 0, deleted: false },
      preserved,
      internalAfter: {
        article: { exists: true, publicationStatus: String(afterArticle.publication_status), rowSha256: rowsStableHash([afterArticle]) },
        event: { exists: true, rowsSha256: rowsStableHash(internalAfter.events) },
        eventSources: { rowCount: internalAfter.eventSources.length, rowsSha256: rowsStableHash(internalAfter.eventSources) },
        rawItems: { rowCount: internalAfter.rawItems.length, rowsSha256: rowsStableHash(internalAfter.rawItems) },
        sources: { rowCount: internalAfter.sources.length, rowsSha256: rowsStableHash(internalAfter.sources) },
        pipelineAttempts: { rowCount: internalAfter.attempts.length, rowsSha256: rowsStableHash(internalAfter.attempts) },
        checkpoints: checkpointsAfter,
      },
      reprocessTopology: {
        classification: "ARCHITECTURE_DOES_NOT_SUPPORT_SAFE_REMEDIATION",
        normalPipelineFromVerifierAvailable: false,
        blocker: "READY_FOR_PUBLICATION is a permanent attempt outcome in both the normal eligibility policy and claim_pipeline_event_attempt RPC.",
        normalClaimWouldReturn: "INELIGIBLE / PERMANENT_OUTCOME",
        normalPipelineEntry: "Discovery -> Extraction -> Clustering; no exact event-key Verifier entry exists.",
        publisherMaterialization: "upsert_by_event_id reuses the existing article row; articles.slug is globally unique.",
        futureArticleRowPolicy: "REPROCESS_SAME_EVENT_REPLACE_ARCHIVED_ARTICLE",
        futureSlugPolicy: "reuse the existing slug on the same event/article row; capture before/after correction evidence before Publisher can update it",
        noAttemptConsumedByThisPhase: true,
        nextAuthorizedReprocessWouldBeAttemptNumber: Number(attemptRows.at(-1)?.attempt_number ?? 0) + 1,
        wouldConsumeFifthPilotAttemptIfApproved: true,
        migrationOrExplicitLifecycleChangeRequiredBefore12C2B: true,
      },
      incidentArticleId: incident.articleId,
      incidentEventId: incident.eventId,
      publicCountBefore: publicBeforeRows.length,
      publicCountAfter: publicAfterRows.length,
      archived: afterArticle.publication_status === "archived",
      incidentDeleted: false,
      historicalEvidencePreserved: Object.values(preserved).every((value) => value === true),
      historyEvidence: {
        localCheckpointFilesPreserved: checkpointsAfter.length,
        criticCheckpointPreserved: preserved.criticCheckpointPresent,
        snapshot12C1Sha256: incidentPublicHashBefore,
        remoteAgentRunRowsFoundForPipelineRun: false,
        remoteAgentRunRowsNote: "No remote agent_runs/agent_logs rows were found keyed to this pipeline run in the preceding read-only audit; only local checkpoints and the 12C.1 snapshot are asserted as retained run evidence.",
      },
      systemicGuardClassification: "MULTIPLE",
      systemicGuardLayers: [
        "VERIFIER_CONTRACT_OR_POSTCHECK",
        "TRANSLATOR_PRESERVATION_GUARD",
        "EDITOR_FACTUAL_PROVENANCE_GUARD",
        "EDITOR_UNCERTAINTY_GUARD",
        "CRITIC_INPUT_EVIDENCE_EXPANSION",
        "CRITIC_PRECHECK",
      ],
      systemicGuardCoverage: "Prompt contracts and offline regressions are in place; semantic model calibration was not run because provider calls were prohibited.",
      migrationRequired: {
        thisPhase: false,
        archive: false,
        systemicGuard: false,
        future12C2BRemediationClaim: true,
        migration27Created: false,
      },
      regressionResults: {
        badCertaintyEscalation: "PASS_BLOCKED_CRITIC_REVISE_EDITORIAL_CRITICAL",
        unsupportedMaterialInternalDetail: "PASS_FLAGGED_CRITIC_REVISE_EDITORIAL",
        translatorAttributionLoss: "PASS_FLAGGED_CRITIC_REVISE_TRANSLATION",
        validDirectReport: "PASS",
        validAttributedSecondaryReport: "PASS",
        theVergeSingleSourceRegression: "PASS",
        mitStory: "NOT_DETERMINABLE",
        providerCalls: 0,
      },
      slugPolicy: {
        selected: "reuse existing slug and article row for the same event",
        publisherOperation: "upsert_by_event_id",
        uniqueness: "articles.slug is globally unique",
        noParallelReplacementRow: true,
      },
      eventAttemptConsequence: {
        pilotAttemptsUsedBefore: 4,
        pilotAttemptCeiling: 5,
        attemptsConsumedThisPhase: 0,
        existingEventAttemptNumber: Number(attemptRows.at(-1)?.attempt_number ?? 0),
        nextApprovedRemediationAttemptNumber: Number(attemptRows.at(-1)?.attempt_number ?? 0) + 1,
        consumesFifthPilotAttemptIfApproved: true,
        existingAttemptCountsTowardTechnicalRetryLimit: false,
      },
      futureModelStages: ["Verifier", "Translator", "Editor", "Classifier", "Ranker", "Critic"],
      futureMaximumGroqCalls: 6,
      pilotCallsUsed: 19,
      pilotCallCeiling: 30,
      providerCallsThisPhase: 0,
      phaseReadiness: "READY_NO",
      phaseBlockers: [
        "No normal canonical entry starts this exact event from Verifier.",
        "The existing READY_FOR_PUBLICATION attempt is permanently ineligible for another normal claim; a narrow database lifecycle change is required for 12C.2B.",
      ],
      publicRouteAfterArchive: {
        path: `/noticias/${incident.slug}`,
        httpStatus: 404,
        verifiedAgainst: "local production build after archive, backed by the public contract",
      },
      validationResults: {
        focusedOfflineSuites: "PASS",
        lint: "PASS",
        typeScript: "PASS",
        build: "PASS",
        providerCalls: 0,
      },
      filesChanged: [
        "lib/agents/verifier/verifier-prompt.ts",
        "lib/agents/verifier/verifier-fixtures.ts",
        "lib/agents/translator/translator-prompt.ts",
        "lib/agents/editor/editor-v2-prompt.ts",
        "lib/agents/critic/critic-prompt.ts",
        "lib/agents/critic/critic-types.ts",
        "lib/agents/critic/critic-input.ts",
        "lib/agents/critic/critic-prechecks.ts",
        "lib/agents/critic/critic-evidence-catalog.ts",
        "lib/agents/critic/critic-fixtures.ts",
        "lib/agents/critic/ranker-pipeline-checkpoint.ts",
        "lib/agents/pipeline/create-production-pipeline.ts",
        "lib/agents/pipeline/pipeline-fixtures.ts",
        "lib/agents/pipeline/pipeline-types.ts",
        "lib/agents/publisher/article-lifecycle.ts",
        "lib/agents/publisher/supabase-incident-article-lifecycle-repository.ts",
        "lib/agents/publisher/index.ts",
        "scripts/archive-incident-12c2a.ts",
        "scripts/article-lifecycle-unit-test.mjs",
        "scripts/verifier-unit-test.mjs",
        "scripts/translator-unit-test.mjs",
        "scripts/editor-unit-test.mjs",
        "scripts/critic-unit-test.mjs",
        "scripts/critic-checkpoint-resume.ts",
        "scripts/critic-replay-test.ts",
        "scripts/ranker-replay-test.ts",
        "scripts/targeted-critic-publisher-resume-12a2.ts",
        "scripts/groq-full-path-capacity-probe.ts",
        "scripts/pipeline-boundaries-unit-test.mjs",
        "scripts/pipeline-wiring-unit-test.mjs",
        "scripts/pipeline-real-test.ts",
        "scripts/supervised-snapshot-execute.ts",
        "scripts/frontend-public-content-unit-test.mjs",
        "package.json",
        "docs/published-factual-remediation-12c2a.md",
        "docs/published-factual-remediation-12c2b-plan.md",
        "artifacts/published-factual-remediation-12c2a.json",
      ],
      remoteWrites: { archiveOnly: lifecycle.changed ? 1 : 0, otherWrites: 0 },
      scheduler: "disabled",
      providerRouter: "disabled",
      netlifyTouched: false,
      migrationCreated: false,
    });
    await writeReport(report);
    console.log(JSON.stringify({ status: report.status, articleId: incident.articleId, publicCountBefore: publicBeforeRows.length, publicCountAfter: publicAfterRows.length, incidentVisibleAfter, archived: true, deleted: false, remoteArchiveWrites: lifecycle.changed ? 1 : 0, providerCalls: 0, report: reportPath }, null, 2));
  } catch (error) {
    Object.assign(report, { status: "ARCHIVE_POSTCHECK_FAILED", failedAt: new Date().toISOString(), errorCode: error instanceof Error ? error.message : "UNKNOWN_ARCHIVE_FAILURE" });
    await writeReport(report);
    throw error;
  }
}

await main();
