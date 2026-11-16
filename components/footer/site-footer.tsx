import Link from "next/link";

import { Container } from "@/components/ui/container";

const platformLinks = [
  { label: "Mapa global", href: "/#mapa-global" },
  { label: "Historias recientes", href: "/#historias-destacadas" },
  { label: "Lo más reciente", href: "/#ultimas-noticias" },
];

const companyLinks = [
  { label: "Sobre nosotros", href: "/sobre-nosotros" },
  { label: "Metodología", href: "/metodologia" },
  { label: "Fuentes", href: "/fuentes" },
  { label: "Contacto", href: "/contacto" },
];

const legalLinks = [
  { label: "Privacidad", href: "/privacidad" },
  { label: "Términos", href: "/terminos" },
];

function LinkColumn({ title, links }: { title: string; links: { label: string; href: string }[] }) {
  return (
    <div>
      <p className="footer-heading">{title}</p>
      <ul className="mt-3.5 space-y-2.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link className="footer-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background" href={link.href}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Container className="py-12 sm:py-14">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,0.75fr))] lg:gap-10">
          <div className="max-w-sm">
            <Link
              className="inline-flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
              href="/#top"
            >
              <span className="brand-mark" aria-hidden="true">
                <svg className="size-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="8" cy="8" r="5.6" />
                  <path d="M2.4 8h11.2M8 2.4c2 1.8 2.8 3.7 2.8 5.6S10 11.8 8 13.6C6 11.8 5.2 9.9 5.2 8S6 4.2 8 2.4Z" />
                </svg>
              </span>
              <span className="font-display text-[1.2rem] font-bold tracking-[-0.04em] text-foreground-strong">
                Horiz<span className="text-accent">AI</span>
              </span>
            </Link>
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Noticias globales sobre inteligencia artificial, con contexto editorial y enlaces a las fuentes originales.
            </p>
          </div>

          <LinkColumn title="Explorar" links={platformLinks} />
          <LinkColumn title="HorizAI" links={companyLinks} />
          <LinkColumn title="Legal" links={legalLinks} />
        </div>

        <div className="mt-10 border-t border-hairline pt-6">
          <p className="text-xs text-faint">© {new Date().getFullYear()} HorizAI. Resúmenes propios; el mérito de cada noticia es de su fuente. Correcciones y derechos: <a className="footer-link" href="mailto:d.perez.sanchez.dev@gmail.com">d.perez.sanchez.dev@gmail.com</a></p>
        </div>
      </Container>
    </footer>
  );
}
