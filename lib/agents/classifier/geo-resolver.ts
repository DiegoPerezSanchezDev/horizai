import type { ReferenceRegistry, RegionReference } from "./geo-registry.ts";

export type GeoResolutionLevel = "global" | "region" | "country" | "unresolved";
export type GeoResolution = {
  latitude: number | null;
  longitude: number | null;
  resolutionLevel: GeoResolutionLevel;
  resolvedFrom: "country_registry" | "region_registry" | null;
};

function resolved(region: RegionReference, level: GeoResolutionLevel): GeoResolution {
  if (region.latitude === null || region.longitude === null) return { latitude: null, longitude: null, resolutionLevel: "unresolved", resolvedFrom: null };
  return { latitude: region.latitude, longitude: region.longitude, resolutionLevel: level, resolvedFrom: "region_registry" };
}

export function resolveGeo(input: { regionCode: string | null }, registry: ReferenceRegistry): GeoResolution {
  if (input.regionCode && registry.regions.has(input.regionCode)) {
    const level = input.regionCode === "GLOBAL" ? "global" : "region";
    return resolved(registry.regions.get(input.regionCode)!, level);
  }
  return { latitude: null, longitude: null, resolutionLevel: "unresolved", resolvedFrom: null };
}

/** Reprojects deterministic coordinates from a persisted semantic region without mutating its checkpoint. */
export function projectClassificationGeo<T extends {
  primaryRegionCode: string | null;
  latitude: number | null;
  longitude: number | null;
}>(classification: T, registry: ReferenceRegistry): { classification: T; geo: GeoResolution } {
  const geo = resolveGeo({ regionCode: classification.primaryRegionCode }, registry);
  return {
    classification: { ...classification, latitude: geo.latitude, longitude: geo.longitude },
    geo,
  };
}
