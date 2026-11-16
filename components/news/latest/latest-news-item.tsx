import Link from "next/link";
import Image from "next/image";

import type { PublicArticleSummary } from "@/lib/public-content-model";
import { formatPublishedDate, getArticleHref } from "@/lib/public-content-model";

interface LatestNewsItemProps {
  story: PublicArticleSummary;
  articleBasePath?: string;
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[s,.;:–-]+$/, "")}…`;
}

export function LatestNewsItem({ story, articleBasePath = "/noticias" }: LatestNewsItemProps) {
  const date = formatPublishedDate(story.publishedAt);

  return (
    <article className="wire-item group">
      {story.sources[0] ? (
        <p className="story-source">
          Fuente:{" "}
          {story.sources[0].url ? (
            <a className="story-source-link" href={story.sources[0].url} target="_blank" rel="noopener noreferrer">{story.sources[0].name} <span aria-hidden="true">↗</span></a>
          ) : <strong>{story.sources[0].name}</strong>}
        </p>
      ) : null}
      <Link
        href={getArticleHref(story.slug, articleBasePath)}
        className="latest-story-link"
      >
        <span className="latest-story-copy">
          <span className="story-metadata">
            {story.categories[0] ? <span className="story-card-tag">{story.categories[0].name}</span> : null}
            {story.regionName ? <span className="story-region">{story.regionName}</span> : null}
          </span>
          <span className="wire-title">{story.headline}</span>
          {story.summary ? <span className="latest-summary">{truncateAtWord(story.summary, 170)}</span> : null}
          <span className="story-byline">
            {date ? <time dateTime={story.publishedAt}>{date}</time> : null}
          </span>
        </span>
        {story.imageUrl ? <span className="wire-thumb" aria-hidden="true"><Image src={story.imageUrl} alt="" fill sizes="80px" className="object-cover" unoptimized /></span> : null}
      </Link>
    </article>
  );
}
