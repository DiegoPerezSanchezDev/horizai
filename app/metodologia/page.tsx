import type { Metadata } from "next";

import { ContentPageLayout } from "@/components/content/content-page-layout";
import { CONTENT_PAGES } from "@/components/content/content-page-data";
import { getCanonicalAlternates } from "@/lib/public-site-url";

export const metadata: Metadata = {
  title: "Metodología",
  description: "Descubre cómo HorizAI descubre, verifica, contextualiza y clasifica las historias globales de inteligencia artificial.",
  alternates: getCanonicalAlternates("/metodologia"),
};

export default function MethodologyPage() {
  return <ContentPageLayout page={CONTENT_PAGES.methodology} />;
}
