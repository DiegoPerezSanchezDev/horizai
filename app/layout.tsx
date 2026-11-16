import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Manrope } from "next/font/google";
import type { ReactNode } from "react";
import "maplibre-gl/dist/maplibre-gl.css";
import { ThemeInitializer } from "@/components/ui/theme-initializer";
import { canIndexPublicSite, getPublicSiteUrl, getSiteSocialImageUrl } from "@/lib/public-site-url";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const display = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-manrope",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  variable: "--font-jetbrains",
});

const siteSocialImage = getSiteSocialImageUrl();
const canIndex = canIndexPublicSite();

export const metadata: Metadata = {
  title: {
    default: "HorizAI — Inteligencia global sobre IA",
    template: "%s | HorizAI",
  },
  description:
    "Noticias globales sobre inteligencia artificial en español, con contexto editorial y enlaces a las fuentes originales.",
  applicationName: "HorizAI",
  metadataBase: getPublicSiteUrl(),
  robots: {
    index: canIndex,
    follow: canIndex,
    googleBot: {
      index: canIndex,
      follow: canIndex,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    siteName: "HorizAI",
    locale: "es_ES",
    title: "HorizAI — Inteligencia global sobre IA",
    description: "Noticias globales sobre inteligencia artificial en español, con contexto editorial y enlaces a las fuentes originales.",
    images: siteSocialImage ? [{
      url: siteSocialImage,
      width: 1200,
      height: 630,
      alt: "HorizAI: noticias globales sobre inteligencia artificial en español",
    }] : undefined,
  },
  twitter: {
    card: "summary_large_image",
    title: "HorizAI — Inteligencia global sobre IA",
    description: "Noticias globales sobre inteligencia artificial en español, con contexto y fuentes originales.",
    images: siteSocialImage ? [siteSocialImage.toString()] : undefined,
  },
  icons: { icon: "/icon.svg", apple: "/apple-icon" },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#040914" },
    { media: "(prefers-color-scheme: light)", color: "#f3f6fb" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="es"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
    >
      <body className="h-full min-h-full antialiased bg-background text-foreground">
        <ThemeInitializer />
        <a className="skip-link" href="#contenido">Saltar al contenido</a>
        {children}
      </body>
    </html>
  );
}
