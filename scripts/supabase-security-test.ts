import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types/database.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

type Client = SupabaseClient<Database>;

function required(name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function createAnonClient(): Client {
  return createClient<Database>(required("NEXT_PUBLIC_SUPABASE_URL"), required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
}

async function expectDenied(label: string, operation: () => Promise<{ error: { code?: string | null } | null }>): Promise<string> {
  const response = await operation();
  if (!response.error) throw new Error(`${label} was not denied`);
  return response.error.code ?? "UNKNOWN_ERROR";
}

function keysOf(value: unknown): string[] {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

async function main(): Promise<void> {
  const service = createSupabaseServerClient();
  const anon = createAnonClient();
  const suffix = randomUUID().replaceAll("-", "");
  const publishedSlug = `security-public-${suffix}`;
  const draftSlug = `security-draft-${suffix}`;
  const publishedEventKey = `event-${suffix}`;
  const draftEventKey = `event-${randomUUID().replaceAll("-", "")}`;
  const entityName = `HorizAI Security Fixture ${suffix}`;
  const created: { articleIds: string[]; eventIds: string[]; rawItemIds: string[]; entityIds: string[] } = {
    articleIds: [], eventIds: [], rawItemIds: [], entityIds: [],
  };
  const denied: Record<string, string> = {};

  try {
    const [sourceResponse, regionResponse, categoryResponse] = await Promise.all([
      service.from("sources").select("id,name,url").eq("is_active", true).limit(1).single(),
      service.from("regions").select("id,code").eq("code", "US").eq("is_active", true).single(),
      service.from("categories").select("id,slug").eq("slug", "chips").eq("is_active", true).single(),
    ]);
    if (sourceResponse.error || regionResponse.error || categoryResponse.error) {
      const codes = [sourceResponse.error?.code, regionResponse.error?.code, categoryResponse.error?.code].filter(Boolean).join(",");
      throw new Error(`security fixture reference lookup failed${codes ? ` (${codes})` : ""}`);
    }
    const source = sourceResponse.data;
    const region = regionResponse.data;
    const category = categoryResponse.data;

    const raw = await service.from("raw_items").insert({
      source_id: source.id,
      original_url: `https://example.invalid/security/${suffix}`,
      external_id: `security-${suffix}`,
      title: "Temporary security fixture",
      excerpt: "Temporary security fixture excerpt.",
      raw_content: "Temporary security fixture content.",
      content_hash: `security-${suffix}`,
      processing_status: "processed",
    }).select("id").single();
    if (raw.error) throw new Error("security raw item fixture failed");
    created.rawItemIds.push(raw.data.id);

    const publishedEvent = await service.from("events").insert({
      event_key: publishedEventKey,
      canonical_title: "Temporary public security fixture",
      event_status: "active",
      primary_region_id: region.id,
      primary_country_code: "US",
      review_status: "approved",
    }).select("id").single();
    if (publishedEvent.error) throw new Error("security published event fixture failed");
    created.eventIds.push(publishedEvent.data.id);

    const eventSource = await service.from("event_sources").insert({ event_id: publishedEvent.data.id, raw_item_id: raw.data.id, source_id: source.id, is_primary: true });
    if (eventSource.error) throw new Error("security event source fixture failed");

    const entity = await service.from("entities").insert({
      entity_type: "organization",
      canonical_name: entityName,
      country_code: "US",
      review_status: "approved",
    }).select("id").single();
    if (entity.error) throw new Error("security entity fixture failed");
    created.entityIds.push(entity.data.id);

    const publishedArticle = await service.from("articles").insert({
      event_id: publishedEvent.data.id,
      slug: publishedSlug,
      headline_es: "Fixture público de seguridad",
      summary_es: "Resumen público temporal.",
      why_it_matters_es: "Permite comprobar el contrato de lectura pública.",
      body_es: "Contenido público temporal para una prueba de seguridad.",
      publication_status: "published",
      critic_status: "approved",
      published_at: "2026-09-21T10:00:00Z",
      reviewed_at: "2026-09-21T09:59:00Z",
    }).select("id").single();
    if (publishedArticle.error) throw new Error("security published article fixture failed");
    created.articleIds.push(publishedArticle.data.id);

    const categoryRelation = await service.from("article_categories").insert({ article_id: publishedArticle.data.id, category_id: category.id, is_primary: true });
    if (categoryRelation.error) throw new Error("security category relation fixture failed");
    const entityRelation = await service.from("article_entities").insert({ article_id: publishedArticle.data.id, entity_id: entity.data.id, role: "subject" });
    if (entityRelation.error) throw new Error("security entity relation fixture failed");

    const draftEvent = await service.from("events").insert({
      event_key: draftEventKey,
      canonical_title: "Temporary unpublished security fixture",
      event_status: "active",
      primary_region_id: region.id,
      primary_country_code: "US",
      review_status: "approved",
    }).select("id").single();
    if (draftEvent.error) throw new Error("security draft event fixture failed");
    created.eventIds.push(draftEvent.data.id);
    const draftArticle = await service.from("articles").insert({
      event_id: draftEvent.data.id,
      slug: draftSlug,
      headline_es: "Fixture no publicado",
      publication_status: "draft",
      critic_status: "pending",
    }).select("id").single();
    if (draftArticle.error) throw new Error("security draft article fixture failed");
    created.articleIds.push(draftArticle.data.id);

    const publicArticle = await anon.from("public_published_articles").select("*").eq("slug", publishedSlug).maybeSingle();
    if (publicArticle.error || !publicArticle.data) throw new Error("anonymous public article read failed");
    const allowedArticleColumns = ["body_es", "categories", "entities", "headline_es", "published_at", "region_code", "region_latitude", "region_longitude", "region_name", "slug", "sources", "summary_es", "updated_at", "why_it_matters_es"].sort();
    assert(JSON.stringify(keysOf(publicArticle.data)) === JSON.stringify(allowedArticleColumns), "public article contract exposed unexpected columns");
    assert((await anon.from("public_published_articles").select("slug").eq("slug", draftSlug)).data?.length === 0, "draft article is visible in public contract");

    const regions = await anon.from("public_regions").select("code,name,latitude,longitude");
    if (regions.error || !regions.data || regions.data.length < 11) throw new Error("public regions contract is incomplete");
    const categories = await anon.from("public_categories").select("slug,name");
    if (categories.error || !categories.data || categories.data.length < 8) throw new Error("public categories contract is incomplete");

    const internalTables = ["sources", "raw_items", "events", "event_sources", "articles", "regions", "categories", "article_categories", "entities", "article_entities", "activity_history", "agent_runs", "agent_logs", "scheduler_runs", "pipeline_event_attempts"] as const;
    for (const table of internalTables) {
      denied[`select:${table}`] = await expectDenied(`anonymous SELECT ${table}`, async () => anon.from(table).select("*").limit(1));
    }
    denied["insert:articles"] = await expectDenied("anonymous INSERT articles", async () => anon.from("articles").insert({ event_id: publishedEvent.data.id, slug: `security-write-${suffix}`, headline_es: "No debe escribirse", publication_status: "draft" }));
    denied["update:events"] = await expectDenied("anonymous UPDATE events", async () => anon.from("events").update({ canonical_title: "No debe escribirse" }).eq("id", randomUUID()));
    denied["delete:events"] = await expectDenied("anonymous DELETE events", async () => anon.from("events").delete().eq("id", randomUUID()));
    denied["rpc:publish_article_atomic"] = await expectDenied("anonymous publisher RPC", async () => anon.rpc("publish_article_atomic", { p_payload: {} }));
    denied["rpc:reserve_agent_request"] = await expectDenied("anonymous reservation RPC", async () => anon.rpc("reserve_agent_request", { p_run_id: randomUUID(), p_agent_name: "security-test", p_agent_version: "test", p_event_key: null, p_attempt: 1, p_model: "none", p_request_date: "2026-09-21", p_limit: 20 }));
    denied["rpc:reserve_provider_agent_request"] = await expectDenied("anonymous provider reservation RPC", async () => anon.rpc("reserve_provider_agent_request", { p_run_id: randomUUID(), p_agent_name: "security-test", p_agent_version: "test", p_event_key: null, p_attempt: 1, p_model: "gpt-oss-120b", p_request_date: "2026-09-21", p_limit: 20, p_provider: "cerebras" }));
    denied["rpc:claim_pipeline_event_attempt"] = await expectDenied("anonymous event attempt RPC", async () => anon.rpc("claim_pipeline_event_attempt", { p_event_key: `security-${suffix}`, p_pipeline_run_id: randomUUID(), p_started_at: new Date().toISOString(), p_now: new Date().toISOString(), p_stale_after_seconds: 3600 }));

    const publicSource = (publicArticle.data.sources as Array<Record<string, unknown>>)[0];
    assert(publicSource && JSON.stringify(keysOf(publicSource)) === JSON.stringify(["name", "url"]), "public source attribution leaked internal fields");
    const publicEntity = (publicArticle.data.entities as Array<Record<string, unknown>>)[0];
    assert(publicEntity && JSON.stringify(keysOf(publicEntity)) === JSON.stringify(["countryCode", "name", "type"]), "public entity projection leaked internal fields");

    console.log(JSON.stringify({
      status: "SUCCESS",
      publicArticleRead: true,
      unpublishedArticleHidden: true,
      publicRegions: regions.data.length,
      publicCategories: categories.data.length,
      internalSelectsBlocked: Object.keys(denied).filter((key) => key.startsWith("select:")).length,
      anonymousWritesBlocked: 3,
      sensitiveRpcsBlocked: 4,
      publicColumns: allowedArticleColumns,
      groqCalls: 0,
      pipelineExecutions: 0,
    }, null, 2));
  } finally {
    for (const articleId of created.articleIds) {
      await service.from("article_categories").delete().eq("article_id", articleId);
      await service.from("article_entities").delete().eq("article_id", articleId);
    }
    for (const articleId of created.articleIds) await service.from("articles").delete().eq("id", articleId);
    for (const eventId of created.eventIds) await service.from("event_sources").delete().eq("event_id", eventId);
    for (const eventId of created.eventIds) await service.from("events").delete().eq("id", eventId);
    for (const rawItemId of created.rawItemIds) await service.from("raw_items").delete().eq("id", rawItemId);
    for (const entityId of created.entityIds) await service.from("entities").delete().eq("id", entityId);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Supabase security test failed");
  process.exitCode = 1;
});
