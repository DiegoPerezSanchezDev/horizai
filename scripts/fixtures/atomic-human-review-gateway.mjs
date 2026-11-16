/** Offline equivalent of create_pipeline_human_review's atomic completion.
 * No Supabase client, provider, files, or real review creation is involved.
 */
export function atomicHumanReviewGateway(registry, onCreate = () => {}) {
  return { async createReview(input) {
    const target = registry.snapshot().find((row) => row.id === input.attemptId);
    if (!target || target.completedAt !== null || target.finalState !== null) throw new Error("human_review_attempt_not_waiting");
    await registry.finalize({ attemptId: input.attemptId, pipelineRunId: input.run.runId,
      completedAt: new Date().toISOString(), finalState: "WAITING_FOR_HUMAN_REVIEW",
      stopStage: "human_review", stopReason: "HUMAN_REVIEW_PENDING", retryClass: "NONE",
      countsTowardRetryLimit: false, nextEligibleAt: null });
    onCreate(input);
    return { reviewId: "synthetic-review", packageSha256: "a".repeat(64) };
  } };
}
