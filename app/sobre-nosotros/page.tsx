import type { Metadata } from "next";

import { ContentPageLayout } from "@/components/content/content-page-layout";
import { CONTENT_PAGES } from "@/components/content/content-page-data";
import { getCanonicalAlternates } from "@/lib/public-site-url";

export const metadata: Metadata = {
  title: "Sobre nosotros",
  description: "Conoce el propósito editorial de HorizAI y cómo reunimos el contexto global de la inteligencia artificial.",
  alternates: getCanonicalAlternates("/sobre-nosotros"),
};

export default function AboutPage() {
  return <ContentPageLayout page={CONTENT_PAGES.about} />;
}
