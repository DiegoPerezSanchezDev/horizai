"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import type { PublicArticleSummary } from "@/lib/public-content-model";
import { getAvailableCategories } from "@/lib/public-content-model";

import { LatestNewsFilters } from "./latest-news-filters";
import { LatestNewsItem } from "./latest-news-item";

const PAGE_SIZE = 5;

export function LatestNewsSection({
  stories,
  status,
  articleBasePath = "/noticias",
}: {
  stories: readonly PublicArticleSummary[];
  status: "ready" | "error";
  articleBasePath?: string;
}) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const categories = useMemo(() => getAvailableCategories(stories), [stories]);
  const filteredNews = useMemo(() => stories
    .filter((story) => activeCategory === null || story.categories.some((category) => category.slug === activeCategory))
    .toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)), [activeCategory, stories]);
  const visibleNews = filteredNews.slice(0, showAll ? undefined : PAGE_SIZE);

  return (
    <section id="ultimas-noticias" className="section-shell section-divider">
      <Container className="relative z-10">
        <div className="reveal flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
          <div className="max-w-2xl">
            <p className="editorial-label">Más noticias</p>
            <h2 className="type-h2 mt-4 max-w-[38rem]">Más allá de lo destacado</h2>
          </div>
          <p className="max-w-sm text-[0.92rem] leading-relaxed text-muted-foreground lg:pb-1 lg:text-right">
            El resto del archivo de los últimos 30 días, con contexto y enlaces a las fuentes originales.
          </p>
        </div>

        {categories.length > 1 && stories.length >= 3 ? (
          <div className="reveal mt-6 sm:mt-7">
            <LatestNewsFilters
              categories={categories}
              activeCategory={activeCategory}
              onSelect={(category) => { setActiveCategory(category); setShowAll(false); }}
            />
          </div>
        ) : null}

        <div className="latest-index reveal mt-4 sm:mt-5">
          <p className="latest-count" aria-live="polite">
            {status === "error" ? "Noticias no disponibles" : `${visibleNews.length} de ${filteredNews.length} ${filteredNews.length === 1 ? "publicación" : "publicaciones"}`}
          </p>
          {status === "error" ? (
            <p className="content-state py-6" role="alert">No pudimos cargar las noticias. Vuelve a intentarlo más tarde.</p>
          ) : visibleNews.length > 0 ? (
            <ol className="latest-list">
              {visibleNews.map((story) => <li key={story.slug}><LatestNewsItem story={story} articleBasePath={articleBasePath} /></li>)}
            </ol>
          ) : (
            <p className="content-state py-6" role="status">
              {stories.length === 0
                ? "Aún no hay noticias publicadas en el periodo reciente."
                : "No hay noticias disponibles para esta categoría."}
            </p>
          )}
        </div>

        {status === "ready" && filteredNews.length > visibleNews.length ? (
          <div className="mt-6 flex justify-center">
            <Button className="px-5 text-[0.8rem]" onClick={() => setShowAll(true)} size="sm" variant="secondary">
              Ver {filteredNews.length - visibleNews.length} {filteredNews.length - visibleNews.length === 1 ? "noticia más" : "noticias más"} <span aria-hidden="true" className="text-accent">→</span>
            </Button>
          </div>
        ) : null}
      </Container>
    </section>
  );
}
