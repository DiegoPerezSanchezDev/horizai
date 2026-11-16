import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SupabaseHumanReviewReadRepository, parseHumanReviewOperatorInspection, parseHumanReviewOperatorList } from "../lib/agents/publisher/human-review-read-repository.ts";
import { buildHumanReviewInspection, buildHumanReviewListEntry } from "../lib/agents/publisher/human-review-operator.ts";
import { parseHumanReviewOperatorStatus } from "../lib/agents/publisher/human-review-status.ts";

const migration = readFileSync("supabase/migrations/20261007215233_human_review_operator_read_rpc.sql", "utf8");
const normalized = migration.toLowerCase();
const migration31 = readFileSync("supabase/migrations/20261005194000_supervised_human_review_gate.sql", "utf8").toLowerCase();
// The CLI and the shared operations module (also used by the editorial panel) together form the operator read/decide path.
const operatorCli = readFileSync("scripts/pipeline-human-review.ts", "utf8") + "\n" + readFileSync("lib/agents/publisher/human-review-operations.ts", "utf8");
const readRepositorySource = readFileSync("lib/agents/publisher/human-review-read-repository.ts", "utf8");
const statusParserSource = readFileSync("lib/agents/publisher/human-review-status.ts", "utf8");
const functionNames = [
  "get_pipeline_human_review_operator_status",
  "list_pipeline_human_reviews_operator",
  "get_pipeline_human_review_operator_inspect",
];

function functionBody(name) {
  const start = migration.search(new RegExp(`create\\s+function\\s+public\\.${name}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `${name} is created`);
  const end = migration.indexOf("$function$;", start);
  assert.notEqual(end, -1, `${name} body is complete`);
  return migration.slice(start, end + "$function$;".length);
}

const bodies = Object.fromEntries(functionNames.map((name) => [name, functionBody(name)]));
for (const [name, body] of Object.entries(bodies)) {
  assert.match(body, /language\s+plpgsql[\s\S]*?stable[\s\S]*?security\s+definer/i, `${name} is stable and SECURITY DEFINER`);
  assert.match(body, /set\s+search_path\s*=\s*pg_catalog\s*,\s*public/i, `${name} fixes the search path`);
  assert.match(body, /auth\.role\(\)\s+is\s+distinct\s+from\s+'service_role'/i, `${name} rejects non-service callers`);
  assert.match(body, /raise\s+exception\s+using\s+errcode\s*=\s*'42501'/i, `${name} has typed authorization failure`);
  assert.doesNotMatch(body, /\b(?:insert\s+into|update\s+public\.|delete\s+from|truncate|execute\s+(?:immediate|format))\b/i, `${name} is read-only and has no dynamic SQL`);
}
assert.match(bodies.get_pipeline_human_review_operator_status, /get_pipeline_human_review_operator_status\(\)\s+returns\s+jsonb/i);
assert.match(bodies.list_pipeline_human_reviews_operator, /list_pipeline_human_reviews_operator\(p_limit\s+integer\s+default\s+100\)\s+returns\s+jsonb/i);
assert.match(bodies.get_pipeline_human_review_operator_inspect, /get_pipeline_human_review_operator_inspect\(p_review_id\s+uuid\)\s+returns\s+jsonb/i);

assert.match(normalized, /revoke\s+all\s+on\s+function\s+public\.get_pipeline_human_review_operator_status\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/);
assert.match(normalized, /revoke\s+all\s+on\s+function\s+public\.list_pipeline_human_reviews_operator\(integer\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/);
assert.match(normalized, /revoke\s+all\s+on\s+function\s+public\.get_pipeline_human_review_operator_inspect\(uuid\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/);
for (const name of functionNames) {
  assert.match(normalized, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\s*\\([^;]*?\\)\\s+to\\s+service_role`, "i"), `${name} is executable only by the trusted server role`);
}
assert.doesNotMatch(normalized, /grant\s+(?:all|select)\s+on\s+table\s+public\.pipeline_human_reviews/i, "migration 32 does not grant direct table access");
assert.doesNotMatch(normalized, /grant\s+execute\s+on\s+function\s+public\.(?:get_pipeline_human_review_operator_status|list_pipeline_human_reviews_operator|get_pipeline_human_review_operator_inspect)[^;]*\s+to\s+(?:public|anon|authenticated)/i);
assert.match(normalized, /p_limit\s+is\s+null\s+or\s+p_limit\s*<\s*1\s+or\s+p_limit\s*>\s*500/);
assert.match(bodies.list_pipeline_human_reviews_operator, /order\s+by\s+r\.created_at\s+desc\s*,\s*r\.id\s+desc\s+limit\s+p_limit/i, "list uses bounded deterministic ordering");
assert.match(bodies.list_pipeline_human_reviews_operator, /errcode\s*=\s*'22023'\s*,\s*message\s*=\s*'human_review_operator_limit_invalid'/i);
assert.match(bodies.get_pipeline_human_review_operator_inspect, /errcode\s*=\s*'22023'\s*,\s*message\s*=\s*'human_review_operator_review_id_required'/i);
assert.match(bodies.list_pipeline_human_reviews_operator, /'eventid',\s*review_row\.event_key/i);
assert.match(bodies.list_pipeline_human_reviews_operator, /'review_manifest',\s*review_row\.review_manifest/i);
assert.match(bodies.list_pipeline_human_reviews_operator, /'source_lineage_sha256',\s*review_row\.source_lineage_sha256/i);
assert.doesNotMatch(bodies.list_pipeline_human_reviews_operator, /'source_lineage'\s*,|'decision_history'\s*,|'reviewer_id'\s*,|'uncertainty_preserved'\s*,|'body'\s*,|'headline'\s*,|'summary'\s*,|'why_it_matters'\s*,|'publication_payload'\s*,/i, "list omits full lineage, decision history, editorial bodies, and unneeded review details");
assert.doesNotMatch(bodies.list_pipeline_human_reviews_operator, /\b(?:body|headline|summary|why_it_matters|publication_payload)\b/i, "list omits article/review bodies; the operator binds the local immutable artifact");
assert.match(bodies.get_pipeline_human_review_operator_inspect, /'found',\s*v_review\s+is\s+not\s+null/i);
assert.match(migration31, /revoke\s+all\s+on\s+table\s+public\.pipeline_human_reviews\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/);
assert.doesNotMatch(migration31, /create(?:\s+or\s+replace)?\s+function\s+public\.(?:get_pipeline_human_review_operator_status|list_pipeline_human_reviews_operator|get_pipeline_human_review_operator_inspect)/i, "migration 31 has no operator read RPC");

const statusFields = ["utcDay", "asOfUtc", "totalReviews", "waitingReviews", "holdReviews", "rejectedReviews", "approvedReviews", "approveReviews", "publishingReviews", "publishedReviews", "consumedReviews", "candidatesToday", "attemptsToday", "awaitingReview", "held", "rejected", "approved", "consumed", "publishedToday", "failedToday", "groqRequests", "groqTokens", "groqUnknownUsage", "activeWork", "stuckWork"];
for (const field of statusFields) {
  assert.match(bodies.get_pipeline_human_review_operator_status, new RegExp(`'${field}'\\s*,`), `status SQL returns ${field}`);
  assert.match(statusParserSource, new RegExp(`\\b${field}:`), `strict status schema validates ${field}`);
}
for (const [rpc, argName] of [[functionNames[0], null], [functionNames[1], "p_limit"], [functionNames[2], "p_review_id"]]) {
  assert.match(readRepositorySource, new RegExp(`rpc\\(["']${rpc}["']`), `${rpc} is called by the runtime repository`);
  if (argName) assert.match(readRepositorySource, new RegExp(`\\b${argName}\\b`), `${rpc} argument name matches the SQL signature`);
}
assert.match(readRepositorySource, /const summaryRowSchema[\s\S]*?\.strict\(\)/);
assert.match(readRepositorySource, /const reviewRowSchema[\s\S]*?\.strict\(\)/);
assert.match(statusParserSource, /operatorStatusSchema\s*=\s*z\.object\([\s\S]*?\.strict\(\)/);

const status = {
  utcDay: "2026-10-07", asOfUtc: "2026-10-07T21:00:00.000Z",
  totalReviews: 5, waitingReviews: 1, holdReviews: 1, rejectedReviews: 1,
  approvedReviews: 1, approveReviews: 2, publishingReviews: 0, publishedReviews: 1, consumedReviews: 2,
  candidatesToday: 0, attemptsToday: 0, awaitingReview: 1, held: 1, rejected: 1,
  approved: 1, consumed: 2, publishedToday: 1, failedToday: 0, groqRequests: 3,
  groqTokens: 5387, groqUnknownUsage: 0, activeWork: 0, stuckWork: 0,
};
assert.deepEqual(parseHumanReviewOperatorStatus(status), status, "operator status accepts aggregate review and operational state");
const zeroStatus = Object.fromEntries(statusFields.map((key) => [key, key === "utcDay" ? "2026-10-07" : key === "asOfUtc" ? "2026-10-07T21:00:00.000Z" : 0]));
assert.deepEqual(parseHumanReviewOperatorStatus(zeroStatus), zeroStatus, "empty review status is valid and all counters are zero");
assert.throws(() => parseHumanReviewOperatorStatus({ ...zeroStatus, unexpected: 1 }), /STATUS_QUERY_INVALID/, "unknown status fields fail closed");
assert.throws(() => parseHumanReviewOperatorStatus({ ...zeroStatus, totalReviews: "0" }), /STATUS_QUERY_INVALID/, "numeric strings do not satisfy the strict RPC contract");

const sourceLineage = [{ source_id: "11111111-1111-4111-8111-111111111111", raw_item_id: "22222222-2222-4222-8222-222222222222", content_hash: "a".repeat(64), canonical_url: "https://example.test/story", source_url: "https://example.test/story" }];
const checkpointNames = ["verifier", "translator", "editor", "classifier", "ranker", "critic"];
const rowManifest = {
  schemaVersion: "1", packageSha256: "d".repeat(64),
  checkpoints: Object.fromEntries(checkpointNames.map((name) => [name, { identity: `synthetic-run:${name}:synthetic-event`, sha256: "e".repeat(64) }])),
  manifestSha256: "f".repeat(64), eventKey: "synthetic-event",
  attemptId: "44444444-4444-4444-8444-444444444444", pipelineRunId: "55555555-5555-4555-8555-555555555555",
  draftId: "synthetic-draft", draftSha256: "b".repeat(64), sourceLineageSha256: "a".repeat(64),
  publicationPayloadSha256: "c".repeat(64),
};
const baseRow = {
  id: "33333333-3333-4333-8333-333333333333", eventId: "synthetic-event", event_key: "synthetic-event",
  attempt_id: "44444444-4444-4444-8444-444444444444", pipeline_run_id: "55555555-5555-4555-8555-555555555555",
  draft_id: "synthetic-draft", draft_sha256: "b".repeat(64), source_lineage_sha256: "a".repeat(64), publication_payload_sha256: "c".repeat(64),
  source_lineage: sourceLineage,
  review_manifest: rowManifest,
  critic_pass: true, provider_usage_settled: true, status: "WAITING_FOR_HUMAN_REVIEW", action: null,
  reviewer_id: null, reviewer_approved: null, facts_acceptable: null, attribution_acceptable: null,
  uncertainty_preserved: null, headline_acceptable: null, summary_acceptable: null,
  no_unsupported_material_claims: null, source_chain_acceptable: null, reviewed_at: null,
  consumed_at: null, published_article_id: null, decision_history: [],
  created_at: "2026-10-07T20:00:00.000Z", updated_at: "2026-10-07T20:00:00.000Z",
};
const rows = [
  baseRow,
  { ...baseRow, id: "66666666-6666-4666-8666-666666666666", status: "HOLD", action: "HOLD" },
  { ...baseRow, id: "77777777-7777-4777-8777-777777777777", status: "REJECTED", action: "REJECT" },
  { ...baseRow, id: "88888888-8888-4888-8888-888888888888", status: "APPROVED", action: "APPROVE", reviewer_id: "reviewer-synthetic", reviewer_approved: true, facts_acceptable: true, attribution_acceptable: true, uncertainty_preserved: true, headline_acceptable: true, summary_acceptable: true, no_unsupported_material_claims: true, source_chain_acceptable: true, reviewed_at: "2026-10-07T20:30:00.000Z" },
  { ...baseRow, id: "99999999-9999-4999-8999-999999999999", status: "APPROVED", action: "APPROVE", reviewer_id: "reviewer-synthetic", reviewer_approved: true, facts_acceptable: true, attribution_acceptable: true, uncertainty_preserved: true, headline_acceptable: true, summary_acceptable: true, no_unsupported_material_claims: true, source_chain_acceptable: true, reviewed_at: "2026-10-07T20:30:00.000Z", consumed_at: "2026-10-07T20:45:00.000Z" },
  { ...baseRow, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "PUBLISHED", action: "APPROVE", reviewer_id: "reviewer-synthetic", reviewer_approved: true, facts_acceptable: true, attribution_acceptable: true, uncertainty_preserved: true, headline_acceptable: true, summary_acceptable: true, no_unsupported_material_claims: true, source_chain_acceptable: true, reviewed_at: "2026-10-07T20:30:00.000Z", consumed_at: "2026-10-07T20:45:00.000Z", published_article_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
];
function summaryOf(row) {
  const summary = { ...row };
  for (const field of ["source_lineage", "reviewer_id", "uncertainty_preserved", "headline_acceptable", "summary_acceptable", "no_unsupported_material_claims", "source_chain_acceptable", "decision_history"]) {
    delete summary[field];
  }
  return summary;
}
const summaries = rows.map((row) => parseHumanReviewOperatorList({ reviews: [summaryOf(row)], publishedToday: 1, returned: 1, limit: 10 }).reviews[0]);
const parsedRows = parseHumanReviewOperatorList({ reviews: summaries, publishedToday: 1, returned: summaries.length, limit: 10 });
assert.equal(parsedRows.reviews.length, 6);
const fixtureArtifact = {
  draft: { headlineEs: "Titular sintético", summaryEs: "Resumen sintético", whyItMattersEs: "Importancia sintética", bodyEs: "Cuerpo sintético" },
  publicationPayload: { sources: [{ sourceName: "Fuente sintética", url: "https://example.test/story" }] },
  reviewEvidence: {
    verifier: { uncertainClaims: [] }, attributionStatus: "PASS", uncertaintyStatus: "PASS",
    critic: { decision: "pass", issues: [], unsupportedClaims: [] }, classifier: {}, ranking: {}, geo: {}, providerAccounting: {},
  },
  sourceLineage, checkpoints: {}, reviewManifest: { manifestSha256: "e".repeat(64), checkpoints: {} },
};
const entries = parsedRows.reviews.map((row) => buildHumanReviewListEntry(row, fixtureArtifact));
assert.deepEqual(entries.map(({ status, action }) => [status, action]), [
  ["WAITING_FOR_HUMAN_REVIEW", null], ["HOLD", "HOLD"], ["REJECTED", "REJECT"],
  ["APPROVED", "APPROVE"], ["APPROVED", "APPROVE"], ["PUBLISHED", "APPROVE"],
]);
assert.equal(entries[0].factualReviewState, null);
assert.equal(entries[3].factualReviewState, true);
assert.equal(entries[4].consumedAt, "2026-10-07T20:45:00.000Z", "consumed approval is explicit in operator output");
assert.equal(entries[5].publishedArticleId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const populatedInspection = parseHumanReviewOperatorInspection({ found: true, review: baseRow, publishedToday: 1 });
const inspection = buildHumanReviewInspection(populatedInspection.review, fixtureArtifact, "PASS");
assert.equal(inspection.headline, "Titular sintético");
assert.equal(inspection.body, "Cuerpo sintético");
assert.equal(inspection.publicationPayload.sources[0].url, "https://example.test/story");
for (const key of ["verifier", "attribution", "uncertainty", "critic", "classification", "regionGeo", "ranking", "providerAccounting", "reviewManifest", "review"]) assert.ok(key in inspection, `inspect package includes ${key}`);

assert.deepEqual(parseHumanReviewOperatorList({ reviews: [], publishedToday: 0, returned: 0, limit: 500 }).reviews, [], "empty operator list is valid");
assert.deepEqual(parseHumanReviewOperatorInspection({ found: false, review: null, publishedToday: 0 }), { found: false, review: null, publishedToday: 0 }, "missing inspect returns typed not-found data");
assert.throws(() => parseHumanReviewOperatorInspection({ found: true, review: null, publishedToday: 0 }), /INSPECT_INVALID/);

const rpcCalls = [];
const fakeResponses = {
  get_pipeline_human_review_operator_status: status,
  list_pipeline_human_reviews_operator: { reviews: [], publishedToday: 0, returned: 0, limit: 5 },
  get_pipeline_human_review_operator_inspect: { found: false, review: null, publishedToday: 0 },
};
const fakeSupabase = {
  async rpc(name, args) {
    rpcCalls.push({ name, args });
    return { data: fakeResponses[name], error: null };
  },
};
const repository = new SupabaseHumanReviewReadRepository(fakeSupabase);
await repository.status();
assert.deepEqual((await repository.list(5)).reviews, []);
assert.equal((await repository.inspect("33333333-3333-4333-8333-333333333333")).found, false);
await assert.rejects(repository.list(501), /HUMAN_REVIEW_OPERATOR_LIMIT_INVALID/, "runtime refuses list limits above the SQL maximum before RPC dispatch");
await assert.rejects(repository.inspect("not-a-uuid"), /HUMAN_REVIEW_ID_MUST_BE_UUID/, "runtime rejects malformed inspect IDs before RPC dispatch");
fakeResponses.get_pipeline_human_review_operator_inspect = { found: true, review: baseRow, publishedToday: 1 };
assert.equal((await repository.inspect("33333333-3333-4333-8333-333333333333")).review.status, "WAITING_FOR_HUMAN_REVIEW");
assert.deepEqual(rpcCalls, [
  { name: "get_pipeline_human_review_operator_status", args: {} },
  { name: "list_pipeline_human_reviews_operator", args: { p_limit: 5 } },
  { name: "get_pipeline_human_review_operator_inspect", args: { p_review_id: "33333333-3333-4333-8333-333333333333" } },
  { name: "get_pipeline_human_review_operator_inspect", args: { p_review_id: "33333333-3333-4333-8333-333333333333" } },
]);
const forbiddenRepository = new SupabaseHumanReviewReadRepository({
  async rpc() { return { data: null, error: { code: "42501", message: "human_review_operator_read_forbidden" } }; },
});
await assert.rejects(forbiddenRepository.status(), /HUMAN_REVIEW_OPERATOR_READ_FORBIDDEN/, "authorization SQLSTATE maps to a safe runtime error");

assert.match(operatorCli, /new\s+SupabaseHumanReviewReadRepository\(createSupabaseServerClient\(\)\)/);
assert.match(operatorCli, /async function readRemoteReviews[\s\S]*?repository\.list\(500\)/);
assert.match(operatorCli, /repository\.inspect\(reviewId\)|\.inspect\(reviewId\)/);
assert.doesNotMatch(operatorCli, /supabase\s+db\s+query|execFile|child_process|\.from\(["']pipeline_human_reviews["']\)/i, "operator read path uses the trusted PostgREST RPC helper, not CLI SQL or direct table SELECT");

console.log("Human-review migration 32 operator read-path and populated-state fixtures passed");
