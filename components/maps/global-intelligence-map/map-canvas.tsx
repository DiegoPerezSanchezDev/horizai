"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AttributionControl,
  Map as MapLibreMap,
  setWorkerUrl,
  type GeoJSONSource,
  type MapMouseEvent,
} from "maplibre-gl";
import type { FeatureCollection, Point } from "geojson";
import Link from "next/link";

import type { MapLocation } from "@/lib/public-content-model";
import { getArticleHref } from "@/lib/public-content-model";
import { applyHorizAIMapTheme, getMapStyleUrl, WORLD_MAP_VIEW } from "@/lib/maps/provider";
import { MapControls } from "./map-controls";
import type { MapViewMode } from "./map-types";
import { createMapArticleHref, type MapUrlState } from "./map-url-state";
import { cn } from "@/components/ui/utils";

const STORY_SOURCE = "horizai-public-stories";
const HEAT_SOURCE = "horizai-public-story-heat-data";
const CLUSTER_LAYER = "horizai-public-story-clusters";
const CLUSTER_COUNT_LAYER = "horizai-public-story-cluster-count";
const STORY_POINT_LAYER = "horizai-public-story-points";
const SELECTED_POINT_LAYER = "horizai-public-story-selected";
const HEAT_LAYER = "horizai-public-story-heat";
const HEAT_POINT_LAYER = "horizai-public-story-heat-points";

setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

type StoryFeatureProperties = { locationId: string; storyCount: number };
type StoryCollection = FeatureCollection<Point, StoryFeatureProperties>;

interface MapCanvasProps {
  locations: readonly MapLocation[];
  mode: MapViewMode;
  selectedLocationId: string | null;
  onSelectLocation: (locationId: string | null) => void;
  articleBasePath: string;
  mapState: MapUrlState;
}

function createStoryFeatureCollection(locations: readonly MapLocation[]): StoryCollection {
  return {
    type: "FeatureCollection",
    features: locations.map((location) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [location.longitude, location.latitude] },
      properties: { locationId: location.id, storyCount: location.stories.length },
    })),
  };
}

function isLightTheme(): boolean {
  return document.documentElement.classList.contains("light");
}

function removeStoryStyle(map: MapLibreMap) {
  [HEAT_POINT_LAYER, HEAT_LAYER, SELECTED_POINT_LAYER, STORY_POINT_LAYER, CLUSTER_COUNT_LAYER, CLUSTER_LAYER].forEach((layer) => {
    if (map.getLayer(layer)) map.removeLayer(layer);
  });
  if (map.getSource(STORY_SOURCE)) map.removeSource(STORY_SOURCE);
  if (map.getSource(HEAT_SOURCE)) map.removeSource(HEAT_SOURCE);
}

function installStoryLayers(map: MapLibreMap, locations: readonly MapLocation[]) {
  removeStoryStyle(map);
  map.addSource(STORY_SOURCE, {
    type: "geojson",
    data: createStoryFeatureCollection(locations),
    cluster: true,
    clusterMaxZoom: 4,
    clusterRadius: 44,
    clusterProperties: { storyCount: ["+", ["get", "storyCount"]] },
  });
  map.addSource(HEAT_SOURCE, {
    type: "geojson",
    data: createStoryFeatureCollection(locations),
  });

  map.addLayer({
    id: CLUSTER_LAYER,
    type: "circle",
    source: STORY_SOURCE,
    filter: ["has", "point_count"],
    paint: {
      "circle-color": ["step", ["get", "point_count"], "#1979d4", 5, "#176ab7", 15, "#145a9b"],
      "circle-radius": ["step", ["get", "point_count"], 17, 5, 22, 15, 29],
      "circle-stroke-color": "#d7ecff",
      "circle-stroke-width": 1.2,
      "circle-opacity": 0.92,
    },
  });
  map.addLayer({
    id: CLUSTER_COUNT_LAYER,
    type: "symbol",
    source: STORY_SOURCE,
    filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 12, "text-font": ["Noto Sans Regular"] },
    paint: { "text-color": "#ffffff" },
  });
  map.addLayer({
    id: STORY_POINT_LAYER,
    type: "circle",
    source: STORY_SOURCE,
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "storyCount"], 1, 6, 8, 11],
      "circle-color": "#49a8ff",
      "circle-stroke-color": "#f4f9ff",
      "circle-stroke-width": 1.5,
      "circle-opacity": 0.94,
    },
  });
  map.addLayer({
    id: SELECTED_POINT_LAYER,
    type: "circle",
    source: STORY_SOURCE,
    filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "locationId"], ""]],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "storyCount"], 1, 13, 8, 19],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#f4cb73",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: HEAT_LAYER,
    type: "heatmap",
    source: HEAT_SOURCE,
    paint: {
      "heatmap-weight": ["interpolate", ["linear"], ["get", "storyCount"], 1, 0.45, 8, 1],
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.75, 5, 1.45],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 24, 5, 56],
      "heatmap-opacity": 0.78,
      "heatmap-color": [
        "interpolate", ["linear"], ["heatmap-density"],
        0, "rgba(36, 106, 230, 0)", 0.16, "#286adf", 0.35, "#41baff", 0.58, "#f6d45f", 0.82, "#f0793d", 1, "#ed483d",
      ],
    },
  });
  map.addLayer({
    id: HEAT_POINT_LAYER,
    type: "circle",
    source: HEAT_SOURCE,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "storyCount"], 1, 3, 8, 6],
      "circle-color": "#fff2be",
      "circle-stroke-color": "#18263a",
      "circle-stroke-width": 0.6,
    },
  });

  map.setLayoutProperty(CLUSTER_LAYER, "visibility", "visible");
  map.setLayoutProperty(CLUSTER_COUNT_LAYER, "visibility", "visible");
  map.setLayoutProperty(STORY_POINT_LAYER, "visibility", "visible");
  map.setLayoutProperty(SELECTED_POINT_LAYER, "visibility", "visible");
  map.setLayoutProperty(HEAT_LAYER, "visibility", "none");
  map.setLayoutProperty(HEAT_POINT_LAYER, "visibility", "none");
}

export function MapCanvas({ locations, mode, selectedLocationId, onSelectLocation, articleBasePath, mapState }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const locationsRef = useRef(locations);
  const modeRef = useRef(mode);
  const selectedRef = useRef(selectedLocationId);
  const selectRef = useRef(onSelectLocation);
  const resetViewRef = useRef({ center: WORLD_MAP_VIEW.center, zoom: 1.15 });
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const selectedLocation = locations.find((location) => location.id === selectedLocationId) ?? null;
  const selectedStory = selectedLocation?.stories[0] ?? null;

  useEffect(() => {
    locationsRef.current = locations;
    modeRef.current = mode;
    selectedRef.current = selectedLocationId;
    selectRef.current = onSelectLocation;
  }, [locations, mode, onSelectLocation, selectedLocationId]);

  const applyVisibility = useCallback((map: MapLibreMap) => {
    const nodes = modeRef.current === "nodes";
    [CLUSTER_LAYER, CLUSTER_COUNT_LAYER, STORY_POINT_LAYER, SELECTED_POINT_LAYER].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", nodes ? "visible" : "none");
    });
    [HEAT_LAYER, HEAT_POINT_LAYER].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", nodes ? "none" : "visible");
    });
    if (map.getLayer(SELECTED_POINT_LAYER)) {
      map.setFilter(SELECTED_POINT_LAYER, [
        "all", ["!", ["has", "point_count"]], ["==", ["get", "locationId"], selectedRef.current ?? ""],
      ]);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current) return;

    const compact = container.clientWidth < 640;
    const initialView = compact
      ? { center: [12, 24] as [number, number], zoom: 0 }
      : { center: WORLD_MAP_VIEW.center, zoom: 1.15 };
    resetViewRef.current = initialView;

    const map = new MapLibreMap({
      container,
      style: getMapStyleUrl(isLightTheme()),
      center: initialView.center,
      zoom: initialView.zoom,
      minZoom: 0,
      maxZoom: 7,
      attributionControl: false,
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    mapRef.current = map;
    map.addControl(new AttributionControl({ compact: true }), "bottom-left");
    map.getCanvas().setAttribute("aria-label", "Mapa interactivo de las publicaciones públicas de HorizAI. Usa las flechas para explorar y Tab para ir a las historias.");
    map.getCanvas().setAttribute("aria-describedby", "map-story-context");

    let lightTheme = isLightTheme();
    const onStyleLoad = () => {
      if (!lightTheme && !process.env.NEXT_PUBLIC_MAP_STYLE_URL) applyHorizAIMapTheme(map);
      try {
        installStoryLayers(map, locationsRef.current);
        applyVisibility(map);
        map.resize();
        setHasError(false);
        setIsReady(true);
      } catch {
        setHasError(true);
      }
    };

    const onClick = (event: MapMouseEvent) => {
      if (![CLUSTER_LAYER, STORY_POINT_LAYER, HEAT_POINT_LAYER].some((id) => map.getLayer(id))) return;
      const clusters = map.queryRenderedFeatures(event.point, { layers: [CLUSTER_LAYER] });
      const cluster = clusters[0];
      if (cluster && typeof cluster.properties?.cluster_id === "number") {
        const source = map.getSource(STORY_SOURCE) as GeoJSONSource | undefined;
        void source?.getClusterExpansionZoom(cluster.properties.cluster_id).then((zoom) => {
          map.easeTo({ center: (cluster.geometry as Point).coordinates as [number, number], zoom });
        }).catch(() => undefined);
        return;
      }
      const layers = modeRef.current === "nodes" ? [STORY_POINT_LAYER] : [HEAT_POINT_LAYER];
      const feature = map.queryRenderedFeatures(event.point, { layers })[0];
      const locationId = feature?.properties?.locationId;
      if (typeof locationId === "string") selectRef.current(locationId);
    };

    const onMove = (event: MapMouseEvent) => {
      const layers = modeRef.current === "nodes" ? [CLUSTER_LAYER, STORY_POINT_LAYER] : [HEAT_POINT_LAYER];
      const availableLayers = layers.filter((id) => map.getLayer(id));
      map.getCanvas().style.cursor = availableLayers.length > 0 && map.queryRenderedFeatures(event.point, { layers: availableLayers }).length > 0 ? "pointer" : "";
    };
    const observer = new MutationObserver(() => {
      const nextTheme = isLightTheme();
      if (nextTheme === lightTheme) return;
      lightTheme = nextTheme;
      setIsReady(false);
      map.setStyle(getMapStyleUrl(nextTheme), { diff: false });
    });

    map.on("style.load", onStyleLoad);
    map.on("click", onClick);
    map.on("mousemove", onMove);
    map.on("error", (event) => {
      if (!map.isStyleLoaded() && event.error) setHasError(true);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(container);

    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [applyVisibility]);

  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource(STORY_SOURCE) as GeoJSONSource | undefined;
    if (source) source.setData(createStoryFeatureCollection(locations));
    const heatSource = map?.getSource(HEAT_SOURCE) as GeoJSONSource | undefined;
    if (heatSource) heatSource.setData(createStoryFeatureCollection(locations));
    if (map && isReady) {
      applyVisibility(map);
      map.triggerRepaint();
    }
  }, [applyVisibility, isReady, locations, selectedLocationId]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && isReady) applyVisibility(map);
  }, [applyVisibility, isReady, mode]);

  const handleReset = useCallback(() => {
    const map = mapRef.current;
    if (map) map.easeTo({ ...resetViewRef.current, duration: 300 });
  }, []);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className={cn("map-canvas-shell h-[25rem] w-full sm:h-[31rem]", mode === "heat" ? "map-canvas-heat" : "map-canvas-nodes")}
      />
      <div className="map-grid-overlay pointer-events-none absolute inset-0" aria-hidden="true" />
      <MapControls
        onZoomIn={() => mapRef.current?.zoomIn({ duration: 180 })}
        onZoomOut={() => mapRef.current?.zoomOut({ duration: 180 })}
        onReset={handleReset}
      />
      {selectedLocation && selectedStory ? (
        <div className="map-selection-card" aria-live="polite">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <p className="console-kicker">{selectedLocation.regionName ?? "Historias en esta ubicación"}</p>
            <button type="button" className="map-selection-close" onClick={() => onSelectLocation(null)} aria-label="Cerrar historias seleccionadas">×</button>
          </div>
          <Link className="mt-2 block text-sm font-semibold leading-snug text-foreground-strong hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={createMapArticleHref(getArticleHref(selectedStory.slug, articleBasePath), mapState)}>
            {selectedStory.headline}
          </Link>
          {selectedLocation.stories.length > 1 ? <p className="mt-1 text-xs text-muted-foreground">+ {selectedLocation.stories.length - 1} publicaciones en esta ubicación</p> : null}
        </div>
      ) : null}
      {!isReady && !hasError ? <div className="map-load-overlay" role="status">Cargando cartografía…</div> : null}
      {hasError ? <div className="map-error-overlay" role="alert">No se pudo cargar la cartografía. Comprueba la conexión e inténtalo de nuevo más tarde.</div> : null}
    </div>
  );
}
