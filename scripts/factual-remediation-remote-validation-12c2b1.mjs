import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const expectedProjectRef = "skrthgpurquypgdwxast";
const linkedProjectRef = readFileSync(resolve(repo, "supabase/.temp/project-ref"), "utf8").trim();
const namespace = "12c2b1:" + randomUUID();
const baseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const snapshotSqlPath = resolve(repo, "supabase/.temp/12c2b1-baseline.sql");
const sqlTempPaths = new Set();
const suffixes = ["valid", "concurrency", "not-archived", "wrong-prior"];
const realIds = new Set(["756b0ee0-b5e6-4153-846f-278a12c9afe3", "5138e509-f4c3-4020-9d13-6a6efac99a39", "d3834944-72f6-4f59-9aca-3f66ae92dc33"]);

if (!process.argv.includes("--execute-synthetic-validation")) throw new Error("SYNTHETIC_VALIDATION_REQUIRES_EXPLICIT_FLAG");
if (linkedProjectRef !== expectedProjectRef) throw new Error("LINKED_PROJECT_REF_MISMATCH");
if (!baseUrl || !serviceKey || !anonKey) throw new Error("SUPABASE_VALIDATION_CONFIGURATION_MISSING");
if (new URL(baseUrl).hostname.split(".")[0] !== expectedProjectRef) throw new Error("SUPABASE_URL_PROJECT_REF_MISMATCH");
if (!existsSync(snapshotSqlPath)) throw new Error("PREVALIDATION_SNAPSHOT_QUERY_MISSING");

const sqlLiteral = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const jsonLiteral = (value) => sqlLiteral(JSON.stringify(value)) + "::jsonb";
const md5 = (value) => createHash("md5").update(value).digest("hex");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableStringify = (value) => {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + stableStringify(item)).join(",") + "}";
  return JSON.stringify(value);
};

function runDbQuery(sql, label) {
  const sqlPath = resolve(repo, "supabase/.temp", "12c2b1-" + randomUUID() + "-" + label + ".sql");
  sqlTempPaths.add(sqlPath);
  writeFileSync(sqlPath, sql.trim() + "\n", "utf8");
  const cli = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(cli, ["--yes", "supabase", "db", "query", "--linked", "--output-format", "json", "--file", sqlPath], {
    cwd: repo, encoding: "utf8", shell: process.platform === "win32", windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error("DB_QUERY_" + label + "_FAILED:" + (result.error?.message || result.stderr?.slice(-300) || result.status));
  const output = result.stdout || "";
  const jsonStart = output.indexOf("{");
  if (jsonStart < 0) throw new Error("DB_QUERY_" + label + "_RESULT_MISSING");
  try { return JSON.parse(output.slice(jsonStart)); } catch { throw new Error("DB_QUERY_" + label + "_RESULT_INVALID"); }
}

async function callRpc(name, args, key = serviceKey) {
  const response = await fetch(baseUrl + "/rest/v1/rpc/" + name, {
    method: "POST", cache: "no-store",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(args),
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { message: raw.slice(0, 240) }; }
  return { httpStatus: response.status, body };
}

async function readAttempt(id) {
  const url = new URL(baseUrl + "/rest/v1/pipeline_event_attempts");
  url.searchParams.set("select", "*");
  url.searchParams.set("id", "eq." + id);
  const response = await fetch(url, { cache: "no-store", headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, Accept: "application/json" } });
  assert.equal(response.status, 200);
  const rows = await response.json();
  assert.equal(rows.length, 1);
  return rows[0];
}

async function readPublicRows() {
  const url = new URL(baseUrl + "/rest/v1/public_published_articles");
  url.searchParams.set("select", "*");
  url.searchParams.set("order", "slug.asc");
  const response = await fetch(url, { cache: "no-store", headers: { apikey: anonKey, Authorization: "Bearer " + anonKey, Accept: "application/json" } });
  assert.equal(response.status, 200);
  const rows = await response.json();
  return rows.map((row) => ({ slug: row.slug, sha256: sha256(stableStringify(row)) }));
}

async function captureSnapshot() {
  const response = runDbQuery(readFileSync(snapshotSqlPath, "utf8"), "snapshot");
  const baseline = response.rows?.[0]?.baseline;
  assert.ok(baseline, "prevalidation SQL returns a database baseline");
  const counts = runDbQuery(
    "select jsonb_build_object(" +
      "'realRemediationAttempts',(select count(*) from public.pipeline_event_attempts where event_key='event-30f226d1b8ba5c9eb8af2b65c46db512' and purpose='FACTUAL_REMEDIATION')," +
      "'realActiveRemediationAttempts',(select count(*) from public.pipeline_event_attempts where event_key='event-30f226d1b8ba5c9eb8af2b65c46db512' and purpose='FACTUAL_REMEDIATION' and completed_at is null)" +
      ") as counts;",
    "real-remediation-counts",
  );
  baseline.real_remediation_attempts = counts.rows?.[0]?.counts?.realRemediationAttempts;
  baseline.real_active_remediation_attempts = counts.rows?.[0]?.counts?.realActiveRemediationAttempts;
  return baseline;
}

function makeFixture(suffix, priorState, articleStatus) {
  const eventId = randomUUID();
  const articleId = randomUUID();
  const rawItemId = randomUUID();
  const priorAttemptId = randomUUID();
  const priorPipelineRunId = randomUUID();
  const eventKey = "event-" + md5(namespace + ":" + suffix + ":" + eventId);
  const slug = "synthetic-12c2b1-" + suffix + "-" + eventId.slice(0, 8);
  for (const id of [eventId, articleId, rawItemId, priorAttemptId, priorPipelineRunId]) assert.equal(realIds.has(id), false);
  return { suffix, eventKey, eventId, articleId, rawItemId, priorAttemptId, priorPipelineRunId, slug, priorState, articleStatus };
}

function fixtureSetupSql(fixtures, orphanRawId) {
  const sourceId = randomUUID();
  const nsId = namespace.slice("12c2b1:".length);
  const sourceUrl = "https://example.invalid/12c2b1/" + nsId + "/source";
  const statements = [
    "insert into public.sources (id,name,url,source_type,language,metadata) values (" +
      sqlLiteral(sourceId) + "," + sqlLiteral("12C.2B.1 synthetic source " + namespace) + "," + sqlLiteral(sourceUrl) +
      ",'other','en'," + jsonLiteral({ validationNamespace: namespace }) + ");",
  ];
  for (const fixture of fixtures) {
    const text = "Synthetic validation content only; namespace " + namespace + "; fixture " + fixture.suffix + ".";
    const contentHash = "sha256:" + sha256(text);
    statements.push(
      "insert into public.events (id,event_key,canonical_title,event_status,review_status,classification_payload) values (" +
        sqlLiteral(fixture.eventId) + "," + sqlLiteral(fixture.eventKey) + "," + sqlLiteral("Synthetic event " + namespace + " " + fixture.suffix) +
        ",'active','approved'," + jsonLiteral({ validationNamespace: namespace, fixture: fixture.suffix }) + ");",
      "insert into public.raw_items (id,source_id,original_url,canonical_url,external_id,title,excerpt,raw_content,content_type,language,content_hash,processing_status,extraction_quality,extracted_at,normalized_payload) values (" +
        sqlLiteral(fixture.rawItemId) + "," + sqlLiteral(sourceId) + "," +
        sqlLiteral("https://example.invalid/12c2b1/" + nsId + "/" + fixture.suffix) + "," +
        sqlLiteral("https://example.invalid/12c2b1/" + nsId + "/" + fixture.suffix) + "," +
        sqlLiteral(namespace + ":" + fixture.suffix) + "," + sqlLiteral("Synthetic fixture " + fixture.suffix) + "," +
        sqlLiteral("Synthetic source text for database lifecycle validation.") + "," + sqlLiteral(text) +
        ",'article','en'," + sqlLiteral(contentHash) + ",'extracted','full',now()," +
        jsonLiteral({ validationNamespace: namespace, fixture: fixture.suffix }) + ");",
      "insert into public.event_sources (event_id,raw_item_id,source_id,is_primary) values (" +
        sqlLiteral(fixture.eventId) + "," + sqlLiteral(fixture.rawItemId) + "," + sqlLiteral(sourceId) + ",true);",
      "insert into public.articles (id,event_id,slug,headline_es,summary_es,publication_status,metadata) values (" +
        sqlLiteral(fixture.articleId) + "," + sqlLiteral(fixture.eventId) + "," + sqlLiteral(fixture.slug) + "," +
        sqlLiteral("Artículo sintético " + fixture.suffix) + "," +
        sqlLiteral("Contenido sintético sin texto protegido; solo fixture de validación.") + "," +
        sqlLiteral(fixture.articleStatus) + "," + jsonLiteral({ validationNamespace: namespace, fixture: fixture.suffix }) + ");",
      "insert into public.pipeline_event_attempts (id,event_key,pipeline_run_id,attempt_number,started_at,completed_at,final_state,stop_stage,stop_reason,counts_toward_retry_limit) values (" +
        sqlLiteral(fixture.priorAttemptId) + "," + sqlLiteral(fixture.eventKey) + "," + sqlLiteral(fixture.priorPipelineRunId) +
        ",1,now()-interval '2 minutes',now()-interval '1 minute'," + sqlLiteral(fixture.priorState) +
        ",'synthetic_validation'," + sqlLiteral(namespace + ":synthetic-prior:" + fixture.suffix) + ",false);",
    );
  }
  const orphanText = "Synthetic orphan lineage only; namespace " + namespace + ".";
  statements.push(
    "insert into public.raw_items (id,source_id,original_url,canonical_url,external_id,title,excerpt,raw_content,content_type,language,content_hash,processing_status,extraction_quality,extracted_at,normalized_payload) values (" +
      sqlLiteral(orphanRawId) + "," + sqlLiteral(sourceId) + "," +
      sqlLiteral("https://example.invalid/12c2b1/" + nsId + "/orphan") + "," +
      sqlLiteral("https://example.invalid/12c2b1/" + nsId + "/orphan") + "," +
      sqlLiteral(namespace + ":orphan") + ",'Synthetic orphan lineage','Synthetic orphan evidence.'," + sqlLiteral(orphanText) +
      ",'article','en'," + sqlLiteral("sha256:" + sha256(orphanText)) +
      ",'extracted','full',now()," + jsonLiteral({ validationNamespace: namespace, fixture: "orphan" }) + ");",
  );
  return statements.join("\n");
}

function claimArgs(fixture, overrides = {}) {
  return {
    p_pipeline_run_id: randomUUID(),
    p_authorized_by: "Codex synthetic validation",
    p_authorization_reference: namespace + ":approval",
    p_reason: "Synthetic lifecycle validation for " + fixture.suffix + "; no real incident data.",
    p_event_key: fixture.eventKey,
    p_event_id: fixture.eventId,
    p_article_id: fixture.articleId,
    p_raw_item_id: fixture.rawItemId,
    p_prior_attempt_id: fixture.priorAttemptId,
    p_purpose: "FACTUAL_REMEDIATION",
    p_start_stage: "VERIFIER",
    p_validation_namespace: namespace,
    ...overrides,
  };
}

function cleanupSql() {
  const n = sqlLiteral(namespace);
  return [
    "delete from public.pipeline_event_attempts where validation_namespace = " + n +
      " or stop_reason like " + sqlLiteral(namespace + ":synthetic-prior:%") +
      " or event_key in (select e.event_key from public.events e where e.classification_payload ->> 'validationNamespace' = " + n + ");",
    "delete from public.articles where metadata ->> 'validationNamespace' = " + n + ";",
    "delete from public.event_sources where event_id in (select e.id from public.events e where e.classification_payload ->> 'validationNamespace' = " + n + ");",
    "delete from public.events where classification_payload ->> 'validationNamespace' = " + n + ";",
    "delete from public.raw_items where normalized_payload ->> 'validationNamespace' = " + n + ";",
    "delete from public.sources where metadata ->> 'validationNamespace' = " + n + ";",
  ].join("\n");
}

function residualSql() {
  const n = sqlLiteral(namespace);
  return "select jsonb_build_object(" +
    "'attempts',(select count(*) from public.pipeline_event_attempts where validation_namespace = " + n + " or stop_reason like " + sqlLiteral(namespace + ":synthetic-prior:%") + ")," +
    "'events',(select count(*) from public.events where classification_payload ->> 'validationNamespace' = " + n + ")," +
    "'articles',(select count(*) from public.articles where metadata ->> 'validationNamespace' = " + n + ")," +
    "'rawItems',(select count(*) from public.raw_items where normalized_payload ->> 'validationNamespace' = " + n + ")," +
    "'sources',(select count(*) from public.sources where metadata ->> 'validationNamespace' = " + n + ")," +
    "'eventSources',(select count(*) from public.event_sources es join public.events e on e.id=es.event_id where e.classification_payload ->> 'validationNamespace' = " + n + ")" +
    ") as residual;";
}

const fixtures = suffixes.map((suffix) => makeFixture(
  suffix,
  suffix === "wrong-prior" ? "TECHNICAL_FAILURE" : "READY_FOR_PUBLICATION",
  suffix === "not-archived" ? "draft" : "archived",
));
const fixtureByName = Object.fromEntries(fixtures.map((fixture) => [fixture.suffix, fixture]));
const orphanRawId = randomUUID();
let setupAttempted = false;
let originalSnapshot;
let mainError;
let report;
let cleanup;

try {
  originalSnapshot = await captureSnapshot();
  assert.equal(originalSnapshot.article?.publication_status, "archived");
  assert.equal(originalSnapshot.public?.count, 2);
  assert.equal(originalSnapshot.public?.incident_visible, false);
  assert.equal(originalSnapshot.pilot_attempt_matches, 4);
  assert.equal(originalSnapshot.remediation_schema_present, true);
  assert.equal(originalSnapshot.attempts?.count, 1);
  assert.equal(originalSnapshot.real_remediation_attempts, 0);
  assert.equal(originalSnapshot.real_active_remediation_attempts, 0);

  const publicBefore = await readPublicRows();
  setupAttempted = true;
  runDbQuery(fixtureSetupSql(fixtures, orphanRawId), "fixture-setup");
  const whileFixturesExist = await captureSnapshot();
  const publicWhileFixturesExist = await readPublicRows();
  assert.deepEqual(whileFixturesExist, originalSnapshot, "fixtures do not change real incident, public, pilot, or capacity baseline");
  assert.deepEqual(publicWhileFixturesExist, publicBefore, "synthetic articles never enter the public contract");

  const valid = fixtureByName.valid;
  const anonCall = await callRpc("claim_factual_remediation_attempt", claimArgs(valid), anonKey);
  assert.ok([401, 403].includes(anonCall.httpStatus), "anon is denied by the actual REST RPC boundary");

  const normalClaim = await callRpc("claim_pipeline_event_attempt", {
    p_event_key: valid.eventKey,
    p_pipeline_run_id: randomUUID(),
    p_started_at: new Date().toISOString(),
    p_now: new Date().toISOString(),
    p_stale_after_seconds: 3600,
  });
  assert.equal(normalClaim.httpStatus, 200);
  assert.equal(normalClaim.body.status, "INELIGIBLE");
  assert.equal(normalClaim.body.reason, "PERMANENT_OUTCOME");

  const invalidCases = {};
  async function expectBlocked(name, fixture, overrides) {
    const result = await callRpc("claim_factual_remediation_attempt", claimArgs(fixture, overrides));
    assert.equal(result.httpStatus, 200, name + " returned a structured rejection");
    assert.equal(result.body.status, "BLOCKED", name + " is rejected");
    invalidCases[name] = result.body.reason;
  }
  await expectBlocked("articleNotArchived", fixtureByName["not-archived"], {});
  await expectBlocked("unknownEvent", valid, { p_event_id: randomUUID() });
  await expectBlocked("unknownArticle", valid, { p_article_id: randomUUID() });
  await expectBlocked("articleEventMismatch", fixtureByName.concurrency, { p_article_id: valid.articleId });
  await expectBlocked("wrongRawLineage", valid, { p_raw_item_id: orphanRawId });
  await expectBlocked("wrongPriorAttemptState", fixtureByName["wrong-prior"], {});
  await expectBlocked("wrongPurpose", valid, { p_purpose: "NORMAL" });
  await expectBlocked("wrongRestartStage", valid, { p_start_stage: "EDITOR" });
  await expectBlocked("invalidValidationNamespace", valid, { p_validation_namespace: "not-a-12c2b1-namespace" });
  const missingAuthorization = await callRpc("claim_factual_remediation_attempt", claimArgs(valid, { p_authorized_by: "" }));
  assert.equal(missingAuthorization.httpStatus, 400);
  assert.equal(missingAuthorization.body.code, "22023");
  invalidCases.missingHumanAuthorization = missingAuthorization.body.code;

  const priorBefore = await readAttempt(valid.priorAttemptId);
  const validResult = await callRpc("claim_factual_remediation_attempt", claimArgs(valid));
  assert.equal(validResult.httpStatus, 200);
  assert.equal(validResult.body.status, "ACQUIRED");
  const newAttempt = validResult.body.attempt;
  assert.equal(newAttempt.attempt_number, 2);
  assert.equal(newAttempt.purpose, "FACTUAL_REMEDIATION");
  assert.equal(newAttempt.start_stage, "VERIFIER");
  assert.equal(newAttempt.pilot_attempt_number, null);
  assert.equal(newAttempt.validation_namespace, namespace);
  const priorAfter = await readAttempt(valid.priorAttemptId);
  assert.equal(sha256(stableStringify(priorAfter)), sha256(stableStringify(priorBefore)), "historical attempt is immutable");

  const duplicateActive = await callRpc("claim_factual_remediation_attempt", claimArgs(valid));
  assert.equal(duplicateActive.httpStatus, 200);
  assert.equal(duplicateActive.body.status, "BLOCKED");
  assert.equal(duplicateActive.body.reason, "ACTIVE_ATTEMPT");

  const concurrentFixture = fixtureByName.concurrency;
  const priorBeforeConcurrency = await readAttempt(concurrentFixture.priorAttemptId);
  const concurrent = await Promise.all([
    callRpc("claim_factual_remediation_attempt", claimArgs(concurrentFixture)),
    callRpc("claim_factual_remediation_attempt", claimArgs(concurrentFixture)),
  ]);
  assert.ok(concurrent.every((result) => result.httpStatus === 200));
  const admitted = concurrent.filter((result) => result.body.status === "ACQUIRED");
  const rejected = concurrent.filter((result) => result.body.status === "BLOCKED");
  assert.equal(admitted.length, 1, "exactly one concurrent PostgreSQL request is admitted");
  assert.equal(rejected.length, 1, "the other concurrent PostgreSQL request is rejected");
  assert.equal(rejected[0].body.reason, "ACTIVE_ATTEMPT");
  assert.equal(admitted[0].body.attempt.attempt_number, 2);
  assert.equal(admitted[0].body.attempt.validation_namespace, namespace);
  const priorAfterConcurrency = await readAttempt(concurrentFixture.priorAttemptId);
  assert.equal(sha256(stableStringify(priorAfterConcurrency)), sha256(stableStringify(priorBeforeConcurrency)));

  const during = await captureSnapshot();
  assert.deepEqual(during, originalSnapshot, "real and capacity baselines are unchanged while synthetic attempts exist");
  assert.deepEqual(await readPublicRows(), publicBefore);
  report = {
    status: "PASS",
    projectRef: expectedProjectRef,
    namespace,
    fixtureKinds: suffixes,
    fixtureRowsCreated: { sources: 1, events: fixtures.length, articles: fixtures.length, rawItems: fixtures.length + 1, eventSources: fixtures.length, priorAttempts: fixtures.length, remediationAttempts: 2 },
    serviceRole: "ALLOWED",
    anon: "DENIED",
    authenticated: "DENIED_BY_EXECUTE_ACL",
    normalFinalClaim: normalClaim.body,
    validRemediation: {
      status: validResult.body.status,
      attemptNumber: newAttempt.attempt_number,
      purpose: newAttempt.purpose,
      restart: newAttempt.start_stage,
      pilotAttemptNumber: newAttempt.pilot_attempt_number,
      validationNamespace: newAttempt.validation_namespace,
    },
    invalidCases,
    duplicateActive: duplicateActive.body.reason,
    concurrency: { requests: 2, admitted: admitted.length, rejected: rejected.length, rejectionReason: rejected[0].body.reason },
    oldAttemptImmutable: true,
    checkpointPolicy: "No model stage ran; remediation uses a new run id; previous Verifier-onward checkpoints are not selected.",
    capacityBefore: originalSnapshot.capacity,
    capacityDuring: during.capacity,
    capacityDelta: "0",
    realIncidentState: {
      articleStatus: during.article.publication_status,
      articleId: during.article.id,
      slug: during.article.slug,
      eventId: during.event.id,
      eventKey: during.event.event_key,
      historicalAttempts: during.attempts.count,
      realRemediationAttempts: during.real_remediation_attempts,
      pilotAttemptMatches: during.pilot_attempt_matches,
      publicCount: during.public.count,
      incidentVisible: during.public.incident_visible,
    },
    publicRowsBeforeFixtures: publicBefore,
    publicRowsDuringFixtures: await readPublicRows(),
  };
} catch (error) {
  mainError = error;
} finally {
  if (setupAttempted) {
    try {
      runDbQuery(cleanupSql(), "fixture-cleanup");
      const result = runDbQuery(residualSql(), "fixture-residual-check");
      cleanup = result.rows?.[0]?.residual;
      assert.ok(cleanup);
      assert.deepEqual(cleanup, { attempts: 0, events: 0, articles: 0, rawItems: 0, sources: 0, eventSources: 0 });
    } catch (error) {
      mainError = mainError ? new Error(mainError.message + "; FIXTURE_CLEANUP_FAILED:" + error.message) : error;
    }
  } else {
    cleanup = { attempts: 0, events: 0, articles: 0, rawItems: 0, sources: 0, eventSources: 0 };
  }
  for (const path of sqlTempPaths) {
    try { unlinkSync(path); } catch {}
  }
}

if (mainError) throw mainError;
const afterCleanup = await captureSnapshot();
assert.deepEqual(afterCleanup, originalSnapshot, "all prevalidation real, public, and capacity baselines are restored");
report.cleanup = { residualRows: cleanup, baselineRestored: true };
report.baselineAfterCleanup = afterCleanup;
console.log(JSON.stringify(report, null, 2));
