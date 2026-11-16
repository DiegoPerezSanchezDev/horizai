import { join } from "node:path";
import { createProductionPipeline } from "../lib/agents/pipeline/create-production-pipeline.ts";
import { assertExecutionMode, parsePipelineCliArgs, pipelineCliHelp, printPipelineCliDiagnostics } from "../lib/agents/pipeline/pipeline-cli.ts";
import { publicationPayloadSchema, type PublicationPayload } from "../lib/agents/contracts/index.ts";
import type { PipelineEventContext } from "../lib/agents/pipeline/pipeline-types.ts";
import { validateRealPublicationReadiness } from "../lib/agents/publisher/publication-readiness.ts";
import { buildPublicationScores } from "../lib/agents/publisher/publication-payload.ts";
import { SupabasePublisherRepository } from "../lib/agents/publisher/supabase-publisher-repository.ts";
import type { PublisherInput } from "../lib/agents/publisher/publisher-types.ts";
import { readSafeTranslatorCheckpoint } from "../lib/agents/translator/translator-checkpoint.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

function publicationInput(context: PipelineEventContext): PublisherInput {
  if (!context.verification || !context.translation || !context.editorial || !context.classification || !context.geo || !context.ranking || !context.critic) {
    throw new Error("PUBLICATION_PREVIEW_REQUIRES_COMPLETE_LINEAGE");
  }
  const publishedByCandidate = new Map(context.event.sourceItems.map((item) => [item.candidateId, item.publishedAt]));
  const verification = context.verification;
  const translation = context.translation;
  const editorial = context.editorial;
  const classification = context.classification;
  const geo = context.geo;
  const ranking = context.ranking;
  const critic = context.critic;
  const payload: PublicationPayload = publicationPayloadSchema.parse({
    schemaVersion: 1,
    eventKey: context.event.eventKey,
    event: {
      canonicalTitle: context.event.canonicalTitle,
      probableOccurredAt: context.event.probableOccurredAt,
      probableCountryCode: classification.countryCodes[0] ?? context.event.probableCountryCode,
      probableRegionCode: classification.primaryRegionCode,
    },
    article: {
      slug: editorial.suggestedSlug,
      headlineEs: editorial.headlineEs,
      dekEs: editorial.dekEs,
      summaryEs: editorial.summaryEs,
      whyItMattersEs: editorial.whyItMattersEs,
      bodyEs: editorial.bodyEs,
      keyPoints: editorial.keyPoints,
    },
    sources: context.sources.map((source) => ({
      sourceId: source.sourceId,
      rawItemId: source.rawItemId ?? undefined,
      sourceName: source.sourceName,
      url: source.sourceUrl,
      isPrimary: source.sourceId === verification.primarySourceId,
      publishedAt: publishedByCandidate.get(source.sourceItemId) ?? null,
    })),
    categories: classification.categorySlugs.map((categorySlug, index) => ({ categorySlug, isPrimary: index === 0, confidenceScore: 100 })),
    entities: [
      ...classification.companies.map((canonicalName) => ({ entityType: "organization" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...classification.models.map((canonicalName) => ({ entityType: "model" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...classification.people.map((canonicalName) => ({ entityType: "person" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
      ...classification.technologies.map((canonicalName) => ({ entityType: "product" as const, canonicalName, countryCode: null, role: "mentioned" as const, confidenceScore: 100 })),
    ],
    region: { code: classification.primaryRegionCode, latitude: geo.latitude, longitude: geo.longitude },
    scores: buildPublicationScores(ranking),
    verification,
    critic,
  });
  const lineage = {
    eventKey: context.event.eventKey,
    verificationEventKey: verification.eventKey,
    translationEventKey: translation.eventKey,
    editorialEventKey: editorial.eventKey,
    classificationEventKey: classification.eventKey,
    rankingEventKey: ranking.eventKey,
    criticEventKey: critic.eventKey,
  };
  return {
    payload,
    lineage,
    validationContext: {
      translation,
      editorSources: context.sources.map((source) => ({ sourceId: source.sourceId, sourceName: source.sourceName, canonicalUrl: source.sourceUrl, sourceType: source.sourceType ?? "unknown" })),
    },
  };
}

function safeCheckpointPath(runId: string, eventKey: string): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return join("artifacts/pipeline-checkpoints", safe(runId), `verifier-${safe(eventKey)}.json`);
}

async function printTraceability(runId: string, eventKey: string, sourceItemIds: string[]): Promise<{ rawItemIds: string[]; ownership: boolean; title: string; sources: Array<{ name: string; url: string; sourceItemId: string }> }> {
  const supabase = createSupabaseServerClient();
  const checkpoint = await readSafeTranslatorCheckpoint(safeCheckpointPath(runId, eventKey));
  const rows = await supabase.from("raw_items").select("id,source_id,external_id").in("external_id", sourceItemIds);
  if (rows.error) throw new Error("TRACEABILITY_RAW_ITEM_LOOKUP_FAILED");
  const byExternalId = new Map((rows.data ?? []).map((row) => [row.external_id, row]));
  let ownership = true;
  const rawItemIds: string[] = [];
  for (const source of checkpoint.sources) {
    const row = byExternalId.get(source.sourceItemId);
    const owned = Boolean(row && row.source_id === source.sourceId);
    ownership = ownership && owned;
    if (row) rawItemIds.push(row.id);
    console.log(`source: ${source.sourceName}`);
    console.log(`rawItemId: ${row ? "PRESENT" : "ABSENT"}`);
    console.log(`ownership: ${owned ? "PASS" : "FAIL"}`);
    console.log(`original URL: ${source.sourceItemId}`);
  }
  return { rawItemIds, ownership, title: checkpoint.event.canonicalTitle, sources: checkpoint.sources.map((source) => ({ name: source.sourceName, url: source.sourceItemId, sourceItemId: source.sourceItemId })) };
}

export async function runPipelineCli(argv: string[]): Promise<void> {
  const cli = parsePipelineCliArgs(argv);
  printPipelineCliDiagnostics(cli);
  if (cli.help || argv.length === 0) {
    console.log("");
    console.log(pipelineCliHelp());
    return;
  }
  const supabase = createSupabaseServerClient();
  const capturedPublisherInput: { value: PublisherInput | null } = { value: null };
  const pipeline = createProductionPipeline({
    supabase,
    persistTraceability: true,
    publicationPayloadFactory: (context) => {
      capturedPublisherInput.value = publicationInput(context);
      return capturedPublisherInput.value.payload;
    },
    config: { hours: cli.hours ?? 24, limit: cli.limit ?? 1, dryRun: true, publish: false, trigger: "manual", automaticRevision: false },
  });
  const preflight = await pipeline.preflight();
  if (preflight.provider.toLowerCase() !== "groq") throw new Error("Pipeline preflight requires AGENT_PROVIDER=groq");
  if (Object.values(preflight.maxRetries).some((value) => value !== 0)) throw new Error("Pipeline preflight requires maxRetries=0 for every model stage");
  if (preflight.quotaRemaining < preflight.requiredRequests) throw new Error(`Insufficient persistent quota: ${preflight.quotaRemaining} remaining, ${preflight.requiredRequests} required`);
  console.log(`Provider execution allowed: ${cli.executionMode === "execute" ? "YES" : "NO"}`);
  console.log(`Quota provider: ${preflight.quotaProvider}`);
  console.log(`Supabase connected: ${preflight.supabaseConnected}`);
  console.log(`Effective maxRetries: ${JSON.stringify(preflight.maxRetries)}`);
  console.log(`Groq request budget: ${preflight.quotaRemaining}/${preflight.dailyRequestLimit} remaining`);
  console.log(`Worst-case required=${preflight.requiredRequests}`);
  console.log(`Budget available: ${preflight.quotaRemaining >= preflight.requiredRequests}`);
  console.log("Groq calls=0");
  console.log("persistTraceability: true");
  console.log("automaticRevision: false");
  if (cli.executionMode === "preflight") return;
  assertExecutionMode(cli.executionMode);
  if (cli.hours === null || cli.limit === null) throw new Error("Execution flags were lost before the runtime boundary");
  const result = await pipeline.orchestrator.run();
  const eventResult = result.eventResults[0];
  const eventKey = eventResult?.eventKey ?? null;
  let traceability: Awaited<ReturnType<typeof printTraceability>> | null = null;
  if (eventKey) {
    const checkpoint = await readSafeTranslatorCheckpoint(safeCheckpointPath(result.runId, eventKey)).catch(() => null);
    traceability = checkpoint ? await printTraceability(result.runId, eventKey, checkpoint.sources.map((source) => source.sourceItemId)) : null;
  }
  const publisherInput = capturedPublisherInput.value;
  let readiness: Awaited<ReturnType<typeof validateRealPublicationReadiness>> | null = null;
  if (publisherInput && eventResult?.criticDecision === "pass") {
    readiness = await validateRealPublicationReadiness(publisherInput, new SupabasePublisherRepository(supabase));
  }
  const counts = eventKey ? await (async () => {
    const event = await supabase.from("events").select("id").eq("event_key", eventKey).maybeSingle();
    const articleForEvent = event.data ? await supabase.from("articles").select("id").eq("event_id", event.data.id).maybeSingle() : { data: null };
    const slug = publisherInput?.payload.article.slug;
    const articleForSlug = slug ? await supabase.from("articles").select("id").eq("slug", slug).maybeSingle() : { data: null };
    return { event: event.data ? 1 : 0, articleForEvent: articleForEvent.data ? 1 : 0, articleForSlug: articleForSlug.data ? 1 : 0 };
  })() : { event: 0, articleForEvent: 0, articleForSlug: 0 };
  const quotaAfter = await pipeline.quota.remaining();
  const requestsUsed = eventResult?.requestsUsed ?? 0;
  const accounting = requestsUsed === result.providerRequestsUsed && preflight.quotaRemaining - quotaAfter === result.providerRequestsUsed;
  console.log(JSON.stringify({ runId: result.runId, finalState: result.finalState, eventsAttempted: result.eventsAttempted, providerRequestsUsed: result.providerRequestsUsed, dryRun: true, persistTraceability: true, publish: false, automaticRevision: false }, null, 2));
  console.log(`Raw item persisted: ${traceability && traceability.rawItemIds.length > 0 ? "YES" : "NO"}`);
  console.log(`rawItemId in lineage: ${traceability && traceability.rawItemIds.length === (traceability?.sources.length ?? -1) ? "YES" : "NO"}`);
  console.log(`Ownership: ${traceability?.ownership ? "PASS" : "FAIL"}`);
  console.log(`Existing event: ${counts.event ? "YES" : "NO"}`);
  console.log(`Existing article: ${counts.articleForEvent ? "YES" : "NO"}`);
  console.log(`Slug collision: ${counts.articleForSlug ? "YES" : "NO"}`);
  console.log(`Publication readiness: ${readiness ? (readiness.ready ? "PASS" : "FAIL") : "NOT_RUN"}`);
  console.log(`PublicationPayload: ${publisherInput ? "PASS" : "NOT_RUN"}`);
  console.log(`Real rawItemIds in payload: ${publisherInput?.payload.sources.every((source) => Boolean(source.rawItemId)) ? "PASS" : publisherInput ? "FAIL" : "NOT_RUN"}`);
  console.log(`Materialization preview: ${eventResult?.finalState === "READY_FOR_PUBLICATION_DRY_RUN" ? "PASS" : "NOT_RUN"}`);
  console.log("RPC called: NO");
  console.log("Article writes: 0");
  console.log(`Request accounting: ${accounting ? "PASS" : "FAIL"}`);
  console.log(`Groq calls: ${result.providerRequestsUsed}`);
  console.log(`Groq request budget before: ${preflight.quotaRemaining}/${preflight.dailyRequestLimit} remaining`);
  console.log(`Groq request budget after: ${quotaAfter}/${preflight.dailyRequestLimit} remaining`);
  if (publisherInput && readiness?.ready && eventResult?.criticDecision === "pass") {
    console.log("\n========================\nHUMAN PUBLICATION PREVIEW\n========================");
    console.log(`HEADLINE\n${publisherInput.payload.article.headlineEs}`);
    console.log(`\nDEK / SUMMARY\n${publisherInput.payload.article.dekEs}\n\n${publisherInput.payload.article.summaryEs}`);
    console.log(`\nPOR QUÉ IMPORTA\n${publisherInput.payload.article.whyItMattersEs}`);
    console.log(`\nBODY\n${publisherInput.payload.article.bodyEs}`);
    console.log(`\nKEY POINTS\n${publisherInput.payload.article.keyPoints.join("\n")}`);
    console.log(`\nREGIÓN\n${publisherInput.payload.region.code ?? "N/A"}`);
    console.log(`\nPAÍSES\n${publisherInput.payload.event.probableCountryCode ?? "N/A"}`);
    console.log(`\nCATEGORÍAS\n${publisherInput.payload.categories.map((category) => category.categorySlug).join(", ") || "N/A"}`);
    console.log(`\nENTIDADES\n${publisherInput.payload.entities.map((entity) => entity.canonicalName).join(", ") || "N/A"}`);
    console.log(`\nFUENTES PÚBLICAS\n${publisherInput.payload.sources.map((source) => `${source.sourceName} — ${source.url}`).join("\n")}`);
    console.log(`\nSLUG\n${publisherInput.payload.article.slug}`);
    console.log("\nIMAGE: NOT AVAILABLE");
  }
  const finalStatus = publisherInput && readiness?.ready && eventResult?.criticDecision === "pass"
    ? "READY_FOR_HUMAN_PUBLICATION_APPROVAL"
    : `TRACEABLE_PIPELINE_VALIDATED_BUT_${eventResult?.finalState ?? "FAILED"}`;
  console.log(`FINAL STATUS: ${finalStatus}`);
  const failures = result.eventResults.flatMap((event) => event.failure ? [event.failure] : []);
  if (failures.length > 0) console.log(JSON.stringify({ stageFailures: failures }, null, 2));
}

runPipelineCli(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Pipeline test failed"); process.exitCode = 1; });
