import type { NextConfig } from "next";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tiles.openfreemap.org",
  "font-src 'self' data: https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL?.trim()
      || (process.env.NETLIFY === "true" && process.env.CONTEXT === "production" ? process.env.URL?.trim() : undefined),
    HORIZAI_DEPLOY_CONTEXT: process.env.NETLIFY === "true" ? process.env.CONTEXT || "unknown" : "",
  },
  poweredByHeader: false,
  // The development badge otherwise overlays the mobile editorial action bar.
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/editorial/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
          { key: "Referrer-Policy", value: "same-origin" },
          // Next's development runtime requires eval. Keep this local to the dev workspace.
          ...(process.env.NODE_ENV === "development" ? [{
            key: "Content-Security-Policy",
            value: contentSecurityPolicy.replace("script-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'"),
          }] : []),
        ],
      },
      {
        source: "/api/editorial/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
          { key: "Cache-Control", value: "private, no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
