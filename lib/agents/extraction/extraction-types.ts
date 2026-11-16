import type { DiscoveryCandidate, ExtractedItem, ExtractionQuality } from "../contracts/index.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/database.ts";
import type { RawItemTraceability } from "../ingestion/raw-item-repository.ts";

export type ExtractionResultStatus = "success" | "blocked" | "failed";
export type ExtractionFetchOutcome = "succeeded" | "blocked" | "failed" | "metadata_fallback" | "not_attempted";
export type ExtractionParserOutcome = "succeeded" | "failed" | "not_reached";
export type ExtractionRawItemMappingOutcome = "created" | "updated" | "reused" | "failed" | "not_requested";

export type ExtractionError = {
  code: string;
  message: string;
  statusCode?: number;
};

export type ExtractionResult = {
  candidate: DiscoveryCandidate;
  status: ExtractionResultStatus;
  quality: ExtractionQuality;
  item: ExtractedItem | null;
  contentLength: number;
  error: ExtractionError | null;
  durationMs: number;
  rawItemId: string | null;
  /** Explicit safe lifecycle fields; optional for historical/offline fixtures. */
  attempted?: boolean;
  fetchOutcome?: ExtractionFetchOutcome;
  parserOutcome?: ExtractionParserOutcome;
  rawItemMappingOutcome?: ExtractionRawItemMappingOutcome;
  rawItemUpdated?: boolean;
};

export type ExtractionRunOptions = {
  hours: number;
  limit: number;
  persist: boolean;
  now?: Date;
  timeoutMs?: number;
  concurrency?: number;
  supabase?: SupabaseClient<Database>;
};

export type ExtractionRunResult = {
  startedAt: string;
  finishedAt: string;
  hours: number;
  limit: number;
  candidatesSelected: number;
  results: ExtractionResult[];
  full: number;
  partial: number;
  metadataOnly: number;
  blocked: number;
  failed: number;
  averageContentLength: number;
  persisted: number;
  /** Existing raw_items rows updated by the extraction write phase. */
  persistUpdated?: number;
  persistSkipped: number;
  persistErrors: number;
  traceability: RawItemTraceability[];
  freshness?: import("./freshness-policy.ts").ExtractionFreshnessSummary;
};
