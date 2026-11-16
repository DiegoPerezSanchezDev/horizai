import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { NewsArticlePage } from "@/components/news/article/news-article-page";
import { getPublishedArticleBySlug, getRecentPublishedArticles } from "@/lib/public-content";
import { getRelatedArticles } from "@/lib/public-content-model";
import { canIndexPublicSite, getCanonicalAlternates, getCanonicalUrl, getSiteSocialImageUrl } from "@/lib/public-site-url";
import { serializeJsonLd } from "@/lib/structured-data";
import { getMapReturnHref } from "@/components/maps/global-intelligence-map/map-url-state";

interface NewsPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: NewsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPublishedArticleBySlug(slug);
  const article = result.status === "ready" ? result.data : null;
  if (!article) {
    const description = "Esta noticia no está disponible públicamente.";
    return {
      title: "Noticia no disponible",
      description,
      robots: { index: false, follow: canIndexPublicSite() },
      openGraph: {
        type: "website",
        siteName: "HorizAI",
        locale: "es_ES",
        title: "Noticia no disponible | HorizAI",
        description,
      },
      twitter: { card: "summary", title: "Noticia no disponible | HorizAI", description },
    };
  }

  const title = article.headline;
  const description = article.summary ?? article.headline;
  const socialImage = article.imageUrl ?? getSiteSocialImageUrl();
  const metadata: Metadata = {
    title,
    description,
    alternates: getCanonicalAlternates(`/noticias/${encodeURIComponent(article.slug)}`),
    openGraph: {
      type: "article",
      siteName: "HorizAI",
      locale: "es_ES",
      title,
      description,
      publishedTime: article.publishedAt,
    modifiedTime: article.updatedAt,
      section: article.categories[0]?.name,
      images: socialImage ? [{
        url: socialImage,
        ...(article.imageUrl ? {} : { width: 1200, height: 630 }),
        alt: article.imageAlt ?? "HorizAI: noticias globales sobre inteligencia artificial en español",
      }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: socialImage ? [socialImage.toString()] : undefined,
    },
  };
  return metadata;
}

export default async function NewsPage({ params, searchParams }: NewsPageProps) {
  const [{ slug }, articleSearchParams] = await Promise.all([params, searchParams]);
  const result = await getPublishedArticleBySlug(slug);

  if (result.status === "error") throw new Error("PUBLIC_ARTICLE_READ_FAILED");

  if (!result.data) notFound();

  const relatedResult = result.data.entities.length > 0
    ? await getRecentPublishedArticles()
    : { status: "ready" as const, data: [] };
  const related = relatedResult.status === "ready"
    ? getRelatedArticles(result.data, relatedResult.data)
    : [];

  const canonical = getCanonicalUrl(`/noticias/${encodeURIComponent(result.data.slug)}`);
  const structuredData = canonical ? serializeJsonLd({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: result.data.headline,
    ...(result.data.summary ? { description: result.data.summary } : {}),
    datePublished: result.data.publishedAt,
    dateModified: result.data.updatedAt,
    ...(result.data.categories.length > 0 ? { articleSection: result.data.categories.map(({ name }) => name) } : {}),
    inLanguage: "es",
    url: canonical.toString(),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical.toString() },
  }) : null;

  return (
    <>
      {structuredData ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} /> : null}
      <NewsArticlePage article={result.data} relatedArticles={related} returnHref={getMapReturnHref(articleSearchParams) ?? undefined} />
    </>
  );
}
