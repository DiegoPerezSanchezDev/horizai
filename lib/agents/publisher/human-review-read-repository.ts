import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "../../../types/database.ts";
import { createSupabaseServerClient } from "../../supabase/server-client.ts";
import type { HumanReviewArtifact } from "./human-review.ts";
import { parseHumanReviewOperatorStatus, type HumanReviewOperatorStatus } from "./human-review-status.ts";

const reviewStatuses = ["WAITING_FOR_HUMAN_REVIEW", "APPROVED", "HOLD", "REJECTED", "PUBLISHING", "PUBLISHED"] as const;
const actionStatuses = ["APPROVE", "HOLD", "REJECT"] as const;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const checkpointHashSchema = z.object({ identity: z.string().min(1), sha256: digestSchema }).strict();
const sourceLineageSchema = z.array(z.object({
  source_id: z.string().uuid(),
  raw_item_id: z.string().uuid(),
  content_hash: z.string().min(8),
  canonical_url: z.string().url(),
  source_url: z.string().url(),
}).strict()).min(1).max(100);
const reviewManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  packageSha256: digestSchema,
  checkpoints: z.object({
    verifier: checkpointHashSchema,
    translator: checkpointHashSchema,
    editor: checkpointHashSchema,
    classifier: checkpointHashSchema,
    ranker: checkpointHashSchema,
    critic: checkpointHashSchema,
  }).strict(),
  manifestSha256: digestSchema,
  eventKey: z.string().min(1),
  attemptId: z.string().uuid(),
  pipelineRunId: z.string().uuid(),
  draftId: z.string().min(1),
  draftSha256: digestSchema,
  sourceLineageSha256: digestSchema,
  publicationPayloadSha256: digestSchema,
}).strict();

export type HumanReviewOperatorManifest = z.infer<typeof reviewManifestSchema>;

export type HumanReviewOperatorSummaryRow = {
  id: string;
  eventId: string;
  event_key: string;
  attempt_id: string;
  pipeline_run_id: string;
  draft_id: string;
  draft_sha256: string;
  source_lineage_sha256: string;
  publication_payload_sha256: string;
  approval_target_kind: "ORIGINAL" | "HUMAN_REVISION";
  approval_target_revision_id: string | null;
  approval_target_revision_sha256: string | null;
  approved_revision_sha256: string | null;
  review_manifest: HumanReviewOperatorManifest;
  critic_pass: boolean;
  provider_usage_settled: boolean;
  status: (typeof reviewStatuses)[number];
  action: (typeof actionStatuses)[number] | null;
  reviewer_approved: boolean | null;
  facts_acceptable: boolean | null;
  attribution_acceptable: boolean | null;
  reviewed_at: string | null;
  consumed_at: string | null;
  published_article_id: string | null;
  created_at: string;
  updated_at: string;
};

export type HumanReviewOperatorReadRow = HumanReviewOperatorSummaryRow & {
  source_lineage: HumanReviewArtifact["sourceLineage"];
  reviewer_id: string | null;
  uncertainty_preserved: boolean | null;
  headline_acceptable: boolean | null;
  summary_acceptable: boolean | null;
  no_unsupported_material_claims: boolean | null;
  source_chain_acceptable: boolean | null;
  decision_history: unknown[];
};

export type HumanReviewOperatorList = {
  reviews: HumanReviewOperatorSummaryRow[];
  publishedToday: number;
  returned: number;
  limit: number;
};

export type HumanReviewOperatorInspection = {
  found: boolean;
  review: HumanReviewOperatorReadRow | null;
  publishedToday: number;
};

const summaryRowSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().min(1),
  event_key: z.string().min(1),
  attempt_id: z.string().uuid(),
  pipeline_run_id: z.string().uuid(),
  draft_id: z.string().min(1),
  draft_sha256: digestSchema,
  source_lineage_sha256: digestSchema,
  publication_payload_sha256: digestSchema,
  approval_target_kind: z.enum(["ORIGINAL", "HUMAN_REVISION"]).default("ORIGINAL"),
  approval_target_revision_id: z.string().uuid().nullable().default(null),
  approval_target_revision_sha256: digestSchema.nullable().default(null),
  approved_revision_sha256: digestSchema.nullable().default(null),
  review_manifest: reviewManifestSchema,
  critic_pass: z.boolean(),
  provider_usage_settled: z.boolean(),
  status: z.enum(reviewStatuses),
  action: z.enum(actionStatuses).nullable(),
  reviewer_approved: z.boolean().nullable(),
  facts_acceptable: z.boolean().nullable(),
  attribution_acceptable: z.boolean().nullable(),
  reviewed_at: z.string().datetime({ offset: true }).nullable(),
  consumed_at: z.string().datetime({ offset: true }).nullable(),
  published_article_id: z.string().uuid().nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
}).strict().superRefine((row, context) => {
  const expectedAction = row.status === "HOLD" ? "HOLD"
    : row.status === "REJECTED" ? "REJECT"
      : ["APPROVED", "PUBLISHING", "PUBLISHED"].includes(row.status) ? "APPROVE" : null;
  if (row.action !== expectedAction) context.addIssue({ code: "custom", message: "HUMAN_REVIEW_OPERATOR_ACTION_STATUS_MISMATCH" });
  if (row.eventId !== row.event_key || row.review_manifest.eventKey !== row.event_key
    || row.review_manifest.attemptId !== row.attempt_id || row.review_manifest.pipelineRunId !== row.pipeline_run_id
    || row.review_manifest.draftId !== row.draft_id || row.review_manifest.draftSha256 !== row.draft_sha256
    || row.review_manifest.sourceLineageSha256 !== row.source_lineage_sha256
    || row.review_manifest.publicationPayloadSha256 !== row.publication_payload_sha256) {
    context.addIssue({ code: "custom", message: "HUMAN_REVIEW_OPERATOR_ROW_BINDING_MISMATCH" });
  }
  if ((row.approval_target_kind === "ORIGINAL" && (row.approval_target_revision_id !== null || row.approval_target_revision_sha256 !== null || row.approved_revision_sha256 !== null))
    || (row.approval_target_kind === "HUMAN_REVISION" && (!row.approval_target_revision_id || !row.approval_target_revision_sha256
      || (["APPROVED", "PUBLISHING", "PUBLISHED"].includes(row.status) ? row.approved_revision_sha256 !== row.approval_target_revision_sha256 : row.approved_revision_sha256 !== null)))) {
    context.addIssue({ code: "custom", message: "HUMAN_REVIEW_OPERATOR_REVISION_BINDING_INVALID" });
  }
});

const reviewRowSchema = summaryRowSchema.extend({
  source_lineage: sourceLineageSchema,
  reviewer_id: z.string().nullable(),
  uncertainty_preserved: z.boolean().nullable(),
  headline_acceptable: z.boolean().nullable(),
  summary_acceptable: z.boolean().nullable(),
  no_unsupported_material_claims: z.boolean().nullable(),
  source_chain_acceptable: z.boolean().nullable(),
  decision_history: z.array(z.unknown()),
}).strict().superRefine((row, context) => {
  if (row.source_lineage.length === 0) context.addIssue({ code: "custom", message: "HUMAN_REVIEW_OPERATOR_SOURCE_LINEAGE_EMPTY" });
});

const listSchema = z.object({
  reviews: z.array(summaryRowSchema),
  publishedToday: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(500),
}).strict().superRefine((value, context) => {
  if (value.returned !== value.reviews.length || value.reviews.length > value.limit) {
    context.addIssue({ code: "custom", message: "HUMAN_REVIEW_OPERATOR_LIST_INVALID" });
  }
});

const inspectSchema = z.object({
  found: z.boolean(),
  review: reviewRowSchema.nullable(),
  publishedToday: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.found !== (value.review !== null)) context.addIssue({ code: "custom", message: "HUMAN_REVIEW_OPERATOR_INSPECT_INVALID" });
});

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new Error("HUMAN_REVIEW_OPERATOR_RESPONSE_INVALID_JSON"); }
}

function rpcFailure(error: { code?: string; message: string } | null, operation: string): never {
  if (error?.code === "42501" || /human_review_operator_read_forbidden/i.test(error?.message ?? "")) {
    throw new Error("HUMAN_REVIEW_OPERATOR_READ_FORBIDDEN");
  }
  throw new Error(`HUMAN_REVIEW_OPERATOR_${operation}_FAILED:${error?.code ?? "UNKNOWN"}`);
}

export function parseHumanReviewOperatorList(value: unknown): HumanReviewOperatorList {
  const parsed = listSchema.safeParse(parseJson(value));
  if (!parsed.success) throw new Error("HUMAN_REVIEW_OPERATOR_LIST_INVALID");
  return parsed.data;
}

export function parseHumanReviewOperatorInspection(value: unknown): HumanReviewOperatorInspection {
  const parsed = inspectSchema.safeParse(parseJson(value));
  if (!parsed.success) throw new Error("HUMAN_REVIEW_OPERATOR_INSPECT_INVALID");
  return parsed.data;
}

export class SupabaseHumanReviewReadRepository {
  private readonly supabase: SupabaseClient<Database>;

  constructor(supabase: SupabaseClient<Database> = createSupabaseServerClient()) {
    this.supabase = supabase;
  }

  async status(): Promise<HumanReviewOperatorStatus> {
    const response = await this.supabase.rpc("get_pipeline_human_review_operator_status", {});
    if (response.error) rpcFailure(response.error, "STATUS");
    return parseHumanReviewOperatorStatus(response.data);
  }

  async list(limit = 500): Promise<HumanReviewOperatorList> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("HUMAN_REVIEW_OPERATOR_LIMIT_INVALID");
    const response = await this.supabase.rpc("list_pipeline_human_reviews_operator", { p_limit: limit });
    if (response.error) rpcFailure(response.error, "LIST");
    return parseHumanReviewOperatorList(response.data);
  }

  async inspect(reviewId: string): Promise<HumanReviewOperatorInspection> {
    if (!z.string().uuid().safeParse(reviewId).success) throw new Error("HUMAN_REVIEW_ID_MUST_BE_UUID");
    const response = await this.supabase.rpc("get_pipeline_human_review_operator_inspect", { p_review_id: reviewId });
    if (response.error) rpcFailure(response.error, "INSPECT");
    return parseHumanReviewOperatorInspection(response.data);
  }
}
