import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const projectRef = "skrthgpurquypgdwxast";
const namespace = "12c2b2d:" + randomUUID();
const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const snapshotSqlPath = resolve(repo, "supabase/.temp/12c2b1-baseline.sql");
const migrationPath = resolve(repo, "supabase/migrations/20261002105220_factual_remediation_continuation.sql");
const scratchFiles = new Set();
const realIds = new Set([
  "756b0ee0-b5e6-4153-846f-278a12c9afe3", "5138e509-f4c3-4020-9d13-6a6efac99a39",
  "a82482be-58d8-4fc6-ac16-946d0906257b", "db368f10-d9c1-4897-b752-b3d2cb156e09",
  "4017edf4-86be-49f1-a464-e766ad371284", "d3834944-72f6-4f59-9aca-3f66ae92dc33",
  "e8dd0363-f51e-4381-9fb2-c02ee81f4d41",
]);
const testNames = [
  "valid", "concurrency", "dispatch-marker", "critic-run-exists", "not-archived",
  "wrong-lineage-namespace", "missing-verifier", "wrong-event-key", "wrong-source-run",
  "wrong-checkpoint-hash", "stage-verifier", "stage-translator", "stage-editor",
  "stage-classifier", "stage-ranker", "stage-publisher", "active-attempt",
  "ready-attempt", "other-terminal", "unsupported-technical-failure", "wrong-purpose",
];

if (!process.argv.includes("--execute-synthetic-validation")) throw new Error("SYNTHETIC_VALIDATION_REQUIRES_EXPLICIT_FLAG");
if (!existsSync(snapshotSqlPath) || !existsSync(migrationPath)) throw new Error("PREFLIGHT_FILE_MISSING");
if (!supabaseUrl || !serviceKey || !anonKey) throw new Error("SUPABASE_VALIDATION_CONFIGURATION_MISSING");
if (new URL(supabaseUrl).hostname.split(".")[0] !== projectRef) throw new Error("SUPABASE_URL_PROJECT_REF_MISMATCH");

const sqlLiteral = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const jsonLiteral = (value) => sqlLiteral(JSON.stringify(value)) + "::jsonb";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const md5 = (value) => createHash("md5").update(value).digest("hex");
function runDbQuery(sql, label) {
  const path = resolve(repo, "supabase/.temp", `12c2b2d-${randomUUID()}-${label}.sql`);
  scratchFiles.add(path);
  writeFileSync(path, sql.trim() + "\n", "utf8");
  const cli = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(cli, ["--yes", "supabase", "db", "query", "--linked", "--output-format", "json", "--file", path], {
    cwd: repo, encoding: "utf8", shell: process.platform === "win32", windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error(`DB_QUERY_${label}_FAILED:${result.error?.message || result.status}`);
  const output = result.stdout || "";
  const start = output.indexOf("{");
  if (start < 0) throw new Error(`DB_QUERY_${label}_RESULT_MISSING`);
  try { return JSON.parse(output.slice(start)); } catch { throw new Error(`DB_QUERY_${label}_RESULT_INVALID`); }
}

async function rest(path, key = serviceKey, method = "GET", body = undefined) {
  const response = await fetch(supabaseUrl + path, {
    method, cache: "no-store",
    headers: { apikey: key, Authorization: "Bearer " + key, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { message: raw.slice(0, 200) }; }
  return { status: response.status, body: parsed };
}

async function rpc(args, key = serviceKey) {
  return rest("/rest/v1/rpc/authorize_incident_factual_remediation_continuation", key, "POST", args);
}

function queryOne(sql, label) {
  const result = runDbQuery(sql, label);
  assert.equal(result.rows?.length, 1, `${label} returns one row`);
  return result.rows[0];
}

async function snapshot() {
  const raw = queryOne(readFileSync(snapshotSqlPath, "utf8"), "baseline").baseline;
  const details = queryOne(`
select jsonb_build_object(
 'realAttempt',(select to_jsonb(a) from public.pipeline_event_attempts a where a.id='a82482be-58d8-4fc6-ac16-946d0906257b'),
 'attemptCount',(select count(*) from public.pipeline_event_attempts where event_key='event-30f226d1b8ba5c9eb8af2b65c46db512'),
 'continuationColumn',exists(select 1 from information_schema.columns where table_schema='public' and table_name='pipeline_event_attempts' and column_name='continuation'),
 'functions',(select jsonb_agg(jsonb_build_object('name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'owner',r.rolname,'securityDefiner',p.prosecdef,'config',p.proconfig,'acl',p.proacl) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname in ('authorize_incident_factual_remediation_continuation','finish_incident_factual_remediation_continuation','publish_incident_factual_remediation_continuation_atomic')),
 'functionSecurity',(select jsonb_agg(jsonb_build_object('name',p.proname,'serviceRoleExecute',has_function_privilege('service_role',p.oid,'execute'),'anonExecute',has_function_privilege('anon',p.oid,'execute'),'authenticatedExecute',has_function_privilege('authenticated',p.oid,'execute'),'publicExecute',coalesce((select bool_or(x.grantee=0 and x.privilege_type='EXECUTE') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),false)) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('authorize_incident_factual_remediation_continuation','finish_incident_factual_remediation_continuation','publish_incident_factual_remediation_continuation_atomic')),
 'continuationColumns',(select jsonb_agg(jsonb_build_object('column',column_name,'type',data_type,'nullable',is_nullable) order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='pipeline_event_attempts' and column_name in ('continuation','validation_namespace','pilot_attempt_number')),
 'continuationConstraints',(select jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid)) order by conname) from pg_constraint where conrelid='public.pipeline_event_attempts'::regclass and conname in ('pipeline_event_attempts_continuation_shape_check','pipeline_event_attempts_remediation_metadata_check')),
 'continuationIndexes',(select jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef) order by indexname) from pg_indexes where schemaname='public' and tablename='pipeline_event_attempts' and indexname='pipeline_event_attempts_continuation_run_id_idx'),
 'normalRoutineHashes',(select jsonb_agg(jsonb_build_object('name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'md5',md5(pg_get_functiondef(p.oid))) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('claim_pipeline_event_attempt','claim_factual_remediation_attempt','claim_incident_factual_remediation_attempt','publish_factual_remediation_article_atomic')),
 'newTables',(select count(*) from information_schema.tables where table_schema='public' and table_name like '%continuation%')
) as detail;`, "details").detail;
  return { ...raw, detail: details };
}

function assertSnapshotExceptCapacity(actual, expected, message) {
  const { capacity: actualCapacity, ...actualWithoutCapacity } = actual;
  const { capacity: expectedCapacity, ...expectedWithoutCapacity } = expected;
  assert.deepEqual(actualWithoutCapacity, expectedWithoutCapacity, message);
  return { actualCapacity, expectedCapacity };
}

async function publicRows() {
  const url = new URL(supabaseUrl + "/rest/v1/public_published_articles");
  url.searchParams.set("select", "slug");
  url.searchParams.set("order", "slug.asc");
  const response = await rest(url.pathname + url.search, anonKey);
  assert.equal(response.status, 200, "public article contract is readable with anon role");
  return response.body;
}

async function freshRealRead() {
  const queries = [
    ["articles", "id,event_id,slug,publication_status", "id", "756b0ee0-b5e6-4153-846f-278a12c9afe3"],
    ["events", "id,event_key,event_status,review_status", "id", "5138e509-f4c3-4020-9d13-6a6efac99a39"],
    ["pipeline_event_attempts", "id,event_key,pipeline_run_id,attempt_number,purpose,pilot_attempt_number,final_state,completed_at,stop_stage,stop_reason,continuation", "id", "a82482be-58d8-4fc6-ac16-946d0906257b"],
  ];
  const values = {};
  for (const [table, select, filter, id] of queries) {
    const url = new URL(supabaseUrl + "/rest/v1/" + table);
    url.searchParams.set("select", select);
    url.searchParams.set(filter, "eq." + id);
    const result = await rest(url.pathname + url.search);
    assert.equal(result.status, 200, `authorized live read succeeded for ${table}`);
    assert.equal(result.body.length, 1, `${table} incident row exists`);
    values[table] = result.body[0];
  }
  assert.equal(values.articles.publication_status, "archived");
  assert.equal(values.articles.event_id, values.events.id);
  assert.equal(values.pipeline_event_attempts.id, "a82482be-58d8-4fc6-ac16-946d0906257b");
  return values;
}

function makeFixture(name) {
  const eventId = randomUUID();
  const articleId = randomUUID();
  const rawItemId = randomUUID();
  const sourceId = randomUUID();
  const priorAttemptId = randomUUID();
  const priorRunId = randomUUID();
  const attemptId = randomUUID();
  const remediationRunId = randomUUID();
  const criticRunId = randomUUID();
  const eventKey = "event-" + md5(namespace + ":" + name + ":" + eventId);
  const wrongLineage = "wrong-lineage-namespace" === name;
  const lineageNamespace = wrongLineage ? "12c2b2d:" + randomUUID() : namespace;
  const fixture = {
    name, eventId, articleId, rawItemId, sourceId, priorAttemptId, priorRunId,
    attemptId, remediationRunId, criticRunId, eventKey,
    slug: "synthetic-12c2b2d-" + name + "-" + eventId.slice(0, 8),
    articleStatus: name === "not-archived" ? "draft" : "archived",
    lineageNamespace,
    attemptPurpose: name === "wrong-purpose" ? "NORMAL" : "FACTUAL_REMEDIATION",
    state: name === "active-attempt" ? "ACTIVE" : name === "ready-attempt" ? "READY_FOR_PUBLICATION"
      : name === "other-terminal" ? "PROVIDER_RATE_LIMIT" : "TECHNICAL_FAILURE",
    stopReason: name === "unsupported-technical-failure" ? "provider_timeout" : "cost_guard_violation",
    criticDispatched: name === "dispatch-marker",
    criticRunExists: name === "critic-run-exists",
  };
  for (const id of [eventId, articleId, rawItemId, sourceId, priorAttemptId, priorRunId, attemptId, remediationRunId, criticRunId]) {
    assert.equal(realIds.has(id), false, "synthetic fixture never reuses a real incident UUID");
  }
  return fixture;
}

const fixtures = Object.fromEntries(testNames.map((name) => [name, makeFixture(name)]));

function fixtureSetupSql() {
  const statements = ["begin;"];
  for (const fixture of Object.values(fixtures)) {
    const { eventId, articleId, rawItemId, sourceId, priorAttemptId, priorRunId, attemptId, remediationRunId, criticRunId, eventKey, slug, lineageNamespace } = fixture;
    const text = `Synthetic continuation fixture ${namespace} ${fixture.name}; no source facts.`;
    const contentHash = "sha256:" + sha256(text);
    const marker = namespace + ":synthetic-prior:" + fixture.name;
    const eventMeta = { validationNamespace: lineageNamespace, fixture: fixture.name };
    const articleMeta = { validationNamespace: lineageNamespace, fixture: fixture.name };
    const rawMeta = { validationNamespace: lineageNamespace, fixture: fixture.name };
    const sourceMeta = { validationNamespace: lineageNamespace, fixture: fixture.name };
    statements.push(
      `insert into public.sources(id,name,url,source_type,language,metadata) values (${sqlLiteral(sourceId)},${sqlLiteral("12C.2B.2d synthetic source " + fixture.name)},${sqlLiteral("https://example.invalid/12c2b2d/" + eventId + "/source")},'other','en',${jsonLiteral(sourceMeta)});`,
      `insert into public.events(id,event_key,canonical_title,event_status,review_status,classification_payload) values (${sqlLiteral(eventId)},${sqlLiteral(eventKey)},${sqlLiteral("Synthetic event " + fixture.name)},'active','approved',${jsonLiteral(eventMeta)});`,
      `insert into public.raw_items(id,source_id,original_url,canonical_url,external_id,title,excerpt,raw_content,content_type,language,content_hash,processing_status,extraction_quality,extracted_at,normalized_payload) values (${sqlLiteral(rawItemId)},${sqlLiteral(sourceId)},${sqlLiteral("https://example.invalid/12c2b2d/" + eventId + "/raw")},${sqlLiteral("https://example.invalid/12c2b2d/" + eventId + "/raw")},${sqlLiteral(namespace + ":" + fixture.name)},${sqlLiteral("Synthetic source " + fixture.name)},'Synthetic fixture only',${sqlLiteral(text)},'article','en',${sqlLiteral(contentHash)},'extracted','full',now(),${jsonLiteral(rawMeta)});`,
      `insert into public.event_sources(event_id,raw_item_id,source_id,is_primary) values (${sqlLiteral(eventId)},${sqlLiteral(rawItemId)},${sqlLiteral(sourceId)},true);`,
      `insert into public.articles(id,event_id,slug,headline_es,summary_es,publication_status,metadata) values (${sqlLiteral(articleId)},${sqlLiteral(eventId)},${sqlLiteral(slug)},${sqlLiteral("Artículo sintético " + fixture.name)},'Fixture de validación sintético.',${sqlLiteral(fixture.articleStatus)},${jsonLiteral(articleMeta)});`,
      `insert into public.pipeline_event_attempts(id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,purpose,start_stage,remediation_article_id,remediation_raw_item_id,remediation_prior_attempt_id,remediation_reason,authorized_by,authorization_reference,pilot_attempt_number,validation_namespace) values (${sqlLiteral(priorAttemptId)},${sqlLiteral(eventKey)},${sqlLiteral(priorRunId)},1,now()-interval '30 seconds',now()-interval '20 seconds','READY_FOR_PUBLICATION','synthetic_fixture',${sqlLiteral(marker)},'NONE',false,'NORMAL',null,null,null,null,null,null,null,null,null);`,
      `insert into public.pipeline_event_attempts(id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,purpose,start_stage,remediation_article_id,remediation_raw_item_id,remediation_prior_attempt_id,remediation_reason,authorized_by,authorization_reference,pilot_attempt_number,validation_namespace) values (${sqlLiteral(attemptId)},${sqlLiteral(eventKey)},${sqlLiteral(remediationRunId)},2,now()-interval '15 seconds',${fixture.state === "ACTIVE" ? "null" : "now()-interval '5 seconds'"},${fixture.state === "ACTIVE" ? "null" : sqlLiteral(fixture.state)},${fixture.state === "ACTIVE" ? "null" : "'critic'"},${sqlLiteral(fixture.stopReason)},${sqlLiteral(fixture.state === "PROVIDER_RATE_LIMIT" ? "PROVIDER_RATE_LIMIT" : "NONE")},false,${sqlLiteral(fixture.attemptPurpose)},${fixture.attemptPurpose === "NORMAL" ? "null" : "'VERIFIER'"},${fixture.attemptPurpose === "NORMAL" ? "null" : sqlLiteral(articleId)},${fixture.attemptPurpose === "NORMAL" ? "null" : sqlLiteral(rawItemId)},${fixture.attemptPurpose === "NORMAL" ? "null" : sqlLiteral(priorAttemptId)},${fixture.attemptPurpose === "NORMAL" ? "null" : sqlLiteral("Synthetic lifecycle validation reason for " + fixture.name + ".")},${fixture.attemptPurpose === "NORMAL" ? "null" : "'Codex synthetic validation'"},${fixture.attemptPurpose === "NORMAL" ? "null" : sqlLiteral(namespace + ":approval")},null,${fixture.attemptPurpose === "NORMAL" ? "null" : sqlLiteral(namespace)});`,
      `insert into public.agent_runs(id,run_type,started_at,finished_at,status,dry_run,stats,config,provider,created_at) values (${sqlLiteral(criticRunId)},'other',now()-interval '12 seconds',now()-interval '8 seconds','failed',false,${jsonLiteral({ telemetry: { status: "RUNTIME_ERROR", providerRequestDispatched: fixture.criticDispatched, providerRequestsUsed: fixture.criticDispatched ? 1 : 0 } })},${jsonLiteral({ agentName: "critic", agentVersion: "critic-v3", eventKey, model: "openai/gpt-oss-20b", provider: "groq", pipelineRunId: remediationRunId, attemptId, validationNamespace: namespace })},'groq',now()-interval '13 seconds');`,
      `insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,created_at) values (${sqlLiteral(criticRunId)},'critic','groq_tpm_pacing_decision','error','Synthetic canonical pre-dispatch TPM refusal',${jsonLiteral({ eventKey, runId: criticRunId, agentVersion: "critic-v3", model: "openai/gpt-oss-20b", provider: "groq", details: { reason: "GROQ_TPM_STAGE_EXCEEDS_TPM", estimatedStageTokenRequirement: 9005, tokenLimitTpm: 8000, stage: "critic" } })},'groq',now()-interval '11 seconds');`,
    );
    if (fixture.criticDispatched) statements.push(
      `insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,created_at) values (${sqlLiteral(criticRunId)},'critic','provider_request_reserved','info','Synthetic dispatch-marker fixture; no provider request was sent',${jsonLiteral({ providerRequestDispatched: true, syntheticValidationNamespace: namespace })},'groq',now()-interval '10 seconds');`,
    );
    if (fixture.criticRunExists) statements.push(
      `insert into public.agent_runs(id,run_type,started_at,finished_at,status,dry_run,stats,config,provider,created_at) values (${sqlLiteral(randomUUID())},'other',now()-interval '7 seconds',now()-interval '6 seconds','succeeded',true,'{}'::jsonb,${jsonLiteral({ agentName: "critic", agentVersion: "critic-v4", eventKey, model: "openai/gpt-oss-20b", pipelineRunId: remediationRunId, attemptId, validationNamespace: namespace })},'groq',now()-interval '8 seconds');`,
    );
  }
  statements.push("commit;");
  return statements.join("\n");
}

function cleanupSql() {
  const eventKeys = Object.values(fixtures).map((fixture) => sqlLiteral(fixture.eventKey)).join(",");
  const eventIds = Object.values(fixtures).map((fixture) => sqlLiteral(fixture.eventId)).join(",");
  const articleIds = Object.values(fixtures).map((fixture) => sqlLiteral(fixture.articleId)).join(",");
  const rawIds = Object.values(fixtures).map((fixture) => sqlLiteral(fixture.rawItemId)).join(",");
  const sourceIds = Object.values(fixtures).map((fixture) => sqlLiteral(fixture.sourceId)).join(",");
  const n = sqlLiteral(namespace);
  return [
    "begin;",
    `delete from public.agent_logs where run_id in (select id from public.agent_runs where config ->> 'validationNamespace' = ${n});`,
    `delete from public.agent_runs where config ->> 'validationNamespace' = ${n};`,
    `delete from public.pipeline_event_attempts where event_key in (${eventKeys});`,
    `delete from public.articles where id in (${articleIds}) and event_id in (${eventIds});`,
    `delete from public.event_sources where event_id in (${eventIds}) and raw_item_id in (${rawIds});`,
    `delete from public.events where id in (${eventIds}) and event_key in (${eventKeys}) and classification_payload ->> 'validationNamespace' in (${sqlLiteral(namespace)},${sqlLiteral(Object.values(fixtures).find((item) => item.lineageNamespace !== namespace)?.lineageNamespace || namespace)});`,
    `delete from public.raw_items where id in (${rawIds}) and source_id in (${sourceIds});`,
    `delete from public.sources where id in (${sourceIds}) and metadata ->> 'validationNamespace' in (${sqlLiteral(namespace)},${sqlLiteral(Object.values(fixtures).find((item) => item.lineageNamespace !== namespace)?.lineageNamespace || namespace)});`,
    "commit;",
  ].join("\n");
}

function residualSql() {
  const eventKeys = Object.values(fixtures).map((fixture) => sqlLiteral(fixture.eventKey)).join(",");
  const eventIds = Object.values(fixtures).map((fixture) => sqlLiteral(fixture.eventId)).join(",");
  const ids = Object.values(fixtures).flatMap((fixture) => [fixture.articleId, fixture.rawItemId, fixture.sourceId, fixture.priorAttemptId, fixture.attemptId, fixture.criticRunId]);
  const idSql = ids.map(sqlLiteral).join(",");
  return `select jsonb_build_object(
    'attempts',(select count(*) from public.pipeline_event_attempts where event_key in (${eventKeys})),
    'events',(select count(*) from public.events where id in (${eventIds})),
    'articles',(select count(*) from public.articles where id in (${idSql})),
    'rawItems',(select count(*) from public.raw_items where id in (${idSql})),
    'sources',(select count(*) from public.sources where id in (${idSql})),
    'eventSources',(select count(*) from public.event_sources where event_id in (${eventIds})),
    'agentRuns',(select count(*) from public.agent_runs where config ->> 'validationNamespace' = ${sqlLiteral(namespace)}),
    'agentLogs',(select count(*) from public.agent_logs l join public.agent_runs ar on ar.id=l.run_id where ar.config ->> 'validationNamespace' = ${sqlLiteral(namespace)})
  ) as residual;`;
}

function manifestFor(fixture, overrides = {}) {
  return {
    schemaVersion: "1",
    eventKey: fixture.eventKey,
    sourceRunId: fixture.remediationRunId,
    resumeStage: "critic",
    criticCheckpoint: "absent",
    checkpoints: Object.fromEntries(["verifier", "translator", "editor", "classifier", "ranker"].map((stage) => [stage, sha256(namespace + fixture.eventKey + stage)])),
    ...overrides,
  };
}

function rpcArgs(fixture, overrides = {}) {
  return {
    p_attempt_id: fixture.attemptId,
    p_pipeline_run_id: randomUUID(),
    p_authorized_by: "Codex synthetic validation",
    p_authorization_reference: namespace + ":approval",
    p_reason: "Validate the synthetic Critic continuation lifecycle only.",
    p_checkpoint_manifest: manifestFor(fixture),
    ...overrides,
  };
}

async function readAttempt(id) {
  const url = new URL(supabaseUrl + "/rest/v1/pipeline_event_attempts");
  url.searchParams.set("select", "*");
  url.searchParams.set("id", "eq." + id);
  const response = await rest(url.pathname + url.search);
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  return response.body[0];
}

async function roleDenied(fixture) {
  const manifest = JSON.stringify(manifestFor(fixture)).replaceAll("'", "''");
  const sql = `begin; set local role authenticated; do $$ declare denied boolean := false; begin begin execute ${sqlLiteral(
    `select public.authorize_incident_factual_remediation_continuation('${fixture.attemptId}'::uuid,'${randomUUID()}'::uuid,'Codex synthetic validation','${namespace}:approval','Validate the synthetic Critic continuation lifecycle only.','${manifest}'::jsonb)`
  )}; exception when insufficient_privilege then denied := true; end; if not denied then raise exception 'AUTHENTICATED_RPC_WAS_NOT_DENIED'; end if; end $$; reset role; commit;`;
  runDbQuery(sql, "authenticated-denial");
}

const realBaselineArticle = "756b0ee0-b5e6-4153-846f-278a12c9afe3";
let setupAttempted = false;
let originalSnapshot;
let publicBefore;
let liveBefore;
let mainError;
let report;
let cleanupResidual;

try {
  originalSnapshot = await snapshot();
  liveBefore = await freshRealRead();
  assert.equal(originalSnapshot.article?.id, realBaselineArticle);
  assert.equal(originalSnapshot.article?.publication_status, "archived");
  assert.equal(originalSnapshot.attempts?.count, 2);
  assert.equal(originalSnapshot.attempts?.rows?.find((row) => row.id === "a82482be-58d8-4fc6-ac16-946d0906257b")?.final_state, "TECHNICAL_FAILURE");
  assert.equal(originalSnapshot.detail.realAttempt?.continuation, null);
  assert.equal(originalSnapshot.public?.count, 2);
  assert.equal(originalSnapshot.public?.incident_visible, false);
  assert.equal(originalSnapshot.detail.newTables, 0);
  assert.equal(originalSnapshot.detail.continuationColumn, true, "migration 28 is present before fixture validation");
  assert.equal(originalSnapshot.detail.functions?.length, 3);
  publicBefore = await publicRows();
  assert.equal(publicBefore.length, 2);
  setupAttempted = true;
  runDbQuery(fixtureSetupSql(), "fixture-setup");

  const fixtureSnapshot = await snapshot();
  const fixtureCapacity = assertSnapshotExceptCapacity(fixtureSnapshot, originalSnapshot, "synthetic fixtures preserve all non-capacity real state");
  assert.equal(Number(fixtureCapacity.actualCapacity.groq_requests), Number(fixtureCapacity.expectedCapacity.groq_requests) + 1, "only the explicit synthetic dispatch-marker fixture adds one temporary ledger reservation");
  assert.equal(Number(fixtureCapacity.actualCapacity.cloudflare_requests), Number(fixtureCapacity.expectedCapacity.cloudflare_requests), "fixtures add no Cloudflare reservation");
  assert.equal(Number(fixtureCapacity.actualCapacity.groq_tokens), Number(fixtureCapacity.expectedCapacity.groq_tokens), "fixtures add no Groq token accounting");
  const valid = fixtures.valid;
  const validArgs = rpcArgs(valid);
  const anon = await rpc(validArgs, anonKey);
  assert.ok([401, 403].includes(anon.status), "anon REST invocation is denied");
  await roleDenied(valid);

  const invalidCases = {};
  async function expectRejected(name, fixture, overrides = {}) {
    const result = await rpc(rpcArgs(fixture, overrides));
    assert.equal(result.status, 200, `${name} produces structured denial: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.status, "BLOCKED", `${name} is rejected`);
    invalidCases[name] = result.body.reason;
  }
  await expectRejected("criticDispatchMarker", fixtures["dispatch-marker"]);
  await expectRejected("criticCheckpointManifestPresent", fixtures["critic-run-exists"], { p_checkpoint_manifest: manifestFor(fixtures["critic-run-exists"], { criticCheckpoint: "present" }) });
  await expectRejected("criticCheckpointRunExists", fixtures["critic-run-exists"]);
  await expectRejected("articleNotArchived", fixtures["not-archived"]);
  await expectRejected("wrongLineageNamespace", fixtures["wrong-lineage-namespace"]);
  await expectRejected("missingVerifierCheckpoint", fixtures["missing-verifier"], { p_checkpoint_manifest: (() => { const m = manifestFor(fixtures["missing-verifier"]); delete m.checkpoints.verifier; return m; })() });
  await expectRejected("wrongEventKey", fixtures["wrong-event-key"], { p_checkpoint_manifest: manifestFor(fixtures["wrong-event-key"], { eventKey: "event-wrong-lineage" }) });
  await expectRejected("wrongSourceRunId", fixtures["wrong-source-run"], { p_checkpoint_manifest: manifestFor(fixtures["wrong-source-run"], { sourceRunId: randomUUID() }) });
  await expectRejected("wrongCheckpointHash", fixtures["wrong-checkpoint-hash"], { p_checkpoint_manifest: manifestFor(fixtures["wrong-checkpoint-hash"], { checkpoints: { ...manifestFor(fixtures["wrong-checkpoint-hash"]).checkpoints, ranker: "not-a-sha256" } }) });
  for (const stage of ["verifier", "translator", "editor", "classifier", "ranker", "publisher"]) {
    const fixture = fixtures["stage-" + stage];
    await expectRejected("wrongStage:" + stage, fixture, { p_checkpoint_manifest: manifestFor(fixture, { resumeStage: stage }) });
  }
  await expectRejected("activeAttempt", fixtures["active-attempt"]);
  await expectRejected("readyAttempt", fixtures["ready-attempt"]);
  await expectRejected("otherTerminalState", fixtures["other-terminal"]);
  await expectRejected("unsupportedTechnicalFailure", fixtures["unsupported-technical-failure"]);
  await expectRejected("wrongPurpose", fixtures["wrong-purpose"]);
  const missingAuth = await rpc(rpcArgs(valid, { p_authorized_by: "" }));
  assert.equal(missingAuth.status, 400);
  assert.equal(missingAuth.body.code, "22023");
  invalidCases.missingHumanAuthorization = missingAuth.body.code;

  const before = await readAttempt(valid.attemptId);
  const admitted = await rpc(validArgs);
  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.status, "AUTHORIZED");
  assert.equal(admitted.body.attemptId, valid.attemptId);
  assert.equal(admitted.body.pipelineRunId, validArgs.p_pipeline_run_id);
  assert.equal(admitted.body.resumeStage, "critic");
  const after = await readAttempt(valid.attemptId);
  assert.equal(after.id, before.id);
  assert.equal(after.final_state, before.final_state);
  assert.equal(after.completed_at, before.completed_at);
  assert.equal(after.stop_stage, before.stop_stage);
  assert.equal(after.stop_reason, before.stop_reason);
  assert.equal(after.pipeline_run_id, before.pipeline_run_id);
  assert.equal(after.continuation.pipelineRunId, validArgs.p_pipeline_run_id);
  assert.equal(after.continuation.resumeStage, "critic");
  assert.equal(after.continuation.syntheticFixture, true);
  assert.equal(after.continuation.validationNamespace, namespace);
  assert.equal(after.continuation.checkpointManifest.criticCheckpoint, "absent");
  const validCount = queryOne(`select jsonb_build_object('rows',(select count(*) from public.pipeline_event_attempts where event_key=${sqlLiteral(valid.eventKey)}),'pilotOrdinal',(select max(pilot_attempt_number) from public.pipeline_event_attempts where event_key=${sqlLiteral(valid.eventKey)}),'continuationRunExists',(select count(*) from public.agent_runs where id=${sqlLiteral(validArgs.p_pipeline_run_id)}::uuid)) as value;`, "valid-count").value;
  assert.equal(validCount.rows, 2, "authorization reuses the exact existing attempt");
  assert.equal(validCount.pilotOrdinal, null, "synthetic fixture adds no pilot ordinal or attempt six");
  assert.equal(validCount.continuationRunExists, 0, "authorization alone creates no execution run");
  const repeat = await rpc(rpcArgs(valid));
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.status, "BLOCKED");
  invalidCases.duplicateAuthorization = repeat.body.reason;

  const concurrency = await Promise.all([rpc(rpcArgs(fixtures.concurrency)), rpc(rpcArgs(fixtures.concurrency))]);
  assert.ok(concurrency.every((item) => item.status === 200));
  const concurrencyAdmitted = concurrency.filter((item) => item.body.status === "AUTHORIZED");
  const concurrencyRejected = concurrency.filter((item) => item.body.status === "BLOCKED");
  assert.equal(concurrency.length, 2);
  assert.equal(concurrencyAdmitted.length, 1);
  assert.equal(concurrencyRejected.length, 1);

  const afterAuthSnapshot = await snapshot();
  assert.deepEqual(afterAuthSnapshot, fixtureSnapshot, "authorization adds no provider reservations or modifies real baseline");
  assert.deepEqual(await publicRows(), publicBefore, "the public contract is unchanged");
  report = {
    status: "PASS",
    projectRef,
    namespace,
    fixtureCount: testNames.length,
    fixtureIdsCheckedAgainstRealIds: true,
    validContinuation: { status: admitted.body.status, sameAttempt: after.id === before.id, resumeStage: after.continuation.resumeStage, newExecutionId: after.continuation.pipelineRunId, historicalFailurePreserved: after.final_state === "TECHNICAL_FAILURE" && after.completed_at === before.completed_at, attemptRows: validCount.rows, pilotAttemptNumber: 5, syntheticPilotOrdinal: validCount.pilotOrdinal },
    invalidCases,
    dispatchProof: { allowedWhenCanonicalRunShowsZeroRequests: true, rejectedWhenSyntheticDispatchMarkerExists: true, pacingLogBoundToEventAndRun: true },
    oneTimeContinuation: { first: "AUTHORIZED", second: "BLOCKED" },
    concurrency: { requests: concurrency.length, admitted: concurrencyAdmitted.length, rejected: concurrencyRejected.length, rejectionReason: concurrencyRejected[0].body.reason },
    security: { serviceRole: "ALLOWED", anon: "DENIED", authenticated: "DENIED", executeAcl: queryOne("select jsonb_build_object('anon',has_function_privilege('anon','public.authorize_incident_factual_remediation_continuation(uuid,uuid,text,text,text,jsonb)','execute'),'authenticated',has_function_privilege('authenticated','public.authorize_incident_factual_remediation_continuation(uuid,uuid,text,text,text,jsonb)','execute')) as value;", "acl").value },
    historicalFailurePreserved: true,
    attemptCountInvariant: { rowsBefore: 2, rowsAfter: validCount.rows, createdByAuthorization: 0, syntheticPilotOrdinal: null },
    checkpointPolicy: { reused: ["verifier", "translator", "editor", "classifier", "ranker"], resumeStage: "critic", criticMustBeAbsent: true, wrongStageConfiguredByCaller: "rejected" },
    capacityDelta: { groqRequests: 0, groqTokens: 0, cloudflare: 0, authorizationAddsReservation: false, syntheticDispatchMarkerFixtureRemovedAtCleanup: true },
    realBaselineDuringValidation: afterAuthSnapshot,
    publicRowsBefore: publicBefore,
    publicRowsDuring: await publicRows(),
  };
} catch (error) {
  mainError = error;
} finally {
  if (setupAttempted) {
    try {
      runDbQuery(cleanupSql(), "fixture-cleanup");
      cleanupResidual = queryOne(residualSql(), "fixture-residual").residual;
      assert.deepEqual(cleanupResidual, { attempts: 0, events: 0, articles: 0, rawItems: 0, sources: 0, eventSources: 0, agentRuns: 0, agentLogs: 0 });
    } catch (error) {
      mainError = mainError ? new Error(`${mainError.message}; SYNTHETIC_CLEANUP_FAILED:${error.message}`) : error;
    }
  }
  for (const path of scratchFiles) { try { unlinkSync(path); } catch {} }
}

if (mainError) throw mainError;
const afterCleanup = await snapshot();
const liveAfter = await freshRealRead();
assert.deepEqual(afterCleanup, originalSnapshot, "only persistent schema changes remain after exact synthetic cleanup");
assert.deepEqual(liveAfter, liveBefore, "fresh authorized REST reads prove the real incident is unchanged");
assert.deepEqual(await publicRows(), publicBefore, "public article set is restored");
report.cleanup = { residualRows: cleanupResidual, baselineRestored: true };
report.realAttemptStateAfter = liveAfter.pipeline_event_attempts;
report.realArticleStateAfter = liveAfter.articles;
report.liveStateReadMethod = "Supabase CLI linked PostgreSQL read plus service-role REST for incident rows and anon REST for public rows";
report.publicCountAfter = afterCleanup.public.count;
report.finalBaseline = afterCleanup;
console.log(JSON.stringify(report, null, 2));
