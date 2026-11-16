"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { Container } from "@/components/ui/container";
import type { PublicArticleSummary } from "@/lib/public-content-model";
import { getAvailableRegions } from "@/lib/public-content-model";

import { FeaturedStoriesFilters } from "./featured-stories-filters";
import { FeaturedStoryCard } from "./featured-story-card";
import { FEATURED_STORIES_LIMIT, getFeaturedStoriesGridConfig } from "./featured-stories-layout";

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {direction === "left" ? <path d="m10 3.5-4.5 4.5 4.5 4.5" /> : <path d="m6 3.5 4.5 4.5L6 12.5" />}
    </svg>
  );
}

export function FeaturedStoriesSection({ stories, status, articleBasePath = "/noticias" }: { stories: readonly PublicArticleSummary[]; status: "ready" | "error"; articleBasePath?: string }) {
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ ratio: 0, width: 1, atStart: true, atEnd: false });
  const regions = useMemo(() => getAvailableRegions(stories), [stories]);

  const visibleStories = useMemo(
    () => stories
      .filter((story) => activeRegion === null || story.regionCode === activeRegion)
      .toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, FEATURED_STORIES_LIMIT),
    [activeRegion, stories],
  );
  const gridConfig = getFeaturedStoriesGridConfig(visibleStories);

  const updateScrollState = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScroll = rail.scrollWidth - rail.clientWidth;
    if (maxScroll <= 1) {
      setScrollState({ ratio: 0, width: 1, atStart: true, atEnd: true });
      return;
    }
    const ratio = rail.scrollLeft / maxScroll;
    setScrollState({ ratio, width: rail.clientWidth / rail.scrollWidth, atStart: rail.scrollLeft <= 2, atEnd: rail.scrollLeft >= maxScroll - 2 });
  }, []);

  useEffect(() => {
    updateScrollState();
    const rail = railRef.current;
    if (!rail) return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [updateScrollState, visibleStories.length]);

  const scrollBy = (direction: 1 | -1) => {
    const rail = railRef.current;
    if (!rail) return;
    const card = rail.firstElementChild as HTMLElement | null;
    rail.scrollBy({ left: (card ? card.offsetWidth + 14 : rail.clientWidth * 0.8) * direction, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const showControls = !(scrollState.atStart && scrollState.atEnd);

  return (
    <section id="historias-destacadas" className="section-shell section-divider">
      <Container className="relative z-10">
        <div className="reveal flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
          <div className="max-w-2xl">
            <p className="editorial-label">Briefing diario</p>
            <h2 className="type-h2 mt-4 max-w-[38rem]">
              Noticias recientes de IA, con perspectiva global
            </h2>
          </div>
          <p className="max-w-sm text-[0.92rem] leading-relaxed text-muted-foreground lg:pb-1 lg:text-right">
            Hasta cinco historias publicadas en las últimas 72 horas. Si no hay novedades recientes, no rellenamos la selección con noticias antiguas.
          </p>
        </div>

        {(regions.length > 1 && stories.length >= 3) || (showControls && status === "ready") ? <div className="reveal mt-6 flex items-center justify-between gap-4 sm:mt-7">
          <FeaturedStoriesFilters activeRegion={activeRegion} regions={regions} onSelect={setActiveRegion} />
          {showControls && status === "ready" ? (
            <div className="hidden shrink-0 items-center gap-2 sm:flex xl:hidden">
              <button type="button" className="icon-button size-11" onClick={() => scrollBy(-1)} disabled={scrollState.atStart} aria-label="Historias anteriores"><ChevronIcon direction="left" /></button>
              <button type="button" className="icon-button size-11" onClick={() => scrollBy(1)} disabled={scrollState.atEnd} aria-label="Historias siguientes"><ChevronIcon direction="right" /></button>
            </div>
          ) : null}
        </div> : null}

        {visibleStories.length > 0 ? (
          <>
            <div
              ref={railRef}
              onScroll={updateScrollState}
              data-count={gridConfig.count}
              data-lead-image={gridConfig.leadHasImage}
              data-tail-remainder={gridConfig.tailRemainder}
              style={{ "--story-count": visibleStories.length } as CSSProperties}
              className="story-rail scroll-x reveal -mx-4 mt-4 px-4 sm:mx-0 sm:mt-5 sm:px-0"
            >
              {visibleStories.map((story, index) => <FeaturedStoryCard key={story.slug} story={story} index={index} articleBasePath={articleBasePath} />)}
            </div>
            {showControls ? (
              <div className="rail-progress mx-auto mt-2 w-40 xl:hidden" aria-hidden="true">
                <span style={{ width: `${Math.max(12, scrollState.width * 100)}%`, transform: `translateX(${scrollState.ratio * (100 / Math.max(12, scrollState.width * 100) - 1) * 100}%)` }} />
              </div>
            ) : null}
          </>
        ) : (
          <div className="content-state mt-6" role={status === "error" ? "alert" : "status"}>
            {status === "error" ? "No pudimos cargar las historias. Inténtalo de nuevo dentro de un momento." : activeRegion ? "No hay historias de esta región publicadas en las últimas 72 horas." : "No hay noticias nuevas en las últimas 72 horas. Puedes explorar las publicaciones recientes en «Más noticias» y en el mapa."}
          </div>
        )}
      </Container>
    </section>
  );
}
