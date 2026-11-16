import Link from "next/link";
import Image from "next/image";

import type { PublicArticleSummary } from "@/lib/public-content-model";
import { formatPublishedDate, getArticleHref } from "@/lib/public-content-model";

interface FeaturedStoryCardProps {
  story: PublicArticleSummary;
  index: number;
  articleBasePath?: string;
}

export function FeaturedStoryCard({ story, index, articleBasePath = "/noticias" }: FeaturedStoryCardProps) {
  const category = story.categories[0]?.name;

  return (
    <article className={story.imageUrl ? "story-card group" : "story-card story-card-no-image group"}>
      {story.sources[0] ? (
        <p className="story-source">
          Fuente:{" "}
          {story.sources[0].url ? (
            <a className="story-source-link" href={story.sources[0].url} target="_blank" rel="noopener noreferrer">{story.sources[0].name} <span aria-hidden="true">↗</span></a>
          ) : <strong>{story.sources[0].name}</strong>}
        </p>
      ) : null}
      <Link href={getArticleHref(story.slug, articleBasePath)} className="story-card-link">
        {story.imageUrl ? (
          <div className="story-card-media" aria-hidden="true">
            <Image src={story.imageUrl} alt="" fill sizes="(max-width: 767px) 80vw, (max-width: 1279px) 50vw, 600px" className="object-cover" unoptimized />
          </div>
        ) : null}
        <div className="story-card-body">
          <div className="story-metadata">
            {category ? <span className="story-card-tag">{category}</span> : null}
            {story.regionName ? <span className="story-region">{story.regionName}</span> : null}
          </div>
          <h3 className="story-card-title">{story.headline}</h3>
          {story.summary ? <p className="story-card-summary">{story.summary}</p> : null}
          <p className="story-byline">
            <time dateTime={story.publishedAt}>{formatPublishedDate(story.publishedAt)}</time>
          </p>
          <span className="sr-only">Noticia {index + 1}</span>
        </div>
      </Link>
    </article>
  );
}
