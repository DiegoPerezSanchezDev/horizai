import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createContinuationCheckpointManifestSchema, canonicalJsonString } from "../lib/agents/pipeline/factual-remediation-continuation.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseAgentLogger } from "../lib/agents/runtime/agent-logger.ts";

const projectRef = "skrthgpurquypgdwxast";
const namespace = `12c2b2f1a:${randomUUID()}`;
const scratchDir = resolve("supabase/.temp");
const scratchFiles = new Set();
const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SECRET_KEY || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const realIds = new Set([
  "756b0ee0-b5e6-4153-846f-278a12c9afe3", "5138e509-f4c3-4020-9d13-6a6efac99a39",
  "a82482be-58d8-4fc6-ac16-946d0906257b", "db368f10-d9c1-4897-b752-b3d2cb156e09",
  "f140d01b-b7f1-4f05-b8f7-9ad0081e7105", "4017edf4-86be-49f1-a464-e766ad371284",
  "d3834944-72f6-4f59-9aca-3f66ae92dc33", "e8dd0363-f51e-4381-9fb2-c02ee81f4d41",
]);
const testNames = [
  "valid", "concurrency", "wrong-stop-reason", "wrong-authorization",
  "dispatch-marker", "reservation-marker", "critic-checkpoint", "not-archived",
  "active-attempt", "ready-attempt", "other-terminal", "wrong-purpose",
];

if (!process.argv.includes("--execute-synthetic-validation")) throw new Error("SYNTHETIC_RESUME_VALIDATION_REQUIRES_EXPLICIT_FLAG");
if (!supabaseUrl || !serviceKey || !anonKey) throw new Error("SUPABASE_VALIDATION_CONFIGURATION_MISSING");
if (new URL(supabaseUrl).hostname.split(".")[0] !== projectRef) throw new Error("SUPABASE_URL_PROJECT_REF_MISMATCH");

const sqlLiteral = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const jsonLiteral = (value) => sqlLiteral(JSON.stringify(value)) + "::jsonb";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const md5 = (value) => createHash("md5").update(value).digest("hex");
const schemaVersion = "20261002211000";
const migration30PriorState = process.env.HORIZAI_MIGRATION30_PRIOR_STATE || "UNKNOWN";
const migration30AppliedThisSession = process.env.HORIZAI_MIGRATION30_APPLIED_THIS_SESSION === "true";
const resumeFunctionName = "resume_incident_factual_remediation_continuation";
const resumeSignature = "public.resume_incident_factual_remediation_continuation(uuid,uuid,uuid,jsonb)";
const supabase = createSupabaseServerClient();
const logger = new SupabaseAgentLogger(supabase);
const dateUtc = new Date().toISOString().slice(0, 10);

function cleanupScratchFiles() {
  for (const path of scratchFiles) { try { unlinkSync(path); } catch {} }
}

function dbQuery(sql, label) {
  mkdirSync(scratchDir, { recursive: true });
  const path = resolve(scratchDir, `12c2b2f1a-${randomUUID()}-${label}.sql`);
  scratchFiles.add(path);
  writeFileSync(path, sql.trim() + "\n", "utf8");
  const cli = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(cli, ["--yes", "supabase", "db", "query", "--linked", "--output-format", "json", "--file", path], {
    cwd: process.cwd(), encoding: "utf8", shell: process.platform === "win32", windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    const diagnostic = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean).join("\n").trim().slice(0, 1800);
    throw new Error(`REMOTE_SQL_${label}_FAILED:${diagnostic || result.status}`);
  }
  const output = result.stdout || "";
  const start = output.indexOf("{");
  if (start < 0) throw new Error(`REMOTE_SQL_${label}_RESULT_MISSING`);
  try { return JSON.parse(output.slice(start)); } catch { throw new Error(`REMOTE_SQL_${label}_RESULT_INVALID`); }
}

function queryOne(sql, label) {
  const result = dbQuery(sql, label);
  assert.equal(result.rows?.length, 1, `${label} returns one row`);
  return result.rows[0];
}

async function rest(path, key = serviceKey, method = "GET", body = undefined) {
  const response = await fetch(supabaseUrl + path, {
    method, cache: "no-store",
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let parsed;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { message: raw.slice(0, 200) }; }
  return { status: response.status, body: parsed };
}

async function rpc(args, key = serviceKey) {
  return rest(`/rest/v1/rpc/${resumeFunctionName}`, key, "POST", args);
}

async function capacitySnapshot() {
  const [groq, cloudflare, cerebras] = await Promise.all([
    logger.getProviderDailyUsage("groq", dateUtc),
    logger.getProviderDailyUsage("cloudflare_workers_ai", dateUtc),
    logger.getProviderDailyUsage("cerebras", dateUtc),
  ]);
  return {
    dateUtc,
    groq: {
      requestsReserved: groq.requestsReserved,
      requestsDispatched: groq.requestsDispatched,
      totalTokens: groq.totalTokens,
      unknownTokenRequests: groq.unknownTokenRequests,
      tokenUsageKnown: groq.tokenUsageKnown,
    },
    cloudflare: {
      requestsReserved: cloudflare.requestsReserved,
      requestsDispatched: cloudflare.requestsDispatched,
      neuronsUsed: cloudflare.neuronsUsed,
      unknownRequests: cloudflare.unknownTokenRequests,
      neuronUsageKnown: cloudflare.neuronUsageKnown,
    },
    cerebras: {
      requestsReserved: cerebras.requestsReserved,
      requestsDispatched: cerebras.requestsDispatched,
      totalTokens: cerebras.totalTokens,
      unknownTokenRequests: cerebras.unknownTokenRequests,
      tokenUsageKnown: cerebras.tokenUsageKnown,
    },
  };
}

async function publicRows() {
  const url = new URL(`${supabaseUrl}/rest/v1/public_published_articles`);
  url.searchParams.set("select", "slug");
  url.searchParams.set("order", "slug.asc");
  const response = await rest(url.pathname + url.search, anonKey);
  assert.equal(response.status, 200, "public contract is readable with the anon key");
  return response.body;
}

async function realSnapshot() {
  const value = queryOne(`
select jsonb_build_object(
  'migration27',exists(select 1 from supabase_migrations.schema_migrations where version='20260930211903'),
  'migration28',exists(select 1 from supabase_migrations.schema_migrations where version='20261002105220'),
  'migration29',exists(select 1 from supabase_migrations.schema_migrations where version='20261002150747'),
  'migration30',exists(select 1 from supabase_migrations.schema_migrations where version='20261002211000'),
  'migration31',exists(select 1 from supabase_migrations.schema_migrations where version>'20261002211000'),
  'realAttempts',(select jsonb_agg(jsonb_build_object('id',id,'pipelineRunId',pipeline_run_id,'attemptNumber',attempt_number,'purpose',purpose,'pilotAttemptNumber',pilot_attempt_number,'finalState',final_state,'completedAt',completed_at,'stopStage',stop_stage,'stopReason',stop_reason,'continuation',continuation) order by attempt_number) from public.pipeline_event_attempts where event_key='event-30f226d1b8ba5c9eb8af2b65c46db512'),
  'article',(select jsonb_build_object('id',id,'eventId',event_id,'slug',slug,'publicationStatus',publication_status) from public.articles where id='756b0ee0-b5e6-4153-846f-278a12c9afe3'),
  'event',(select jsonb_build_object('id',id,'eventKey',event_key,'eventStatus',event_status,'reviewStatus',review_status) from public.events where id='5138e509-f4c3-4020-9d13-6a6efac99a39'),
  'publicCount',(select count(*) from public.public_published_articles),
  'incidentPublicCount',(select count(*) from public.public_published_articles where slug='openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad'),
  'newTables',(select count(*) from information_schema.tables where table_schema='public' and table_name like '%continuation%'),
  'resumeObjects',(select jsonb_agg(jsonb_build_object('name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'owner',r.rolname,'securityDefiner',p.prosecdef,'config',p.proconfig,'acl',p.proacl) order by p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='public' and p.proname='resume_incident_factual_remediation_continuation'),
  'resumeSecurity',(select jsonb_build_object('serviceRoleExecute',has_function_privilege('service_role',p.oid,'execute'),'anonExecute',has_function_privilege('anon',p.oid,'execute'),'authenticatedExecute',has_function_privilege('authenticated',p.oid,'execute'),'publicExecute',coalesce((select bool_or(x.grantee=0 and x.privilege_type='EXECUTE') from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x),false)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='resume_incident_factual_remediation_continuation'),
  'resumeConstraint',(select pg_get_constraintdef(oid) from pg_constraint where conrelid='public.pipeline_event_attempts'::regclass and conname='pipeline_event_attempts_remediation_metadata_check'),
  'normalRoutineHashes',(select jsonb_agg(jsonb_build_object('name',p.proname,'identity',pg_get_function_identity_arguments(p.oid),'md5',md5(pg_get_functiondef(p.oid))) order by p.proname,pg_get_function_identity_arguments(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('claim_pipeline_event_attempt','claim_factual_remediation_attempt','claim_incident_factual_remediation_attempt','publish_factual_remediation_article_atomic'))
) as snapshot;`, "real-snapshot").snapshot;
  return { ...value, publicRows: await publicRows(), capacity: await capacitySnapshot() };
}

function makeFixture(name) {
  const eventId = randomUUID();
  const articleId = randomUUID();
  const rawItemId = randomUUID();
  const sourceId = randomUUID();
  const priorAttemptId = randomUUID();
  const priorRunId = randomUUID();
  const attemptId = randomUUID();
  const originalRunId = randomUUID();
  const continuationRunId = randomUUID();
  const eventKey = `event-${md5(`${namespace}:${name}:${eventId}`)}`;
  const purpose = name === "wrong-purpose" ? "NORMAL" : "FACTUAL_REMEDIATION";
  const attemptState = name === "active-attempt" ? "ACTIVE"
    : name === "ready-attempt" ? "READY_FOR_PUBLICATION"
      : name === "other-terminal" ? "PROVIDER_RATE_LIMIT" : "TECHNICAL_FAILURE";
  const lineageNamespace = purpose === "NORMAL" ? null : namespace;
  const checkpointHashes = Object.fromEntries(["verifier", "translator", "editor", "classifier", "ranker"]
    .map((stage) => [stage, sha256(`${namespace}:${eventKey}:${stage}`)]));
  const manifest = {
    schemaVersion: 1,
    eventKey,
    sourceRunId: originalRunId,
    resumeStage: "critic",
    criticCheckpoint: "absent",
    checkpoints: checkpointHashes,
  };
  const continuation = {
    kind: "FACTUAL_REMEDIATION_CONTINUATION",
    attemptId,
    pipelineRunId: continuationRunId,
    resumeStage: "critic",
    criticAgentVersion: "critic-v4",
    authorizedBy: name === "wrong-authorization" ? "Different synthetic person" : "Codex synthetic validation",
    authorizationReference: `${namespace}:${name}:authorization-once`,
    reason: "Synthetic validation of the previously authorized Critic-only continuation.",
    authorizedAt: "2026-10-03T12:00:00.000Z",
    completedAt: "2026-10-03T12:00:01.000Z",
    status: "STOPPED",
    pilotAttemptNumber: null,
    syntheticFixture: true,
    validationNamespace: namespace,
    checkpointManifest: manifest,
    criticDecision: null,
    stopStage: "critic",
    stopReason: name === "wrong-stop-reason" ? "OTHER_RUNNER_FAILURE" : "CONTINUATION_RUNNER_ABORTED",
    providerRequestsUsed: 0,
    failureCode: "FACTUAL_REMEDIATION_CONTINUATION_CHECKPOINT_MANIFEST_CHANGED",
  };
  const fixture = {
    name, eventId, articleId, rawItemId, sourceId, priorAttemptId, priorRunId,
    attemptId, originalRunId, continuationRunId, eventKey, slug: `synthetic-12c2b2f1a-${name}-${eventId.slice(0, 8)}`,
    purpose, attemptState, articleStatus: name === "not-archived" ? "draft" : "archived",
    lineageNamespace, checkpointHashes, manifest, continuation,
    runId: randomUUID(),
  };
  for (const id of [eventId, articleId, rawItemId, sourceId, priorAttemptId, priorRunId, attemptId, originalRunId, continuationRunId, fixture.runId]) {
    assert.equal(realIds.has(id), false, "synthetic fixture does not use a real incident UUID");
  }
  return fixture;
}

const fixtures = Object.fromEntries(testNames.map((name) => [name, makeFixture(name)]));

function fixtureSetupSql() {
  const statements = ["begin;"];
  for (const f of Object.values(fixtures)) {
    const content = `Synthetic test source ${namespace} ${f.name}; no provider content.`;
    const contentHash = `sha256:${sha256(content)}`;
    const tagged = { validationNamespace: namespace, fixture: f.name };
    const isActive = f.attemptState === "ACTIVE";
    const isOtherTerminal = f.attemptState === "PROVIDER_RATE_LIMIT";
    const attemptFinalState = isActive ? "null" : sqlLiteral(f.attemptState);
    const attemptCompletedAt = isActive ? "null" : "now()-interval '5 seconds'";
    const attemptStopStage = isActive ? "null" : sqlLiteral("critic");
    const attemptStopReason = isActive ? "null" : sqlLiteral("cost_guard_violation");
    const serializedContinuation = jsonLiteral(f.continuation);
    statements.push(
      `insert into public.sources(id,name,url,source_type,language,metadata) values (${sqlLiteral(f.sourceId)},${sqlLiteral(`12C.2B.2f.1 synthetic source ${f.name}`)},${sqlLiteral(`https://example.invalid/${f.eventId}/source`)},'other','en',${jsonLiteral(tagged)});`,
      `insert into public.events(id,event_key,canonical_title,event_status,review_status,classification_payload) values (${sqlLiteral(f.eventId)},${sqlLiteral(f.eventKey)},${sqlLiteral(`Synthetic continuation ${f.name}`)},'active','approved',${jsonLiteral(tagged)});`,
      `insert into public.raw_items(id,source_id,original_url,canonical_url,external_id,title,excerpt,raw_content,content_type,language,content_hash,processing_status,extraction_quality,extracted_at,normalized_payload) values (${sqlLiteral(f.rawItemId)},${sqlLiteral(f.sourceId)},${sqlLiteral(`https://example.invalid/${f.eventId}/raw`)},${sqlLiteral(`https://example.invalid/${f.eventId}/raw`)},${sqlLiteral(`${namespace}:${f.name}`)},${sqlLiteral(`Synthetic raw item ${f.name}`)},'Synthetic data only',${sqlLiteral(content)},'article','en',${sqlLiteral(contentHash)},'extracted','full',now(),${jsonLiteral(tagged)});`,
      `insert into public.event_sources(event_id,raw_item_id,source_id,is_primary) values (${sqlLiteral(f.eventId)},${sqlLiteral(f.rawItemId)},${sqlLiteral(f.sourceId)},true);`,
      `insert into public.articles(id,event_id,slug,headline_es,summary_es,publication_status,metadata) values (${sqlLiteral(f.articleId)},${sqlLiteral(f.eventId)},${sqlLiteral(f.slug)},${sqlLiteral(`Artículo sintético ${f.name}`)},'Fixture de validación aislado.',${sqlLiteral(f.articleStatus)},${jsonLiteral(tagged)});`,
      `insert into public.pipeline_event_attempts(id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,purpose,start_stage,remediation_article_id,remediation_raw_item_id,remediation_prior_attempt_id,remediation_reason,authorized_by,authorization_reference,pilot_attempt_number,validation_namespace,continuation) values (${sqlLiteral(f.priorAttemptId)},${sqlLiteral(f.eventKey)},${sqlLiteral(f.priorRunId)},1,now()-interval '30 seconds',now()-interval '20 seconds','READY_FOR_PUBLICATION','synthetic_fixture',${sqlLiteral(`${namespace}:prior:${f.name}`)},'NONE',false,'NORMAL',null,null,null,null,null,null,null,null,null,null);`,
      `insert into public.pipeline_event_attempts(id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,retry_class,counts_toward_retry_limit,purpose,start_stage,remediation_article_id,remediation_raw_item_id,remediation_prior_attempt_id,remediation_reason,authorized_by,authorization_reference,pilot_attempt_number,validation_namespace,continuation) values (${sqlLiteral(f.attemptId)},${sqlLiteral(f.eventKey)},${sqlLiteral(f.originalRunId)},2,now()-interval '15 seconds',${attemptCompletedAt},${attemptFinalState},${attemptStopStage},${attemptStopReason},${isOtherTerminal ? "'PROVIDER_RATE_LIMIT'" : "'NONE'"},false,${sqlLiteral(f.purpose)},${f.purpose === "NORMAL" ? "null" : "'VERIFIER'"},${f.purpose === "NORMAL" ? "null" : sqlLiteral(f.articleId)},${f.purpose === "NORMAL" ? "null" : sqlLiteral(f.rawItemId)},${f.purpose === "NORMAL" ? "null" : sqlLiteral(f.priorAttemptId)},${f.purpose === "NORMAL" ? "null" : sqlLiteral("Synthetic factual remediation authorization fixture.")},${f.purpose === "NORMAL" ? "null" : sqlLiteral("Codex synthetic validation")},${f.purpose === "NORMAL" ? "null" : sqlLiteral(`${namespace}:${f.name}:authorization-once`)},null,${f.purpose === "NORMAL" ? "null" : sqlLiteral(f.lineageNamespace)},${serializedContinuation});`,
    );
    if (["dispatch-marker", "reservation-marker", "critic-checkpoint"].includes(f.name)) {
      const criticV4 = f.name === "critic-checkpoint";
      const stats = f.name === "dispatch-marker"
        ? { telemetry: { providerRequestDispatched: true, providerRequestsUsed: 1 } }
        : { telemetry: { providerRequestDispatched: false, providerRequestsUsed: 0 } };
      const config = { agentName: "critic", agentVersion: criticV4 ? "critic-v4" : "critic-v3", eventKey: f.eventKey, model: "synthetic-validation", provider: "synthetic_validation", pipelineRunId: f.originalRunId, attemptId: f.attemptId, validationNamespace: namespace };
      statements.push(
        `insert into public.agent_runs(id,run_type,started_at,finished_at,status,dry_run,stats,config,provider,created_at) values (${sqlLiteral(f.runId)},'other',now()-interval '12 seconds',now()-interval '8 seconds',${sqlLiteral(criticV4 ? "succeeded" : "failed")},false,${jsonLiteral(stats)},${jsonLiteral(config)},null,now()-interval '13 seconds');`,
      );
      if (f.name === "dispatch-marker") statements.push(
        `insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,created_at) values (${sqlLiteral(f.runId)},'critic','synthetic_dispatch_marker','info','Synthetic dispatch marker; no provider request was sent',${jsonLiteral({ providerRequestDispatched: true, validationNamespace: namespace })},null,now()-interval '10 seconds');`,
      );
      if (f.name === "reservation-marker") statements.push(
        `insert into public.agent_logs(run_id,agent_name,step,level,message,payload,provider,created_at) values (${sqlLiteral(f.runId)},'critic','provider_request_reserved','info','Synthetic reservation rejection fixture outside the active provider ledger window; no provider request was sent',${jsonLiteral({ provider: "synthetic_validation", providerRequestDispatched: false, validationNamespace: namespace, tokenUsageState: "reserved_estimate" })},null,now()-interval '2 days');`,
      );
    }
  }
  statements.push("commit;");
  return statements.join("\n");
}

function cleanupSql() {
  const eventIds = Object.values(fixtures).map((f) => sqlLiteral(f.eventId)).join(",");
  const eventKeys = Object.values(fixtures).map((f) => sqlLiteral(f.eventKey)).join(",");
  const articleIds = Object.values(fixtures).map((f) => sqlLiteral(f.articleId)).join(",");
  const rawIds = Object.values(fixtures).map((f) => sqlLiteral(f.rawItemId)).join(",");
  const sourceIds = Object.values(fixtures).map((f) => sqlLiteral(f.sourceId)).join(",");
  const n = sqlLiteral(namespace);
  return [
    "begin;",
    `delete from public.agent_logs where run_id in (select id from public.agent_runs where config ->> 'validationNamespace' = ${n});`,
    `delete from public.agent_runs where config ->> 'validationNamespace' = ${n};`,
    `delete from public.pipeline_event_attempts where event_key in (${eventKeys});`,
    `delete from public.articles where id in (${articleIds}) and event_id in (${eventIds});`,
    `delete from public.event_sources where event_id in (${eventIds}) and raw_item_id in (${rawIds});`,
    `delete from public.events where id in (${eventIds}) and event_key in (${eventKeys}) and classification_payload ->> 'validationNamespace' = ${n};`,
    `delete from public.raw_items where id in (${rawIds}) and source_id in (${sourceIds});`,
    `delete from public.sources where id in (${sourceIds}) and metadata ->> 'validationNamespace' = ${n};`,
    "commit;",
  ].join("\n");
}

function residualSql() {
  const eventIds = Object.values(fixtures).map((f) => sqlLiteral(f.eventId)).join(",");
  const eventKeys = Object.values(fixtures).map((f) => sqlLiteral(f.eventKey)).join(",");
  const articleIds = Object.values(fixtures).map((f) => sqlLiteral(f.articleId)).join(",");
  const rawIds = Object.values(fixtures).map((f) => sqlLiteral(f.rawItemId)).join(",");
  const sourceIds = Object.values(fixtures).map((f) => sqlLiteral(f.sourceId)).join(",");
  const n = sqlLiteral(namespace);
  return `select jsonb_build_object(
    'attempts',(select count(*) from public.pipeline_event_attempts where event_key in (${eventKeys})),
    'events',(select count(*) from public.events where id in (${eventIds})),
    'articles',(select count(*) from public.articles where id in (${articleIds})),
    'rawItems',(select count(*) from public.raw_items where id in (${rawIds})),
    'sources',(select count(*) from public.sources where id in (${sourceIds})),
    'eventSources',(select count(*) from public.event_sources where event_id in (${eventIds})),
    'agentRuns',(select count(*) from public.agent_runs where config ->> 'validationNamespace'=${n}),
    'agentLogs',(select count(*) from public.agent_logs l join public.agent_runs r on r.id=l.run_id where r.config ->> 'validationNamespace'=${n})
  ) as residual;`;
}

function manifestFor(fixture, overrides = {}) {
  return { ...fixture.manifest, ...overrides };
}

function argsFor(fixture, overrides = {}) {
  return {
    p_attempt_id: fixture.attemptId,
    p_pipeline_run_id: fixture.continuationRunId,
    p_resume_execution_id: randomUUID(),
    p_checkpoint_manifest: manifestFor(fixture),
    ...overrides,
  };
}

async function readAttempt(attemptId) {
  const url = new URL(`${supabaseUrl}/rest/v1/pipeline_event_attempts`);
  url.searchParams.set("select", "id,event_key,pipeline_run_id,attempt_number,purpose,pilot_attempt_number,completed_at,final_state,stop_stage,stop_reason,authorized_by,authorization_reference,continuation");
  url.searchParams.set("id", `eq.${attemptId}`);
  const result = await rest(url.pathname + url.search);
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1);
  return result.body[0];
}

function reorderedJsonbManifest(fixture) {
  const m = fixture.manifest;
  return {
    eventKey: m.eventKey,
    checkpoints: {
      ranker: m.checkpoints.ranker,
      editor: m.checkpoints.editor,
      verifier: m.checkpoints.verifier,
      translator: m.checkpoints.translator,
      classifier: m.checkpoints.classifier,
    },
    resumeStage: m.resumeStage,
    sourceRunId: m.sourceRunId,
    schemaVersion: m.schemaVersion,
    criticCheckpoint: m.criticCheckpoint,
  };
}

const setup = { attempted: false };
let baseline;
let migrationBefore;
let report;
let primaryError;
let cleanupResidual;
try {
  baseline = await realSnapshot();
  migrationBefore = migration30PriorState;
  assert.equal(migrationBefore, "NOT_APPLIED", "remote status was verified NOT_APPLIED before this phase applied the migration");
  assert.equal(migration30AppliedThisSession, true, "this phase applied migration 30 after its pre-apply audit");
  assert.deepEqual([baseline.migration27, baseline.migration28, baseline.migration29], [true, true, true]);
  assert.equal(baseline.migration30, true, "migration 30 is applied before synthetic validation begins");
  assert.equal(baseline.migration31, false, "migration 31 is absent");
  assert.equal(baseline.newTables, 0, "migration 30 creates no table");
  assert.equal(baseline.publicCount, 2);
  assert.equal(baseline.incidentPublicCount, 0);
  const realAttempts = baseline.realAttempts;
  assert.equal(realAttempts.length, 2);
  const real = realAttempts.find((a) => a.id === "a82482be-58d8-4fc6-ac16-946d0906257b");
  assert.equal(real.pilotAttemptNumber, 5);
  assert.equal(real.purpose, "FACTUAL_REMEDIATION");
  assert.equal(real.finalState, "TECHNICAL_FAILURE");
  assert.equal(real.continuation.status, "STOPPED");
  assert.equal(real.continuation.pipelineRunId, "f140d01b-b7f1-4f05-b8f7-9ad0081e7105");
  assert.equal(real.continuation.resumeGeneration, undefined);
  assert.equal(real.continuation.providerRequestsUsed, 0);

  const beforeSetupPublic = await publicRows();
  assert.deepEqual(beforeSetupPublic, baseline.publicRows);
  const migrationAudit = baseline.resumeObjects?.[0];
  assert.ok(migrationAudit, "resume RPC exists remotely");
  assert.equal(migrationAudit.identity, "p_attempt_id uuid, p_pipeline_run_id uuid, p_resume_execution_id uuid, p_checkpoint_manifest jsonb");
  assert.equal(migrationAudit.owner, "postgres");
  assert.equal(migrationAudit.securityDefiner, true);
  assert.ok(migrationAudit.config?.includes("search_path=pg_catalog, public"));
  assert.deepEqual(baseline.resumeSecurity, { serviceRoleExecute: true, anonExecute: false, authenticatedExecute: false, publicExecute: false });

  setup.attempted = true;
  dbQuery(fixtureSetupSql(), "fixture-setup");
  const afterSetupCapacity = await capacitySnapshot();
  assert.deepEqual(afterSetupCapacity, baseline.capacity, "synthetic fixture creation adds no provider accounting");
  const fixtureValid = fixtures.valid;
  const localManifest = fixtureValid.manifest;
  const remoteAttempt = await readAttempt(fixtureValid.attemptId);
  const remoteManifest = remoteAttempt.continuation.checkpointManifest;
  const schema = createContinuationCheckpointManifestSchema({ eventKey: fixtureValid.eventKey, sourceRunId: fixtureValid.originalRunId, checkpointHashes: fixtureValid.checkpointHashes });
  assert.equal(schema.safeParse(localManifest).success, true, "synthetic strict schema passes");
  assert.equal(schema.safeParse(remoteManifest).success, true, "PostgreSQL JSONB round-trip still satisfies the strict schema");
  assert.equal(JSON.stringify(localManifest) === JSON.stringify(remoteManifest), false, "PostgreSQL JSONB key order differs from local construction");
  assert.equal(canonicalJsonString(localManifest), canonicalJsonString(remoteManifest), "canonical semantic manifest equality passes");
  assert.equal(sha256(canonicalJsonString(localManifest)), sha256(canonicalJsonString(remoteManifest)), "canonical manifest hashes match");
  const rootManifest = manifestFor(fixtureValid);
  const hashChangingStages = {};
  for (const [stage, value] of Object.entries(rootManifest.checkpoints)) {
    const altered = structuredClone(rootManifest);
    altered.checkpoints[stage] = value === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
    hashChangingStages[stage] = altered;
  }
  const missingStageManifests = {};
  for (const stage of Object.keys(rootManifest.checkpoints)) {
    const altered = structuredClone(rootManifest);
    delete altered.checkpoints[stage];
    missingStageManifests[stage] = altered;
  }

  const deniedCases = {};
  async function expectBlocked(name, fixture, overrides = {}) {
    const result = await rpc(argsFor(fixture, overrides));
    assert.equal(result.status, 200, `${name} returns structured BLOCKED`);
    assert.equal(result.body.status, "BLOCKED", `${name} is rejected: ${JSON.stringify(result.body)}`);
    deniedCases[name] = result.body.reason;
  }
  await expectBlocked("changedEventIdentity", fixtureValid, { p_checkpoint_manifest: manifestFor(fixtureValid, { eventKey: "event-not-the-authorized-event" }) });
  await expectBlocked("changedRunIdentity", fixtureValid, { p_checkpoint_manifest: manifestFor(fixtureValid, { sourceRunId: randomUUID() }) });
  await expectBlocked("changedResumeStage", fixtureValid, { p_checkpoint_manifest: manifestFor(fixtureValid, { resumeStage: "translator" }) });
  await expectBlocked("changedCheckpointId", fixtureValid, { p_checkpoint_manifest: (() => { const m = structuredClone(rootManifest); delete m.checkpoints.verifier; m.checkpoints.verification = fixtureValid.checkpointHashes.verifier; return m; })() });
  await expectBlocked("changedAuthorizationField", fixtureValid, { p_checkpoint_manifest: manifestFor(fixtureValid, { authorizedBy: "other" }) });
  await expectBlocked("missingRootKey", fixtureValid, { p_checkpoint_manifest: (() => { const m = structuredClone(rootManifest); delete m.criticCheckpoint; return m; })() });
  await expectBlocked("extraRootKey", fixtureValid, { p_checkpoint_manifest: manifestFor(fixtureValid, { extra: true }) });
  await expectBlocked("extraCheckpoint", fixtureValid, { p_checkpoint_manifest: manifestFor(fixtureValid, { checkpoints: { ...rootManifest.checkpoints, publisher: "a".repeat(64) } }) });
  for (const stage of Object.keys(hashChangingStages)) await expectBlocked(`changedHash:${stage}`, fixtureValid, { p_checkpoint_manifest: hashChangingStages[stage] });
  for (const stage of Object.keys(missingStageManifests)) await expectBlocked(`missingCheckpoint:${stage}`, fixtureValid, { p_checkpoint_manifest: missingStageManifests[stage] });
  await expectBlocked("wrongAttemptIdentity", fixtureValid, { p_attempt_id: randomUUID() });
  await expectBlocked("wrongAuthorizationSnapshot", fixtures["wrong-authorization"]);
  await expectBlocked("wrongStopReason", fixtures["wrong-stop-reason"]);
  await expectBlocked("dispatchMarkerExists", fixtures["dispatch-marker"]);
  await expectBlocked("reservationExists", fixtures["reservation-marker"]);
  await expectBlocked("criticCheckpointExists", fixtures["critic-checkpoint"]);
  await expectBlocked("articleNotArchived", fixtures["not-archived"]);
  await expectBlocked("activeAttempt", fixtures["active-attempt"]);
  await expectBlocked("readyAttempt", fixtures["ready-attempt"]);
  await expectBlocked("otherTerminalAttempt", fixtures["other-terminal"]);
  await expectBlocked("wrongPurpose", fixtures["wrong-purpose"]);
  await expectBlocked("wrongPipelineRunId", fixtureValid, { p_pipeline_run_id: randomUUID() });

  const anon = await rpc(argsFor(fixtures.concurrency), anonKey);
  assert.ok([401, 403].includes(anon.status), "anon REST invocation is denied");
  const roleSecurity = queryOne(`
begin;
set local role anon;
do $$ declare denied boolean := false; begin begin execute ${sqlLiteral(`select public.${resumeFunctionName}('${fixtures.concurrency.attemptId}'::uuid,'${fixtures.concurrency.continuationRunId}'::uuid,'${randomUUID()}'::uuid,'${JSON.stringify(fixtures.concurrency.manifest).replaceAll("'", "''")}'::jsonb)`)}; exception when insufficient_privilege then denied := true; end; if not denied then raise exception 'ANON_RESUME_WAS_NOT_DENIED'; end if; end $$;
reset role;
set local role authenticated;
do $$ declare denied boolean := false; begin begin execute ${sqlLiteral(`select public.${resumeFunctionName}('${fixtures.concurrency.attemptId}'::uuid,'${fixtures.concurrency.continuationRunId}'::uuid,'${randomUUID()}'::uuid,'${JSON.stringify(fixtures.concurrency.manifest).replaceAll("'", "''")}'::jsonb)`)}; exception when insufficient_privilege then denied := true; end; if not denied then raise exception 'AUTHENTICATED_RESUME_WAS_NOT_DENIED'; end if; end $$;
reset role;
select jsonb_build_object('anonDenied',not has_function_privilege('anon','${resumeSignature}','execute'),'authenticatedDenied',not has_function_privilege('authenticated','${resumeSignature}','execute'),'publicDenied',not exists(select 1 from aclexplode((select proacl from pg_proc where oid='${resumeSignature}'::regprocedure)) where grantee=0 and privilege_type='EXECUTE'),'serviceRoleAllowed',has_function_privilege('service_role','${resumeSignature}','execute')) as security;
rollback;`, "role-security").security;
  assert.deepEqual(roleSecurity, { anonDenied: true, authenticatedDenied: true, publicDenied: true, serviceRoleAllowed: true });

  const beforeResume = remoteAttempt;
  const runCountBefore = queryOne(`select jsonb_build_object('rows',(select count(*) from public.pipeline_event_attempts where event_key=${sqlLiteral(fixtureValid.eventKey)}),'resumeIdExists',(select count(*) from public.pipeline_event_attempts where pipeline_run_id=${sqlLiteral(randomUUID())}::uuid),'authorizationCount',1) as value;`, "before-resume-counts").value;
  assert.equal(runCountBefore.rows, 2);
  const executionId = randomUUID();
  const validArgs = argsFor(fixtureValid, { p_resume_execution_id: executionId, p_checkpoint_manifest: reorderedJsonbManifest(fixtureValid) });
  const admitted = await rpc(validArgs);
  assert.equal(admitted.status, 200);
  assert.deepEqual(admitted.body, {
    status: "RESUMED", attemptId: fixtureValid.attemptId,
    pipelineRunId: fixtureValid.continuationRunId, resumeExecutionId: executionId,
    resumeGeneration: 1, authorizationReused: true, newAuthorizationCreated: false, newAttemptCreated: false,
  });
  const afterResume = await readAttempt(fixtureValid.attemptId);
  assert.equal(afterResume.id, beforeResume.id);
  assert.equal(afterResume.pipeline_run_id, beforeResume.pipeline_run_id);
  assert.equal(afterResume.final_state, beforeResume.final_state);
  assert.equal(afterResume.completed_at, beforeResume.completed_at);
  assert.equal(afterResume.stop_stage, beforeResume.stop_stage);
  assert.equal(afterResume.stop_reason, beforeResume.stop_reason);
  assert.equal(afterResume.continuation.pipelineRunId, fixtureValid.continuationRunId);
  assert.equal(afterResume.continuation.resumeExecutionId, executionId);
  assert.equal(afterResume.continuation.resumeGeneration, 1);
  assert.equal(afterResume.continuation.status, "RUNNING");
  assert.equal(afterResume.continuation.resumeStage, "critic");
  assert.deepEqual(afterResume.continuation.resumeHistory[0], beforeResume.continuation, "entire prior STOPPED JSON state remains auditable");
  const afterResumeCounts = queryOne(`select jsonb_build_object('rows',(select count(*) from public.pipeline_event_attempts where event_key=${sqlLiteral(fixtureValid.eventKey)}),'pilotSix',(select count(*) from public.pipeline_event_attempts where event_key=${sqlLiteral(fixtureValid.eventKey)} and pilot_attempt_number=6),'authFields',(select count(*) from public.pipeline_event_attempts where id=${sqlLiteral(fixtureValid.attemptId)} and continuation ? 'authorizedBy' and continuation ? 'authorizationReference'),'executionRows',(select count(*) from public.agent_runs where config->>'pipelineRunId'=${sqlLiteral(executionId)})) as value;`, "after-resume-counts").value;
  assert.equal(afterResumeCounts.rows, 2);
  assert.equal(afterResumeCounts.pilotSix, 0);
  assert.equal(afterResumeCounts.authFields, 1);
  assert.equal(afterResumeCounts.executionRows, 0, "resume transition creates no Critic agent run");
  const secondResume = await rpc(argsFor(fixtureValid, { p_resume_execution_id: randomUUID(), p_checkpoint_manifest: rootManifest }));
  assert.equal(secondResume.status, 200, "second resume returns a structured BLOCKED result");
  assert.equal(secondResume.body.status, "BLOCKED", `second resume is rejected: ${JSON.stringify(secondResume.body)}`);
  assert.ok([
    "AUTHORIZED_STOPPED_STATE_NOT_RESUMABLE",
    "AUTHORIZED_RESUME_ALREADY_USED_OR_EXECUTION_ID_EXISTS",
    "AUTHORIZED_RESUME_ALREADY_USED",
  ].includes(secondResume.body.reason), `second resume rejection is a canonical one-resume guard: ${JSON.stringify(secondResume.body)}`);
  deniedCases.secondResume = secondResume.body.reason;
  assert.deepEqual(await capacitySnapshot(), afterSetupCapacity, "the valid resume transition adds no provider accounting");

  const concurrencyArgs1 = argsFor(fixtures.concurrency, { p_resume_execution_id: randomUUID() });
  const concurrencyArgs2 = argsFor(fixtures.concurrency, { p_resume_execution_id: randomUUID() });
  const concurrent = await Promise.all([rpc(concurrencyArgs1), rpc(concurrencyArgs2)]);
  assert.equal(concurrent.length, 2);
  const concurrentAdmitted = concurrent.filter((response) => response.status === 200 && response.body.status === "RESUMED");
  const concurrentRejected = concurrent.filter((response) => response.status === 200 && response.body.status === "BLOCKED");
  assert.equal(concurrentAdmitted.length, 1, "one concurrent request is admitted");
  assert.equal(concurrentRejected.length, 1, "one concurrent request is rejected");
  const concurrencyAfter = await readAttempt(fixtures.concurrency.attemptId);
  assert.equal(concurrencyAfter.continuation.resumeGeneration, 1);
  assert.equal(concurrencyAfter.continuation.resumeExecutionId, concurrentAdmitted[0].body.resumeExecutionId);

  const afterTests = await realSnapshot();
  assert.equal(afterTests.migration30, true);
  assert.equal(afterTests.migration31, false);
  assert.equal(afterTests.realAttempts.find((a) => a.id === "a82482be-58d8-4fc6-ac16-946d0906257b").continuation.status, "STOPPED");
  assert.equal(afterTests.realAttempts.length, 2);
  assert.deepEqual(afterTests.publicRows, beforeSetupPublic);
  assert.equal(afterTests.publicCount, baseline.publicCount);
  assert.deepEqual(afterTests.capacity, baseline.capacity, "synthetic validation does not change the daily provider ledger baseline");

  report = {
    status: "PASS",
    projectRef,
    namespace,
    migration30PriorState: migrationBefore,
    migration30AppliedThisSession,
    migration30FinalState: "APPLIED",
    migrationLatest: schemaVersion,
    migration31: "ABSENT",
    remoteObjects: { resumeRpc: resumeSignature, constraintChanged: "pipeline_event_attempts_remediation_metadata_check", columnsAffected: [], indexesAffected: [], newTables: 0, owner: migrationAudit.owner, securityDefiner: migrationAudit.securityDefiner, searchPath: migrationAudit.config },
    security: { serviceRole: "ALLOWED", anon: "DENIED", authenticated: "DENIED", publicExecute: "DENIED", checks: roleSecurity },
    jsonbRoundTrip: { rawStringifyEqual: false, semanticEquality: true, canonicalHashEqual: true, strictSyntheticSchema: "PASS" },
    semanticManifestComparison: "PASS",
    validResume: { status: admitted.body.status, sameAttempt: afterResume.id === beforeResume.id, sameAuthorization: afterResume.continuation.pipelineRunId === fixtureValid.continuationRunId, resumeExecutionId: executionId, stage: afterResume.continuation.resumeStage, criticDispatched: false, criticReservation: false },
    invalidManifestCases: deniedCases,
    oneResumeRule: { status: "PASS", secondResume: "REJECTED" },
    concurrency: { requests: 2, admitted: concurrentAdmitted.length, rejected: concurrentRejected.length },
    historicalStopPreserved: true,
    attemptInvariant: { before: runCountBefore.rows, after: afterResumeCounts.rows, newAttempts: 0, attemptSix: afterResumeCounts.pilotSix },
    authorizationInvariant: { before: 1, after: afterResumeCounts.authFields, secondAuthorizationCreated: false },
    checkpointPolicy: { reused: ["verifier", "translator", "editor", "classifier", "ranker"], next: "critic", criticCheckpointAbsentRequired: true, publisherAllowedDuringResumeValidation: false },
    normalLifecycleUnchanged: { migration27RemediationFunctionChanged: false, migration28AuthorizationChanged: false, migration29AuthorizationFixChanged: false, normalRoutineHashesEqual: JSON.stringify(baseline.normalRoutineHashes) === JSON.stringify(afterTests.normalRoutineHashes) },
    capacityDelta: {
      groq: {
        requestsReserved: afterSetupCapacity.groq.requestsReserved - baseline.capacity.groq.requestsReserved,
        requestsDispatched: afterSetupCapacity.groq.requestsDispatched - baseline.capacity.groq.requestsDispatched,
        totalTokens: afterSetupCapacity.groq.totalTokens - baseline.capacity.groq.totalTokens,
        unknownReservations: afterSetupCapacity.groq.unknownTokenRequests - baseline.capacity.groq.unknownTokenRequests,
      },
      cloudflare: {
        requestsReserved: afterSetupCapacity.cloudflare.requestsReserved - baseline.capacity.cloudflare.requestsReserved,
        requestsDispatched: afterSetupCapacity.cloudflare.requestsDispatched - baseline.capacity.cloudflare.requestsDispatched,
        neurons: afterSetupCapacity.cloudflare.neuronsUsed - baseline.capacity.cloudflare.neuronsUsed,
        unknownRequests: afterSetupCapacity.cloudflare.unknownRequests - baseline.capacity.cloudflare.unknownRequests,
      },
      cerebras: {
        requestsReserved: afterSetupCapacity.cerebras.requestsReserved - baseline.capacity.cerebras.requestsReserved,
        requestsDispatched: afterSetupCapacity.cerebras.requestsDispatched - baseline.capacity.cerebras.requestsDispatched,
        totalTokens: afterSetupCapacity.cerebras.totalTokens - baseline.capacity.cerebras.totalTokens,
        unknownTokenRequests: afterSetupCapacity.cerebras.unknownTokenRequests - baseline.capacity.cerebras.unknownTokenRequests,
      },
      providerCalls: 0,
      resumeCreatedReservation: false,
    },
    providerAccounting: { beforeSynthetic: baseline.capacity, afterSyntheticCleanup: afterTests.capacity },
    realAttemptState: { id: "a82482be-58d8-4fc6-ac16-946d0906257b", state: "TECHNICAL_FAILURE", pilotAttempt: "5/5", continuation: "STOPPED", resumeExecuted: false, reservation: false, dispatch: false, checkpoint: false, attempts: 2 },
    realContinuationState: "STOPPED",
    realArticleState: afterTests.article.publicationStatus,
    publicCount: afterTests.publicCount,
    realIncidentPublic: false,
    baselineRestoredBeforeCleanup: true,
    syntheticResidualRows: "CLEANED_IN_FINALLY",
    runnerPreflight: "PENDING_AFTER_CLEANUP",
  };
} catch (error) {
  primaryError = error;
} finally {
  if (setup.attempted) {
    try {
      dbQuery(cleanupSql(), "fixture-cleanup");
      cleanupResidual = queryOne(residualSql(), "fixture-residual").residual;
      assert.deepEqual(cleanupResidual, { attempts: 0, events: 0, articles: 0, rawItems: 0, sources: 0, eventSources: 0, agentRuns: 0, agentLogs: 0 });
    } catch (error) {
      primaryError = primaryError ? new Error(`${primaryError.message}; SYNTHETIC_CLEANUP_FAILED:${error.message}`) : error;
    }
  }
  cleanupScratchFiles();
}

if (primaryError) throw primaryError;
try {
  const finalReal = await realSnapshot();
  assert.equal(finalReal.migration30, true);
  assert.equal(finalReal.migration31, false);
  assert.equal(finalReal.realAttempts.length, 2);
  assert.equal(finalReal.realAttempts.find((a) => a.id === "a82482be-58d8-4fc6-ac16-946d0906257b").continuation.status, "STOPPED");
  assert.equal(finalReal.article.publicationStatus, "archived");
  assert.equal(finalReal.publicCount, baseline.publicCount);
  assert.deepEqual(finalReal.publicRows, baseline.publicRows);
  assert.deepEqual(finalReal.capacity, baseline.capacity);
  assert.deepEqual(cleanupResidual, { attempts: 0, events: 0, articles: 0, rawItems: 0, sources: 0, eventSources: 0, agentRuns: 0, agentLogs: 0 });
  report.cleanup = { residualRows: cleanupResidual, baselineRestored: true };
  report.baselineRestoredAfterCleanup = true;
  report.realAttemptStateAfter = { id: "a82482be-58d8-4fc6-ac16-946d0906257b", state: "TECHNICAL_FAILURE", pilotAttempt: "5/5", continuation: "STOPPED", resumeGeneration: finalReal.realAttempts.find((a) => a.id === "a82482be-58d8-4fc6-ac16-946d0906257b").continuation.resumeGeneration ?? null };
  report.realArticleStateAfter = finalReal.article.publicationStatus;
  report.publicCountAfter = finalReal.publicCount;
  report.capacityAfterCleanup = finalReal.capacity;
  console.log(JSON.stringify(report, null, 2));
} finally {
  cleanupScratchFiles();
}
