import Link from "next/link";

import { Container } from "@/components/ui/container";
import type { PublicArticleSummary } from "@/lib/public-content-model";
import { formatPublishedDate, getArticleHref, getAvailableRegions } from "@/lib/public-content-model";

import { HeroCallouts } from "./hero-callouts";
import { HeroHeader } from "./hero-header";
import { HeroMetrics } from "./hero-metrics";
import { HeroTerrain } from "./hero-terrain";
import { TechGlobe } from "./tech-globe";

function ArrowIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.6">
      <path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Hero({
  status,
  stories,
  hasArchive = false,
  articleBasePath = "/noticias",
}: {
  status: "ready" | "error";
  stories: readonly PublicArticleSummary[];
  hasArchive?: boolean;
  articleBasePath?: string;
}) {
  const leadStory = stories[0] ?? null;
  const regionsCount = getAvailableRegions(stories).length;

  return (
    <>
      <HeroHeader />
      <div id="top" className="hero-backdrop">
        <HeroTerrain />
        <Container className="hero-container relative z-10">
          <section className="hero-main grid items-center gap-y-5 pt-8 pb-8 sm:gap-y-6 sm:pt-10 sm:pb-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:grid-rows-[auto_auto] lg:content-center lg:gap-x-8 lg:gap-y-0 lg:py-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="hero-copy relative z-10 order-1 min-w-0 max-w-[38rem] lg:col-start-1 lg:row-start-1 lg:self-end lg:pb-4">
              <p className="hero-promise">La inteligencia artificial global, en español y con contexto.</p>
              {leadStory ? (
                <>
                  <p className="hero-eyebrow fade-in">
                    <span className="published-indicator" aria-hidden="true" />
                    Publicado {formatPublishedDate(leadStory.publishedAt)}
                  </p>
                  <h1 className="hero-title fade-in delay-1 mt-4 max-w-[680px] sm:mt-5">
                    {leadStory.headline}
                  </h1>
                  {leadStory.summary ? (
                    <p className="hero-summary fade-in delay-2 mt-4 max-w-[34rem] text-[0.92rem] leading-[1.65] text-muted-foreground-strong dark:text-muted-foreground sm:mt-5 sm:text-[1.02rem]">
                      {leadStory.summary}
                    </p>
                  ) : null}
                  <div className="hero-story-meta mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground-strong dark:text-muted-foreground">
                    {leadStory.categories[0] ? <span className="tag-pill">{leadStory.categories[0].name}</span> : null}
                    {leadStory.regionName ? <span>{leadStory.regionName}</span> : null}
                    {leadStory.sources[0] ? <span>· Fuente: <strong>{leadStory.sources[0].name}</strong></span> : null}
                  </div>
                  <div className="hero-ctas fade-in delay-3 mt-6 flex flex-wrap items-center gap-3 sm:mt-7">
                    {leadStory.sources[0]?.url ? (
                      <a href={leadStory.sources[0].url} target="_blank" rel="noopener noreferrer" className="btn-primary-glow inline-flex min-h-11 items-center justify-center gap-2.5 rounded-pill px-5 text-[0.92rem] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                        Leer en {leadStory.sources[0].name} <span aria-hidden="true">↗</span>
                      </a>
                    ) : null}
                    <Link href={getArticleHref(leadStory.slug, articleBasePath)} className="btn-outline-glass inline-flex min-h-11 items-center justify-center gap-2.5 rounded-pill px-5 text-[0.92rem] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
                      Ver el resumen
                    </Link>
                  </div>
                </>
              ) : status === "error" ? (
                <>
                  <p className="hero-eyebrow fade-in">HorizAI · Noticias y contexto</p>
                  <h1 className="hero-title fade-in delay-1 mt-4 max-w-[640px] sm:mt-5">La portada no está disponible ahora.</h1>
                  <p className="hero-summary fade-in delay-2 mt-4 max-w-[32rem] text-[0.95rem] leading-[1.65] text-muted-foreground sm:mt-5">
                    No pudimos cargar las noticias. Inténtalo de nuevo dentro de un momento.
                  </p>
                  <div className="hero-ctas mt-6 flex flex-wrap items-center gap-3">
                    <Link href="/" className="btn-primary-glow inline-flex min-h-11 items-center justify-center gap-2 rounded-pill px-5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      Volver a intentar <ArrowIcon />
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="hero-eyebrow fade-in">HorizAI · Inteligencia global sobre IA</p>
                  <h1 className="hero-title fade-in delay-1 mt-4 max-w-[640px] sm:mt-5">No hay noticias nuevas en las &uacute;ltimas 72 horas.</h1>
                  <p className="hero-summary fade-in delay-2 mt-4 max-w-[32rem] text-[0.95rem] leading-[1.65] text-muted-foreground sm:mt-5">El briefing muestra las novedades publicadas en esta ventana. Cuando haya noticias recientes, aparecer&aacute;n aqu&iacute; con su contexto y sus fuentes.</p>
                  <div className="hero-ctas mt-6 flex flex-wrap items-center gap-3">
                    <Link href={hasArchive ? "#ultimas-noticias" : "/metodologia"} className="btn-primary-glow inline-flex min-h-11 items-center justify-center gap-2.5 rounded-pill px-5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {hasArchive ? "Ver publicaciones anteriores" : "C&oacute;mo trabajamos"} <ArrowIcon />
                    </Link>
                    {hasArchive ? (
                      <Link href="/metodologia" className="btn-outline-glass inline-flex min-h-11 items-center justify-center rounded-pill px-5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        C&oacute;mo trabajamos
                      </Link>
                    ) : null}
                  </div>
                </>
              )}
            </div>

            <div aria-hidden="true" className="hero-globe-stage order-2 mx-auto w-full min-w-0 max-w-[22rem] sm:max-w-[28rem] lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:mx-0 lg:max-w-none lg:min-h-[430px] lg:self-center xl:min-h-[470px]">
              <div className="hero-globe-frame absolute inset-0 flex items-center justify-center lg:-translate-y-2">
                <TechGlobe />
              </div>
              {status === "ready" && stories.length > 0 ? <HeroCallouts stories={stories.slice(0, 4)} /> : null}
            </div>

            {status === "ready" ? (
              <div className="hero-metrics-wrap fade-in delay-4 order-3 max-w-[36rem] lg:col-start-1 lg:row-start-2 lg:mt-2 lg:self-start">
                <HeroMetrics storyCount={stories.length} regionCount={regionsCount} />
              </div>
            ) : null}
          </section>
          {status === "ready" && stories.length > 0 ? <HeroCallouts stories={stories.slice(0, 4)} mobile /> : null}
        </Container>
      </div>
    </>
  );
}
