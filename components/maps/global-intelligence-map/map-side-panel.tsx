import Link from "next/link";

import type { MapLocation, MapStory } from "@/lib/public-content-model";
import { formatPublishedDate, getArticleHref } from "@/lib/public-content-model";
import { createMapArticleHref, type MapUrlState } from "./map-url-state";

interface MapSidePanelProps {
  locations: readonly MapLocation[];
  storiesWithCoordinates: number;
  storiesWithoutCoordinates: number;
  selectedLocationId: string | null;
  onSelectLocation: (locationId: string | null) => void;
  status: "ready" | "error";
  articleBasePath?: string;
  mapState: MapUrlState;
}

function StoryLink({ story, articleBasePath = "/noticias", mapState }: { story: MapStory; articleBasePath?: string; mapState: MapUrlState }) {
  return (
    <li>
      <Link href={createMapArticleHref(getArticleHref(story.slug, articleBasePath), mapState)} className="map-story-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {story.categoryName ? <span className="tag-pill">{story.categoryName}</span> : null}
          <time className="wire-time" dateTime={story.publishedAt}>{formatPublishedDate(story.publishedAt)}</time>
        </span>
        <span className="mt-2 block text-sm font-semibold leading-snug text-foreground-strong transition-colors group-hover:text-accent">{story.headline}</span>
        {story.summary ? <span className="mt-1 block line-clamp-2 text-xs leading-relaxed text-muted-foreground">{story.summary}</span> : null}
      </Link>
    </li>
  );
}

export function MapSidePanel({ locations, storiesWithCoordinates, storiesWithoutCoordinates, selectedLocationId, onSelectLocation, status, articleBasePath = "/noticias", mapState }: MapSidePanelProps) {
  const selectedLocation = locations.find((location) => location.id === selectedLocationId) ?? null;
  const stories = selectedLocation
    ? selectedLocation.stories
    : locations.flatMap((location) => location.stories).toSorted((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 4);

  return (
    <section id="map-story-context" className="console-panel map-stories-panel" aria-label="Historias ubicadas en el mapa">
      <div className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-4">
        <div>
          <p className="console-kicker">{selectedLocation ? selectedLocation.regionName ?? "Historias en esta ubicación" : "Historias en el mapa"}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {status === "error" ? "Datos no disponibles" : selectedLocation
              ? `${selectedLocation.stories.length} ${selectedLocation.stories.length === 1 ? "publicación" : "publicaciones"}`
              : `${storiesWithCoordinates} ${storiesWithCoordinates === 1 ? "publicación ubicada" : "publicaciones ubicadas"}`}
          </p>
        </div>
        {selectedLocation ? <button type="button" className="footer-link text-xs" onClick={() => onSelectLocation(null)}>Ver todas</button> : null}
      </div>

      {status === "error" ? (
        <p className="content-state m-3 text-sm" role="status">No pudimos cargar las publicaciones para este mapa.</p>
      ) : stories.length > 0 ? (
        <ul className="divide-y divide-hairline">
          {stories.map((story) => <StoryLink key={story.slug} story={story} articleBasePath={articleBasePath} mapState={mapState} />)}
        </ul>
      ) : (
        <p className="content-state m-3 text-sm" role="status">No hay publicaciones con ubicación en este periodo y selección.</p>
      )}

      {storiesWithoutCoordinates > 0 ? (
        <p className="border-t border-hairline px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {storiesWithoutCoordinates} {storiesWithoutCoordinates === 1 ? "publicación no tiene" : "publicaciones no tienen"} coordenadas y no se representa{storiesWithoutCoordinates === 1 ? "" : "n"} en el mapa.
        </p>
      ) : null}
    </section>
  );
}
