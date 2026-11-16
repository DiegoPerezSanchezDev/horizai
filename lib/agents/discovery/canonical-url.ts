import { createHash } from "node:crypto";

const trackingParameterNames = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref_src",
  "ref_url",
  "yclid",
  "vero_id",
]);

function isTrackingParameter(name: string): boolean {
  const lowerName = name.toLowerCase();
  return trackingParameterNames.has(lowerName) || lowerName.startsWith("utm_");
}

export function canonicalizeUrl(value: string): string {
  const url = new URL(value.trim());

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https");
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }

  for (const [name] of [...url.searchParams]) {
    if (isTrackingParameter(name)) url.searchParams.delete(name);
  }

  // Query parameters are preserved, but their order is normalized for stable deduplication.
  url.searchParams.sort();
  return url.toString();
}

export function stableHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function candidateExternalId(sourceId: string, canonicalUrl: string): string {
  return `${sourceId}:${stableHash(canonicalUrl).slice(0, 32)}`;
}
