export type MapViewMode = "nodes" | "heat";
export type MapTimeRange = "24h" | "7d" | "30d";

export interface GlobalMapFilters {
  timeRange: MapTimeRange;
  region: string | null;
  category: string | null;
}
