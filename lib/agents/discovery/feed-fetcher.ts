export type FetchedFeed = {
  text: string;
  finalUrl: string;
  statusCode: number;
};

export class FeedFetchError extends Error {
  public readonly code: "timeout" | "http_error";
  public readonly statusCode?: number;

  constructor(
    message: string,
    code: "timeout" | "http_error",
    statusCode?: number
  ) {
    super(message);
    this.name = "FeedFetchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const maxFeedBytes = 2_000_000;

export async function fetchFeed(feedUrl: string, timeoutMs = 15_000): Promise<FetchedFeed> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(feedUrl, {
        headers: {
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
          "user-agent": "HorizAI/0.1 discovery",
        },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new FeedFetchError("request timed out", "timeout");
      const message = error instanceof Error ? error.message : "request failed";
      throw new FeedFetchError(message, "http_error");
    }

    if (!response.ok) {
      throw new FeedFetchError(`HTTP ${response.status}`, "http_error", response.status);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxFeedBytes) {
      throw new FeedFetchError("feed exceeded the 2 MB safety limit", "http_error", response.status);
    }

    return { text, finalUrl: response.url, statusCode: response.status };
  } finally {
    clearTimeout(timeout);
  }
}
