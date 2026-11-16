import type { MetadataRoute } from "next";
import { connection } from "next/server";

import { getPublishedArticlesForSitemap } from "@/lib/public-content";
import { canIndexPublicSite, getPublicSiteUrl } from "@/lib/public-site-url";

const INDEXABLE_PAGES = ["/", "/sobre-nosotros", "/metodologia", "/fuentes"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!canIndexPublicSite()) return [];

  const siteUrl = getPublicSiteUrl();
  if (!siteUrl) return [];

  await connection();
  const articles = await getPublishedArticlesForSitemap();
  const staticEntries: MetadataRoute.Sitemap = INDEXABLE_PAGES.map((path) => ({
    url: new URL(path, siteUrl).toString(),
  }));
  const articleEntries: MetadataRoute.Sitemap = articles.status === "ready"
    ? articles.data.map((article) => {
      const updatedAt = new Date(article.updatedAt);
      return {
        url: new URL(`/noticias/${encodeURIComponent(article.slug)}`, siteUrl).toString(),
        ...(Number.isFinite(updatedAt.getTime()) ? { lastModified: updatedAt } : {}),
      };
    })
    : [];

  return [...staticEntries, ...articleEntries];
}
