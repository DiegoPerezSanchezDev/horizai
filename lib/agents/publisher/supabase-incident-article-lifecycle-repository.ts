import "server-only";

import {
  publishedFactualIncident12C2A,
  type IncidentArticleLifecycleRepository,
  type IncidentArticleLifecycleRow,
} from "./article-lifecycle.ts";

type FetchLike = typeof fetch;

export class SupabaseIncidentArticleLifecycleRepository implements IncidentArticleLifecycleRepository {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { baseUrl: string; serviceKey: string; fetchImpl?: FetchLike }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.serviceKey = options.serviceKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.baseUrl || !this.serviceKey) throw new Error("INCIDENT_ARCHIVE_SERVER_CONFIGURATION_MISSING");
  }

  static fromEnvironment(fetchImpl?: FetchLike): SupabaseIncidentArticleLifecycleRepository {
    const baseUrl = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const serviceKey = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!baseUrl || !serviceKey) throw new Error("INCIDENT_ARCHIVE_SERVER_CONFIGURATION_MISSING");
    return new SupabaseIncidentArticleLifecycleRepository({ baseUrl, serviceKey, fetchImpl });
  }

  async readIncidentArticle(): Promise<IncidentArticleLifecycleRow | null> {
    const rows = await this.requestRows("GET", {
      select: "id,event_id,slug,publication_status",
      id: `eq.${publishedFactualIncident12C2A.articleId}`,
      event_id: `eq.${publishedFactualIncident12C2A.eventId}`,
      slug: `eq.${publishedFactualIncident12C2A.slug}`,
    });
    if (rows.length > 1) throw new Error("INCIDENT_ARCHIVE_READ_RETURNED_MULTIPLE_ROWS");
    return rows[0] ?? null;
  }

  async archivePublishedIncidentArticle(): Promise<IncidentArticleLifecycleRow[]> {
    return this.requestRows("PATCH", {
      select: "id,event_id,slug,publication_status",
      id: `eq.${publishedFactualIncident12C2A.articleId}`,
      event_id: `eq.${publishedFactualIncident12C2A.eventId}`,
      slug: `eq.${publishedFactualIncident12C2A.slug}`,
      publication_status: "eq.published",
    }, { publication_status: "archived" }, true);
  }

  private async requestRows(method: "GET" | "PATCH", query: Record<string, string>, body?: unknown, returnRepresentation = false): Promise<IncidentArticleLifecycleRow[]> {
    const url = new URL(`${this.baseUrl}/rest/v1/articles`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.fetchImpl(url, {
      method,
      cache: "no-store",
      headers: {
        apikey: this.serviceKey,
        Authorization: `Bearer ${this.serviceKey}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(returnRepresentation ? { Prefer: "return=representation" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`INCIDENT_ARCHIVE_POSTGREST_${method}_FAILED_${response.status}`);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error("INCIDENT_ARCHIVE_POSTGREST_INVALID_RESPONSE");
    return value as IncidentArticleLifecycleRow[];
  }
}
