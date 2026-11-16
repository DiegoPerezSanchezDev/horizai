import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import "./editorial.css";

export const metadata: Metadata = {
  title: "Editorial",
  description: "Acceso privado de operadores editoriales. Datos en vivo no activados.",
  robots: { index: false, follow: false, noarchive: true, nosnippet: true, googleBot: { index: false, follow: false, noimageindex: true } },
  openGraph: null,
  twitter: null,
  alternates: { canonical: null },
};

export default function EditorialLayout({ children }: { children: ReactNode }) {
  return (
    <div className="editorial-shell">
      <header className="ed-header">
        <div className="ed-header-inner">
          <Link className="ed-brand" href="/editorial" aria-label="HorizAI — bandeja editorial">Horiz<span>AI</span><span className="ed-brand-section">Editorial</span></Link>
          <ThemeToggle compact />
        </div>
      </header>
      {children}
    </div>
  );
}
