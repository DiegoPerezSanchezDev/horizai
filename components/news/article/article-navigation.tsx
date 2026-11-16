import Link from "next/link";

import { Container } from "@/components/ui/container";

export function ArticleNavigation({ homeHref = "/", returnHref }: { homeHref?: string; returnHref?: string }) {
  const mapOrigin = Boolean(returnHref);
  return (
    <nav className="article-subheader" aria-label="Volver a la portada">
      <Container className="article-navigation">
        <Link href={returnHref ?? `${homeHref}#ultimas-noticias`} replace={mapOrigin} className="article-back-link">
          <svg aria-hidden="true" className="size-3.5" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.6">
            <path d="M13 8H3M6.5 4.5 3 8l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {mapOrigin ? "Volver al mapa" : "Volver a las noticias"}
        </Link>
      </Container>
    </nav>
  );
}
