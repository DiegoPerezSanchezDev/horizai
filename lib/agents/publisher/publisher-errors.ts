export type PublisherErrorCode =
  | "publication_not_approved"
  | "publication_lineage_mismatch"
  | "publication_invalid_category"
  | "publication_invalid_region"
  | "publication_ranking_mismatch"
  | "publication_idempotency_conflict"
  | "publication_transaction_failed"
  | "publication_missing_event"
  | "publication_missing_source"
  | "publication_missing_raw_item"
  | "publication_source_traceability_missing"
  | "publication_invalid_geo"
  | "publication_missing_validation_context";

export class PublisherError extends Error {
  readonly code: PublisherErrorCode;

  constructor(code: PublisherErrorCode, message: string) {
    super(message);
    this.name = "PublisherError";
    this.code = code;
  }
}

export function publisherErrorSummary(error: unknown): { code: string; message: string } {
  if (error instanceof PublisherError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "publication_transaction_failed", message: "Publisher operation failed" };
  return { code: "publication_transaction_failed", message: "Publisher operation failed" };
}
