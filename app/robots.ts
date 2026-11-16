import type { MetadataRoute } from "next";

import { canIndexPublicSite, getCanonicalUrl } from "@/lib/public-site-url";

export default function robots(): MetadataRoute.Robots {
  if (!canIndexPublicSite()) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  const sitemap = getCanonicalUrl("/sitemap.xml");
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/admin/", "/operator/", "/editorial", "/debug/", "/qa/"],
    },
    sitemap: sitemap?.toString(),
  };
}
