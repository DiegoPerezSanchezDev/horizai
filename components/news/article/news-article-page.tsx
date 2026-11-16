import Link from "next/link";
import Image from "next/image";

import { Container } from "@/components/ui/container";
import { SiteFooter } from "@/components/footer/site-footer";
import type { PublicArticle, PublicArticleSummary } from "@/lib/public-content-model";
import { formatPublishedDate, getArticleHref, getReadingTime, parseArticleBody } from "@/lib/public-content-model";

import { ReadingProgress } from "./reading-progress";
import { ArticleNavigation } from "./article-navigation";

function BodyText({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)]+)/g).filter(Boolean);
  return <>{parts.map((part, index) => {
    const markdown = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    const plainUrl = /^https?:\/\/[^\s)]+$/.exec(part);
    const value = markdown?.[2] ?? plainUrl?.[0];
    if (!value) return <span key={index}>{part}</span>;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") return <span key={index}>{part}</span>;
      return <a key={index} href={url.toString()} target="_blank" rel="noopener noreferrer">{markdown?.[1] ?? value}</a>;
    } catch {
      return <span key={index}>{part}</span>;
    }
  })}</>;
}

function RelatedArticleCard({ article, articleBasePath = "/noticias" }: { article: PublicArticleSummary; articleBasePath?: string }) {
  return (
    <Link
      href={getArticleHref(article.slug, articleBasePath)}
      className="hairline-card group flex min-h-28 flex-col justify-between p-4 hover:-translate-y-0.5 hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>
        <span className="tag-pill">{article.categories[0]?.name ?? "Noticia"}</span>
        <span className="mt-2 block font-display text-[0.92rem] font-bold leading-[1.35] tracking-[-0.015em] text-foreground-strong transition-colors group-hover:text-accent">{article.headline}</span>
      </span>
      <span className="mt-3 text-xs text-muted-foreground">{formatPublishedDate(article.publishedAt)}</span>
    </Link>
  );
}

export function NewsArticlePage({
  article,
  relatedArticles,
  articleBasePath = "/noticias",
  homeHref = "/",
  returnHref,
}: {
  article: PublicArticle;
  relatedArticles: readonly PublicArticleSummary[];
  articleBasePath?: string;
  homeHref?: string;
  returnHref?: string;
}) {
  const bodyBlocks = parseArticleBody(article.body);
  const readingTime = getReadingTime(article.body);
  const category = article.categories[0]?.name;
  const publishedTimestamp = Date.parse(article.publishedAt);
  const updatedTimestamp = Date.parse(article.updatedAt);
  const wasUpdatedAfterPublication = Number.isFinite(publishedTimestamp) && Number.isFinite(updatedTimestamp)
    && updatedTimestamp > publishedTimestamp + 60_000;
  return (
    <div className="article-page min-h-screen text-foreground">
      <ReadingProgress />
      <ArticleNavigation homeHref={homeHref} returnHref={returnHref} />

      <main id="contenido">
        <Container className="relative z-10 py-6 sm:py-8 lg:py-10">
        <article>
          <header className="fade-in mx-auto max-w-4xl">
            <div className="flex flex-wrap items-center gap-2.5">
              {category ? <span className="tag-pill">{category}</span> : null}
              {article.regionName ? <span className="wire-meta">{article.regionName}</span> : null}
            </div>

            <h1 className="article-title mt-4 max-w-4xl">{article.headline}</h1>
            {article.summary ? <p className="article-summary mt-4 max-w-3xl">{article.summary}</p> : null}

            <div className="article-metabar mt-5">
              <time className="wire-time normal-case tracking-normal" dateTime={article.publishedAt}>{formatPublishedDate(article.publishedAt)}</time>
              {wasUpdatedAfterPublication ? <span>Registro actualizado <time dateTime={article.updatedAt}>{formatPublishedDate(article.updatedAt)}</time></span> : null}
              {readingTime ? (
                <span className="inline-flex items-center gap-1.5">
                  <svg aria-hidden="true" className="size-3.5 text-faint" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                    <circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" />
                  </svg>
                  {readingTime} min de lectura
                </span>
              ) : null}
            </div>
            {article.sources[0] ? (
              <aside className="article-source-panel mt-6" aria-label="Fuente original">
                <div>
                  <p className="article-source-kicker">Fuente original</p>
                  <p className="article-source-name">{article.sources[0].name}</p>
                  <p className="article-source-note">Este texto es un resumen propio de HorizAI. El mérito de la información es de la fuente. Resumen y traducción generados con IA y revisados por una persona antes de publicarse. La lista de fuentes muestra la procedencia; varios enlaces no implican por sí solos corroboración independiente.</p>
                </div>
                {article.sources[0].url ? (
                  <a className="btn-primary-glow article-source-cta" href={article.sources[0].url} target="_blank" rel="noopener noreferrer">
                    Leer la noticia original <span aria-hidden="true">↗</span>
                  </a>
                ) : null}
              </aside>
            ) : null}
          </header>

          {article.imageUrl ? (
            <figure className="article-lead-image mx-auto mt-8 max-w-4xl sm:mt-10">
              <div className="article-lead-image-frame">
                <Image
                  src={article.imageUrl}
                  alt={article.imageAlt ?? ""}
                  fill
                  sizes="(max-width: 768px) 100vw, 896px"
                  className="object-cover"
                  unoptimized
                />
              </div>
            </figure>
          ) : null}

          {article.whyItMatters ? (
            <section className="article-why reveal mx-auto mt-7 max-w-3xl" aria-labelledby="why-title">
              <h2 id="why-title" className="article-section-label">Por qué importa</h2>
              <p className="article-why-copy mt-3">{article.whyItMatters}</p>
            </section>
          ) : null}

          <div className="article-reading-column mx-auto mt-8 max-w-3xl sm:mt-10">
            <div className="article-body">
              {bodyBlocks.length > 0 ? bodyBlocks.map((block, index) => {
                if (block.kind === "heading") {
                  return block.level === 2
                    ? <h2 key={index}><BodyText text={block.text} /></h2>
                    : <h3 key={index}><BodyText text={block.text} /></h3>;
                }
                if (block.kind === "list") {
                  const List = block.ordered ? "ol" : "ul";
                  return <List key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><BodyText text={item} /></li>)}</List>;
                }
                return <p key={index}><BodyText text={block.text} /></p>;
              }) : (
                <p className="content-state" role="status">El texto completo no está disponible en esta ficha pública.</p>
              )}
            </div>

            {article.sources.length > 0 ? (
              <section className="article-sources reveal mt-12 border-t border-hairline pt-8 sm:mt-16" aria-labelledby="sources-title">
                <h2 id="sources-title" className="article-section-label">Fuentes originales</h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Esta ficha resume y contextualiza información; consulta las publicaciones originales para ampliar los detalles.
                </p>
                <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                  {article.sources.map((source, index) => (
                    <li key={`${source.name}-${source.url ?? index}`}>
                      {source.url ? (
                        <a href={source.url} target="_blank" rel="noopener noreferrer" className="hairline-card group block h-full p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <span className="flex items-center justify-between gap-2 text-sm font-semibold text-foreground-strong transition-colors group-hover:text-accent">
                            {source.name}
                            <svg aria-hidden="true" className="size-3.5 shrink-0 text-faint" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12 12 4M6 4h6v6" /></svg>
                          </span>
                        </a>
                      ) : (
                        <div className="hairline-card h-full p-4 text-sm font-semibold text-foreground-strong">{source.name}</div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <p className="article-correction-note mt-8">
              ¿Detectas un error o una cuestión de derechos? Escribe a <a href="mailto:d.perez.sanchez.dev@gmail.com">d.perez.sanchez.dev@gmail.com</a>.
            </p>

            {relatedArticles.length > 0 ? (
              <section className="reveal mt-12 border-t border-hairline pt-8 sm:mt-16" aria-labelledby="related-title">
                <h2 id="related-title" className="article-section-label">En contexto</h2>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {relatedArticles.slice(0, 4).map((related) => <RelatedArticleCard key={related.slug} article={related} articleBasePath={articleBasePath} />)}
                </div>
              </section>
            ) : (
              <section className="article-continuation mt-10 border-t border-hairline pt-6" aria-labelledby="continue-title">
                <h2 id="continue-title" className="article-section-label">Sigue explorando</h2>
                <nav aria-label="Continuar leyendo" className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                  <Link className="article-continuation-link" href={`${homeHref}#ultimas-noticias`}>Lo más reciente</Link>
                  <Link className="article-continuation-link" href={`${homeHref}#mapa-global`}>Mapa global</Link>
                </nav>
              </section>
            )}

          </div>
        </article>
        </Container>
      </main>
      <SiteFooter />
    </div>
  );
}
