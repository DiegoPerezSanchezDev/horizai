import Link from "next/link";

import { SiteFooter } from "@/components/footer/site-footer";
import { HeroHeader } from "@/components/hero/hero-header";
import { Container } from "@/components/ui/container";

export default function NotFound() {
  return (
    <div className="min-h-screen text-foreground">
      <HeroHeader />
      <main id="contenido"><Container className="content-state my-16 max-w-3xl">
        <h1 className="font-display text-3xl font-bold tracking-tight text-foreground-strong">No encontramos esta página</h1>
        <p className="mt-3 text-muted-foreground">La dirección puede ser incorrecta o el contenido ya no estar disponible.</p>
        <Link className="btn-primary-glow mt-6 inline-flex min-h-11 items-center rounded-pill px-5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href="/">
          Volver a HorizAI
        </Link>
      </Container></main>
      <SiteFooter />
    </div>
  );
}
