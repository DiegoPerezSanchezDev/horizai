import type { Metadata } from "next";

import { ContentPageLayout } from "@/components/content/content-page-layout";
import { CONTENT_PAGES } from "@/components/content/content-page-data";
import { getCanonicalAlternates } from "@/lib/public-site-url";

export const metadata: Metadata = {
  title: "Fuentes",
  description: "Conoce qué fuentes oficiales, técnicas, académicas y periodísticas prioriza HorizAI.",
  alternates: getCanonicalAlternates("/fuentes"),
};

export default function SourcesPage() {
  return <ContentPageLayout page={CONTENT_PAGES.sources} />;
}
