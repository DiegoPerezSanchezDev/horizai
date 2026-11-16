import Link from "next/link";

import { Container } from "@/components/ui/container";
import { ThemeToggle } from "@/components/ui/theme-toggle";

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg className="size-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <circle cx="8" cy="8" r="5.6" />
        <path d="M2.4 8h11.2M8 2.4c2 1.8 2.8 3.7 2.8 5.6S10 11.8 8 13.6C6 11.8 5.2 9.9 5.2 8S6 4.2 8 2.4Z" />
      </svg>
    </span>
  );
}

const navLinks = [
  { label: "Mapa global", href: "/#mapa-global" },
  { label: "Historias", href: "/#historias-destacadas" },
  { label: "Lo más reciente", href: "/#ultimas-noticias" },
];

export function HeroHeader() {
  return (
    <header className="site-header">
      <Container className="header-layout">
        <Link
          className="group flex w-fit items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
          href="/"
          scroll
        >
          <BrandMark />
          <span className="font-display text-[1.15rem] font-bold tracking-[-0.04em] text-foreground-strong transition-colors duration-200 group-hover:text-accent sm:text-[1.28rem]">
            Horiz<span className="text-accent">AI</span>
          </span>
        </Link>

        <nav aria-label="Secciones" className="header-navigation">
          {navLinks.map((link) => (
            <Link key={link.href} href={link.href} className="header-nav-link">
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="header-theme">
          <ThemeToggle compact />
        </div>
      </Container>
    </header>
  );
}
