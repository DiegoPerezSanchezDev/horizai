import type { HumanReviewOperations } from "../agents/publisher/human-review-operations.ts";
import { humanReviewChecksFromVerdicts } from "../agents/publisher/human-review-operations.ts";
import { mapEditorialDecisionError, type EditorialDecisionCommand, type EditorialDecisionOutcome } from "./decision-policy.ts";

const approvedOutcome = { approve: "approved", approve_publish: "published", hold: "held", reject: "rejected" } as const;

/**
 * Runs a parsed command through the shared human-review operations (the same ones the CLI uses).
 * The reviewer identity is the verified operator email from the session, never a form value.
 */
export async function executeEditorialDecision(
  command: EditorialDecisionCommand,
  operatorEmail: string,
  operations: Pick<HumanReviewOperations, "decide" | "publishApproved">,
): Promise<EditorialDecisionOutcome> {
  try {
    if (command.action === "publish") {
      await operations.publishApproved(command.items.map((item) => item.reviewId), command.items.map((item) => item.expectedPackageSha256));
      return "published";
    }
    await operations.decide({
      reviewId: command.reviewId,
      decision: command.action === "approve_publish" || command.action === "approve" ? "APPROVE" : command.action === "hold" ? "HOLD" : "REJECT",
      reviewerId: operatorEmail,
      expectedPackageSha256: command.expectedPackageSha256,
      checks: humanReviewChecksFromVerdicts(command.checks),
      // The panel always carries the revision hash of a corrected target; only an approval consumes it.
      expectedRevisionSha256: command.action === "approve_publish" || command.action === "approve" ? command.expectedRevisionSha256 : undefined,
    });
    if (command.action === "approve_publish") {
      try {
        await operations.publishApproved([command.reviewId], [command.expectedPackageSha256]);
      } catch {
        // The approval is durable; publication may have crossed its atomic write before a later error.
        // Ask the operator to refresh and inspect state instead of encouraging a blind retry.
        return "approved_publish_failed";
      }
    }
    return approvedOutcome[command.action];
  } catch (error) {
    return mapEditorialDecisionError(error);
  }
}
