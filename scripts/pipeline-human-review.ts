import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SupabaseHumanReviewRepository, type HumanReviewChecks, type HumanReviewDecision } from "../lib/agents/publisher/human-review-repository.ts";
import { readHumanReviewArtifact } from "../lib/agents/publisher/human-review.ts";
import { SupabaseSchedulerRepository } from "../lib/agents/pipeline/scheduler/scheduler-repository.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { SupabaseHumanReviewReadRepository, type HumanReviewOperatorSummaryRow } from "../lib/agents/publisher/human-review-read-repository.ts";
import { buildHumanReviewInspection, buildHumanReviewListEntry } from "../lib/agents/publisher/human-review-operator.ts";
import type { HumanReviewOperatorStatus } from "../lib/agents/publisher/human-review-status.ts";
import {
  assertRowArtifactMatch, createHumanReviewOperations, humanReviewCheckNames, humanReviewChecksFromVerdicts, manifestPackageSha,
  parseExpectedPackageSha256, parseHumanReviewId, type HumanReviewCheckName, type HumanReviewOperations,
} from "../lib/agents/publisher/human-review-operations.ts";

// Decision and publication rules live in lib/agents/publisher/human-review-operations.ts and are shared
// with the authenticated editorial panel, so both surfaces apply exactly the same checks.
export { assertRowArtifactMatch };

type RemoteReviewSnapshot = { reviews: HumanReviewOperatorSummaryRow[]; publishedToday: number };

function parseFlags(argv: readonly string[]): { positional: string[]; flags: Map<string, string[]> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const equals = arg.indexOf("=");
    if (equals < 3) throw new Error(`EXPECTED_FLAG_VALUE:${arg}`);
    const name = arg.slice(2, equals);
    const value = arg.slice(equals + 1);
    const list = flags.get(name) ?? [];
    list.push(value);
    flags.set(name, list);
  }
  return { positional, flags };
}

function oneFlag(flags: Map<string, string[]>, name: string): string {
  const values = flags.get(name);
  if (!values || values.length !== 1 || !values[0]?.trim()) throw new Error(`REQUIRED_FLAG:--${name}=...`);
  return values[0].trim();
}

const uuid = parseHumanReviewId;
const manifestSha = parseExpectedPackageSha256;

async function readRemoteReviews(): Promise<RemoteReviewSnapshot> {
  const repository = new SupabaseHumanReviewReadRepository(createSupabaseServerClient());
  const list = await repository.list(500);
  return { reviews: list.reviews, publishedToday: list.publishedToday };
}

async function readOperatorStatus(): Promise<HumanReviewOperatorStatus> {
  return new SupabaseHumanReviewReadRepository(createSupabaseServerClient()).status();
}

function operations(): HumanReviewOperations {
  const supabase = createSupabaseServerClient();
  return createHumanReviewOperations({
    readRepository: new SupabaseHumanReviewReadRepository(supabase),
    decisionRepository: new SupabaseHumanReviewRepository(supabase),
    scheduler: new SupabaseSchedulerRepository(supabase),
    artifactRoot: process.env.HUMAN_REVIEW_ARTIFACT_ROOT?.trim() || "artifacts/human-review-packages",
    checkpointRoot: process.env.HUMAN_REVIEW_CHECKPOINT_ROOT?.trim() || "artifacts/pipeline-checkpoints",
  });
}

function checksFromFlags(flags: Map<string, string[]>): HumanReviewChecks {
  const verdicts = {} as Record<HumanReviewCheckName, boolean>;
  for (const name of humanReviewCheckNames) {
    const value = oneFlag(flags, name);
    if (value !== "pass" && value !== "fail") throw new Error(`CHECK_MUST_BE_PASS_OR_FAIL:--${name}`);
    verdicts[name] = value === "pass";
  }
  return humanReviewChecksFromVerdicts(verdicts);
}

function printHelp(): void {
  console.log([
    "Human review operator (server-side only)",
    "  status",
    "  list",
    "  inspect <review-uuid>",
    "  approve|hold|reject <review-uuid> --reviewer=<id> --expected-package-sha256=<sha256> --facts=pass|fail --attribution=pass|fail --uncertainty=pass|fail --headline=pass|fail --summary=pass|fail --unsupported-claims=pass|fail --source-chain=pass|fail",
    "  publish-approved <review-uuid>[,<review-uuid>] --expected-package-sha256=<sha256>[,<sha256>]",
    "Publication is separately capped at two per UTC day; a single command owns the daily lease.",
  ].join("\n"));
}

async function publishApproved(idsArg: string, hashesArg: string): Promise<void> {
  await operations().publishApproved(idsArg.split(","), hashesArg.split(","), (published) => {
    console.log(JSON.stringify({ reviewId: published.reviewId, status: "PUBLISHED", articleId: published.articleId }, null, 2));
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") { printHelp(); return; }
  if (command === "status") {
    if (rest.length) throw new Error("USAGE:status");
    console.log(JSON.stringify(await readOperatorStatus(), null, 2));
    return;
  }
  if (command === "list") {
    if (rest.length) throw new Error("USAGE:list");
    const snapshot = await readRemoteReviews();
    const reviews = await Promise.all(snapshot.reviews.map(async (row) => {
      try {
        const artifactRoot = process.env.HUMAN_REVIEW_ARTIFACT_ROOT?.trim() || "artifacts/human-review-packages";
        const artifact = await readHumanReviewArtifact(artifactRoot, row.attempt_id);
        assertRowArtifactMatch(row, artifact, manifestPackageSha(row));
        return buildHumanReviewListEntry(row, artifact);
      } catch {
        return { event: row.event_key, attempt: row.attempt_id, status: row.status, createdAt: row.created_at, packageIntegrity: "UNAVAILABLE_OR_STALE" };
      }
    }));
    console.log(JSON.stringify({ reviews, publishedTodayUtc: snapshot.publishedToday, note: "List includes at most the latest 500 reviews." }, null, 2));
    return;
  }
  if (command === "inspect") {
    if (rest.length !== 1) throw new Error("USAGE:inspect <review-uuid>");
    const id = uuid(rest[0]!);
    const supabase = createSupabaseServerClient();
    const inspection = await new SupabaseHumanReviewReadRepository(supabase).inspect(id);
    const row = inspection.review;
    if (!inspection.found || !row) throw new Error("HUMAN_REVIEW_NOT_FOUND");
    const shared = operations();
    const artifact = await shared.loadArtifactBoundToRow(row);
    assertRowArtifactMatch(row, artifact, manifestPackageSha(row));
    let currentCheckpoints: "PASS" | "STALE" = "PASS";
    try { await shared.assertCurrentCheckpoints(artifact); } catch { currentCheckpoints = "STALE"; }
    const revision = row.approval_target_kind === "HUMAN_REVISION"
      ? await new SupabaseHumanReviewRepository(supabase).getRevision(row.id)
      : undefined;
    console.log(JSON.stringify(buildHumanReviewInspection(row, artifact, currentCheckpoints, revision && {
      corrected_draft: revision.corrected_draft, human_revision_proof: revision.human_revision_proof,
    }), null, 2));
    return;
  }
  if (["approve", "hold", "reject"].includes(command)) {
    const parsed = parseFlags(rest);
    if (parsed.positional.length !== 1) throw new Error(`USAGE:${command} <review-uuid> plus reviewer, exact package sha, and all seven check flags`);
    const id = uuid(parsed.positional[0]!);
    const { flags } = parsed;
    const reviewerId = oneFlag(flags, "reviewer");
    const expectedPackageSha256 = manifestSha(oneFlag(flags, "expected-package-sha256"));
    const checks = checksFromFlags(flags);
    const decision = command.toUpperCase() as HumanReviewDecision;
    const result = await operations().decide({
      reviewId: id, decision, reviewerId, expectedPackageSha256, checks,
      expectedRevisionSha256: flags.has("expected-revision-sha256") ? oneFlag(flags, "expected-revision-sha256") : undefined,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "publish-approved") {
    const parsed = parseFlags(rest);
    if (parsed.positional.length !== 1) throw new Error("USAGE:publish-approved <review-uuid>[,<review-uuid>] --expected-package-sha256=<sha>[,<sha>]");
    await publishApproved(parsed.positional[0]!, oneFlag(parsed.flags, "expected-package-sha256"));
    return;
  }
  throw new Error(`UNKNOWN_HUMAN_REVIEW_COMMAND:${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "HUMAN_REVIEW_COMMAND_FAILED");
  process.exitCode = 1;
});
