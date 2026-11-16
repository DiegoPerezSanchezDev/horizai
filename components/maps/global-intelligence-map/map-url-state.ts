import type { GlobalMapFilters, MapTimeRange, MapViewMode } from "./map-types";

export interface MapUrlState {
  mode: MapViewMode;
  filters: GlobalMapFilters;
}

interface MapOptionSet {
  regions: readonly { code: string }[];
  categories: readonly { slug: string }[];
}

type SearchParamReader = Pick<URLSearchParams, "get">;
type ArticleSearchParams = Record<string, string | string[] | undefined>;

const DEFAULT_MAP_STATE: MapUrlState = {
  mode: "nodes",
  filters: { timeRange: "30d", region: null, category: null },
};

const validTimeRanges = new Set<MapTimeRange>(["24h", "7d", "30d"]);
const mapQueryKeys = ["map", "period", "region", "topic"] as const;

function isSafeSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value);
}

export function parseMapUrlState(
  params: SearchParamReader,
  available: MapOptionSet,
): MapUrlState {
  const mode: MapViewMode = params.get("map") === "heat" ? "heat" : "nodes";
  const rawPeriod = params.get("period");
  const timeRange = validTimeRanges.has(rawPeriod as MapTimeRange)
    ? rawPeriod as MapTimeRange
    : DEFAULT_MAP_STATE.filters.timeRange;
  const rawRegion = params.get("region");
  const region = rawRegion && available.regions.some(({ code }) => code === rawRegion)
    ? rawRegion
    : null;
  const rawCategory = params.get("topic");
  const category = rawCategory && available.categories.some(({ slug }) => slug === rawCategory)
    ? rawCategory
    : null;

  return { mode, filters: { timeRange, region, category } };
}

export function serializeMapUrlState(state: MapUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.mode !== DEFAULT_MAP_STATE.mode) params.set("map", state.mode);
  if (state.filters.timeRange !== DEFAULT_MAP_STATE.filters.timeRange) {
    params.set("period", state.filters.timeRange);
  }
  if (state.filters.region) params.set("region", state.filters.region);
  if (state.filters.category) params.set("topic", state.filters.category);
  return params;
}

export function mergeMapUrlState(existing: URLSearchParams, state: MapUrlState): URLSearchParams {
  const next = new URLSearchParams(existing.toString());
  for (const key of mapQueryKeys) next.delete(key);
  serializeMapUrlState(state).forEach((value, key) => next.set(key, value));
  return next;
}

export function createMapArticleHref(articleHref: string, state: MapUrlState): string {
  const articleUrl = new URL(articleHref, "https://horizai.invalid");
  for (const key of [...mapQueryKeys, "fromMap"]) articleUrl.searchParams.delete(key);
  articleUrl.searchParams.set("fromMap", "1");
  serializeMapUrlState(state).forEach((value, key) => articleUrl.searchParams.set(key, value));
  const query = articleUrl.searchParams.toString();
  return `${articleUrl.pathname}${query ? `?${query}` : ""}${articleUrl.hash}`;
}

export function getMapReturnHref(searchParams: ArticleSearchParams): string | null {
  if (searchParams.fromMap !== "1") return null;

  const params = new URLSearchParams();
  if (searchParams.map === "heat") params.set("map", "heat");

  const period = searchParams.period;
  if (typeof period === "string" && validTimeRanges.has(period as MapTimeRange) && period !== "30d") {
    params.set("period", period);
  }

  for (const key of ["region", "topic"] as const) {
    const value = searchParams[key];
    if (typeof value === "string" && isSafeSlug(value)) params.set(key, value);
  }

  const query = params.toString();
  return `/${query ? `?${query}` : ""}#mapa-global`;
}

export function shouldShowHeatIntensityLegend(
  mode: MapViewMode,
  status: "ready" | "error",
  locationCount: number,
): boolean {
  return mode === "heat" && status === "ready" && locationCount > 0;
}
