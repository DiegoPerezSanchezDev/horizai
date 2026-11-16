import type { Metadata } from "next";

import { ContentPageLayout } from "@/components/content/content-page-layout";
import { CONTENT_PAGES } from "@/components/content/content-page-data";
import { getCanonicalAlternates } from "@/lib/public-site-url";

export const metadata: Metadata = {
  title: "Privacidad",
  description: "Consulta la política de privacidad provisional de HorizAI para el MVP.",
  alternates: getCanonicalAlternates("/privacidad"),
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  return <ContentPageLayout page={CONTENT_PAGES.privacy} />;
}
