import type { DiscoveryCandidate } from "../contracts/index.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/database.ts";
import type { RawItemPersistenceOutcome, RawItemTraceability } from "../ingestion/raw-item-repository.ts";

export type DiscoveryMethod = "rss" | "atom" | "html" | "api" | "manual";

export type SourceRegistryEntry = {
  id: string;
  name: string;
  url: string;
  feedUrl: string | null;
  discoveryMethod: DiscoveryMethod;
  sourceType: string;
  countryCode: string | null;
  language: string;
  priority: number;
};

export type ParsedFeedItem = {
  externalId: string | null;
  url: string | null;
  title: string | null;
  excerpt: string | null;
  publishedAt: string | null;
  dateReliable: boolean;
};

export type CandidateRecord = {
  candidate: DiscoveryCandidate;
  canonicalUrl: string;
  contentHash: string | null;
};

export type SourceResultStatus = "success" | "timeout" | "parse_error" | "http_error" | "empty";

export type SourceDiscoveryResult = {
  source: SourceRegistryEntry;
  status: SourceResultStatus;
  discovered: number;
  valid: number;
  invalid: number;
  undatedExcluded: number;
  error: { code: string; message: string; statusCode?: number } | null;
  durationMs: number;
};

export type DiscoveryRunOptions = {
  hours: number;
  persist: boolean;
  now?: Date;
  timeoutMs?: number;
  concurrency?: number;
  supabase?: SupabaseClient<Database>;
};

export type DiscoveryRunResult = {
  startedAt: string;
  finishedAt: string;
  hours: number;
  sources: SourceDiscoveryResult[];
  candidates: DiscoveryCandidate[];
  candidatesDiscovered: number;
  duplicateUrls: number;
  duplicateContentHashes: number;
  invalidCandidates: number;
  undatedExcluded: number;
  persisted: number;
  persistSkipped: number;
  persistErrors: number;
  traceability: RawItemTraceability[];
  /** One entry per deduplicated candidate, including failed or disabled persistence. */
  persistenceOutcomes?: RawItemPersistenceOutcome[];
};
