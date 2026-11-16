export type EditorialDataMode = "FIXTURE" | "LIVE_READ_ONLY" | "LIVE_DISABLED";

export function resolveEditorialDataMode(nodeEnv: string | undefined, liveFlag: string | undefined): EditorialDataMode {
  if (liveFlag === "true") return "LIVE_READ_ONLY";
  return nodeEnv === "development" ? "FIXTURE" : "LIVE_DISABLED";
}
