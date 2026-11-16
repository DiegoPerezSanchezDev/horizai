export type FetchedContent = {
  html: string;
  finalUrl: string;
  contentType: string;
  statusCode: number;
  redirects: number;
};

export type ContentFetchErrorCode =
  | "timeout"
  | "blocked"
  | "http_error"
  | "content_type"
  | "redirect_limit";

export class ContentFetchError extends Error {
  public readonly code: ContentFetchErrorCode;
  public readonly statusCode?: number;
  public readonly contentType?: string;

  constructor(message: string, code: ContentFetchErrorCode, statusCode?: number, contentType?: string) {
    super(message);
    this.name = "ContentFetchError";
    this.code = code;
    this.statusCode = statusCode;
    this.contentType = contentType;
  }
}

const maxResponseBytes = 5_000_000;
const maxRedirects = 4;

export function isSupportedHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/html") || normalized.includes("application/xhtml+xml");
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isBlockedStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

export async function fetchContent(url: string, timeoutMs = 15_000): Promise<FetchedContent> {
  let currentUrl = url;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          headers: {
            accept: "text/html,application/xhtml+xml;q=0.9",
            "user-agent": "HorizAI/0.1 content-extractor",
          },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new ContentFetchError("request timed out", "timeout");
        throw new ContentFetchError(error instanceof Error ? error.message : "request failed", "http_error");
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new ContentFetchError("redirect has no location", "http_error", response.status);
        if (redirects === maxRedirects) throw new ContentFetchError("redirect limit exceeded", "redirect_limit", response.status);
        const nextUrl = new URL(location, currentUrl);
        if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
          throw new ContentFetchError("redirect target must use http or https", "http_error", response.status);
        }
        currentUrl = nextUrl.toString();
        continue;
      }

      if (!response.ok) {
        const code = isBlockedStatus(response.status) ? "blocked" : "http_error";
        throw new ContentFetchError(`HTTP ${response.status}`, code, response.status);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!isSupportedHtmlContentType(contentType)) {
        throw new ContentFetchError("response is not HTML", "content_type", response.status, contentType);
      }

      const html = await response.text();
      if (Buffer.byteLength(html, "utf8") > maxResponseBytes) {
        throw new ContentFetchError("response exceeded the 5 MB safety limit", "http_error", response.status, contentType);
      }

      return { html, finalUrl: response.url || currentUrl, contentType, statusCode: response.status, redirects };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new ContentFetchError("redirect limit exceeded", "redirect_limit");
}
