import "server-only";

import { cache } from "react";
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";
import {
  mapPublicArticle,
  mapPublicArticleSummary,
  type PublicArticle,
  type PublicArticleRow,
  type PublicArticleSummary,
  type PublicArticleSummaryRow,
} from "./public-content-model";
import { publicContentError, publicContentReady, type PublicContentResult } from "./public-content-result";

const HOMEPAGE_WINDOW_DAYS = 30;
const HOMEPAGE_ARTICLE_LIMIT = 36;
const HOMEPAGE_FIELDS = "slug,headline_es,summary_es,published_at,region_code,region_name,region_latitude,region_longitude,categories,sources,entities";
const ARTICLE_FIELDS = `${HOMEPAGE_FIELDS},why_it_matters_es,body_es,updated_at`;
const SITEMAP_PAGE_SIZE = 1000;

export interface PublishedArticleSitemapEntry {
  slug: string;
  updatedAt: string;
}

function createPublicContentClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();

  if (!url || !key) return null;

  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
}

function logReadFailure(scope: string, code?: string) {
  console.error(`[public-content] ${scope} read failed`, { code: code?.trim() || "UNKNOWN" });
}

export interface RecentPublishedArticlesSnapshot {
  content: PublicContentResult<PublicArticleSummary[]>;
  asOf: number;
}

export const getRecentPublishedArticlesSnapshot = cache(async (): Promise<RecentPublishedArticlesSnapshot> => {
  const now = new Date();
  const client = createPublicContentClient();
  if (!client) {
    logReadFailure("homepage", "PUBLIC_CONFIGURATION_MISSING");
    return { content: publicContentError<PublicArticleSummary[]>([]), asOf: now.getTime() };
  }

  try {
    const publishedSince = new Date(now.getTime() - HOMEPAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await client
      .from("public_published_articles")
      .select(HOMEPAGE_FIELDS)
      .gte("published_at", publishedSince)
      .lte("published_at", now.toISOString())
      .order("published_at", { ascending: false })
      .limit(HOMEPAGE_ARTICLE_LIMIT);

    if (error) {
      logReadFailure("homepage", error.code);
      return { content: publicContentError<PublicArticleSummary[]>([]), asOf: now.getTime() };
    }

    return { content: publicContentReady((data as PublicArticleSummaryRow[]).map(mapPublicArticleSummary)), asOf: now.getTime() };
  } catch {
    logReadFailure("homepage", "UNEXPECTED_READ_FAILURE");
    return { content: publicContentError<PublicArticleSummary[]>([]), asOf: now.getTime() };
  }
});

export const getRecentPublishedArticles = cache(async (): Promise<PublicContentResult<PublicArticleSummary[]>> =>
  (await getRecentPublishedArticlesSnapshot()).content
);
export const getPublishedArticleBySlug = cache(async (slug: string): Promise<PublicContentResult<PublicArticle | null>> => {
  const client = createPublicContentClient();
  if (!client) {
    logReadFailure("article", "PUBLIC_CONFIGURATION_MISSING");
    return publicContentError<PublicArticle | null>(null);
  }

  try {
    const { data, error } = await client
      .from("public_published_articles")
      .select(ARTICLE_FIELDS)
      .eq("slug", slug)
      .maybeSingle();

    if (error) {
      logReadFailure("article", error.code);
      return publicContentError<PublicArticle | null>(null);
    }

    return publicContentReady(data ? mapPublicArticle(data as PublicArticleRow) : null);
  } catch {
    logReadFailure("article", "UNEXPECTED_READ_FAILURE");
    return publicContentError<PublicArticle | null>(null);
  }
});

export const getPublishedArticlesForSitemap = cache(async (): Promise<PublicContentResult<PublishedArticleSitemapEntry[]>> => {
  const client = createPublicContentClient();
  if (!client) {
    logReadFailure("sitemap", "PUBLIC_CONFIGURATION_MISSING");
    return publicContentError<PublishedArticleSitemapEntry[]>([]);
  }

  try {
    const entries: PublishedArticleSitemapEntry[] = [];
    for (let offset = 0; ; offset += SITEMAP_PAGE_SIZE) {
      const { data, error } = await client
        .from("public_published_articles")
        .select("slug,updated_at")
        .order("published_at", { ascending: false })
        .range(offset, offset + SITEMAP_PAGE_SIZE - 1);

      if (error) {
        logReadFailure("sitemap", error.code);
        return publicContentError<PublishedArticleSitemapEntry[]>([]);
      }

      const rows = data as Pick<PublicArticleRow, "slug" | "updated_at">[];
      entries.push(...rows.map(({ slug, updated_at }) => ({ slug, updatedAt: updated_at })));
      if (rows.length < SITEMAP_PAGE_SIZE) break;
    }

    return publicContentReady(entries);
  } catch {
    logReadFailure("sitemap", "UNEXPECTED_READ_FAILURE");
    return publicContentError<PublishedArticleSitemapEntry[]>([]);
  }
});
