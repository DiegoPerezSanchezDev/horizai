import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const projectRef = "skrthgpurquypgdwxast";
const migrationVersion = "20261005194000";
const migrationFile = "supabase/migrations/20261005194000_supervised_human_review_gate.sql";
const inventoryPath = resolve(repo, "supabase/.temp/12e1a-preapply-object-inventory.json");
const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SECRET_KEY || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const scratchFiles = new Set();
const sqlLiteral = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const md5 = (value) => createHash("md5").update(value).digest("hex");
const marker = randomUUID();
const namespace = `12e1a:${marker}`;

if (!url || !serviceKey || !anonKey || new URL(url).hostname.split(".")[0] !== projectRef) {
  throw new Error("SUPABASE_VALIDATION_CONFIGURATION_OR_PROJECT_MISMATCH");
}
if (!existsSync(migrationFile) || readFileSync(resolve(repo, "supabase/.temp/project-ref"), "utf8").trim() !== projectRef) {
  throw new Error("MIGRATION_OR_LINKED_PROJECT_PREFLIGHT_FAILED");
}

function dbQuery(sql, label) {
  const path = resolve(repo, "supabase/.temp", `12e1a-${randomUUID()}-${label}.sql`);
  scratchFiles.add(path);
  writeFileSync(path, sql.trim() + "\n", "utf8");
  try {
    const cli = process.platform === "win32" ? "npx.cmd" : "npx";
    const result = spawnSync(cli, ["--yes", "supabase", "db", "query", "--linked", "--output-format", "json", "--file", path], {
      cwd: repo, encoding: "utf8", shell: process.platform === "win32", windowsHide: true, maxBuffer: 12 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) {
      const diagnostic = [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n").trim().slice(0, 2200);
      throw new Error(`DB_QUERY_${label}_FAILED:${diagnostic || result.status}`);
    }
    const start = (result.stdout || "").indexOf("{");
    if (start < 0) throw new Error(`DB_QUERY_${label}_RESULT_MISSING`);
    try { return JSON.parse(result.stdout.slice(start)); } catch { throw new Error(`DB_QUERY_${label}_RESULT_INVALID`); }
  } finally {
    try { unlinkSync(path); } catch { /* cleanup is retried at process exit */ }
    scratchFiles.delete(path);
  }
}

async function rest(path, key = serviceKey, method = "GET", body = undefined) {
  const response = await fetch(url + path, {
    method, cache: "no-store",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json", Prefer: "return=representation" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw.slice(0, 300) }; }
  return { status: response.status, data };
}

const rpc = (name, args, key = serviceKey) => rest(`/rest/v1/rpc/${name}`, key, "POST", args);

function oneRow(sql, label) {
  const result = dbQuery(sql, label);
  assert.equal(result.rows?.length, 1, `${label} returns exactly one row`);
  return result.rows[0];
}

async function privateRead() {
  const { createSupabaseServerClient } = await import("../lib/supabase/server-client.ts");
  const db = createSupabaseServerClient();
  const result = await db.from("pipeline_event_attempts").select("id", { count: "exact", head: true });
  if (result.error) throw new Error(`NORMAL_PRIVATE_READ_FAILED:${result.error.code}`);
  return { status: "PASS", table: "pipeline_event_attempts", rowCount: result.count };
}

async function publicRead() {
  const result = await rest("/rest/v1/public_published_articles?select=slug&order=slug.asc", anonKey);
  assert.equal(result.status, 200, "anonymous public-article read is HTTP 200");
  assert.ok(Array.isArray(result.data), "anonymous public-article read returns rows");
  return result.data.map((row) => row.slug).sort();
}

const inventorySql = `
select jsonb_build_object(
 'latestMigration',(select max(version) from supabase_migrations.schema_migrations),
 'lateMigrations',(select coalesce(jsonb_agg(version order by version),'[]'::jsonb) from supabase_migrations.schema_migrations where version >= '20260930211903'),
 'migration31Applied',exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
 'migration32Applied',exists(select 1 from supabase_migrations.schema_migrations where version>'${migrationVersion}'),
 'pgcryptoSchema',(select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto'),
 'relations',(select coalesce(jsonb_agg(c.relname order by c.relname),'[]'::jsonb) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','m','p','f')),
 'functions',(select coalesce(jsonb_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')),
 'functionHashes',(select coalesce(jsonb_object_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',md5(pg_get_functiondef(p.oid))),'{}'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')),
 'types',(select coalesce(jsonb_agg(t.typname order by t.typname),'[]'::jsonb) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype in ('c','d','e','r','m')),
 'indexes',(select coalesce(jsonb_agg(indexname order by indexname),'[]'::jsonb) from pg_indexes where schemaname='public'),
 'indexDefinitions',(select coalesce(jsonb_object_agg(indexname,indexdef),'{}'::jsonb) from pg_indexes where schemaname='public'),
 'constraints',(select coalesce(jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text,c.conname),'[]'::jsonb) from pg_constraint c join pg_namespace n on n.oid=(select relnamespace from pg_class where oid=c.conrelid) where n.nspname='public'),
 'triggers',(select coalesce(jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'definition',pg_get_triggerdef(oid)) order by tgrelid::regclass::text,tgname),'[]'::jsonb) from pg_trigger where not tgisinternal and tgrelid in (select oid from pg_class where relnamespace='public'::regnamespace))
) as inventory;`;

const preapplyBaselineSql = `
select jsonb_build_object(
 'publicArticles',(select jsonb_agg(jsonb_build_object('id',a.id,'slug',a.slug,'rowMd5',md5(to_jsonb(a)::text)) order by a.slug) from public.articles a where a.publication_status='published'),
 'publicCount',(select count(*) from public.public_published_articles),
 'astra',(select jsonb_build_object('id',a.id,'status',a.publication_status,'slug',a.slug,'rowMd5',md5(to_jsonb(a)::text)) from public.articles a where a.id='756b0ee0-b5e6-4153-846f-278a12c9afe3'::uuid),
 'attemptCount',(select count(*) from public.pipeline_event_attempts a where not exists(select 1 from public.agent_runs ar where ar.id=a.pipeline_run_id and ar.config->>'validationNamespace' like '12e1a:%')),
 'attemptRowsMd5',(select md5(coalesce(string_agg(md5(to_jsonb(a)::text),',' order by a.id),'')) from public.pipeline_event_attempts a where not exists(select 1 from public.agent_runs ar where ar.id=a.pipeline_run_id and ar.config->>'validationNamespace' like '12e1a:%')),
 'pilotAttemptCount',(select count(*) from public.pipeline_event_attempts where pilot_attempt_number is not null),
 'pilotAttemptsMd5',(select md5(coalesce(string_agg(md5(to_jsonb(a)::text),',' order by a.id),'')) from public.pipeline_event_attempts a where pilot_attempt_number is not null),
 'astraAttemptCount',(select count(*) from public.pipeline_event_attempts where event_key='event-30f226d1b8ba5c9eb8af2b65c46db512'),
 'providerAccounting',(select jsonb_build_object('reservationCount',count(*),'rowsMd5',md5(coalesce(string_agg(concat_ws('|',l.id::text,l.run_id::text,coalesce(l.provider,''),coalesce(l.provider_unit,''),coalesce(l.provider_unit_amount::text,''),l.created_at::text),',' order by l.id),''))) from public.agent_logs l where l.step='provider_request_reserved'),
 'reviewTableExists',to_regclass('public.pipeline_human_reviews') is not null,
 'reviewCount',0
) as baseline;`;

async function preapplySnapshot() {
  const privateReadResult = await privateRead();
  const publicSlugs = await publicRead();
  assert.equal(publicSlugs.length, 2, "preapply public contract still has two articles");
  const inventory = oneRow(inventorySql, "preapply_inventory").inventory;
  assert.equal(inventory.latestMigration, "20261002211000", "migration 30 is latest before apply");
  assert.deepEqual(inventory.lateMigrations, ["20260930211903", "20261002105220", "20261002150747", "20261002211000"], "migrations 27 through 30 are applied in order");
  assert.equal(inventory.migration31Applied, false, "migration 31 is not applied before apply");
  assert.equal(inventory.migration32Applied, false, "migration 32 is absent before apply");
  assert.equal(inventory.pgcryptoSchema, "extensions", "pgcrypto is installed in extensions");
  assert.equal(inventory.relations.includes("pipeline_human_reviews"), false, "review table is not yet remote");
  const baseline = oneRow(preapplyBaselineSql, "preapply_real_baseline").baseline;
  assert.equal(baseline.publicCount, publicSlugs.length, "public baseline agrees with the anonymous read");
  assert.equal(baseline.publicCount, 2, "real public article count is two before apply");
  assert.equal(baseline.astra?.status, "archived", "Astra is archived before apply");
  assert.equal(baseline.attemptCount, 8, "real attempt count matches the established baseline");
  assert.ok(Number.isInteger(baseline.providerAccounting.reservationCount) && baseline.providerAccounting.reservationCount >= 0, "provider reservation count is captured without assuming a historic total");
  assert.equal(baseline.reviewTableExists, false, "no human-review storage exists before migration 31");
  const savedInventory = { ...inventory, _realBaseline: baseline };
  writeFileSync(inventoryPath, JSON.stringify(savedInventory, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ status: "PASS", phase: "PREAPPLY_READ_ONLY", projectRef, privateRead: privateReadResult, publicArticleCount: publicSlugs.length, latestMigration: inventory.latestMigration, migration31Applied: inventory.migration31Applied, pgcryptoSchema: inventory.pgcryptoSchema, inventorySha256: sha256(JSON.stringify(inventory)), migration31Sha256: sha256(readFileSync(migrationFile)), realBaseline: baseline }));
}

function valueRows(result, label) {
  assert.ok(result.status >= 200 && result.status < 300, `${label} insert/update returned HTTP ${result.status}`);
  return Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
}

function assertDenied(result, label) {
  assert.notEqual(result.status, 200, `${label} must be denied`);
}

function publicationArgs(scenario) {
  return {
    p_review_id: scenario.reviewId,
    p_event_key: scenario.eventKey,
    p_attempt_id: scenario.attemptId,
    p_pipeline_run_id: scenario.pipelineRunId,
    p_draft_id: scenario.draftId,
    p_draft_sha256: scenario.draftSha256,
    p_checkpoint_hashes: scenario.manifest.checkpoints,
    p_source_lineage: scenario.lineage,
    p_publication_payload: scenario.payload,
  };
}

async function storedReview(reviewId) {
  const row = oneRow(`select to_jsonb(r) as review from public.pipeline_human_reviews r where r.id=${sqlLiteral(reviewId)}::uuid;`, "review_row").review;
  return row;
}

async function assertNotPublished(scenario, label) {
  const sqlCount = oneRow(`select count(*)::integer as count from public.articles a join public.events e on e.id=a.event_id where e.event_key=${sqlLiteral(scenario.eventKey)} and a.publication_status='published';`, `${label}_article_count`).count;
  assert.equal(Number(sqlCount), 0, `${label} has no public article row`);
  const slugs = await publicRead();
  assert.equal(slugs.includes(scenario.payload.article.slug), false, `${label} is absent from anonymous public view`);
}

async function createScenario(label, refs, options = {}) {
  const runId = randomUUID();
  const validationNamespace = `12e1a:${randomUUID()}`;
  const eventKey = `event-${md5(`${validationNamespace}:${randomUUID()}`)}`;
  const sourceContentHash = sha256(`${eventKey}:source-content`);
  const rawUrl = `https://example.invalid/12e1a/${randomUUID()}`;
  const rawRows = valueRows(await rest("/rest/v1/raw_items", serviceKey, "POST", {
    source_id: refs.source.id,
    original_url: rawUrl,
    canonical_url: rawUrl,
    external_id: validationNamespace,
    title: `Synthetic 12E.1a ${label}`,
    excerpt: "Synthetic validation only.",
    content_hash: sourceContentHash,
    processing_status: "extracted",
    extraction_quality: "full",
    extracted_at: new Date().toISOString(),
  }), `${label}_raw_item`);
  assert.equal(rawRows.length, 1, `${label} raw item created`);
  const rawItem = rawRows[0];
  const scenario = { label, eventKey, validationNamespace, pipelineRunId: runId, rawItemId: rawItem.id, sourceContentHash, attemptId: null, reviewId: null };
  refs.scenarios.push(scenario);

  const startedAt = new Date().toISOString();
  valueRows(await rest("/rest/v1/agent_runs", serviceKey, "POST", {
    id: runId,
    run_type: "critic",
    started_at: startedAt,
    finished_at: startedAt,
    status: "succeeded",
    dry_run: true,
    config: { agentName: "critic", eventKey, pipelineRunId: runId, validationNamespace },
    ...(options.usageUnsettled ? { provider: "groq" } : {}),
    stats: { telemetry: {
      finalCriticResultValid: true,
      deterministicPrechecksPassed: true,
      finalDecision: options.criticNonPass ? "fail" : "pass",
      providerRequestsUsed: options.usageUnsettled ? 1 : 0,
      ...(options.usageUnsettled ? { provider: "groq" } : {}),
    } },
  }), `${label}_critic_run`);
  if (options.usageUnsettled) {
    valueRows(await rest("/rest/v1/agent_logs", serviceKey, "POST", {
      run_id: runId,
      agent_name: "critic",
      step: "provider_request_reserved",
      level: "info",
      message: "Synthetic unsettled provider usage evidence; no provider request was dispatched.",
      payload: { provider: "groq", providerRequestDispatched: false, tokenUsageState: "unsettled" },
      provider: "groq",
      provider_unit: "tokens",
      provider_unit_amount: 1,
    }), `${label}_unsettled_usage_evidence`);
  }

  const claimed = await rpc("claim_pipeline_event_attempt", {
    p_event_key: eventKey,
    p_pipeline_run_id: runId,
    p_started_at: startedAt,
    p_now: startedAt,
    p_stale_after_seconds: 3600,
  });
  assert.equal(claimed.status, 200, `${label} canonical attempt claim is allowed`);
  assert.equal(claimed.data?.status, "ACQUIRED", `${label} has a fresh synthetic attempt`);
  scenario.attemptId = claimed.data.attempt.id;

  const source = refs.source;
  const payload = structuredClone(refs.basePayload);
  payload.eventKey = eventKey;
  payload.event.canonicalTitle = `Synthetic supervised review ${eventKey}`;
  payload.event.probableOccurredAt = startedAt;
  payload.article.slug = `twelve-e-one-${randomUUID().replaceAll("-", "")}`;
  payload.article.headlineEs = `Artículo sintético de revisión ${label}`;
  payload.article.dekEs = "Contenido sintético de validación de una transacción de revisión humana.";
  payload.article.summaryEs = `Resumen sintético para ${eventKey}.`;
  payload.article.whyItMattersEs = "Validación técnica sin afirmaciones sobre hechos reales.";
  payload.article.bodyEs = `Contenido sintético de prueba para ${eventKey}. No describe una noticia real.`;
  payload.article.keyPoints = ["Fixture sintético", "Sin llamadas a proveedores"];
  payload.sources = [{ sourceId: source.id, rawItemId: rawItem.id, sourceName: source.name, url: source.url, isPrimary: true, publishedAt: null }];
  payload.categories = [{ categorySlug: refs.category.slug, isPrimary: true, confidenceScore: 95 }];
  payload.entities = [];
  payload.region = { code: "US", latitude: refs.region.latitude, longitude: refs.region.longitude };
  payload.verification = {
    ...payload.verification,
    eventKey,
    primarySourceId: source.id,
    supportingSourceIds: [],
    verifiedFacts: payload.verification.verifiedFacts.map((fact) => ({ ...fact, sourceIds: [source.id] })),
    uncertainClaims: payload.verification.uncertainClaims.map((claim) => ({ ...claim, sourceIds: [source.id] })),
    contradictions: [],
  };
  payload.critic = { ...payload.critic, eventKey, decision: "pass", notes: `Synthetic Critic pass for ${eventKey}.` };
  scenario.payload = payload;
  scenario.draftId = `${eventKey}:draft`;
  scenario.draftSha256 = sha256(`${eventKey}:draft-checkpoint`);
  scenario.lineage = [{
    raw_item_id: rawItem.id,
    source_id: source.id,
    content_hash: sourceContentHash,
    canonical_url: rawUrl,
    source_url: source.url,
  }];
  const stages = ["verifier", "translator", "editor", "classifier", "ranker", "critic"];
  const checkpoints = Object.fromEntries(stages.map((stage) => [stage, {
    identity: `${eventKey}:${stage}`,
    sha256: sha256(`${eventKey}:${stage}:checkpoint`),
  }]));
  scenario.manifest = { schemaVersion: "1", packageSha256: sha256(`${eventKey}:package`), checkpoints };
  const created = await rpc("create_pipeline_human_review", {
    p_event_key: eventKey,
    p_attempt_id: scenario.attemptId,
    p_pipeline_run_id: runId,
    p_draft_id: scenario.draftId,
    p_draft_sha256: scenario.draftSha256,
    p_source_lineage: scenario.lineage,
    p_review_manifest: scenario.manifest,
    p_publication_payload: payload,
  });
  if (options.criticNonPass || options.usageUnsettled) {
    assert.notEqual(created.status, 200, `${label} evidence cannot enter the waiting or approved state`);
    assert.match(JSON.stringify(created.data), options.criticNonPass ? /human_review_critic_pass_not_proven/i : /human_review_provider_usage_unsettled/i, `${label} is blocked by its specific evidence guard`);
    const reviewCount = oneRow(`select count(*)::integer as count from public.pipeline_human_reviews where event_key=${sqlLiteral(eventKey)};`, `${label}_review_absent`).count;
    assert.equal(Number(reviewCount), 0, `${label} creates no review or publication authorization`);
    scenario.creationBlocked = true;
    return scenario;
  }
  assert.equal(created.status, 200, `${label} service-role review creation is allowed`);
  scenario.reviewId = created.data.reviewId;
  assert.equal(created.data.status, "WAITING_FOR_HUMAN_REVIEW", `${label} transitions to durable waiting state`);
  assert.ok(created.data.reviewManifest?.publicationPayloadSha256, `${label} stores only the payload hash in the manifest`);
  const attempt = oneRow(`select final_state,stop_stage,stop_reason,completed_at from public.pipeline_event_attempts where id=${sqlLiteral(scenario.attemptId)}::uuid;`, `${label}_attempt_state`);
  assert.equal(attempt.final_state, "WAITING_FOR_HUMAN_REVIEW", `${label} attempt is waiting`);
  assert.equal(attempt.stop_stage, "human_review", `${label} stops at human review`);
  assert.equal(attempt.stop_reason, "HUMAN_REVIEW_PENDING", `${label} stop reason is explicit`);
  await assertNotPublished(scenario, `${label}_waiting`);
  return scenario;
}

async function decide(scenario, decision, flags = {}) {
  return rpc("decide_pipeline_human_review", {
    p_review_id: scenario.reviewId,
    p_decision: decision,
    p_reviewer_id: "Codex 12E.1 synthetic validation",
    p_facts_acceptable: flags.facts ?? true,
    p_attribution_acceptable: flags.attribution ?? true,
    p_uncertainty_preserved: flags.uncertainty ?? true,
    p_headline_acceptable: flags.headline ?? true,
    p_summary_acceptable: flags.summary ?? true,
    p_no_unsupported_material_claims: flags.noUnsupported ?? true,
    p_source_chain_acceptable: flags.sourceChain ?? true,
  });
}

function objectInventory() {
  return oneRow(inventorySql, "postapply_inventory").inventory;
}

function diffArray(before, after) {
  const keyOf = (value) => typeof value === "string" ? value : JSON.stringify(value);
  const beforeByKey = new Map(before.map((value) => [keyOf(value), value]));
  const afterByKey = new Map(after.map((value) => [keyOf(value), value]));
  return {
    added: [...afterByKey].filter(([key]) => !beforeByKey.has(key)).map(([, value]) => value).sort((left, right) => keyOf(left).localeCompare(keyOf(right))),
    removed: [...beforeByKey].filter(([key]) => !afterByKey.has(key)).map(([, value]) => value).sort((left, right) => keyOf(left).localeCompare(keyOf(right))),
  };
}

function assertObjectInventory(before, after) {
  const relationDiff = diffArray(before.relations, after.relations);
  assert.deepEqual(relationDiff.added, ["pipeline_human_reviews"], "only the review table was added");
  assert.deepEqual(relationDiff.removed, [], "no relation was removed");
  const expectedNewFunctions = [
    "assert_pipeline_human_review_evidence(p_event_key text, p_pipeline_run_id uuid)",
    "assert_pipeline_human_review_source_lineage(p_lineage jsonb)",
    "create_pipeline_human_review(p_event_key text, p_attempt_id uuid, p_pipeline_run_id uuid, p_draft_id text, p_draft_sha256 text, p_source_lineage jsonb, p_review_manifest jsonb, p_publication_payload jsonb)",
    "decide_pipeline_human_review(p_review_id uuid, p_decision text, p_reviewer_id text, p_facts_acceptable boolean, p_attribution_acceptable boolean, p_uncertainty_preserved boolean, p_headline_acceptable boolean, p_summary_acceptable boolean, p_no_unsupported_material_claims boolean, p_source_chain_acceptable boolean)",
    "publish_reviewed_article_atomic(p_review_id uuid, p_event_key text, p_attempt_id uuid, p_pipeline_run_id uuid, p_draft_id text, p_draft_sha256 text, p_checkpoint_hashes jsonb, p_source_lineage jsonb, p_publication_payload jsonb)",
  ].sort();
  const functionDiff = diffArray(before.functions, after.functions);
  assert.deepEqual(functionDiff.added, expectedNewFunctions, "only the five review RPC/helper signatures were added");
  assert.deepEqual(functionDiff.removed, [], "no existing function signature was removed");
  const beforeFunctionHashes = before.functionHashes;
  const afterFunctionHashes = after.functionHashes;
  const changedFunctions = Object.keys(beforeFunctionHashes).filter((key) => beforeFunctionHashes[key] !== afterFunctionHashes[key]).sort();
  assert.deepEqual(changedFunctions, [
    "claim_pipeline_event_attempt(p_event_key text, p_pipeline_run_id uuid, p_started_at timestamp with time zone, p_now timestamp with time zone, p_stale_after_seconds integer)",
    "finalize_pipeline_event_attempt(p_attempt_id uuid, p_pipeline_run_id uuid, p_completed_at timestamp with time zone, p_final_state text, p_stop_stage text, p_stop_reason text, p_retry_class text, p_counts_toward_retry_limit boolean, p_next_eligible_at timestamp with time zone)",
  ].sort(), "only claim/finalize attempt lifecycle functions changed");
  const typeDiff = diffArray(before.types, after.types);
  assert.deepEqual(typeDiff.added, ["pipeline_human_reviews"], "only the review-table row type was added (the inventory intentionally omits built-in array types)");
  assert.deepEqual(typeDiff.removed, [], "no PostgreSQL type was removed");
  const indexDiff = diffArray(before.indexes, after.indexes);
  assert.deepEqual(indexDiff.added, ["pipeline_event_attempts_one_human_review_waiting_idx", "pipeline_human_reviews_attempt_id_key", "pipeline_human_reviews_pkey"].sort(), "only the waiting uniqueness index and review table indexes were added");
  assert.deepEqual(indexDiff.removed, [], "no index was removed");
  assert.deepEqual(diffArray(before.triggers, after.triggers), { added: [], removed: [] }, "no trigger was added or removed");
  const beforeConstraints = new Map(before.constraints.map((constraint) => [`${constraint.table}:${constraint.name}`, constraint.definition]));
  const afterConstraints = new Map(after.constraints.map((constraint) => [`${constraint.table}:${constraint.name}`, constraint.definition]));
  const addedConstraints = [...afterConstraints.keys()].filter((key) => !beforeConstraints.has(key)).sort();
  const removedConstraints = [...beforeConstraints.keys()].filter((key) => !afterConstraints.has(key)).sort();
  const changedConstraints = [...beforeConstraints.keys()].filter((key) => afterConstraints.has(key) && beforeConstraints.get(key) !== afterConstraints.get(key)).sort();
  const manifestConstraints = after.constraints.filter((constraint) => constraint.name === "pipeline_human_reviews_review_manifest_check");
  assert.equal(manifestConstraints.length, 1, "remote catalog contains exactly one canonical review-manifest constraint");
  assert.match(manifestConstraints[0].definition, /jsonb_typeof\(review_manifest\)\s*=\s*'object'/i, "remote constraint preserves object shape");
  assert.match(manifestConstraints[0].definition, /schemaVersion[\s\S]*packageSha256[\s\S]*checkpoints[\s\S]*identity[\s\S]*sha256/i, "remote constraint preserves strict checkpoint identities and hashes");
  assert.deepEqual(removedConstraints, [], "no existing constraint was removed");
  assert.deepEqual(changedConstraints, ["pipeline_event_attempts:pipeline_event_attempts_final_state_check"], "only the final-state constraint changed on an existing table");
  assert.ok(addedConstraints.every((key) => key.startsWith("pipeline_human_reviews:")), "all added constraints belong to the new review table");
  return { relationDiff, functionDiff, changedFunctions, typeDiff, indexDiff, addedConstraints, changedConstraints, reviewManifestConstraintCount: manifestConstraints.length, reviewManifestConstraintDefinition: manifestConstraints[0].definition, triggers: "UNCHANGED" };
}

async function baseline() {
  return oneRow(`
select jsonb_build_object(
 'publicArticles',(select jsonb_agg(jsonb_build_object('id',a.id,'slug',a.slug,'rowMd5',md5(to_jsonb(a)::text)) order by a.slug) from public.articles a where a.publication_status='published'),
 'publicCount',(select count(*) from public.public_published_articles),
 'astra',(select jsonb_build_object('id',a.id,'status',a.publication_status,'slug',a.slug,'rowMd5',md5(to_jsonb(a)::text)) from public.articles a where a.id='756b0ee0-b5e6-4153-846f-278a12c9afe3'::uuid),
 'attemptCount',(select count(*) from public.pipeline_event_attempts a where not exists(select 1 from public.agent_runs ar where ar.id=a.pipeline_run_id and ar.config->>'validationNamespace' like '12e1a:%')),
 'attemptRowsMd5',(select md5(coalesce(string_agg(md5(to_jsonb(a)::text),',' order by a.id),'')) from public.pipeline_event_attempts a where not exists(select 1 from public.agent_runs ar where ar.id=a.pipeline_run_id and ar.config->>'validationNamespace' like '12e1a:%')),
 'pilotAttemptCount',(select count(*) from public.pipeline_event_attempts where pilot_attempt_number is not null),
 'pilotAttemptsMd5',(select md5(coalesce(string_agg(md5(to_jsonb(a)::text),',' order by a.id),'')) from public.pipeline_event_attempts a where pilot_attempt_number is not null),
 'astraAttemptCount',(select count(*) from public.pipeline_event_attempts where event_key='event-30f226d1b8ba5c9eb8af2b65c46db512'),
 'providerAccounting',(select jsonb_build_object('reservationCount',count(*),'rowsMd5',md5(coalesce(string_agg(concat_ws('|',l.id::text,l.run_id::text,coalesce(l.provider,''),coalesce(l.provider_unit,''),coalesce(l.provider_unit_amount::text,''),l.created_at::text),',' order by l.id),''))) from public.agent_logs l where l.step='provider_request_reserved'),
 'reviewCount',(select count(*) from public.pipeline_human_reviews)
) as baseline;`, "baseline_after_migration").baseline;
}

async function cleanup(scenarios) {
  if (!scenarios.length) return;
  const eventKeys = scenarios.map((scenario) => scenario.eventKey);
  const rawIds = scenarios.map((scenario) => scenario.rawItemId).filter(Boolean);
  const runIds = scenarios.map((scenario) => scenario.pipelineRunId);
  const keys = eventKeys.map(sqlLiteral).join(",");
  const raws = rawIds.map((id) => sqlLiteral(id)).join(",");
  const runs = runIds.map((id) => sqlLiteral(id)).join(",");
  dbQuery(`begin;
delete from public.activity_history where source_run_id in (${runs});
delete from public.article_categories c using public.articles a, public.events e where c.article_id=a.id and a.event_id=e.id and e.event_key in (${keys});
delete from public.article_entities c using public.articles a, public.events e where c.article_id=a.id and a.event_id=e.id and e.event_key in (${keys});
delete from public.pipeline_human_reviews where event_key in (${keys});
delete from public.articles a using public.events e where a.event_id=e.id and e.event_key in (${keys});
delete from public.event_sources s using public.events e where s.event_id=e.id and e.event_key in (${keys});
delete from public.events where event_key in (${keys});
delete from public.pipeline_event_attempts where event_key in (${keys});
delete from public.agent_logs where run_id in (${runs});
delete from public.agent_runs where id in (${runs});
delete from public.raw_items where id in (${raws});
commit;`, "synthetic_cleanup");
}

async function readSyntheticResidual() {
  return oneRow(`select jsonb_build_object(
   'reviews',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'eventKey',r.event_key,'attemptId',r.attempt_id,'pipelineRunId',r.pipeline_run_id,'status',r.status) order by r.event_key),'[]'::jsonb) from public.pipeline_human_reviews r where r.pipeline_run_id in (select ar.id from public.agent_runs ar where ar.config->>'validationNamespace' like '12e1a:%')),
   'attempts',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'eventKey',a.event_key,'pipelineRunId',a.pipeline_run_id,'finalState',a.final_state) order by a.event_key),'[]'::jsonb) from public.pipeline_event_attempts a where a.pipeline_run_id in (select ar.id from public.agent_runs ar where ar.config->>'validationNamespace' like '12e1a:%')),
   'events',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'eventKey',e.event_key) order by e.event_key),'[]'::jsonb) from public.events e where e.event_key in (select a.event_key from public.pipeline_event_attempts a where a.pipeline_run_id in (select ar.id from public.agent_runs ar where ar.config->>'validationNamespace' like '12e1a:%'))),
   'articles',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'eventId',a.event_id,'slug',a.slug,'publicationStatus',a.publication_status) order by a.slug),'[]'::jsonb) from public.articles a join public.events e on e.id=a.event_id where e.event_key in (select x.event_key from public.pipeline_event_attempts x where x.pipeline_run_id in (select ar.id from public.agent_runs ar where ar.config->>'validationNamespace' like '12e1a:%'))),
   'rawItems',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'externalId',r.external_id) order by r.external_id),'[]'::jsonb) from public.raw_items r where r.external_id like '12e1a:%'),
   'agentRuns',(select coalesce(jsonb_agg(jsonb_build_object('id',ar.id,'eventKey',ar.config->>'eventKey','validationNamespace',ar.config->>'validationNamespace','provider',ar.provider) order by ar.id),'[]'::jsonb) from public.agent_runs ar where ar.config->>'validationNamespace' like '12e1a:%'),
   'providerReservationCount',(select count(*) from public.agent_logs l join public.agent_runs ar on ar.id=l.run_id where l.step='provider_request_reserved' and ar.config->>'validationNamespace' like '12e1a:%')
  ) as counts;`, "synthetic_residual_inspection").counts;
}

async function inspectSyntheticResidual() {
  const residual = await readSyntheticResidual();
  console.log(JSON.stringify({ status: "PASS", phase: "SYNTHETIC_RESIDUAL_READ_ONLY", namespacePrefix: "12e1a:", residual }));
}

async function cleanupSyntheticResidual() {
  const residual = await readSyntheticResidual();
  const eventKeys = new Set([
    ...residual.reviews.map((row) => row.eventKey),
    ...residual.attempts.map((row) => row.eventKey),
    ...residual.agentRuns.map((row) => row.eventKey).filter(Boolean),
    ...residual.events.map((row) => row.eventKey),
  ]);
  const rawIdsByNamespace = new Map(residual.rawItems.map((row) => [row.externalId, row.id]));
  const scenarios = residual.agentRuns.map((run) => ({
    eventKey: run.eventKey,
    rawItemId: rawIdsByNamespace.get(run.validationNamespace) ?? null,
    pipelineRunId: run.id,
  })).filter((scenario) => scenario.eventKey);
  const representedRawIds = new Set(scenarios.map((scenario) => scenario.rawItemId).filter(Boolean));
  for (const rawItem of residual.rawItems) {
    if (!representedRawIds.has(rawItem.id)) scenarios.push({ eventKey: [...eventKeys][0] ?? "synthetic-cleanup-only", rawItemId: rawItem.id, pipelineRunId: null });
  }
  if (scenarios.length) await cleanup(scenarios);
  const after = await readSyntheticResidual();
  assert.deepEqual(after, { reviews: [], attempts: [], events: [], articles: [], rawItems: [], agentRuns: [], providerReservationCount: 0 }, "exact 12e1a namespace rows and accounting are fully removed");
  console.log(JSON.stringify({ status: "PASS", phase: "SYNTHETIC_RESIDUAL_CLEANUP", namespacePrefix: "12e1a:", removedNamespaceKeys: scenarios.length, syntheticResidualRows: after }));
}

async function auditRemoteObjects() {
  const audit = oneRow(`select jsonb_build_object(
   'latestMigration',(select max(version) from supabase_migrations.schema_migrations),
   'migration31Applied',exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
   'migration32Exists',exists(select 1 from supabase_migrations.schema_migrations where version>'${migrationVersion}'),
   'reviewManifestConstraints',(select coalesce(jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_get_constraintdef(c.oid)) order by c.conname),'[]'::jsonb) from pg_constraint c where c.conrelid='public.pipeline_human_reviews'::regclass and c.conname='pipeline_human_reviews_review_manifest_check'),
   'tableOwner',(select pg_get_userbyid(relowner) from pg_class where oid='public.pipeline_human_reviews'::regclass),
   'rlsEnabled',(select relrowsecurity from pg_class where oid='public.pipeline_human_reviews'::regclass),
   'policyCount',(select count(*) from pg_policies where schemaname='public' and tablename='pipeline_human_reviews'),
   'tablePrivileges',jsonb_build_object('serviceRoleSelect',has_table_privilege('service_role','public.pipeline_human_reviews','select'),'anonSelect',has_table_privilege('anon','public.pipeline_human_reviews','select'),'authenticatedSelect',has_table_privilege('authenticated','public.pipeline_human_reviews','select')),
   'columns',(select coalesce(jsonb_agg(column_name order by ordinal_position),'[]'::jsonb) from information_schema.columns where table_schema='public' and table_name='pipeline_human_reviews'),
   'indexes',(select coalesce(jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef) order by indexname),'[]'::jsonb) from pg_indexes where schemaname='public' and tablename in ('pipeline_human_reviews','pipeline_event_attempts') and indexname in ('pipeline_human_reviews_pkey','pipeline_human_reviews_attempt_id_key','pipeline_event_attempts_one_human_review_waiting_idx')),
   'functions',(select coalesce(jsonb_agg(jsonb_build_object('name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'owner',pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,'config',p.proconfig,'serviceRoleExecute',has_function_privilege('service_role',p.oid,'execute'),'anonExecute',has_function_privilege('anon',p.oid,'execute'),'authenticatedExecute',has_function_privilege('authenticated',p.oid,'execute'),'publicExecute',coalesce((select bool_or(x.grantee=0 and x.privilege_type='EXECUTE') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),false)) order by p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::jsonb) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('claim_pipeline_event_attempt','finalize_pipeline_event_attempt','assert_pipeline_human_review_evidence','assert_pipeline_human_review_source_lineage','create_pipeline_human_review','decide_pipeline_human_review','publish_reviewed_article_atomic','publish_article_atomic'))
  ) as audit;`, "postapply_object_security_audit").audit;
  assert.equal(audit.latestMigration, migrationVersion, "migration 31 is the latest migration");
  assert.equal(audit.migration31Applied, true, "migration 31 is recorded");
  assert.equal(audit.migration32Exists, false, "migration 32 does not exist remotely");
  assert.equal(audit.reviewManifestConstraints.length, 1, "exactly one review-manifest constraint exists remotely");
  assert.equal(audit.rlsEnabled, true, "review storage has RLS enabled");
  assert.equal(audit.policyCount, 0, "review storage has no client policies");
  assert.deepEqual(audit.tablePrivileges, { serviceRoleSelect: false, anonSelect: false, authenticatedSelect: false }, "review rows are not directly readable by API roles");
  const requiredRpcNames = new Set(["claim_pipeline_event_attempt", "finalize_pipeline_event_attempt", "create_pipeline_human_review", "decide_pipeline_human_review", "publish_reviewed_article_atomic"]);
  for (const fn of audit.functions) {
    assert.equal(fn.anonExecute, false, `${fn.name} denies anon execution`);
    assert.equal(fn.authenticatedExecute, false, `${fn.name} denies authenticated execution`);
    assert.equal(fn.publicExecute, false, `${fn.name} denies PUBLIC execution`);
    if (requiredRpcNames.has(fn.name)) assert.equal(fn.serviceRoleExecute, true, `${fn.name} allows the trusted service-role path`);
    if (fn.name === "publish_article_atomic") assert.equal(fn.serviceRoleExecute, false, "the underlying Publisher cannot be called directly by service_role");
  }
  assert.ok(audit.functions.filter((fn) => fn.name !== "publish_article_atomic").every((fn) => fn.securityDefiner && (fn.config || []).some((setting) => setting === "search_path=pg_catalog, public" || setting === "search_path=pg_catalog, public, pg_temp")), "migration 31 routines are SECURITY DEFINER with fixed search_path values");
  console.log(JSON.stringify({ status: "PASS", phase: "POSTAPPLY_READ_ONLY_OBJECT_SECURITY_AUDIT", projectRef, audit }));
}

async function executeSyntheticValidation() {
  assert.ok(existsSync(inventoryPath), "preapply object inventory exists from the read-only preflight");
  const beforeInventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const afterInventory = objectInventory();
  assert.equal(afterInventory.latestMigration, migrationVersion, "migration 31 is latest remotely");
  assert.deepEqual(afterInventory.lateMigrations, ["20260930211903", "20261002105220", "20261002150747", "20261002211000", migrationVersion], "migrations 27 through 31 are applied in order");
  assert.equal(afterInventory.migration31Applied, true, "migration 31 is applied remotely");
  assert.equal(afterInventory.migration32Applied, false, "migration 32 is absent remotely");
  assert.equal(afterInventory.pgcryptoSchema, "extensions", "pgcrypto schema matches the qualified migration calls");
  const objectDiff = assertObjectInventory(beforeInventory, afterInventory);
  const postApplyBaseline = await baseline();
  const preapplyBaseline = beforeInventory._realBaseline;
  assert.ok(preapplyBaseline, "fresh preapply real-data baseline is present");
  for (const key of ["publicArticles", "publicCount", "astra", "attemptCount", "attemptRowsMd5", "pilotAttemptCount", "pilotAttemptsMd5", "astraAttemptCount", "providerAccounting", "reviewCount"]) {
    assert.deepEqual(postApplyBaseline[key], preapplyBaseline[key], `migration application leaves real baseline field ${key} unchanged`);
  }
  const publicSlugsBefore = await publicRead();
  assert.equal(postApplyBaseline.publicCount, 2, "two public articles remain after migration");
  assert.equal(postApplyBaseline.astra?.status, "archived", "Astra remains archived");
  assert.equal(postApplyBaseline.reviewCount, 0, "no review records existed before synthetic validation");

  const access = oneRow(`select jsonb_build_object(
   'rlsEnabled',(select relrowsecurity from pg_class where oid='public.pipeline_human_reviews'::regclass),
   'tableOwner',(select pg_get_userbyid(relowner) from pg_class where oid='public.pipeline_human_reviews'::regclass),
   'policies',(select count(*) from pg_policies where schemaname='public' and tablename='pipeline_human_reviews'),
   'columns',(select coalesce(jsonb_agg(column_name order by ordinal_position),'[]'::jsonb) from information_schema.columns where table_schema='public' and table_name='pipeline_human_reviews'),
   'serviceRoleTableSelect',has_table_privilege('service_role','public.pipeline_human_reviews','select'),
   'anonTableSelect',has_table_privilege('anon','public.pipeline_human_reviews','select'),
   'authenticatedTableSelect',has_table_privilege('authenticated','public.pipeline_human_reviews','select'),
   'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'owner',pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,'config',p.proconfig,'serviceRoleExecute',has_function_privilege('service_role',p.oid,'execute'),'anonExecute',has_function_privilege('anon',p.oid,'execute'),'authenticatedExecute',has_function_privilege('authenticated',p.oid,'execute'),'publicExecute',coalesce((select bool_or(x.grantee=0 and x.privilege_type='EXECUTE') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),false)) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('claim_pipeline_event_attempt','finalize_pipeline_event_attempt','assert_pipeline_human_review_evidence','assert_pipeline_human_review_source_lineage','create_pipeline_human_review','decide_pipeline_human_review','publish_reviewed_article_atomic','publish_article_atomic'))
  ) as security;`, "security_audit").security;
  assert.equal(access.rlsEnabled, true, "review table has RLS enabled");
  assert.equal(access.policies, 0, "review table has no client-access policy");
  assert.equal(access.serviceRoleTableSelect, false, "service_role cannot read review table directly");
  assert.equal(access.anonTableSelect, false, "anon cannot read review table directly");
  assert.equal(access.authenticatedTableSelect, false, "authenticated cannot read review table directly");
  for (const name of ["event_key", "attempt_id", "pipeline_run_id", "draft_id", "draft_sha256", "source_lineage_sha256", "publication_payload_sha256", "review_manifest", "reviewer_id", "reviewed_at", "decision_history"]) {
    assert.ok(access.columns.includes(name), `durable review table contains ${name}`);
  }
  assert.equal(access.columns.some((name) => ["publication_payload", "raw_content", "body", "body_es", "review_material"].includes(name)), false, "review table has no duplicate article or payload content columns");
  const migration31FunctionNames = new Set([
    "claim_pipeline_event_attempt", "finalize_pipeline_event_attempt",
    "assert_pipeline_human_review_evidence", "assert_pipeline_human_review_source_lineage",
    "create_pipeline_human_review", "decide_pipeline_human_review", "publish_reviewed_article_atomic",
  ]);
  for (const fn of access.functions) {
    if (migration31FunctionNames.has(fn.name)) {
      assert.equal(fn.securityDefiner, true, `${fn.name} is SECURITY DEFINER`);
      assert.ok((fn.config || []).some((setting) => setting === "search_path=pg_catalog, public" || setting === "search_path=pg_catalog, public, pg_temp"), `${fn.name} has a fixed safe search_path`);
    }
    assert.equal(fn.anonExecute, false, `${fn.name} denies anon execution`);
    assert.equal(fn.authenticatedExecute, false, `${fn.name} denies authenticated execution`);
    assert.equal(fn.publicExecute, false, `${fn.name} denies PUBLIC execution`);
    if (["claim_pipeline_event_attempt", "finalize_pipeline_event_attempt", "create_pipeline_human_review", "decide_pipeline_human_review", "publish_reviewed_article_atomic"].includes(fn.name)) {
      assert.equal(fn.serviceRoleExecute, true, `${fn.name} permits the service-role RPC path`);
    } else {
      assert.equal(fn.serviceRoleExecute, false, `${fn.name} helper is not directly callable by service_role`);
    }
  }
  const publishedBase = access.functions.find((fn) => fn.name === "publish_article_atomic");
  assert.equal(publishedBase?.serviceRoleExecute, false, "ordinary service_role cannot bypass the review wrapper");

  const deniedAnonymous = await rpc("create_pipeline_human_review", {
    p_event_key: namespace, p_attempt_id: randomUUID(), p_pipeline_run_id: randomUUID(), p_draft_id: "denied", p_draft_sha256: "0".repeat(64),
    p_source_lineage: [], p_review_manifest: {}, p_publication_payload: {},
  }, anonKey);
  assertDenied(deniedAnonymous, "anonymous review mutation RPC");
  const deniedDirectPublish = await rpc("publish_article_atomic", { p_payload: {} });
  assertDenied(deniedDirectPublish, "direct ordinary Publisher RPC");
  const deniedReviewTable = await rest("/rest/v1/pipeline_human_reviews?select=id&limit=1", serviceKey);
  assertDenied(deniedReviewTable, "direct service-role review table read");

  const [{ validFixtures }, sources, regions, categories] = await Promise.all([
    import("../lib/agents/contracts/fixtures.ts"),
    rest("/rest/v1/sources?select=id,name,url&is_active=eq.true&limit=1"),
    rest("/rest/v1/regions?select=id,code,latitude,longitude&code=eq.US&is_active=eq.true&limit=1"),
    rest("/rest/v1/categories?select=slug&slug=eq.chips&is_active=eq.true&limit=1"),
  ]);
  const source = sources.data?.[0];
  const region = regions.data?.[0];
  const category = categories.data?.[0];
  assert.equal(sources.status, 200, "source lookup is read-only and successful");
  assert.equal(regions.status, 200, "region lookup is read-only and successful");
  assert.equal(categories.status, 200, "category lookup is read-only and successful");
  assert.ok(source?.id && region?.latitude !== undefined && category?.slug, "synthetic fixture references are available");
  const refs = {
    source,
    region,
    category,
    basePayload: structuredClone(validFixtures.PublicationPayload),
    scenarios: [],
  };

  let reported;
  let validationError;
  const continuationFunctionKey = Object.keys(beforeInventory.functionHashes).find((key) => key.startsWith("resume_incident_factual_remediation_continuation("));
  assert.ok(continuationFunctionKey, "migration 30 continuation RPC is present in the preapply inventory");
  const continuationFunctionHash = beforeInventory.functionHashes[continuationFunctionKey];
  try {
    const noApproval = await createScenario("no-approval", refs);
    const noApprovalResult = await rpc("publish_reviewed_article_atomic", publicationArgs(noApproval));
    assert.notEqual(noApprovalResult.status, 200, "publication without approval is rejected");
    assert.match(JSON.stringify(noApprovalResult.data), /HUMAN_APPROVAL_REQUIRED/i, "no-approval rejection names the missing human approval");
    await assertNotPublished(noApproval, "no_approval");

    const hold = await createScenario("hold", refs);
    const holdDecision = await decide(hold, "HOLD");
    assert.equal(holdDecision.status, 200, "HOLD decision is durably stored");
    assert.equal((await storedReview(hold.reviewId)).status, "HOLD", "HOLD status is durable");
    assert.equal(oneRow(`select final_state from public.pipeline_event_attempts where id=${sqlLiteral(hold.attemptId)}::uuid;`, "hold_attempt_state").final_state, "WAITING_FOR_HUMAN_REVIEW", "HOLD does not restart or retry the attempt");
    const holdResult = await rpc("publish_reviewed_article_atomic", publicationArgs(hold));
    assert.notEqual(holdResult.status, 200, "HOLD cannot publish");
    assert.match(JSON.stringify(holdResult.data), /human_review_held/i, "HOLD returns the blocked reason");
    await assertNotPublished(hold, "hold");

    const reject = await createScenario("reject", refs);
    const rejectDecision = await decide(reject, "REJECT");
    assert.equal(rejectDecision.status, 200, "REJECT decision is durably stored");
    assert.equal((await storedReview(reject.reviewId)).status, "REJECTED", "REJECT status is durable");
    assert.equal(oneRow(`select final_state from public.pipeline_event_attempts where id=${sqlLiteral(reject.attemptId)}::uuid;`, "reject_attempt_state").final_state, "WAITING_FOR_HUMAN_REVIEW", "REJECT does not restart or retry the attempt");
    const rejectResult = await rpc("publish_reviewed_article_atomic", publicationArgs(reject));
    assert.notEqual(rejectResult.status, 200, "REJECT cannot publish");
    assert.match(JSON.stringify(rejectResult.data), /human_review_rejected/i, "REJECT returns the blocked reason");
    await assertNotPublished(reject, "reject");

    const criticNonPass = await createScenario("critic-non-pass", refs, { criticNonPass: true });
    assert.equal(criticNonPass.creationBlocked, true, "a non-pass Critic result cannot enter human-review publication eligibility");
    const usageUnsettled = await createScenario("usage-unsettled", refs, { usageUnsettled: true });
    assert.equal(usageUnsettled.creationBlocked, true, "unsettled provider accounting cannot enter human-review publication eligibility");

    const approval = await createScenario("approved-single-use", refs);
    const incomplete = await decide(approval, "APPROVE", { facts: false });
    assert.notEqual(incomplete.status, 200, "APPROVE without factual review is rejected");
    assert.match(JSON.stringify(incomplete.data), /human_review_approval_checks_incomplete/i, "factual approval is mandatory");
    assert.equal((await storedReview(approval.reviewId)).status, "WAITING_FOR_HUMAN_REVIEW", "incomplete approval does not alter the waiting review");
    const noAttribution = await decide(approval, "APPROVE", { attribution: false });
    assert.notEqual(noAttribution.status, 200, "APPROVE without attribution review is rejected");
    assert.match(JSON.stringify(noAttribution.data), /human_review_approval_checks_incomplete/i, "attribution approval is mandatory");
    const approved = await decide(approval, "APPROVE");
    assert.equal(approved.status, 200, "valid factual and attribution approval is stored");
    const storedApproval = await storedReview(approval.reviewId);
    assert.equal(storedApproval.status, "APPROVED", "valid approval is eligible");
    assert.equal(storedApproval.reviewer_approved, true, "approval boolean is stored");
    assert.equal(storedApproval.facts_acceptable, true, "factual review is stored");
    assert.equal(storedApproval.attribution_acceptable, true, "attribution review is stored");
    assert.ok(storedApproval.reviewer_id && storedApproval.reviewed_at && storedApproval.decision_history?.length === 1, "reviewer, timestamp, and action provenance are stored");

    const badDraft = publicationArgs(approval);
    badDraft.p_draft_sha256 = sha256("changed draft");
    const staleDraft = await rpc("publish_reviewed_article_atomic", badDraft);
    assert.notEqual(staleDraft.status, 200, "changed draft hash is stale");
    const badCheckpoints = publicationArgs(approval);
    badCheckpoints.p_checkpoint_hashes = structuredClone(approval.manifest.checkpoints);
    badCheckpoints.p_checkpoint_hashes.critic.sha256 = sha256("changed critic checkpoint");
    const staleCheckpoint = await rpc("publish_reviewed_article_atomic", badCheckpoints);
    assert.notEqual(staleCheckpoint.status, 200, "changed Critic checkpoint identity is stale");
    const badPayload = publicationArgs(approval);
    badPayload.p_publication_payload = structuredClone(approval.payload);
    badPayload.p_publication_payload.article.bodyEs += " changed";
    const stalePayload = await rpc("publish_reviewed_article_atomic", badPayload);
    assert.notEqual(stalePayload.status, 200, "changed publication payload is stale");
    const badSource = await rest(`/rest/v1/raw_items?id=eq.${encodeURIComponent(approval.rawItemId)}`, serviceKey, "PATCH", { content_hash: sha256("changed synthetic source lineage") });
    assert.equal(badSource.status, 200, "synthetic source lineage mutation succeeds");
    const staleSource = await rpc("publish_reviewed_article_atomic", publicationArgs(approval));
    assert.notEqual(staleSource.status, 200, "changed source lineage is stale");
    const restoreSource = await rest(`/rest/v1/raw_items?id=eq.${encodeURIComponent(approval.rawItemId)}`, serviceKey, "PATCH", { content_hash: approval.sourceContentHash });
    assert.equal(restoreSource.status, 200, "synthetic source lineage is restored for cleanup/publication");
    const wrongEventArgs = publicationArgs(approval);
    wrongEventArgs.p_event_key = noApproval.eventKey;
    const wrongEvent = await rpc("publish_reviewed_article_atomic", wrongEventArgs);
    assert.notEqual(wrongEvent.status, 200, "wrong event is rejected");
    const wrongAttemptArgs = publicationArgs(approval);
    wrongAttemptArgs.p_attempt_id = noApproval.attemptId;
    const wrongAttempt = await rpc("publish_reviewed_article_atomic", wrongAttemptArgs);
    assert.notEqual(wrongAttempt.status, 200, "wrong attempt is rejected");
    await assertNotPublished(approval, "approved_before_atomic_publish");

    const concurrent = await Promise.all([
      rpc("publish_reviewed_article_atomic", publicationArgs(approval)),
      rpc("publish_reviewed_article_atomic", publicationArgs(approval)),
    ]);
    const successfulConsumes = concurrent.filter((result) => result.status === 200);
    const rejectedConsumes = concurrent.filter((result) => result.status !== 200);
    assert.equal(successfulConsumes.length, 1, `one of two concurrent consume calls succeeds; responses=${JSON.stringify(concurrent.map(({ status, data }) => ({ status, data })))}`);
    assert.equal(rejectedConsumes.length, 1, `one of two concurrent consume calls is rejected; responses=${JSON.stringify(concurrent.map(({ status, data }) => ({ status, data })))}`);
    assert.equal(successfulConsumes[0].data.humanReviewStatus, "PUBLISHED", "canonical wrapper publishes the synthetic article");
    const secondConsume = await rpc("publish_reviewed_article_atomic", publicationArgs(approval));
    assert.notEqual(secondConsume.status, 200, "a second consume is rejected");
    const finalReview = await storedReview(approval.reviewId);
    assert.equal(finalReview.status, "PUBLISHED", "review is marked published after one atomic consume");
    assert.equal(finalReview.consumed_at !== null, true, "approval consumption is durable");
    const finalAttempt = oneRow(`select final_state,stop_stage from public.pipeline_event_attempts where id=${sqlLiteral(approval.attemptId)}::uuid;`, "approved_attempt_published");
    assert.equal(finalAttempt.final_state, "READY_FOR_PUBLICATION", "published attempt reaches the existing ready terminal state");
    const publishedSlug = await rest(`/rest/v1/public_published_articles?select=slug&slug=eq.${encodeURIComponent(approval.payload.article.slug)}`, anonKey);
    assert.equal(publishedSlug.status, 200, "anonymous read remains available after synthetic approved publication");
    assert.ok(publishedSlug.data.some((article) => article.slug === approval.payload.article.slug), "only the approved synthetic article becomes public");

    const unchangedFunction = afterInventory.functionHashes;
    assert.equal(unchangedFunction[continuationFunctionKey], continuationFunctionHash, "migration 30 continuation function definition is unchanged remotely");
    reported = {
      status: "PASS",
      projectRef,
      migrationLatest: afterInventory.latestMigration,
      migration31Applied: afterInventory.migration31Applied,
      migration32Exists: afterInventory.migration32Applied,
      namespacePrefix: "12e1a:",
      syntheticScenarios: refs.scenarios.length,
      waitingState: "PASS",
      withoutApproval: "BLOCKED",
      hold: "BLOCKED",
      reject: "BLOCKED",
      approve: "STORED_ELIGIBLE",
      factualReviewRequired: "YES",
      attributionReviewRequired: "YES",
      factualFalse: "BLOCKED",
      attributionFalse: "BLOCKED",
      staleApproval: "BLOCKED_DRAFT_CHECKPOINT_SOURCE_AND_PAYLOAD",
      wrongEvent: "BLOCKED",
      wrongAttempt: "BLOCKED",
      criticNonPass: "BLOCKED",
      usageUnsettled: "BLOCKED",
      singleUse: "PASS",
      concurrency: { admitted: successfulConsumes.length, rejected: rejectedConsumes.length },
      security: {
        anon: "DENIED",
        authenticated: "DENIED_BY_ACL",
        serviceRole: "ALLOWED_FOR_REVIEW_RPCS",
        directPublisherBypass: "DENIED",
        tableOwner: access.tableOwner,
        tableSelect: { serviceRole: access.serviceRoleTableSelect, anon: access.anonTableSelect, authenticated: access.authenticatedTableSelect },
        functions: access.functions,
      },
      constraintCount: objectDiff.reviewManifestConstraintCount,
      remoteObjects: objectDiff,
      existingLifecycleRegression: { migration30ResumeFunctionHashUnchanged: true, syntheticResume: "NOT_RUN_NAMESPACE_NOT_ACCEPTED_BY_IMMUTABLE_MIGRATION_30" },
      preapplyBaseline,
      postApplyBaseline,
    };
  } catch (error) {
    validationError = error;
  }
  let cleanupError;
  try {
    await cleanup(refs.scenarios);
  } catch (error) {
    cleanupError = error;
  }
  if (validationError && cleanupError) throw new AggregateError([validationError, cleanupError], "Synthetic validation failed and cleanup also failed");
  if (cleanupError) throw cleanupError;
  if (validationError) throw validationError;

  const finalBaseline = await baseline();
  const afterCleanupInventory = objectInventory();
  assert.deepEqual(finalBaseline.publicArticles, postApplyBaseline.publicArticles, "real public article rows are unchanged after cleanup");
  assert.equal(finalBaseline.publicCount, 2, "two real public articles remain after cleanup");
  assert.deepEqual(finalBaseline.astra, postApplyBaseline.astra, "Astra remains unchanged and archived");
  assert.equal(finalBaseline.attemptCount, postApplyBaseline.attemptCount, "real attempt count is unchanged after cleanup");
  assert.equal(finalBaseline.attemptRowsMd5, postApplyBaseline.attemptRowsMd5, "real attempt rows are unchanged after cleanup");
  assert.equal(finalBaseline.pilotAttemptCount, postApplyBaseline.pilotAttemptCount, "pilot attempt count is unchanged");
  assert.equal(finalBaseline.pilotAttemptsMd5, postApplyBaseline.pilotAttemptsMd5, "pilot attempt rows are unchanged");
  assert.equal(finalBaseline.astraAttemptCount, postApplyBaseline.astraAttemptCount, "Astra attempt count is unchanged");
  assert.deepEqual(finalBaseline.providerAccounting, postApplyBaseline.providerAccounting, "provider accounting is unchanged");
  assert.equal(finalBaseline.reviewCount, 0, "no review records remain");
  const residualDetails = await readSyntheticResidual();
  const residual = {
    reviews: residualDetails.reviews.length,
    attempts: residualDetails.attempts.length,
    events: residualDetails.events.length,
    articles: residualDetails.articles.length,
    rawItems: residualDetails.rawItems.length,
    agentRuns: residualDetails.agentRuns.length,
    providerReservations: residualDetails.providerReservationCount,
  };
  assert.deepEqual(residual, { reviews: 0, attempts: 0, events: 0, articles: 0, rawItems: 0, agentRuns: 0, providerReservations: 0 }, "all 12e1a synthetic rows were removed");
  const finalPublicSlugs = await publicRead();
  assert.equal(finalPublicSlugs.length, 2, "anonymous public read returns the original two articles after cleanup");
  assert.deepEqual(finalPublicSlugs, publicSlugsBefore, "public read returns the same two article slugs after cleanup");
  assert.deepEqual(afterCleanupInventory, afterInventory, "synthetic validation leaves no schema or routine changes");
  assert.equal(afterCleanupInventory.functionHashes[continuationFunctionKey], continuationFunctionHash, "migration 30 continuation function definition remains unchanged after cleanup");
  console.log(JSON.stringify({ ...reported, realDataIsolation: "PASS", syntheticResidualRows: residual, providerCalls: 0, finalBaseline, publicRead: { status: "PASS", count: finalPublicSlugs.length } }));
}

const mode = process.argv.includes("--preapply-snapshot") ? "preapply" : process.argv.includes("--execute-synthetic-validation") ? "execute" : process.argv.includes("--inspect-synthetic-residual") ? "inspect" : process.argv.includes("--cleanup-synthetic-residual") ? "cleanup" : process.argv.includes("--postapply-object-security-audit") ? "audit" : "invalid";
if (mode === "invalid") throw new Error("PASS --preapply-snapshot OR --execute-synthetic-validation OR --inspect-synthetic-residual OR --cleanup-synthetic-residual OR --postapply-object-security-audit EXPLICITLY");
if (mode === "preapply") await preapplySnapshot();
else if (mode === "execute") await executeSyntheticValidation();
else if (mode === "inspect") await inspectSyntheticResidual();
else if (mode === "cleanup") await cleanupSyntheticResidual();
else await auditRemoteObjects();
for (const path of scratchFiles) {
  try { unlinkSync(path); } catch { /* best-effort scratch cleanup */ }
}
