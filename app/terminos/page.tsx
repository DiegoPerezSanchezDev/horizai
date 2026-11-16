import type { Metadata } from "next";

import { ContentPageLayout } from "@/components/content/content-page-layout";
import { CONTENT_PAGES } from "@/components/content/content-page-data";
import { getCanonicalAlternates } from "@/lib/public-site-url";

export const metadata: Metadata = {
  title: "Términos",
  description: "Consulta los términos de uso provisionales de HorizAI como producto editorial e informativo.",
  alternates: getCanonicalAlternates("/terminos"),
  robots: { index: false, follow: true },
};

export default function TermsPage() {
  return <ContentPageLayout page={CONTENT_PAGES.terms} />;
}
