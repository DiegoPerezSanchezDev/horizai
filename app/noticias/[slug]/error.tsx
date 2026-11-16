"use client";

import Link from "next/link";

export default function ArticleError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="contenido" className="content-state mx-auto my-16 max-w-3xl" role="alert">
      <h1 className="font-display text-2xl font-bold text-foreground-strong">No pudimos mostrar esta noticia</h1>
      <p className="mt-3 text-muted-foreground">Inténtalo de nuevo dentro de un momento.</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button className="btn-primary-glow min-h-11 rounded-pill px-5 font-medium" onClick={reset} type="button">Volver a intentar</button>
        <Link className="btn-outline-glass inline-flex min-h-11 items-center rounded-pill px-5 font-medium" href="/">Portada</Link>
      </div>
    </main>
  );
}
