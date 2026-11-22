import type { NextConfig } from "next";

/**
 * The MeroStay API. Browsers never call it directly: `/api/v1/*` on the web origin is proxied
 * to it (ADR 0010), so the httpOnly session cookie is first-party and no CORS is needed.
 * Read when the server starts (and at build time); set API_URL in every environment.
 */
const API_URL = (process.env.API_URL || "http://localhost:4000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${API_URL}/api/v1/:path*` }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // Baseline security headers. A full Content-Security-Policy is added once
  // third-party scripts (maps, payment widgets) are known.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
