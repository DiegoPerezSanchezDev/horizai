const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  || (process.env.NETLIFY === "true" && process.env.CONTEXT === "production" ? process.env.URL?.trim() : undefined);

function isLoopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}

function normalizePublicSiteUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    const hasOnlyOrigin = (url.pathname === "" || url.pathname === "/")
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;

    if (!isHttp || !hasOnlyOrigin) return undefined;
    if (process.env.NODE_ENV === "production" && (url.protocol !== "https:" || isLoopback(url.hostname))) {
      return undefined;
    }

    return new URL(url.origin);
  } catch {
    return undefined;
  }
}

const publicSiteUrl = normalizePublicSiteUrl(configuredSiteUrl);

if (process.env.NODE_ENV === "production" && !publicSiteUrl) {
  console.warn("[launch-readiness] NEXT_PUBLIC_SITE_URL is missing or invalid; indexing metadata is disabled.");
}

export function getPublicSiteUrl(): URL | undefined {
  return publicSiteUrl;
}

export function getCanonicalUrl(path: string): URL | undefined {
  if (!publicSiteUrl || !path.startsWith("/")) return undefined;
  return new URL(path, publicSiteUrl);
}

export function getCanonicalAlternates(path: string) {
  const canonical = getCanonicalUrl(path);
  return canonical ? { canonical } : undefined;
}

export function getSiteSocialImageUrl(): URL | undefined {
  return publicSiteUrl ? new URL("/social-card", publicSiteUrl) : undefined;
}

export function canIndexPublicSite(): boolean {
  return process.env.NODE_ENV === "production"
    && publicSiteUrl !== undefined
    && (!process.env.HORIZAI_DEPLOY_CONTEXT || process.env.HORIZAI_DEPLOY_CONTEXT === "production")
    && (process.env.NETLIFY !== "true" || process.env.CONTEXT === "production");
}
