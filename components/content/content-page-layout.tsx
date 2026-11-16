import Link from "next/link";

import { SiteFooter } from "@/components/footer/site-footer";
import { HeroHeader } from "@/components/hero/hero-header";
import { Container } from "@/components/ui/container";

import type { ContentPageData } from "./content-page-data";

export function ContentPageLayout({ page }: { page: ContentPageData }) {
  return (
    <main className="content-page article-page min-h-screen text-foreground">
      <HeroHeader />
      <div className="article-subheader">
        <Container className="py-3">
          <Link className="article-back-link" href="/#top">
            <svg aria-hidden="true" className="size-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.6">
              <path d="M13 8H3M6.5 4.5 3 8l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Volver a HorizAI
          </Link>
        </Container>
      </div>

      <Container className="py-12 sm:py-16 lg:py-20">
        <article className="mx-auto max-w-4xl">
          <header className="fade-in max-w-3xl">
            <span className="section-kicker">{page.eyebrow}</span>
            <h1 className="type-h1 mt-5 max-w-3xl">
              {page.title}<span className="text-accent">{page.titleAccent}</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">{page.intro}</p>
            {page.action ? (
              <a
                className="btn-outline-glass mt-6 inline-flex h-10 items-center gap-2 rounded-pill px-4 text-sm font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                href={page.action.href}
              >
                {page.action.label} →
              </a>
            ) : null}
          </header>

          <div className="mt-12 space-y-10 sm:mt-16 sm:space-y-12">
            {page.sections.map((section) => (
              <section className="reveal border-t border-hairline pt-8 sm:pt-10" key={section.heading}>
                <h2 className="type-h3 max-w-2xl">{section.heading}</h2>
                {section.paragraphs?.map((paragraph) => (
                  <p className="mt-4 max-w-3xl text-sm leading-7 text-muted-foreground sm:text-base sm:leading-8" key={paragraph}>
                    {paragraph}
                  </p>
                ))}
                {section.items ? (
                  <ul className="mt-5 grid gap-3 sm:grid-cols-2">
                    {section.items.map((item) => (
                      <li className="hairline-card flex gap-3 px-4 py-3 text-sm leading-6 text-muted-foreground" key={item}>
                        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" aria-hidden="true" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))}
          </div>

          {page.callout ? (
            <aside className="mt-12 rounded-panel border border-warning/30 bg-warning-soft px-5 py-4 text-sm leading-6 text-foreground sm:mt-16 sm:px-6 sm:py-5">
              <strong className="font-semibold text-warning">Nota importante: </strong>
              {page.callout}
            </aside>
          ) : null}
        </article>
      </Container>

      <SiteFooter />
    </main>
  );
}
