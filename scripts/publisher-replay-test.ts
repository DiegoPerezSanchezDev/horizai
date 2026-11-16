import { join } from "node:path";
import { readSafeCriticPipelineCheckpoint } from "../lib/agents/publisher/critic-pipeline-checkpoint.ts";
import { buildCheckpointDryRunMaterialization, buildPublisherInputFromCriticCheckpoint } from "../lib/agents/publisher/publisher-checkpoint-adapter.ts";
import { Publisher } from "../lib/agents/publisher/publisher-agent.ts";
import { publisherErrorSummary } from "../lib/agents/publisher/publisher-errors.ts";
import { SupabasePublisherRepository } from "../lib/agents/publisher/supabase-publisher-repository.ts";
import type { PublisherMaterializationPlan, PublisherRepository } from "../lib/agents/publisher/index.ts";

function requiredArgument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((argument) => argument.startsWith(prefix))?.slice(prefix.length).trim();
  if (!value || value.includes("..") || value.includes("/") || value.includes("\\")) throw new Error(`Missing or invalid required argument: --${name}`);
  return value;
}

async function main(): Promise<void> {
  try {
    const runId = requiredArgument("run-id");
    const eventKey = requiredArgument("event-key");
    const checkpointPath = join("artifacts", "pipeline-checkpoints", runId, `critic-${eventKey}.json`);
    const checkpoint = await readSafeCriticPipelineCheckpoint(checkpointPath);
    if (checkpoint.critic.decision !== "pass") {
      console.log(JSON.stringify({ status: "BLOCKED", reason: "publication_not_approved", dryRun: true, writes: 0, publisherVersion: "publisher-v1", checkpointPath }));
      return;
    }

    const repository = new SupabasePublisherRepository();
    const sources = await repository.findSources(checkpoint.sources.map((source) => source.sourceId));
    const materialization = buildCheckpointDryRunMaterialization(checkpoint, sources);
    const input = buildPublisherInputFromCriticCheckpoint(checkpoint, materialization);
    let rpcCalls = 0;
    const readOnlyRepository: PublisherRepository = {
      findEventByKey: (value) => repository.findEventByKey(value),
      findActiveRegion: (value) => repository.findActiveRegion(value),
      findActiveCategories: (values) => repository.findActiveCategories(values),
      findSources: (values) => repository.findSources(values),
      findEventSourceIds: (value) => repository.findEventSourceIds(value),
      findArticleByEventId: (value) => repository.findArticleByEventId(value),
      findArticleBySlug: (value) => repository.findArticleBySlug(value),
      findExactEntities: (values) => repository.findExactEntities(values),
      publishAtomic: async () => {
        rpcCalls += 1;
        throw new Error("publish_article_atomic must not be called during dry-run");
      },
    };
    const result = await new Publisher(readOnlyRepository).preview(input);
    const plan = result.writePlan;
    if (!("resolution" in plan.event) || !("sources" in plan) || !("relations" in plan)) throw new Error("Dry-run did not produce a materialization plan");
    const materializationPlan = plan as PublisherMaterializationPlan;
    console.log(JSON.stringify({
      status: "SUCCESS",
      publisherVersion: "publisher-v1",
      criticGate: "PASS",
      eventPersistedBeforeDryRun: materializationPlan.event.resolution === "reuse_existing",
      eventResolution: materializationPlan.event.resolution === "would_create" ? "WOULD_CREATE" : "REUSE_EXISTING",
      articleResolution: materializationPlan.article.resolution === "would_create" ? "WOULD_CREATE" : "REUSE_EXISTING",
      publicationPayload: "VALID",
      writePlan: "VALID",
      dryRun: result.dryRun,
      publish: false,
      transactionAttempted: result.summary.transactionAttempted,
      publishArticleAtomic: rpcCalls === 0 ? "NOT_CALLED" : "CALLED",
      articleCreated: result.summary.articleCreated,
      articleUpdated: result.summary.articleUpdated,
      dbWrites: 0,
      categoriesResolved: materializationPlan.categories.length,
      entitiesExisting: materializationPlan.entities.filter((entity) => entity.resolution === "reuse_existing").length,
      entitiesWouldCreate: materializationPlan.entities.filter((entity) => entity.resolution === "would_create").length,
      sourcesResolved: materializationPlan.sources.length,
      relations: materializationPlan.relations,
      checkpointPath,
    }, null, 2));
  } catch (error) {
    const summary = publisherErrorSummary(error);
    console.error(`Publisher replay failed closed: ${summary.code} — ${summary.message}`);
    process.exitCode = 1;
  }
}

main();
