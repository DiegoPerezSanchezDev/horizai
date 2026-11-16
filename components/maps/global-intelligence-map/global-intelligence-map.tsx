"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Container } from "@/components/ui/container";
import type { PublicArticleSummary } from "@/lib/public-content-model";
import { createMapLocations, getAvailableCategories, getAvailableRegions } from "@/lib/public-content-model";

import { MapFilters } from "./map-filters";
import { MapSidePanel } from "./map-side-panel";
import { MapViewToggle } from "./map-view-toggle";
import type { GlobalMapFilters, MapViewMode } from "./map-types";
import { mergeMapUrlState, parseMapUrlState, shouldShowHeatIntensityLegend } from "./map-url-state";

const LazyMapCanvas = lazy(() => import("./map-canvas").then((module) => ({ default: module.MapCanvas })));

function MapPlaceholder() {
  return (
    <div className="grid h-[25rem] place-items-center bg-console-bg sm:h-[31rem]" role="status">
      <div className="flex items-center gap-3 font-mono text-[0.62rem] uppercase tracking-[0.18em] text-console-faint">
        <span className="live-dot" aria-hidden="true" /> Cargando mapa global
      </div>
    </div>
  );
}

export function GlobalIntelligenceMap({
  stories,
  status,
  articleBasePath = "/noticias",
}: {
  stories: readonly PublicArticleSummary[];
  status: "ready" | "error";
  articleBasePath?: string;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const [shouldLoadMap, setShouldLoadMap] = useState(false);
  const searchParams = useSearchParams();
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [timeReference, setTimeReference] = useState(() => Date.now());

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setShouldLoadMap(true);
      observer.disconnect();
    }, { rootMargin: "420px 0px" });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const categories = useMemo(() => getAvailableCategories(stories), [stories]);
  const regions = useMemo(() => getAvailableRegions(stories), [stories]);
  const mapState = useMemo(
    () => parseMapUrlState(searchParams, { regions, categories }),
    [categories, regions, searchParams],
  );
  const { filters, mode } = mapState;
  const hasExplicitFilters = filters.timeRange !== "30d" || filters.region !== null || filters.category !== null;
  const updateUrlState = useCallback((nextState: { mode: MapViewMode; filters: GlobalMapFilters }) => {
    const currentUrl = new URL(window.location.href);
    const nextParams = mergeMapUrlState(currentUrl.searchParams, nextState);
    const query = nextParams.toString();
    const nextUrl = `${currentUrl.pathname}${query ? `?${query}` : ""}${currentUrl.hash}`;
    window.history.replaceState(null, "", nextUrl);
  }, []);

  const updateFilters = useCallback((changes: Partial<GlobalMapFilters>) => {
    const nextFilters = { ...filters, ...changes };
    updateUrlState({ mode, filters: nextFilters });
    setSelectedLocationId(null);
    setTimeReference(Date.now());
  }, [filters, mode, updateUrlState]);

  const updateMode = useCallback((nextMode: MapViewMode) => {
    updateUrlState({ mode: nextMode, filters });
  }, [filters, updateUrlState]);

  const filteredStories = useMemo(() => {
    const windowMs = filters.timeRange === "24h" ? 24 * 60 * 60 * 1000 : filters.timeRange === "7d" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    if (filters.timeRange === "30d" && !hasExplicitFilters) return stories;
    const cutoff = timeReference - windowMs;
    return stories.filter((story) => {
      const publishedAt = Date.parse(story.publishedAt);
      if (!Number.isFinite(publishedAt) || publishedAt < cutoff) return false;
      if (filters.region !== null && story.regionCode !== filters.region) return false;
      if (filters.category !== null && !story.categories.some((category) => category.slug === filters.category)) return false;
      return true;
    });
  }, [filters.category, filters.region, filters.timeRange, hasExplicitFilters, stories, timeReference]);

  const locations = useMemo(() => createMapLocations(filteredStories), [filteredStories]);
  const storiesWithCoordinates = locations.reduce((total, location) => total + location.stories.length, 0);
  const storiesWithoutCoordinates = Math.max(0, filteredStories.length - storiesWithCoordinates);

  const activeSelectedLocationId = selectedLocationId && locations.some((location) => location.id === selectedLocationId)
    ? selectedLocationId
    : null;
  const handleSelectLocation = useCallback((locationId: string | null) => setSelectedLocationId(locationId), []);
  const timeLabel = filters.timeRange === "24h" ? "Últimas 24 h" : filters.timeRange === "7d" ? "Últimos 7 días" : "Últimos 30 días";

  return (
    <section ref={sectionRef} id="mapa-global" className="map-section section-divider py-12 sm:py-16 lg:py-[var(--space-section)]">
      <Container className="relative z-10">
        <div className="reveal flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
          <div className="max-w-2xl">
            <p className="editorial-label">Exploración global</p>
            <h2 className="type-h2 mt-4 max-w-[30rem]">Mapa global de la <span className="text-accent">IA</span></h2>
            <p className="mt-3 max-w-xl text-[0.92rem] leading-relaxed text-muted-foreground sm:text-[0.98rem]">
              Filtra las publicaciones por periodo, región y tema. Selecciona una ubicación para explorar sus historias y fuentes.
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
            <span className="chip-label">{mode === "nodes" ? "Historias por ubicación" : "Concentración de historias"}</span>
            <MapViewToggle activeView={mode} onChange={updateMode} />
          </div>
        </div>

        {status === "ready" && stories.length > 0 ? (
          <div className="reveal mt-6 sm:mt-7"><MapFilters filters={filters} regions={regions} categories={categories} onChange={updateFilters} /></div>
        ) : null}

        <div className="reveal mt-4 grid items-start gap-3 sm:mt-5 lg:grid-cols-[minmax(0,3fr)_minmax(17.5rem,1fr)] lg:gap-4">
          <div className="map-frame">
            <span className="map-corner map-corner-tl" aria-hidden="true" />
            <span className="map-corner map-corner-tr" aria-hidden="true" />
            <span className="map-corner map-corner-bl" aria-hidden="true" />
            <span className="map-corner map-corner-br" aria-hidden="true" />
            <div className="map-statusbar">
              <span className="published-indicator" aria-hidden="true" />
              <strong>{mode === "nodes" ? "Nodos" : "Calor"}</strong>
              <span className="hidden sm:inline">· {timeLabel}</span>
            </div>

            {status === "error" ? (
              <div className="map-empty-state" role="alert"><strong>El mapa no está disponible ahora.</strong><span>Inténtalo de nuevo dentro de un momento.</span></div>
            ) : locations.length > 0 ? (
              shouldLoadMap ? (
                <Suspense fallback={<MapPlaceholder />}>
              <LazyMapCanvas locations={locations} mode={mode} selectedLocationId={activeSelectedLocationId} onSelectLocation={handleSelectLocation} articleBasePath={articleBasePath} mapState={mapState} />
                </Suspense>
              ) : <MapPlaceholder />
            ) : (
              <div className="map-empty-state" role="status">
                <strong>{stories.length === 0 ? "Aún no hay historias publicadas." : "No hay historias ubicadas en este periodo."}</strong>
                <span>{storiesWithoutCoordinates > 0 ? `${storiesWithoutCoordinates} ${storiesWithoutCoordinates === 1 ? "publicación no incluye" : "publicaciones no incluyen"} coordenadas; no se asignan ubicaciones estimadas.` : "Las historias aparecerán aquí cuando haya ubicaciones disponibles."}</span>
              </div>
            )}
            {shouldShowHeatIntensityLegend(mode, status, locations.length) ? (
              <div className="heat-intensity-legend" role="group" aria-label="Intensidad relativa de publicaciones">
                <span className="heat-intensity-legend-title">Intensidad relativa</span>
                <span className="heat-intensity-legend-scale">
                  <span>Menor</span>
                  <span className="heat-intensity-gradient" aria-hidden="true" />
                  <span>Mayor</span>
                </span>
              </div>
            ) : null}
            <div className="map-hud-footer" aria-hidden="true"><span>OpenFreeMap</span><span>{mode === "nodes" ? "Agrupación por ubicación" : "Intensidad por ubicación"}</span></div>
          </div>

          <aside className="map-side-column min-w-0">
            <MapSidePanel
              locations={locations}
              storiesWithCoordinates={storiesWithCoordinates}
              storiesWithoutCoordinates={storiesWithoutCoordinates}
              selectedLocationId={activeSelectedLocationId}
              onSelectLocation={handleSelectLocation}
              status={status}
              articleBasePath={articleBasePath}
              mapState={mapState}
            />
          </aside>
        </div>

        <div className="map-coverage mt-4">
          <p>{status === "error" ? "Datos públicos no disponibles" : `${timeLabel}: ${storiesWithCoordinates} ${storiesWithCoordinates === 1 ? "publicación" : "publicaciones"} en ${locations.length} ${locations.length === 1 ? "ubicación" : "ubicaciones"}.`}</p>
          <p>Solo ubicaciones incluidas en los datos públicos. La cobertura refleja las historias disponibles, no toda la actividad mundial de IA.</p>
        </div>
      </Container>
    </section>
  );
}
