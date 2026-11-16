import { createSupabaseServerClient } from "../../supabase/server-client.ts";
import type { Database } from "../../../types/database.ts";
import type { DiscoveryMethod, SourceRegistryEntry } from "./discovery-types.ts";

type SourceRow = Database["public"]["Tables"]["sources"]["Row"];

const discoveryMethods = new Set<DiscoveryMethod>(["rss", "atom", "html", "api", "manual"]);

function toDiscoveryMethod(value: string): DiscoveryMethod {
  if (!discoveryMethods.has(value as DiscoveryMethod)) return "manual";
  return value as DiscoveryMethod;
}

/** Reads the active source catalog; fetchers do not own or hardcode source configuration. */
export async function getActiveDiscoverySources(): Promise<SourceRegistryEntry[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("sources")
    .select("id,name,url,feed_url,discovery_method,source_type,country_code,language,priority")
    .eq("is_active", true)
    .order("priority", { ascending: false })
    .order("name", { ascending: true });

  if (error) throw new Error(`read active sources: ${error.message}`);

  return ((data ?? []) as Pick<
    SourceRow,
    "id" | "name" | "url" | "feed_url" | "discovery_method" | "source_type" | "country_code" | "language" | "priority"
  >[]).map((source) => ({
    id: source.id,
    name: source.name,
    url: source.url,
    feedUrl: source.feed_url,
    discoveryMethod: toDiscoveryMethod(source.discovery_method),
    sourceType: source.source_type,
    countryCode: source.country_code,
    language: source.language,
    priority: source.priority,
  }));
}
