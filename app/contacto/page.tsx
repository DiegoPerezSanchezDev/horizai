import type { Metadata } from "next";

import { ContentPageLayout } from "@/components/content/content-page-layout";
import { CONTENT_PAGES } from "@/components/content/content-page-data";
import { getCanonicalAlternates } from "@/lib/public-site-url";

export const metadata: Metadata = {
  title: "Contacto",
  description: "Ponte en contacto con HorizAI para enviar correcciones, propuestas de prensa, colaboración o sugerencias.",
  alternates: getCanonicalAlternates("/contacto"),
  robots: { index: false, follow: true },
};

export default function ContactPage() {
  return <ContentPageLayout page={CONTENT_PAGES.contact} />;
}
