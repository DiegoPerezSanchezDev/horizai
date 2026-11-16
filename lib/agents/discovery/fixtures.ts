import type { ParsedFeedItem } from "./discovery-types.ts";

export const validRssFixture = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><item><guid>one</guid><title>First item</title><link>https://example.com/news/one/?utm_source=test&amp;page=1#fragment</link><description><![CDATA[Short <b>summary</b>]]></description><pubDate>Sat, 12 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;

export const validAtomFixture = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:example.com,2026:item-2</id><title>Second item</title><link rel="alternate" href="https://example.com/news/two"/><updated>2026-09-12T11:00:00Z</updated><summary>Atom summary</summary></entry></feed>`;

export const invalidFeedItemFixture: ParsedFeedItem = {
  externalId: "invalid",
  url: "not-a-url",
  title: "Invalid URL fixture",
  excerpt: null,
  publishedAt: "2026-09-12T11:00:00.000Z",
  dateReliable: true,
};
