import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HorizAI",
    short_name: "HorizAI",
    description: "Noticias globales sobre inteligencia artificial en español, con contexto y fuentes originales.",
    start_url: "/",
    display: "browser",
    background_color: "#040914",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
