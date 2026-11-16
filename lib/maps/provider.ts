import type { Map as MapLibreMap } from "maplibre-gl";

export const DEFAULT_MAP_STYLE_URL =
  "https://tiles.openfreemap.org/styles/dark";

export const LIGHT_MAP_STYLE_URL =
  "https://tiles.openfreemap.org/styles/positron";

const configuredMapStyle = process.env.NEXT_PUBLIC_MAP_STYLE_URL?.trim();

export function getMapStyleUrl(isLight: boolean): string {
  if (isLight) return LIGHT_MAP_STYLE_URL;
  return configuredMapStyle || DEFAULT_MAP_STYLE_URL;
}

export const WORLD_MAP_VIEW = {
  center: [8, 24] as [number, number],
  zoom: 1.25,
};

/**
 * Repaints the OpenFreeMap dark basemap into HorizAI's console palette:
 * deep navy water, muted land, thin luminous borders. The goal is an
 * intelligence surface rather than a GIS map, so detail is deliberately quiet.
 */
export function applyHorizAIMapTheme(map: MapLibreMap): void {
  if (map.getLayer("background")) {
    map.setPaintProperty("background", "background-color", "#051022");
  }

  if (map.getLayer("water")) {
    map.setPaintProperty("water", "fill-color", "#030a15");
    map.setPaintProperty("water", "fill-opacity", 0.98);
    map.setPaintProperty("water", "fill-outline-color", "#134068");
  }

  ["land", "landcover", "landcover_grass", "landcover_wood"].forEach((layerId) => {
    const layer = map.getLayer(layerId);
    if (!layer || layer.type !== "fill") return;

    map.setPaintProperty(layerId, "fill-color", layerId === "land" ? "#102d4d" : "#0d2842");
    map.setPaintProperty(layerId, "fill-opacity", layerId === "land" ? 0.9 : 0.3);
  });

  if (map.getLayer("landcover_ice_shelf")) {
    map.setPaintProperty("landcover_ice_shelf", "fill-color", "#163f63");
    map.setPaintProperty("landcover_ice_shelf", "fill-opacity", 0.6);
  }

  if (map.getLayer("landcover_glacier")) {
    map.setPaintProperty("landcover_glacier", "fill-color", "#194a70");
  }

  if (map.getLayer("landuse_park")) {
    map.setPaintProperty("landuse_park", "fill-color", "#0f324e");
    map.setPaintProperty("landuse_park", "fill-opacity", 0.6);
  }

  if (map.getLayer("boundary_country_z0-4")) {
    map.setPaintProperty("boundary_country_z0-4", "line-color", "#4f92c9");
    map.setPaintProperty("boundary_country_z0-4", "line-opacity", 0.62);
    map.setPaintProperty("boundary_country_z0-4", "line-width", [
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0.5,
      4,
      1.1,
    ]);
    map.setPaintProperty("boundary_country_z0-4", "line-blur", 0.25);
  }

  if (map.getLayer("boundary_country_z5-")) {
    map.setPaintProperty("boundary_country_z5-", "line-color", "#4f92c9");
    map.setPaintProperty("boundary_country_z5-", "line-opacity", 0.6);
    map.setPaintProperty("boundary_country_z5-", "line-width", 0.9);
    map.setPaintProperty("boundary_country_z5-", "line-blur", 0.2);
  }

  if (map.getLayer("boundary_state")) {
    map.setPaintProperty("boundary_state", "line-color", "#244b6c");
    map.setPaintProperty("boundary_state", "line-opacity", 0.4);
    map.setPaintProperty("boundary_state", "line-width", 0.5);
  }

  const countryLabelLayers = [
    "place_country_other",
    "place_country_minor",
    "place_country_major",
  ];

  const latinName = ["coalesce", ["get", "name:latin"], ["get", "name"]] as [
    "coalesce",
    ["get", string],
    ["get", string],
  ];

  countryLabelLayers.forEach((layerId) => {
    if (!map.getLayer(layerId)) return;

    map.setLayoutProperty(layerId, "text-field", latinName);
    map.setLayoutProperty(layerId, "text-letter-spacing", 0.12);
    map.setPaintProperty(layerId, "text-color", "#7ea6c8");
    map.setPaintProperty(layerId, "text-halo-color", "#051022");
    map.setPaintProperty(layerId, "text-halo-width", 1.2);
    map.setPaintProperty(
      layerId,
      "text-opacity",
      layerId === "place_country_major"
        ? ["interpolate", ["linear"], ["zoom"], 1, 0.45, 3, 0.85]
        : ["interpolate", ["linear"], ["zoom"], 2, 0, 3, 0.4, 4, 0.8],
    );
  });

  ["place_town", "place_city", "place_city_large", "place_state", "place_continent"].forEach((layerId) => {
    if (!map.getLayer(layerId)) return;

    map.setLayoutProperty(layerId, "icon-image", "");
    map.setLayoutProperty(layerId, "text-field", latinName);
    map.setPaintProperty(layerId, "text-color", "#6d93b6");
    map.setPaintProperty(layerId, "text-halo-color", "#051022");
    if (layerId !== "place_continent") {
      map.setLayerZoomRange(layerId, 3.2, 24);
    }
  });
}
