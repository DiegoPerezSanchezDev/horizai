import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";

import { Container } from "@/components/ui/container";
import { SiteFooter } from "@/components/footer/site-footer";
import { Hero } from "@/components/hero/hero";
import { GlobalIntelligenceMap } from "@/components/maps/global-intelligence-map/global-intelligence-map";
import { FeaturedStoriesSection } from "@/components/news/featured/featured-stories-section";
import { LatestNewsSection } from "@/components/news/latest/latest-news-section";
import { getDailyBriefingStories } from "@/components/news/featured/featured-stories-layout";
import { getRecentPublishedArticlesSnapshot } from "@/lib/public-content";
import { getCanonicalAlternates, getPublicSiteUrl, getSiteSocialImageUrl } from "@/lib/public-site-url";
import { serializeJsonLd } from "@/lib/structured-data";

const socialImage = getSiteSocialImageUrl();

export const metadata: Metadata = {
  title: { absolute: "HorizAI — Noticias globales sobre inteligencia artificial" },
  description: "Noticias públicas sobre inteligencia artificial, con contexto editorial, fuentes originales y perspectiva global.",
  openGraph: {
    type: "website",
    siteName: "HorizAI",
    locale: "es_ES",
    title: "HorizAI — Noticias globales sobre inteligencia artificial",
    description: "Noticias públicas sobre inteligencia artificial, con contexto editorial, fuentes originales y perspectiva global.",
    images: socialImage ? [{
      url: socialImage,
      width: 1200,
      height: 630,
      alt: "HorizAI: noticias globales sobre inteligencia artificial en español",
    }] : undefined,
  },
  twitter: {
    card: "summary_large_image",
    title: "HorizAI — Noticias globales sobre inteligencia artificial",
    description: "Noticias públicas sobre inteligencia artificial, con contexto y fuentes originales.",
    images: socialImage ? [socialImage.toString()] : undefined,
  },
  alternates: getCanonicalAlternates("/"),
};

function HomeLoading() {
  return (
    <main id="contenido" aria-busy="true" aria-label="Cargando HorizAI" className="min-h-screen">
      <div className="loading-header" />
      <Container className="py-12 sm:py-16">
        <div className="loading-kicker" />
        <div className="loading-title mt-5" />
        <div className="loading-line mt-5 max-w-2xl" />
        <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((item) => <div className="loading-card" key={item} />)}
        </div>
        <span className="sr-only">Cargando contenido público…</span>
      </Container>
    </main>
  );
}

async function HomeContent() {
  await connection();
  const snapshot = await getRecentPublishedArticlesSnapshot();
  const content = snapshot.content;
  const stories = content.data;
  const now = snapshot.asOf;
  // Keep the daily briefing genuinely fresh: older public articles remain browseable below, but never fill its five slots.
  const briefingStories = getDailyBriefingStories(stories, now);
  const featuredSlugs = new Set(briefingStories.map((story) => story.slug));
  const moreStories = stories.filter((story) => !featuredSlugs.has(story.slug));
  const siteUrl = getPublicSiteUrl();
  const structuredData = siteUrl ? serializeJsonLd({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "HorizAI",
    url: siteUrl.toString(),
    description: "Noticias globales sobre inteligencia artificial en español, con contexto editorial y enlaces a las fuentes originales.",
    inLanguage: "es",
  }) : null;

  return (
    <>
      {structuredData ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} /> : null}
      <Hero status={content.status} stories={briefingStories} hasArchive={moreStories.length > 0} />
      <main id="contenido">
        {/* Preserve the old "Lo más reciente" anchor when there is no separate archive section. */}
        {moreStories.length === 0 ? <span id="ultimas-noticias" aria-hidden="true" /> : null}
        <FeaturedStoriesSection stories={briefingStories} status={content.status} />
        <GlobalIntelligenceMap status={content.status} stories={stories} />
        {moreStories.length > 0 ? <LatestNewsSection stories={moreStories} status={content.status} /> : null}
      </main>
      <SiteFooter />
    </>
  );
}

export default function Home() {
  return <Suspense fallback={<HomeLoading />}><HomeContent /></Suspense>;
}
