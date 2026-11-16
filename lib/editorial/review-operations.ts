import "server-only";
import { resolve } from "node:path";
import { SupabaseSchedulerRepository } from "../agents/pipeline/scheduler/scheduler-repository.ts";
import { SupabaseHumanReviewReadRepository } from "../agents/publisher/human-review-read-repository.ts";
import { SupabaseHumanReviewRepository } from "../agents/publisher/human-review-repository.ts";
import { createHumanReviewOperations, type HumanReviewOperations } from "../agents/publisher/human-review-operations.ts";
import { createSupabaseServerClient } from "../supabase/server-client.ts";

/**
 * Server-side wiring of the shared human-review operations for the editorial panel. Same module, same rules and
 * same artifact/checkpoint roots as the `pipeline:human-review` CLI. The privileged client never leaves the server.
 */
export function createEditorialReviewOperations(): HumanReviewOperations {
  const client = createSupabaseServerClient({ privateNoStore: true });
  return createHumanReviewOperations({
    readRepository: new SupabaseHumanReviewReadRepository(client),
    decisionRepository: new SupabaseHumanReviewRepository(client),
    scheduler: new SupabaseSchedulerRepository(client),
    artifactRoot: resolve(process.cwd(), process.env.HUMAN_REVIEW_ARTIFACT_ROOT?.trim() || "artifacts/human-review-packages"),
    checkpointRoot: resolve(process.cwd(), process.env.HUMAN_REVIEW_CHECKPOINT_ROOT?.trim() || "artifacts/pipeline-checkpoints"),
  });
}
