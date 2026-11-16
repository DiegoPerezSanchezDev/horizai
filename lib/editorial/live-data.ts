import "server-only";
import { resolve } from "node:path";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../types/database.ts";
import { readHumanReviewArtifact, verifyHumanReviewArtifact } from "../agents/publisher/human-review.ts";
import { SupabaseHumanReviewReadRepository, type HumanReviewOperatorSummaryRow } from "../agents/publisher/human-review-read-repository.ts";
import { humanReviewRevisionRecordSchema } from "../agents/publisher/human-review-revision.ts";
import { createSupabaseServerClient } from "../supabase/server-client.ts";
import { requireEditorialOperator } from "../editorial-auth/server.ts";
import { EditorialLiveDataError } from "./live-mapping.ts";
import { getEditorialReviewDetailWith, listActionableQueuesWith, listWaitingEditorialReviewsWith } from "./live-service.ts";
export { EditorialLiveDataError } from "./live-mapping.ts";
import type { EditorialReviewDetail } from "./review.ts";

type Client = SupabaseClient<Database>;
const uuidSchema = z.string().uuid();

async function requireLiveReadAccess(): Promise<void> {
  await requireEditorialOperator();
  if (process.env.EDITORIAL_LIVE_DATA_ENABLED !== "true") throw new EditorialLiveDataError("M32_UNAVAILABLE");
}

function artifactRoot(): string {
  const configured = process.env.HUMAN_REVIEW_ARTIFACT_ROOT?.trim();
  return resolve(process.cwd(), configured || "artifacts/human-review-packages");
}

function revisionFromRpc(value: Json): unknown {
  let parsedValue: unknown = value;
  if (typeof value === "string") {
    try { parsedValue = JSON.parse(value) as unknown; }
    catch { throw new EditorialLiveDataError("M32_UNAVAILABLE"); }
  }
  const result = z.object({ found: z.boolean(), revision: z.unknown().nullable() }).strict().safeParse(parsedValue);
  if (!result.success || !result.data.found || result.data.revision === null) throw new EditorialLiveDataError("REVIEW_INVALID");
  const revision = humanReviewRevisionRecordSchema.safeParse(result.data.revision);
  if (!revision.success) throw new EditorialLiveDataError("REVIEW_INVALID");
  return revision.data;
}

async function readRevision(client: Client, reviewId: string): Promise<unknown> {
  const response = await client.rpc("get_pipeline_human_review_revision", { p_review_id: reviewId });
  if (response.error) throw new EditorialLiveDataError("M32_UNAVAILABLE");
  return revisionFromRpc(response.data);
}

async function readPackage(row: HumanReviewOperatorSummaryRow) {
  const artifact = await readHumanReviewArtifact(artifactRoot(), row.attempt_id);
  if (!verifyHumanReviewArtifact(artifact)) throw new EditorialLiveDataError("REVIEW_INVALID");
  return artifact;
}

export async function listWaitingEditorialReviews() {
  await requireLiveReadAccess();
  const client = createSupabaseServerClient({ privateNoStore: true });
  return listWaitingEditorialReviewsWith({
    repository: new SupabaseHumanReviewReadRepository(client),
    readArtifact: readPackage,
    readRevision: (reviewId) => readRevision(client, reviewId),
  });
}

/** HOLD and APPROVED reviews still open to action (re-decide or publish). Read-only, same boundary as the inbox. */
export async function listActionableEditorialQueues() {
  await requireLiveReadAccess();
  const client = createSupabaseServerClient({ privateNoStore: true });
  return listActionableQueuesWith({
    repository: new SupabaseHumanReviewReadRepository(client),
    readArtifact: readPackage,
    readRevision: (reviewId) => readRevision(client, reviewId),
  });
}

export async function getEditorialReviewDetail(reviewId: string): Promise<EditorialReviewDetail> {
  await requireLiveReadAccess();
  if (!uuidSchema.safeParse(reviewId).success) throw new EditorialLiveDataError("REVIEW_NOT_FOUND");
  const client = createSupabaseServerClient({ privateNoStore: true });
  return getEditorialReviewDetailWith(reviewId, {
    repository: new SupabaseHumanReviewReadRepository(client),
    readArtifact: readPackage,
    readRevision: (id) => readRevision(client, id),
  });
}
